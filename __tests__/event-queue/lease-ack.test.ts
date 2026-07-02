import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

async function makeQueue() {
  const clock = new FakeClock(1000);
  const q = new EventQueue({
    adapter: new InMemoryQueueStorage(),
    clock,
    idGen: new SeqIdGen(),
    defaults: { leaseMs: 30000 },
  });
  await q.load();
  return { q, clock };
}

describe('EventQueue lease/ack', () => {
  it('leases the visible record, marks it leased, and ack removes it', async () => {
    const { q, clock } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });

    const leased = await q.lease();
    expect(leased).toHaveLength(1);
    const rec = leased[0];
    expect(rec.state).toBe('leased');
    expect(rec.leaseId).toBeTruthy();
    expect(rec.leaseExpiresAt).toBe(clock.now() + 30000);
    expect(rec.attempts).toBe(1);

    // A second lease before ack returns nothing (already leased).
    expect(await q.lease()).toHaveLength(0);

    await q.ack(rec.id, rec.leaseId!);
    expect(q.peek()).toHaveLength(0);
    expect(await q.lease()).toHaveLength(0);
  });

  it('respects max and topic filter and FIFO order', async () => {
    const { q } = await makeQueue();
    await q.enqueue({ topic: 'a', source: 'manual', payload: 1 });
    await q.enqueue({ topic: 'b', source: 'manual', payload: 2 });
    await q.enqueue({ topic: 'a', source: 'manual', payload: 3 });

    const onlyA = await q.lease({ topic: 'a', max: 5 });
    expect(onlyA.map((r) => r.payload)).toEqual([1, 3]);
  });

  it('ignores ack with a non-matching leaseId', async () => {
    const { q } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });
    const [rec] = await q.lease();
    await q.ack(rec.id, 'wrong-lease');
    expect(q.peek()).toHaveLength(1);
    // Correct leaseId still works.
    await q.ack(rec.id, rec.leaseId!);
    expect(q.peek()).toHaveLength(0);
  });
});
