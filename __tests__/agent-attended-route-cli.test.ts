/**
 * Parallel CLI steps Inc3 (docs/superpowers/specs/2026-11-01-parallel-cli-steps-plan.md):
 * attended Run now hands a chain with CLI branches (Codex / Claude Code) to
 * the PlanSpec executor, which drives each through shelly-agent-driver.js.
 *
 *  - decideAttendedRoute allows a step whose disk pin is {type:'cli', cli}
 *    when the attended first choice is that same CLI and the plan carries
 *    cliWorker; plan.tool must stay HTTP-dispatchable; reason says cli=<n>.
 *  - Everything else (pin mismatch, unsupported plan.tool, missing
 *    cliWorker, unknown engine, autonomous unpinned CLI step) stays serial.
 *  - An ephemeral "run once now" draft (installAgent → runAgentNow, the
 *    hooks/use-ai-pane-dispatch.ts confirmAgentDraft path) has a current
 *    PlanSpec with cliWorker on disk before the route check.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('@/lib/memory/shadow', () => ({
  shadowMemoryRecall: jest.fn(async () => undefined),
  activateMemoryRecall: jest.fn(async () => undefined),
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
  scheduleAgent: jest.fn(async () => undefined),
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
  EXECUTOR_CLI_ENGINES,
  EXECUTOR_CLI_TOOL_TYPES,
  decideAttendedRoute,
  storedPlanSpecOpts,
} from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { installAgent } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, AgentOrchestrationConfig } from '@/store/types';
import type { LadderEnv } from '@/lib/agent-escalation-ladder';

const AGENT_ID = 'attended-cli-agent';
const ENV: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };
const ENV_TEXT = 'CEREBRAS_API_KEY=0\nGROQ_API_KEY=0\nPERPLEXITY_API_KEY=1\nGEMINI_API_KEY=1\nSHELLY_AUTONOMOUS_CLOUD=0\nSHELLY_AUTONOMOUS_CLOUD_STOP=0';

const CLI_STEPS: AgentOrchestrationConfig['steps'] = [
  { instruction: 'review the open pull request in the repo', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' }, toolPinned: true },
  { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' }, toolPinned: true },
  'merge both results into one memo',
];

const makeAgent = (steps: AgentOrchestrationConfig['steps'] = CLI_STEPS, over: Partial<Agent> = {}): Agent => ({
  id: AGENT_ID,
  name: 'CLI route agent',
  description: '',
  prompt: 'Review the PR and add tests, then summarize',
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

const planObj = (agent: Agent) => buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, ENV)) as unknown as Record<string, unknown>;
const planFor = (agent: Agent) => JSON.stringify(planObj(agent), null, 2);

describe('decideAttendedRoute — CLI steps (Inc3)', () => {
  it('mirrors the executor: cli is a driver-dispatched step type for codex / claude', () => {
    expect([...EXECUTOR_CLI_TOOL_TYPES]).toEqual(['cli']);
    expect([...EXECUTOR_CLI_ENGINES].sort()).toEqual(['claude', 'codex']);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'shelly-plan-executor.js'), 'utf8');
    for (const engine of EXECUTOR_CLI_ENGINES) expect(src).toMatch(new RegExp(`CLI_STEP_LABELS[\\s\\S]{0,200}${engine}:`));
  });

  it('two CLI branches whose attended first choice is the same CLI → executor, reason cli=2', () => {
    const agent = makeAgent();
    const plan = planObj(agent);
    expect(plan.cliWorker).toMatchObject({ cwd: expect.any(String), policy: expect.any(Object) });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r).toMatchObject({ route: 'executor', cliSteps: 2, groupCount: 1 });
    expect(r.reason).toMatch(/cli=2$/);
  });

  it('a non-CLI chain reports cli=0', () => {
    const agent = makeAgent([
      { instruction: 'summarize part A of the notes', parallelGroup: 'g' },
      { instruction: 'summarize part B of the notes', parallelGroup: 'g' },
      'merge both summaries into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r).toMatchObject({ route: 'executor', cliSteps: 0 });
    expect(r.reason).toMatch(/cli=0$/);
  });

  it('pin mismatch: the disk plan pins a different CLI than the agent → serial', () => {
    const agent = makeAgent();
    const plan = planObj(agent);
    const list = (plan.steps as { list: Array<Record<string, unknown>> }).list;
    list[1] = { ...list[1], tool: { type: 'cli', cli: 'codex' } };
    const r = decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV });
    expect(r.route).toBe('serial');
  });

  it('pin mismatch: the attended router would not pick that CLI first (autonomous, step not user-pinned) → serial', () => {
    const agent = makeAgent([
      { instruction: 'review the open pull request in the repo', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' } },
      'merge both results into one memo',
    ], { autonomous: true });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/provider drift: attended .* vs executor cli:codex/);
  });

  it('an engine the executor cannot drive (gemini CLI) → serial', () => {
    const agent = makeAgent([
      { instruction: 'review the open pull request in the repo', parallelGroup: 'g', tool: { type: 'cli', cli: 'gemini' } as unknown as Agent['tool'], toolPinned: true },
      { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' }, toolPinned: true },
      'merge both results into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/codex \/ claude only/);
  });

  it('plan.tool unsupported (agent-level tool is a CLI) → serial: the aggregation step needs an HTTP provider', () => {
    const agent = makeAgent(CLI_STEPS, { tool: { type: 'cli', cli: 'codex' } });
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/not executor-dispatchable/);
  });

  it('a plan without the cliWorker block → serial (stale check fires first; a hand-trimmed plan is caught by the explicit check)', () => {
    const agent = makeAgent();
    const plan = planObj(agent);
    delete plan.cliWorker;
    expect(decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV }).route).toBe('serial');
  });

  it('review H1: a CLI step after web research (sourced chain) → serial, with the reason', () => {
    // Perplexity research step, then a CLI step whose prompt would carry the
    // research results (web text) — the serial chain runs it text-only.
    const agent = makeAgent([
      { instruction: 'research the latest AI papers', tool: { type: 'perplexity' }, toolPinned: true },
      { instruction: 'review the open pull request in the repo', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' }, toolPinned: true },
      { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' }, toolPinned: true },
      'merge both results into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(agent), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/step 2 is a CLI step after web research step 1/);
  });

  it('review H1: CLI steps BEFORE the research step stay eligible for the route check', () => {
    const agent = makeAgent([
      { instruction: 'review the open pull request in the repo', parallelGroup: 'g', tool: { type: 'cli', cli: 'codex' }, toolPinned: true },
      { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' }, toolPinned: true },
      'merge both results into one memo',
    ]);
    expect(decideAttendedRoute({ agent, planText: planFor(agent), env: ENV }).reason).not.toMatch(/after web research/);
  });

  it('a stale plan (built before the CLI pin) → serial', () => {
    const agent = makeAgent();
    const old = makeAgent([
      { instruction: 'review the open pull request in the repo', parallelGroup: 'g' },
      { instruction: 'write unit tests for the parser', parallelGroup: 'g', tool: { type: 'cli', cli: 'claude' }, toolPinned: true },
      'merge both results into one memo',
    ]);
    const r = decideAttendedRoute({ agent, planText: planFor(old), env: ENV });
    expect(r.route).toBe('serial');
    expect(r.reason).toMatch(/stale/);
  });
});

describe('ephemeral one-shot draft (installAgent → runAgentNow) has a current PlanSpec on disk', () => {
  beforeEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('the plan installAgent writes routes a CLI chain to the executor', async () => {
    const agent = makeAgent();
    useAgentStore.getState().setAgents([agent]);
    const commands: string[] = [];
    const runCommand = jest.fn(async (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('CEREBRAS_API_KEY')) return ENV_TEXT;
      return '';
    });
    await installAgent(agent, runCommand);
    const re = new RegExp(`cat > '[^']*plan-agent-${AGENT_ID}\\.json\\.(SHELLY_AGENT_[A-Za-z0-9_]+)\\.tmp' <<'\\1'[^\\n]*\\n([\\s\\S]*?)\\n\\1`);
    const written = commands.map((c) => re.exec(c)).find(Boolean);
    expect(written).toBeTruthy();
    const planText = written![2];
    const plan = JSON.parse(planText);
    expect(plan.cliWorker).toBeTruthy();
    expect(plan.steps.list.map((s: { tool?: { cli?: string } }) => s.tool?.cli)).toEqual(['codex', 'claude', undefined]);
    const r = decideAttendedRoute({ agent, planText, env: ENV });
    expect(r).toMatchObject({ route: 'executor', cliSteps: 2 });
  });
});
