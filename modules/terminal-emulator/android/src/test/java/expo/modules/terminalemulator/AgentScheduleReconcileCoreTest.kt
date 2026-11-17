package expo.modules.terminalemulator

import expo.modules.terminalemulator.AgentScheduleReconcileCore.Action
import expo.modules.terminalemulator.AgentScheduleReconcileCore.ClaimState
import expo.modules.terminalemulator.AgentScheduleReconcileCore.Enabled
import expo.modules.terminalemulator.AgentScheduleReconcileCore.Inputs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Calendar

/**
 * Catch-up reconcile decision table (AgentScheduleReconcileCore) and the
 * AgentAlarmScheduler.lastTriggerAt vectors. Mirrors
 * __tests__/agent-schedule-reconcile.test.ts. Like ContinuousStopPolicyTest this
 * is not wired into CI (build-android.yml only runs assembleRelease); run it
 * with `./gradlew :terminal-emulator:testDebugUnitTest`.
 *
 * AgentAlarmScheduler is an `object` that references Android classes, but
 * lastTriggerAt itself only uses java.util, so calling it on the JVM is fine.
 */
class AgentScheduleReconcileCoreTest {
    private val min = 60 * 1000L
    private val hour = 60 * min
    private val day = 24 * hour
    private val now = 1_800_000_000_000L

    private fun inputs(
        halted: Boolean = false,
        enabled: Enabled = Enabled.ENABLED,
        running: Boolean = false,
        occurrenceMs: Long? = now - hour,
        previousOccurrenceMs: Long? = null,
        lastRunAt: Long? = now - day - hour,
        createdAt: Long? = now - 30 * day,
        startNotBefore: Long? = null,
        intervalMs: Long? = day,
        claimedForMs: Long? = null,
        claimedAtMs: Long? = null,
        startedForMs: Long? = null,
        settledForMs: Long? = null,
        deferredForMs: Long? = null,
        graceMs: Long = AgentScheduleReconcileCore.RECONCILE_GRACE_MS,
    ) = Inputs(now, halted, enabled, running, occurrenceMs, previousOccurrenceMs, lastRunAt, createdAt, startNotBefore, intervalMs, claimedForMs, claimedAtMs, startedForMs, settledForMs, deferredForMs, graceMs)

    private fun action(i: Inputs) = AgentScheduleReconcileCore.decide(i).action

    // ── catchUpWindowMs ─────────────────────────────────────────────────────
    @Test
    fun windowDailyIsTwoHours() = assertEquals(2 * hour, AgentScheduleReconcileCore.catchUpWindowMs(day))

    @Test
    fun windowHourlyIsOneHour() = assertEquals(hour, AgentScheduleReconcileCore.catchUpWindowMs(hour))

    @Test
    fun windowEveryFiveMinutesFloorsAtTenMinutes() = assertEquals(10 * min, AgentScheduleReconcileCore.catchUpWindowMs(5 * min))

    @Test
    fun windowEveryThirtyMinutes() = assertEquals(30 * min, AgentScheduleReconcileCore.catchUpWindowMs(30 * min))

    @Test
    fun windowZeroOrNullIsTwoHours() {
        assertEquals(2 * hour, AgentScheduleReconcileCore.catchUpWindowMs(0L))
        assertEquals(2 * hour, AgentScheduleReconcileCore.catchUpWindowMs(null))
    }

    // ── decide ──────────────────────────────────────────────────────────────
    @Test
    fun baseIsLateRun() = assertEquals(Action.LATE_RUN, action(inputs()))

    @Test
    fun deadEveryFiveMinuteChainIsRearmedNotLeftInGrace() = assertEquals(
        Action.REARM,
        action(inputs(occurrenceMs = now - 2 * min, previousOccurrenceMs = now - 7 * min, lastRunAt = now - 3 * hour, intervalMs = 5 * min)),
    )

    @Test
    fun graceWithPreviousAccountedForStillWaits() = assertEquals(
        Action.WAIT_GRACE,
        action(inputs(occurrenceMs = now - 2 * min, previousOccurrenceMs = now - 2 * min - day, lastRunAt = now - 2 * min - day + 20 * min)),
    )

    @Test
    fun occurrenceBeforeStartNotBeforeIsNotRunLate() = assertEquals(
        Action.REARM,
        action(inputs(occurrenceMs = now - hour, startNotBefore = now - 30 * min, lastRunAt = null, createdAt = now - day)),
    )

