/* eslint-disable import/first -- Jest mocks must be registered before imports. */
/**
 * Recall freshness (roadmap item 3, part 2 — "per-fire 鮮度").
 *
 * Recall is baked into each agent's on-disk run script. An UNATTENDED
 * AlarmManager fire runs that script directly, so a note written after the last
 * bake used to stay invisible until the next app launch. The fix re-bakes the
 * script whenever memory changes, which makes the baked block equal to what a
 * fire-time read would have produced — without moving the recall injection past
 * resolveAgentRoute's secret-guard scan (see refreshAgentRecall's comment).
 *
 * These tests pin the observable consequence: a memory write is followed by a
 * script re-write for that agent, and a no-op write is not.
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

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
jest.mock('expo-file-system/legacy', () => ({}));

import { loadAgentsFromDisk } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, AgentRunLog } from '@/store/types';

const AGENT_LIST_MARKER = '---SEPARATOR---';
const LOG_MARKER = '---SHELLY_AGENT_LOG---';
const AGENT_ID = 'sched-agent';
const SCRIPT_PATH = `run-agent-${AGENT_ID}.sh`;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
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
    agentId: AGENT_ID,
    timestamp: Date.now(),
    status: 'success',
    outputPreview: 'Top headline: local news roundup for today.',
    durationMs: 1000,
    toolUsed: 'gemini-api',
    ...overrides,
  };
}

function buildRunCommand(opts: { agent: Agent | null; log: AgentRunLog | null }) {
  const order: string[] = [];
  const runCommand = jest.fn(async (command: string): Promise<string> => {
    if (command.startsWith('[ -f ')) return 'HALTED_NO';
    if (command.startsWith('d=')) {
      return opts.agent ? `${JSON.stringify(opts.agent)}\n${AGENT_LIST_MARKER}\n` : '';
    }
    if (command.startsWith('for d in')) {
      return opts.log ? `${JSON.stringify(opts.log)}\n${LOG_MARKER}\n` : '';
    }
    if (command.startsWith('cd ')) return '';
    if (command.includes('.shelly/agents/memory/')) order.push('memory-write');
    else if (command.includes(SCRIPT_PATH)) order.push('script-rebake');
    return '';
  });
  return { runCommand, order };
}

async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('recall freshness — re-bake after a memory write', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('re-bakes the agent script AFTER capturing a scheduled run’s memory', async () => {
    const { runCommand, order } = buildRunCommand({
      agent: makeAgent({ memory: { remember: true, tags: ['news'] } }),
      log: makeRunLog(),
    });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settle();

    expect(order).toContain('memory-write');
    expect(order).toContain('script-rebake');
    // Order matters: baking before the write would bake the OLD note set.
    expect(order.indexOf('memory-write')).toBeLessThan(order.lastIndexOf('script-rebake'));
  });

  it('does not re-bake when no memory was written (agent opted out)', async () => {
    const { runCommand, order } = buildRunCommand({
      agent: makeAgent({ memory: undefined }),
      log: makeRunLog(),
    });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settle();

    expect(order).not.toContain('memory-write');
    expect(order).not.toContain('script-rebake');
  });

  it('does not re-bake when the latest run failed (nothing worth remembering)', async () => {
    const { runCommand, order } = buildRunCommand({
      agent: makeAgent({ memory: { remember: true } }),
      log: makeRunLog({ status: 'error', outputPreview: 'boom' }),
    });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settle();

    expect(order).not.toContain('memory-write');
    expect(order).not.toContain('script-rebake');
  });
});
