/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// P0-1 reliability audit follow-up: a single lost AlarmManager alarm (Doze /
// OEM battery kill / a foreground-service start failure) previously left a
// scheduled agent's schedule silently and permanently dead — the only signal
// was the Sidebar agent-detail popup, which is passive (only checked if/when
// the user taps the agent row). scheduleAgentStartupRepair (fired from
// loadAgentsFromDisk on every app launch, see app/_layout.tsx) already
// unconditionally re-armed every enabled scheduled agent's alarm on launch;
// this suite covers the NEW active-detection half: it must ALSO notice a
// fire that was due but never recorded a run and post a local notification,
// exactly once per missed window (dedup via Agent.lastMissedNotifiedAt).

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    scheduleAgent: jest.fn(async () => undefined),
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => 'notif-id'),
}));
jest.mock('expo-file-system/legacy', () => ({}));

import { loadAgentsFromDisk } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';
import * as Notifications from 'expo-notifications';

const scheduleNotificationAsync = Notifications.scheduleNotificationAsync as jest.Mock;

const AGENT_LIST_MARKER = '---SEPARATOR---';

/** A daily 08:00 cron that (relative to a fixed "now" of 09:00) is guaranteed
 *  to have last fired at today 08:00 — well past the 5-minute missed-run grace. */
const DAILY_0800 = '0 8 * * *';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'sched-agent',
    name: 'Daily digest',
    description: '',
    prompt: 'summarize the day',
    schedule: DAILY_0800,
    tool: { type: 'local' },
    autonomous: false,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  };
}

/**
 * materializeAgentBody writes agent metadata via a `cat > <tmp> <<'MARKER' ...
 * MARKER` heredoc (writeFileCommand) bundled into one big `set -e\n...`
 * command. Extract the JSON body of THAT specific heredoc (identified by the
 * "/<agentId>.json." tmp-filename fragment — the leading "/" anchors it to
 * the metadata file itself, not e.g. plans/plan-agent-<agentId>.json, whose
 * tmp filename also happens to contain "<agentId>.json." as a substring but
 * preceded by "-", not "/") so the mock can simulate real persistence across
 * repair passes — required to prove the lastMissedNotifiedAt dedup marker
 * actually survives a disk round-trip, not just an in-memory store mutation.
 */
function extractAgentMetadataJson(command: string, agentId: string): string | null {
  const anchor = `/${agentId}.json.`;
  const lines = command.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(anchor) && lines[i]!.includes('cat >')) {
      const markerMatch = lines[i]!.match(/<<'([^']+)'/);
      if (!markerMatch) continue;
      const endIdx = lines.indexOf(markerMatch[1]!, i + 1);
      if (endIdx === -1) continue;
      return lines.slice(i + 1, endIdx).join('\n');
    }
  }
  return null;
}

function buildRunCommand(initialAgent: Agent) {
  let onDiskJson = JSON.stringify(initialAgent);
  return jest.fn(async (command: string): Promise<string> => {
    if (command.startsWith('[ -f ')) return 'HALTED_NO'; // halt-sentinel check
    if (command.startsWith('d=')) {
      // readAgentMetadataViaShell — reflect whatever was last materialized,
      // simulating a real disk round-trip across repair passes.
      return `${onDiskJson}\n${AGENT_LIST_MARKER}\n`;
    }
    if (command.startsWith('for d in') || command.includes('SHELLY_AGENT_LOG')) return ''; // readAgentRunLogs
    if (command.startsWith('cd ')) return ''; // cleanupOrphanAgentFiles
    const extracted = extractAgentMetadataJson(command, initialAgent.id);
    if (extracted != null) onDiskJson = extracted;
    return ''; // materialize write / install commands
  });
}

/** Give the fire-and-forget repair pass (setTimeout(..., 0) + async loop)
 *  a chance to run to completion. */
async function settleMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('scheduleAgentStartupRepair — missed-schedule detection (P0-1)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.setSystemTime(new Date(2026, 6, 15, 9, 0, 0, 0)); // Wed 2026-07-15 09:00
  });

  afterEach(() => {
    jest.useRealTimers();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('posts a missed-schedule notification when a daily fire is overdue with no recorded run', async () => {
    const agent = makeAgent({ lastRun: null, createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);

    await loadAgentsFromDisk(runCommand, {
      syncLogs: false,
      repairSchedules: true,
      repairDelayMs: 0,
      shouldRepair: () => true,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const call = scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.content.title).toContain('⚠');
    expect(call.content.body).toContain('Daily digest');
    expect(call.content.data).toMatchObject({ agentId: 'sched-agent' });
    expect(typeof call.content.data.missedAt).toBe('number');

    // Dedup bookkeeping landed on the store so a later pass for the SAME
    // missed window does not re-notify.
    const stored = useAgentStore.getState().agents.find((a) => a.id === 'sched-agent');
    expect(stored?.lastMissedNotifiedAt).toBe(call.content.data.missedAt);
  });

  it('does not notify when the agent already ran at/after the expected fire', async () => {
    // lastRun at today 08:00 exactly satisfies the expected fire — not missed.
    const lastRun = new Date(2026, 6, 15, 8, 0, 0, 0).getTime();
    const agent = makeAgent({ lastRun, createdAt: lastRun - 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);

    await loadAgentsFromDisk(runCommand, {
      syncLogs: false,
      repairSchedules: true,
      repairDelayMs: 0,
      shouldRepair: () => true,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('does not re-notify the same missed window on a second repair pass (dedup)', async () => {
    const agent = makeAgent({ lastRun: null, createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);

    const repairOnce = () =>
      loadAgentsFromDisk(runCommand, {
        syncLogs: false,
        repairSchedules: true,
        repairDelayMs: 0,
        shouldRepair: () => true,
      });

    await repairOnce();
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    // Re-open the app (second loadAgentsFromDisk pass) before the agent has
    // successfully fired again — same missed window, must not re-notify.
    await repairOnce();
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a disabled agent even if its schedule is overdue', async () => {
    const agent = makeAgent({ enabled: false, lastRun: null, createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);

    await loadAgentsFromDisk(runCommand, {
      syncLogs: false,
      repairSchedules: true,
      repairDelayMs: 0,
      shouldRepair: () => true,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('does not claim a successful re-arm when the repair-pass materialize call itself fails', async () => {
    // Regression test for a reviewed-and-fixed bug: notifyMissedSchedule used to
    // fire (claiming "re-armed for the next occurrence") BEFORE the materializeAgent
    // re-arm attempt in this same pass had resolved, so a failed re-arm still told
    // the user repair succeeded. The write for the agent's own metadata file is the
    // last step of materializeAgent — throwing there simulates that failure.
    const agent = makeAgent({ lastRun: null, createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const okRunCommand = buildRunCommand(agent);
    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (extractAgentMetadataJson(command, agent.id) != null) {
        throw new Error('simulated disk write failure during re-arm');
      }
      return okRunCommand(command);
    });

    await loadAgentsFromDisk(runCommand, {
      syncLogs: false,
      repairSchedules: true,
      repairDelayMs: 0,
      shouldRepair: () => true,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const call = scheduleNotificationAsync.mock.calls[0]![0];
    expect(call.content.data).toMatchObject({ agentId: 'sched-agent', repaired: false });
    expect(call.content.body).not.toMatch(/re-armed|次回の予定は再設定済み/i);
  });
});
