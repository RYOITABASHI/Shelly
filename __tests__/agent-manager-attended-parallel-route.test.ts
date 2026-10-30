/**
 * MONITOR stage (4) (DEFERRED.md「マルチエージェント MONITOR ペイン…」, option B):
 * attended Run now routes a chain to the PlanSpec executor ONLY when it has an
 * effective parallel group, every step's attended provider equals the
 * executor's effective provider, and the on-disk PlanSpec is current. On that
 * route JS must not take the chain lock (AgentRuntime.kt runPlanAgent skips
 * the executor while one exists), must not rewrite the plan (alarms read it),
 * must keep the run "user"-origin for approvals for as long as THIS executor
 * run lives, and must not mistake a concurrent fire's refusal log for its
 * result. Everything else stays on the serial chain.
 *
 * Harness copied from __tests__/agent-manager-parallel-group.test.ts, plus a
 * fake executor that writes progress.jsonl run markers and a run log.
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

import { executorPidFromRunId, runAgentNow, __setAttendedExecutorWaitForTests } from '@/lib/agent-manager';
import { decideAttendedRoute, storedPlanSpecOpts } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { registeredRunOrigin, __resetRunOriginRegistryForTests } from '@/lib/agent-run-origin-registry';
import { useAgentStore } from '@/store/agent-store';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { Agent, AgentOrchestrationConfig } from '@/store/types';
import type { LadderEnv } from '@/lib/agent-escalation-ladder';

const AGENT_ID = 'attended-route-agent';
/** Shape of a real executor runId: `${agentId}-${Date.now()}-${pid}-${hex}`. */
const OUR_RUN_ID = `${AGENT_ID}-1700000000000-4242-a1b2c3`;

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

/** Mirrors ENV_TEXT as ladderEnvFromDisk parses it. */
const ENV: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };

const progressLine = (fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, agentId: AGENT_ID, ts: new Date().toISOString(), ...fields });

const executorLog = (preview = 'merged memo') => ({
  agentId: AGENT_ID,
  timestamp: Date.now(),
  status: 'success',
  durationMs: 5,
  toolUsed: 'Local LLM',
  outputPreview: preview,
  executor: 'planspec',
  steps: [
    { index: 0, instruction: 'summarize part A of the notes', status: 'success', durationMs: 1, outputPreview: 'A', parallelGroup: 'g' },
    { index: 1, instruction: 'summarize part B of the notes', status: 'success', durationMs: 1, outputPreview: 'B', parallelGroup: 'g' },
    { index: 2, instruction: 'merge both summaries into one memo', status: 'success', durationMs: 1, outputPreview: preview },
  ],
});

const refusalLog = () => ({
  agentId: AGENT_ID,
  timestamp: Date.now() + 50,
  status: 'skipped',
  durationMs: 0,
  toolUsed: 'Local LLM',
  outputPreview: 'previous run still active',
  errorMessage: 'previous run still active',
  executor: 'planspec',
});

interface Harness {
  commands: string[];
  logs: Array<Record<string, unknown>>;
  originAtMarkerRead: string[];
  originAtStop: string[];
  markerReads: () => number;
  runCommand: jest.Mock;
}

/**
 * `onMarkerRead(n, h)` runs on the n-th progress-marker read after the
 * executor launch (1-based) — scenarios use it to end the run, add a
 * concurrent refusal log, etc. `progress` is the current progress.jsonl.
 */
function makeHarness(opts: {
  planText: string;
  chainLockBusy?: boolean;
  stopReply?: string;
  onLaunch?: (state: { progress: string[] ; logs: Array<Record<string, unknown>> }) => void;
  onMarkerRead?: (n: number, state: { progress: string[]; logs: Array<Record<string, unknown>> }) => void;
}): Harness {
  const commands: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const progress: string[] = [progressLine({ runId: 'OLD-RUN', seq: 1, kind: 'run_start', mode: 'SERIAL', stepCount: 2 }), progressLine({ runId: 'OLD-RUN', seq: 9, kind: 'run_end', status: 'success' })];
  const state = { progress, logs };
  const originAtMarkerRead: string[] = [];
  const originAtStop: string[] = [];
  let launched = false;
  let reads = 0;
  let scriptsSinceLastRun = 0;
  mockTerminalEmulator.runAgent.mockImplementation(async () => {
    if (scriptsSinceLastRun === 0) {
      launched = true;
      opts.onLaunch?.(state);
    }
    scriptsSinceLastRun = 0;
  });
  const runCommand = jest.fn(async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes('# PLAN_SPEC_READ')) return opts.planText;
    if (cmd.includes('# CHAIN_LOCK_CHECK')) return opts.chainLockBusy ? 'CHAIN_LOCK_BUSY' : '';
    if (cmd.includes('# PROGRESS_MARKERS')) {
      if (launched) {
        reads += 1;
        originAtMarkerRead.push(registeredRunOrigin(AGENT_ID));
        opts.onMarkerRead?.(reads, state);
      }
      return state.progress.join('\n');
    }
    if (cmd.includes('# EXECUTOR_STOP')) {
      originAtStop.push(registeredRunOrigin(AGENT_ID));
      return opts.stopReply ?? 'STOP_DONE';
    }
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      scriptsSinceLastRun += 1;
      logs.push({ agentId: AGENT_ID, timestamp: Date.now() + logs.length, status: 'success', durationMs: 5, toolUsed: 'Local LLM', outputPreview: `serial step ${logs.length}` });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return ENV_TEXT;
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
  return { commands, logs, originAtMarkerRead, originAtStop, markerReads: () => reads, runCommand };
}

