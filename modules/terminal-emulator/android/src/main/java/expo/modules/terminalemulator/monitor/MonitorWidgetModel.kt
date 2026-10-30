package expo.modules.terminalemulator.monitor

import kotlin.math.roundToInt

/**
 * Pure state -> view-model mapping for the MONITOR home-screen widget. Mirrors
 * the rules of lib/monitor-live.ts (the MONITOR pane's LIVE source) so the
 * widget and the pane never disagree about a run:
 *  - one camera per step, channels CH-01.. in step order (the widget shows 4);
 *  - a user stop (run status `halted`) of a started step is STOPPED, and a
 *    "no" to an approval (SKIPPED after WAITING_APPROVAL, tail "declined") too;
 *  - mission progress is step based: settled steps count fully, an active
 *    (running / waiting for approval) step counts half, over the step count;
 *  - money only when the provider reported it; CLI is the flat plan, LOCAL
 *    is free.
 *
 * The model deliberately holds no "now": two reads of an unchanged run give
 * equal models, so the provider can skip the RemoteViews push entirely (a
 * tail-only progress write changes nothing on the widget).
 */
object MonitorWidgetModel {
    const val CAMERA_SLOTS = 4
    /** lib/monitor-live.ts isRunActive: a run with no run_end whose last event
     *  is older than this is treated as gone (crash / killed process)... */
    const val DEAD_AFTER_MS = 120_000L
    /** ...stretched to this while something holds the run (the pane's agent
     *  lock; here: the attended JS chain mark). */
    const val LOCKED_DEAD_AFTER_MS = 600_000L
    /** Events this close after native saw the last holder end still belong to it. */
    const val END_GRACE_MS = 5_000L
    /** Floor for the re-check alarm (inexact, non-wakeup). */
    const val MIN_RECHECK_MS = 60_000L

    enum class CamState { STANDBY, RUNNING, APPROVAL, DONE, FAILED, STOPPED, SKIPPED, NO_SIGNAL }

    enum class Variant { LIVE, DIM, ALERT, FAIL }

    enum class Outcome { RUNNING, SUCCESS, FAILED, STOPPED, SKIPPED }

    enum class Tone { LIVE, AMBER, DONE, FAIL }

    sealed class Cost {
        data class Money(val usd: Double) : Cost()
        data class Tokens(val tokens: Long) : Cost()
        object Plan : Cost()
        object Free : Cost()
        object None : Cost()
    }

    data class Camera(
        val slot: Int,
        /** Null for an empty (NO SIGNAL) slot. */
        val stepIndex: Int?,
        val channel: String,
        val state: CamState,
        val variant: Variant,
        /** Operator portrait 1..5 (bundled monitor_operator_<n>_<variant>). */
        val operator: Int,
        /** API / CLI / LOCAL once a `tool` event said what ran, else null. */
        val kind: String?,
        val providerLabel: String,
        /** 0 / 50 / 100 (step-based, like the pane's camera bar). */
        val progress: Int,
        val tone: Tone,
        val cost: Cost
    ) {
        val active: Boolean get() = state == CamState.RUNNING || state == CamState.APPROVAL
    }

    data class CostLine(
        val hasApi: Boolean,
        val apiUsd: Double?,
        val apiTokens: Long,
        val hasCli: Boolean,
        val cliTokens: Long,
        val hasLocal: Boolean,
        val localTokens: Long
    ) {
        val isEmpty: Boolean get() = !hasApi && !hasCli && !hasLocal
    }

    data class Model(
        val agentId: String,
        val runId: String,
        val outcome: Outcome,
        /** True while the run is live: drives REC flipping and the running clock. */
        val live: Boolean,
        val missionPct: Int,
        val tone: Tone,
        val runStartMs: Long?,
        val runEndMs: Long?,
        /** Continuous-mode iteration (checkpoint.json), when present. */
        val iteration: Int?,
        /** Channel of the first step waiting for the user's OK, else null. */
        val approvalChannel: String?,
        val approvalStep: Int?,
        val costLine: CostLine,
        val cameras: List<Camera>
    )

    fun channel(stepIndex: Int): String {
        val n = stepIndex + 1
        return if (n < 10) "CH-0$n" else "CH-$n"
    }

    /** djb2, identical to lib/monitor-live.ts `hash` (UTF-16 code units, uint32). */
    fun hash(text: String): Long {
        var h = 5381L
        for (ch in text) {
            h = ((h shl 5) + h + ch.code.toLong()) and 0xFFFFFFFFL
        }
        return h
    }

