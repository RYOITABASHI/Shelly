import { EventQueue } from '@/lib/event-queue/event-queue';
import { InMemoryQueueStorage } from '@/lib/event-queue/storage-memory';
import { EVENT_QUEUE_SCHEMA_VERSION } from '@/lib/event-queue/types';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';

async function makeQueue() {
  const clock = new FakeClock(1000);
  const q = new EventQueue({
    adapter: new InMemoryQueueStorage(),
    clock,
    idGen: new SeqIdGen(),
  });
  await q.load();
  return { q, clock };
}

describe('EventQueue.enqueue', () => {
  it('creates a ready record with generated id and opaque payload', async () => {
    const { q } = await makeQueue();
    const res = await q.enqueue({ topic: 'agent.run', source: 'schedule', payload: { a: 1 } });
    expect(res).toEqual({ id: 'id-1', deduped: false });

    const [rec] = q.peek();
    expect(rec.id).toBe('id-1');
    expect(rec.state).toBe('ready');
    expect(rec.attempts).toBe(0);
    expect(rec.schemaVersion).toBe(EVENT_QUEUE_SCHEMA_VERSION);
    expect(rec.payload).toEqual({ a: 1 });
    expect(rec.visibleAt).toBe(1000);
    expect(rec.enqueuedAt).toBe(1000);
  });

  it('honors delayMs by pushing visibleAt forward', async () => {
    const { q } = await makeQueue();
    await q.enqueue({ topic: 't', source: 'manual', payload: {}, delayMs: 5000 });
    const [rec] = q.peek();
    expect(rec.visibleAt).toBe(6000);
  });

  it('requires load() before use', async () => {
    const q = new EventQueue({
      adapter: new InMemoryQueueStorage(),
      clock: new FakeClock(),
      idGen: new SeqIdGen(),
    });
    await expect(q.enqueue({ topic: 't', source: 'manual', payload: {} })).rejects.toThrow(
      /load\(\) must be awaited/,
    );
  });
});
