package expo.modules.terminalemulator.monitor

import org.json.JSONObject

/**
 * Minimal native port of lib/agent-progress.ts (the reader of
 * `$HOME/.shelly/agents/logs/<agentId>/progress.jsonl`, schema v1, written by
 * scripts/shelly-plan-executor.js and lib/agent-progress-writer.ts) for the
 * MONITOR home-screen widget.
 *
 * Same forgiving rules as the JS reader, because the widget may read the file
 * mid-write:
 *  - malformed / partial lines and events of another schema version are dropped;
 *  - per run, an event whose `seq` is not strictly greater than the last
 *    accepted one is dropped (stale / out-of-order / duplicate);
 *  - a settled branch state (DONE / FAILED / SKIPPED) is never overwritten.
 *
 * Pure: no Android, no I/O. org.json is the only dependency (real on device,
 * `org.json:json` in JVM unit tests).
 */
object MonitorProgress {
    const val SCHEMA_VERSION = 1

    val BRANCH_STATES = setOf("STANDBY", "RUNNING", "WAITING_APPROVAL", "DONE", "FAILED", "SKIPPED")
    val TERMINAL_STATES = setOf("DONE", "FAILED", "SKIPPED")
    private val RUN_MODES = setOf("SINGLE", "SERIAL", "PARALLEL")
    private val PROVIDER_KINDS = setOf("API", "CLI", "LOCAL")
    private val EVENT_KINDS = setOf("run_start", "branch_state", "tool", "tail", "usage", "run_end")

    data class Provider(val kind: String, val name: String, val model: String? = null)

    data class Usage(
        val inputTokens: Double? = null,
        val outputTokens: Double? = null,
        val usd: Double? = null
    ) {
        val tokens: Long get() = ((inputTokens ?: 0.0) + (outputTokens ?: 0.0)).toLong()
    }

    data class Branch(
        val stepIndex: Int,
        val state: String = "STANDBY",
        val tool: String? = null,
        val provider: Provider? = null,
        val tail: String? = null,
        val usage: Usage? = null,
        val startedAtMs: Long? = null,
        val endedAtMs: Long? = null,
        val updatedAtMs: Long? = null,
        val approvalAsked: Boolean = false
    )

    data class Run(
        val runId: String,
        val agentId: String,
        val mode: String = "SERIAL",
        val startedAtMs: Long? = null,
        val endedAtMs: Long? = null,
        /** run_end status: success / error / unavailable / skipped / halted (STOP-ALL). */
        val status: String? = null,
        val stepCount: Int? = null,
        val lastSeq: Int = 0,
        /** Sorted by stepIndex. */
        val branches: List<Branch> = emptyList()
    ) {
        val ended: Boolean get() = endedAtMs != null || status != null
    }

    internal data class Event(
        val runId: String,
        val agentId: String,
        val seq: Int,
        val tsMs: Long?,
        val kind: String,
        val obj: JSONObject
    )

    /** Parses one line; null for anything malformed. */
    internal fun parseLine(line: String): Event? {
        val trimmed = line.trim()
        if (trimmed.isEmpty() || !trimmed.startsWith("{")) return null
        val o = try {
            JSONObject(trimmed)
        } catch (_: Exception) {
            return null
        }
        if (intOrNull(o, "v") != SCHEMA_VERSION) return null
        val runId = nonEmptyString(o, "runId") ?: return null
        val agentId = nonEmptyString(o, "agentId") ?: return null
        val ts = nonEmptyString(o, "ts") ?: return null
        val seq = intOrNull(o, "seq")?.takeIf { it >= 1 } ?: return null
        val kind = nonEmptyString(o, "kind")?.takeIf { it in EVENT_KINDS } ?: return null
        val runLevel = kind == "run_start" || kind == "run_end"
        if (!runLevel && (intOrNull(o, "stepIndex")?.takeIf { it >= 0 } == null)) return null
        if (kind == "branch_state" && nonEmptyString(o, "state") !in BRANCH_STATES) return null
        return Event(runId, agentId, seq, parseIsoMs(ts), kind, o)
    }

    private class MutableRun(var run: Run) {
        val branches = LinkedHashMap<Int, Branch>()
    }

    /** Every run in the text, in order of first appearance. */
    fun parseRuns(text: String): List<Run> {
        val runs = LinkedHashMap<String, MutableRun>()
        for (line in text.split('\n')) {
            val e = parseLine(line) ?: continue
            val entry = runs.getOrPut(e.runId) {
                MutableRun(Run(runId = e.runId, agentId = e.agentId, startedAtMs = e.tsMs))
            }
            if (e.agentId != entry.run.agentId) continue
            if (e.seq <= entry.run.lastSeq) continue
            apply(entry, e)
        }
        return runs.values.map { m -> m.run.copy(branches = m.branches.values.sortedBy { it.stepIndex }) }
    }

    /** The latest run (the last one to start), or null when nothing parses. */
    fun parse(text: String): Run? = parseRuns(text).lastOrNull()