    /** Same portrait as the pane for (agent, step): lib/monitor-live.ts liveOperator. */
    fun operator(agentId: String, stepIndex: Int): Int = (((hash(agentId) + stepIndex) % 5) + 1).toInt()

    fun approvalEnding(b: MonitorProgress.Branch): String? {
        if (!b.approvalAsked || b.state != "SKIPPED") return null
        val reason = (b.tail ?: "").lowercase()
        if (reason.contains("timed out") || reason.contains("timeout")) return "timeout"
        if (reason.contains("declin")) return "declined"
        return null
    }

    fun camState(run: MonitorProgress.Run, b: MonitorProgress.Branch): CamState = when (b.state) {
        "RUNNING" -> CamState.RUNNING
        "WAITING_APPROVAL" -> CamState.APPROVAL
        "DONE" -> CamState.DONE
        "FAILED" -> CamState.FAILED
        "SKIPPED" -> when {
            run.status == "halted" && b.startedAtMs != null -> CamState.STOPPED
            approvalEnding(b) == "declined" -> CamState.STOPPED
            else -> CamState.SKIPPED
        }
        else -> CamState.STANDBY
    }

    fun variant(state: CamState): Variant = when (state) {
        CamState.RUNNING -> Variant.LIVE
        CamState.APPROVAL -> Variant.ALERT
        CamState.FAILED -> Variant.FAIL
        else -> Variant.DIM
    }

    fun outcome(run: MonitorProgress.Run): Outcome {
        if (!run.ended) return Outcome.RUNNING
        val base = when (run.status) {
            "success" -> Outcome.SUCCESS
            "halted" -> Outcome.STOPPED
            "skipped" -> Outcome.SKIPPED
            else -> Outcome.FAILED
        }
        val declined = run.branches.any { approvalEnding(it) == "declined" }
        return if (declined && (base == Outcome.SKIPPED || base == Outcome.FAILED)) Outcome.STOPPED else base
    }

    /** Short label for a provider name as the executor reports it. */
    /** Same table as lib/monitor-live.ts liveProviderLabel (keep in sync). */
    fun providerLabel(p: MonitorProgress.Provider?): String {
        if (p == null) return ""
        return when (p.name) {
            "perplexity" -> "Perplexity"
            "gemini-api" -> "Gemini API"
            "cerebras" -> "Cerebras"
            "groq" -> "Groq"
            "local" -> "Local LLM"
            "cli", "codex", "codex-cli", "cli:codex" -> "Codex CLI"
            "openrouter" -> "OpenRouter"
            "ab-article-eval" -> "A/B eval"
            else -> p.name
        }
    }

    private fun cost(state: CamState, kind: String?, usage: MonitorProgress.Usage?): Cost {
        if (state == CamState.STANDBY || state == CamState.NO_SIGNAL) return Cost.None
        return when (kind) {
            "CLI" -> Cost.Plan
            "LOCAL" -> Cost.Free
            "API" -> {
                val usd = usage?.usd
                val tokens = usage?.tokens ?: 0L
                when {
                    usd != null -> Cost.Money(usd)
                    tokens > 0 -> Cost.Tokens(tokens)
                    else -> Cost.None
                }
            }
            else -> Cost.None
        }
    }

    private fun toneFor(state: CamState): Tone = when (state) {
        CamState.APPROVAL -> Tone.AMBER
        CamState.FAILED -> Tone.FAIL
        CamState.DONE, CamState.STOPPED, CamState.SKIPPED -> Tone.DONE
        else -> Tone.LIVE
    }

    private val SETTLED = setOf(CamState.DONE, CamState.SKIPPED, CamState.FAILED, CamState.STOPPED)

    /** Newest event time of the run (run start or any branch update), else null. */
    fun lastEventMs(run: MonitorProgress.Run): Long? {
        var last = run.startedAtMs
        for (b in run.branches) {
            val u = b.updatedAtMs ?: continue
            if (last == null || u > last) last = u
        }
        return last
    }

    /**
     * Is the run still live? Mirrors lib/monitor-live.ts isRunActive, by event
     * timestamps (never file mtime):
     *  - a run_end ends it;
     *  - an AgentRuntime run of this agent in this process keeps it live;
     *  - the attended JS chain mark (which a JS reload can orphan) only
     *    stretches the silence window from [DEAD_AFTER_MS] to [LOCKED_DEAD_AFTER_MS];
     *  - once the last holder ended with no later event, it is over.
     */
    fun isLive(
        run: MonitorProgress.Run,
        nowMs: Long,
        nativeRunActive: Boolean,
        chainActive: Boolean,
        heldEndedAtMs: Long?
    ): Boolean {
        if (run.ended) return false
        if (nativeRunActive) return true
        val last = lastEventMs(run) ?: return false
        if (!chainActive && heldEndedAtMs != null && last <= heldEndedAtMs + END_GRACE_MS) return false
        val limit = if (chainActive) LOCKED_DEAD_AFTER_MS else DEAD_AFTER_MS
        return nowMs - last < limit
    }

