/**
 * STOP-ALL in flight (2026-10-30, docs/superpowers/DEFERRED.md「STOP-ALL が
 * 実行中のチェーンを止めない」), attended TS side:
 *  - runAgentOrchestratedBody re-checks the kill-switch before every step and
 *    the run waiter aborts on it, so a chain halted mid-run schedules nothing
 *    further, never runs the final (action) step, and records 'skipped';
 *  - haltAllAgents also terminates in-flight runs via haltInflightRunsCommand,
 *    which tolerates a missing locks dir, garbage / stale pid files and
 *    already-dead processes, and never signals a non-agent process.
 *
 * Harness copied from __tests__/agent-manager-parallel-group.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async () => undefined),
  cancelAgentSchedule: jest.fn(async () => undefined),
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

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { haltAllAgents, haltInflightRunsCommand, runAgentNow } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';

const AGENT_ID = 'stop-all-chain-agent';
const KILL_SWITCH_MESSAGE = 'All agents are stopped (global kill-switch is on).';

const makeAgent = (id: string): Agent => ({
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
    steps: ['collect the base data', 'research one more angle', 'aggregate everything into one digest'],
  },
});

/** `writeLog(n)` decides whether the n-th (0-based) step-script materialize
 *  produces a run log, i.e. whether that step "finishes". */