    @Test
    fun occurrenceAtStartNotBeforeIsCaughtUp() = assertEquals(
        Action.LATE_RUN,
        action(inputs(occurrenceMs = now - hour, startNotBefore = now - hour, lastRunAt = null, createdAt = now - day)),
    )

    @Test
    fun haltedSkipsEvenIfDue() = assertEquals(Action.SKIP_HALTED, action(inputs(halted = true)))

    @Test
    fun disabledSkips() = assertEquals(Action.SKIP_DISABLED, action(inputs(enabled = Enabled.DISABLED)))

    @Test
    fun unknownSkips() = assertEquals(Action.SKIP_UNKNOWN, action(inputs(enabled = Enabled.UNKNOWN)))

    @Test
    fun runningSkips() = assertEquals(Action.SKIP_RUNNING, action(inputs(running = true)))

    @Test
    fun noOccurrenceRearmsWithNullExpectedAt() {
        val d = AgentScheduleReconcileCore.decide(inputs(occurrenceMs = null))
        assertEquals(Action.REARM, d.action)
        assertNull(d.expectedAt)
    }

    @Test
    fun futureStartNotBeforeRearms() = assertEquals(Action.REARM, action(inputs(startNotBefore = now + day)))

    @Test
    fun noRunEvidenceAndNoCreatedAtRearms() = assertEquals(Action.REARM, action(inputs(lastRunAt = null, createdAt = null)))