    /**
     * Delay for the re-check alarm that turns a live widget off when its run
     * goes silent (the only thing that would otherwise never wake us), or null
     * when the widget is not live. Armed for EVERY live run, including an
     * in-process AgentRuntime run: if the process dies mid-run, nothing
     * reports the end, and the alarm's refresh in a new process (empty
     * registry) times the run out by its event timestamps. While the run is
     * still going the refresh simply re-arms.
     */
    fun recheckDelayMs(
        run: MonitorProgress.Run?,
        nowMs: Long,
        live: Boolean,
        nativeRunActive: Boolean,
        chainActive: Boolean
    ): Long? {
        if (run == null || !live) return null
        val last = lastEventMs(run) ?: return MIN_RECHECK_MS
        if (nativeRunActive) {
            // A long quiet step of a live runtime run: look again every
            // LOCKED_DEAD_AFTER_MS rather than at the floor.
            val remaining = last + LOCKED_DEAD_AFTER_MS - nowMs + 1_000L
            return if (remaining < MIN_RECHECK_MS) LOCKED_DEAD_AFTER_MS else remaining
        }
        val limit = if (chainActive) LOCKED_DEAD_AFTER_MS else DEAD_AFTER_MS
        return maxOf(MIN_RECHECK_MS, last + limit - nowMs + 1_000L)
    }

    /** Step indices that get a camera: every reported branch plus every step
     *  of the plan (stepCount), so a step with no event yet is STANDBY. Same
     *  set the MONITOR pane shows (lib/monitor-live.ts createLiveSource). */
    fun stepIndices(run: MonitorProgress.Run): List<Int> {
        val set = java.util.TreeSet<Int>()
        run.branches.forEach { set.add(it.stepIndex) }
        for (i in 0 until (run.stepCount ?: 0)) set.add(i)
        return set.toList()
    }

    data class Candidate(
        val run: MonitorProgress.Run,
        val model: Model,
        val nativeActive: Boolean,
        val chainActive: Boolean
    )

    /** lib/monitor-live.ts pickDefaultLiveRun: the most recently started live
     *  run, else the most recently started run; null when there is none. */
    fun pick(candidates: List<Candidate>): Candidate? {
        val start = { c: Candidate -> c.run.startedAtMs ?: Long.MIN_VALUE }
        return candidates.filter { it.model.live }.maxByOrNull(start) ?: candidates.maxByOrNull(start)
    }

    /** First step shown: the window of 4 slides to the first unsettled step. */
    fun windowStart(stepTotal: Int, firstUnsettled: Int?): Int {
        if (stepTotal <= CAMERA_SLOTS) return 0
        val anchor = firstUnsettled ?: (stepTotal - CAMERA_SLOTS)
        return anchor.coerceIn(0, stepTotal - CAMERA_SLOTS)
    }

