/**
 * DEFERRED.md "エージェント二重実行レース" — chain-lock follow-up (2026-07-18).
 *
 * __tests__/agent-manager-inflight-dedupe.test.ts already proved the JS-side
 * fix (inFlightAgentRuns dedupe). That fix cannot reach a native AlarmManager
 * fire, which runs an agent's on-disk .sh directly — never through
 * runAgentNow. This file proves the SECOND, independent line of defense: a
 * chain-scoped mkdir lock (lib/agent-manager.ts's acquireChainLock/
 * releaseChainLock) held across a whole attended chain, plus the generated
 * script's own chain-lock-aware, now-atomic per-agent LOCK_FILE check
 * (lib/agent-executor.ts's generateRunScript).
 *
 * Two kinds of coverage:
 *  - Real bash execution (no mocks) against a real temp HOME, proving the
 *    on-disk mkdir/token mechanics actually work — including simulating two
 *    genuinely separate OS processes racing the same on-disk lock state.
 *  - Mocked-runCommand JS-level tests proving runAgentOrchestrated /
 *    runEscalatingAttempts acquire the chain lock before their first step/
 *    attempt and release it only after the final restore materialize,
 *    including on an early-exit/error path.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => require('node:os').tmpdir().replace(/\\/g, '/') + '/shelly-chain-lock-test-home',
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

import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { generateRunScript, getChainLockDir } from '@/lib/agent-executor';
import { acquireChainLock, releaseChainLock, runAgentNow } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent, ToolChoice } from '@/store/types';

const execFileAsync = promisify(execFile);

const HOME = os.tmpdir().replace(/\\/g, '/') + '/shelly-chain-lock-test-home';

/** A real runCommand — actually shells out to bash, no mocking. Used to prove
 * the on-disk mkdir/token mechanics work against a genuine filesystem. */
const realRunCommand = async (cmd: string): Promise<string> => {
  const { stdout } = await execFileAsync('bash', ['-c', cmd]);
  return stdout;
};

