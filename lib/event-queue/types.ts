// EVENT-001 event.queue — shared types and ports.
//
// This module is the pure, dependency-free contract for the durable event
// queue that Phase 1 unifies schedule/inbound/poller/retry/lease origins onto.
// It imports nothing at runtime: the core state machine (event-queue.ts) and
// every storage adapter depend only on these types plus injected ports, so the
// whole primitive is host-testable and free of `Date.now`/`Math.random`/expo.
//
// Dormancy: nothing here is wired into a production dispatch path yet
// (see wiring.ts, EVENT_QUEUE_ENABLED). "実装されるが有効化はされない."

// Bump only alongside a persisted-record shape change. FUTURE LOCKSTEP POINT:
// once a native/script consumer or the bundled-sqlite adapter reads persisted
// records, mirror this exactly like PLAN_SPEC_SCHEMA_VERSION — TS constant +
// script asset + AgentRuntime.CURRENT_* + a parity test. No mirror is required
// while the queue is a dormant TS-only library. See wiring.ts §migration.
export const EVENT_QUEUE_SCHEMA_VERSION = 1;

export type QueueRecordState = 'ready' | 'leased' | 'dead';

// The unified origin of a record. schedule/inbound/poller/retry/lease all land
// on the same queue, differing only by (topic, source).
export type QueueSource = 'schedule' | 'inbound' | 'poller' | 'retry' | 'manual';

export interface QueueRecord<P = unknown> {
  id: string;
  schemaVersion: typeof EVENT_QUEUE_SCHEMA_VERSION;
  topic: string;
  source: QueueSource;
  // Opaque to the queue — never interpreted here. By convention payloads carry
  // no secret values (secret-by-reference lives in the capability layer).
  payload: P;
  dedupKey?: string;
  state: QueueRecordState;
  // Epoch ms. A record is leasable only when state==='ready' && visibleAt<=now.
  // Delay and retry backoff both move this forward.
  visibleAt: number;
  enqueuedAt: number;
  // Incremented at lease (delivery), so a worker that crashes mid-process still
  // consumes an attempt — poison messages are bounded by maxAttempts.
  attempts: number;
  maxAttempts: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  // Set by nack. Callers redact before storing.
  lastError?: string;
}

// Injected clock — Date.now is unavailable in some native contexts, so the core
// never reads wall-clock time directly.
export interface Clock {
  now(): number;
}

// Injected id source — the core never calls Math.random directly.
export interface IdGen {
  next(): string;
}

// Adapter boundary port for file-backed storage. A host adapter injects a
// node-fs implementation; the device adapter injects an expo-file-system one.
export interface FsPort {
  // Resolves to null when the file is absent (not an error).
  readFile(path: string): Promise<string | null>;
  writeFileAtomic(path: string, data: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
}

export interface RetryPolicy {
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
}

export interface EnqueueInput<P = unknown> {
  topic: string;
  source: QueueSource;
  payload: P;
  // Optional idempotency key. While a record with this key is still pending
  // (ready OR leased/in-flight), a further enqueue with the same key is dropped
  // as a duplicate. CONTRACT: the queue's at-least-once guarantee is per
  // dedupKey — callers must treat a shared dedupKey as "the same logical
  // event." Do NOT reuse a key for a distinct event you need delivered while an
  // earlier one is in flight (it would be swallowed). Leave undefined for
  // at-least-once delivery of every enqueue.
  dedupKey?: string;
  delayMs?: number;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  deduped: boolean;
}

export interface LeaseOptions {
  leaseMs?: number;
  max?: number;
  topic?: string;
}

// The single storage boundary. The core holds authoritative state in memory and
// persists every mutation through this interface, which maps cleanly onto one
// JSON file per record (host/device) or a sqlite row (deferred, flag-gated).
export interface QueueStorageAdapter {
  loadAll(): Promise<QueueRecord[]>;
  put(record: QueueRecord): Promise<void>; // upsert by id
  delete(id: string): Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 1000,
  factor: 2,
  maxMs: 300000,
  jitter: false,
};

export const DEFAULT_LEASE_MS = 30000;
export const DEFAULT_MAX_ATTEMPTS = 5;
