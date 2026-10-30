/**
 * MONITOR stage (4) (DEFERRED.md「マルチエージェント MONITOR ペイン…」, option B):
 * attended Run now routes a chain to the PlanSpec executor ONLY when it has an
 * effective parallel group, every step is executor-dispatchable, and the
 * on-disk PlanSpec already is this chain. On that route JS must not take the
 * chain lock (AgentRuntime.kt runPlanAgent skips the executor while one
 * exists), must not rewrite the plan (alarms read it), and must keep the run
 * "user"-origin for approvals. Everything else stays on the serial chain.
 *
 * Harness copied from __tests__/agent-manager-parallel-group.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
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
import { decideAttendedRoute } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { registeredRunOrigin, __resetRunOriginRegistryForTests } from '@/lib/agent-run-origin-registry';
import { useAgentStore } from '@/store/agent-store';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { Agent, AgentOrchestrationConfig } from '@/store/types';

const AGENT_ID = 'attended-route-agent';

const GROUPED_STEPS: AgentOrchestrationConfig['steps'] = [
  { instruction: 'summarize part A of the notes', parallelGroup: 'g' },
  { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
  'merge both summaries into one memo',
];

const makeAgent = (steps: AgentOrchestrationConfig['steps'], over: Partial<Agent> = {}): Agent => ({
  id: AGENT_ID,
  name: 'Route agent',
  description: '',
  prompt: 'Write the weekly memo from my notes',
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
  orchestration: { steps },
  ...over,
});

const ENV_TEXT = [
  'CEREBRAS_API_KEY=0',
  'GROQ_API_KEY=0',
  'PERPLEXITY_API_KEY=1',
  'GEMINI_API_KEY=1',
  'SHELLY_AUTONOMOUS_CLOUD=0',
  'SHELLY_AUTONOMOUS_CLOUD_STOP=0',
].join('\n');

interface Harness {
  commands: string[];
  originDuringRun: string[];
  runCommand: jest.Mock;
}

/**
 * `planText` is what the on-disk plan read returns. A runAgent() call with no
 * `# run-agent-` script materialized just before it is the executor route:
 * the fake "executor" writes one aggregate run log with per-step records.
 */
function makeHarness(planText: string): Harness {
  const commands: string[] = [];
  const originDuringRun: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let scriptsSinceLastRun = 0;
  mockTerminalEmulator.runAgent.mockImplementation(async (agentId: string) => {
    originDuringRun.push(registeredRunOrigin(agentId));
    if (scriptsSinceLastRun === 0) {
      logs.push({
        agentId,
        timestamp: Date.now() + 10,
        status: 'success',
        durationMs: 5,
        toolUsed: 'Local LLM',
        outputPreview: 'merged memo',
        steps: [
          { index: 0, instruction: 'summarize part A of the notes', status: 'success', durationMs: 1, outputPreview: 'A', parallelGroup: 'g' },
          { index: 1, instruction: 'summarize part B of the notes', status: 'success', durationMs: 1, outputPreview: 'B', parallelGroup: 'g' },
          { index: 2, instruction: 'merge both summaries into one memo', status: 'success', durationMs: 1, outputPreview: 'merged memo' },
        ],
      });
    }
    scriptsSinceLastRun = 0;
  });
  const runCommand = jest.fn(async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes('# PLAN_SPEC_READ')) return planText;
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      scriptsSinceLastRun += 1;
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'Local LLM',
        outputPreview: `serial step ${logs.length}`,
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return ENV_TEXT;
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
  return { commands, originDuringRun, runCommand };
}

const planFor = (agent: Agent): string => JSON.stringify(buildAgentPlanSpec(agent), null, 2);

