/**
 * lib/agent-schedule-reconcile.ts — the catch-up decision for ONE recurring
 * (cron, non-one-shot, non-continuous) schedule, shared by the JS startup
 * repair (lib/agent-manager.ts scheduleAgentStartupRepair) and mirrored
 * line-for-line by the native reconciler
 * (modules/terminal-emulator/.../AgentScheduleReconcileCore.kt, called from
 * AgentAlarmScheduler.reconcile). Kotlin and TS change in lockstep;
 * __tests__/agent-schedule-reconcile.test.ts holds the decision table and the
 * structural lockstep checks.
 *
 * Lockstep scope: the decision functions below (decideReconcile,
 * occurrenceClaimState, isChainLockLive, catchUpWindowMs) are equivalent for
 * every input. The occurrence parsers feeding them (JS lastTriggerMs vs
 * Kotlin AgentAlarmScheduler.lastTriggerAt) agree ONLY on the cron shapes
 * lib/agent-scheduler.ts cronToIntervalMs accepts: every-N-min
 * (`*\/N * * * *`), every-N-hour (`0 *\/N * * *`), daily and daily-multi
 * (`M H[,H] * * *`) and weekly (`M H * * D[,D]`). Other shapes (monthly
 * `0 7 1 * *`, an out-of-range day-of-week list) parse differently and are
 * outside the contract; installSchedule never arms them (it arms only what
 * cronToIntervalMs accepts), so native never reconciles them.
 *
 * Why a late run at all (docs: ~/workspace/research/doze-scheduler-diagnosis.md
 * §3): a recurring occurrence whose alarm was lost (inexact fallback refused
 * the FGS start, process death mid-run, a re-arm overwritten by startup
 * repair) used to be DROPPED. Inside a bounded window it now runs late,
 * through the same ACTION_RUN_AGENT service path, so every service gate
 * (STOP-ALL, enabled re-check, backoff, circuit breaker) still applies.
 *
 * "Due and unrun" is EXACTLY lib/agent-scheduler.ts isScheduleMissed's rule
 * (5-minute grace on both sides), so the Sidebar, the JS repair and native
 * reconcile can never disagree about which occurrence was missed.
 */

/** Mirrors lib/agent-scheduler.ts MISSED_RUN_GRACE_MS (re-declared to keep
 *  this module free of the native-module import chain; a test pins them equal). */
export const RECONCILE_GRACE_MS = 5 * 60 * 1000;
/** A late run is only allowed this long after the occurrence, at most. */
export const CATCH_UP_WINDOW_CAP_MS = 2 * 60 * 60 * 1000;
/** ...and never less than this, whatever the interval. */
export const CATCH_UP_WINDOW_FLOOR_MS = 10 * 60 * 1000;
/** Native watchdog alarm period (AgentAlarmScheduler.armReconcileWatchdog). */
export const RECONCILE_WATCHDOG_PERIOD_MS = 60 * 60 * 1000;
/** When an occurrence is still inside the grace, the next watchdog tick is
 *  pulled in to just after the grace ends (occurrence + grace + this). */
export const RECONCILE_GRACE_FOLLOW_UP_MS = 60 * 1000;
/**
 * A RESERVED occurrence claim (reconcile intends to dispatch it, or a regular
 * fire has just received it) whose run has not been marked STARTED is treated
 * as abandoned this long after it was taken. Reserve → start is a few
 * milliseconds in the same service call; only a process death or a failed
 * dispatch leaves a reservation behind. Kept well below the 10-min window
 * floor so an abandoned reservation is recoverable inside its window. A run
 * that did start but failed to persist its STARTED mark is still protected by
 * the live run lock (while running) and its run log (once finished).
 */
export const CLAIM_ABANDON_MS = 3 * 60 * 1000;
/**
 * The ONE stale-lock policy for `locks/<id>.chain.lock`: acquireChainLock
 * (lib/agent-manager.ts) steals a chain lock whose `acquired-at` (epoch
 * seconds) is at least this old, so every reader that asks "is a run live?"
 * — the JS startup repair and native reconcile (AgentAlarmScheduler
 * .isAgentRunLive) — must ignore such a lock too (isChainLockLive). 2 h is
 * comfortably above agent-orchestration.ts's HARD_TOTAL_TIMEOUT_MS (1 h).
 */
export const CHAIN_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * `acquired-at` file content → epoch seconds, exactly as acquireChainLock's
 * shell reads it: digits only, anything else (missing, empty, signed,
 * garbage) is 0, i.e. stale.
 */
export function parseChainLockAcquiredAt(raw: string | null | undefined): number {
  const t = (raw ?? '').trim();
  return /^[0-9]+$/.test(t) ? Number(t) : 0;
}

/** A chain lock is live only while acquireChainLock would still refuse to
 *  steal it: nowSec - acquiredAtSec < CHAIN_LOCK_STALE_MS / 1000. */
