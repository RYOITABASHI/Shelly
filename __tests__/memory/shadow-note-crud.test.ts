// Memory Workbench — delete-by-id / edit-by-id on the shadow (strangler) layer.
//
// Same mock preamble as shadow.test.ts: the empty expo/noble mocks prove the
// lazy device port is never constructed when tests inject their own ShadowDeps,
// and keep ts-jest from parsing @noble/ciphers' ESM-only build.
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@noble/ciphers/aes.js', () => ({}));
jest.mock('@noble/ciphers/utils.js', () => ({}));
jest.mock('expo-crypto', () => ({}));
jest.mock('expo-secure-store', () => ({}));

import {
  deleteMemoryNoteById,
  updateMemoryNoteById,
  type ShadowDeps,
} from '@/lib/memory/shadow';
import { InMemoryMemoryStorage, MemoryStore, g2NoteToRecord } from '@/lib/memory';
import { GLOBAL_MEMORY_SCOPE, memoryNoteId, type MemoryNote } from '@/lib/agent-memory';
import * as agentMemoryModule from '@/lib/agent-memory';

function note(id: string, created: string, text: string, tags: string[] = []): MemoryNote {
  return { id, agentId: 'agent-7', type: 'fact', created, tags, text };
}

// Newest-first, like readMemoryNotes returns them.
const NOTES: MemoryNote[] = [
  note('fact-c', '2026-07-03T00:00:03Z', 'deploy target is the fold6 device', ['deploy']),
  note('fact-b', '2026-07-02T00:00:02Z', 'user prefers concise answers'),
  note('fact-a', '2026-07-01T00:00:01Z', 'api base url is example.com', ['api']),
];

function makeDeps(): ShadowDeps {
  const adapter = new InMemoryMemoryStorage();
  return {
    adapter,
    store: new MemoryStore({ adapter, clock: { now: () => 1_000 } }),
    importedAgents: new Set<string>(),
  };
}

async function seed(deps: ShadowDeps, agentId: string, notes: MemoryNote[]): Promise<void> {
  for (const n of notes) {
    await deps.adapter.put(g2NoteToRecord({ ...n, agentId }));
  }
  deps.importedAgents.add(agentId);
}

// Without this spy the real deleteMemoryNoteFile runs over the empty
// expo-file-system mock, throws internally, and reports false — so every
// success-path test needs the G2 file removal stubbed to "removed".
let deleteFileSpy: jest.SpyInstance;
beforeEach(() => {
  deleteFileSpy = jest
    .spyOn(agentMemoryModule, 'deleteMemoryNoteFile')
    .mockResolvedValue(true);
});
afterEach(() => {
  deleteFileSpy.mockRestore();
});