describe('attended Run now — PlanSpec executor route gate', () => {
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    mockTerminalEmulator.execCommand.mockClear();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
    __resetRunOriginRegistryForTests();
  });

  it('eligible chain → executor route: one native launch, no chain lock, plan not rewritten, user origin kept', async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness(planFor(agent));

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledWith(AGENT_ID);
    // No chain lock: native would skip the executor while <id>.chain.lock exists.
    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(false);
    // No materialize: neither the per-step script nor the PlanSpec is written.
    expect(h.commands.some((c) => c.includes(`# run-agent-${AGENT_ID}`))).toBe(false);
    const planTouches = h.commands.filter((c) => c.includes(`plan-agent-${AGENT_ID}.json`));
    expect(planTouches.length).toBeGreaterThan(0);
    expect(planTouches.every((c) => c.includes('# PLAN_SPEC_READ') && !/>\s*["']?[^\n]*plan-agent-/.test(c))).toBe(true);
    // The executor writes progress.jsonl itself — no JS writer on this route.
    expect(h.commands.some((c) => c.includes('# SHELLY_PROGRESS_APPEND'))).toBe(false);
    // Approvals during the run keep the "user" origin; cleared afterwards.
    expect(h.originDuringRun).toEqual(['user']);
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
    // The chat still tells the story: one hand-off digest in the agent thread.
    const thread = useAIPaneStore.getState().conversations[agentThreadKey(AGENT_ID)]?.messages ?? [];
    expect(thread.filter((m) => m.handoff).length).toBe(1);
    // The executor's aggregate is in the store.
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.steps?.length).toBe(3);
  });

  it('a Codex/CLI-pinned branch → serial chain (chain lock taken, one native launch per step)', async () => {
    const steps: AgentOrchestrationConfig['steps'] = [
      { instruction: 'summarize part A of the notes', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ];
    const agent = makeAgent(steps);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness(planFor(agent));

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    expect(h.commands.filter((c) => c.includes(`# run-agent-${AGENT_ID}`)).length).toBeGreaterThanOrEqual(3);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.originDuringRun.every((o) => o === 'user')).toBe(true);
  });

  it('no effective parallel group → serial chain even with a current on-disk plan', async () => {
    const agent = makeAgent(['summarize the notes', 'turn the summary into a memo']);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness(planFor(agent));

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBe(2);
  });

  it('missing on-disk plan → serial chain', async () => {
    useAgentStore.getState().setAgents([makeAgent(GROUPED_STEPS)]);
    const h = makeHarness('');

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBe(3);
  });
});

describe('decideAttendedRoute (pure gate)', () => {
  const env = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };

  it('eligible → executor', () => {
    const agent = makeAgent(GROUPED_STEPS);
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env });
    expect(r.route).toBe('executor');
  });

  it('stale on-disk plan (an instruction changed since it was written) → serial', () => {
    const agent = makeAgent(GROUPED_STEPS);
    const stale = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g' },
      { instruction: 'an OLD instruction', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(stale), env });
    expect(r).toMatchObject({ route: 'serial' });
    expect(r.reason).toMatch(/stale/);
  });

  it('on-disk plan for a non-dispatchable tool (unsupported) → serial', () => {
    const agent = makeAgent(GROUPED_STEPS);
    const plan = JSON.parse(planFor(agent));
    plan.tool = { type: 'unsupported', label: 'Codex', unsupportedReason: 'x' };
    const r = decideAttendedRoute({ agent, planText: JSON.stringify(plan), env });
    expect(r.route).toBe('serial');
  });

  it('a step the attended router would hand to Codex → serial', () => {
    const agent = makeAgent(GROUPED_STEPS, { tool: { type: 'cli', cli: 'codex' } });
    const r = decideAttendedRoute({ agent, planText: planFor(makeAgent(GROUPED_STEPS)), env });
    expect(r.route).toBe('serial');
  });

  it('a group that only reaches the final step is not effective → serial', () => {
    const agent = makeAgent([
      'summarize the notes',
      { instruction: 'draft memo A', parallelGroup: 'g' },
      { instruction: 'draft memo B', parallelGroup: 'g' },
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env });
    expect(r).toMatchObject({ route: 'serial', reason: 'no effective parallel group' });
  });
});
