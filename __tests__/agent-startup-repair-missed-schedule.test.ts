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
    reconcileAgentSchedules: jest.fn(async () => true),
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
const terminalEmulator = jest.requireMock('@/modules/terminal-emulator/src/TerminalEmulatorModule').default as {
  scheduleAgent: jest.Mock;
  cancelAgent: jest.Mock;
  reconcileAgentSchedules?: jest.Mock;
};

const AGENT_LIST_MARKER = '---SEPARATOR---';

/** A daily 06:00 cron that (relative to a fixed "now" of 09:00) last fired at
 *  today 06:00 — past the 5-minute missed-run grace AND past the 2-hour
 *  catch-up window (lib/agent-schedule-reconcile.ts), so it is a real miss:
 *  notify + re-arm forward. An occurrence still inside the window is handed
 *  to native reconcile instead (see the catch-up describe below). */
const DAILY_0600 = '0 6 * * *';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'sched-agent',
    name: 'Daily digest',
    description: '',
    prompt: 'summarize the day',
    schedule: DAILY_0600,
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
    // lastRun at today 06:00 exactly satisfies the expected fire — not missed.
    const lastRun = new Date(2026, 6, 15, 6, 0, 0, 0).getTime();
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
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
  });

  it('does not re-arm an agent paused during the startup-repair delay', async () => {
    const agent = makeAgent({ lastRun: Date.now(), createdAt: Date.now() - 24 * 60 * 60 * 1000 });
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);

    await loadAgentsFromDisk(runCommand, {
      syncLogs: false,
      repairSchedules: true,
      repairDelayMs: 1_000,
      shouldRepair: () => true,
    });
    useAgentStore.getState().updateAgent(agent.id, { enabled: false });
    await jest.advanceTimersByTimeAsync(2_000);
    await settleMicrotasks();

    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(terminalEmulator.cancelAgent).toHaveBeenCalledWith(agent.id);
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

describe('scheduleAgentStartupRepair — one-shot schedules (lib/agent-oneshot.ts)', () => {
  const NOW = new Date(2026, 6, 15, 9, 0, 0, 0).getTime();
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  async function repair(agent: Agent) {
    useAgentStore.getState().setAgents([agent]);
    const runCommand = buildRunCommand(agent);
    await loadAgentsFromDisk(runCommand, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => true });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    return runCommand;
  }

  it('a future one-shot is (re-)armed at its instant with no interval', async () => {
    const schedule = `@once ${NOW + 30 * 60_000}`;
    await repair(makeAgent({ schedule, createdAt: NOW - 60_000 }));
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledWith('sched-agent', 0, NOW + 30 * 60_000, schedule);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a one-shot past the grace window with no run is retired as missed (one notification, never fired late)', async () => {
    const due = NOW - 60 * 60_000;
    const runCommand = await repair(makeAgent({ schedule: `@once ${due}`, createdAt: due - 5 * 60_000 }));
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    const stored = useAgentStore.getState().agents.find((a) => a.id === 'sched-agent');
    expect(stored).toMatchObject({ enabled: false, oneShotStatus: 'missed' });
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync.mock.calls[0]![0].content.data).toMatchObject({ agentId: 'sched-agent', missedAt: due });
    const persisted = runCommand.mock.calls.map((c) => c[0] as string).find((c) => c.includes('"oneShotStatus": "missed"'));
    expect(persisted).toBeDefined();
  });

  it('a one-shot that already ran is retired as done (no re-arm, no notification)', async () => {
    const due = NOW - 60 * 60_000;
    await repair(makeAgent({ schedule: `@once ${due}`, lastRun: due + 3000, createdAt: due - 5 * 60_000 }));
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(useAgentStore.getState().agents.find((a) => a.id === 'sched-agent')).toMatchObject({ enabled: false, oneShotStatus: 'done' });
  });

  it('a one-shot just inside the grace window gets a catch-up fire', async () => {
    const due = NOW - 3 * 60_000;
    await repair(makeAgent({ schedule: `@once ${due}`, createdAt: due - 5 * 60_000 }));
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledWith('sched-agent', 0, NOW + 5000, `@once ${due}`);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('scheduleAgentStartupRepair — live run lock and catch-up hand-off (doze-scheduler fix)', () => {
  const NOW = new Date(2026, 6, 15, 9, 0, 0, 0).getTime(); // Wed 09:00
  const DAY = 24 * 60 * 60 * 1000;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  async function repair(agent: Agent, opts: { lockLive?: boolean; chainAt?: string } = {}) {
    useAgentStore.getState().setAgents([agent]);
    const base = buildRunCommand(agent);
    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (command.includes('then echo LOCK_LIVE; else echo LOCK_IDLE')) {
        const chain = opts.chainAt !== undefined ? `CHAIN_AT=${opts.chainAt}\n` : '';
        return chain + (opts.lockLive ? 'LOCK_LIVE\n' : 'LOCK_IDLE\n');
      }
      return base(command);
    });
    await loadAgentsFromDisk(runCommand, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => true });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    return runCommand;
  }

  const metadataWrites = (runCommand: jest.Mock) =>
    runCommand.mock.calls.map((c) => c[0] as string).filter((c) => extractAgentMetadataJson(c, 'sched-agent') != null);

  it('a live run lock skips the missed check AND the re-arm (no false positive while the run is in flight)', async () => {
    // 06:00 is past the window and has no run log yet — but the 06:00 run is
    // still going (its log is written at the end).
    const runCommand = await repair(makeAgent({ lastRun: null, createdAt: NOW - 3 * DAY }), { lockLive: true });
    const lockCheck = runCommand.mock.calls.map((c) => c[0] as string).find((c) => c.includes('LOCK_LIVE'));
    expect(lockCheck).toContain('/home/shelly-test/.shelly/agents/locks/sched-agent.pid');
    expect(lockCheck).toContain('sched-agent.chain.lock');
    expect(lockCheck).toContain('kill -0');
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(terminalEmulator.reconcileAgentSchedules).not.toHaveBeenCalled();
    expect(metadataWrites(runCommand)).toHaveLength(0);
  });

  it('an idle lock keeps the existing past-window behaviour (notify + re-arm forward)', async () => {
    await repair(makeAgent({ lastRun: null, createdAt: NOW - 3 * DAY }), { lockLive: false });
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.reconcileAgentSchedules).not.toHaveBeenCalled();
  });

  it('due-unrun inside the catch-up window: native reconcile instead of a forward re-arm, no notification', async () => {
    // 08:00 daily, now 09:00: 1 h late, window 2 h.
    const runCommand = await repair(makeAgent({ schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
    // The artifacts are still refreshed (no alarm), and no dedup marker is set.
    expect(metadataWrites(runCommand).length).toBeGreaterThan(0);
    expect(useAgentStore.getState().agents.find((a) => a.id === 'sched-agent')?.lastMissedNotifiedAt).toBeUndefined();
  });

  it('an occurrence still inside the grace is not re-armed forward either (a deferred alarm may still be pending)', async () => {
    // 08:57 daily, now 09:00: 3 min after the occurrence, inside the 5-min grace.
    await repair(makeAgent({ schedule: '57 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('an occurrence that already ran is re-armed forward as before (no native hand-off)', async () => {
    await repair(makeAgent({ schedule: '0 8 * * *', lastRun: NOW - 55 * 60_000, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.reconcileAgentSchedules).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('hourly cron with no run for 2 h: the latest occurrence is inside its 1 h window, so it is handed off (no forward re-arm, no notification)', async () => {
    jest.setSystemTime(new Date(2026, 6, 15, 9, 30, 0, 0).getTime());
    // Window = min(1 h interval, 2 h) = 1 h; the latest occurrence (09:00) is
    // 30 min old. The 08:00 one is older but only the latest is ever owed.
    await repair(makeAgent({ schedule: '0 */1 * * *', lastRun: NOW - 2 * 60 * 60_000, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a build without the reconcile bridge keeps the old behaviour (notify + forward re-arm)', async () => {
    const saved = terminalEmulator.reconcileAgentSchedules;
    delete terminalEmulator.reconcileAgentSchedules;
    try {
      await repair(makeAgent({ schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY }));
      expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
      expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    } finally {
      terminalEmulator.reconcileAgentSchedules = saved;
    }
  });

  it('several due agents still produce ONE native reconcile request', async () => {
    const a = makeAgent({ id: 'a1', schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY });
    const b = makeAgent({ id: 'b2', schedule: '30 7 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY });
    useAgentStore.getState().setAgents([a, b]);
    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (command.includes('then echo LOCK_LIVE; else echo LOCK_IDLE')) return 'LOCK_IDLE\n';
      if (command.startsWith('[ -f ')) return 'HALTED_NO';
      if (command.startsWith('d=')) return `${JSON.stringify(a)}\n${AGENT_LIST_MARKER}\n${JSON.stringify(b)}\n${AGENT_LIST_MARKER}\n`;
      return '';
    });
    await loadAgentsFromDisk(runCommand, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => true });
    await jest.advanceTimersByTimeAsync(1000);
    await settleMicrotasks(40);
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
  });

  // ── Codex gate F2: stale chain lock ──
  const SEC = (ms: number) => String(Math.floor(ms / 1000));

  it('a STALE chain lock (older than the acquire-side steal age) does not suppress the missed notification or the re-arm', async () => {
    const runCommand = await repair(makeAgent({ lastRun: null, createdAt: NOW - 3 * DAY }), { chainAt: SEC(NOW - 3 * 60 * 60_000) });
    const lockCheck = runCommand.mock.calls.map((c) => c[0] as string).find((c) => c.includes('LOCK_LIVE'));
    expect(lockCheck).toContain('acquired-at');
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
  });

  it('a chain lock with a missing / garbage acquired-at is stale too (as acquireChainLock treats it)', async () => {
    await repair(makeAgent({ lastRun: null, createdAt: NOW - 3 * DAY }), { chainAt: '' });
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
  });

  it('a FRESH chain lock still counts as a live run (skip)', async () => {
    const runCommand = await repair(makeAgent({ lastRun: null, createdAt: NOW - 3 * DAY }), { chainAt: SEC(NOW - 10 * 60_000) });
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    expect(metadataWrites(runCommand)).toHaveLength(0);
  });

  // ── Codex gate F4: per-agent hand-off with fallback ──
  it('bridge rejection: the agent falls back to the previous behaviour (missed notify + forward re-arm)', async () => {
    terminalEmulator.reconcileAgentSchedules!.mockRejectedValueOnce(new Error('service start refused'));
    await repair(makeAgent({ schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('bridge accepted=false: the agent falls back too', async () => {
    terminalEmulator.reconcileAgentSchedules!.mockResolvedValueOnce(false);
    await repair(makeAgent({ schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY }));
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).toHaveBeenCalledTimes(1);
  });

  function twoDueAgents() {
    const a = makeAgent({ id: 'a1', schedule: '0 8 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY });
    const b = makeAgent({ id: 'b2', schedule: '30 7 * * *', lastRun: NOW - DAY, createdAt: NOW - 3 * DAY });
    useAgentStore.getState().setAgents([a, b]);
    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (command.includes('then echo LOCK_LIVE; else echo LOCK_IDLE')) return 'LOCK_IDLE\n';
      if (command.startsWith('[ -f ')) return 'HALTED_NO';
      if (command.startsWith('d=')) return `${JSON.stringify(a)}\n${AGENT_LIST_MARKER}\n${JSON.stringify(b)}\n${AGENT_LIST_MARKER}\n`;
      return '';
    });
    return runCommand;
  }
  const armedIds = () => terminalEmulator.scheduleAgent.mock.calls.map((c) => c[0]);

  it('a failed hand-off is retried for the next deferred agent; only the agent it failed for is re-armed', async () => {
    terminalEmulator.reconcileAgentSchedules!.mockResolvedValueOnce(false);
    const runCommand = twoDueAgents();
    await loadAgentsFromDisk(runCommand, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => true });
    await jest.advanceTimersByTimeAsync(2000);
    await settleMicrotasks(60);
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(2);
    expect(armedIds()).toEqual(['a1']);
  });

  it('early exit after the first agent: that agent was already handed off (not stranded)', async () => {
    const runCommand = twoDueAgents();
    // true for the timer callback and the first iteration, false from the second.
    let calls = 0;
    await loadAgentsFromDisk(runCommand, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => ++calls <= 2 });
    await jest.advanceTimersByTimeAsync(2000);
    await settleMicrotasks(60);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(terminalEmulator.reconcileAgentSchedules).toHaveBeenCalledTimes(1);
    expect(terminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    // The second agent was never touched.
    const b2Writes = runCommand.mock.calls.map((c) => c[0] as string).filter((c) => extractAgentMetadataJson(c, 'b2') != null);
    expect(b2Writes).toHaveLength(0);
  });
});
