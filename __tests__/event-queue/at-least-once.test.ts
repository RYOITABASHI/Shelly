import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

describe('EventQueue at-least-once', () => {
  it('redelivers after lease expiry and ignores the stale ack', async () => {
    const clock = new FakeClock(1000);
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock,
      idGen: new SeqIdGen(),
      defaults: { leaseMs: 5000 },
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: { v: 42 } });

    const first = await q.lease();
    expect(first).toHaveLength(1);
    const firstLease = first[0].leaseId!;
    expect(first[0].attempts).toBe(1);

    // Worker stalls past the lease; sweep on the next lease reclaims it.
    clock.advance(5001);
    const second = await q.lease();
    expect(second).toHaveLength(1);
    expect(second[0].payload).toEqual({ v: 42 });
    expect(second[0].attempts).toBe(2);
    expect(second[0].leaseId).not.toBe(firstLease);

    // The stale worker finally acks with the OLD leaseId — must be a no-op.
    await q.ack(second[0].id, firstLease);
    expect(q.peek({ state: 'leased' })).toHaveLength(1);

    // The live worker acks correctly.
    await q.ack(second[0].id, second[0].leaseId!);
    expect(q.peek()).toHaveLength(0);
  });

  it('dead-letters a record whose lease keeps expiring past maxAttempts', async () => {
    const clock = new FakeClock(1000);
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock,
      idGen: new SeqIdGen(),
      defaults: { leaseMs: 1000, maxAttempts: 2 },
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });

    await q.lease(); // attempts=1
    clock.advance(1001);
    await q.lease(); // attempts=2
    clock.advance(1001);
    // sweep sees attempts>=maxAttempts → dead, not redelivered.
    const again = await q.lease();
    expect(again).toHaveLength(0);
    expect(q.stats().dead).toBe(1);
  });
});
