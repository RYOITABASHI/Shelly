/**
 * User-scope (`_global`) memory namespace — roadmap item 3, part 1.
 *
 * Covers the pure surface: scope detection, note construction, merged recall
 * ranking across scopes, and the rendered recall block's shape (which must keep
 * the per-line format the MEMORY-001 parity checks depend on).
 */
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: false, isDirectory: false })),
  readDirectoryAsync: jest.fn(async () => []),
  readAsStringAsync: jest.fn(async () => ''),
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/test' }));

import {
  GLOBAL_MEMORY_SCOPE,
  buildGlobalRecallContext,
  buildMemoryNoteMarkdown,
  buildRecallContext,
  isGlobalMemoryScope,
  makeGlobalMemoryNote,
  makeMemoryNote,
  parseMemoryNoteMarkdown,
  recallMemoryNotes,
  type MemoryNote,
} from '@/lib/agent-memory';

const iso = (n: number) => new Date(Date.UTC(2026, 6, 28, 0, 0, n)).toISOString();

describe('the _global scope', () => {
  it('is a reserved id that cannot collide with a generated agent id', () => {
    expect(GLOBAL_MEMORY_SCOPE).toBe('_global');
    expect(isGlobalMemoryScope('_global')).toBe(true);
    expect(isGlobalMemoryScope('agent-ms4aagxz')).toBe(false);
    // createAgent generates `agent-<base36>`; the leading underscore is outside
    // that space, so no real agent can ever land in the global namespace.
    expect(GLOBAL_MEMORY_SCOPE.startsWith('agent-')).toBe(false);
  });

  it('builds a global note through the same normalization as an agent note', () => {
    const note = makeGlobalMemoryNote({
      type: 'preference',
      text: '  返信は日本語で  ',
      tags: ['Language', 'lang!!'],
      created: iso(0),
    });
    expect(note.agentId).toBe(GLOBAL_MEMORY_SCOPE);
    expect(note.text).toBe('返信は日本語で');
    expect(note.tags).toEqual(['language', 'lang']);
  });

  it('round-trips through the existing markdown format with no schema change', () => {
    const note = makeGlobalMemoryNote({ type: 'fact', text: 'user lives in Tokyo', created: iso(0) });
    const parsed = parseMemoryNoteMarkdown(buildMemoryNoteMarkdown(note));
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe(GLOBAL_MEMORY_SCOPE);
    expect(parsed!.text).toBe('user lives in Tokyo');
  });
});

describe('merged recall across scopes', () => {
  const own: MemoryNote = makeMemoryNote({
    agentId: 'agent-a',
    type: 'result',
    text: 'yesterday the crypto digest covered ETH',
    tags: ['crypto'],
    created: iso(1),
  });
  const global: MemoryNote = makeGlobalMemoryNote({
    type: 'preference',
    text: 'always answer in Japanese',
    tags: ['language'],
    created: iso(2), // newer
  });

  // readMemoryNotesForRecall returns the union newest-first; mirror that here.
  const merged = [global, own];

  it('ranks a relevant global note above an irrelevant agent note', () => {
    const out = recallMemoryNotes(merged, 'language preference for the reply', 1);
    expect(out[0].agentId).toBe(GLOBAL_MEMORY_SCOPE);
  });

  it('still ranks a relevant agent note above an unrelated global one', () => {
    const out = recallMemoryNotes(merged, 'give me the crypto digest', 1);
    expect(out[0].agentId).toBe('agent-a');
  });

  it('can return both scopes together', () => {
    const out = recallMemoryNotes(merged, 'crypto digest in Japanese', 2);
    expect(out.map((n) => n.agentId).sort()).toEqual(['_global', 'agent-a']);
  });
});

describe('buildRecallContext with mixed scopes', () => {
  const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'agent fact', created: iso(1) });
  const global = makeGlobalMemoryNote({ type: 'preference', text: 'global pref', created: iso(2) });

  it('keeps the agent-scoped block byte-identical to before', () => {
    expect(buildRecallContext([own])).toBe(
      [
        '# Remembered context (on-device memory)',
        'These facts were saved from earlier runs or by the user. Use them if relevant.',
        '- [fact] agent fact',
      ].join('\n')
    );
  });

  it('emits shared context in its own labelled section', () => {
    const ctx = buildRecallContext([global, own]);
    expect(ctx).toContain('# Remembered context (on-device memory)');
    expect(ctx).toContain('# Shared context (applies to every agent)');
    expect(ctx).toContain('- [fact] agent fact');
    expect(ctx).toContain('- [preference] global pref');
    // The agent block comes first — this run's own context leads.
    expect(ctx.indexOf('# Remembered context')).toBeLessThan(ctx.indexOf('# Shared context'));
  });

  it('emits only the shared section when the agent has no notes of its own', () => {
    const ctx = buildRecallContext([global]);
    expect(ctx).not.toContain('# Remembered context (on-device memory)');
    expect(ctx).toContain('# Shared context (applies to every agent)');
  });

  it('is still empty for an agent with no memory at all', () => {
    expect(buildRecallContext([])).toBe('');
  });

  it('keeps the per-line format identical across scopes (MEMORY-001 parity)', () => {
    for (const line of buildRecallContext([global, own]).split('\n')) {
      if (!line.startsWith('- ')) continue;
      expect(line).toMatch(/^- \[(fact|preference|result)\] .+$/);
    }
  });
});

describe('buildGlobalRecallContext', () => {
  it('renders only global notes and ignores agent-scoped ones', () => {
    const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'agent fact', created: iso(1) });
    const global = makeGlobalMemoryNote({ type: 'fact', text: 'global fact', created: iso(2) });
    const ctx = buildGlobalRecallContext([own, global]);
    expect(ctx).toContain('- [fact] global fact');
    expect(ctx).not.toContain('agent fact');
  });

  it('is empty when there is nothing shared to say', () => {
    expect(buildGlobalRecallContext([])).toBe('');
    const own = makeMemoryNote({ agentId: 'agent-a', type: 'fact', text: 'x', created: iso(1) });
    expect(buildGlobalRecallContext([own])).toBe('');
  });
});
