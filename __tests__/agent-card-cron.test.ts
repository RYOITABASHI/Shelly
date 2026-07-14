import { decodeCron, buildCron, resolveInitialFrequency } from '@/lib/agent-card-cron';

describe('resolveInitialFrequency — confirm-card initial selection', () => {
  it('a confident parse keeps its decoded shape', () => {
    expect(resolveInitialFrequency(true, 'custom', undefined, '1,5')).toBe('custom');
    expect(resolveInitialFrequency(true, 'daily', undefined, '')).toBe('daily');
  });

  it('a no-time recurrence honours the suggested frequency instead of falling to once', () => {
    expect(resolveInitialFrequency(false, 'daily', 'daily', undefined)).toBe('daily');
    expect(resolveInitialFrequency(false, 'daily', 'weekly', '5')).toBe('weekly');
    expect(resolveInitialFrequency(false, 'daily', 'weekly', '1,5')).toBe('custom'); // multi-day → custom
  });

  it('a truly scheduleless utterance defaults to once', () => {
    expect(resolveInitialFrequency(false, 'daily', undefined, undefined)).toBe('once');
  });
});

describe('agent confirm-card cron codec', () => {
  it('round-trips a multi-day (Mon/Fri) preset cron WITHOUT collapsing to daily', () => {
    // Regression (cross-model review): the G6 preset's "0 8 * * 1,5" used to decode
    // to daily (single-digit-only dow check) and re-encode as "0 8 * * *", silently
    // dropping Fri. It must survive as 'custom' and round-trip verbatim.
    const d = decodeCron('0 8 * * 1,5');
    expect(d.frequency).toBe('custom');
    expect(d.dowList).toBe('1,5');
    expect(d.hour).toBe(8);
    expect(d.minute).toBe(0);
    expect(buildCron('custom', d.hour, d.minute, d.weekday, d.interval, d.dowList)).toBe('0 8 * * 1,5');
  });

  it('a custom schedule still allows a time edit while preserving the day list', () => {
    const d = decodeCron('0 8 * * 1,5');
    // user changes the hour to 9 in the card
    expect(buildCron('custom', 9, 30, d.weekday, d.interval, d.dowList)).toBe('30 9 * * 1,5');
  });

  it('decodes the simple shapes as before', () => {
    expect(decodeCron('0 8 * * *').frequency).toBe('daily');
    expect(decodeCron('0 9 * * 1').frequency).toBe('weekly');
    expect(decodeCron('*/15 * * * *').frequency).toBe('interval');
    expect(decodeCron(null).frequency).toBe('daily'); // fallback
  });

  it('decodes the "once" sentinel (a confidently-parsed run-immediately request) as frequency "once", not the null fallback', () => {
    // parseSchedule() emits schedule:'once' for "すぐに"/"今すぐ"/etc — a
    // deliberately non-cron sentinel (see lib/agent-nl-parser.ts) that must
    // decode differently from a genuinely unparsed null, or scheduleConfident:
    // true would seed the card with the wrong (daily) frequency.
    expect(decodeCron('once').frequency).toBe('once');
    expect(buildCron('once', 8, 0, 1, 15, '')).toBeNull();
  });

  it('decodes the "every N hours" shape ("0 */N * * *") — the inverse of the minute-interval shape', () => {
    const d = decodeCron('0 */3 * * *');
    expect(d.frequency).toBe('hourly');
    expect(d.interval).toBe(3);
    expect(decodeCron('0 */1 * * *').interval).toBe(1);
    // Regression: before this fix, "0 */3 * * *" had no matching branch and fell
    // through to the FALLBACK's frequency, silently mis-decoding as 'daily'.
    expect(decodeCron('0 */3 * * *').frequency).not.toBe('daily');
  });

  it('builds the simple shapes and rejects invalid input', () => {
    expect(buildCron('daily', 8, 0, 1, 15, '')).toBe('0 8 * * *');
    expect(buildCron('weekly', 9, 0, 5, 15, '')).toBe('0 9 * * 5');
    expect(buildCron('interval', 0, 0, 0, 15, '')).toBe('*/15 * * * *');
    expect(buildCron('once', 8, 0, 1, 15, '')).toBeNull();
    expect(buildCron('custom', 8, 0, 1, 15, 'bad')).toBeNull();
    expect(buildCron('interval', 0, 0, 0, 99, '')).toBeNull(); // interval out of range
  });

  it('builds and round-trips the "every N hours" shape, enforcing the 1..23 range', () => {
    expect(buildCron('hourly', 0, 0, 0, 3, '')).toBe('0 */3 * * *'); // round-trip
    expect(buildCron('hourly', 0, 0, 0, 0, '')).toBeNull(); // 0 rejected — below range
    expect(buildCron('hourly', 0, 0, 0, 24, '')).toBeNull(); // 24 rejected — above range (max 23)
    expect(buildCron('hourly', 0, 0, 0, 23, '')).toBe('0 */23 * * *'); // boundary, valid
  });

  it('rejects an out-of-range custom DOW list', () => {
    expect(buildCron('custom', 8, 0, 1, 15, '1,5')).toBe('0 8 * * 1,5');
    expect(buildCron('custom', 8, 0, 1, 15, '1,9')).toBeNull(); // 9 is not 0..6
    expect(buildCron('custom', 8, 0, 1, 15, '7')).toBeNull(); // 7 not allowed here (card uses 0..6)
  });
});

describe('agent confirm-card cron codec — "daily-multi" (multiple times per day)', () => {
  it('decodes a shared-minute multi-hour cron ("0 8,21 * * *") as daily-multi', () => {
    const d = decodeCron('0 8,21 * * *');
    expect(d.frequency).toBe('daily-multi');
    expect(d.minute).toBe(0);
    expect(d.hour).toBe(8); // first listed hour
    expect(d.hourList).toBe('8,21');
  });

  it('a plain single-hour daily cron is unaffected by the new daily-multi branch', () => {
    const d = decodeCron('0 8 * * *');
    expect(d.frequency).toBe('daily');
    expect(d.hourList).toBe('');
  });

  it('builds a valid multi-hour cron from a shared minute + hour list', () => {
    expect(buildCron('daily-multi', 0, 0, 1, 15, '', '8,21')).toBe('0 8,21 * * *');
  });

  it('rejects the WHOLE hour list when any single hour is out of range (no partial accept)', () => {
    expect(buildCron('daily-multi', 0, 0, 1, 15, '', '25,8')).toBeNull();
  });

  it('rejects fewer than 2 distinct hours — that is not actually "multi"', () => {
    expect(buildCron('daily-multi', 0, 0, 1, 15, '', '8')).toBeNull();
  });

  it('rejects more than 4 hours (the daily cap)', () => {
    expect(buildCron('daily-multi', 0, 0, 1, 15, '', '8,9,10,11,12')).toBeNull();
  });

  it('dedups BEFORE the count check, so a duplicate does not wrongly count toward the cap', () => {
    expect(buildCron('daily-multi', 0, 0, 1, 15, '', '8,8,21')).toBe('0 8,21 * * *');
  });

  it('an invalid minute still rejects even when the hour list is otherwise valid', () => {
    // NOTE: buildCron's signature is (f, hour, minute, weekday, interval, customDow,
    // hourList) — the `hour` param is unused for 'daily-multi' (only `minute` and
    // `hourList` are checked), so the invalid value must be in the minute slot.
    expect(buildCron('daily-multi', 0, 65, 1, 15, '', '8,21')).toBeNull();
  });
});
