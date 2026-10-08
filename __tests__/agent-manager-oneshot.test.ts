/**
 * lib/agent-manager.ts one-shot write boundary: createAgent / updateAgent
 * resolve a draft-stage one-shot ('@in' / '@at') to an absolute '@once' at
 * call (= confirm) time, a schedule change re-arms a retired one-shot, and the
 * alarm is armed exactly once with no interval.
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

import { createAgent, setAgentEnabled, updateAgent } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { encodeOnceOneShot } from '@/lib/agent-oneshot';

const NOW = new Date(2026, 9, 7, 12, 0, 0, 0).getTime();
const MIN = 60_000;

function create(schedule: string | null) {
  return createAgent({
    name: 'Briefing',
    description: 'brief',
    prompt: 'brief me',
    schedule,
    tool: { type: 'local' },
    outputPath: '~/out',
  });
}

describe('one-shot write boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockTerminalEmulator.scheduleAgent.mockClear();
    useAgentStore.getState().setAgents([]);
  });
  afterEach(() => jest.useRealTimers());

  it('createAgent resolves "in 5 minutes" against the confirm instant', () => {
    jest.setSystemTime(NOW + 2 * MIN); // confirmed 2 minutes after parsing
    const agent = create('@in 300000');
    expect(agent.schedule).toBe(encodeOnceOneShot(NOW + 7 * MIN));
  });

  it('createAgent resolves a past wall-clock time to tomorrow', () => {
    const agent = create('@at 9:30');
    expect(agent.schedule).toBe(encodeOnceOneShot(new Date(2026, 9, 8, 9, 30).getTime()));
  });

  it('createAgent leaves a recurring cron untouched', () => {
    expect(create('0 9 * * *').schedule).toBe('0 9 * * *');
  });

  it('updateAgent: re-scheduling a retired one-shot re-arms it as pending + enabled', async () => {
    const agent = create('@in 300000');
    useAgentStore.getState().updateAgent(agent.id, { enabled: false, oneShotStatus: 'done', oneShotResolvedAt: NOW });
    const updated = await updateAgent(agent.id, { schedule: '@in 600000' }, jest.fn(async () => ''));
    expect(updated?.schedule).toBe(encodeOnceOneShot(NOW + 10 * MIN));
    expect(updated?.enabled).toBe(true);
    expect(updated?.oneShotStatus).toBeNull();
    expect(mockTerminalEmulator.scheduleAgent).toHaveBeenCalledWith(agent.id, 0, NOW + 10 * MIN, encodeOnceOneShot(NOW + 10 * MIN));
  });

  it('updateAgent: a paused pending one-shot moved to a new time stays paused', async () => {
    const agent = create('@in 300000');
    useAgentStore.getState().updateAgent(agent.id, { enabled: false });
    const updated = await updateAgent(agent.id, { schedule: '@in 600000' }, jest.fn(async () => ''));
    expect(updated?.enabled).toBe(false);
  });
});

describe('H1 — a stale RN snapshot never resurrects a fired/retired one-shot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockTerminalEmulator.scheduleAgent.mockClear();
    mockTerminalEmulator.cancelAgent.mockClear();
    useAgentStore.getState().setAgents([]);
  });
  afterEach(() => jest.useRealTimers());

  /** runCommand whose `cat <agent>.json` returns `disk`; records every write. */
  function diskRunCommand(disk: Record<string, unknown>) {
    return jest.fn(async (cmd: string) => (cmd.startsWith('cat ') ? JSON.stringify(disk) : ''));
  }

  it('setAgentEnabled(true) on a one-shot native already retired keeps it disabled and never arms it', async () => {
    const schedule = encodeOnceOneShot(NOW - 2 * MIN);
    const agent = create('@in 300000');
    useAgentStore.getState().updateAgent(agent.id, { schedule, enabled: false });
    const runCommand = diskRunCommand({ id: agent.id, schedule, enabled: false, oneShotStatus: 'done', oneShotResolvedAt: NOW - MIN });
    await setAgentEnabled(agent.id, true, runCommand);
    const stored = useAgentStore.getState().agents.find((a) => a.id === agent.id);
    expect(stored).toMatchObject({ enabled: false, oneShotStatus: 'done' });
    expect(mockTerminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    const write = runCommand.mock.calls.map((c) => c[0] as string).find((c) => c.includes('"oneShotStatus"'));
    expect(write).toContain('"enabled": false');
  });

  it('a re-materialize (rename / startup repair) of a stale enabled snapshot adopts the disk start marker: no catch-up, marker preserved', async () => {
    const schedule = encodeOnceOneShot(NOW - 2 * MIN);
    const agent = create('@in 300000');
    useAgentStore.getState().updateAgent(agent.id, { schedule });
    const runCommand = diskRunCommand({ id: agent.id, schedule, enabled: true, oneShotFiredAt: NOW - 2 * MIN });
    await updateAgent(agent.id, { name: 'Renamed' }, runCommand);
    expect(mockTerminalEmulator.scheduleAgent).not.toHaveBeenCalled();
    const metadataWrite = runCommand.mock.calls.map((c) => c[0] as string).find((c) => c.includes('"name": "Renamed"'));
    expect(metadataWrite).toContain(`"oneShotFiredAt": ${NOW - 2 * MIN}`);
  });

  it('an explicit re-schedule is NOT blocked by the old terminal state on disk', async () => {
    const old = encodeOnceOneShot(NOW - 2 * MIN);
    const agent = create('@in 300000');
    useAgentStore.getState().updateAgent(agent.id, { schedule: old, enabled: false, oneShotStatus: 'done', oneShotFiredAt: NOW - 2 * MIN });
    const runCommand = diskRunCommand({ id: agent.id, schedule: old, enabled: false, oneShotStatus: 'done' });
    const updated = await updateAgent(agent.id, { schedule: '@in 600000' }, runCommand);
    expect(updated).toMatchObject({ enabled: true, oneShotStatus: null, oneShotFiredAt: null });
    expect(mockTerminalEmulator.scheduleAgent).toHaveBeenCalledWith(agent.id, 0, NOW + 10 * MIN, encodeOnceOneShot(NOW + 10 * MIN));
  });

  it('M1 follow-through: clearing a one-shot schedule (→ null) disarms the old alarm', async () => {
    const agent = create('@in 300000');
    await updateAgent(agent.id, { schedule: null }, jest.fn(async () => ''));
    expect(mockTerminalEmulator.cancelAgent).toHaveBeenCalledWith(agent.id);
  });
});