    private fun apply(m: MutableRun, e: Event) {
        m.run = m.run.copy(lastSeq = e.seq)
        val o = e.obj
        when (e.kind) {
            "run_start" -> {
                val mode = nonEmptyString(o, "mode")?.takeIf { it in RUN_MODES }
                val steps = intOrNull(o, "stepCount")?.takeIf { it >= 0 }
                m.run = m.run.copy(
                    startedAtMs = e.tsMs ?: m.run.startedAtMs,
                    mode = mode ?: m.run.mode,
                    stepCount = steps ?: m.run.stepCount
                )
            }
            "run_end" -> {
                m.run = m.run.copy(
                    endedAtMs = e.tsMs ?: m.run.endedAtMs ?: m.run.startedAtMs ?: 0L,
                    status = nonEmptyString(o, "status") ?: m.run.status
                )
            }
            else -> {
                val stepIndex = o.optInt("stepIndex")
                val prev = (m.branches[stepIndex] ?: Branch(stepIndex = stepIndex)).copy(updatedAtMs = e.tsMs)
                val next = when (e.kind) {
                    "branch_state" -> {
                        if (prev.state in TERMINAL_STATES) {
                            prev
                        } else {
                            val state = o.optString("state")
                            prev.copy(
                                state = state,
                                startedAtMs = if (state == "RUNNING" && prev.startedAtMs == null) e.tsMs else prev.startedAtMs,
                                endedAtMs = if (state in TERMINAL_STATES) e.tsMs else prev.endedAtMs,
                                approvalAsked = prev.approvalAsked || state == "WAITING_APPROVAL"
                            )
                        }
                    }
                    "tool" -> prev.copy(
                        tool = nonEmptyString(o, "tool") ?: prev.tool,
                        provider = parseProvider(o.optJSONObject("provider")) ?: prev.provider
                    )
                    "tail" -> if (o.opt("tail") is String) prev.copy(tail = o.optString("tail")) else prev
                    "usage" -> prev.copy(usage = addUsage(prev.usage, o.optJSONObject("usage")))
                    else -> prev
                }
                m.branches[stepIndex] = next
            }
        }
    }

    private fun parseProvider(p: JSONObject?): Provider? {
        if (p == null) return null
        val kind = nonEmptyString(p, "kind")?.takeIf { it in PROVIDER_KINDS } ?: return null
        val name = nonEmptyString(p, "name") ?: return null
        return Provider(kind, name, nonEmptyString(p, "model"))
    }

    private fun addUsage(prev: Usage?, u: JSONObject?): Usage? {
        if (u == null) return prev
        fun field(key: String): Double? {
            val v = u.opt(key)
            if (v !is Number) return null
            val d = v.toDouble()
            return if (d.isFinite() && d >= 0) d else null
        }
        val inT = field("inputTokens")
        val outT = field("outputTokens")
        val usd = field("usd")
        if (inT == null && outT == null && usd == null) return prev
        val base = prev ?: Usage()
        return Usage(
            inputTokens = sum(base.inputTokens, inT),
            outputTokens = sum(base.outputTokens, outT),
            usd = sum(base.usd, usd)
        )
    }

    private fun sum(a: Double?, b: Double?): Double? = if (b == null) a else (a ?: 0.0) + b

    private fun nonEmptyString(o: JSONObject, key: String): String? {
        val v = o.opt(key)
        return if (v is String && v.isNotEmpty()) v else null
    }

    /** Integer-valued JSON number (1 or 1.0), else null. Booleans/strings are rejected. */
    private fun intOrNull(o: JSONObject, key: String): Int? {
        val v = o.opt(key)
        if (v !is Number) return null
        val d = v.toDouble()
        if (!d.isFinite() || d != Math.floor(d) || d > Int.MAX_VALUE || d < Int.MIN_VALUE) return null
        return d.toInt()
    }

    private val ISO = Regex(
        """^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$"""
    )

    /** Epoch ms of an ISO-8601 timestamp as written by `Date#toISOString`
     *  (offsets accepted too), or null. No java.time: minSdk is 24. */
    fun parseIsoMs(text: String): Long? {
        val m = ISO.matchEntire(text.trim()) ?: return null
        val g = m.groupValues
        val year = g[1].toInt()
        val month = g[2].toInt()
        val day = g[3].toInt()
        val hour = g[4].toInt()
        val minute = g[5].toInt()
        val second = g[6].toInt()
        if (month !in 1..12 || day !in 1..31 || hour > 23 || minute > 59 || second > 60) return null
        val millis = if (g[7].isEmpty()) 0 else g[7].padEnd(3, '0').take(3).toInt()
        val offsetMs = if (g[8] == "Z") {
            0L
        } else {
            val sign = if (g[8][0] == '-') -1 else 1
            val digits = g[8].substring(1).replace(":", "")
            sign * (digits.substring(0, 2).toLong() * 60 + digits.substring(2, 4).toLong()) * 60_000L
        }
        val days = daysFromCivil(year, month, day)
        return ((days * 24 + hour) * 60 + minute) * 60_000L + second * 1000L + millis - offsetMs
    }

    /** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm). */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }
}
