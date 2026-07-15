/**
 * lib/agent-schedule-readiness.ts
 *
 * P1 scheduling-reliability audit (2026-07-15) — pure gating logic for the
 * one-time AgentScheduleReadinessCard nudge appended after a device's first
 * scheduled (real cron, not notification-trigger-only) agent registration.
 * Extracted from hooks/use-ai-pane-dispatch.ts's confirmAgentDraft so the
 * dedup rule itself is unit-testable without the surrounding streaming/store
 * machinery.
 *
 * This gate is append-time only, never a registration gate: by the time it
 * is consulted, createAgent + installAgent have already succeeded.
 */

/**
 * true iff a schedule-readiness nudge should be appended for this
 * registration:
 *  - the confirmed draft has an actual cron schedule (a pure
 *    notification-trigger agent has `schedule === null` and never touches
 *    AlarmManager, so it's excluded — there's nothing exact-alarm-related to
 *    warn about), AND
 *  - the device hasn't already seen the nudge once (device-scoped, not
 *    per-agent, via AppSettings.scheduleReadinessNudgeShown).
 */
export function shouldShowScheduleReadinessNudge(
  cronSchedule: string | null | undefined,
  nudgeAlreadyShown: boolean,
): boolean {
  return !!cronSchedule && !nudgeAlreadyShown;
}
