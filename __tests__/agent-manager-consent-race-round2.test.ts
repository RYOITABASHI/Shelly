/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// Round 2 of the autonomous-agent cloud-consent revocation race.
//
// Round 1 (commit 6ff094f1e, this branch) serialized rematerializeAutonomousAgents
// against ITSELF via a FIFO queue and is covered by
// __tests__/agent-manager-rematerialize-race.test.ts (kept as regression
// coverage — scenario (a) below). Two independent reviews (Codex + CC) found
// that fix insufficient: materializeAgent (the actual write chokepoint) has
// several OTHER call sites — installAgent, runEscalatingAttempts's post-ladder
// restore, runLadderAttempts's per-attempt materialize, runAgentOrchestrated's
// post-chain restore, and scheduleAgentStartupRepair (fired on every app boot)
// — that bypassed rematerializeAutonomousAgents's queue entirely and could
// reproduce the identical fail-closed violation (a stale ON-consent write
// landing after a newer OFF-consent write) via a different path.
//
// This file adds the two NEW scenarios round 2 must cover per the task brief:
//   (b) rematerializeAutonomousAgents racing scheduleAgentStartupRepair (driven
//       through the public loadAgentsFromDisk entry point) — proves the fix is
//       a single chokepoint that serializes DIFFERENT callers, not just
//       rematerializeAutonomousAgents against itself.
//   (c) the escalation-ladder TOCTOU inside runLadderAttempts — consent is read
//       once before the attempt loop, then an await (readAgentRunLogs / the
//       agent run itself) is a real window for a revoke to land; the fix must
//       make the WRITE re-read consent fresh rather than bake the stale
//       pre-loop snapshot.
//
// Both tests use the same "hold the ON write open, observe that the OFF write
// cannot even START (let alone complete) until the ON write's queued turn
// fully settles, only THEN release ON" shape as the round-1 test — this is
// what distinguishes "properly serialized, OFF always lands last" from "raced,
// ON silently wins": if OFF's write completed while ON was still gated (or if
// ON's write landed AFTER OFF without being the one that started first per
// enqueue order), the assertions below would catch it.
//
// Self-review note: both tests below were run against a revert of round 2's
// lib/agent-manager.ts diff (keeping round 1's fix) and FAIL without it —
// see the round-2 handoff notes in the PR description / final report for the
// revert transcript. This directly resolves the CC/Codex disagreement about
// whether the regression coverage actually exercises the fix.

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  rematerializeAutonomousAgents,
  loadAgentsFromDisk,
  runAgentNow,
} from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const AGENT_LIST_MARKER = '---SEPARATOR---';

describe('materializeAgent shared queue — cross-caller races (round 2)', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    jest.clearAllMocks();
  });

  it('(b) an in-flight scheduleAgentStartupRepair pass cannot outlive a later consent revocation', async () => {
    const agent: Agent = {
      id: 'repair-race-agent',
      name: 'Repair race agent',
      description: '',
      prompt: '最新ニュースを集めて',
      schedule: '0 8 * * *',
      tool: { type: 'gemini-api' },
      autonomous: true,
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
    };
    useAgentStore.getState().setAgents([agent]);

    let consentEnabled = true;
    let envReads = 0;
    let writes = 0;
    const writeCommands: string[] = [];
    let finalOnDiskCommand = '';
    const firstWriteGate = deferred<void>();
    const firstWriteStarted = deferred<void>();

    const runCommand = jest.fn(async (command: string): Promise<string> => {
      // Halt-sentinel check (loadAgentsFromDisk).
      if (command.startsWith('[ -f ')) return 'HALTED_NO';
      // Agent metadata listing (readAgentMetadataViaShell).
      if (command.startsWith('d=')) {
        return `${JSON.stringify(agent)}\n${AGENT_LIST_MARKER}\n`;
      }
      // Run-log reads (readAgentRunLogs) — no history either way.
      if (command.includes('SHELLY_AGENT_LOG') || command.startsWith('for d in')) return '';
      // Orphan-file sweep (cleanupOrphanAgentFiles).
      if (command.startsWith('cd ')) return '';
      // Consent / key preflight read (ladderEnvFromDisk).
      if (command.startsWith('for k in CEREBRAS_API_KEY')) {
        envReads += 1;
        return [
          'CEREBRAS_API_KEY=0',
          'GROQ_API_KEY=0',
          'PERPLEXITY_API_KEY=1',
          'GEMINI_API_KEY=1',
          `SHELLY_AUTONOMOUS_CLOUD='${consentEnabled ? '1' : '0'}'`,
          "SHELLY_AUTONOMOUS_CLOUD_STOP='0'",
        ].join('\n');
      }
      // The materialize write itself (writeFileCommand block, `set -e\n...`).
      writes += 1;
      writeCommands.push(command);
      if (writes === 1) {
        firstWriteStarted.resolve();
        await firstWriteGate.promise;
      }
      finalOnDiskCommand = command;
      return '';
    });

    // Boot: startup repair fires almost immediately (repairDelayMs: 0) and will
    // materialize `agent` while consent is still ON.
    await loadAgentsFromDisk(runCommand, {
      repairSchedules: true,
      repairDelayMs: 0,
      shouldRepair: () => true,
    });

    // Wait for the repair pass's materialize write to actually start (not just
    // for the setTimeout to fire) — this is the ON write, now gated open.
    await firstWriteStarted.promise;
    expect(envReads).toBe(1);
    expect(writes).toBe(1);

    // The user revokes consent while the repair pass's write is still in
    // flight, and the Settings toggle fires the normal rematerialize path.
    consentEnabled = false;
    const revokePass = rematerializeAutonomousAgents(runCommand);

    // Structural check (NOT a fixed microtask-tick count, which would be
    // timing-fragile — materializeAgent's real body hops through several
    // genuinely-async, unmocked steps like readMemoryNotes before it ever
    // reaches a write, so "hasn't written yet after N ticks" proves nothing on
    // its own). Instead race revokePass's own settlement against a real
    // timeout: with the fix, revokePass's per-agent materialize call is
    // chained onto the SAME queue turn the repair pass's write is still
    // holding open, so it is promise-structurally impossible for it to settle
    // before that turn resolves — no timeout is "long enough" to let it slip
    // through. Without the fix, rematerializeAutonomousAgents has nothing to
    // wait on (its own pass-level queue is untouched by the repair path) and
    // settles at ordinary microtask speed, comfortably inside this window.
    const raced = await Promise.race([
      revokePass.then(() => 'revoke-settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 150)),
    ]);
    expect(raced).toBe('timeout');
    // Still exactly the repair pass's single (gated, unfinished) write.
    expect(writes).toBe(1);
    expect(envReads).toBe(1);

    // Release the repair pass's (ON) write. Only now can revoke's queued turn
    // begin (and it must re-read consent fresh, seeing the revoke).
    firstWriteGate.resolve();
    await revokePass;

    // The revoke's write must be the LAST one on disk, not the repair pass's.
    expect(writes).toBe(2);
    expect(envReads).toBe(2);
    expect(writeCommands[0]).toContain('https://generativelanguage.googleapis.com');
    expect(finalOnDiskCommand).toContain('[REFUSED] autonomous mode does not allow the');
    expect(finalOnDiskCommand).not.toContain('https://generativelanguage.googleapis.com');
  });
});

