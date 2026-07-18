/**
 * Concurrency-race investigation (2026-07-17/18, docs/superpowers/DEFERRED.md,
 * agent-mrorpolq): components/layout/Sidebar.tsx's RUN NOW controls had no
 * guard against a second concurrent press for the same agent — a double-tap/
 * ghost-tap (or any other JS caller invoking runAgentNow for the same agentId
 * while a prior call is still in flight — @agent chat, TerminalPane, a second
 * Sidebar press) could start two overlapping runs that race each other's
 * materialize/run-log writes.
 *
 * lib/agent-manager.ts's runAgentNow now dedupes: a second call for the same
 * agentId while one is already in flight JOINS the existing promise instead
 * of starting its own run. This test drives two concurrent runAgentNow calls
 * for the SAME agent (holding the first's materialize command open via a
 * deferred gate so the second call provably starts while the first is still
 * running) and asserts the agent was only actually run ONCE — exactly one
 * TerminalEmulator.runAgent call — and both callers observe the same outcome.
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

const AGENT_ID = 'inflight-dedupe-agent';

const agent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: 'summarize this note for me',
  schedule: null,
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runAgentNow — in-flight per-agent dedupe', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([agent]);
    useAgentStore.getState().setRunHistory({});
  });

  it('a second concurrent call for the same agent joins the first instead of starting a new run', async () => {
    const logs: Array<Record<string, unknown>> = [];
    let materializeCalls = 0;
    const firstMaterializeStarted = deferred();
    const releaseFirstMaterialize = deferred();

    const runCommand = jest.fn(async (cmd: string) => {
      if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
        materializeCalls += 1;
        if (materializeCalls === 1) {
          firstMaterializeStarted.resolve();
          // Hold the first (and, if the dedupe fix regresses, the only
          // legitimate) materialize open long enough for a second
          // runAgentNow call to be issued and provably observe the first
          // as still in flight before either resolves.
          await releaseFirstMaterialize.promise;
        }
        logs.push({
          agentId: AGENT_ID,
          timestamp: Date.now() + logs.length,
          status: 'success',
          durationMs: 5,
          toolUsed: 'attempt-1',
          outputPreview: 'ok',
        });
        return '';
      }
      if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv probe
      if (cmd.includes('---SHELLY_AGENT_LOG---')) {
        return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
      }
      return ''; // listAgentLogFiles / memory / skills / misc
    });

    const first = runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });
    await firstMaterializeStarted.promise;

    // Fire a second call for the SAME agent while the first is provably still
    // in its materialize step — the exact double-tap/re-entrant-call shape
    // under investigation.
    const second = runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    releaseFirstMaterialize.resolve();
    await expect(Promise.all([first, second])).resolves.toBeDefined();

    // A single successful runEscalatingAttempts call legitimately does TWO
    // materialize calls (the real ladder attempt, then runEscalatingAttempts's
    // own trailing restore-to-original-config write — see the identical note
    // in __tests__/agent-manager-deterministic-dispatch-failure.test.ts's
    // makeRunCommand) but only ONE TerminalEmulator.runAgent call (the restore
    // never runs the agent, it only rewrites the on-disk script). If the
    // dedupe fix had regressed and the second runAgentNow call had driven its
    // own overlapping run instead of joining the first, this would instead be
    // 4 materialize calls and 2 TerminalEmulator.runAgent calls.
    expect(materializeCalls).toBe(2);
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
  });
});