export function isChainLockLive(acquiredAtSec: number, nowMs: number): boolean {
  const nowSec = Math.floor(nowMs / 1000);
  const staleSec = Math.floor(CHAIN_LOCK_STALE_MS / 1000);
  return nowSec - acquiredAtSec < staleSec;
}

/**
 * Occurrence claim lifecycle (native prefs shelly_schedule_reconcile):
 *  - started: the run of this occurrence began (AgentRuntime's
 *    onExecutionStart, immediately before the executor launches) — it never
 *    runs again;
 *  - settled: a dispatch of this occurrence reached AgentRuntime and was
 *    refused there before launch (disabled, failure backoff, extraction
 *    failure, missing / stale script or plan, …). Those refusals belong to
 *    the failure / backoff / circuit-breaker machinery; re-dispatching inside
 *    the window would only be refused again — it never runs again either;
 *  - deferred: a dispatch of this occurrence reached AgentRuntime and was
 *    refused because a previous run of the agent was still active (its chain
 *    lock or run lock was held). Recoverable: a late run may be dispatched
 *    inside the window as soon as no run is live, whatever was logged since
 *    (that refusal's own log, the previous run's end). The mark stays until
 *    the occurrence starts or settles: a re-dispatch of it reads as reserved
 *    while fresh and as deferred again once abandoned;
 *  - reserved: claimed less than CLAIM_ABANDON_MS ago, no outcome yet — a
 *    dispatch is in flight; nobody else takes it;
 *  - abandoned: claimed, no outcome, older than the bound — the dispatch
 *    never reached a runtime outcome (service start refused, process death,
 *    failed dispatch): a late run may be re-dispatched inside the window, and
 *    a regular fire of it may take it over;
 *  - none: this occurrence was never claimed.
 * A claim without a timestamp (written before the lifecycle existed) is
 * treated as started (conservative: never re-run). Settled and deferred
 * marks are written together with the claim (same occurrence).
 */
export type OccurrenceClaimState = 'none' | 'reserved' | 'abandoned' | 'deferred' | 'settled' | 'started';

export function occurrenceClaimState(
  occurrenceMs: number,
  claimedForMs: number | null,
  claimedAtMs: number | null,
  startedForMs: number | null,
  settledForMs: number | null,
  deferredForMs: number | null,
  nowMs: number,
): OccurrenceClaimState {
  if (startedForMs != null && startedForMs === occurrenceMs) return 'started';
  if (settledForMs != null && settledForMs === occurrenceMs) return 'settled';
  if (claimedForMs == null || claimedForMs !== occurrenceMs) return 'none';
  if (claimedAtMs != null && Math.abs(nowMs - claimedAtMs) < CLAIM_ABANDON_MS) return 'reserved';
  if (deferredForMs != null && deferredForMs === occurrenceMs) return 'deferred';
  if (claimedAtMs == null) return 'started';
  return 'abandoned';
}

/** min(nominal interval, 2 h), floored at 10 min. A non-positive / unknown
 *  interval gets the 2 h cap. Daily / weekly → 2 h; hourly → 1 h. */
export function catchUpWindowMs(intervalMs: number | null | undefined): number {
  const nominal = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : CATCH_UP_WINDOW_CAP_MS;
  return Math.max(CATCH_UP_WINDOW_FLOOR_MS, Math.min(nominal, CATCH_UP_WINDOW_CAP_MS));
}

/** What the agent file on disk says. `unknown` = the file could not be read
 *  or parsed (transient): keep whatever is armed, decide nothing. */
export type ReconcileEnabledState = 'enabled' | 'disabled' | 'unknown';

export type ReconcileAction =
  /** STOP-ALL is on: touch nothing (STOP-ALL promises no armed alarm). */
  | 'skip-halted'
  /** The file says disabled / missing: native cancels as before. */
  | 'skip-disabled'
  /** The file could not be read: keep the schedule and boot entry as they are. */
  | 'skip-unknown'
  /** A run of this agent holds its lock: no missed check, no re-arm. */
  | 'skip-running'
  /** The latest occurrence is still inside the grace with no run yet: leave a
   *  possibly deferred, still pending alarm alone (re-arming forward would
   *  replace it — diagnosis mechanism C); look again right after the grace. */
  | 'wait-grace'
  /** Due and unrun, inside the catch-up window, but a reservation for it is
   *  in flight (occurrenceClaimState 'reserved'): re-arm the next one and look
   *  again once the reservation would count as abandoned. */
  | 'wait-claim'
  /** Due and unrun, inside the catch-up window: run it late (also re-dispatches
   *  an abandoned reservation or a deferred occurrence). */
  | 'late-run'
  /** Due and unrun, past the window: record it as missed, re-arm the next one
   *  (a stranded reservation past its window ends here too). */
  | 'missed'
  /** Nothing is owed (it ran, it is not due yet, or it cannot be computed):
   *  make sure the next future occurrence is armed. */
  | 'rearm';

