import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

describe('EventQueue nack + backoff', () => {
  it('requeues with exponential backoff and is not leasable until visible', async () => {
    const clock = new FakeClock(1000);
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock,
      idGen: new SeqIdGen(),
      retry: { baseMs: 1000, factor: 2, maxMs: 300000, jitter: false },
      defaults: { maxAttempts: 10 },
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });

    // attempt 1 fails → backoff base 1000
    let [rec] = await q.lease();
    await q.nack(rec.id, rec.leaseId!, { error: 'boom' });
    let [pending] = q.peek({ state: 'ready' });
    expect(pending.visibleAt).toBe(1000 + 1000);
    expect(pending.source).toBe('retry');
    expect(pending.lastError).toBe('boom');
    expect(await q.lease()).toHaveLength(0); // not yet visible

    // advance to visible, attempt 2 fails → backoff 2000
    clock.set(2000);
    [rec] = await q.lease();
    expect(rec.attempts).toBe(2);
    await q.nack(rec.id, rec.leaseId!);
    [pending] = q.peek({ state: 'ready' });
    expect(pending.visibleAt).toBe(2000 + 2000);

    // attempt 3 fails → backoff 4000
    clock.set(4000);
    [rec] = await q.lease();
    await q.nack(rec.id, rec.leaseId!);
    [pending] = q.peek({ state: 'ready' });
    expect(pending.visibleAt).toBe(4000 + 4000);
  });

  it('dead-letters after maxAttempts and never redelivers', async () => {
    const clock = new FakeClock(0);
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock,
      idGen: new SeqIdGen(),
      retry: { baseMs: 1, factor: 1, maxMs: 10, jitter: false },
      defaults: { maxAttempts: 3 },
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });

    for (let i = 0; i < 3; i += 1) {
      clock.advance(100);
      const [rec] = await q.lease();
      expect(rec).toBeDefined();
      await q.nack(rec.id, rec.leaseId!);
    }
    expect(q.stats().dead).toBe(1);
    clock.advance(100);
    expect(await q.lease()).toHaveLength(0);
  });

  it('ignores nack with a stale leaseId', async () => {
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock: new FakeClock(1000),
      idGen: new SeqIdGen(),
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });
    const [rec] = await q.lease();
    await q.nack(rec.id, 'wrong');
    expect(q.peek({ state: 'leased' })).toHaveLength(1);
  });

  it('ignores a stale nack that arrives after the record was swept and re-leased', async () => {
    const clock = new FakeClock(1000);
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock,
      idGen: new SeqIdGen(),
      defaults: { leaseMs: 5000 },
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });

    const [first] = await q.lease();
    const staleLease = first.leaseId!;
    clock.advance(5001); // first lease expires
    const [second] = await q.lease(); // swept back to ready, then re-leased
    expect(second.leaseId).not.toBe(staleLease);

    // The stalled first worker nacks with its OLD leaseId — must NOT touch the
    // live second lease (no requeue, no dead-letter, no lastError overwrite).
    await q.nack(second.id, staleLease, { error: 'from-stale-worker' });
    const [live] = q.peek({ state: 'leased' });
    expect(live).toBeDefined();
    expect(live.leaseId).toBe(second.leaseId);
    expect(live.lastError).toBeUndefined();
  });
});
