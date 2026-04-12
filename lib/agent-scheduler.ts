/**
 * lib/agent-scheduler.ts — Manages scheduled execution.
 * Primary: AlarmManager (via native module).
 * Fallback: crond.
 */
import { Agent } from '@/store/types';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

function cronToIntervalMs(cron: string): number | null {
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

  return null;
}

function nextTriggerMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return Date.now() + 60000;

  const [min, hour] = parts;
  const now = new Date();
  const target = new Date();

  if (/^\d+$/.test(min)) target.setMinutes(parseInt(min));
  if (/^\d+$/.test(hour)) target.setHours(parseInt(hour));
  target.setSeconds(0);
  target.setMilliseconds(0);

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
    await TerminalEmulator.scheduleAgent(agent.id, intervalMs, triggerAt);
  }
}

export async function uninstallSchedule(agentId: string): Promise<void> {
  await TerminalEmulator.cancelAgent(agentId);
}