function resetHome(): void {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

const baseAgent = (id: string, tool: ToolChoice = { type: 'local' }): Agent => ({
  id,
  name: id,
  description: '',
  prompt: 'summarize this note for me',
  schedule: null,
  tool,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

describe('acquireChainLock / releaseChainLock — mkdir-based atomic lock (real fs, real bash)', () => {
  beforeEach(() => {
    resetHome();
  });

  it('acquires the lock and writes seed/token/acquired-at under the real chain-lock directory', async () => {
    const seed = await acquireChainLock('lock-agent-1', realRunCommand);
    const dir = getChainLockDir('lock-agent-1');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(`${dir}/seed`, 'utf8')).toBe(seed);
    expect(fs.readFileSync(`${dir}/token`, 'utf8')).toBe('');
    expect(fs.existsSync(`${dir}/acquired-at`)).toBe(true);
  });

  it('a second acquireChainLock call for the SAME agent while the first is still held throws — proves mkdir exclusivity independent of any in-process JS map', async () => {
    await acquireChainLock('lock-agent-2', realRunCommand);
    await expect(acquireChainLock('lock-agent-2', realRunCommand)).rejects.toThrow(/already holding the chain lock/);
  });

  it('a DIFFERENT agentId is unaffected by another agent holding its own chain lock', async () => {
    await acquireChainLock('lock-agent-3a', realRunCommand);
    await expect(acquireChainLock('lock-agent-3b', realRunCommand)).resolves.toEqual(expect.any(String));
  });

  it('releaseChainLock only removes the lock when the seed matches — a stale caller cannot tear down a lock it no longer owns', async () => {
    const seed = await acquireChainLock('lock-agent-4', realRunCommand);
    const dir = getChainLockDir('lock-agent-4');

    await releaseChainLock('lock-agent-4', 'not-the-real-seed', realRunCommand);
    expect(fs.existsSync(dir)).toBe(true); // still held — wrong seed didn't tear it down

    await releaseChainLock('lock-agent-4', seed, realRunCommand);
    expect(fs.existsSync(dir)).toBe(false); // correct seed released it

    // Lock is free again — a new chain can now acquire it.
    await expect(acquireChainLock('lock-agent-4', realRunCommand)).resolves.toEqual(expect.any(String));
  });

  it('a lock older than the staleness window is reclaimed — self-heals after a chain whose process was killed before its `finally` ran', async () => {
    const firstSeed = await acquireChainLock('lock-agent-5', realRunCommand);
    const dir = getChainLockDir('lock-agent-5');
    // Simulate an orphaned lock: back-date acquired-at well past the 2h staleness
    // window (see agent-manager.ts's CHAIN_LOCK_STALE_MS) without ever releasing it
    // — i.e. the crash this staleness reclaim exists for.
    const ancientEpochSec = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
    fs.writeFileSync(`${dir}/acquired-at`, String(ancientEpochSec));

    const secondSeed = await acquireChainLock('lock-agent-5', realRunCommand);
    expect(secondSeed).not.toBe(firstSeed);
    expect(fs.readFileSync(`${dir}/seed`, 'utf8')).toBe(secondSeed);
  });
});

describe('generated script — chain-lock check + hardened per-agent LOCK_FILE (real bash execution)', () => {
  beforeEach(() => {
    resetHome();
  });

  /** Extract just the chain-lock-check + per-agent LOCK_FILE block (the
   *  generateRunScript()-emitted section under test), the same
   *  extract-a-snippet convention __tests__/agent-executor-chain-execution.test.ts
   *  already uses for the orchestration-chain bash. */
  function extractLockCheckSnippet(script: string): string {
    const start = script.indexOf('# Chain-level lock check');
    expect(start).toBeGreaterThan(-1);
    const end = script.indexOf('\n\n# Execute tool', start);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end);
  }

  /** Pull a single real REAL baked `KEY=...` assignment line out of the full
   *  generated script, so the harness below drives the snippet with the
   *  EXACT values generateRunScript computed (LOCK_FILE/LOCK_DIR/
   *  CHAIN_LOCK_DIR paths, CHAIN_LOCK_NONCE, etc.) rather than a
   *  reimplementation that could silently drift from the real thing. */
  function extractVarLine(script: string, name: string): string {
    const re = new RegExp(`^${name}=.*$`, 'm');
    const m = script.match(re);
    expect(m).not.toBeNull();
    return m![0];
  }

  /** Build a small, self-contained harness around the extracted snippet —
   *  deliberately does NOT reuse the real script's trap/finish/cleanup
   *  machinery (which pulls in unrelated helpers far past what this section
   *  needs); only the variables the lock-check code itself reads. */
  function buildHarness(script: string): string {
    const vars = ['AGENT_ID', 'LOCK_FILE', 'LOCK_DIR', 'CHAIN_LOCK_DIR', 'CHAIN_LOCK_NONCE', 'LOG_DIR', 'TOOL_LABEL', 'ROUTE_DECISION_JSON']
      .map((name) => extractVarLine(script, name))
      .join('\n');
    return `set -euo pipefail
${vars}
mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"
json_escape_text() { printf '%s' "$1"; }
${extractLockCheckSnippet(script)}
echo "SHELLY_TEST_EXIT_OK"
`;
  }

  function runHarness(harness: string): { skipped: boolean; lockFilePid: string | null } {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-lock-harness-')), 'run.sh');
    fs.writeFileSync(file, harness);
    const out = execFileSync('bash', [file]).toString();
    return {
      skipped: !out.includes('SHELLY_TEST_EXIT_OK'),
      lockFilePid: null, // callers read $LOCK_FILE off disk directly when they need it
    };
  }

  it('bash -n parses the isolated chain-lock + LOCK_FILE snippet cleanly', () => {
    const script = generateRunScript(baseAgent('parse-agent'), { chainLockNonce: 'abc' });
    const harness = buildHarness(script);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-lock-parse-')), 'run.sh');
    fs.writeFileSync(file, harness);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });

  it('the full generated script still parses (bash -n) with a non-empty chainLockNonce baked in', () => {
    const script = generateRunScript(baseAgent('full-parse-agent'), { chainLockNonce: 'tok-1' });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-lock-full-parse-')), 'run.sh');
    fs.writeFileSync(file, script);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    expect(script).toContain("CHAIN_LOCK_NONCE='tok-1'");
  });

  it('no chain lock on disk → proceeds straight to the (now mkdir-atomic) per-agent lock', async () => {
    // Native-alarm-style invocation: no attended chain is running for this agent.
    const script = generateRunScript(baseAgent('no-chain-agent'));
    const { skipped } = runHarness(buildHarness(script));
    expect(skipped).toBe(false);
    const lockFileMatch = script.match(/^LOCK_FILE=(.+)$/m)![1].replace(/^'|'$/g, '');
    expect(fs.existsSync(lockFileMatch)).toBe(true); // per-agent lock was acquired
  });

  it('a chain lock held by SOMEONE ELSE (native-alarm-style empty CHAIN_LOCK_NONCE) is skipped — closes the inter-step gap', async () => {
    const agentId = 'gap-agent';
    // Simulate an attended chain currently mid-run: acquire the chain lock for
    // real and arm a live token, exactly as lib/agent-manager.ts's
    // materializeAgentBody + armed-per-attempt token would.
    const seed = await acquireChainLock(agentId, realRunCommand);
    const dir = getChainLockDir(agentId);
    fs.writeFileSync(`${dir}/token`, 'the-chain-own-token');
    // The STORED/native-alarm script never carries a nonce (see
    // MaterializeRunOpts.chainLockNonce's doc comment) — generateRunScript()
    // with no chainLockNonce opt bakes an empty CHAIN_LOCK_NONCE, exactly what
    // a native AlarmManager fire would run.
    const script = generateRunScript(baseAgent(agentId));
    const { skipped } = runHarness(buildHarness(script));
    expect(skipped).toBe(true);
    const logDir = script.match(/^LOG_DIR=(.+)$/m)![1].replace(/^'|'$/g, '');
    const logs = fs.readdirSync(logDir).filter((f) => f.endsWith('.json'));
    expect(logs.length).toBe(1);
    expect(fs.readFileSync(path.join(logDir, logs[0]), 'utf8')).toContain('previous run still active');
    const lockFileMatch = script.match(/^LOCK_FILE=(.+)$/m)![1].replace(/^'|'$/g, '');
    expect(fs.existsSync(lockFileMatch)).toBe(false); // never reached the per-agent lock

    await releaseChainLock(agentId, seed, realRunCommand);
  });

  it('a chain lock held by THIS chain (matching live token) proceeds — the chain does not self-block', async () => {
    const agentId = 'own-chain-agent';
    const seed = await acquireChainLock(agentId, realRunCommand);
    const dir = getChainLockDir(agentId);
    fs.writeFileSync(`${dir}/token`, 'my-live-token');
    // This step/candidate's materialize call baked the SAME token — mirrors
    // materializeAgentBody folding the arm write into the SAME batch that
    // bakes CHAIN_LOCK_NONCE into the script (see agent-manager.ts).
    const script = generateRunScript(baseAgent(agentId), { chainLockNonce: 'my-live-token' });
    const { skipped } = runHarness(buildHarness(script));
    expect(skipped).toBe(false);
    const lockFileMatch = script.match(/^LOCK_FILE=(.+)$/m)![1].replace(/^'|'$/g, '');
    expect(fs.existsSync(lockFileMatch)).toBe(true);

    await releaseChainLock(agentId, seed, realRunCommand);
  });

  it('a MISMATCHED nonce (different chain / stale token) is skipped', async () => {
    const agentId = 'mismatch-agent';
    const seed = await acquireChainLock(agentId, realRunCommand);
    const dir = getChainLockDir(agentId);
    fs.writeFileSync(`${dir}/token`, 'live-token-A');
    const script = generateRunScript(baseAgent(agentId), { chainLockNonce: 'stale-token-B' });
    const { skipped } = runHarness(buildHarness(script));
    expect(skipped).toBe(true);

    await releaseChainLock(agentId, seed, realRunCommand);
  });

  it('a per-agent LOCK_FILE held by a REAL live process is skipped — two genuinely separate script invocations racing the same on-disk lock state', async () => {
    const agentId = 'busy-agent';
    const script = generateRunScript(baseAgent(agentId));
    const harness = buildHarness(script);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-lock-busy-')), 'run.sh');
    fs.writeFileSync(file, harness.replace('echo "SHELLY_TEST_EXIT_OK"', 'echo "SHELLY_TEST_EXIT_OK"; sleep 10'));

    // First "invocation": a real, separate OS process that acquires the lock
    // and then sleeps, holding it — simulating a step that is still running.
    const first = spawn('bash', [file]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('first invocation never signalled readiness')), 8000);
      first.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('SHELLY_TEST_EXIT_OK')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    try {
      // Second invocation: a genuinely separate synchronous execFileSync call
      // (a distinct OS process) racing the same on-disk LOCK_FILE/LOCK_DIR.
      const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-lock-busy2-')), 'run.sh');
      fs.writeFileSync(file2, harness);
      const out2 = execFileSync('bash', [file2]).toString();
      expect(out2).not.toContain('SHELLY_TEST_EXIT_OK'); // second invocation was skipped
    } finally {
      first.kill('SIGKILL');
    }
  }, 15000);

  it('a stale per-agent LOCK_FILE (dead PID) is reclaimed atomically', () => {
    const agentId = 'stale-lock-agent';
    const script = generateRunScript(baseAgent(agentId));
    const lockFile = script.match(/^LOCK_FILE=(.+)$/m)![1].replace(/^'|'$/g, '');
    const lockDir = script.match(/^LOCK_DIR=(.+)$/m)![1].replace(/^'|'$/g, '');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true }); // simulate a prior holder's atomicity gate
    fs.writeFileSync(lockFile, '99999999'); // a PID that (almost certainly) doesn't exist

    const { skipped } = runHarness(buildHarness(script));
    expect(skipped).toBe(false); // reclaimed, not treated as busy
    expect(fs.readFileSync(lockFile, 'utf8').trim()).not.toBe('99999999'); // overwritten with the reclaiming process's own PID
  });
});