describe('deleteMemoryNoteById', () => {
  it('removes the record from the store and the G2 .md file', async () => {
    const deps = makeDeps();
    await seed(deps, 'agent-7', NOTES);
    const ok = await deleteMemoryNoteById('agent-7', 'fact-b', deps);
    expect(ok).toBe(true);
    expect((await deps.adapter.list('agent-7')).map((r) => r.key).sort()).toEqual([
      'fact-a',
      'fact-c',
    ]);
    expect(deleteFileSpy).toHaveBeenCalledWith('agent-7', 'fact-b');
  });

  it('mirror-imports G2 notes first so a disk-only note cannot resurrect', async () => {
    const deps = makeDeps();
    const readSpy = jest.spyOn(agentMemoryModule, 'readMemoryNotes').mockResolvedValue(NOTES);
    try {
      const ok = await deleteMemoryNoteById('agent-7', 'fact-b', deps);
      expect(ok).toBe(true);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(deps.importedAgents.has('agent-7')).toBe(true);
      // The other two G2 notes were imported; only the target was deleted.
      expect((await deps.adapter.list('agent-7')).map((r) => r.key).sort()).toEqual([
        'fact-a',
        'fact-c',
      ]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('works for the shared _global scope', async () => {
    const deps = makeDeps();
    await seed(deps, GLOBAL_MEMORY_SCOPE, [note('fact-g', '2026-07-04T00:00:00Z', 'shared fact')]);
    const ok = await deleteMemoryNoteById(GLOBAL_MEMORY_SCOPE, 'fact-g', deps);
    expect(ok).toBe(true);
    expect(await deps.adapter.list(GLOBAL_MEMORY_SCOPE)).toEqual([]);
  });

  it('returns false and warns when the store delete throws (caller falls back, never crashes)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      await seed(deps, 'agent-7', NOTES);
      jest.spyOn(deps.store, 'delete').mockRejectedValue(new Error('disk exploded'));
      const ok = await deleteMemoryNoteById('agent-7', 'fact-b', deps);
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      // Store delete failed first — the G2 file must survive too, or the
      // store copy would outlive its authoritative source inconsistently.
      expect(deleteFileSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns false when the G2 file removal fails (the note would resurrect next launch)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      await seed(deps, 'agent-7', NOTES);
      deleteFileSpy.mockResolvedValue(false);
      const ok = await deleteMemoryNoteById('agent-7', 'fact-b', deps);
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('updateMemoryNoteById', () => {
  it('rewrites the text, rederives the id, drops the stale key and G2 file, preserves createdAt', async () => {
    const deps = makeDeps();
    await seed(deps, 'agent-7', NOTES);
    const updated = await updateMemoryNoteById(
      { agentId: 'agent-7', id: 'fact-a', text: 'api base url moved to example.org' },
      deps
    );
    expect(updated).not.toBeNull();
    expect(updated!.id).not.toBe('fact-a');
    expect(updated!.id).toBe(memoryNoteId('agent-7', 'fact', 'api base url moved to example.org'));
    // Stale key gone, new record present with the G2 created timestamp preserved.
    expect(await deps.adapter.get('agent-7', 'fact-a')).toBeNull();
    const record = await deps.adapter.get('agent-7', updated!.id);
    expect(record?.text).toBe('api base url moved to example.org');
    expect(record?.createdAt).toBe(Date.parse('2026-07-01T00:00:01Z'));
    // The old G2 .md must be removed or the pre-edit note resurrects on the
    // next session's mirror-import.
    expect(deleteFileSpy).toHaveBeenCalledWith('agent-7', 'fact-a');
  });

  it('keeps the id on a tags-only edit and normalizes tags like G2', async () => {
    const deps = makeDeps();
    await seed(deps, 'agent-7', NOTES);
    const updated = await updateMemoryNoteById(
      {
        agentId: 'agent-7',
        id: 'fact-a',
        text: 'api base url is example.com',
        tags: ['API', 'Foo Bar'],
      },
      deps
    );
    expect(updated!.id).toBe(memoryNoteId('agent-7', 'fact', 'api base url is example.com'));
    const record = await deps.adapter.get('agent-7', updated!.id);
    expect(record?.tags).toEqual(['api', 'foo-bar']);
  });

  it('preserves the note type (kind) of the existing record', async () => {
    const deps = makeDeps();
    const pref: MemoryNote = {
      id: 'preference-x',
      agentId: 'agent-7',
      type: 'preference',
      created: '2026-07-05T00:00:00Z',
      tags: [],
      text: 'prefers dark mode',
    };
    await seed(deps, 'agent-7', [pref]);
    const updated = await updateMemoryNoteById(
      { agentId: 'agent-7', id: 'preference-x', text: 'prefers light mode' },
      deps
    );
    expect(updated!.type).toBe('preference');
    expect(updated!.id.startsWith('preference-')).toBe(true);
  });

  it('inherits makeMemoryNote truncation (MAX_NOTE_CHARS = 1200)', async () => {
    const deps = makeDeps();
    await seed(deps, 'agent-7', NOTES);
    const updated = await updateMemoryNoteById(
      { agentId: 'agent-7', id: 'fact-a', text: 'x'.repeat(2000) },
      deps
    );
    expect(updated!.text.length).toBe(1200);
  });

  it('attaches PII-taint metadata (kinds only) like activateMemoryWrite', async () => {
    const deps = makeDeps();
    await seed(deps, 'agent-7', NOTES);
    const updated = await updateMemoryNoteById(
      {
        agentId: 'agent-7',
        id: 'fact-a',
        text: 'I was diagnosed with anxiety disorder last spring',
      },
      deps
    );
    const record = await deps.adapter.get('agent-7', updated!.id);
    expect(record?.metadata?.piiTaint).toBe('true');
    expect(record?.metadata?.piiKinds).toContain('health-condition');
  });

  it('returns null for an unknown note id', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      await seed(deps, 'agent-7', NOTES);
      const updated = await updateMemoryNoteById(
        { agentId: 'agent-7', id: 'fact-nope', text: 'anything' },
        deps
      );
      expect(updated).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses an empty replacement text', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      await seed(deps, 'agent-7', NOTES);
      const updated = await updateMemoryNoteById(
        { agentId: 'agent-7', id: 'fact-a', text: '   ' },
        deps
      );
      expect(updated).toBeNull();
      // Nothing was destroyed by the refused edit.
      expect(await deps.adapter.get('agent-7', 'fact-a')).not.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns null and warns when the adapter throws (fallback pattern, never throws)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      await seed(deps, 'agent-7', NOTES);
      jest.spyOn(deps.adapter, 'put').mockRejectedValue(new Error('disk exploded'));
      const updated = await updateMemoryNoteById(
        { agentId: 'agent-7', id: 'fact-a', text: 'new text' },
        deps
      );
      expect(updated).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
