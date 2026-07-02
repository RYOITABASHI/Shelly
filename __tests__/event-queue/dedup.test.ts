import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

async function makeQueue() {
  const q = new EventQueue({
    adapter: new InMemoryQueueStorage(),
    clock: new FakeClock(1000),
    idGen: new SeqIdGen(),
  });
  await q.load();
  return q;
}

describe('EventQueue dedup', () => {
  it('drops a duplicate dedupKey while the record is pending', async () => {
    const q = await makeQueue();
    const a = await q.enqueue({ topic: 't', source: 'schedule', payload: 1, dedupKey: 'k' });
    const b = await q.enqueue({ topic: 't', source: 'schedule', payload: 2, dedupKey: 'k' });
    expect(a).toEqual({ id: 'id-1', deduped: false });
    expect(b).toEqual({ id: 'id-1', deduped: true });
    expect(q.peek()).toHaveLength(1);
  });

  it('dedups against a leased (in-flight) record too', async () => {
    const q = await makeQueue();
    await q.enqueue({ topic: 't', source: 'schedule', payload: 1, dedupKey: 'k' });
    const leased = await q.lease();
    expect(leased).toHaveLength(1);
    const b = await q.enqueue({ topic: 't', source: 'schedule', payload: 2, dedupKey: 'k' });
    expect(b.deduped).toBe(true);
    expect(q.peek()).toHaveLength(1);
  });

  it('frees the key once the record is ack’d', async () => {
    const q = await makeQueue();
    await q.enqueue({ topic: 't', source: 'schedule', payload: 1, dedupKey: 'k' });
    const [rec] = await q.lease();
    await q.ack(rec.id, rec.leaseId!);
    const b = await q.enqueue({ topic: 't', source: 'schedule', payload: 2, dedupKey: 'k' });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(rec.id);
  });
});
