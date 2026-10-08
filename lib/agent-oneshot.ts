/**
 * lib/agent-oneshot.ts — one-shot (run exactly once at a future time) agent
 * schedules: sentinel codec, confirm-time resolution, arm/boot planning and
 * i18n labels. Pure (no RN / store imports) so every rule here is unit-testable
 * with an injected clock.
 *
 * Agent.schedule historically holds ONLY a whitelisted cron string (or null =
 * manual / ephemeral run-now). A one-shot reuses that same field with an
 * '@'-prefixed sentinel instead of adding a parallel field, for two reasons:
 *   1. `schedule === null` already means "run now and discard" across the
 *      confirm flow (lib/notification-trigger.ts's isEphemeralOneShot) — a
 *      missed `runAt` check anywhere would silently turn a timed one-shot into
 *      an immediate run. A non-null sentinel fails safe instead: every
 *      cron-only consumer (cronToIntervalMs, the native nextTriggerAt) rejects
 *      it as "not a cron", so a missed branch can never fire early or repeat.
 *   2. The native alarm path already carries `schedule` as its EXTRA_CRON
 *      extra and boot-persists it, so the absolute fire time travels to
 *      AgentAlarmScheduler / TerminalSessionService with no new extra or
 *      storage (see AgentAlarmScheduler.oneShotAtMs).
 *
 * Three shapes (never valid cron — cron fields never start with '@'):
 *   - '@in <ms>'               DRAFT-ONLY relative delay ("in 5 minutes").
 *   - '@at <H>:<MM>[ +<days>]' DRAFT-ONLY wall-clock time; no '+N' = auto
 *                              (today, or tomorrow when already past).
 *   - '@once <epochMs>'        RESOLVED absolute fire time — the only shape
 *                              ever persisted on a registered Agent.
 * Draft shapes are resolved at REGISTRATION-CONFIRM time
 * (resolveOneShotSchedule), so "in 5 minutes" counts from the user's OK, not
 * from when the sentence was parsed.
 */
import { tFor, type Locale } from './i18n';

/** A fire whose alarm was lost (reboot/Doze/app killed) may still run late
 *  when we notice within this window; past it the run is marked missed —
 *  stale runs never fire on boot / app start. */
export const ONE_SHOT_GRACE_MS = 10 * 60 * 1000;
/** Catch-up fires (inside the grace window) are armed this far in the future
 *  rather than "now" so the alarm is never in the past when it reaches
 *  AlarmManager. */
export const ONE_SHOT_CATCHUP_DELAY_MS = 5 * 1000;
/** A run log this close BEFORE the scheduled instant still counts as the
 *  one-shot's own fire (inexact-alarm fallback can deliver slightly early). */
const FIRED_EARLY_TOLERANCE_MS = 60 * 1000;
/** Upper bound of one unattended run (the native wake lock is 35 min). */
const ONE_SHOT_RUN_IN_PROGRESS_MS = 40 * 60 * 1000;

export type OneShotSpec =
  | { kind: 'in'; offsetMs: number }
  | { kind: 'at'; hour: number; minute: number; dayOffset: number | null }
  | { kind: 'once'; at: number };

export type OneShotStatus = 'pending' | 'done' | 'missed';

const IN_RE = /^@in\s+(\d+)$/;
const AT_RE = /^@at\s+(\d{1,2}):(\d{2})(?:\s+\+(\d))?$/;
const ONCE_RE = /^@once\s+(\d+)$/;

export function encodeRelativeOneShot(offsetMs: number): string {
  return `@in ${Math.max(0, Math.round(offsetMs))}`;
}

export function encodeAtOneShot(hour: number, minute: number, dayOffset: number | null): string {
  const hhmm = `${hour}:${String(minute).padStart(2, '0')}`;
  return dayOffset && dayOffset > 0 ? `@at ${hhmm} +${dayOffset}` : `@at ${hhmm}`;
}

export function encodeOnceOneShot(atMs: number): string {
  return `@once ${Math.round(atMs)}`;
}

