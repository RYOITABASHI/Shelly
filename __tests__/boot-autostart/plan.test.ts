jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import { planBootRearm, BootScheduleRecord } from '@/lib/boot-autostart';

describe('planBootRearm', () => {
  const now = 1_000_000;

  it('re-arms a cron-scheduled agent with a future trigger', () => {
    const records: BootScheduleRecord[] = [{ agentId: 'a1', cron: '0 8 * * *', intervalMs: 0 }];
    const plan = planBootRearm(records, now);
    expect(plan).toHaveLength(1);
    expect(plan[0].agentId).toBe('a1');
    expect(plan[0].cron).toBe('0 8 * * *');
    expect(plan[0].triggerAt).toBeGreaterThan(Date.now() - 1000); // an absolute future fire
  });

  it('re-arms an interval-only agent at now + interval', () => {
    const plan = planBootRearm([{ agentId: 'a2', cron: '', intervalMs: 60_000 }], now);
    expect(plan).toEqual([{ agentId: 'a2', triggerAt: now + 60_000, cron: '', intervalMs: 60_000 }]);
  });

  it('skips a record with an invalid cron and no interval', () => {
    const plan = planBootRearm([{ agentId: 'bad', cron: 'not a cron', intervalMs: 0 }], now);
    expect(plan).toEqual([]);
  });

  it('skips records without an agentId', () => {
    expect(planBootRearm([{ agentId: '', cron: '0 8 * * *', intervalMs: 0 }], now)).toEqual([]);
  });

  it('returns an empty plan for no records', () => {
    expect(planBootRearm([], now)).toEqual([]);
  });

  it('handles a mixed batch (cron + interval + invalid)', () => {
    const plan = planBootRearm(
      [
        { agentId: 'cron', cron: '*/5 * * * *', intervalMs: 0 },
        { agentId: 'interval', cron: '', intervalMs: 30_000 },
        { agentId: 'junk', cron: 'xyz', intervalMs: 0 },
      ],
      now,
    );
    expect(plan.map((e) => e.agentId).sort()).toEqual(['cron', 'interval']);
  });
});
