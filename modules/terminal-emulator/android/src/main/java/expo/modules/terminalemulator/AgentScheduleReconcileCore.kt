package expo.modules.terminalemulator

/**
 * Pure catch-up decision for one recurring (cron, non-one-shot,
 * non-continuous) schedule. Mirrors lib/agent-schedule-reconcile.ts
 * line-for-line; the two change in lockstep
 * (__tests__/agent-schedule-reconcile.test.ts checks the constants and the
 * branch order, AgentScheduleReconcileCoreTest.kt runs the same table on the
 * JVM). No Android imports: AgentAlarmScheduler.reconcile gathers the inputs
 * from disk / SharedPreferences and acts on the result.
 *
 * "Due and unrun" is exactly lib/agent-scheduler.ts isScheduleMissed's rule
 * (5-minute grace on both sides), so native reconcile and the JS startup
 * repair agree on which occurrence was missed.
 *
 * Lockstep scope: decide / occurrenceClaimState / isChainLockLive /
 * catchUpWindowMs mirror the TS functions for every input. The occurrence
 * parser feeding decide (AgentAlarmScheduler.lastTriggerAt vs JS
 * lastTriggerMs) agrees only on the cron shapes cronToIntervalMs accepts
 * (every-N-min, every-N-hour, daily, daily-multi, weekly); other shapes
 * (monthly `0 7 1 * *`, …) are never armed, hence never reconciled.
 */
object AgentScheduleReconcileCore {
    /** Mirrors lib/agent-scheduler.ts MISSED_RUN_GRACE_MS. */
    const val RECONCILE_GRACE_MS = 5 * 60 * 1000L
    const val CATCH_UP_WINDOW_CAP_MS = 2 * 60 * 60 * 1000L
    const val CATCH_UP_WINDOW_FLOOR_MS = 10 * 60 * 1000L
    const val RECONCILE_WATCHDOG_PERIOD_MS = 60 * 60 * 1000L
    const val RECONCILE_GRACE_FOLLOW_UP_MS = 60 * 1000L
    /** Mirrors CLAIM_ABANDON_MS (TS doc): a reserved, never-started claim is
     *  abandoned (recoverable) this long after it was taken. */
    const val CLAIM_ABANDON_MS = 3 * 60 * 1000L
    /** Mirrors CHAIN_LOCK_STALE_MS (TS doc) = acquireChainLock's steal age. */
    const val CHAIN_LOCK_STALE_MS = 2 * 60 * 60 * 1000L

    /** `acquired-at` content → epoch seconds, as acquireChainLock's shell
     *  reads it: digits only, anything else is 0 (stale). */
    fun parseChainLockAcquiredAt(raw: String?): Long {
        val t = raw?.trim().orEmpty()
        return if (t.isNotEmpty() && t.all { it in '0'..'9' }) t.toLongOrNull() ?: 0L else 0L
    }

    /** Live only while acquireChainLock would still refuse to steal it. */
    fun isChainLockLive(acquiredAtSec: Long, nowMs: Long): Boolean {
        val nowSec = nowMs / 1000
        val staleSec = CHAIN_LOCK_STALE_MS / 1000
        return nowSec - acquiredAtSec < staleSec
    }

    enum class ClaimState { NONE, RESERVED, ABANDONED, DEFERRED, SETTLED, STARTED }

    /** Mirrors occurrenceClaimState (TS doc has the lifecycle). */
    fun occurrenceClaimState(
        occurrenceMs: Long,
        claimedForMs: Long?,
        claimedAtMs: Long?,
        startedForMs: Long?,
        settledForMs: Long?,
        deferredForMs: Long?,
        nowMs: Long,
    ): ClaimState {
        if (startedForMs != null && startedForMs == occurrenceMs) return ClaimState.STARTED
        if (settledForMs != null && settledForMs == occurrenceMs) return ClaimState.SETTLED
        if (claimedForMs == null || claimedForMs != occurrenceMs) return ClaimState.NONE
        if (claimedAtMs != null && Math.abs(nowMs - claimedAtMs) < CLAIM_ABANDON_MS) return ClaimState.RESERVED
        if (deferredForMs != null && deferredForMs == occurrenceMs) return ClaimState.DEFERRED
        if (claimedAtMs == null) return ClaimState.STARTED
        return ClaimState.ABANDONED
    }

    enum class Enabled { ENABLED, DISABLED, UNKNOWN }

