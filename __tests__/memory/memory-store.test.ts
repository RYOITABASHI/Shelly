import { MemoryStore } from '@/lib/memory/memory-store';
import { InMemoryMemoryStorage } from '@/lib/memory/storage-memory';
import { deriveKey, MEMORY_SCHEMA_VERSION } from '@/lib/memory';
import { FakeClock } from '../support/event-queue-harness';

function makeStore(start = 1000) {
  const clock = new FakeClock(start);
  return { store: new MemoryStore({ adapter: new InMemoryMemoryStorage(), clock }), clock };
}

describe('MemoryStore put/get', () => {
  it('round-trips a record with clock timestamps and default kind', async () => {
    const { store } = makeStore();
    const rec = await store.put({ namespace: 'a1', text: '  hello world  ', tags: ['X', 'y y'] });
    expect(rec.kind).toBe('fact');
    expect(rec.text).toBe('hello world'); // trimmed
    expect(rec.tags).toEqual(['x', 'y-y']); // normalized
    expect(rec.createdAt).toBe(1000);
    expect(rec.updatedAt).toBe(1000);
    expect(rec.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);

    const got = await store.get('a1', rec.key);
    expect(got?.text).toBe('hello world');
  });

  it('derives a deterministic key so re-putting the same content overwrites (idempotent)', async () => {
    const { store, clock } = makeStore();
    const first = await store.put({ namespace: 'a1', text: 'the sky is blue' });
    expect(first.key).toBe(deriveKey('a1', 'fact', 'the sky is blue'));

    clock.advance(500);
    const second = await store.put({ namespace: 'a1', text: 'the sky is blue' });
    expect(second.key).toBe(first.key);
    expect(await store.query('a1')).toHaveLength(1); // one record, not two
    expect(second.createdAt).toBe(first.createdAt); // preserved
    expect(second.updatedAt).toBe(1500); // advanced
  });

  it('overwrites fields on an explicit key while preserving createdAt', async () => {
    const { store, clock } = makeStore();
    const a = await store.put({ namespace: 'a1', key: 'k', text: 'v1', tags: ['t1'] });
    clock.advance(10);
    const b = await store.put({ namespace: 'a1', key: 'k', text: 'v2', tags: ['t2'] });
    expect(b.text).toBe('v2');
    expect(b.tags).toEqual(['t2']);
    expect(b.createdAt).toBe(a.createdAt);
    expect(await store.query('a1')).toHaveLength(1);
  });

  it('isolates records by namespace', async () => {
    const { store } = makeStore();
    const rec = await store.put({ namespace: 'A', key: 'K', text: 'secret to A' });
    expect(await store.get('B', rec.key)).toBeNull();
    expect(await store.query('B')).toHaveLength(0);
    expect(await store.query('A')).toHaveLength(1);
  });

  it('deletes a record', async () => {
    const { store } = makeStore();
    const rec = await store.put({ namespace: 'A', text: 'gone soon' });
    await store.delete('A', rec.key);
    expect(await store.get('A', rec.key)).toBeNull();
  });
});
