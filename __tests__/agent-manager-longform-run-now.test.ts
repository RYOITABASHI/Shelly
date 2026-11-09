/**
 * Article pipeline Run now (2026-11-09): a longform chain (or any chain with a
 * `local` step) runs only on the PlanSpec executor. Run now must take the
 * SAME native launch a schedule fire takes (TerminalEmulator.runAgent →
 * AgentRuntime.runPlanAgent, origin "user") on the on-disk plan as is — never
 * the serial .sh chain, never a plan rewrite — and the executor's own
 * refusals (lock held by a scheduled run, STOP ALL) must come back as the
 * run's result. A plan that is missing or is not this chain is refused before
 * launch. Harness trimmed from __tests__/agent-manager-attended-parallel-route.test.ts.
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

import {
  ATTENDED_EXECUTOR_NATIVE_CEILING_MS,
  attendedExecutorDeadlineMs,
  runAgentNow,
  __setAttendedExecutorWaitForTests,
} from '@/lib/agent-manager';
import { decideExecutorOnlyRoute, isExecutorOnlyChain } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { registeredRunOrigin, __resetRunOriginRegistryForTests } from '@/lib/agent-run-origin-registry';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';
import { t } from '@/lib/i18n';
import { examplePipeline } from './fixtures/article-pipeline-config';

const AGENT_ID = 'longform-run-now-agent';
const OUR_RUN_ID = `${AGENT_ID}-1700000000000-4242-a1b2c3`;
const NOT_READY = t('agents.longform_plan_not_ready');

const baseAgent: Agent = {
  id: AGENT_ID,
  name: 'Example series draft',
  description: '',
  prompt: 'do a thing',
  schedule: '30 5 * * *',
  tool: { type: 'gemini-api' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
};

function longformAgent(): Agent {
  const preset = examplePipeline('example-a');
  return {
    ...baseAgent,
    name: preset.name,
    prompt: preset.prompt,
    orchestration: preset.orchestration,
    ...(preset.tool ? { tool: preset.tool } : {}),
    ...(preset.action ? { action: preset.action } : {}),
    autonomous: preset.autonomous,
  };
}

function localStepAgent(): Agent {
  return {
    ...baseAgent,
    orchestration: {
      steps: ['write the article', { instruction: 'assemble it', local: { kind: 'assemble', parts: [[0]], stream: 'example-a', footer: 'footer' } }],
    },
  };
}

const planFor = (agent: Agent): string => JSON.stringify(buildAgentPlanSpec(agent, {}), null, 2);

const progressLine = (fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, agentId: AGENT_ID, ts: new Date().toISOString(), ...fields });

const executorLog = (preview = 'draft saved') => ({
  agentId: AGENT_ID,
  timestamp: Date.now(),
  status: 'success',
  durationMs: 5,
  toolUsed: 'Gemini',
  outputPreview: preview,
  executor: 'planspec',
});

const refusalLog = () => ({
  agentId: AGENT_ID,
  timestamp: Date.now() + 50,
  status: 'skipped',
  durationMs: 0,
  toolUsed: 'Gemini',
  outputPreview: 'previous run still active',
  errorMessage: 'previous run still active',
  executor: 'planspec',
});

type State = { progress: string[]; logs: Array<Record<string, unknown>> };

function makeHarness(opts: {
  planText: string;
  chainLockBusy?: boolean;
  onLaunch?: (s: State) => void;
  onMarkerRead?: (n: number, s: State) => void;
}) {
  const commands: string[] = [];
  const state: State = {
    progress: [
      progressLine({ runId: 'OLD-RUN', seq: 1, kind: 'run_start', mode: 'SERIAL', stepCount: 2 }),
      progressLine({ runId: 'OLD-RUN', seq: 9, kind: 'run_end', status: 'success' }),
    ],
    logs: [],
  };
  const originAtMarkerRead: string[] = [];
  let launched = false;
  let reads = 0;
  mockTerminalEmulator.runAgent.mockImplementation(async () => {
    launched = true;
    opts.onLaunch?.(state);
  });
  const runCommand = jest.fn(async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes('# PLAN_SPEC_READ')) return opts.planText;
    if (cmd.includes('# CHAIN_LOCK_CHECK')) return opts.chainLockBusy ? 'CHAIN_LOCK_BUSY' : '';
    if (cmd.includes('# PROGRESS_STREAM_READ')) return state.progress.join('\n');
    if (cmd.includes('# PROGRESS_MARKERS')) {
      if (launched) {
        reads += 1;
        originAtMarkerRead.push(registeredRunOrigin(AGENT_ID));
        opts.onMarkerRead?.(reads, state);
      }
      return state.progress.join('\n');
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return state.logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
  return { commands, originAtMarkerRead, runCommand };
}

const startRun = (s: State) => {
  s.progress.splice(0, s.progress.length, progressLine({ runId: OUR_RUN_ID, seq: 1, kind: 'run_start', mode: 'SERIAL', stepCount: 8 }));
};
const endRun = (s: State, log: Record<string, unknown> = executorLog()) => {
  s.progress.push(progressLine({ runId: OUR_RUN_ID, seq: 20, kind: 'run_end', status: 'success', durationMs: 5 }));
  s.logs.push(log);
};

describe('Run now on an executor-only (article pipeline) chain', () => {
  let restoreWait: (() => void) | null = null;
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
    __resetRunOriginRegistryForTests();
    restoreWait = __setAttendedExecutorWaitForTests({ refusalGraceMs: 30 });
  });
  afterEach(() => {
    restoreWait?.();
  });

  it('classifies longform and local-step chains as executor-only, plain chains not', () => {
    expect(isExecutorOnlyChain(longformAgent())).toBe(true);
    expect(isExecutorOnlyChain(localStepAgent())).toBe(true);
    expect(isExecutorOnlyChain({ orchestration: { steps: ['a', 'b'] } })).toBe(false);
    expect(isExecutorOnlyChain(undefined)).toBe(false);
  });

  it.each([
    ['longform article preset', longformAgent],
    ['chain with a local step', localStepAgent],
  ])('%s → one native executor launch, no serial chain, no chain lock, plan only read, user origin', async (_label, make) => {
    const agent = make();
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => startRun(s),
      onMarkerRead: (n, s) => { if (n === 2) endRun(s); },
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(h.commands.some((c) => c.includes(`# run-agent-${AGENT_ID}`))).toBe(false);
    expect(h.commands.some((c) => c.includes('# CHAIN_LOCK_ACQUIRE'))).toBe(false);
    const planTouches = h.commands.filter((c) => c.includes(`plan-agent-${AGENT_ID}.json`));
    expect(planTouches.length).toBeGreaterThan(0);
    expect(planTouches.every((c) => c.includes('# PLAN_SPEC_READ'))).toBe(true);
    expect(h.originAtMarkerRead.length).toBeGreaterThan(0);
    expect(h.originAtMarkerRead.every((o) => o === 'user')).toBe(true);
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.outputPreview).toBe('draft saved');
  });

  it('a scheduled run holding the executor lock → no second run; its refusal is this run\'s result', async () => {
    const agent = longformAgent();
    useAgentStore.getState().setAgents([agent]);
    // The scheduled run's own progress stream is already live (its run_start
    // predates our launch); our executor is refused by the pid lock and only
    // writes a skip log.
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => { s.logs.push(refusalLog()); },
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    const last = useAgentStore.getState().runHistory[AGENT_ID]?.at(-1);
    expect(last?.status).toBe('skipped');
    expect(last?.outputPreview).toBe('previous run still active');
    expect(registeredRunOrigin(AGENT_ID)).toBe('event');
  });

  it('a native refusal (STOP ALL sentinel / stale executor) is surfaced as the run log', async () => {
    const agent = longformAgent();
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({
      planText: planFor(agent),
      onLaunch: (s) => {
        s.logs.push({ agentId: AGENT_ID, timestamp: Date.now(), status: 'skipped', durationMs: 0, toolUsed: 'native', outputPreview: 'All agents are stopped (global kill-switch is on).' });
      },
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.outputPreview).toBe('All agents are stopped (global kill-switch is on).');
  });

  it('STOP ALL already on → refused before any launch', async () => {
    useAgentStore.getState().setAgents([longformAgent()]);
    useAgentStore.getState().setHalted(true);
    const h = makeHarness({ planText: planFor(longformAgent()) });
    await expect(runAgentNow(AGENT_ID, h.runCommand)).rejects.toThrow(/kill-switch/);
    expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
  });

  it('an attended serial chain holding the chain lock → refused before launch', async () => {
    const agent = longformAgent();
    useAgentStore.getState().setAgents([agent]);
    const h = makeHarness({ planText: planFor(agent), chainLockBusy: true });
    await expect(runAgentNow(AGENT_ID, h.runCommand)).rejects.toThrow(/chain lock/);
    expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
  });

  it('missing plan, another agent\'s plan, or a plain (non-longform) plan → refused, no launch', async () => {
    const agent = longformAgent();
    const otherAgent = { ...agent, id: 'some-other-agent' };
    const plainAgent: Agent = { ...baseAgent, orchestration: { steps: normalizeLength(agent) } };
    for (const planText of ['', planFor(otherAgent), planFor(plainAgent)]) {
      mockTerminalEmulator.runAgent.mockReset();
      useAgentStore.getState().setAgents([agent]);
      const h = makeHarness({ planText });
      await expect(runAgentNow(AGENT_ID, h.runCommand)).rejects.toThrow(NOT_READY);
      expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
      expect(h.commands.some((c) => c.includes(`# run-agent-${AGENT_ID}`))).toBe(false);
    }
  });

  it('decideExecutorOnlyRoute accepts the plan the agent itself produces', () => {
    const agent = longformAgent();
    expect(decideExecutorOnlyRoute({ agent, planText: planFor(agent) })).toMatchObject({ ok: true });
  });

  it('the wait covers a full article run: >= native 30-min wall + margin, even with the AI pane\'s short per-step timeout', () => {
    const start = 1_000_000;
    const deadline = attendedExecutorDeadlineMs({ startedAtMs: start, launchedAtMs: start, callerTimeoutMs: 10 * 60_000 });
    expect(deadline - start).toBeGreaterThan(ATTENDED_EXECUTOR_NATIVE_CEILING_MS);
    expect(deadline - start).toBeGreaterThanOrEqual(25 * 60_000);
  });
});

/** Same number of plain steps as the agent's chain (so only the longform
 *  flag / local kinds differ). */
function normalizeLength(agent: Agent): string[] {
  const n = agent.orchestration?.steps.length ?? 0;
  return Array.from({ length: n }, (_, i) => `plain step ${i + 1}`);
}
