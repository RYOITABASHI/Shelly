/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// extractText → agent perception-loop fix (Fable5 P1, 2026-08-29, DEFERRED.md):
// a browser-pane extractText result used to reach only the human (an in-app
// Alert in app/_layout.tsx) because the executor process that requested it
// had already exited by the time the DOM read resolved (fire-then-reply
// design). captureBrowserExtractMemory (lib/agent-manager.ts) mirrors the
// extracted text into the requesting agent's own memory, gated the same way
// every other memory write in this file is (agent.memory.remember), so it is
// recalled into that agent's NEXT run prompt via buildRecallContext.

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
jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
}));
// Empty FileSystem mock: readMemoryNotes falls back to an empty list, same as
// the existing scheduled-memory-capture suite.
jest.mock('expo-file-system/legacy', () => ({}));
// lib/memory/shadow.ts lazily require()s @noble/ciphers (pure ESM, unparsable
// under Jest's default CJS transform) the first time activateMemoryWrite
// actually runs. Force the MEMORY_ENABLED branch to report "internal
// failure" so every test below exercises the same G2 (writeMemoryNote)
// fallback path the pre-existing scheduled-memory-capture suite already
// covers, instead of tripping that unrelated parse error.
jest.mock('@/lib/memory/shadow', () => ({
  activateMemoryWrite: jest.fn(async () => false),
  invalidateMemoryImportCache: jest.fn(),
}));

import { captureBrowserExtractMemory } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'browser-agent',
    name: 'Browser agent',
    description: '',
    prompt: 'ページを要約して',
    schedule: null,
    tool: { type: 'gemini-api' },
    autonomous: false,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  };
}

function buildRunCommand() {
  const memoryWrites: string[] = [];
  const runCommand = jest.fn(async (command: string): Promise<string> => {
    if (command.includes('.shelly/agents/memory/')) {
      memoryWrites.push(command);
      return '';
    }
    return '';
  });
  return { runCommand, memoryWrites };
}

describe('captureBrowserExtractMemory', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    jest.clearAllMocks();
  });

  it('writes an extracted page result into the requesting agent memory when remember is enabled', async () => {
    const agent = makeAgent({ memory: { remember: true, tags: ['research'] } });
    useAgentStore.getState().setAgents([agent]);
    const { runCommand, memoryWrites } = buildRunCommand();

    await captureBrowserExtractMemory(agent.id, 'Extracted page heading: quarterly results are up 12%.', runCommand);

    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(memoryWrites[0]).toContain('quarterly results are up 12%');
  });

  it('does nothing for an agent that has not opted into memory.remember', async () => {
    const agent = makeAgent({ memory: undefined });
    useAgentStore.getState().setAgents([agent]);
    const { runCommand, memoryWrites } = buildRunCommand();

    await captureBrowserExtractMemory(agent.id, 'some extracted text', runCommand);

    expect(memoryWrites).toHaveLength(0);
  });

  it('does nothing for an unknown agent id', async () => {
    useAgentStore.getState().setAgents([]);
    const { runCommand, memoryWrites } = buildRunCommand();

    await captureBrowserExtractMemory('missing-agent', 'some extracted text', runCommand);

    expect(memoryWrites).toHaveLength(0);
  });

  it('does nothing for an empty extraction (no extractable digest)', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    useAgentStore.getState().setAgents([agent]);
    const { runCommand, memoryWrites } = buildRunCommand();

    await captureBrowserExtractMemory(agent.id, '   ', runCommand);

    expect(memoryWrites).toHaveLength(0);
  });

  it('never throws when the write itself fails (best-effort, must not break the approval flow)', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = jest.fn(async () => {
      throw new Error('disk full');
    });

    await expect(captureBrowserExtractMemory(agent.id, 'some extracted text', runCommand)).resolves.toBeUndefined();
  });
});
