jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
// Empty mock: if the MEMORY_ENABLED gate ever leaked, the shadow path would hit
// this stub, throw, and surface as a console.warn (asserted below).
jest.mock('expo-file-system/legacy', () => ({}));

import {
  compareShadowRecall,
  runShadowComparison,
  shadowMemoryRecall,
  type ShadowDeps,
} from '@/lib/memory/shadow';
import { MEMORY_ENABLED, InMemoryMemoryStorage, MemoryStore, g2NoteToRecord } from '@/lib/memory';
import { recallMemoryNotes, type MemoryNote } from '@/lib/agent-memory';

function note(id: string, created: string, text: string, tags: string[] = []): MemoryNote {
  return { id, agentId: 'agent-7', type: 'fact', created, tags, text };
}

// Newest-first, like readMemoryNotes returns them.
const NOTES: MemoryNote[] = [
  note('fact-c', '2026-07-03T00:00:03Z', 'deploy target is the fold6 device', ['deploy']),
  note('fact-b', '2026-07-02T00:00:02Z', 'user prefers concise answers'),
  note('fact-a', '2026-07-01T00:00:01Z', 'api base url is example.com', ['api']),
];

const AGENT = { id: 'agent-7', name: 'deploy-bot', prompt: 'deploy the app to the device' };

function makeDeps(): ShadowDeps {
  const adapter = new InMemoryMemoryStorage();
  return {
    adapter,
    store: new MemoryStore({ adapter, clock: { now: () => 1_000 } }),
    importedAgents: new Set<string>(),
  };
}

describe('MEMORY-001 shadow seam — dormancy gate', () => {
  it('ships flag-OFF', () => {
    expect(MEMORY_ENABLED).toBe(false);
  });

  it('shadowMemoryRecall is a silent no-op while MEMORY_ENABLED=false', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // If the gate leaked, the lazy expo port would be constructed over the
      // empty expo-file-system mock, throw, and be logged via console.warn.
      await expect(shadowMemoryRecall(AGENT, NOTES)).resolves.toBeUndefined();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('compareShadowRecall (pure comparator)', () => {
  it('reports parity for identical order + content', () => {
    const live = recallMemoryNotes(NOTES, `${AGENT.name}\n${AGENT.prompt}`);
    const hits = live.map((n) => ({ record: g2NoteToRecord(n), score: 0 }));
    const cmp = compareShadowRecall(live, hits);
    expect(cmp.orderMatches).toBe(true);
    expect(cmp.contextMatches).toBe(true);
    expect(cmp.liveKeys).toEqual(cmp.shadowKeys);
  });

  it('flags an order divergence', () => {
    const live = [NOTES[0], NOTES[1]];
    const hits = [NOTES[1], NOTES[0]].map((n) => ({ record: g2NoteToRecord(n), score: 0 }));
    const cmp = compareShadowRecall(live, hits);
    expect(cmp.orderMatches).toBe(false);
  });

  it('flags a content divergence even when keys line up', () => {
    const live = [NOTES[0]];
    const mutated = { ...g2NoteToRecord(NOTES[0]), text: 'different text' };
    const cmp = compareShadowRecall(live, [{ record: mutated, score: 0 }]);
    expect(cmp.orderMatches).toBe(true);
    expect(cmp.contextMatches).toBe(false);
  });

  it('treats empty-vs-empty as parity (prompt unchanged on both sides)', () => {
    const cmp = compareShadowRecall([], []);
    expect(cmp.orderMatches).toBe(true);
    expect(cmp.contextMatches).toBe(true);
  });
});

describe('runShadowComparison (import → query → compare pipeline)', () => {
  it('imports G2 notes and reproduces the live recall order/content', async () => {
    const deps = makeDeps();
    const cmp = await runShadowComparison(AGENT, NOTES, deps);
    expect(cmp.orderMatches).toBe(true);
    expect(cmp.contextMatches).toBe(true);
    // Sanity: something was actually recalled on both sides.
    expect(cmp.liveKeys.length).toBeGreaterThan(0);
    expect(cmp.shadowKeys).toEqual(cmp.liveKeys);
  });

  it('preserves G2 createdAt on import (recency tiebreaks stay in parity)', async () => {
    const deps = makeDeps();
    await runShadowComparison(AGENT, NOTES, deps);
    const imported = await deps.adapter.get('agent-7', 'fact-a');
    // adapter.put (not store.put): createdAt must be the G2 note's created
    // timestamp, NOT the injected clock's now (1000).
    expect(imported?.createdAt).toBe(Date.parse('2026-07-01T00:00:01Z'));
  });

  it('imports each agent once per session (idempotent upsert either way)', async () => {
    const deps = makeDeps();
    const putSpy = jest.spyOn(deps.adapter, 'put');
    await runShadowComparison(AGENT, NOTES, deps);
    await runShadowComparison(AGENT, NOTES, deps);
    expect(putSpy).toHaveBeenCalledTimes(NOTES.length);
    expect((await deps.adapter.list('agent-7')).length).toBe(NOTES.length);
  });

  it('shadow recall with zero notes yields empty on both sides', async () => {
    const cmp = await runShadowComparison(AGENT, [], makeDeps());
    expect(cmp.liveKeys).toEqual([]);
    expect(cmp.shadowKeys).toEqual([]);
    expect(cmp.orderMatches).toBe(true);
    expect(cmp.contextMatches).toBe(true);
  });
});
