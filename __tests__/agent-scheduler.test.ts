jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import { parseDowList, parseHourList, cronToIntervalMs, nextTriggerMs, lastTriggerMs } from '@/lib/agent-scheduler';

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

  it('rejects out-of-range days instead of silently % 7 normalizing them', () => {
    // Regression (2nd-pass review): "1,9" used to become [1,2] (9 % 7). A bad list
    // must be rejected so it can't fire on a day the user never chose.
    expect(parseDowList('1,9')).toBeNull();
    expect(parseDowList('8')).toBeNull();
    expect(parseDowList('1,5,99')).toBeNull();
  });
});

describe('parseHourList — cron hour field for "daily-multi" (multiple times per day)', () => {
  it('parses a multi-hour list, sorted and de-duped', () => {
    expect(parseHourList('8,21')).toEqual([8, 21]);
    expect(parseHourList('21,8')).toEqual([8, 21]); // sorted
    expect(parseHourList('8,8,21')).toEqual([8, 21]); // de-duped
    expect(parseHourList('9')).toEqual([9]); // single hour still parses
  });

  it('rejects the WHOLE list on any out-of-range value (all-or-nothing, mirrors parseDowList)', () => {
    expect(parseHourList('25,8')).toBeNull();
    expect(parseHourList('24')).toBeNull(); // hours are 0..23, no wraparound alias
    expect(parseHourList('-1')).toBeNull();
  });

  it('rejects wildcards / ranges / junk', () => {
    expect(parseHourList('*')).toBeNull();
    expect(parseHourList('8-21')).toBeNull();
    expect(parseHourList('')).toBeNull();
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

  it('rejects "*/0" and an out-of-range dow list', () => {
    expect(cronToIntervalMs('*/0 * * * *')).toBeNull(); // 0ms interval is invalid
    expect(cronToIntervalMs('0 8 * * 1,9')).toBeNull(); // 9 is not a valid day
  });

  it('handles the "every N hours" shape ("0 */N * * *") — the inverse of the minute-interval shape', () => {
    expect(cronToIntervalMs('0 */3 * * *')).toBe(3 * 60 * 60 * 1000);
    expect(cronToIntervalMs('0 */0 * * *')).toBeNull(); // 0ms interval is invalid
  });

  it('handles "daily-multi" (multiple shared-minute hours per day) with the same 24h fallback net', () => {
    expect(cronToIntervalMs('0 8,21 * * *')).toBe(24 * 60 * 60 * 1000);
  });

  it('a plain single-hour daily cron is unaffected by the new daily-multi branch', () => {
    // Regression check: same value as before this feature (already asserted above,
    // repeated here to pin the daily-multi addition didn't change this case).
    expect(cronToIntervalMs('0 8 * * *')).toBe(24 * 60 * 60 * 1000);
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

  it('an out-of-range dow does not crash or fire on a wrong day (returns a future time)', () => {
    // installSchedule gates this via cronToIntervalMs (→null), so it should never
    // be installed; if nextTriggerMs is called directly it must stay safe, not NaN.
    const ms = nextTriggerMs('0 8 * * 1,9');
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(Date.now());
  });

  it('every-N-hours: lands on the next hour boundary that is a multiple of N, in the future', () => {
    const ms = nextTriggerMs('0 */3 * * *');
    const d = new Date(ms);
    expect(ms).toBeGreaterThan(Date.now());
    expect(d.getHours() % 3).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(ms - Date.now()).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
  });
});

describe('nextTriggerMs — "daily-multi" (multiple shared-minute hours per day) at fixed times', () => {
  const CRON = '0 8,21 * * *'; // 8am & 9pm daily
  const day = (h: number, m = 0) => new Date(2026, 6, 15, h, m, 0, 0); // Wed 2026-07-15

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('before both times → lands on today 08:00 (the soonest listed hour)', () => {
    jest.setSystemTime(day(7, 0));
    expect(nextTriggerMs(CRON)).toBe(day(8, 0).getTime());
  });

  it('between the two times → lands on today 21:00', () => {
    jest.setSystemTime(day(12, 0));
    expect(nextTriggerMs(CRON)).toBe(day(21, 0).getTime());
  });

  it('after both times → rolls over to tomorrow 08:00', () => {
    jest.setSystemTime(day(22, 0));
    const expected = new Date(2026, 6, 16, 8, 0, 0, 0).getTime();
    expect(nextTriggerMs(CRON)).toBe(expected);
  });
});

describe('lastTriggerMs — most recent past fire (missed-run detection)', () => {
  it('daily: returns a past time at the right hour:minute, within the last 24h', () => {
    const ms = lastTriggerMs('0 8 * * *')!;
    const d = new Date(ms);
    expect(ms).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('weekly DOW list: returns a past Mon/Fri at 08:00 within the last 7 days', () => {
    const ms = lastTriggerMs('0 8 * * 1,5')!; // Mon & Fri 08:00
    const d = new Date(ms);
    expect(ms).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(d.getHours()).toBe(8);
    expect([1, 5]).toContain(d.getDay());
  });

  it('interval: returns the most recent N-minute boundary at or before now', () => {
    const ms = lastTriggerMs('*/15 * * * *')!;
    const d = new Date(ms);
    expect(ms).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - ms).toBeLessThan(15 * 60 * 1000);
    expect(d.getMinutes() % 15).toBe(0);
  });

  it('every-N-hours: returns the most recent N-hour boundary at or before now', () => {
    const ms = lastTriggerMs('0 */3 * * *')!;
    const d = new Date(ms);
    expect(ms).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - ms).toBeLessThan(3 * 60 * 60 * 1000);
    expect(d.getHours() % 3).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('past fire is before now and the next fire is after now (coherent window)', () => {
    for (const cron of ['0 8 * * *', '0 8 * * 1,5', '*/30 * * * *', '0 */3 * * *']) {
      const last = lastTriggerMs(cron)!;
      const next = nextTriggerMs(cron);
      expect(last).toBeLessThanOrEqual(Date.now());
      expect(next).toBeGreaterThan(Date.now());
      expect(last).toBeLessThan(next);
    }
  });

  it('returns null for an unparseable cron', () => {
    expect(lastTriggerMs('not a cron')).toBeNull();
  });
});

describe('lastTriggerMs — "daily-multi" (multiple shared-minute hours per day) at fixed times', () => {
  const CRON = '0 8,21 * * *'; // 8am & 9pm daily
  const day = (h: number, m = 0) => new Date(2026, 6, 15, h, m, 0, 0); // Wed 2026-07-15

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('before both times today → most recent past fire is yesterday 21:00', () => {
    jest.setSystemTime(day(7, 0));
    const expected = new Date(2026, 6, 14, 21, 0, 0, 0).getTime();
    expect(lastTriggerMs(CRON)).toBe(expected);
  });

  it('between the two times → most recent past fire is today 08:00', () => {
    jest.setSystemTime(day(12, 0));
    expect(lastTriggerMs(CRON)).toBe(day(8, 0).getTime());
  });

  it('after both times → most recent past fire is today 21:00', () => {
    jest.setSystemTime(day(22, 0));
    expect(lastTriggerMs(CRON)).toBe(day(21, 0).getTime());
  });
});
