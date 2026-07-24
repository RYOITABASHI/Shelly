/**
 * lib/agent-scheduler.ts — Manages scheduled execution.
 * Primary: AlarmManager (via native module).
 * Fallback: crond.
 */
import { Agent } from '@/store/types';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

// A day-of-week field of a single day OR a comma list (e.g. "1,5" = Mon & Fri).
const DOW_LIST_RE = /^\d+(,\d+)*$/;

/** Parse a cron day-of-week field into sorted, de-duped 0–6 (cron 0 or 7 = Sun).
 *  Rejects out-of-range values (only 0..7 are valid) so a malformed stored cron
 *  like "1,9" is not silently normalised (9 % 7 = 2) into the wrong day. */
export function parseDowList(dow: string): number[] | null {
  if (!DOW_LIST_RE.test(dow)) return null;
  const nums = dow.split(',').map((d) => parseInt(d, 10));
  if (nums.some((n) => n > 7)) return null; // 0 and 7 both = Sunday; >7 is invalid
  const days = nums.map((n) => n % 7);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

// An hour field of a single hour OR a comma list (e.g. "8,21" = 8am & 9pm), used
// by the 'daily-multi' multiple-times-per-day schedule.
const HOUR_LIST_RE = /^\d+(,\d+)*$/;

/** Parse a cron hour field into sorted, de-duped 0–23. Rejects out-of-range
 *  values (whole list is rejected, not silently dropped — mirrors parseDowList).
 *  Unlike DOW, hour has no 0/24 wraparound alias, so no modulo normalisation. */
export function parseHourList(hour: string): number[] | null {
  if (!HOUR_LIST_RE.test(hour)) return null;
  const nums = hour.split(',').map((h) => parseInt(h, 10));
  if (nums.some((n) => n < 0 || n > 23)) return null;
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

export function cronToIntervalMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, mon, dow] = parts;

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(everyMinMatch[1], 10);
    return n >= 1 ? n * 60 * 1000 : null; // reject "*/0" (would be a 0ms interval)
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyHourMatch && min === '0' && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(everyHourMatch[1], 10);
    return n >= 1 ? n * 60 * 60 * 1000 : null; // reject "*/0" (would be a 0ms interval)
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return 24 * 60 * 60 * 1000;
  }

  // Single day OR a multi-day list (e.g. "1,5" = Mon/Fri). intervalMs is only a
  // fallback — the native receiver re-arms from the cron string after each fire
  // (AgentAlarmReceiver.nextTriggerAt), so a daily net is safe and never skips a
  // listed day even if a later parse fails. parseDowList rejects out-of-range dow.
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && parseDowList(dow)) {
    return 24 * 60 * 60 * 1000;
  }

  // Multiple specific times per day (e.g. "8,21" = 8am & 9pm, 'daily-multi').
  // Same 24h-net reasoning as above: the native receiver re-arms precisely.
  const hourList = /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*'
    ? parseHourList(hour)
    : null;
  if (hourList && hourList.length >= 2) {
    return 24 * 60 * 60 * 1000;
  }

  return null;
}

/**
 * `notBefore` (Agent.startNotBefore, epoch ms) implements deferred-start
 * scheduling ("来週あたりから" / "starting next week") by simply moving the
 * computation's ANCHOR forward — every branch below already computes "the
 * soonest matching time at or after `now`", so anchoring `now`/`target` to
 * the later of (actual now, notBefore) makes the exact same logic return the
 * first occurrence on/after the requested start. A past/absent notBefore is
 * a no-op (anchor stays the real current time) — no separate gating concept,
 * no explicit clearing once the date passes.
 */
