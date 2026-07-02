import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

async function makeQueue(start = 1000) {
  const clock = new FakeClock(start);
  const q = new EventQueue({
    adapter: new InMemoryQueueStorage(),
    clock,
    idGen: new SeqIdGen(),
  });
  await q.load();
  return { q, clock };
}

describe('EventQueue visibility', () => {
  it('does not lease a delayed record before visibleAt', async () => {
    const { q, clock } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1, delayMs: 5000 });
    expect(await q.lease()).toHaveLength(0);
    clock.advance(4999);
    expect(await q.lease()).toHaveLength(0);
    clock.advance(1);
    expect(await q.lease()).toHaveLength(1);
  });

  it('orders eligible records FIFO by (visibleAt, enqueuedAt)', async () => {
    const { q, clock } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: 'a', delayMs: 3000 });
    await q.enqueue({ topic: 't', source: 'manual', payload: 'b' });
    await q.enqueue({ topic: 't', source: 'manual', payload: 'c', delayMs: 1000 });
    clock.advance(5000);
    const leased = await q.lease({ max: 10 });
    // b (visible@1000) < c (2000) < a (4000)
    expect(leased.map((r) => r.payload)).toEqual(['b', 'c', 'a']);
  });

  it('caps the batch at max', async () => {
    const { q } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });
    await q.enqueue({ topic: 't', source: 'manual', payload: 2 });
    await q.enqueue({ topic: 't', source: 'manual', payload: 3 });
    expect(await q.lease({ max: 2 })).toHaveLength(2);
    expect(q.stats().ready).toBe(1);
  });
});