    @Test
    fun ranAtOrAfterOccurrenceRearms() {
        val occ = now - hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, lastRunAt = occ)))
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, lastRunAt = occ + 1000)))
    }

    @Test
    fun ranWithinGraceBeforeOccurrenceRearms() {
        val occ = now - hour
        val grace = AgentScheduleReconcileCore.RECONCILE_GRACE_MS
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, lastRunAt = occ - 2 * min)))
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, lastRunAt = occ - grace)))
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, lastRunAt = occ - grace - 1)))
    }

    @Test
    fun createdAtIsFallbackWhenNeverRun() {
        val occ = now - hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, lastRunAt = null, createdAt = occ + 1)))
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, lastRunAt = null, createdAt = occ - day)))
    }

    @Test
    fun occurrenceInsideGraceWaits() {
        val occ = now - 2 * min
        val d = AgentScheduleReconcileCore.decide(inputs(occurrenceMs = occ))
        assertEquals(Action.WAIT_GRACE, d.action)
        assertEquals(occ, d.expectedAt)
    }

    @Test
    fun graceBoundary() {
        val grace = AgentScheduleReconcileCore.RECONCILE_GRACE_MS
        assertEquals(Action.WAIT_GRACE, action(inputs(occurrenceMs = now - grace)))
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = now - grace - 1)))
    }

    @Test
    fun dailyOneHourLateRunsLate() {
        val occ = now - hour
        val d = AgentScheduleReconcileCore.decide(inputs(occurrenceMs = occ))
        assertEquals(Action.LATE_RUN, d.action)
        assertEquals(occ, d.expectedAt)
        assertEquals(2 * hour, d.windowMs)
    }

    @Test
    fun windowBoundary() {
        val w = 2 * hour
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = now - w)))
        assertEquals(Action.MISSED, action(inputs(occurrenceMs = now - w - 1)))
    }

    @Test
    fun dailyThreeHoursLateIsMissed() = assertEquals(Action.MISSED, action(inputs(occurrenceMs = now - 3 * hour)))

    @Test
    fun hourlySixtyOneMinutesLateIsMissed() {
        val d = AgentScheduleReconcileCore.decide(inputs(intervalMs = hour, occurrenceMs = now - 61 * min, lastRunAt = now - 3 * hour))
        assertEquals(Action.MISSED, d.action)
        assertEquals(hour, d.windowMs)
    }

    // ── claim lifecycle (mirrors the TS table) ───────────────────────────────
    private val abandon = AgentScheduleReconcileCore.CLAIM_ABANDON_MS

    @Test
    fun reservedThenStartedNeverReruns() {
        val occ = now - hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - 50 * min, startedForMs = occ)))
    }

    @Test
    fun startedPastWindowRearms() {
        val occ = now - 3 * hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - 170 * min, startedForMs = occ)))
    }

    @Test
    fun startedForOlderOccurrenceRunsLate() {
        val occ = now - hour
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, claimedForMs = occ - day, claimedAtMs = now - day, startedForMs = occ - day)))
    }

    @Test
    fun freshReservationWaits() {
        val occ = now - hour
        assertEquals(Action.WAIT_CLAIM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - min)))
        assertEquals(Action.WAIT_CLAIM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - abandon + 1)))
    }

    @Test
    fun abandonedReservationInsideWindowIsRedispatched() {
        val occ = now - hour
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - abandon)))
    }

    @Test
    fun abandonedReservationPastWindowIsMissed() {
        val occ = now - 3 * hour
        assertEquals(Action.MISSED, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - 2 * hour)))
    }

    @Test
    fun claimPlusRunLogIsDone() {
        val occ = now - hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - 50 * min, lastRunAt = occ + 2 * min)))
    }

    // Gate fix round 2 (R1): pre-launch refusals settle; "still active" defers.
    @Test
    fun regateReproAbandonedPlusSettledRefusalIsSettled() {
        val occ = 1_800_000_000_000L
        val at = occ + 6 * min
        val i = Inputs(at, false, Enabled.ENABLED, false, occ, occ - day, occ + 1000, occ - day, null, day, occ, occ, null, occ, null)
        assertEquals(ClaimState.SETTLED, AgentScheduleReconcileCore.occurrenceClaimState(occ, occ, occ, null, occ, null, at))
        assertEquals(Action.REARM, AgentScheduleReconcileCore.decide(i).action)
        // Same, no runtime outcome at all: still re-dispatched.
        val none = Inputs(at, false, Enabled.ENABLED, false, occ, occ - day, null, occ - day, null, day, occ, occ, null, null, null)
        assertEquals(Action.LATE_RUN, AgentScheduleReconcileCore.decide(none).action)
    }

    @Test
    fun deferredOccurrenceStaysRecoverable() {
        val occ = now - hour
        // Its refusal log and the previous run's end are not evidence.
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = occ, deferredForMs = occ, lastRunAt = occ + 1000)))
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = occ, deferredForMs = occ, lastRunAt = occ + 40 * min)))
        assertEquals(Action.SKIP_RUNNING, action(inputs(running = true, occurrenceMs = occ, claimedForMs = occ, claimedAtMs = occ, deferredForMs = occ, lastRunAt = occ + 1000)))
        assertEquals(Action.MISSED, action(inputs(occurrenceMs = now - 3 * hour, claimedForMs = now - 3 * hour, claimedAtMs = now - 3 * hour, deferredForMs = now - 3 * hour, lastRunAt = now - hour)))
        assertEquals(ClaimState.DEFERRED, AgentScheduleReconcileCore.occurrenceClaimState(occ, occ, occ, null, null, occ, now))
        // A fresh re-reservation reads as reserved (wait-claim, logs ignored);
        // once abandoned it is deferred again and re-dispatched.
        assertEquals(Action.WAIT_CLAIM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - min, deferredForMs = occ, lastRunAt = occ + 1000)))
        assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = now - 10 * min, deferredForMs = occ, lastRunAt = occ + 1000)))
        // A deferred mark of an older occurrence is irrelevant.
        assertEquals(ClaimState.NONE, AgentScheduleReconcileCore.occurrenceClaimState(occ, occ - day, occ - day, null, null, occ - day, now))
    }

    @Test
    fun preLifecycleClaimCountsAsStarted() {
        val occ = now - hour
        assertEquals(Action.REARM, action(inputs(occurrenceMs = occ, claimedForMs = occ, claimedAtMs = null)))
    }

    @Test
    fun chainLockStaleness() {
        val nowSec = now / 1000
        val staleSec = AgentScheduleReconcileCore.CHAIN_LOCK_STALE_MS / 1000
        assertEquals(true, AgentScheduleReconcileCore.isChainLockLive(nowSec - staleSec + 1, now))
        assertEquals(false, AgentScheduleReconcileCore.isChainLockLive(nowSec - staleSec, now))
        assertEquals(0L, AgentScheduleReconcileCore.parseChainLockAcquiredAt("-5"))
        assertEquals(0L, AgentScheduleReconcileCore.parseChainLockAcquiredAt(null))
        assertEquals(nowSec, AgentScheduleReconcileCore.parseChainLockAcquiredAt("$nowSec\n"))
    }

    @Test
    fun customGraceIsHonoured() = assertEquals(Action.LATE_RUN, action(inputs(occurrenceMs = now - 2 * min, graceMs = min)))

    // ── lastTriggerAt (local time, TZ independent) ──────────────────────────
    private fun local(y: Int, month1: Int, d: Int, h: Int = 0, mi: Int = 0, s: Int = 0): Long =
        Calendar.getInstance().apply {
            set(y, month1 - 1, d, h, mi, s)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    private fun last(cron: String?, at: Long) = AgentAlarmScheduler.lastTriggerAt(cron, at)

    @Test
    fun dailyVectors() {
        val c = "0 7 * * *"
        assertEquals(local(2026, 11, 16, 7), last(c, local(2026, 11, 17, 6, 59)))
        assertEquals(local(2026, 11, 17, 7), last(c, local(2026, 11, 17, 7, 0, 0)))
        assertEquals(local(2026, 11, 17, 7), last(c, local(2026, 11, 17, 7, 0, 1)))
        assertEquals(local(2026, 2, 28, 7), last(c, local(2026, 3, 1, 6)))
        assertEquals(local(2026, 12, 31, 7), last(c, local(2027, 1, 1, 6)))
        assertEquals(local(2028, 2, 29, 7), last(c, local(2028, 3, 1, 6)))
    }

    @Test
    fun weeklyVectors() {
        // 2026-11-16 is a Monday; 2027-01-01 a Friday.
        assertEquals(local(2026, 11, 9, 9), last("0 9 * * 1", local(2026, 11, 16, 8)))
        assertEquals(local(2026, 11, 16, 9), last("0 9 * * 1", local(2026, 11, 16, 9)))
        assertEquals(local(2026, 11, 16, 9), last("0 9 * * 1", local(2026, 11, 18, 12)))
        assertEquals(local(2026, 11, 16, 9), last("0 9 * * 1,5", local(2026, 11, 18, 12)))
        assertEquals(local(2026, 11, 13, 9), last("0 9 * * 1,5", local(2026, 11, 14, 12)))
        assertEquals(local(2026, 11, 13, 9), last("0 9 * * 1,5", local(2026, 11, 16, 8)))
        assertEquals(local(2026, 11, 15, 9), last("0 9 * * 0", local(2026, 11, 17, 12)))
        assertEquals(local(2026, 11, 15, 9), last("0 9 * * 7", local(2026, 11, 17, 12)))
        assertEquals(local(2026, 12, 28, 9), last("0 9 * * 1", local(2027, 1, 1, 12)))
    }

    @Test
    fun everyNHourVectors() {
        assertEquals(local(2026, 11, 17, 9), last("0 */3 * * *", local(2026, 11, 17, 10, 30)))
        assertEquals(local(2026, 11, 17, 0), last("0 */3 * * *", local(2026, 11, 17, 0, 10)))
        assertEquals(local(2026, 11, 17, 0), last("0 */3 * * *", local(2026, 11, 17, 2, 59)))
        assertEquals(local(2026, 11, 17, 20), last("0 */5 * * *", local(2026, 11, 17, 23, 30)))
    }

    @Test
    fun everyNMinuteVectors() {
        assertEquals(local(2026, 11, 17, 10, 30), last("*/15 * * * *", local(2026, 11, 17, 10, 44, 59)))
        assertEquals(local(2026, 11, 17, 10, 45), last("*/15 * * * *", local(2026, 11, 17, 10, 45, 0)))
    }

    @Test
    fun dailyMultiVectors() {
        val c = "30 8,21 * * *"
        assertEquals(local(2026, 11, 16, 21, 30), last(c, local(2026, 11, 17, 8, 29)))
        assertEquals(local(2026, 11, 17, 8, 30), last(c, local(2026, 11, 17, 12)))
        assertEquals(local(2026, 11, 17, 21, 30), last(c, local(2026, 11, 17, 22)))
    }

    @Test
    fun unsupportedShapesAreNull() {
        val at = local(2026, 11, 17, 12)
        assertNull(last("@once ${local(2099, 1, 1)}", at))
        assertNull(last("bad", at))
        assertNull(last("0 7 * *", at))
        assertNull(last("0 9 * * 1,9", at))
        assertNull(last(null, at))
        assertNull(last("", at))
        // Day-of-month shapes: Kotlin rejects (JS silently treats as daily).
        assertNull(last("0 7 1 * *", at))
    }
}
