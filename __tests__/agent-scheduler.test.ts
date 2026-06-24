jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import { parseDowList, cronToIntervalMs, nextTriggerMs } from '@/lib/agent-scheduler';

describe('parseDowList — cron day-of-week field', () => {
  it('parses a single day, a list, and normalizes Sunday (0 or 7)', () => {
    expect(parseDowList('1')).toEqual([1]);
    expect(parseDowList('1,5')).toEqual([1, 5]); // Mon & Fri
    expect(parseDowList('5,1')).toEqual([1, 5]); // sorted
    expect(parseDowList('1,1,5')).toEqual([1, 5]); // de-duped
    expect(parseDowList('0')).toEqual([0]); // Sunday
    expect(parseDowList('7')).toEqual([0]); // cron 7 = Sunday too
  });

  it('rejects wildcards / ranges / junk (unsupported → null)', () => {
    expect(parseDowList('*')).toBeNull();
    expect(parseDowList('1-5')).toBeNull();
    expect(parseDowList('mon')).toBeNull();
    expect(parseDowList('')).toBeNull();
  });
});

describe('cronToIntervalMs — multi-day schedules are now schedulable', () => {
  it('returns a non-null fallback interval for a Mon/Fri schedule (so it installs)', () => {
    // Regression: "0 8 * * 1,5" used to return null → installSchedule did nothing
    // → the agent never fired. It must now be schedulable.
    expect(cronToIntervalMs('0 8 * * 1,5')).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps the existing every-N-minutes and daily / single-day cases', () => {
    expect(cronToIntervalMs('*/5 * * * *')).toBe(5 * 60 * 1000);
    expect(cronToIntervalMs('0 8 * * *')).toBe(24 * 60 * 60 * 1000);
    expect(cronToIntervalMs('30 9 * * 3')).toBe(24 * 60 * 60 * 1000);
    expect(cronToIntervalMs('not a cron')).toBeNull();
  });
});

describe('nextTriggerMs — soonest of the listed days', () => {
  it('lands on a listed day at the requested time, in the future', () => {
    const ms = nextTriggerMs('0 8 * * 1,5'); // Mon & Fri at 08:00
    const d = new Date(ms);
    expect(ms).toBeGreaterThan(Date.now());
    expect([1, 5]).toContain(d.getDay()); // Monday or Friday
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('a single-day schedule still resolves to that weekday at the time', () => {
    const ms = nextTriggerMs('30 9 * * 3'); // Wednesday 09:30
    const d = new Date(ms);
    expect(ms).toBeGreaterThan(Date.now());
    expect(d.getDay()).toBe(3);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it('picks the nearer of the two listed days (never further than 7 days out)', () => {
    const ms = nextTriggerMs('0 8 * * 1,5');
    expect(ms - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});
