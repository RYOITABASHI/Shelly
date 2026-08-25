/**
 * Companion-journal (`_companion`) memory namespace — "一人の相棒" Gap②
 * (2026-08-25). Mirrors __tests__/agent-memory-global-scope.test.ts's
 * coverage shape for the sibling `_global` scope, but for the
 * companion-only namespace: scope detection, note construction, and the
 * rendered recall block's shape.
 */
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: false, isDirectory: false })),
  readDirectoryAsync: jest.fn(async () => []),
  readAsStringAsync: jest.fn(async () => ''),
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/test' }));

import {
  COMPANION_MEMORY_SCOPE,
  GLOBAL_MEMORY_SCOPE,
  buildCompanionRecallContext,
  buildGlobalRecallContext,
  buildMemoryNoteMarkdown,
  isCompanionMemoryScope,
  isGlobalMemoryScope,
  makeMemoryNote,
  parseMemoryNoteMarkdown,
  type MemoryNote,
} from '@/lib/agent-memory';

const iso = (n: number) => new Date(Date.UTC(2026, 7, 25, 0, 0, n)).toISOString();

describe('the _companion scope', () => {
  it('is a reserved id, distinct from _global, that cannot collide with a generated agent id', () => {
    expect(COMPANION_MEMORY_SCOPE).toBe('_companion');
    expect(isCompanionMemoryScope('_companion')).toBe(true);
    expect(isCompanionMemoryScope('agent-ms4aagxz')).toBe(false);
    expect(isCompanionMemoryScope(GLOBAL_MEMORY_SCOPE)).toBe(false);
    expect(isGlobalMemoryScope(COMPANION_MEMORY_SCOPE)).toBe(false);
    expect(COMPANION_MEMORY_SCOPE.startsWith('agent-')).toBe(false);
  });

  it('builds a companion note through the same normalization as an agent note', () => {
    const note = makeMemoryNote({
      agentId: COMPANION_MEMORY_SCOPE,
      type: 'fact',
      text: '  user is planning a trip to Kyoto in October  ',
      created: iso(0),
    });
    expect(note.agentId).toBe(COMPANION_MEMORY_SCOPE);
    expect(note.text).toBe('user is planning a trip to Kyoto in October');
  });

  it('round-trips through the existing markdown format with no schema change', () => {
    const note = makeMemoryNote({ agentId: COMPANION_MEMORY_SCOPE, type: 'fact', text: 'prefers dark mode', created: iso(0) });
    const parsed = parseMemoryNoteMarkdown(buildMemoryNoteMarkdown(note));
    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe(COMPANION_MEMORY_SCOPE);
    expect(parsed!.text).toBe('prefers dark mode');
  });
});

describe('buildCompanionRecallContext', () => {
  const companionNote: MemoryNote = makeMemoryNote({
    agentId: COMPANION_MEMORY_SCOPE, type: 'fact', text: 'code word for today is PAPAYA99', created: iso(1),
  });
  const globalNote: MemoryNote = makeMemoryNote({
    agentId: GLOBAL_MEMORY_SCOPE, type: 'preference', text: 'replies in Japanese', created: iso(2),
  });
  const agentNote: MemoryNote = makeMemoryNote({
    agentId: 'agent-a', type: 'result', text: 'yesterday the digest covered ETH', created: iso(3),
  });

  it('returns empty string when there are no companion notes', () => {
    expect(buildCompanionRecallContext([])).toBe('');
    expect(buildCompanionRecallContext([globalNote, agentNote])).toBe('');
  });

  it('includes only companion-scoped notes, ignoring global and per-agent notes in the same array', () => {
    const block = buildCompanionRecallContext([companionNote, globalNote, agentNote]);
    expect(block).toContain('PAPAYA99');
    expect(block).not.toContain('replies in Japanese');
    expect(block).not.toContain('ETH');
  });

  it('is a separate block from buildGlobalRecallContext -- the two scopes never merge into one heading', () => {
    const companionBlock = buildCompanionRecallContext([companionNote]);
    const globalBlock = buildGlobalRecallContext([globalNote]);
    expect(companionBlock).not.toEqual(globalBlock);
    expect(companionBlock).toContain('Companion journal');
    expect(globalBlock).toContain('Shared context');
  });
});
