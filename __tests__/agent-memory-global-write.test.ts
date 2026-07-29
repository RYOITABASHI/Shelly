/* eslint-disable import/first -- Jest mocks must be registered before imports. */
/**
 * __tests__/agent-memory-global-write.test.ts
 *
 * The user-scope (`_global`) WRITE path, exercised against the REAL
 * lib/agent-manager.ts writeGlobalMemoryNote (not a mock).
 *
 * Roadmap item 3 shipped this function with no production caller at all: a
 * shared note could only be created by hand-writing the file on-device, so the
 * two behaviors that make it safe — writing into the reserved `_global`
 * namespace, and re-baking EVERY agent's baked recall afterwards — had never
 * been asserted anywhere. Now that hooks/use-ai-pane-dispatch.ts calls it for
 * real (behind a mandatory confirm turn — see
 * lib/agent-global-memory-intent.ts), they are.
 *
 * Why the re-bake matters: recall is BAKED into each agent's on-disk run
 * script at materialize time. An unattended, AlarmManager-fired run reads that
 * baked script with no JS in the loop, so without a re-bake a brand-new shared
 * note would stay invisible to every scheduled agent until the next app
 * launch. Re-baking on write (rather than reading memory from inside the fired
 * script) is what keeps the G2 secret-guard invariant intact: the merged
 * prompt still passes through resolveAgentRoute on the JS side BEFORE a
 * backend is chosen, so a secret in a global note forces the run on-device
 * exactly like a secret in an agent-scoped one.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
    scheduleAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
// Same as the sibling agent-manager suites: readMemoryNotes' FileSystem reads
// fall back to an empty list, which is all this file needs (it asserts on the
// SHELL commands writeGlobalMemoryNote issues, not on recall content).
jest.mock('expo-file-system/legacy', () => ({}));

import { writeGlobalMemoryNote } from '@/lib/agent-manager';
import { GLOBAL_MEMORY_SCOPE } from '@/lib/agent-memory';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    description: '',
    prompt: '最新ニュースを集めて',
    schedule: '0 8 * * *',
    tool: { type: 'gemini-api' },
    autonomous: false,
    outputPath: '~/out',
    outputTemplate: null,
    action: { type: 'notify' },
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  } as Agent;
}

function setAgents(agents: Agent[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same shape the
  // sibling agent-manager suites use to seed the store directly.
  useAgentStore.setState({ agents } as any);
}

beforeEach(() => {
  setAgents([]);
});

describe('writeGlobalMemoryNote', () => {
  it('writes the note into the reserved _global namespace, not into any agent', async () => {
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });

    await writeGlobalMemoryNote(runCommand, { type: 'preference', text: '返信は日本語で' });

    const write = commands.find((c) => c.includes('/.shelly/agents/memory/'));
    expect(write).toBeDefined();
    expect(write).toContain(`/.shelly/agents/memory/${GLOBAL_MEMORY_SCOPE}/`);
    // The frontmatter carries the reserved scope id, which is what makes every
    // agent's recall pick it up (lib/agent-manager.ts's applyMemoryAndSkills).
    expect(write).toContain(`agentId: ${GLOBAL_MEMORY_SCOPE}`);
    expect(write).toContain('返信は日本語で');
    // Crash-safe shape, identical to an agent-scoped note — no bespoke path.
    expect(write).toContain('set -e');
    expect(write).toMatch(/\[ -s .* \] \|\|/);
  });

  it('re-bakes EVERY registered agent, because every agent recalls a global note', async () => {
    setAgents([makeAgent('agent-alpha'), makeAgent('agent-beta'), makeAgent('agent-gamma')]);
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });

    await writeGlobalMemoryNote(runCommand, { type: 'preference', text: '単位はメートル法' });

    for (const id of ['agent-alpha', 'agent-beta', 'agent-gamma']) {
      // materializeAgent rewrites each agent's on-disk metadata/run script, so
      // its id shows up in at least one command issued after the note write.
      expect(commands.some((c) => c.includes(id))).toBe(true);
    }
  });

  it('does not touch any agent script when there are no agents registered', async () => {
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });

    await writeGlobalMemoryNote(runCommand, { type: 'preference', text: 'タイムゾーンはJST' });

    expect(commands.some((c) => c.includes(`/memory/${GLOBAL_MEMORY_SCOPE}/`))).toBe(true);
    expect(commands.some((c) => /agent-[a-z0-9]+\.(?:json|sh)/.test(c))).toBe(false);
  });

  it('writes a secret verbatim so the JS-side route scan can still see it (G2)', async () => {
    // DEFERRED.md's invariant: "globalノート内のsecretもagent別ノートと全く同じ
    // ようにローカル実行を強制する". The note must therefore land on disk
    // UNREDACTED — redacting it here would hide it from resolveAgentRoute's
    // scan of the merged prompt and silently allow a cloud route.
    setAgents([makeAgent('agent-alpha')]);
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return '';
    });

    await writeGlobalMemoryNote(runCommand, {
      type: 'preference',
      text: 'deploy token is sk-live-ABCDEF1234567890',
    });

    const write = commands.find((c) => c.includes(`/memory/${GLOBAL_MEMORY_SCOPE}/`))!;
    expect(write).toContain('sk-live-ABCDEF1234567890');
    expect(write).not.toContain('<redacted>');
  });

  it('is idempotent — re-stating the same preference targets the same note file', async () => {
    const paths: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      const m = cmd.match(/\/memory\/_global\/([A-Za-z0-9_-]+)\.md/);
      if (m) paths.push(m[1]);
      return '';
    });

    await writeGlobalMemoryNote(runCommand, { type: 'preference', text: '返信は日本語で' });
    await writeGlobalMemoryNote(runCommand, { type: 'preference', text: '返信は日本語で' });

    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paths).size).toBe(1);
  });
});
