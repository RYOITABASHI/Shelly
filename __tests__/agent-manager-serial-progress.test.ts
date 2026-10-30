/**
 * MONITOR live progress for the attended SERIAL chain
 * (lib/agent-progress-writer.ts, wired in lib/agent-manager.ts
 * runAgentOrchestratedBody): the chain appends the SAME progress.jsonl schema
 * the PlanSpec executor writes, so lib/agent-progress.ts parseProgressJsonl
 * reads either. Checks event order/shape, rotation at run start, the
 * WAITING_APPROVAL hook, a halted chain ending as run_end "halted", and that
 * a failing progress write never breaks the run.
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
import { parseProgressJsonl, parseProgressLine } from '@/lib/agent-progress';
import { noteAttendedApprovalWaiting, progressTailText, __resetAttendedProgressWritersForTests } from '@/lib/agent-progress-writer';
import { useAgentStore } from '@/store/agent-store';
import { Agent, AgentOrchestrationConfig } from '@/store/types';

const AGENT_ID = 'serial-progress-agent';

const makeAgent = (steps: AgentOrchestrationConfig['steps']): Agent => ({
  id: AGENT_ID,
  name: AGENT_ID,
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
  orchestration: { steps },
});

/** Single-quoted shell words after `printf '%s\n' ` on the append line. */
function appendedLines(cmd: string): string[] {
  const line = cmd.split('\n').find((l) => l.startsWith(`printf '%s\\n' `));
  if (!line) return [];
  const out: string[] = [];
  let i = `printf '%s\\n' `.length;
  while (i < line.length && line[i] === "'") {
    let word = '';
    i += 1;
    for (;;) {
      const end = line.indexOf("'", i);
      word += line.slice(i, end);
      i = end + 1;
      if (line.startsWith("\\''", i)) {
        word += "'";
        i += 3;
        continue;
      }
      break;
    }
    out.push(word);
    while (line[i] === ' ') i += 1;
  }
  return out;
}

interface Harness {
  commands: string[];
  progressLines: () => string[];
  runCommand: jest.Mock;
}

function makeHarness(opts: { previews?: string[]; failProgress?: boolean } = {}): Harness {
  const commands: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const previews = opts.previews ?? ['collected items', 'summary text', 'final digest'];
  const runCommand = jest.fn(async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes('# SHELLY_PROGRESS_APPEND') && opts.failProgress) throw new Error('disk full');
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'Local LLM',
        outputPreview: previews[Math.min(logs.length, previews.length - 1)],
        routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'auto', why: 'test' },
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) {
      return ['CEREBRAS_API_KEY=0', 'GROQ_API_KEY=0', 'PERPLEXITY_API_KEY=1', 'GEMINI_API_KEY=1', 'SHELLY_AUTONOMOUS_CLOUD=0', 'SHELLY_AUTONOMOUS_CLOUD_STOP=0'].join('\n');
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
  return {
    commands,
    runCommand,
    progressLines: () => commands.filter((c) => c.includes('# SHELLY_PROGRESS_APPEND')).flatMap(appendedLines),
  };
}

const STEPS: AgentOrchestrationConfig['steps'] = [
  'collect the base data',
  'summarize the collected data',
  'aggregate everything into one digest',
];

