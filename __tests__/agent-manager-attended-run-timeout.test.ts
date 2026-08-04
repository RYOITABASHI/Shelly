/**
 * bug #164 (docs/superpowers/DEFERRED.md): on-device, registering a
 * schedule-confirmable draft/notify agent via the AI Chat pane and then
 * having it auto-run (isEphemeralOneShot) or an explicit "@agent run"
 * appeared to busy-poll `find … -name '*.json'` under
 * ~/.shelly/agents/logs/<agentId>/ forever — every ~1.5s, always returning
 * the exact same stdout, no error, no visible progress.
 *
 * Investigation: lib/agent-manager.ts's waitForAgentRunCompletion (called
 * from runAgentNow via runEscalatingAttempts/runLadderAttempts) already
 * bounds the poll with a `while (Date.now() <= deadline)` loop and rejects
 * with "Timed out waiting for agent …" once the deadline passes — it is not
 * a true infinite loop. The bug is that BOTH attended, chat-visible call
 * sites in hooks/use-ai-pane-dispatch.ts (explicit "@agent run" and the
 * post-registration ephemeral one-shot auto-run) called runAgentNow with no
 * options, so they inherited the 20-minute UNATTENDED default
 * (AGENT_RUN_WAIT_TIMEOUT_MS) intended for background/native-alarm-driven
 * runs. A human staring at an empty/"Running…" chat bubble for up to 20
 * minutes with zero incremental feedback, while the device silently
 * busy-polls every 1.5s, is indistinguishable from a genuine infinite hang
 * and wastes real CPU/battery. Fix: both attended call sites now pass
 * ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS (10 min, raised from 5 min on
 * 2026-08-04 after an on-device repro where a single slow orchestration
 * step legitimately exceeded the old cap) instead.
 *
 * This test reproduces the exact repro shape reported on-device: a mocked
 * runCommand whose readAgentRunLogs branch always returns the SAME stable,
 * pre-existing run log content (same bytes every poll, matching the
 * on-device observation of an unchanging stdout size) — i.e. a condition
 * that never resolves — and asserts runAgentNow gives up and rejects within
 * a bounded time instead of polling forever.
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

import { runAgentNow, ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';

const AGENT_ID = 'attended-timeout-agent';

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: 'now, create a note with the content: hello',
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

describe('runAgentNow — attended-run poll is bounded, not infinite (bug #164)', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.setState({ halted: false });
  });

  it('ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS is a real, much shorter bound than the 20-minute unattended default', () => {
    expect(ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS).toBeLessThan(20 * 60_000);
  });

  it('gives up and rejects instead of polling forever when the run-log condition never resolves (stable stdout every poll)', async () => {
    useAgentStore.getState().setAgents([baseAgent]);

    // A single, PRE-EXISTING run log — present before this run "starts" and
    // never changing. This reproduces the on-device symptom exactly: every
    // poll returns identical, non-empty stdout (a real existing file), but
    // it is never new enough (older than runStartedAtMs / not a new count)
    // to satisfy waitForAgentRunCompletion's hasNewRun check.
    const staleLog = {
      agentId: AGENT_ID,
      timestamp: Date.now() - 60_000,
      status: 'success',
      durationMs: 1,
      toolUsed: 'x',
      outputPreview: 'an old run from before this attempt',
    };
    const staleLogChunk = `${JSON.stringify(staleLog)}\n---SHELLY_AGENT_LOG---\n`;

    let pollCount = 0;
    const runCommand = jest.fn(async (cmd: string): Promise<string> => {
      if (cmd.includes('---SHELLY_AGENT_LOG---')) {
        pollCount += 1;
        // Byte-for-byte identical every single call — exactly the
        // "exit=0 stdout=652chars every time" shape from the on-device logs.
        return staleLogChunk;
      }
      return '';
    });

    const start = Date.now();
    await expect(
      runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 300, pollMs: 25 })
    ).rejects.toThrow(/Timed out waiting for agent/);
    const elapsedMs = Date.now() - start;

    // Terminates close to the requested bound, not hundreds of polls / minutes.
    expect(elapsedMs).toBeLessThan(3_000);
    // Confirms it actually polled repeatedly (the busy-poll shape) before
    // giving up — this is not a test that trivially resolves on the first call.
    expect(pollCount).toBeGreaterThan(1);
  });
});
