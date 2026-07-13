import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

describe('EventQueue.purgeDead', () => {
  it('drains dead-lettered records from memory and storage, leaving live ones', async () => {
    const clock = new FakeClock(0);
    const adapter = new InMemoryQueueStorage();
    const q = new EventQueue({
      adapter,
      clock,
      idGen: new SeqIdGen(),
      retry: { baseMs: 1, factor: 1, maxMs: 1, jitter: false },
      defaults: { maxAttempts: 1 },
    });
    await q.load();

    // One record we drive to dead, one that stays ready.
    await q.enqueue({ topic: 't', source: 'manual', payload: 'doomed' });
    const [doomed] = await q.lease(); // attempts=1
    await q.nack(doomed.id, doomed.leaseId!); // attempts>=maxAttempts → dead
    await q.enqueue({ topic: 't', source: 'manual', payload: 'alive' });

    expect(q.stats().dead).toBe(1);
    const purged = await q.purgeDead();
    expect(purged).toBe(1);
    expect(q.stats().dead).toBe(0);
    expect(q.peek().map((r) => r.payload)).toEqual(['alive']);

    // Storage was drained too — a fresh queue over the same adapter sees no dead.
    const fresh = new EventQueue({ adapter, clock, idGen: new SeqIdGen('f') });
    await fresh.load();
    expect(fresh.stats().dead).toBe(0);
  });

  it('is a no-op when there are no dead records', async () => {
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock: new FakeClock(),
      idGen: new SeqIdGen(),
    });
    await q.load();
    await q.enqueue({ topic: 't', source: 'manual', payload: 1 });
    expect(await q.purgeDead()).toBe(0);
    expect(q.peek()).toHaveLength(1);
  });
});
