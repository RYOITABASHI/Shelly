/**
 * lib/agent-scheduler.ts — Manages scheduled execution.
 * Primary: AlarmManager (via native module).
 * Fallback: crond.
 */
import { Agent } from '@/store/types';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

// A day-of-week field of a single day OR a comma list (e.g. "1,5" = Mon & Fri).
const DOW_LIST_RE = /^\d+(,\d+)*$/;

/** Parse a cron day-of-week field into sorted, de-duped 0–6 (cron 0 or 7 = Sun). */
export function parseDowList(dow: string): number[] | null {
  if (!DOW_LIST_RE.test(dow)) return null;
  const days = dow.split(',').map((d) => parseInt(d, 10) % 7);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

export function cronToIntervalMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, mon, dow] = parts;

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return parseInt(everyMinMatch[1]) * 60 * 1000;
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return 24 * 60 * 60 * 1000;
  }

  // Single day OR a multi-day list (e.g. "1,5" = Mon/Fri). intervalMs is only a
  // fallback — the native receiver re-arms from the cron string after each fire
  // (AgentAlarmReceiver.nextTriggerAt), so a daily net is safe and never skips a
  // listed day even if a later parse fails.
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && DOW_LIST_RE.test(dow)) {
    return 24 * 60 * 60 * 1000;
  }

  return null;
}

export function nextTriggerMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return Date.now() + 60000;

  const [min, hour, dom, mon, dow] = parts;
  const now = new Date();
  const target = new Date();

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

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}

export async function installSchedule(agent: Agent): Promise<void> {
  if (!agent.schedule) return;

  const intervalMs = cronToIntervalMs(agent.schedule);

  if (intervalMs !== null) {
    const triggerAt = nextTriggerMs(agent.schedule);
    await TerminalEmulator.scheduleAgent(agent.id, intervalMs, triggerAt, agent.schedule);
  }
}

export async function uninstallSchedule(agentId: string): Promise<void> {
  await TerminalEmulator.cancelAgent(agentId);
}