describe('escalation-ladder TOCTOU — per-attempt consent must be re-read fresh (round 2)', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('a revoke that lands between ladder-resolve and the first attempt write is honoured, not the stale pre-loop snapshot', async () => {
    const agent: Agent = {
      id: 'ladder-toctou-agent',
      name: 'Ladder TOCTOU agent',
      description: '',
      prompt: 'ニュースを集めて', // needsWeb, general domain -> gemini-api primary
      schedule: null,
      tool: { type: 'auto' },
      autonomous: true,
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
    };
    useAgentStore.getState().setAgents([agent]);

    // Consent is ON when the ladder is resolved (line ~675, before the attempt
    // loop) — resolveEscalationLadder therefore picks [gemini-api, cli:codex].
    let consentEnabled = true;
    let envReads = 0;
    let writeCount = 0;
    let firstAttemptWriteCommand = '';
    const runLogGate = deferred<void>();
    const runLogGateStarted = deferred<void>();
    let runLogGateConsumed = false;

    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (command.startsWith('for k in CEREBRAS_API_KEY')) {
        envReads += 1;
        return [
          'CEREBRAS_API_KEY=0',
          'GROQ_API_KEY=0',
          'PERPLEXITY_API_KEY=1',
          'GEMINI_API_KEY=1',
          `SHELLY_AUTONOMOUS_CLOUD='${consentEnabled ? '1' : '0'}'`,
          "SHELLY_AUTONOMOUS_CLOUD_STOP='0'",
        ].join('\n');
      }
      if (command.includes('SHELLY_AGENT_LOG') || command.startsWith('for d in')) {
        // readAgentRunLogs — used both for the ladder's "before" snapshot AND
        // by waitForAgentRunCompletion's poll. Gate the VERY FIRST call only
        // (the "before" read inside runLadderAttempts, which happens after the
        // ladder is resolved but before the first attempt's materialize write
        // — the real TOCTOU window this test targets) so the revoke can land
        // in that exact gap.
        if (!runLogGateConsumed) {
          runLogGateConsumed = true;
          runLogGateStarted.resolve();
          await runLogGate.promise;
        }
        return '';
      }
      if (command.startsWith('set -e')) {
        writeCount += 1;
        if (writeCount === 1) firstAttemptWriteCommand = command;
        return '';
      }
      return '';
    });

    const runPromise = runAgentNow('ladder-toctou-agent', runCommand, { waitTimeoutMs: 2_000, pollMs: 5 });

    // Wait until runLadderAttempts is blocked in the gap between ladder-resolve
    // (env read #1, consent=true) and the first attempt's materialize write.
    await runLogGateStarted.promise;
    expect(envReads).toBe(1);
    expect(writeCount).toBe(0);

    // Revoke lands in that exact window.
    consentEnabled = false;
    runLogGate.resolve();

    // The run will time out waiting for a completion log (TerminalEmulator is
    // mocked to a no-op and no run log ever appears) — that's fine, we only
    // care about what got WRITTEN for the first attempt before the timeout.
    await expect(runPromise).rejects.toThrow(/Timed out waiting for agent/);

    expect(writeCount).toBeGreaterThanOrEqual(1);
    // The fix: materializeAgent's own queued turn re-reads consent fresh
    // (envReads becomes 2) rather than reusing the stale ladder-start value —
    // so the FIRST attempt's script must reflect the REVOKED consent and
    // refuse the keyed Gemini backend, even though the ladder picked
    // gemini-api as tools[0] while consent was still true.
    expect(envReads).toBeGreaterThanOrEqual(2);
    expect(firstAttemptWriteCommand).not.toContain('https://generativelanguage.googleapis.com');
  }, 10_000);
});
