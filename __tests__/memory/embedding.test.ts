import { MemoryStore } from '@/lib/memory/memory-store';
import { InMemoryMemoryStorage } from '@/lib/memory/storage-memory';
import {
  EmbeddingPort,
  MEMORY_SCHEMA_VERSION,
  MemoryRecord,
  recordsToRecallContext,
} from '@/lib/memory';
import { scanForSecrets } from '@/lib/secret-guard';
import { FakeClock } from '../support/event-queue-harness';

// Fake embedding: maps a text to a fixed vector by lookup, else zeros. Lets the
// test control cosine ordering deterministically.
function fakePort(table: Record<string, number[]>): EmbeddingPort {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => table[t] ?? [0, 0, 0]);
    },
  };
}

function recWithEmbedding(key: string, text: string, embedding: number[]): MemoryRecord {
  return {
    namespace: 'ns',
    key,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'fact',
    text,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    embedding,
  };
}

describe('MemoryStore embedding (optional, semantic/hybrid)', () => {
  it('re-ranks by cosine similarity in semantic mode', async () => {
    const adapter = new InMemoryMemoryStorage();
    await adapter.put(recWithEmbedding('near', 'about cats', [1, 0, 0]));
    await adapter.put(recWithEmbedding('far', 'about cars', [0, 1, 0]));
    const store = new MemoryStore({
      adapter,
      clock: new FakeClock(0),
      embedding: fakePort({ 'feline pets': [0.9, 0.1, 0] }),
    });
    const hits = await store.query('ns', { text: 'feline pets', mode: 'semantic' });
    expect(hits[0].record.key).toBe('near');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('applies the kind/tags filter in semantic mode (same as other modes)', async () => {
    const adapter = new InMemoryMemoryStorage();
    await adapter.put({ ...recWithEmbedding('p', 'pref one', [1, 0, 0]), kind: 'preference', tags: ['keep'] });
    await adapter.put({ ...recWithEmbedding('f', 'fact one', [1, 0, 0]), kind: 'fact', tags: ['keep'] });
    const store = new MemoryStore({
      adapter,
      clock: new FakeClock(0),
      embedding: fakePort({ q: [1, 0, 0] }),
    });
    const byKind = await store.query('ns', { text: 'q', mode: 'semantic', kind: 'preference' });
    expect(byKind.map((h) => h.record.key)).toEqual(['p']);
    const byTag = await store.query('ns', { text: 'q', mode: 'semantic', tags: ['keep'] });
    expect(byTag.map((h) => h.record.key).sort()).toEqual(['f', 'p']);
  });

  it('breaks ties deterministically by recency for embedding-less records (migrated G2 data)', async () => {
    const adapter = new InMemoryMemoryStorage();
    // No embeddings => every cosine score is 0; must fall back to recency, not
    // unstable insertion/fs order.
    await adapter.put({ namespace: 'ns', key: 'old', schemaVersion: 1, kind: 'fact', text: 'a', tags: [], createdAt: 100, updatedAt: 100 });
    await adapter.put({ namespace: 'ns', key: 'new', schemaVersion: 1, kind: 'fact', text: 'b', tags: [], createdAt: 200, updatedAt: 200 });
    const store = new MemoryStore({
      adapter,
      clock: new FakeClock(0),
      embedding: fakePort({ q: [1, 0, 0] }),
    });
    const hits = await store.query('ns', { text: 'q', mode: 'semantic', limit: 10 });
    expect(hits.map((h) => h.record.key)).toEqual(['new', 'old']); // newest first
  });

  it('degrades to fulltext when no embedding port is present', async () => {
    const store = new MemoryStore({ adapter: new InMemoryMemoryStorage(), clock: new FakeClock(0) });
    await store.put({ namespace: 'ns', text: 'quantum computing notes' });
    // semantic requested but no port -> must still work as fulltext, not throw.
    const hits = await store.query('ns', { text: 'quantum', mode: 'semantic' });
    expect(hits).toHaveLength(1);
    expect(hits[0].record.text).toBe('quantum computing notes');
  });

  it('surfaces a secret in recalled memory so the secret-guard still fires', async () => {
    const store = new MemoryStore({ adapter: new InMemoryMemoryStorage(), clock: new FakeClock(0) });
    await store.put({
      namespace: 'ns',
      text: 'the deploy token is api_key=sk-abcdef0123456789ghjklmno',
    });
    const hits = await store.query('ns', { text: 'deploy token' });
    const block = recordsToRecallContext(hits);
    expect(scanForSecrets(block).hasSecret).toBe(true);
  });
});
