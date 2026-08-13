/**
 * Fan-out subtasks (parallel groups, 2026-08-13 — Hermes sub-agent gap
 * increment 1), attended TS chain path (runAgentOrchestratedBody):
 *
 * A chain step marked as a branch of a parallel group must be
 * context-ISOLATED from its sibling branches — its baked prompt and its
 * PRIOR_STEP_CONTENT (duplicate-detector input) both come from the PRE-group
 * results snapshot, never from a sibling branch's output — while the first
 * step AFTER the group aggregates every branch's result in declared order.
 * Dispatch itself stays serial (per-agent single-flight design — see the
 * parallelPlan comment in lib/agent-manager.ts and DEFERRED.md's 2026-08-13
 * fan-out entry), so everything else about a step run (ladder, gates,
 * suppression, fail-fast) is byte-identical to an unmarked chain.
 *
 * Harness copied from __tests__/agent-manager-step-content-prompt.test.ts
 * (same materialize-capture + fake run-log pattern).
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

import { runAgentNow } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';

const AGENT_ID = 'parallel-group-agent';
const BASE_RESULT_TOKEN = 'BASE_RESULT_TOKEN_ff1';
const BRANCH_A_TOKEN = 'BRANCH_A_RESULT_TOKEN_ff1';
const BRANCH_B_TOKEN = 'BRANCH_B_RESULT_TOKEN_ff1';

const makeAgent = (id: string, withGroups: boolean): Agent => ({
  id,
  name: id,
  description: '',
  prompt: 'Compile the weekly digest',
  schedule: null,
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'notify' },
  orchestration: {
    steps: [
      'collect the base data',
      withGroups
        ? { instruction: 'research angle A', parallelGroup: 'research' }
        : { instruction: 'research angle A' },
      withGroups
        ? { instruction: 'research angle B', parallelGroup: 'research' }
        : { instruction: 'research angle B' },
      'aggregate everything into one digest',
    ],
  },
});

interface CapturedStep {
  priorStepContent: string;
  shScriptBody: string;
  rawCommand: string;
}

function extractLine(cmd: string, prefix: string): string {
  const line = cmd.split('\n').find((l) => l.trim().startsWith(prefix));
  if (!line) return '';
  const trimmed = line.trim();
  return trimmed.slice(prefix.length + 1, -1).replace(/'\\''/g, "'");
}

function extractShScriptBody(cmd: string): string {
  const startMarker = cmd.match(/<<'(SHELLY_AGENT_[A-Za-z0-9_]+)'/);
  if (!startMarker) return cmd;
  const marker = startMarker[1];
  const startIdx = cmd.indexOf(`<<'${marker}'`) + `<<'${marker}'`.length;
  const endIdx = cmd.indexOf(`\n${marker}`, startIdx);
  return endIdx === -1 ? cmd.slice(startIdx) : cmd.slice(startIdx, endIdx);
}

function makeRunCommand(captured: CapturedStep[], allCommands: string[], agentId: string) {
  const logs: Array<Record<string, unknown>> = [];
  const previews = [BASE_RESULT_TOKEN, BRANCH_A_TOKEN, BRANCH_B_TOKEN, 'final digest text'];
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${agentId}`)) {
      const shScriptBody = extractShScriptBody(cmd);
      captured.push({
        priorStepContent: extractLine(shScriptBody, 'PRIOR_STEP_CONTENT='),
        shScriptBody,
        rawCommand: cmd,
      });
      logs.push({
        agentId,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: extractLine(shScriptBody, 'TOOL_LABEL=') || 'unknown',
        outputPreview: previews[Math.min(logs.length, previews.length - 1)],
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) {
      return [
        'CEREBRAS_API_KEY=0',
        'GROQ_API_KEY=0',
        'PERPLEXITY_API_KEY=1',
        'GEMINI_API_KEY=1',
        'SHELLY_AUTONOMOUS_CLOUD=0',
        'SHELLY_AUTONOMOUS_CLOUD_STOP=0',
      ].join('\n');
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
}

describe('attended orchestration — fan-out branch isolation + aggregation', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('a branch sees the pre-group snapshot: branch B carries the base result but NOT sibling branch A', async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID, true)]);
    const captured: CapturedStep[] = [];
    const allCommands: string[] = [];
    const runCommand = makeRunCommand(captured, allCommands, AGENT_ID);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(4);
    // Branch A (step index 1) carries the base result.
    expect(captured[1].shScriptBody).toContain(BASE_RESULT_TOKEN);
    // Branch B (step index 2): pre-group snapshot only — the base result is
    // there, sibling branch A's output is NOT (anywhere in the baked script).
    expect(captured[2].shScriptBody).toContain(BASE_RESULT_TOKEN);
    expect(captured[2].shScriptBody).not.toContain(BRANCH_A_TOKEN);
  });

  it("a branch's PRIOR_STEP_CONTENT (duplicate-detector input) is the last PRE-group result, not the sibling's output", async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID, true)]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured, [], AGENT_ID);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(4);
    expect(captured[1].priorStepContent).toBe(BASE_RESULT_TOKEN);
    // Pre-fix behavior would have been BRANCH_A_TOKEN here — two similar
    // parallel-research branches must never be duplicate-compared against
    // each other.
    expect(captured[2].priorStepContent).toBe(BASE_RESULT_TOKEN);
  });

  it('the first post-group step aggregates EVERY branch result in declared order', async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID, true)]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured, [], AGENT_ID);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(4);
    const finalScript = captured[3].shScriptBody;
    expect(finalScript).toContain(BASE_RESULT_TOKEN);
    expect(finalScript).toContain(BRANCH_A_TOKEN);
    expect(finalScript).toContain(BRANCH_B_TOKEN);
    // Declared order inside the composite prompt's carried-results block
    // (buildStepPrompt labels: base = Step 1, branch A = Step 2, branch B =
    // Step 3). Not a bare indexOf comparison — BRANCH_B also appears earlier
    // in the script as the PRIOR_STEP_CONTENT env line.
    expect(finalScript).toMatch(new RegExp(`## Step 2[\\s\\S]{0,80}${BRANCH_A_TOKEN}`));
    expect(finalScript).toMatch(new RegExp(`## Step 3[\\s\\S]{0,80}${BRANCH_B_TOKEN}`));
    // The final step is never itself a branch: its duplicate check compares
    // against the immediately preceding (branch B) result as usual.
    expect(captured[3].priorStepContent).toBe(BRANCH_B_TOKEN);
  });

  it('the persisted aggregate run log records which steps ran as branches (parallelGroup on the step records)', async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID, true)]);
    const allCommands: string[] = [];
    const runCommand = makeRunCommand([], allCommands, AGENT_ID);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    // The aggregate persist command embeds the JSON.stringify(aggregate) —
    // find it and check the step records.
    const aggregateCmd = allCommands.find((c) => c.includes('"steps":['));
    expect(aggregateCmd).toBeDefined();
    const jsonStart = aggregateCmd!.indexOf('{"agentId"');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const aggregate = JSON.parse(
      // The aggregate JSON is the heredoc/printf payload; parse from its first
      // brace to the matching final brace by trusting JSON.parse to stop at a
      // valid value via a trailing-content trim.
      aggregateCmd!.slice(jsonStart).split('\n')[0].replace(/'$/, '').replace(/\\'/g, "'"),
    );
    const groups = (aggregate.steps as Array<{ parallelGroup?: string }>).map((s) => s.parallelGroup);
    expect(groups).toEqual([undefined, 'research', 'research', undefined]);
  });

  it('REGRESSION: the same chain WITHOUT markers keeps serial carry-forward (branch B sees branch A)', async () => {
    const serialId = 'serial-chain-agent';
    useAgentStore.getState().setAgents([makeAgent(serialId, false)]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured, [], serialId);

    await runAgentNow(serialId, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(4);
    expect(captured[2].shScriptBody).toContain(BRANCH_A_TOKEN);
    expect(captured[2].priorStepContent).toBe(BRANCH_A_TOKEN);
  });
});