describe('runAgentOrchestrated / runEscalatingAttempts — chain lock wraps the whole run (mocked runCommand)', () => {
  beforeEach(() => {
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setRunHistory({});
  });

  /** Tracks the ORDER of chain-lock acquire/release calls relative to
   *  materialize (script-write) calls, without needing any real filesystem —
   *  same command-aware mock convention __tests__/agent-manager-inflight-dedupe.test.ts
   *  already uses. */
  function makeTrackedRunCommand(agentId: string, opts: { failStep?: number } = {}) {
    const events: string[] = [];
    let materializeCalls = 0;
    const logs: Array<Record<string, unknown>> = [];
    const runCommand = jest.fn(async (cmd: string) => {
      if (cmd.includes('CHAIN_LOCK_ACQUIRE')) {
        events.push('acquire');
        return 'CHAIN_LOCK_OK';
      }
      if (cmd.includes('CHAIN_LOCK_RELEASE')) {
        events.push('release');
        return '';
      }
      if (cmd.includes('CHAIN_LOCK_DISARM')) {
        events.push('disarm');
        return '';
      }
      if (cmd.includes(`# run-agent-${agentId}`)) {
        materializeCalls += 1;
        events.push(`materialize-${materializeCalls}`);
        if (opts.failStep && materializeCalls === opts.failStep) {
          throw new Error('simulated materialize failure');
        }
        logs.push({
          agentId,
          timestamp: Date.now() + logs.length,
          status: 'success',
          durationMs: 5,
          toolUsed: 'attempt',
          outputPreview: `ok-${materializeCalls}`,
        });
        return '';
      }
      if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv probe
      if (cmd.includes('---SHELLY_AGENT_LOG---')) {
        return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
      }
      return ''; // listAgentLogFiles / memory / skills / misc
    });
    return { runCommand, events: () => events };
  }

  it('runEscalatingAttempts (non-orchestrated single-run ladder) acquires the chain lock before its first attempt and releases it after the final restore', async () => {
    const agentId = 'esc-chain-agent';
    useAgentStore.getState().setAgents([baseAgent(agentId)]);
    const { runCommand, events } = makeTrackedRunCommand(agentId);

    await runAgentNow(agentId, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const ev = events();
    expect(ev[0]).toBe('acquire');
    expect(ev[ev.length - 1]).toBe('release');
    // Release happens strictly after every materialize (including the restore).
    const lastMaterializeIdx = ev.map((e, i) => (e.startsWith('materialize') ? i : -1)).filter((i) => i >= 0).pop()!;
    const releaseIdx = ev.lastIndexOf('release');
    expect(releaseIdx).toBeGreaterThan(lastMaterializeIdx);
  });

  it('runAgentOrchestrated acquires the chain lock before the first step and releases only after the final restore materialize', async () => {
    const agentId = 'orch-chain-agent';
    useAgentStore.getState().setAgents([
      {
        ...baseAgent(agentId),
        orchestration: { steps: ['step one', 'step two'] },
      },
    ]);
    const { runCommand, events } = makeTrackedRunCommand(agentId);

    await runAgentNow(agentId, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const ev = events();
    expect(ev[0]).toBe('acquire');
    expect(ev[ev.length - 1]).toBe('release');
    const lastMaterializeIdx = ev.map((e, i) => (e.startsWith('materialize') ? i : -1)).filter((i) => i >= 0).pop()!;
    const releaseIdx = ev.lastIndexOf('release');
    expect(releaseIdx).toBeGreaterThan(lastMaterializeIdx);
    // Each step's own attempt disarms its live token right after its run is
    // observed complete (closing the inter-step gap) before the NEXT step's
    // materialize re-arms it.
    expect(ev.filter((e) => e === 'disarm').length).toBeGreaterThanOrEqual(1);
  });

  it('the chain lock is still released when a step throws mid-chain (early-exit path)', async () => {
    const agentId = 'orch-chain-fail-agent';
    useAgentStore.getState().setAgents([
      {
        ...baseAgent(agentId),
        orchestration: { steps: ['step one', 'step two'] },
      },
    ]);
    // Fail the very first materialize call inside the step loop (after the
    // chain lock is already acquired) — runAgentOrchestratedBody catches this
    // per-step (records an 'error' step, does not rethrow), so runAgentNow
    // itself still resolves; what this test proves is that the RELEASE still
    // happens (in `finally`) even though a step failed along the way.
    const { runCommand, events } = makeTrackedRunCommand(agentId, { failStep: 1 });

    await runAgentNow(agentId, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    const ev = events();
    expect(ev[0]).toBe('acquire');
    expect(ev).toContain('release');
    expect(ev[ev.length - 1]).toBe('release');
  });
});