/** The fake executor: rotates progress.jsonl to a new run on launch. */
const startRun = (state: { progress: string[] }, runId = OUR_RUN_ID) => {
  state.progress.splice(0, state.progress.length, progressLine({ runId, seq: 1, kind: 'run_start', mode: 'PARALLEL', stepCount: 3 }));
};
const endRun = (state: { progress: string[]; logs: Array<Record<string, unknown>> }, runId = OUR_RUN_ID, log: Record<string, unknown> = executorLog()) => {
  state.progress.push(progressLine({ runId, seq: 20, kind: 'run_end', status: 'success', durationMs: 5 }));
  state.logs.push(log);
};

const planFor = (agent: Agent): string => JSON.stringify(buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, ENV)), null, 2);
const handoffCount = () =>
  (useAIPaneStore.getState().conversations[agentThreadKey(AGENT_ID)]?.messages ?? []).filter((m) => m.handoff).length;

describe('attended Run now — PlanSpec executor route', () => {
  let restoreWait: (() => void) | null = null;
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    mockTerminalEmulator.execCommand.mockClear();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
    useAIPaneStore.getState().clearConversation?.(agentThreadKey(AGENT_ID));
    __resetRunOriginRegistryForTests();
    restoreWait = __setAttendedExecutorWaitForTests({ refusalGraceMs: 30 });
  });
  afterEach(() => {
    restoreWait?.();
  });

  it('eligible chain → one native launch, no chain lock, plan not rewritten, user origin kept, digest posted', async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => startRun(s),
      onMarkerRead: (n, s) => { if (n === 2) endRun(s); },
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(false);
    expect(h.commands.some((c) => c.includes(`# run-agent-${AGENT_ID}`))).toBe(false);
    const planTouches = h.commands.filter((c) => c.includes(`plan-agent-${AGENT_ID}.json`));
    expect(planTouches.length).toBeGreaterThan(0);
    expect(planTouches.every((c) => c.includes('# PLAN_SPEC_READ'))).toBe(true);
    expect(h.commands.some((c) => c.includes('# SHELLY_PROGRESS_APPEND'))).toBe(false);
    expect(h.originAtMarkerRead.every((o) => o === 'user')).toBe(true);
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
    expect(handoffCount()).toBe(1);
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.steps?.length).toBe(3);
  });

  it("a caller's short per-step timeout (the AI pane's 10-min limit) never cuts the executor run short", async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => startRun(s),
      // Ends well after the caller's 30 ms "timeout" (6 polls × 20 ms).
      onMarkerRead: (n, s) => { if (n === 6) endRun(s); },
    });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 30, pollMs: 20 })).resolves.toBeUndefined();

    expect(h.markerReads()).toBeGreaterThanOrEqual(6);
    expect(h.originAtMarkerRead.every((o) => o === 'user')).toBe(true);
    expect(h.commands.some((c) => c.includes('# EXECUTOR_STOP'))).toBe(false);
    expect(handoffCount()).toBe(1);
  });

  it('on a real wait timeout the executor is stopped BEFORE the user mark is cleared', async () => {
    restoreWait?.();
    restoreWait = __setAttendedExecutorWaitForTests({ runTimeoutMs: 40, preStartTimeoutMs: 40 });
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent), onLaunch: (s) => startRun(s) });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 10, pollMs: 5 })).rejects.toThrow(/Timed out waiting/);

    expect(h.originAtStop).toEqual(['user']);
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
    // Targets OUR pid (from our run_start's runId) via the LIVE shell $HOME,
    // re-checking the lock file and the executor cmdline before signalling —
    // never the JS getHomePath() cache, never a blind kill of the lock holder.
    const stop = h.commands.find((c) => c.includes('# EXECUTOR_STOP'))!;
    expect(stop).toContain('want=4242');
    expect(stop).toContain(`"$HOME/.shelly/agents/locks/${AGENT_ID}.pid"`);
    expect(stop).not.toContain('/home/shelly-test');
    expect(stop).toContain('shelly-plan-executor');
    expect(stop).toContain(`--agent-id ${AGENT_ID}`);
    expect(stop).toMatch(/\[ "\$held" != "\$want" \]/);
  });

  it('when the timed-out executor cannot be confirmed stopped, the user mark is kept (it expires by itself)', async () => {
    restoreWait?.();
    restoreWait = __setAttendedExecutorWaitForTests({ runTimeoutMs: 40, preStartTimeoutMs: 40 });
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent), onLaunch: (s) => startRun(s), stopReply: 'STOP_ALIVE' });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 10, pollMs: 5 })).rejects.toThrow(/Timed out waiting/);

    expect(h.originAtStop).toEqual(['user']);
    expect(registeredRunOrigin(AGENT_ID)).toBe('user');
  });

  it('an executor that dies without run_end ends the wait on native\'s receiver error log (no false 32-min timeout)', async () => {
    restoreWait?.();
    restoreWait = __setAttendedExecutorWaitForTests({ refusalGraceMs: 30, runningLogPollMs: 5 });
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => startRun(s),
      onMarkerRead: (n, s) => {
        // A straggler alarm for this agent is refused natively (skipped) —
        // must NOT be taken as our result.
        if (n === 1) s.logs.push({ agentId: AGENT_ID, timestamp: Date.now() + 5, status: 'skipped', errorMessage: `agent disabled: ${AGENT_ID}` });
        // Our executor is OOM-killed: no run_end, only native's error log.
        if (n === 3) s.logs.push({ agentId: AGENT_ID, timestamp: Date.now() + 10, status: 'error', errorMessage: 'plan-executor exit=137 stderr= stdout=' });
      },
    });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 10, pollMs: 2 })).resolves.toBeUndefined();

    expect(h.markerReads()).toBeGreaterThanOrEqual(3);
    expect(h.markerReads()).toBeLessThan(200);
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.status).toBe('error');
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
    expect(h.commands.some((c) => c.includes('# EXECUTOR_STOP'))).toBe(false);
  });

  it("a concurrent fire's 'previous run still active' log is ignored — completion waits for THIS run's run_end and log", async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    let ourLogTs = 0;
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => startRun(s),
      onMarkerRead: (n, s) => {
        if (n === 1) {
          // An alarm fires mid-run: the executor lock refuses it at once.
          s.logs.push(refusalLog());
        }
        if (n === 4) {
          const log = { ...executorLog('our merged memo'), timestamp: Date.now() - 20 };
          ourLogTs = log.timestamp;
          endRun(s, OUR_RUN_ID, log);
        }
      },
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.markerReads()).toBeGreaterThanOrEqual(4);
    // The user mark outlived the refusal log.
    expect(h.originAtMarkerRead.slice(0, 4).every((o) => o === 'user')).toBe(true);
    // The digest narrates OUR run (3 steps), not the refusal.
    const thread = useAIPaneStore.getState().conversations[agentThreadKey(AGENT_ID)]?.messages ?? [];
    const handoff = thread.filter((m) => m.handoff);
    expect(handoff.length).toBe(1);
    expect(handoff[0].handoff?.runId).toBe(`${AGENT_ID}:${ourLogTs}`);
  });

  it('when OUR launch is the refused one (no run of ours ever starts), the run ends as that skip', async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => { s.logs.push(refusalLog()); },
    });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 5 })).resolves.toBeUndefined();

    expect(handoffCount()).toBe(0);
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.status).toBe('skipped');
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
  });

  it('a live chain lock surfaces the same busy error as the serial path, without launching', async () => {
    const agent = makeAgent(GROUPED_STEPS);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent), chainLockBusy: true });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 })).rejects.toThrow(/already holding the chain lock/);
    expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
  });

  it('a Codex/CLI-pinned branch → serial chain (chain lock taken, one native launch per step)', async () => {
    const agent = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ]);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent) });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('no effective parallel group → serial chain, without even reading the plan', async () => {
    const agent = makeAgent(['summarize the notes', 'turn the summary into a memo']);
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent) });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# PLAN_SPEC_READ'))).toBe(false);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBe(2);
  });

  it('missing on-disk plan → serial chain', async () => {
    useAgentStore.getState().setAgents([makeAgent(GROUPED_STEPS)]);
    const h = makeHarness({ planText: '' });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(true);
    expect(mockTerminalEmulator.runAgent.mock.calls.length).toBe(3);
  });
});

