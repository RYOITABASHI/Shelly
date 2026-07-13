jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('expo-file-system/legacy', () => ({}));

import { MemoryStore } from '@/lib/memory/memory-store';
import { InMemoryMemoryStorage } from '@/lib/memory/storage-memory';
import { deriveKey, g2NoteToRecord } from '@/lib/memory';
import { memoryNoteId, recallMemoryNotes, type MemoryNote } from '@/lib/agent-memory';
import { FakeClock } from '../support/event-queue-harness';

describe('deriveKey byte-identity with G2 memoryNoteId (migration idempotency)', () => {
  it('produces the exact same key as memoryNoteId for the same (namespace/agentId, kind/type, text)', () => {
    const cases: Array<[string, 'fact' | 'preference' | 'result', string]> = [
      ['agent-7', 'fact', 'the sky is blue'],
      ['agent-7', 'preference', '  trims and matches  '],
      ['ag', 'result', 'CJK テキスト も 一致'],
      ['x', 'fact', ''],
    ];
    for (const [ns, kind, text] of cases) {
      expect(deriveKey(ns, kind, text)).toBe(memoryNoteId(ns, kind, text));
    }
  });
});

function makeStore(start = 1000) {
  const clock = new FakeClock(start);
  return { store: new MemoryStore({ adapter: new InMemoryMemoryStorage(), clock }), clock };
}

describe('MemoryStore full-text query', () => {
  it('ranks a tag+token overlap above a weaker match', async () => {
    const { store, clock } = makeStore();
    await store.put({ namespace: 'a', text: 'notes about crypto trading', tags: ['crypto'] });
    clock.advance(1);
    await store.put({ namespace: 'a', text: 'gardening tips for spring' });
    const hits = await store.query('a', { text: 'crypto market update' });
    expect(hits[0].record.text).toBe('notes about crypto trading');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('falls back to newest-first when nothing overlaps', async () => {
    const { store, clock } = makeStore();
    await store.put({ namespace: 'a', text: 'alpha' });
    clock.advance(100);
    await store.put({ namespace: 'a', text: 'beta' });
    const hits = await store.query('a', { text: 'zzz-no-overlap' });
    expect(hits.map((h) => h.record.text)).toEqual(['beta', 'alpha']); // recency
  });

  it('honors limit and returns [] for an empty namespace', async () => {
    const { store } = makeStore();
    await store.put({ namespace: 'a', text: 'one' });
    await store.put({ namespace: 'a', text: 'two' });
    await store.put({ namespace: 'a', text: 'three' });
    expect(await store.query('a', { limit: 2 })).toHaveLength(2);
    expect(await store.query('a', { limit: 0 })).toHaveLength(0);
    expect(await store.query('empty-ns')).toHaveLength(0);
  });

  it('filters by tags (AND) and by kind', async () => {
    const { store } = makeStore();
    await store.put({ namespace: 'a', text: 'r1', tags: ['red', 'blue'], kind: 'fact' });
    await store.put({ namespace: 'a', text: 'r2', tags: ['red'], kind: 'preference' });
    const byTags = await store.query('a', { tags: ['red', 'blue'] });
    expect(byTags.map((h) => h.record.text)).toEqual(['r1']);
    const byKind = await store.query('a', { kind: 'preference' });
    expect(byKind.map((h) => h.record.text)).toEqual(['r2']);
  });

  it('matches G2 recallMemoryNotes ordering (migration recall parity)', async () => {
    // Sample notes, newest-first (as readMemoryNotes returns them).
    const notes: MemoryNote[] = [
      { id: 'n1', agentId: 'ag', type: 'fact', created: '2026-07-03T00:00:03Z', tags: ['crypto'], text: 'crypto portfolio rebalanced' },
      { id: 'n2', agentId: 'ag', type: 'fact', created: '2026-07-03T00:00:02Z', tags: ['garden'], text: 'watered the tomatoes' },
      { id: 'n3', agentId: 'ag', type: 'preference', created: '2026-07-03T00:00:01Z', tags: [], text: 'prefers concise crypto summaries' },
    ];
    const taskText = 'give me a crypto update';

    const g2Order = recallMemoryNotes(notes, taskText).map((n) => n.id);

    // Import G2 notes verbatim via g2NoteToRecord (preserving their createdAt so
    // the recency tiebreak matches), then rank through the new query path.
    const adapter = new InMemoryMemoryStorage();
    const store = new MemoryStore({ adapter, clock: new FakeClock(0) });
    for (const note of notes) {
      await adapter.put(g2NoteToRecord(note));
    }
    const newOrder = (await store.query('ag', { text: taskText, limit: 10 })).map(
      (h) => h.record.key,
    );
    expect(newOrder).toEqual(g2Order);
  });
});
