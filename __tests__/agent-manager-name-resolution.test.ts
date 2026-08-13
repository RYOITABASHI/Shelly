jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { parseAgentCommand, resolveAgentByNameLoose } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

// 2026-08-13 on-device QA finding: lib/agent-nl-parser.ts's deriveName used to
// hard-truncate the PERSISTED agent.name at 28 chars with a trailing "…" for
// display purposes. Since `@agent run <name>` (and stop/delete/history/edit)
// required a byte-EXACT match against that same truncated identity, and the
// Sidebar row applied its OWN independent numberOfLines={1} ellipsis on top
// of the already-truncated name, what a user could read/copy off the Sidebar
// rarely lined up with the true stored name — so a copy-pasted (or manually
// retyped) name from the UI routinely failed to resolve to any agent at all.
// The fix has two parts, covered here:
//   (1) lib/agent-nl-parser.ts's deriveName no longer truncates the stored
//       name (see its own test coverage in agent-nl-parser.test.ts).
//   (2) this file: name resolution for run/stop/delete/history/edit is no
//       longer exact-match-only — it falls through to prefix, then
//       substring matching, and refuses to silently guess when a tier
//       produces more than one candidate.
function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2)}`,
    name: 'Untitled',
    description: '',
    prompt: 'do the thing',
    schedule: null,
    notificationTrigger: null,
    tool: { type: 'cli', cli: 'codex' },
    outputPath: '/tmp/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: Date.now(),
    version: 1,
    ...overrides,
  } as Agent;
}

describe('resolveAgentByNameLoose', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
  });

  it('resolves an exact (case-insensitive, trimmed) match — same semantics as the old exact-only lookup', () => {
    const agent = makeAgent({ id: 'a1', name: 'Morning News' });
    const result = resolveAgentByNameLoose([agent], '  morning news  ');
    expect(result.agent).toBe(agent);
    expect(result.ambiguous).toBeUndefined();
  });

  it('resolves a truncated-with-ellipsis name (the exact on-device repro shape) via prefix match', () => {
    // The real persisted name, as it would have been BEFORE the deriveName
    // fix, and as a user might still type/paste a shortened version of a
    // long name.
    const agent = makeAgent({
      id: 'a1',
      name: 'when I get a notification from Gmail notify me with a summary',
    });
    const result = resolveAgentByNameLoose([agent], 'when I get a notification fr…');
    expect(result.agent).toBe(agent);
    expect(result.ambiguous).toBeUndefined();
  });

  it('also strips a naive "..." (three periods) typed in place of the real ellipsis char', () => {
    const agent = makeAgent({ id: 'a1', name: 'Weekly report generator for the finance team' });
    const result = resolveAgentByNameLoose([agent], 'Weekly report generator for the...');
    expect(result.agent).toBe(agent);
  });

  it('resolves a substring (mid-name) match when no prefix matches', () => {
    const agent = makeAgent({ id: 'a1', name: 'Daily Gmail notification summary' });
    const result = resolveAgentByNameLoose([agent], 'Gmail notification');
    expect(result.agent).toBe(agent);
  });

  it('returns ambiguous (never a silent first-pick) when 2+ agents share the same prefix', () => {
    const a1 = makeAgent({ id: 'a1', name: 'Gmail summary morning' });
    const a2 = makeAgent({ id: 'a2', name: 'Gmail summary evening' });
    const result = resolveAgentByNameLoose([a1, a2], 'Gmail summary');
    expect(result.agent).toBeNull();
    expect(result.ambiguous).toEqual(expect.arrayContaining([a1, a2]));
    expect(result.ambiguous).toHaveLength(2);
  });

  it('prefers an exact match over a broader prefix/substring collision (exact tier short-circuits)', () => {
    const exact = makeAgent({ id: 'a1', name: 'News' });
    const longer = makeAgent({ id: 'a2', name: 'News Digest' });
    const result = resolveAgentByNameLoose([exact, longer], 'News');
    expect(result.agent).toBe(exact);
    expect(result.ambiguous).toBeUndefined();
  });

  it('returns { agent: null } with no ambiguity when nothing matches at all', () => {
    const agent = makeAgent({ id: 'a1', name: 'Completely unrelated task' });
    const result = resolveAgentByNameLoose([agent], 'nonexistent xyz');
    expect(result.agent).toBeNull();
    expect(result.ambiguous).toBeUndefined();
  });

  it('returns { agent: null } for an empty/whitespace-only query', () => {
    const agent = makeAgent({ id: 'a1', name: 'Something' });
    expect(resolveAgentByNameLoose([agent], '').agent).toBeNull();
    expect(resolveAgentByNameLoose([agent], '   ').agent).toBeNull();
  });
});

describe('parseAgentCommand — run/stop/delete/history/edit name resolution', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
  });

  it('"@agent run" resolves a truncated/prefix name instead of requiring the byte-exact stored name', () => {
    const agent = makeAgent({
      id: 'a1',
      name: 'when I get a notification from Gmail notify me with a summary',
    });
    useAgentStore.getState().setAgents([agent]);

    const result = parseAgentCommand('run when I get a notification fr…');
    expect(result.type).toBe('run');
    expect(result.data.agentId).toBe('a1');
  });

  it('"@agent stop" also benefits from the same loose resolution', () => {
    const agent = makeAgent({ id: 'a1', name: 'Long running background sync task' });
    useAgentStore.getState().setAgents([agent]);

    const result = parseAgentCommand('stop Long running background');
    expect(result.type).toBe('stop');
    expect(result.data.agentId).toBe('a1');
  });

  it('"@agent run" on an ambiguous prefix returns a distinct error instead of silently running the first match', () => {
    const a1 = makeAgent({ id: 'a1', name: 'Gmail summary morning' });
    const a2 = makeAgent({ id: 'a2', name: 'Gmail summary evening' });
    useAgentStore.getState().setAgents([a1, a2]);

    const result = parseAgentCommand('run Gmail summary');
    expect(result.type).toBe('error');
    expect(result.message).toMatch(/Gmail summary morning/);
    expect(result.message).toMatch(/Gmail summary evening/);
    // Never silently picks one when ambiguous.
    expect(result.data).toBeUndefined();
  });

  it('"@agent run" on a genuinely unknown name still reports not-found (no regression)', () => {
    useAgentStore.getState().setAgents([makeAgent({ id: 'a1', name: 'Something else entirely' })]);
    const result = parseAgentCommand('run totally-unrelated-name');
    expect(result.type).toBe('error');
    expect(result.message).toMatch(/not found/i);
  });

  it('"@agent delete" resolves the same way as "run" (consistent across subcommands)', () => {
    const agent = makeAgent({ id: 'a1', name: 'Nightly backup to cloud storage' });
    useAgentStore.getState().setAgents([agent]);

    const result = parseAgentCommand('delete Nightly backup');
    expect(result.type).toBe('delete');
    expect(result.data.agent.id).toBe('a1');
  });
});
