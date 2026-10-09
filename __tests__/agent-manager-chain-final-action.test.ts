/**
 * Attended orchestrated chains (no sources involved): the FINAL step must
 * dispatch the agent's REAL configured action exactly once, and intermediate
 * steps must stay suppressed without saving a draft file. Before the
 * 2026-10-09 fix generateRunScript forced ACTION_TYPE='draft' for every
 * orchestrated step, so a notify/webhook chain silently did a draft save
 * instead of its configured action.
 *
 * Harness copied from __tests__/agent-manager-orchestrated-saved-path.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async () => undefined),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: mockTerminalEmulator,
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { runAgentNow } from '@/lib/agent-manager';
import { generateRunScript } from '@/lib/agent-executor';
import { useAgentStore } from '@/store/agent-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import type { Agent, AgentRunLog } from '@/store/types';

const AGENT_ID = 'chain-final-action-agent';

const makeAgent = (action: Agent['action']): Agent => ({
  id: AGENT_ID,
  name: 'Digest',
  description: '',
  prompt: 'Compile the weekly digest',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action,
  orchestration: { steps: ['collect the meeting notes', 'summarize them', 'write the digest'] },
});

function makeRunCommand(allCommands: string[]) {
  const logs: Array<Record<string, unknown>> = [];
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${AGENT_ID}`) && cmd.includes('RESULT_FILE=')) {
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'Local LLM',
        outputPreview: `step output ${logs.length + 1}`,
      });
      return '';
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
}

/** Per-step scripts (the restore of the stored chain script is excluded:
 *  it carries the full orchestration, not a single step's prompt). */
function stepScripts(allCommands: string[]): string[] {
  return allCommands.filter(
    (c) => c.includes(`# run-agent-${AGENT_ID}`) && c.includes('RESULT_FILE=') && c.includes('# This step'),
  );
}

function aggregate(allCommands: string[]): AgentRunLog {
  const cmd = allCommands.find((c) => c.includes('"steps":[') && c.includes(`/logs/${AGENT_ID}/`))!;
  return JSON.parse(cmd.split('\n').find((l) => l.startsWith('{') && l.includes('"steps":['))!) as AgentRunLog;
}

describe('attended chain — final step performs the configured action exactly once', () => {
  beforeEach(() => {
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  it('notify action: intermediate steps suppressed with no draft save, final step notifies once', async () => {
    useAgentStore.getState().setAgents([makeAgent({ type: 'notify' })]);
    const all: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(all), { waitTimeoutMs: 2000, pollMs: 1 });
    const scripts = stepScripts(all);
    expect(scripts).toHaveLength(3);
    const types = scripts.map((s) => /ACTION_TYPE='([^']*)'/.exec(s)![1]);
    expect(types).toEqual(['__suppressed__', '__suppressed__', 'notify']);
    // No step may leave a draft file behind for a notify agent.
    for (const s of scripts.slice(0, 2)) expect(s).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
    expect(types.filter((t) => t === 'draft')).toHaveLength(0);
    const agg = aggregate(all);
    expect(agg.status).toBe('success');
    expect(agg.savedPath).toBeUndefined();
  });

  it('draft action: the draft is saved once, by the final step only', async () => {
    useAgentStore.getState().setAgents([makeAgent({ type: 'draft' })]);
    const all: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(all), { waitTimeoutMs: 2000, pollMs: 1 });
    const types = stepScripts(all).map((s) => /ACTION_TYPE='([^']*)'/.exec(s)![1]);
    expect(types).toEqual(['__suppressed__', '__suppressed__', 'draft']);
    for (const s of stepScripts(all).slice(0, 2)) expect(s).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
  });

  it('webhook action: the final step dispatches the webhook, not a draft', async () => {
    useAgentStore.getState().setAgents([makeAgent({ type: 'webhook', webhookUrl: 'https://hooks.example.com/x' })]);
    const all: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(all), { waitTimeoutMs: 2000, pollMs: 1 });
    const scripts = stepScripts(all);
    expect(/ACTION_TYPE='([^']*)'/.exec(scripts[2])![1]).toBe('webhook');
    expect(scripts[2]).toContain('https://hooks.example.com/x');
  });
});

describe('generateRunScript — orchestrated step action vs system prompt', () => {
  const agent = makeAgent({ type: 'notify' });
  it('dispatches the real action but keeps the generic content-generation system prompt', () => {
    const s = generateRunScript({ ...agent, orchestration: undefined }, { isOrchestratedStep: true });
    expect(s).toContain("ACTION_TYPE='notify'");
    const single = generateRunScript({ ...agent, orchestration: undefined });
    // The system prompt differs: the chain step does NOT get notify's brevity rule.
    expect(s).not.toBe(single);
  });
});