    enum class Action(val code: String) {
        SKIP_HALTED("skip-halted"),
        SKIP_DISABLED("skip-disabled"),
        SKIP_UNKNOWN("skip-unknown"),
        SKIP_RUNNING("skip-running"),
        WAIT_GRACE("wait-grace"),
        WAIT_CLAIM("wait-claim"),
        LATE_RUN("late-run"),
        MISSED("missed"),
        REARM("rearm"),
    }

    data class Inputs(
        val nowMs: Long,
        val halted: Boolean,
        val enabled: Enabled,
        val running: Boolean,
        val occurrenceMs: Long?,
        /** lastTriggerAt(cron, occurrenceMs - 1); see the TS field doc. */
        val previousOccurrenceMs: Long?,
        val lastRunAt: Long?,
        val createdAt: Long?,
        val startNotBefore: Long?,
        val intervalMs: Long?,
        val claimedForMs: Long?,
        val claimedAtMs: Long?,
        val startedForMs: Long?,
        /** Dispatch refused before launch (settled), or null. */
        val settledForMs: Long?,
        /** Dispatch refused: a previous run was still active (deferred), or null. */
        val deferredForMs: Long?,
        val graceMs: Long = RECONCILE_GRACE_MS,
    )

    data class Decision(val action: Action, val expectedAt: Long?, val windowMs: Long)

    /** min(nominal interval, 2 h), floored at 10 min; unknown interval → 2 h. */
    fun catchUpWindowMs(intervalMs: Long?): Long {
        val nominal = if (intervalMs != null && intervalMs > 0) intervalMs else CATCH_UP_WINDOW_CAP_MS
        return maxOf(CATCH_UP_WINDOW_FLOOR_MS, minOf(nominal, CATCH_UP_WINDOW_CAP_MS))
    }

    /** Order matters and is mirrored in decideReconcile (TS). */
    fun decide(i: Inputs): Decision {
        val grace = i.graceMs
        val windowMs = catchUpWindowMs(i.intervalMs)
        val at = i.occurrenceMs
        if (i.halted) return Decision(Action.SKIP_HALTED, at, windowMs)
        if (i.enabled == Enabled.DISABLED) return Decision(Action.SKIP_DISABLED, at, windowMs)
        if (i.enabled == Enabled.UNKNOWN) return Decision(Action.SKIP_UNKNOWN, at, windowMs)
        if (i.running) return Decision(Action.SKIP_RUNNING, at, windowMs)
        if (at == null) return Decision(Action.REARM, null, windowMs)
        // Deferred start: nothing before startNotBefore is ever owed.
        if (i.startNotBefore != null && i.startNotBefore > 0 && (i.nowMs < i.startNotBefore || at < i.startNotBefore)) {
            return Decision(Action.REARM, at, windowMs)
        }
        val lastActual = i.lastRunAt ?: i.createdAt
        // Unknown creation time and no run evidence: never fabricate a late run.
        if (lastActual == null) return Decision(Action.REARM, at, windowMs)
        val claim = occurrenceClaimState(at, i.claimedForMs, i.claimedAtMs, i.startedForMs, i.settledForMs, i.deferredForMs, i.nowMs)
        // isScheduleMissed: missed = at < now - grace && at > lastActual + grace.
        // A deferred occurrence is the exception (also while a re-dispatch of
        // it is reserved or abandoned): what was logged after it is not
        // evidence that IT ran (TS doc).
        val deferred = i.deferredForMs != null && i.deferredForMs == at
        if (!deferred && at <= lastActual + grace) return Decision(Action.REARM, at, windowMs)
        if (at >= i.nowMs - grace) {
            // The previous occurrence is unrun too: the chain is dead, not
            // merely deferred — re-arm now (an every-5-min schedule is always
            // inside the grace and would otherwise wait forever).
            val prev = i.previousOccurrenceMs
            if (prev != null && prev > lastActual + grace && !(i.startNotBefore != null && i.startNotBefore > 0 && prev < i.startNotBefore)) {
                return Decision(Action.REARM, at, windowMs)
            }
            return Decision(Action.WAIT_GRACE, at, windowMs)
        }
        // A started or settled occurrence never runs again, inside or past the window.
        if (claim == ClaimState.STARTED || claim == ClaimState.SETTLED) return Decision(Action.REARM, at, windowMs)
        if (i.nowMs - at <= windowMs) {
            if (claim == ClaimState.RESERVED) return Decision(Action.WAIT_CLAIM, at, windowMs)
            return Decision(Action.LATE_RUN, at, windowMs)
        }
        return Decision(Action.MISSED, at, windowMs)
    }
}