export function nextTriggerMs(cron: string, notBefore?: number | null): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return Date.now() + 60000;

  const [min, hour, dom, mon, dow] = parts;
  const anchorMs = notBefore && notBefore > Date.now() ? notBefore : Date.now();
  const now = new Date(anchorMs);
  const target = new Date(anchorMs);

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') {
    const intervalMin = parseInt(everyMinMatch[1], 10);
    if (intervalMin > 0) {
      const nextMinute = Math.ceil((now.getMinutes() + 1) / intervalMin) * intervalMin;
      target.setSeconds(0);
      target.setMilliseconds(0);
      if (nextMinute >= 60) {
        target.setHours(target.getHours() + 1);
        target.setMinutes(nextMinute % 60);
      } else {
        target.setMinutes(nextMinute);
      }
      return target.getTime();
    }
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyHourMatch && min === '0') {
    const intervalHour = parseInt(everyHourMatch[1], 10);
    if (intervalHour > 0) {
      target.setMinutes(0);
      target.setSeconds(0);
      target.setMilliseconds(0);
      // Cron "*/N" for the hour field resets at midnight each day rather than
      // counting continuously — valid hours are {0, N, 2N, ...} clamped to
      // 0-23, so for N that doesn't divide 24 evenly (e.g. 23, 5, 7) the
      // sequence does NOT wrap via simple modulo (that would land on the
      // wrong hour, e.g. 46 % 24 = 22 instead of the correct 0). Enumerate
      // today's remaining valid hours and fall through to hour 0 tomorrow.
      let nextHour = -1;
      for (let h = 0; h < 24; h += intervalHour) {
        if (h > now.getHours()) {
          nextHour = h;
          break;
        }
      }
      if (nextHour === -1) {
        target.setDate(target.getDate() + 1);
        target.setHours(0);
      } else {
        target.setHours(nextHour);
      }
      return target.getTime();
    }
  }

  if (/^\d+$/.test(min)) target.setMinutes(parseInt(min));
  if (/^\d+$/.test(hour)) target.setHours(parseInt(hour));
  target.setSeconds(0);
  target.setMilliseconds(0);

  // Single day OR a multi-day list (e.g. "1,5" = Mon/Fri): pick the SOONEST of
  // the listed days at the given hour/minute.
  const dowList = (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*')
    ? parseDowList(dow)
    : null;
  if (dowList && dowList.length) {
    let best = Infinity;
    for (const day of dowList) {
      const candidate = new Date(target);
      let daysUntil = (day - candidate.getDay() + 7) % 7;
      if (daysUntil === 0 && candidate.getTime() <= now.getTime()) {
        daysUntil = 7;
      }
      candidate.setDate(candidate.getDate() + daysUntil);
      best = Math.min(best, candidate.getTime());
    }
    return best;
  }

  // Multiple specific times per day (e.g. "8,21" = 8am & 9pm, 'daily-multi'):
  // pick the SOONEST of the listed hours (shared minute) — today if still
  // ahead, else tomorrow. Must return early: the generic /^\d+$/.test(hour)
  // check above silently no-ops on a comma-hour string, so target would
  // otherwise be left at "now"'s hour and fall through to a garbage trigger.
  const hourListNext = /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*'
    ? parseHourList(hour)
    : null;
  if (hourListNext && hourListNext.length >= 2) {
    const m = parseInt(min, 10);
    let best = Infinity;
    for (const h of hourListNext) {
      const candidate = new Date(now);
      candidate.setHours(h, m, 0, 0);
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      best = Math.min(best, candidate.getTime());
    }
    return best;
  }

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}

/** The most recent scheduled fire time at or before now, or null if not parseable.
 *  Mirrors nextTriggerMs but going BACKWARD — used to detect a missed run (a fire
 *  that was due but never produced a run log). Display/health only, not scheduling. */
