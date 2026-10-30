/**
 * MONITOR stage (4) gate × memory recall: the stored PlanSpec is built by
 * materializeAgentBody from applyMemoryAndSkills(agent) — recall baked into
 * the prompt, which also drives plan.tool / toolLadder. The route gate
 * rebuilds it the same way and compares everything but generatedAt, so
 *  - a memory-bearing agent whose plan is current stays on the executor route;
 *  - a prompt-only edit whose re-materialize failed (disk plan still built from
 *    the OLD prompt) falls back to the serial chain.
 *
 * Memory is mocked so recall is deterministic; everything else is the real
 * agent-manager code path through runAgentNow.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const RECALL = 'Remembered: the user wants bullet points.';

jest.mock('@/lib/memory/shadow', () => ({
  shadowMemoryRecall: jest.fn(async () => undefined),
  activateMemoryRecall: jest.fn(async () => RECALL),
  activateMemoryWrite: jest.fn(async () => false),
  invalidateMemoryImportCache: jest.fn(() => undefined),
}));
jest.mock('@/lib/agent-memory', () => ({
  ...jest.requireActual('@/lib/agent-memory'),
  readMemoryNotes: jest.fn(async () => []),
  readGlobalMemoryNotes: jest.fn(async () => []),
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async (_agentId: string) => undefined),
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
import { storedPlanSpecOpts } from '@/lib/agent-attended-route';
import { INJECTED_CONTEXT_SEPARATOR } from '@/lib/agent-output-language';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';

const AGENT_ID = 'attended-memory-agent';
const ENV_TEXT = 'CEREBRAS_API_KEY=0\nGROQ_API_KEY=0\nPERPLEXITY_API_KEY=1\nGEMINI_API_KEY=1\nSHELLY_AUTONOMOUS_CLOUD=0\nSHELLY_AUTONOMOUS_CLOUD_STOP=0';

const makeAgent = (prompt: string): Agent => ({
  id: AGENT_ID,
  name: 'Memory agent',
  description: '',
  prompt,
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
  memory: { remember: true },
  orchestration: {
    steps: [
      { instruction: 'summarize part A of the notes', parallelGroup: 'g' },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ],
  },
});

/** The plan exactly as materialize would have written it (recall baked in). */
const storedPlanFor = (agent: Agent): string => {
  const withRecall: Agent = { ...agent, prompt: `${RECALL}${INJECTED_CONTEXT_SEPARATOR}${agent.prompt}` };
  const env = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };
  return JSON.stringify(buildAgentPlanSpec(withRecall, storedPlanSpecOpts(withRecall, env)), null, 2);
};

function makeRunCommand(planText: string) {
  const commands: string[] = [];
  const runCommand = jest.fn(async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes('# PLAN_SPEC_READ')) return planText;
    if (cmd.includes('CEREBRAS_API_KEY')) return ENV_TEXT;
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      logs.push({ agentId: AGENT_ID, timestamp: Date.now() + logs.length, status: 'success', durationMs: 1, toolUsed: 'Local LLM', outputPreview: `step ${logs.length}` });
      return '';
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    return '';
  });
  const logs: Array<Record<string, unknown>> = [];
  // Executor route: the fake executor writes its own tagged run log.
  mockTerminalEmulator.runAgent.mockImplementation(async () => {
    if (!commands.slice(-3).some((c) => c.includes(`# run-agent-${AGENT_ID}`))) {
      logs.push({ agentId: AGENT_ID, timestamp: Date.now(), status: 'success', durationMs: 1, toolUsed: 'Local LLM', outputPreview: 'memo', executor: 'planspec' });
    }
  });
  return { commands, runCommand };
}

describe('attended route gate × memory recall', () => {
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
  });

  it('a memory-bearing agent whose stored plan is current stays on the executor route', async () => {
    const agent = makeAgent('Write the weekly memo from my notes');
    useAgentStore.getState().setAgents([agent]);
    const { commands, runCommand } = makeRunCommand(storedPlanFor(agent));

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    expect(commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(false);
  });

  it('a prompt-only edit whose re-materialize failed (disk plan built from the OLD prompt) → serial chain', async () => {
    const before = makeAgent('Write the weekly memo from my notes');
    const edited = makeAgent('Write the weekly memo from my notes, in English');
    useAgentStore.getState().setAgents([edited]);
    const { commands, runCommand } = makeRunCommand(storedPlanFor(before));

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    // Serial chain: per-step scripts are materialized (never on the executor route).
    expect(commands.some((c) => c.includes(`# run-agent-${AGENT_ID}`))).toBe(true);
  });
});
