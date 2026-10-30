package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Continuous mode stop conditions (ContinuousStopPolicy). Like
 * DeviceApiRateLimiterTest this is not yet wired into a CI task
 * (build-android.yml only runs assembleRelease); run it with
 * `./gradlew :terminal-emulator:testDebugUnitTest`.
 */
class ContinuousStopPolicyTest {
    private val hour = 60 * 60 * 1000L
    private val start = 1_000_000_000_000L

    private fun config(
        maxIterations: Int = 50,
        maxWallMs: Long = 24 * hour,
        goalCheck: Boolean = false,
        dailyBudgetJpy: Long = 0L,
    ) = ContinuousStopPolicy.normalize(5 * 60_000L, maxIterations, maxWallMs, goalCheck, dailyBudgetJpy, start)

    private fun inputs(
        nowMs: Long = start + hour,
        userStop: Boolean = false,
        enabled: Boolean = true,
        halted: Boolean = false,
        iterations: Int = 3,
        spentUsd: Double = 0.0,
        failures: Int = 0,
        doneStreak: Int = 0,
    ) = ContinuousStopInputs(nowMs, userStop, enabled, halted, iterations, start, spentUsd, failures, doneStreak)

    @Test
    fun keepsGoingWhenNothingHolds() {
        assertNull(ContinuousStopPolicy.evaluate(config(), inputs()))
    }

    @Test
    fun userStopAndPauseStop() {
        assertEquals(ContinuousStopReason.USER_STOP, ContinuousStopPolicy.evaluate(config(), inputs(userStop = true)))
        assertEquals(ContinuousStopReason.USER_STOP, ContinuousStopPolicy.evaluate(config(), inputs(enabled = false)))
    }

    @Test
    fun globalHaltWinsAndKeepsTheAgentEnabled() {
        val reason = ContinuousStopPolicy.evaluate(config(), inputs(halted = true, userStop = true, iterations = 999))
        assertEquals(ContinuousStopReason.HALTED, reason)
        assertFalse(reason!!.disablesAgent)
        assertTrue(ContinuousStopReason.USER_STOP.disablesAgent)
    }

    @Test
    fun maxIterations() {
        assertNull(ContinuousStopPolicy.evaluate(config(maxIterations = 50), inputs(iterations = 49)))
        assertEquals(ContinuousStopReason.MAX_ITERATIONS, ContinuousStopPolicy.evaluate(config(maxIterations = 50), inputs(iterations = 50)))
    }

    @Test
    fun maxWallTime() {
        assertNull(ContinuousStopPolicy.evaluate(config(), inputs(nowMs = start + 24 * hour - 1)))
        assertEquals(ContinuousStopReason.MAX_WALL_TIME, ContinuousStopPolicy.evaluate(config(), inputs(nowMs = start + 24 * hour)))
    }

    @Test
    fun zeroBudgetMeansAnyPaidSpendStops() {
        assertNull(ContinuousStopPolicy.evaluate(config(), inputs(spentUsd = 0.0)))
        assertEquals(ContinuousStopReason.BUDGET, ContinuousStopPolicy.evaluate(config(), inputs(spentUsd = 0.001)))
    }

    @Test
    fun positiveBudgetComparesInYen() {
        // ¥300 cap at 150 JPY/USD = $2.
        assertNull(ContinuousStopPolicy.evaluate(config(dailyBudgetJpy = 300), inputs(spentUsd = 1.99)))
        assertEquals(ContinuousStopReason.BUDGET, ContinuousStopPolicy.evaluate(config(dailyBudgetJpy = 300), inputs(spentUsd = 2.0)))
        assertFalse(ContinuousStopPolicy.budgetExceeded(0, Double.NaN))
    }

    @Test
    fun threeConsecutiveFailures() {
        assertNull(ContinuousStopPolicy.evaluate(config(), inputs(failures = 2)))
        assertEquals(ContinuousStopReason.CONSECUTIVE_FAILURES, ContinuousStopPolicy.evaluate(config(), inputs(failures = 3)))
    }

    @Test
    fun goalNeedsDoneTwiceInARowAndGoalCheck() {
        assertNull(ContinuousStopPolicy.evaluate(config(goalCheck = true), inputs(doneStreak = 1)))
        assertEquals(ContinuousStopReason.GOAL_REACHED, ContinuousStopPolicy.evaluate(config(goalCheck = true), inputs(doneStreak = 2)))
        // "止めるまで" (no goal check): a DONE from the model never ends the loop.
        assertNull(ContinuousStopPolicy.evaluate(config(goalCheck = false), inputs(doneStreak = 5)))
    }

