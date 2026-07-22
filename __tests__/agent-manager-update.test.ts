/**
 * lib/agent-manager.ts's updateAgent — added for the chat-native
 * "correct the agent I just registered" flow (hooks/use-ai-pane-dispatch.ts,
 * 2026-07-23; store/ai-pane-store.ts's JustRegisteredAgentRef). Covers the
 * two contracts callers rely on:
 *  (1) a partial update actually reaches BOTH the in-memory store and a full
 *      installAgent reinstall (disk JSON + generated script + AlarmManager
 *      schedule) — not just an in-memory patch that a corrected schedule
 *      would never actually fire on;
 *  (2) a missing agentId returns null instead of throwing, so a correction
 *      racing against an already-deleted agent degrades gracefully.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async () => undefined),
  scheduleAgent: jest.fn(async () => undefined),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: mockTerminalEmulator,
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { updateAgent } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

const AGENT_ID = 'just-registered-agent';

function baseAgent(): Agent {
  return {
    id: AGENT_ID,
    name: 'Daily digest',
    description: 'Summarize today',
    prompt: 'Summarize today',
    schedule: '0 9 * * *',
    tool: { type: 'local' },
    outputPath: '~/out',
    outputTemplate: null,
    action: { type: 'draft' },
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  };
}

describe('updateAgent — correct an already-registered agent in place', () => {
  beforeEach(() => {
    mockTerminalEmulator.scheduleAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    useAgentStore.getState().setAgents([baseAgent()]);
  });

  it('merges a schedule correction into the store AND reinstalls the alarm with the NEW cron', async () => {
    const runCommand = jest.fn(async () => '');
    const updated = await updateAgent(AGENT_ID, { schedule: '0 20 * * *' }, runCommand);

    expect(updated).not.toBeNull();
    expect(updated?.schedule).toBe('0 20 * * *');
    expect(useAgentStore.getState().agents.find((a) => a.id === AGENT_ID)?.schedule).toBe('0 20 * * *');
    // installSchedule -> TerminalEmulator.scheduleAgent is the ACTUAL mechanism
    // that makes a "やっぱり20時で" correction fire at the new time instead of
    // the stale one — asserting the store field alone would miss a regression
    // that patches the record but leaves the old AlarmManager alarm armed.
    expect(mockTerminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
    expect(mockTerminalEmulator.scheduleAgent).toHaveBeenCalledWith(
      AGENT_ID,
      expect.any(Number),
      expect.any(Number),
      '0 20 * * *',
    );
  });

  it('sanitizes a rename through the same write-boundary filter createAgent uses', async () => {
    const runCommand = jest.fn(async () => '');
    const updated = await updateAgent(AGENT_ID, { name: 'evil\nname' }, runCommand);
    expect(updated?.name).not.toContain('\n');
  });

  it('returns null (does not throw, never touches disk/alarm) when the agent no longer exists', async () => {
    const runCommand = jest.fn(async () => '');
    const updated = await updateAgent('does-not-exist', { schedule: '0 20 * * *' }, runCommand);
    expect(updated).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(mockTerminalEmulator.scheduleAgent).not.toHaveBeenCalled();
  });

  it('defaults autonomyLevel to L2 when a partial update turns autonomous on without one set', async () => {
    const runCommand = jest.fn(async () => '');
    const updated = await updateAgent(
      AGENT_ID,
      { autonomous: true, tool: { type: 'cli', cli: 'codex' } },
      runCommand,
    );
    expect(updated?.autonomous).toBe(true);
    expect(updated?.autonomyLevel).toBe('L2');
  });
});
