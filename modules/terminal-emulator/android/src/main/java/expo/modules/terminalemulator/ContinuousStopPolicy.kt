package expo.modules.terminalemulator

/**
 * Continuous mode ("止めるまで続けて", DEFERRED.md 継続モード Increment 1): the
 * PURE stop-condition decision for one loop. No Android / org.json types so it
 * runs as a plain JVM unit test (ContinuousStopPolicyTest).
 *
 * A continuous agent is a sequence of short unattended runs (iterations); after
 * each run TerminalSessionService re-arms the next one at now + cooldown. Native
 * evaluates [evaluate] before every iteration and again right after it, and
 * never re-arms once it returns a reason. Every number here is mirrored by
 * lib/agent-continuous.ts (asserted by __tests__/agent-continuous.test.ts).
 */
data class ContinuousConfig(
    val cooldownMs: Long,
    val maxIterations: Int,
    val maxWallMs: Long,
    val goalCheck: Boolean,
    /** 0 = paid API steps are not allowed at all (the default). */
    val dailyBudgetJpy: Long,
    /** Epoch ms the user (re)started this loop; null on agents written before it existed. */
    val loopStartedAt: Long?,
)

data class ContinuousStopInputs(
    val nowMs: Long,
    /** The per-agent stop marker exists (notification Stop action). */
    val userStopRequested: Boolean,
    /** Agent json still says enabled (Pause / delete clear it). */
    val agentEnabled: Boolean,
    /** `.halted` exists (STOP-ALL) — or could not be checked (fail closed). */
    val globallyHalted: Boolean,
    /** Iterations already started in this loop. */
    val iterationsDone: Int,
    /** Epoch ms this loop started. */
    val loopStartedAt: Long,
    /** Paid-API spend recorded for today (USD), 0 when none / other day. */
    val spentUsdToday: Double,
    /** max(native circuit-breaker count, checkpoint.consecutiveFailures). */
    val consecutiveFailures: Int,
    /** How many runs in a row ended with a DONE signal. */
    val doneStreak: Int,
    /** A stop already recorded for THIS loop (checkpoint stoppedReason, see
     *  [recordedStop]) — sticky until the user starts a new loop, so a stale
     *  enabled:true written back by the app can never revive it. */
    val recordedStop: ContinuousStopReason? = null,
)

enum class ContinuousStopReason(val code: String) {
    USER_STOP("user_stop"),
    HALTED("halted"),
    MAX_ITERATIONS("max_iterations"),
    MAX_WALL_TIME("max_wall_time"),
    BUDGET("budget"),
    CONSECUTIVE_FAILURES("consecutive_failures"),
    GOAL_REACHED("goal_reached");

    companion object {
        fun fromCode(code: String?): ContinuousStopReason? = values().firstOrNull { it.code == code }
    }

    /** STOP-ALL keeps the agent enabled so RESUME brings the loop back; every
     *  other reason ends this loop (the user re-enables to start a new one). */
    val disablesAgent: Boolean get() = this != HALTED
}

object ContinuousStopPolicy {
    const val DEFAULT_COOLDOWN_MS = 5 * 60 * 1000L
    const val MIN_COOLDOWN_MS = 60 * 1000L
    const val MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000L
    const val DEFAULT_MAX_ITERATIONS = 50
    const val HARD_MAX_ITERATIONS = 1000
    const val DEFAULT_MAX_WALL_MS = 24 * 60 * 60 * 1000L
    const val MIN_MAX_WALL_MS = 60 * 1000L
    const val HARD_MAX_WALL_MS = 7 * 24 * 60 * 60 * 1000L
    const val MAX_DAILY_BUDGET_JPY = 100_000L
    const val CONSECUTIVE_FAILURE_LIMIT = 3
    const val DONE_STREAK_TO_STOP = 2
    /** Conservative fixed rate for comparing a USD spend against a JPY cap. */
    const val JPY_PER_USD = 150.0

    fun clampCooldownMs(raw: Long): Long = raw.coerceIn(MIN_COOLDOWN_MS, MAX_COOLDOWN_MS)

