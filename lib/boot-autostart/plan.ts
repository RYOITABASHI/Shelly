// BOOT-AUTOSTART (L1) — boot re-arm planner (host-testable reference).
//
// Alarms armed via setExactAndAllowWhileIdle are CLEARED by the OS on reboot, so
// scheduled agents silently stop firing after a restart. The L1 fix is a
// RECEIVE_BOOT_COMPLETED receiver that re-arms every scheduled agent on boot.
//
// IMPORTANT: the ACTUAL re-arm runs in native Kotlin
// (AgentAlarmScheduler.rearmAllFromPersistedSchedules on BootCompletedReceiver);
// this TS module does NOT drive it. It is a host-testable REFERENCE for the same
// decision, so the logic is reviewable/verifiable offline. It mirrors the live
// PERSIST gate — a schedule only reaches the boot store after passing
// cronToIntervalMs at install (lib/agent-scheduler installSchedule), so gating on
// cronToIntervalMs here matches exactly the crons the store can contain. (The
// native nextTriggerAt regex is more lenient about out-of-range day-of-week, but
// such a cron never enters the store, so the two agree on real data.)

import { cronToIntervalMs, nextTriggerMs } from '@/lib/agent-scheduler';
import { ONE_SHOT_CATCHUP_DELAY_MS, ONE_SHOT_GRACE_MS, oneShotAtMs } from '@/lib/agent-oneshot';

export type BootOneShotDecision =
  | { action: 'arm'; triggerAt: number }
  | { action: 'catch-up'; triggerAt: number }
  | { action: 'missed' }
  | { action: 'done' };

/**
 * One-shot ('@once <epochMs>') boot decision — reference for the native
 * AgentAlarmScheduler.rearmAllFromPersistedSchedules one-shot branch:
 * future → re-arm at its instant; past but within ONE_SHOT_GRACE_MS → a
 * catch-up fire ONE_SHOT_CATCHUP_DELAY_MS out; older → missed (retired,
 * never fired late). `alreadyFired` = the native disk evidence
 * (AgentAlarmScheduler.oneShotAlreadyFired: terminal status, the pre-run
 * oneShotFiredAt marker, or a run log at/after the instant) — a reboot
 * mid-run retires it as done instead of re-firing. null = not a one-shot.
 */
export function planBootOneShot(cron: string, now: number, alreadyFired = false): BootOneShotDecision | null {
  const at = oneShotAtMs(cron);
  if (at === null) return null;
  if (alreadyFired) return { action: 'done' };
  if (at > now) return { action: 'arm', triggerAt: at };
  if (now - at <= ONE_SHOT_GRACE_MS) return { action: 'catch-up', triggerAt: now + ONE_SHOT_CATCHUP_DELAY_MS };
  return { action: 'missed' };
}

// One persisted agent schedule the native side records so a boot can re-arm it
// without RN running.
export interface BootScheduleRecord {
  agentId: string;
  // Cron string in one of the scheduler's supported shapes, or '' for interval-only.
  cron: string;
  intervalMs: number;
}

export interface BootRearmEntry {
  agentId: string;
  triggerAt: number; // epoch ms of the next fire
  cron: string;
  intervalMs: number;
}

// Compute the re-arm plan. A record is re-armed when it has a scheduler-valid
// cron (next fire from the cron) OR a positive interval (next fire = now +
// interval). Records with neither are skipped (nothing to re-arm).
// Determinism note: `now` drives ONLY the interval branch; the cron branch
// delegates to nextTriggerMs, which reads the wall clock — so cron entries'
// triggerAt is wall-clock-relative, not a function of `now`. (This mirrors the
// native path, which also computes cron fires from System.currentTimeMillis.)
export function planBootRearm(records: BootScheduleRecord[], now: number): BootRearmEntry[] {
  const plan: BootRearmEntry[] = [];
  for (const record of records) {
    if (!record.agentId) continue;
    const oneShot = planBootOneShot(record.cron, now);
    if (oneShot) {
      // A missed / already-fired one-shot is retired natively, never re-armed.
      if (oneShot.action === 'arm' || oneShot.action === 'catch-up') {
        plan.push({ agentId: record.agentId, triggerAt: oneShot.triggerAt, cron: record.cron, intervalMs: 0 });
      }
      continue;
    }
    const hasCron = record.cron ? cronToIntervalMs(record.cron) !== null : false;
    if (hasCron) {
      plan.push({
        agentId: record.agentId,
        triggerAt: nextTriggerMs(record.cron),
        cron: record.cron,
        intervalMs: record.intervalMs,
      });
    } else if (record.intervalMs > 0) {
      plan.push({
        agentId: record.agentId,
        triggerAt: now + record.intervalMs,
        cron: '',
        intervalMs: record.intervalMs,
      });
    }
    // else: neither cron nor interval → not a re-armable schedule, skip.
  }
  return plan;
}