export function parseOneShotSchedule(schedule: string | null | undefined): OneShotSpec | null {
  if (!schedule) return null;
  const s = schedule.trim();
  let m = s.match(ONCE_RE);
  if (m) return { kind: 'once', at: parseInt(m[1], 10) };
  m = s.match(IN_RE);
  if (m) return { kind: 'in', offsetMs: parseInt(m[1], 10) };
  m = s.match(AT_RE);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) return null;
    return { kind: 'at', hour, minute, dayOffset: m[3] !== undefined ? parseInt(m[3], 10) : null };
  }
  return null;
}

export function isOneShotSchedule(schedule: string | null | undefined): boolean {
  return parseOneShotSchedule(schedule) !== null;
}

/** Absolute fire time of a RESOLVED ('@once') schedule, else null. */
export function oneShotAtMs(schedule: string | null | undefined): number | null {
  const spec = parseOneShotSchedule(schedule);
  return spec?.kind === 'once' ? spec.at : null;
}

export interface ResolvedOneShot {
  at: number;
  /** true when an auto-day wall-clock time had already passed today and was
   *  moved to tomorrow — surfaced to the user in the confirmation. */
  rolledToTomorrow: boolean;
}

/** Resolve any one-shot shape to an absolute instant relative to `now`
 *  (device-local wall clock, DST-safe: day arithmetic uses setDate, never
 *  a fixed 24h in ms). */
export function resolveOneShotAt(schedule: string | null | undefined, now: number): ResolvedOneShot | null {
  const spec = parseOneShotSchedule(schedule);
  if (!spec) return null;
  if (spec.kind === 'once') return { at: spec.at, rolledToTomorrow: false };
  if (spec.kind === 'in') return { at: now + spec.offsetMs, rolledToTomorrow: false };
  const target = new Date(now);
  target.setHours(spec.hour, spec.minute, 0, 0);
  if (spec.dayOffset !== null) {
    target.setDate(target.getDate() + spec.dayOffset);
    return { at: target.getTime(), rolledToTomorrow: false };
  }
  if (target.getTime() <= now) {
    target.setDate(target.getDate() + 1);
    return { at: target.getTime(), rolledToTomorrow: true };
  }
  return { at: target.getTime(), rolledToTomorrow: false };
}

/** Convert a draft-stage one-shot ('@in' / '@at') into the persisted '@once'
 *  shape. Every other value (cron, 'once' run-now sentinel, null, an already
 *  resolved '@once') passes through untouched. Called at confirm time and,
 *  defensively, at the createAgent/updateAgent write boundary. */
export function resolveOneShotSchedule<T extends string | null | undefined>(schedule: T, now: number): T | string {
  const spec = parseOneShotSchedule(schedule);
  if (!spec || spec.kind === 'once') return schedule;
  const resolved = resolveOneShotAt(schedule, now);
  return resolved ? encodeOnceOneShot(resolved.at) : schedule;
}

/** Minimal agent shape the lifecycle helpers need (structural, so this pure
 *  module never imports store types). */
export interface OneShotAgentLike {
  schedule: string | null;
  enabled: boolean;
  lastRun: number | null;
  oneShotStatus?: 'done' | 'missed' | null;
  /** Native "fire started" marker (TerminalSessionService writes it BEFORE the
   *  run), so a kill/reboot mid-run can never re-fire it. */
  oneShotFiredAt?: number | null;
}

/** Did a run at/after the scheduled instant (minus a small early tolerance)
 *  happen? */
export function oneShotHasFired(
  at: number,
  lastRun: number | null | undefined,
  firedAt?: number | null,
): boolean {
  const min = at - FIRED_EARLY_TOLERANCE_MS;
  return (lastRun != null && lastRun >= min) || (firedAt != null && firedAt >= min);
}

/** Effective lifecycle state of a one-shot agent (null when not a one-shot).
 *  Persisted status wins; otherwise derived from the clock + run history so a
 *  stale in-memory store (native marked it done while JS slept) still reads
 *  correctly. */