describe('attended serial chain — progress.jsonl stream', () => {
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
    __resetAttendedProgressWritersForTests();
  });

  it('writes run_start(SERIAL) → STANDBY×n → RUNNING/tool/DONE per step → run_end(success), parsable by parseProgressJsonl', async () => {
    useAgentStore.getState().setAgents([makeAgent(STEPS)]);
    const h = makeHarness();

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const lines = h.progressLines();
    expect(lines.length).toBeGreaterThan(0);
    // Every line is a valid schema-v1 event in strictly increasing seq.
    const events = lines.map((l) => parseProgressLine(l));
    expect(events.every(Boolean)).toBe(true);
    expect(events.map((e) => e!.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]).toMatchObject({ kind: 'run_start', mode: 'SERIAL', stepCount: 3, agentId: AGENT_ID });
    expect(events.at(-1)).toMatchObject({ kind: 'run_end', status: 'success' });
    expect(typeof (events.at(-1) as unknown as { durationMs: unknown }).durationMs).toBe('number');

    // Per-step order: STANDBY before RUNNING before DONE.
    const statesOf = (i: number) => events.filter((e) => e!.kind === 'branch_state' && e!.stepIndex === i).map((e) => e!.state);
    for (let i = 0; i < 3; i++) expect(statesOf(i)).toEqual(['STANDBY', 'RUNNING', 'DONE']);
    // Step i+1 only starts after step i settled (serial).
    const runningAt = (i: number) => events.findIndex((e) => e!.kind === 'branch_state' && e!.stepIndex === i && e!.state === 'RUNNING');
    const doneAt = (i: number) => events.findIndex((e) => e!.kind === 'branch_state' && e!.stepIndex === i && e!.state === 'DONE');
    expect(doneAt(0)).toBeLessThan(runningAt(1));
    expect(doneAt(1)).toBeLessThan(runningAt(2));

    const run = parseProgressJsonl(lines.join('\n'));
    expect(run).not.toBeNull();
    expect(run!.mode).toBe('SERIAL');
    expect(run!.status).toBe('success');
    expect(run!.stepCount).toBe(3);
    expect(run!.branches.map((b) => b.state)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(run!.branches[0].provider).toMatchObject({ kind: 'LOCAL', name: 'local' });
    expect(run!.branches[2].tail).toBe('final digest');

    // Rotation happens once, in the first append, via the live shell $HOME.
    const appends = h.commands.filter((c) => c.includes('# SHELLY_PROGRESS_APPEND'));
    expect(appends[0]).toContain('progress.prev.jsonl');
    expect(appends[0]).toContain(`"$HOME/.shelly/agents/logs/${AGENT_ID}/progress.jsonl"`);
    expect(appends.slice(1).some((c) => c.includes('progress.prev.jsonl'))).toBe(false);
  });

  it('a grouped chain still reports SERIAL (the attended route dispatches serially) and tags branches with groupId', async () => {
    useAgentStore.getState().setAgents([makeAgent([
      'collect the base data',
      { instruction: 'research angle A', parallelGroup: 'research' },
      { instruction: 'research angle B', parallelGroup: 'research' },
      'aggregate everything into one digest',
    ])]);
    const h = makeHarness({ previews: ['base', 'angle A', 'angle B', 'digest'] });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const run = parseProgressJsonl(h.progressLines().join('\n'));
    expect(run!.mode).toBe('SERIAL');
    expect(run!.branches.map((b) => b.groupId)).toEqual([undefined, 'research', 'research', undefined]);
  });

  it('the approval hook flags the running step WAITING_APPROVAL before it settles', async () => {
    useAgentStore.getState().setAgents([makeAgent(STEPS)]);
    const h = makeHarness();
    let calls = 0;
    mockTerminalEmulator.runAgent.mockImplementation(async (agentId: string) => {
      calls += 1;
      if (calls === 3) noteAttendedApprovalWaiting(agentId); // final (action) step
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const events = h.progressLines().map((l) => parseProgressLine(l)!);
    const finalStates = events.filter((e) => e.kind === 'branch_state' && e.stepIndex === 2).map((e) => e.state);
    expect(finalStates).toEqual(['STANDBY', 'RUNNING', 'WAITING_APPROVAL', 'DONE']);
  });

  it('a chain halted mid-run (STOP-ALL) ends with run_end "halted" and the unrun steps SKIPPED', async () => {
    useAgentStore.getState().setAgents([makeAgent(STEPS)]);
    const h = makeHarness();
    let calls = 0;
    mockTerminalEmulator.runAgent.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) useAgentStore.getState().setHalted(true);
    });

    await runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const run = parseProgressJsonl(h.progressLines().join('\n'));
    expect(run!.status).toBe('halted');
    expect(run!.endedAt).toBeDefined();
    expect(run!.branches[0].state).toBe('DONE');
    expect(run!.branches[1].state).toBe('SKIPPED');
    expect(run!.branches[2].state).toBe('SKIPPED');
    // The final action step never ran.
    expect(calls).toBe(1);
  });

  it('a failing progress write disables the stream after one attempt and never breaks the run', async () => {
    useAgentStore.getState().setAgents([makeAgent(STEPS)]);
    const h = makeHarness({ failProgress: true });

    await expect(runAgentNow(AGENT_ID, h.runCommand, { waitTimeoutMs: 2000, pollMs: 1 })).resolves.toBeUndefined();

    expect(h.commands.filter((c) => c.includes('# SHELLY_PROGRESS_APPEND')).length).toBe(1);
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(3);
    expect(useAgentStore.getState().runHistory[AGENT_ID]?.at(-1)?.status).toBe('success');
  });

  it('progressTailText redacts and caps at 240 code points', () => {
    const long = '😀'.repeat(300);
    expect(Array.from(progressTailText(long)).length).toBe(240);
    expect(progressTailText('key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end')).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });
});
