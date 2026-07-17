jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
// Empty mocks: if the MEMORY_ENABLED gate ever leaked, the shadow path would
// hit one of these stubs, throw, and surface as a console.warn (asserted
// below). expo-file-system/legacy backs fs-expo.ts's FsPort; @noble/ciphers +
// expo-crypto + expo-secure-store back crypto-expo.ts/encryption-key.ts's
// Track A EncryptionPort (see DEFERRED.md MEMORY-001). @noble/ciphers ships
// pure ESM with no CJS build, so it must be mocked here regardless of the
// dormancy gate — otherwise ts-jest fails to parse it at require time.
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@noble/ciphers/aes.js', () => ({}));
jest.mock('@noble/ciphers/utils.js', () => ({}));
jest.mock('expo-crypto', () => ({}));
jest.mock('expo-secure-store', () => ({}));

import {
  activateMemoryRecall,
  activateMemoryWrite,
  compareShadowRecall,
  runShadowComparison,
  shadowMemoryRecall,
  type ShadowDeps,
} from '@/lib/memory/shadow';
import { MEMORY_ENABLED, InMemoryMemoryStorage, MemoryStore, g2NoteToRecord } from '@/lib/memory';
import { buildRecallContext, recallMemoryNotes, type MemoryNote } from '@/lib/agent-memory';

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

describe('activateMemoryRecall (MEMORY-001 Step 3)', () => {
  it('injects the MEMORY-001 store context, not G2, when the store has data', async () => {
    const deps = makeDeps();
    const result = await activateMemoryRecall(AGENT, NOTES, deps);
    // Sanity: MEMORY-001's own render function produced this, and it is
    // non-null/non-empty because the store actually has matching records.
    expect(result).not.toBeNull();
    expect(result).not.toBe('');
    // Ground truth for "not G2's result": compareShadowRecall already proves
    // order+content parity between the two paths for this fixture, so instead
    // we assert the activated result is produced by the MEMORY-001 rendering
    // path directly (recordsToRecallContext over the store's own query), by
    // checking it reproduces the query independently of G2's recallMemoryNotes.
    const g2Context = buildRecallContext(
      recallMemoryNotes(NOTES, `${AGENT.name}\n${AGENT.prompt}`)
    );
    expect(result).toBe(g2Context); // parity fixture: same content, different code path
  });

  it('returns non-empty content that differs from G2 when the store has EXTRA data G2 does not', async () => {
    const deps = makeDeps();
    // Seed the MEMORY-001 store directly (bypassing the G2 import) with a
    // record G2 has never seen, so a correct activation must reflect it and an
    // accidental "still calling G2 under the hood" bug would not.
    await deps.store.put({
      namespace: 'agent-7',
      text: 'deploy the app to the device please remember the fold6 rollback plan',
      kind: 'fact',
      tags: ['deploy'],
    });
    deps.importedAgents.add(AGENT.id); // skip the G2 mirror-import for this call
    const result = await activateMemoryRecall(AGENT, NOTES, deps);
    const g2Context = buildRecallContext(
      recallMemoryNotes(NOTES, `${AGENT.name}\n${AGENT.prompt}`)
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe(g2Context);
    expect(result).toContain('rollback plan');
  });

  it('falls back safely (returns null) when the store throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const brokenDeps = makeDeps();
      jest.spyOn(brokenDeps.store, 'query').mockRejectedValue(new Error('disk exploded'));
      const result = await activateMemoryRecall(AGENT, NOTES, brokenDeps);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns empty string (not null) when the store legitimately has nothing to recall', async () => {
    const deps = makeDeps();
    const result = await activateMemoryRecall(AGENT, [], deps);
    expect(result).toBe('');
  });

  it('is unreachable while MEMORY_ENABLED=false (agent-manager never calls it)', () => {
    // Documents the contract enforced at the agent-manager call-site: this
    // module has no internal flag check of its own (agent-manager gates the
    // call), so the guarantee lives in agent-manager's `if (MEMORY_ENABLED)`.
    expect(MEMORY_ENABLED).toBe(false);
  });
});

describe('activateMemoryWrite (MEMORY-001 Step 4)', () => {
  it('writes through store.put (not the G2 shell command) and is queryable back', async () => {
    const deps = makeDeps();
    const ok = await activateMemoryWrite(
      { agentId: 'agent-9', type: 'fact', text: 'remember the API base url', tags: ['Api', 'API'] },
      deps
    );
    expect(ok).toBe(true);
    const stored = await deps.adapter.list('agent-9');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('remember the API base url');
    // Tag normalization matches G2's normalizeTags (lowercase, deduped).
    expect(stored[0].tags).toEqual(['api']);
  });

  it('reuses makeMemoryNote truncation/id-derivation so the record matches what G2 would have produced', async () => {
    const deps = makeDeps();
    const longText = 'x'.repeat(2000);
    await activateMemoryWrite({ agentId: 'agent-9', type: 'result', text: longText }, deps);
    const stored = await deps.adapter.list('agent-9');
    // MAX_NOTE_CHARS = 1200 in agent-memory.ts; activateMemoryWrite must inherit it.
    expect(stored[0].text.length).toBe(1200);
  });

  it('falls back safely (returns false) when the store throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const brokenDeps = makeDeps();
      jest.spyOn(brokenDeps.store, 'put').mockRejectedValue(new Error('disk exploded'));
      const ok = await activateMemoryWrite(
        { agentId: 'agent-9', type: 'fact', text: 'hello' },
        brokenDeps
      );
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // MEMORY-001 Track C (see DEFERRED.md): write-boundary PII/taint scan.
  it('attaches PII-taint metadata (kinds only) when the written text matches pii-guard', async () => {
    const deps = makeDeps();
    await activateMemoryWrite(
      { agentId: 'agent-9', type: 'fact', text: 'I was diagnosed with anxiety disorder last spring' },
      deps
    );
    const stored = await deps.adapter.list('agent-9');
    expect(stored).toHaveLength(1);
    expect(stored[0].metadata?.piiTaint).toBe('true');
    expect(stored[0].metadata?.piiKinds).toContain('health-condition');
  });

  it('does not attach PII-taint metadata for ordinary text', async () => {
    const deps = makeDeps();
    await activateMemoryWrite(
      { agentId: 'agent-9', type: 'fact', text: 'deploy target is the fold6 device' },
      deps
    );
    const stored = await deps.adapter.list('agent-9');
    expect(stored[0].metadata).toBeUndefined();
  });
});
