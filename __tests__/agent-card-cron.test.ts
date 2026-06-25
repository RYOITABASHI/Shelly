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

  it('builds the simple shapes and rejects invalid input', () => {
    expect(buildCron('daily', 8, 0, 1, 15, '')).toBe('0 8 * * *');
    expect(buildCron('weekly', 9, 0, 5, 15, '')).toBe('0 9 * * 5');
    expect(buildCron('interval', 0, 0, 0, 15, '')).toBe('*/15 * * * *');
    expect(buildCron('once', 8, 0, 1, 15, '')).toBeNull();
    expect(buildCron('custom', 8, 0, 1, 15, 'bad')).toBeNull();
    expect(buildCron('interval', 0, 0, 0, 99, '')).toBeNull(); // interval out of range
  });

  it('rejects an out-of-range custom DOW list', () => {
    expect(buildCron('custom', 8, 0, 1, 15, '1,5')).toBe('0 8 * * 1,5');
    expect(buildCron('custom', 8, 0, 1, 15, '1,9')).toBeNull(); // 9 is not 0..6
    expect(buildCron('custom', 8, 0, 1, 15, '7')).toBeNull(); // 7 not allowed here (card uses 0..6)
  });
});