export interface ReconcileInputs {
  nowMs: number;
  halted: boolean;
  enabled: ReconcileEnabledState;
  running: boolean;
  /** Most recent past occurrence (lastTriggerMs / lastTriggerAt), or null. */
  occurrenceMs: number | null;
  /** The occurrence before it (lastTrigger(cron, occurrenceMs - 1)), or null.
   *  Lets the grace branch tell "just due, maybe deferred" from "the chain is
   *  already dead" (an every-5-min schedule is always inside the grace). */
  previousOccurrenceMs: number | null;
  /** Newest evidence of a run of any status (run log / Agent.lastRun), or null. */
  lastRunAt: number | null;
  /** Agent.createdAt — the fallback when it never ran. null = unknown. */
  createdAt: number | null;
  /** Agent.startNotBefore. */
  startNotBefore: number | null;
  /** The persisted nominal interval (cronToIntervalMs). */
  intervalMs: number | null;
  /** The occurrence currently claimed for this agent (native marker, written
   *  atomically by a regular alarm fire or by a late-run dispatch), or null. */
  claimedForMs: number | null;
  /** When that claim was taken (wall ms), or null (pre-lifecycle claim). */
  claimedAtMs: number | null;
  /** The occurrence whose run was marked started, or null. */
  startedForMs: number | null;
  /** The occurrence whose dispatch was refused before launch (settled), or null. */
  settledForMs: number | null;
  /** The occurrence whose dispatch was refused because a previous run was
   *  still active (deferred), or null. */
  deferredForMs: number | null;
  graceMs?: number;
}

export interface ReconcileDecision {
  action: ReconcileAction;
  /** The occurrence the decision is about (null when none was computed). */
  expectedAt: number | null;
  windowMs: number;
}

/** Pure. Order matters and is mirrored in AgentScheduleReconcileCore.decide. */
export function decideReconcile(i: ReconcileInputs): ReconcileDecision {
  const grace = i.graceMs ?? RECONCILE_GRACE_MS;
  const windowMs = catchUpWindowMs(i.intervalMs);
  const at = i.occurrenceMs;
  if (i.halted) return { action: 'skip-halted', expectedAt: at, windowMs };
  if (i.enabled === 'disabled') return { action: 'skip-disabled', expectedAt: at, windowMs };
  if (i.enabled === 'unknown') return { action: 'skip-unknown', expectedAt: at, windowMs };
  if (i.running) return { action: 'skip-running', expectedAt: at, windowMs };
  if (at == null) return { action: 'rearm', expectedAt: null, windowMs };
  // Deferred start: nothing before startNotBefore is ever owed (that covers
  // "not started yet" and an occurrence that predates the start).
  if (i.startNotBefore != null && i.startNotBefore > 0 && (i.nowMs < i.startNotBefore || at < i.startNotBefore)) {
    return { action: 'rearm', expectedAt: at, windowMs };
  }
  const lastActual = i.lastRunAt ?? i.createdAt;
  // Unknown creation time and no run evidence: never fabricate a late run.
  if (lastActual == null) return { action: 'rearm', expectedAt: at, windowMs };
  const claim = occurrenceClaimState(at, i.claimedForMs, i.claimedAtMs, i.startedForMs, i.settledForMs, i.deferredForMs, i.nowMs);
  // isScheduleMissed: missed = at < now - grace && at > lastActual + grace.
  // A deferred occurrence is the exception (also while a re-dispatch of it
  // is reserved, and once that re-dispatch is abandoned): what was logged
  // after it (its own "previous run still active" refusal, the previous
  // run's end) is not evidence that IT ran.
  const deferred = i.deferredForMs != null && i.deferredForMs === at;
  if (!deferred && at <= lastActual + grace) return { action: 'rearm', expectedAt: at, windowMs };
  if (at >= i.nowMs - grace) {
    // The previous occurrence is unrun too: the chain is already dead, not
    // merely deferred — re-arm now (the window rule still applies to `at`
    // on a later pass). Without this a schedule at or below the grace
    // (every 5 min) would wait forever.
    const prev = i.previousOccurrenceMs;
    if (prev != null && prev > lastActual + grace && !(i.startNotBefore != null && i.startNotBefore > 0 && prev < i.startNotBefore)) {
      return { action: 'rearm', expectedAt: at, windowMs };
    }
    return { action: 'wait-grace', expectedAt: at, windowMs };
  }
  // A started or settled occurrence never runs again, inside or past the window.
  if (claim === 'started' || claim === 'settled') return { action: 'rearm', expectedAt: at, windowMs };
  if (i.nowMs - at <= windowMs) {
    if (claim === 'reserved') return { action: 'wait-claim', expectedAt: at, windowMs };
    return { action: 'late-run', expectedAt: at, windowMs };
  }
  return { action: 'missed', expectedAt: at, windowMs };
}
