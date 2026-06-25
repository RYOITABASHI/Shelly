/**
 * lib/agent-card-cron.ts — pure cron <-> selector-state codec for the agent
 * confirm card. Extracted from AgentConfirmCard so the round-trip (especially the
 * multi-day "custom" case, e.g. Mon/Fri = "1,5") is unit-testable without RN.
 *
 * Only the whitelisted shapes the scheduler accepts are produced: an interval
 * ("every N minutes"), daily ("M H * * *"), weekly single-day ("M H * * D"), and
 * a custom multi-day list ("M H * * D,D,...") — the simple weekday selector can't
 * hold the list, so it is round-tripped verbatim (e.g. Mon/Fri = "1,5").
 */
export type Frequency = 'once' | 'daily' | 'weekly' | 'interval' | 'custom';

export interface DecodedCron {
  frequency: Frequency;
  hour: number;
  minute: number;
  weekday: number;
  interval: number;
  /** Raw DOW field for a multi-day ('custom') schedule, e.g. "1,5" = Mon/Fri. */
  dowList: string;
}

const FALLBACK: DecodedCron = {
  frequency: 'daily',
  hour: 8,
  minute: 0,
  weekday: 1,
  interval: 15,
  dowList: '',
};

/** Parse an existing cron (when the draft was confident) back into selector state. */
export function decodeCron(cron: string | null): DecodedCron {
  if (!cron) return { ...FALLBACK };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...FALLBACK };
  const [min, hour, , , dow] = parts;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*') {
    return { ...FALLBACK, frequency: 'interval', interval: parseInt(everyMin[1], 10) };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (/^\d+$/.test(dow)) {
      return { ...FALLBACK, frequency: 'weekly', minute: +min, hour: +hour, weekday: +dow, dowList: dow };
    }
    // Multi-day list (e.g. "1,5" = Mon/Fri): the simple weekday selector can't
    // hold it, so model it as 'custom' and round-trip the DOW list verbatim.
    if (/^\d+(,\d+)+$/.test(dow)) {
      return { ...FALLBACK, frequency: 'custom', minute: +min, hour: +hour, weekday: +dow.split(',')[0], dowList: dow };
    }
    return { ...FALLBACK, frequency: 'daily', minute: +min, hour: +hour };
  }
  return { ...FALLBACK };
}

/** Build a whitelisted cron from selector state, or null when the selection is invalid. */
export function buildCron(
  f: Frequency,
  hour: number,
  minute: number,
  weekday: number,
  interval: number,
  customDow: string,
): string | null {
  if (f === 'once') return null; // one-shot: no schedule
  if (f === 'interval') {
    if (!Number.isInteger(interval) || interval < 1 || interval > 59) return null;
    return `*/${interval} * * * *`;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (f === 'custom') {
    // Multi-day (e.g. "1,5"): preserve the DOW list, still allow time edits.
    if (!/^\d+(,\d+)*$/.test(customDow)) return null;
    return `${minute} ${hour} * * ${customDow}`;
  }
  if (f === 'weekly') {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return `${minute} ${hour} * * ${weekday}`;
  }
  return `${minute} ${hour} * * *`;
}
