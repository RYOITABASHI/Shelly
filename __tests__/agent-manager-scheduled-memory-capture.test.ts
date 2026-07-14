/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// G2 follow-up: scheduled (alarm-fired) runs finish with no TS runtime alive, so
// captureRunMemory (the foreground/runAgentNow hook) never sees them. Coverage
// for the fix: loadAgentsFromDisk's app-launch log sync now captures the latest
// success digest for every remember-enabled agent via
// captureRunMemoryFromSyncedLogs (fire-and-forget, after setAgents/setRunHistory).

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
// Empty FileSystem mock: readAgentMetadataViaFileSystem/readMemoryNotes both
// call into it and their try/catch falls back to the shell path / empty list,
// exactly like the existing loadAgentsFromDisk tests in this suite.
jest.mock('expo-file-system/legacy', () => ({}));

import { loadAgentsFromDisk } from '@/lib/agent-manager';
import { LOCAL_FALLBACK_DIGEST_MARKER } from '@/lib/agent-escalation-ladder';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, AgentRunLog } from '@/store/types';

const AGENT_LIST_MARKER = '---SEPARATOR---';
const LOG_MARKER = '---SHELLY_AGENT_LOG---';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'sched-agent',
    name: 'Scheduled agent',
    description: '',
    prompt: '最新ニュースを集めて',
    schedule: '0 8 * * *',
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

function makeRunLog(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  return {
    agentId: 'sched-agent',
    timestamp: Date.now(),
    status: 'success',
    outputPreview: 'Top headline: local news roundup for today.',
    durationMs: 1000,
    toolUsed: 'gemini-api',
    ...overrides,
  };
}

/** Builds a runCommand mock that serves loadAgentsFromDisk's fixed sequence of
 * shell probes, plus records any write that looks like a memory-note write. */
function buildRunCommand(opts: {
  agent: Agent | null;
  log: AgentRunLog | null;
}) {
  const memoryWrites: string[] = [];
  const writeSeen = deferredFlag();
  const runCommand = jest.fn(async (command: string): Promise<string> => {
    if (command.startsWith('[ -f ')) return 'HALTED_NO'; // halt-sentinel check
    if (command.startsWith('d=')) {
      // readAgentMetadataViaShell
      return opts.agent ? `${JSON.stringify(opts.agent)}\n${AGENT_LIST_MARKER}\n` : '';
    }
    if (command.startsWith('for d in')) {
      // readAgentRunLogs
      return opts.log ? `${JSON.stringify(opts.log)}\n${LOG_MARKER}\n` : '';
    }
    if (command.startsWith('cd ')) return ''; // cleanupOrphanAgentFiles
    if (command.includes('.shelly/agents/memory/')) {
      memoryWrites.push(command);
      writeSeen.resolve();
      return '';
    }
    return '';
  });
  return { runCommand, memoryWrites, writeSeen: writeSeen.promise };
}

function deferredFlag(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Give the fire-and-forget captureRunMemoryFromSyncedLogs a chance to run,
 * without hanging forever when no write is expected. */
async function settleMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('loadAgentsFromDisk — scheduled-run memory capture (G2 follow-up)', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('captures the latest success digest for a remember-enabled agent after a log sync', async () => {
    const agent = makeAgent({ memory: { remember: true, tags: ['news'] } });
    const log = makeRunLog();
    const { runCommand, memoryWrites, writeSeen } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await Promise.race([writeSeen, settleMicrotasks(10)]);

    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(memoryWrites[0]).toContain('local news roundup');
  });

  it('does not write memory for an agent that has not opted into remember', async () => {
    const agent = makeAgent({ memory: undefined });
    const log = makeRunLog();
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });

  it('does not write memory when the latest run was not a success', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog({ status: 'error', outputPreview: 'boom' });
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });

  it('never captures a local-context-fallback digest, even one logged by an older script version (defense in depth)', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog({
      status: 'success',
      outputPreview: `${LOCAL_FALLBACK_DIGEST_MARKER}\nran on-device without cloud access`,
    });
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });

  it('does nothing when there is no run history for the agent yet', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log: null });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });
});
