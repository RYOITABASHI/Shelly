/**
 * lib/agent-card-cron.ts — pure cron <-> selector-state codec for the agent
 * confirm card. Extracted from AgentConfirmCard so the round-trip (especially the
 * multi-day "custom" case, e.g. Mon/Fri = "1,5") is unit-testable without RN.
 *
 * Only the whitelisted shapes the scheduler accepts are produced: an interval
 * ("every N minutes"), daily ("M H * * *"), weekly single-day ("M H * * D"), and
 * a custom multi-day list ("M H * * D,D,...") — the simple weekday selector can't
 * hold the list, so it is round-tripped verbatim (e.g. Mon/Fri = "1,5"). Also
 * supports multiple specific times per day ("M H,H,... * * *", 'daily-multi'),
 * e.g. "0 8,21 * * *" = 8am and 9pm daily. NOTE: 'daily-multi' combined with a
 * multi-weekday ('custom') list is NOT supported (out of scope, not a bug).
 */
export type Frequency = 'once' | 'daily' | 'weekly' | 'interval' | 'hourly' | 'custom' | 'daily-multi';

/** Cron dow (0=Sun..6=Sat) → display char. Deliberately JP kanji regardless of
 *  locale — pre-existing convention inherited from AgentConfirmCard (the weekday
 *  chips/summary always show 日月火水木金土, even under the EN locale). Not fixed
 *  here; extracted verbatim so scheduleHuman below and the card stay in lockstep. */
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

export interface DecodedCron {
  frequency: Frequency;
  hour: number;
  minute: number;
  weekday: number;
  interval: number;
  /** Raw DOW field for a multi-day ('custom') schedule, e.g. "1,5" = Mon/Fri. */
  dowList: string;
  /** Raw HOUR field for a multi-time-per-day ('daily-multi') schedule, e.g. "8,21". */
  hourList: string;
}

const FALLBACK: DecodedCron = {
  frequency: 'daily',
  hour: 8,
  minute: 0,
  weekday: 1,
  interval: 15,
  dowList: '',
  hourList: '',
};

/** Parse an existing cron (when the draft was confident) back into selector state. */
export function decodeCron(cron: string | null): DecodedCron {
  if (!cron) return { ...FALLBACK };
  // Sentinel (not a real cron): a confidently-parsed "run once, right now" request
  // (e.g. "すぐに" / "今すぐ" / "immediately") has no time/recurrence to decode —
  // schedule stays this literal string instead of null specifically so a confident
  // parse can still register as scheduleConfident:true (null pairs with :false
  // everywhere else in this codebase, which would re-trigger the schedule
  // slot-fill question forever instead of landing on the Once frequency).
  if (cron === 'once') return { ...FALLBACK, frequency: 'once' };
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
  // Multi-time-per-day (e.g. "8,21" = 8am & 9pm daily), one shared minute for
  // every listed hour. Checked before the plain single-hour shape below since a
  // comma-hour already fails that shape's /^\d+$/.test(hour) and would otherwise
  // fall through to FALLBACK.
  if (/^\d+$/.test(min) && /^\d+(,\d+)+$/.test(hour) && dow === '*') {
    return { ...FALLBACK, frequency: 'daily-multi', minute: +min, hour: +hour.split(',')[0], hourList: hour };
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
  hourList: string = '',
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
  if (f === 'daily-multi') {
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    if (!/^\d+(,\d+)*$/.test(hourList)) return null;
    const hours = hourList.split(',').map((h) => parseInt(h, 10));
    if (hours.some((h) => h < 0 || h > 23)) return null;
    const uniq = Array.from(new Set(hours)).sort((a, b) => a - b);
    if (uniq.length < 2 || uniq.length > 4) return null; // <2: not multi; >4: cap
    return `${minute} ${uniq.join(',')} * * *`;
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

/**
 * Render a decoded schedule as a human-readable phrase via the injected `t()`
 * (either the React `useTranslation()` translator or the plain module-level
 * `t` from lib/i18n — both share the same signature). Extracted verbatim from
 * AgentConfirmCard's private `scheduleHuman` so lib/agent-plan-summary.ts (the
 * chat-native confirm renderer) can produce IDENTICAL schedule phrasing to the
 * card without duplicating the cron-shape → phrase mapping.
 */
export function scheduleHuman(
  f: Frequency,
  hour: number,
  minute: number,
  weekday: number,
  interval: number,
  t: (k: string, p?: Record<string, string | number>) => string,
  customDow = '',
  dailyMultiHours: number[] = [],
): string {
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (f === 'interval') return t('agentcard.sched_interval', { n: interval });
  if (f === 'hourly') return t('agentcard.sched_hourly', { n: interval });
  if (f === 'daily-multi') {
    const hours = dailyMultiHours.length > 0 ? dailyMultiHours : [hour];
    const times = hours.map((h) => `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join('・');
    return t('agentcard.sched_daily_multi', { times });
  }
  if (f === 'custom') {
    const days = customDow.split(',').map((d) => WEEKDAY_LABELS[+d] ?? d).join('・');
    return t('agentcard.sched_weekly', { day: days, time: hhmm });
  }
  if (f === 'weekly') return t('agentcard.sched_weekly', { day: WEEKDAY_LABELS[weekday], time: hhmm });
  return t('agentcard.sched_daily', { time: hhmm });
}

/**
 * Compute the next fire Date for a decoded cron — used by
 * lib/agent-plan-summary.ts's summarizeAgentDraftAsText to show a concrete
 * "next run: …" line when a schedule was Propose-and-Echo DEFAULTED from a
 * bare time-of-day word (ParsedAgentDraft.scheduleAssumed — see
 * lib/agent-nl-parser.ts's TIME_OF_DAY_DEFAULTS), so the assumption is never
 * left abstract. `now` is injectable for deterministic unit tests.
 *
 * Handles every shape decodeCron produces: 'daily' / 'weekly' / 'custom'
 * (multi-day) / 'daily-multi' (multiple times/day, one shared minute).
 * 'once' has no next fire (returns null). 'interval'/'hourly' are not
 * surfaced by scheduleAssumed (TIME_OF_DAY_DEFAULTS only ever produces a
 * daily/weekly cron) and are intentionally left unimplemented here (returns
 * null) rather than guessed at.
 */
export function nextFireDate(decoded: DecodedCron, now: Date = new Date()): Date | null {
  if (decoded.frequency === 'once' || decoded.frequency === 'interval' || decoded.frequency === 'hourly') {
    return null;
  }

  const candidateHours =
    decoded.frequency === 'daily-multi' && decoded.hourList
      ? decoded.hourList
          .split(',')
          .map((h) => parseInt(h, 10))
          .filter((n) => !Number.isNaN(n))
          .sort((a, b) => a - b)
      : [decoded.hour];

  const dows =
    decoded.frequency === 'weekly' || decoded.frequency === 'custom'
      ? (decoded.dowList ? decoded.dowList.split(',').map((d) => parseInt(d, 10)) : [decoded.weekday])
      : null; // null = every day (daily / daily-multi)

  // Scan forward up to 7 days (guarantees hitting every possible weekday at
  // least once) and, within each day, every candidate hour in order.
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    if (dows && !dows.includes(day.getDay())) continue;
    for (const h of candidateHours) {
      const candidate = new Date(day);
      candidate.setHours(h, decoded.minute, 0, 0);
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }
  return null; // unreachable for a valid decoded cron within a 7-day scan
}