export function oneShotState(agent: OneShotAgentLike, now: number): OneShotStatus | null {
  const at = oneShotAtMs(agent.schedule);
  if (at === null) return null;
  if (agent.oneShotStatus === 'done' || agent.oneShotStatus === 'missed') return agent.oneShotStatus;
  if (oneShotHasFired(at, agent.lastRun, agent.oneShotFiredAt)) return 'done';
  if (now - at > ONE_SHOT_GRACE_MS) return 'missed';
  return 'pending';
}

export type OneShotArmPlan =
  | { action: 'arm'; triggerAt: number; catchUp: boolean }
  | { action: 'done' }
  | { action: 'missed'; at: number }
  | { action: 'skip' };

/**
 * Decide what the scheduler should do with a one-shot agent right now —
 * shared by installSchedule (JS arm), startup repair, and (mirrored natively
 * in AgentAlarmScheduler.rearmAllFromPersistedSchedules) boot re-arm:
 *   - future                      → arm exactly at `at`
 *   - past, within grace, not run → arm a catch-up fire a few seconds out
 *   - already fired               → done (never re-arm)
 *   - past grace, never ran       → missed (never fire a stale run)
 */
export function planOneShotArm(agent: OneShotAgentLike, now: number): OneShotArmPlan {
  const at = oneShotAtMs(agent.schedule);
  if (at === null) return { action: 'skip' };
  if (agent.oneShotStatus === 'done') return { action: 'done' };
  if (agent.oneShotStatus === 'missed') return { action: 'missed', at };
  if (oneShotHasFired(at, agent.lastRun, agent.oneShotFiredAt)) return { action: 'done' };
  if (at > now) return { action: 'arm', triggerAt: at, catchUp: false };
  if (now - at <= ONE_SHOT_GRACE_MS) {
    return { action: 'arm', triggerAt: now + ONE_SHOT_CATCHUP_DELAY_MS, catchUp: true };
  }
  return { action: 'missed', at };
}

export interface OneShotTerminalPatch {
  enabled: false;
  oneShotStatus: 'done' | 'missed';
  oneShotResolvedAt: number;
}

/**
 * JS-side mirror of the native terminal-state write: when a one-shot has
 * already fired (a run log at/after its instant) or is past the grace window
 * without one, return the metadata patch that retires it (enabled=false + a
 * terminal status). null = still pending, not a one-shot, or already retired.
 * The native side writes the same fields on fire / boot; this catches the
 * cases where JS observes the outcome first (log sync, startup repair) or the
 * in-memory store is stale.
 */
export function reconcileOneShotAgent(agent: OneShotAgentLike, now: number): OneShotTerminalPatch | null {
  const plan = planOneShotArm(agent, now);
  if (plan.action !== 'done' && plan.action !== 'missed') return null;
  // Fired (native start marker) but no run log yet and still within a run's
  // lifetime: the run is in progress — native decides done vs missed from its
  // outcome when it returns. Retiring it here would pre-empt that.
  const at = oneShotAtMs(agent.schedule)!;
  if (
    plan.action === 'done' &&
    !agent.oneShotStatus &&
    !(agent.lastRun != null && agent.lastRun >= at - FIRED_EARLY_TOLERANCE_MS) &&
    agent.oneShotFiredAt != null &&
    now - agent.oneShotFiredAt < ONE_SHOT_RUN_IN_PROGRESS_MS
  ) {
    return null;
  }
  const status = plan.action;
  if (agent.oneShotStatus === status && !agent.enabled) return null;
  return { enabled: false, oneShotStatus: status, oneShotResolvedAt: now };
}

/** The one-shot fields of an agent JSON as last written to DISK (native may
 *  have retired / started it while the JS store slept). */
export interface OneShotDiskState {
  schedule?: string | null;
  enabled?: boolean;
  oneShotStatus?: 'done' | 'missed' | null;
  oneShotFiredAt?: number | null;
  oneShotResolvedAt?: number | null;
}