describe('decideAttendedRoute (pure gate)', () => {
  it('eligible → executor', () => {
    const agent = makeAgent(GROUPED_STEPS);
    expect(decideAttendedRoute({ agent, planText: planFor(agent), env: ENV }).route).toBe('executor');
  });

  it('stale plan: a step instruction changed since it was written → serial', () => {
    const agent = makeAgent(GROUPED_STEPS);
    const stale = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g' },
      { instruction: 'an OLD instruction', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(stale), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/stale.*steps/);
  });

  it('stale plan: action contents (webhook URL) differ → serial', () => {
    const agent = makeAgent(GROUPED_STEPS, { action: { type: 'webhook', webhookUrl: 'https://new.example/hook' } as Agent['action'] });
    const old = makeAgent(GROUPED_STEPS, { action: { type: 'webhook', webhookUrl: 'https://old.example/hook' } as Agent['action'] });
    const r = decideAttendedRoute({ agent, planText: planFor(old), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/stale.*action/);
  });

  it('stale plan: requireActionApproval / outputPath / plan.tool differ → serial', () => {
    const agent = makeAgent(GROUPED_STEPS);
    for (const old of [
      makeAgent(GROUPED_STEPS, { requireActionApproval: false }),
      makeAgent(GROUPED_STEPS, { outputPath: '~/elsewhere' }),
      makeAgent(GROUPED_STEPS, { tool: { type: 'local', model: 'Qwen3.5-2B-Q4_K_M' } }),
    ]) {
      const r = decideAttendedRoute({ agent, planText: planFor(old), env: ENV });
      expect(r).toMatchObject({ route: 'serial' });
      expect(r.reason).toMatch(/stale/);
    }
  });

  it('only generatedAt may differ — a prompt difference reads as stale', () => {
    const agent = makeAgent(GROUPED_STEPS);
    const plan = JSON.parse(planFor(agent));
    plan.generatedAt = 1;
    expect(decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV }).route).toBe('executor');
    plan.prompt = `${plan.prompt}\n\n(something else)`;
    const r = decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/stale.*prompt/);
  });

  it('executorPidFromRunId reads the pid out of a real executor runId only', () => {
    expect(executorPidFromRunId(OUR_RUN_ID, AGENT_ID)).toBe(4242);
    expect(executorPidFromRunId('NEW-RUN', AGENT_ID)).toBeNull();
    expect(executorPidFromRunId(`${AGENT_ID}-1700000000000-attended-abc`, AGENT_ID)).toBeNull();
    expect(executorPidFromRunId(`other-1700000000000-4242-abc`, AGENT_ID)).toBeNull();
    expect(executorPidFromRunId(undefined, AGENT_ID)).toBeNull();
  });

  it('tool:auto per-step drift: the attended router sends a web step to a different provider than plan.tool → serial', () => {
    const agent = makeAgent([
      { instruction: 'collect the latest AI news on the web from today', parallelGroup: 'g' },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both into one memo',
    ], { tool: { type: 'auto' } });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/provider drift|not executor-dispatchable|plan\.tool/);
  });

  it('an autonomous agent whose step pin the PlanSpec dropped (no cloud consent) → serial', () => {
    const agent = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g', tool: { type: 'perplexity' } },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ], { autonomous: true });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/dropped/);
  });

  it('a local step pin under a cloud plan.tool → serial (native autostarts llama-server only for a local plan.tool)', () => {
    const agent = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g', tool: { type: 'local' } },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ], { tool: { type: 'gemini-api' } });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/llama-server/);
  });

  it('on-disk plan for a non-dispatchable tool → serial', () => {
    const agent = makeAgent(GROUPED_STEPS, { tool: { type: 'cli', cli: 'codex' } });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
  });

  it('a group that only reaches the final step is not effective → serial', () => {
    const agent = makeAgent([
      'summarize the notes',
      { instruction: 'draft memo A', parallelGroup: 'g' },
      { instruction: 'draft memo B', parallelGroup: 'g' },
    ]);
    expect(decideAttendedRoute({ agent, planText: planFor(agent), env: ENV })).toMatchObject({ route: 'serial', reason: 'no effective parallel group' });
  });
});