export function lastTriggerMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, mon, dow] = parts;
  const now = new Date();
  const target = new Date();

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') {
    const intervalMin = parseInt(everyMinMatch[1], 10);
    if (intervalMin > 0) {
      const prevMinute = Math.floor(now.getMinutes() / intervalMin) * intervalMin;
      target.setSeconds(0);
      target.setMilliseconds(0);
      target.setMinutes(prevMinute);
      if (target.getTime() > now.getTime()) target.setMinutes(prevMinute - intervalMin);
      return target.getTime();
    }
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyHourMatch && min === '0') {
    const intervalHour = parseInt(everyHourMatch[1], 10);
    if (intervalHour > 0) {
      const prevHour = Math.floor(now.getHours() / intervalHour) * intervalHour;
      target.setMinutes(0);
      target.setSeconds(0);
      target.setMilliseconds(0);
      target.setHours(prevHour);
      if (target.getTime() > now.getTime()) target.setHours(prevHour - intervalHour);
      return target.getTime();
    }
  }

  if (/^\d+$/.test(min)) target.setMinutes(parseInt(min));
  if (/^\d+$/.test(hour)) target.setHours(parseInt(hour));
  target.setSeconds(0);
  target.setMilliseconds(0);

  const dowList = (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*')
    ? parseDowList(dow)
    : null;
  if (dowList && dowList.length) {
    let best = -Infinity;
    for (const day of dowList) {
      const candidate = new Date(target);
      let daysSince = (candidate.getDay() - day + 7) % 7;
      if (daysSince === 0 && candidate.getTime() > now.getTime()) daysSince = 7;
      candidate.setDate(candidate.getDate() - daysSince);
      best = Math.max(best, candidate.getTime());
    }
    return best === -Infinity ? null : best;
  }

  // Multiple specific times per day (e.g. "8,21" = 8am & 9pm, 'daily-multi'):
  // mirror nextTriggerMs backward — pick the MOST RECENT of the listed hours
  // (shared minute) that is at or before now. Early return for the same
  // reason as nextTriggerMs: a comma-hour string silently no-ops the generic
  // /^\d+$/.test(hour) check above.
  const hourListLast = /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*'
    ? parseHourList(hour)
    : null;
  if (hourListLast && hourListLast.length >= 2) {
    const m = parseInt(min, 10);
    let best = -Infinity;
    for (const h of hourListLast) {
      const candidate = new Date(now);
      candidate.setHours(h, m, 0, 0);
      if (candidate.getTime() > now.getTime()) {
        candidate.setDate(candidate.getDate() - 1);
      }
      best = Math.max(best, candidate.getTime());
    }
    return best === -Infinity ? null : best;
  }

  // Daily (m h * * *): today at h:m if already past, else yesterday.
  if (target.getTime() > now.getTime()) target.setDate(target.getDate() - 1);
  return target.getTime();
}

/** Grace window before a due-but-unrecorded fire counts as "missed" — generous
 *  enough to absorb a long-running previous run plus normal scheduling jitter,
 *  not just clock skew. Shared by the Sidebar agent-detail popup (passive
 *  display, existing) and the app-launch startup repair (active detection +
 *  notification, P0-1) so the two surfaces can never disagree about what counts
 *  as "missed". */
export const MISSED_RUN_GRACE_MS = 5 * 60 * 1000;

export interface MissedScheduleCheck {
  missed: boolean;
  /** The most recent past fire time the cron implies, or null if unparseable. */
  expectedAt: number | null;
}

/**
 * Detect a scheduled fire that was due but never recorded a run — the signal
 * that an AlarmManager alarm was silently dropped (Doze / OEM battery
 * management / a foreground-service start failure) with no independent repair.
 * Pass the agent's most recently known COMPLETED-run timestamp as `lastRunAt`
 * (Agent.lastRun), falling back to `createdAt` for an agent that has never run.
 * Pure function of its inputs — always recomputes from the cron string rather
 * than trusting any persisted "next expected" field, so a stale/missing
 * bookkeeping field can never mask (or fabricate) a missed-run signal.
 *
 * `notBefore` (Agent.startNotBefore): a deferred-start agent that simply
 * hasn't reached its start date yet must NEVER be flagged missed — without
 * this guard, lastTriggerMs (which knows nothing about notBefore) would
 * report the most recent PAST cron occurrence as "expected", which for a
 * freshly-created future-start agent is always before `lastActual`
 * (createdAt), producing a false "schedule missed" notification days before
 * the agent was ever meant to fire.
 */
export function isScheduleMissed(
  schedule: string,
  lastRunAt: number | null,
  createdAt: number,
  now: number = Date.now(),
  graceMs: number = MISSED_RUN_GRACE_MS,
  notBefore?: number | null
): MissedScheduleCheck {
  if (notBefore && now < notBefore) return { missed: false, expectedAt: null };
  const expectedAt = lastTriggerMs(schedule);
  const lastActual = lastRunAt ?? createdAt;
  const missed = expectedAt != null && expectedAt < now - graceMs && expectedAt > lastActual + graceMs;
  return { missed, expectedAt };
}

export async function installSchedule(agent: Agent): Promise<void> {
  if (!agent.schedule) return;

  const intervalMs = cronToIntervalMs(agent.schedule);

  if (intervalMs !== null) {
    const triggerAt = nextTriggerMs(agent.schedule, agent.startNotBefore);
    await TerminalEmulator.scheduleAgent(agent.id, intervalMs, triggerAt, agent.schedule);
  }
}

export async function uninstallSchedule(agentId: string): Promise<void> {
  await TerminalEmulator.cancelAgent(agentId);
}
