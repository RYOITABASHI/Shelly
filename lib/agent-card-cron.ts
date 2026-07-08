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
export type Frequency = 'once' | 'daily' | 'weekly' | 'interval' | 'hourly' | 'custom';

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
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (everyHour && min === '0') {
    return { ...FALLBACK, frequency: 'hourly', interval: parseInt(everyHour[1], 10) };
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

/**
 * Pick the confirm-card's INITIAL frequency. A confidently-parsed schedule keeps
 * its decoded shape. Otherwise, if the utterance stated a recurrence but no time
 * (suggestedFrequency), honour it — a multi-day weekly hint ("1,5") becomes
 * 'custom' — so the card doesn't fall to a one-shot 'once'. A truly scheduleless
 * utterance stays 'once'. (Pure so it's unit-testable without React Native.)
 */
export function resolveInitialFrequency(
  scheduleConfident: boolean,
  decodedFrequency: Frequency,
  suggestedFrequency: 'daily' | 'weekly' | undefined,
  suggestedDowList: string | undefined,
): Frequency {
  if (scheduleConfident) return decodedFrequency;
  if (suggestedFrequency === 'weekly') return (suggestedDowList ?? '').includes(',') ? 'custom' : 'weekly';
  if (suggestedFrequency === 'daily') return 'daily';
  return 'once';
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
  if (f === 'hourly') {
    if (!Number.isInteger(interval) || interval < 1 || interval > 23) return null;
    return `0 */${interval} * * *`;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (f === 'custom') {
    // Multi-day (e.g. "1,5"): preserve the DOW list, still allow time edits. Each
    // day must be a valid 0..6 (reject "1,9" etc. so a bad list can't be built).
    if (!/^\d+(,\d+)*$/.test(customDow)) return null;
    if (customDow.split(',').some((d) => +d < 0 || +d > 6)) return null;
    return `${minute} ${hour} * * ${customDow}`;
  }
  if (f === 'weekly') {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return `${minute} ${hour} * * ${weekday}`;
  }
  return `${minute} ${hour} * * *`;
}