/**
 * Never let a stale in-memory snapshot resurrect a one-shot native already
 * started or retired: when the disk JSON carries the SAME one-shot schedule
 * and a terminal status or a fire marker, adopt those fields (terminal ⇒
 * enabled=false). A different schedule on disk means the in-memory value is
 * an explicit re-schedule (updateAgent cleared the bookkeeping) — keep it.
 * Returns the same object when nothing changes.
 */
export function mergeOneShotDiskState<T extends OneShotAgentLike & { oneShotResolvedAt?: number | null }>(
  agent: T,
  disk: OneShotDiskState | null | undefined,
): T {
  if (!disk || oneShotAtMs(agent.schedule) === null || disk.schedule !== agent.schedule) return agent;
  const diskTerminal = disk.oneShotStatus === 'done' || disk.oneShotStatus === 'missed' ? disk.oneShotStatus : null;
  const diskFired = typeof disk.oneShotFiredAt === 'number' ? disk.oneShotFiredAt : null;
  if (!diskTerminal && diskFired === null) return agent;
  const next: T = { ...agent };
  if (diskFired !== null && (agent.oneShotFiredAt == null || agent.oneShotFiredAt < diskFired)) {
    next.oneShotFiredAt = diskFired;
  }
  if (diskTerminal && !agent.oneShotStatus) {
    next.oneShotStatus = diskTerminal;
    next.oneShotResolvedAt = disk.oneShotResolvedAt ?? agent.oneShotResolvedAt ?? null;
  }
  if (next.oneShotStatus) next.enabled = false;
  const changed =
    next.oneShotFiredAt !== agent.oneShotFiredAt ||
    next.oneShotStatus !== agent.oneShotStatus ||
    next.enabled !== agent.enabled;
  return changed ? next : agent;
}

// ── Labels ─────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "today 14:55" / "tomorrow 08:00" / "2026-10-10 08:00" (localized). */
export function formatOneShotWhen(at: number, now: number, locale: Locale): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(today);
  dayAfter.setDate(dayAfter.getDate() + 2);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at >= today && at < tomorrow.getTime()) return tFor(locale, 'agentcard.oneshot_today', { time });
  if (at >= tomorrow.getTime() && at < dayAfter.getTime()) return tFor(locale, 'agentcard.oneshot_tomorrow', { time });
  if (at >= yesterday.getTime() && at < today) return tFor(locale, 'agentcard.oneshot_yesterday', { time });
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return tFor(locale, 'agentcard.oneshot_date', { date, time });
}

/** " (in 5 min)" / "（5分後）" — empty when the instant is not in the future. */
export function formatOneShotCountdown(at: number, now: number, locale: Locale): string {
  const diff = at - now;
  if (diff <= 0) return '';
  const totalMin = Math.round(diff / 60000);
  if (totalMin < 1) return tFor(locale, 'agentcard.oneshot_in_soon');
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const duration =
    h === 0
      ? tFor(locale, 'agentcard.oneshot_dur_min', { m })
      : m === 0
        ? tFor(locale, 'agentcard.oneshot_dur_hour', { h })
        : tFor(locale, 'agentcard.oneshot_dur_hour_min', { h, m });
  return tFor(locale, 'agentcard.oneshot_in', { duration });
}

/**
 * Human label for a one-shot schedule string (any shape), or null when the
 * schedule is not a one-shot. e.g. "Once · today 14:55 (in 5 min)" /
 * "1回 · 今日 14:55（5分後）". With `status` 'done' / 'missed' the label
 * reflects the terminal state instead of a countdown.
 */
export function formatOneShotLabel(
  schedule: string | null | undefined,
  locale: Locale,
  now: number,
  status: OneShotStatus | null = null,
): string | null {
  const resolved = resolveOneShotAt(schedule, now);
  if (!resolved) return null;
  const when = formatOneShotWhen(resolved.at, now, locale);
  if (status === 'done') return tFor(locale, 'agentcard.sched_oneshot_done', { when });
  if (status === 'missed') return tFor(locale, 'agentcard.sched_oneshot_missed', { when });
  return tFor(locale, 'agentcard.sched_oneshot', {
    when,
    countdown: formatOneShotCountdown(resolved.at, now, locale),
  });
}