    /** Normalize untrusted numbers (agent json) into a config that always has limits. */
    fun normalize(
        cooldownMs: Long?,
        maxIterations: Int?,
        maxWallMs: Long?,
        goalCheck: Boolean?,
        dailyBudgetJpy: Long?,
        loopStartedAt: Long?,
    ): ContinuousConfig = ContinuousConfig(
        cooldownMs = clampCooldownMs(cooldownMs?.takeIf { it > 0 } ?: DEFAULT_COOLDOWN_MS),
        maxIterations = (maxIterations?.takeIf { it > 0 } ?: DEFAULT_MAX_ITERATIONS).coerceAtMost(HARD_MAX_ITERATIONS),
        maxWallMs = (maxWallMs?.takeIf { it > 0 } ?: DEFAULT_MAX_WALL_MS).coerceIn(MIN_MAX_WALL_MS, HARD_MAX_WALL_MS),
        goalCheck = goalCheck == true,
        dailyBudgetJpy = (dailyBudgetJpy ?: 0L).coerceIn(0L, MAX_DAILY_BUDGET_JPY),
        loopStartedAt = loopStartedAt?.takeIf { it > 0 },
    )

    /**
     * The first reason this loop must stop, or null to keep going. Order matters
     * only for which reason is reported when several hold: explicit user
     * intent first, then hard limits, then outcome-based reasons.
     */
    fun evaluate(config: ContinuousConfig, inputs: ContinuousStopInputs): ContinuousStopReason? {
        if (inputs.globallyHalted) return ContinuousStopReason.HALTED
        inputs.recordedStop?.let { return it }
        if (inputs.userStopRequested || !inputs.agentEnabled) return ContinuousStopReason.USER_STOP
        if (inputs.iterationsDone >= config.maxIterations) return ContinuousStopReason.MAX_ITERATIONS
        // A clock that went backwards (start in the future) counts as elapsed
        // wall time = 0; a start older than the cap stops the loop.
        if (inputs.nowMs - inputs.loopStartedAt >= config.maxWallMs) return ContinuousStopReason.MAX_WALL_TIME
        if (budgetExceeded(config.dailyBudgetJpy, inputs.spentUsdToday)) return ContinuousStopReason.BUDGET
        if (inputs.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) return ContinuousStopReason.CONSECUTIVE_FAILURES
        if (config.goalCheck && inputs.doneStreak >= DONE_STREAK_TO_STOP) return ContinuousStopReason.GOAL_REACHED
        return null
    }

    /** With the default ¥0 cap any recorded paid spend is already a breach
     *  (paid steps are excluded upstream, so spend here means a leak). */
    fun budgetExceeded(dailyBudgetJpy: Long, spentUsdToday: Double): Boolean {
        if (spentUsdToday.isNaN() || spentUsdToday <= 0.0) return false
        if (dailyBudgetJpy <= 0L) return true
        return spentUsdToday * JPY_PER_USD >= dailyBudgetJpy.toDouble()
    }

    /** The stop recorded in the checkpoint, if it belongs to this loop. A
     *  'halted' record is not sticky (RESUME continues the loop). */
    fun recordedStop(stoppedReason: String?, stoppedAt: Long?, loopStartedAt: Long): ContinuousStopReason? {
        val reason = ContinuousStopReason.fromCode(stoppedReason) ?: return null
        if (reason == ContinuousStopReason.HALTED) return null
        if (stoppedAt == null || stoppedAt < loopStartedAt) return null
        return reason
    }

    /** A stop marker counts only when written at / after [sinceMs] (1s slack
     *  for coarse file-system mtimes). */
    fun markerApplies(markerMtimeMs: Long, sinceMs: Long): Boolean = markerMtimeMs + 1000 >= sinceMs

    /** The PlanSpec executor process of THIS agent (its argv names this
     *  agent's plan file) — never another agent's executor. */
    fun isOwnExecutorCmdline(cmdline: String, agentId: String): Boolean =
        cmdline.contains("shelly-plan-executor") && cmdline.contains("plan-agent-$agentId.json")

    /** Iterations to count: the larger of native's own counter and the
     *  checkpoint's (a corrupt/missing checkpoint can never lower it). */
    fun iterationsDone(nativeCount: Int, checkpointIteration: Int): Int =
        maxOf(nativeCount.coerceAtLeast(0), checkpointIteration.coerceAtLeast(0))
}
