// EVENT-001 event.queue — the durable at-least-once state machine.
//
// Pure core: depends only on ./types, ./backoff, and injected ports
// (adapter/clock/idGen/rng). No FS, no Date.now, no Math.random, no expo.
// The queue holds authoritative state in memory and persists every mutation
// through the storage adapter, so a fresh instance over the same adapter
// recovers by calling load().

import { computeBackoffMs } from './backoff';
import {
  Clock,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_POLICY,
  EnqueueInput,
  EnqueueResult,
  EVENT_QUEUE_SCHEMA_VERSION,
  IdGen,
  LeaseOptions,
  QueueRecord,
  QueueRecordState,
  QueueStorageAdapter,
  RetryPolicy,
} from './types';

export interface EventQueueOptions {
  adapter: QueueStorageAdapter;
  clock: Clock;
  idGen: IdGen;
  retry?: Partial<RetryPolicy>;
  defaults?: { leaseMs?: number; maxAttempts?: number };
  rng?: () => number;
}

function clone<P>(record: QueueRecord<P>): QueueRecord<P> {
  // Structured-ish copy so callers cannot mutate internal state. Payloads are
  // JSON-serialisable by convention (they round-trip through storage).
  return JSON.parse(JSON.stringify(record)) as QueueRecord<P>;
}

export class EventQueue {
  private readonly adapter: QueueStorageAdapter;
  private readonly clock: Clock;
  private readonly idGen: IdGen;
  private readonly retry: RetryPolicy;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly rng?: () => number;

  // Authoritative in-memory state, keyed by record id.
  private records = new Map<string, QueueRecord>();
  private loaded = false;

  constructor(opts: EventQueueOptions) {
    this.adapter = opts.adapter;
    this.clock = opts.clock;
    this.idGen = opts.idGen;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.leaseMs = opts.defaults?.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = opts.defaults?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.rng = opts.rng;
  }