function makeRunCommand(allCommands: string[], agentId: string, writeLog: (n: number) => boolean) {
  const logs: Array<Record<string, unknown>> = [];
  const previews = ['base data alpha', 'angle beta research', 'final digest gamma'];
  let materialized = 0;
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${agentId}`)) {
      const n = materialized++;
      if (writeLog(n)) {
        logs.push({
          agentId,
          timestamp: Date.now() + logs.length,
          status: 'success',
          durationMs: 5,
          toolUsed: 'unknown',
          outputPreview: previews[Math.min(logs.length, previews.length - 1)],
        });
      }
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
}

function readAggregate(allCommands: string[]): any {
  const aggregateCmd = allCommands.find((c) => c.includes('"steps":['));
  expect(aggregateCmd).toBeDefined();
  const jsonStart = aggregateCmd!.indexOf('{"agentId"');
  return JSON.parse(aggregateCmd!.slice(jsonStart).split('\n')[0].replace(/'$/, '').replace(/\\'/g, "'"));
}

describe('attended chain — STOP-ALL mid-chain', () => {
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockReset();
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID)]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.getState().setHalted(false);
  });

  afterEach(() => {
    useAgentStore.getState().setHalted(false);
  });

  it('halt between steps: no later step (and so no final action) is launched; the run is skipped', async () => {
    const allCommands: string[] = [];
    const runCommand = makeRunCommand(allCommands, AGENT_ID, () => true);
    // STOP-ALL pressed while step 1 is running.
    mockTerminalEmulator.runAgent.mockImplementationOnce(async () => {
      useAgentStore.getState().setHalted(true);
    });

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    const aggregate = readAggregate(allCommands);
    expect(aggregate.status).toBe('skipped');
    expect(aggregate.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(aggregate.steps).toHaveLength(1);
    expect(aggregate.steps[0].status).toBe('success');
  });

  it('halt while a step is still running: the waiter aborts at once instead of waiting out the deadline', async () => {
    const allCommands: string[] = [];
    // Step 1 never writes a run log (killed by STOP-ALL).
    const runCommand = makeRunCommand(allCommands, AGENT_ID, (n) => n !== 0);
    mockTerminalEmulator.runAgent.mockImplementationOnce(async () => {
      useAgentStore.getState().setHalted(true);
    });

    const started = Date.now();
    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 60_000, pollMs: 1 });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    const aggregate = readAggregate(allCommands);
    expect(aggregate.status).toBe('skipped');
    expect(aggregate.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(aggregate.steps).toHaveLength(0);
  });

  it('REGRESSION: without a halt the whole chain runs', async () => {
    const allCommands: string[] = [];
    const runCommand = makeRunCommand(allCommands, AGENT_ID, () => true);
    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(3);
    expect(readAggregate(allCommands).status).toBe('success');
  });
});

describe('haltAllAgents — in-flight termination', () => {
  afterEach(() => {
    useAgentStore.getState().setHalted(false);
  });

  it('kills in-flight runs after writing the sentinel, with the live shell $HOME', async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID)]);
    const commands: string[] = [];
    await haltAllAgents(async (cmd) => {
      commands.push(cmd);
      return '';
    });
    expect(useAgentStore.getState().halted).toBe(true);
    const sentinelIdx = commands.findIndex((c) => c.includes('.halted'));
    const killIdx = commands.indexOf(haltInflightRunsCommand());
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeGreaterThan(sentinelIdx);
    const kill = haltInflightRunsCommand();
    expect(kill).toContain('d="$HOME/.shelly/agents/locks"');
    expect(kill).not.toContain('/home/shelly-test');
    expect(kill).not.toMatch(/set -e/);
  });

  it('a failed termination command is reported, not swallowed (alarms and sentinel still applied)', async () => {
    useAgentStore.getState().setAgents([makeAgent(AGENT_ID)]);
    const commands: string[] = [];
    await expect(
      haltAllAgents(async (cmd) => {
        commands.push(cmd);
        if (cmd === haltInflightRunsCommand()) throw new Error('exec failed');
        return '';
      }),
    ).rejects.toThrow(/in-flight run termination failed/);
    expect(useAgentStore.getState().halted).toBe(true);
    expect(commands.some((c) => c.includes('.halted'))).toBe(true);
  });

  // Real bash + /proc (Linux CI; Git Bash's MSYS /proc also works). Skipped
  // when no bash with a readable /proc/self/stat is on PATH.
  const hasProc = spawnSync('bash', ['-c', 'test -r /proc/self/stat && test -r /proc/$$/cmdline'], { encoding: 'utf8' }).status === 0;
  (hasProc ? it : it.skip)('real bash: survives missing/garbage/stale pid files, kills agent runs, spares other processes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-halt-inflight-'));
    // 1) No locks dir at all: exits 0.
    let r = spawnSync('bash', ['-c', haltInflightRunsCommand()], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);

    const locks = path.join(home, '.shelly/agents/locks');
    fs.mkdirSync(locks, { recursive: true });
    const agentScript = path.join(home, '.shelly/agents/run-agent-live.sh');
    fs.writeFileSync(agentScript, 'sleep 30\n');
    fs.writeFileSync(path.join(locks, 'garbage.pid'), 'not-a-pid\n');
    fs.writeFileSync(path.join(locks, 'empty.pid'), '');
    fs.writeFileSync(path.join(locks, 'stale.pid'), '4194000\n');
    fs.mkdirSync(path.join(locks, 'stale.pid.lockdir'));
    const killScript = path.join(home, 'halt-inflight.sh');
    fs.writeFileSync(killScript, haltInflightRunsCommand());
    // Background jobs get /dev/null stdio so an orphaned `sleep` can't hold
    // spawnSync's pipe open.
    const script = [
      'cd "$HOME/.shelly/agents"',
      'bash run-agent-live.sh </dev/null >/dev/null 2>&1 & agent=$!',
      'sleep 30 </dev/null >/dev/null 2>&1 & other=$!',
      'echo "$agent" > locks/live.pid',
      'echo "$other" > locks/other.pid',
      'sleep 0.3',
      'bash "$HOME/halt-inflight.sh"; rc=$?',
      'sleep 0.2',
      'kill -0 "$agent" 2>/dev/null && echo AGENT_ALIVE || echo AGENT_DEAD',
      'kill -0 "$other" 2>/dev/null && echo OTHER_ALIVE || echo OTHER_DEAD',
      'echo "RC=$rc"',
      'kill "$other" 2>/dev/null',
    ].join('\n');
    r = spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20_000 });
    expect(r.stdout).toContain('RC=0');
    expect(r.stdout).toContain('AGENT_DEAD');
    expect(r.stdout).toContain('OTHER_ALIVE');
    // Stale / garbage pid files and their lockdir are cleaned up.
    expect(fs.existsSync(path.join(locks, 'stale.pid'))).toBe(false);
    expect(fs.existsSync(path.join(locks, 'stale.pid.lockdir'))).toBe(false);
    expect(fs.existsSync(path.join(locks, 'garbage.pid'))).toBe(false);
  });
});