    /**
     * @param nativeRunActive AgentRuntime is executing this agent in this process
     * @param chainActive the attended JS chain of this agent reported its start
     * @param heldEndedAtMs when the last holder of this agent's run ended (null = not seen)
     */
    fun build(
        run: MonitorProgress.Run,
        nowMs: Long,
        nativeRunActive: Boolean = false,
        chainActive: Boolean = false,
        iteration: Int? = null,
        heldEndedAtMs: Long? = null
    ): Model {
        val byStep = run.branches.associateBy { it.stepIndex }
        val steps = stepIndices(run)
        val states = steps.map { i -> byStep[i]?.let { camState(run, it) } ?: CamState.STANDBY }

        var result = outcome(run)
        val live = result == Outcome.RUNNING && isLive(run, nowMs, nativeRunActive, chainActive, heldEndedAtMs)
        // No run_end and nothing vouches for it any more: it died.
        if (result == Outcome.RUNNING && !live) result = Outcome.FAILED

        val firstUnsettled = states.indexOfFirst { it !in SETTLED }.takeIf { it >= 0 }
        val start = windowStart(steps.size, firstUnsettled)

        val cameras = (0 until CAMERA_SLOTS).map { slot ->
            val pos = start + slot
            if (pos >= steps.size) {
                val step = (steps.lastOrNull() ?: -1) + 1 + (pos - steps.size)
                Camera(
                    slot = slot, stepIndex = null, channel = channel(step), state = CamState.NO_SIGNAL,
                    variant = Variant.DIM, operator = operator(run.agentId, step), kind = null,
                    providerLabel = "", progress = 0, tone = Tone.DONE, cost = Cost.None
                )
            } else {
                val step = steps[pos]
                val b = byStep[step]
                var state = states[pos]
                // A dead run leaves no camera "recording".
                if (!live && (state == CamState.RUNNING || state == CamState.APPROVAL)) state = CamState.STOPPED
                val kind = b?.provider?.kind
                Camera(
                    slot = slot,
                    stepIndex = step,
                    channel = channel(step),
                    state = state,
                    variant = variant(state),
                    operator = operator(run.agentId, step),
                    kind = kind,
                    providerLabel = providerLabel(b?.provider),
                    progress = when {
                        state in SETTLED -> 100
                        state == CamState.RUNNING || state == CamState.APPROVAL -> 50
                        else -> 0
                    },
                    tone = toneFor(state),
                    cost = cost(state, kind, b?.usage)
                )
            }
        }

        // Mission progress over every step (not just the 4 shown).
        val settled = states.count { it in SETTLED }
        val active = states.count { it == CamState.RUNNING || it == CamState.APPROVAL }
        // lib/monitor-live.ts: max(stepCount, cameras, 1).
        val total = maxOf(run.stepCount ?: 0, steps.size, 1)
        val pct = if (result == Outcome.SUCCESS) {
            100
        } else {
            minOf(100, (((settled + (if (live) active * 0.5 else 0.0)) / total) * 100).roundToInt())
        }

        val approvalStep = if (live) states.indexOfFirst { it == CamState.APPROVAL }.takeIf { it >= 0 } else null

        var hasApi = false; var hasCli = false; var hasLocal = false
        var apiUsd: Double? = null; var apiTokens = 0L; var cliTokens = 0L; var localTokens = 0L
        for (b in run.branches) {
            val tokens = b.usage?.tokens ?: 0L
            when (b.provider?.kind) {
                "API" -> {
                    hasApi = true
                    apiTokens += tokens
                    b.usage?.usd?.let { apiUsd = (apiUsd ?: 0.0) + it }
                }
                "CLI" -> { hasCli = true; cliTokens += tokens }
                "LOCAL" -> { hasLocal = true; localTokens += tokens }
            }
        }

        val tone = when {
            approvalStep != null -> Tone.AMBER
            result == Outcome.RUNNING -> Tone.LIVE
            result == Outcome.FAILED -> Tone.FAIL
            else -> Tone.DONE
        }

        return Model(
            agentId = run.agentId,
            runId = run.runId,
            outcome = result,
            live = live,
            missionPct = pct,
            tone = tone,
            runStartMs = run.startedAtMs,
            runEndMs = if (live) null else (run.endedAtMs ?: lastEventMs(run)),
            iteration = iteration?.takeIf { it > 0 },
            approvalChannel = approvalStep?.let { channel(it) },
            approvalStep = approvalStep,
            costLine = CostLine(hasApi, apiUsd, apiTokens, hasCli, cliTokens, hasLocal, localTokens),
            cameras = cameras
        )
    }

    // ── Formatting (pure; the provider resolves the localized words) ──

    const val USD_TO_YEN = 150.0

    /** lib/monitor-source.ts formatMoney: yen for Japanese, dollars otherwise. */
    fun formatMoney(usd: Double, japanese: Boolean): String {
        if (japanese) {
            val yen = usd * USD_TO_YEN
            return if (yen < 10) "¥" + String.format(java.util.Locale.US, "%.2f", yen)
            else "¥" + String.format(java.util.Locale.US, "%,d", yen.roundToInt())
        }
        return "$" + if (usd < 1) String.format(java.util.Locale.US, "%.4f", usd)
        else String.format(java.util.Locale.US, "%.2f", usd)
    }

    /** lib/monitor-source.ts formatTokens. */
    fun formatTokens(n: Long): String =
        if (n >= 1000) String.format(java.util.Locale.US, "%.1fk tok", n / 1000.0) else "$n tok"

    /** Zero in the viewer's currency (LOCAL runs on the device). */
    fun zeroMoney(japanese: Boolean): String = if (japanese) "¥0" else "$0"
}