  // Rehydrate from storage and return expired leases to ready. Idempotent.
  async load(): Promise<void> {
    const all = await this.adapter.loadAll();
    this.records = new Map(all.map((r) => [r.id, r]));
    this.loaded = true;
    await this.sweep();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      // A queue must be load()ed before use so crash-recovery is deterministic.
      throw new Error('EventQueue.load() must be awaited before use');
    }
  }

  async enqueue<P>(input: EnqueueInput<P>): Promise<EnqueueResult> {
    this.ensureLoaded();
    const now = this.clock.now();

    if (input.dedupKey) {
      const existing = this.findPendingByDedupKey(input.dedupKey);
      if (existing) {
        return { id: existing.id, deduped: true };
      }
    }

    const record: QueueRecord<P> = {
      id: this.idGen.next(),
      schemaVersion: EVENT_QUEUE_SCHEMA_VERSION,
      topic: input.topic,
      source: input.source,
      payload: input.payload,
      dedupKey: input.dedupKey,
      state: 'ready',
      visibleAt: now + Math.max(0, input.delayMs ?? 0),
      enqueuedAt: now,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.maxAttempts,
    };
    this.records.set(record.id, record as QueueRecord);
    await this.adapter.put(record as QueueRecord);
    return { id: record.id, deduped: false };
  }

  // Dedup window = while a record with the key is still pending (ready|leased).
  // Once ack'd (removed) or dead, the key is free again.
  private findPendingByDedupKey(dedupKey: string): QueueRecord | undefined {
    for (const r of this.records.values()) {
      if (r.dedupKey === dedupKey && (r.state === 'ready' || r.state === 'leased')) {
        return r;
      }
    }
    return undefined;
  }

  async lease(opts: LeaseOptions = {}): Promise<QueueRecord[]> {
    this.ensureLoaded();
    // Reclaim expired leases before selecting, so a crashed worker's record is
    // eligible again.
    await this.sweep();

    const now = this.clock.now();
    const leaseMs = opts.leaseMs ?? this.leaseMs;
    const max = Math.max(1, opts.max ?? 1);

    const eligible = [...this.records.values()]
      .filter(
        (r) =>
          r.state === 'ready' &&
          r.visibleAt <= now &&
          (opts.topic === undefined || r.topic === opts.topic),
      )
      // FIFO by (visibleAt, enqueuedAt).
      .sort((a, b) => a.visibleAt - b.visibleAt || a.enqueuedAt - b.enqueuedAt)
      .slice(0, max);

    const leased: QueueRecord[] = [];
    for (const r of eligible) {
      r.state = 'leased';
      r.leaseId = this.idGen.next();
      r.leaseExpiresAt = now + leaseMs;
      // Count the attempt at delivery: a worker that crashes mid-process still
      // consumes an attempt, bounding poison messages.
      r.attempts += 1;
      await this.adapter.put(r);
      leased.push(clone(r));
    }
    return leased;
  }

  // Remove a record on successful processing. Idempotent; a stale leaseId (from
  // an expired-then-re-leased record) is ignored so it cannot delete a live lease.
  async ack(id: string, leaseId: string): Promise<void> {
    this.ensureLoaded();
    const r = this.records.get(id);
    if (!r) return;
    if (r.state !== 'leased' || r.leaseId !== leaseId) return;
    this.records.delete(id);
    await this.adapter.delete(id);
  }

  // Consumer-facing synonym for ack.
  async complete(id: string, leaseId: string): Promise<void> {
    return this.ack(id, leaseId);
  }

  // Application-level failure: requeue with backoff, or dead-letter once the
  // attempt budget is spent. A stale leaseId is a no-op.
  async nack(
    id: string,
    leaseId: string,
    opts: { error?: string; requeueDelayMs?: number } = {},
  ): Promise<void> {
    this.ensureLoaded();
    const r = this.records.get(id);
    if (!r) return;
    if (r.state !== 'leased' || r.leaseId !== leaseId) return;

    r.lastError = opts.error;
    delete r.leaseId;
    delete r.leaseExpiresAt;

    if (r.attempts >= r.maxAttempts) {
      r.state = 'dead';
      await this.adapter.put(r);
      return;
    }

    const now = this.clock.now();
    const delay =
      opts.requeueDelayMs ?? computeBackoffMs(r.attempts, this.retry, this.rng);
    r.state = 'ready';
    r.source = 'retry';
    r.visibleAt = now + Math.max(0, delay);
    await this.adapter.put(r);
  }

  // Return expired leases to ready (crash recovery), dead-lettering those that
  // have exhausted their attempts. Idempotent; returns the number moved.
  async sweep(): Promise<number> {
    const now = this.clock.now();
    let moved = 0;
    for (const r of this.records.values()) {
      if (r.state !== 'leased') continue;
      if (r.leaseExpiresAt === undefined || r.leaseExpiresAt > now) continue;

      delete r.leaseId;
      delete r.leaseExpiresAt;
      if (r.attempts >= r.maxAttempts) {
        r.state = 'dead';
      } else {
        // A lease timeout is a crash, not an app-level failure: redeliver
        // immediately. attempts was already counted at lease, so it stays bounded.
        r.state = 'ready';
        r.visibleAt = now;
      }
      await this.adapter.put(r);
      moved += 1;
    }
    return moved;
  }

  // Dead-lettered records are retained for inspection but grow unbounded over a
  // long-lived install. Callers drain them explicitly (e.g. after exporting for
  // diagnostics). Returns the number purged from memory and storage.
  async purgeDead(): Promise<number> {
    this.ensureLoaded();
    let purged = 0;
    for (const r of [...this.records.values()]) {
      if (r.state !== 'dead') continue;
      this.records.delete(r.id);
      await this.adapter.delete(r.id);
      purged += 1;
    }
    return purged;
  }

  peek(filter: { state?: QueueRecordState; topic?: string } = {}): QueueRecord[] {
    this.ensureLoaded();
    return [...this.records.values()]
      .filter(
        (r) =>
          (filter.state === undefined || r.state === filter.state) &&
          (filter.topic === undefined || r.topic === filter.topic),
      )
      .map((r) => clone(r));
  }

  stats(): { ready: number; leased: number; dead: number } {
    this.ensureLoaded();
    const out = { ready: 0, leased: 0, dead: 0 };
    for (const r of this.records.values()) {
      out[r.state] += 1;
    }
    return out;
  }
}