    @Test
    fun normalizeFillsDefaultsAndClamps() {
        val c = ContinuousStopPolicy.normalize(null, null, null, null, null, null)
        assertEquals(ContinuousStopPolicy.DEFAULT_COOLDOWN_MS, c.cooldownMs)
        assertEquals(50, c.maxIterations)
        assertEquals(24 * hour, c.maxWallMs)
        assertEquals(0L, c.dailyBudgetJpy)
        assertFalse(c.goalCheck)
        assertNull(c.loopStartedAt)
        val clamped = ContinuousStopPolicy.normalize(1_000L, 1_000_000, 365 * 24 * hour, true, -5L, -1L)
        assertEquals(ContinuousStopPolicy.MIN_COOLDOWN_MS, clamped.cooldownMs)
        assertEquals(ContinuousStopPolicy.HARD_MAX_ITERATIONS, clamped.maxIterations)
        assertEquals(ContinuousStopPolicy.HARD_MAX_WALL_MS, clamped.maxWallMs)
        assertEquals(0L, clamped.dailyBudgetJpy)
        assertNull(clamped.loopStartedAt)
    }

    @Test
    fun aRecordedStopIsStickyForItsLoopOnly() {
        // Budget stop recorded during this loop: even with enabled:true written
        // back by a stale app snapshot, the loop stays stopped.
        val sticky = ContinuousStopPolicy.recordedStop("budget", start + 10, start)
        assertEquals(ContinuousStopReason.BUDGET, sticky)
        assertEquals(ContinuousStopReason.BUDGET, ContinuousStopPolicy.evaluate(config(), inputs(enabled = true).copy(recordedStop = sticky)))
        // A new loop (re-enable → later loopStartedAt) is not affected.
        assertNull(ContinuousStopPolicy.recordedStop("budget", start + 10, start + 20))
        // STOP-ALL is not sticky (RESUME continues), unknown codes are ignored.
        assertNull(ContinuousStopPolicy.recordedStop("halted", start + 10, start))
        assertNull(ContinuousStopPolicy.recordedStop("nope", start + 10, start))
        assertNull(ContinuousStopPolicy.recordedStop(null, null, start))
    }

    @Test
    fun aStopMarkerCountsOnlyFromItsRunOrLoop() {
        assertTrue(ContinuousStopPolicy.markerApplies(5_000L, 5_500L)) // 1s mtime slack
        assertTrue(ContinuousStopPolicy.markerApplies(9_000L, 5_000L))
        assertFalse(ContinuousStopPolicy.markerApplies(1_000L, 5_000L))
    }

    @Test
    fun onlyThisAgentsExecutorIsKillable() {
        val cmd = "/data/app/lib/node /home/.shelly-plan-executor.js --plan-file /home/.shelly/agents/plans/plan-agent-agent-a.json --agent-id agent-a"
        assertTrue(ContinuousStopPolicy.isOwnExecutorCmdline(cmd, "agent-a"))
        assertFalse(ContinuousStopPolicy.isOwnExecutorCmdline(cmd, "agent-b"))
        assertFalse(ContinuousStopPolicy.isOwnExecutorCmdline("bash plan-agent-agent-a.json", "agent-a"))
    }

    @Test
    fun serviceRecreationKeepsALiveLoopsNotification() {
        // Between iterations the service stops and is recreated: a loop that is
        // still continuous + enabled keeps its notification (and Stop button).
        assertTrue(ContinuousStopPolicy.keepRunningNotification("agent-a", stillContinuous = true, enabledOnDisk = true))
        assertFalse(ContinuousStopPolicy.keepRunningNotification("agent-a", stillContinuous = true, enabledOnDisk = false))
        assertFalse(ContinuousStopPolicy.keepRunningNotification("agent-a", stillContinuous = false, enabledOnDisk = true))
        assertFalse(ContinuousStopPolicy.keepRunningNotification(null, stillContinuous = true, enabledOnDisk = true))
    }

    @Test
    fun aLostCheckpointCannotLowerTheIterationCount() {
        assertEquals(7, ContinuousStopPolicy.iterationsDone(7, 0))
        assertEquals(9, ContinuousStopPolicy.iterationsDone(7, 9))
        assertEquals(0, ContinuousStopPolicy.iterationsDone(-1, -4))
    }
}
