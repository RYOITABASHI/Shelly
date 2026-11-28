package expo.modules.terminalemulator

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * The pure part of the residency ledger (shelly-hayato-bridge #6 item 2,
 * "residency evidence"): what one line of `<home>/.shelly/services/<id>/
 * residency.jsonl` looks like, how lines chain, how a chain is verified and
 * how a truncated or replaced tail is detected against the anchor kept in
 * SharedPreferences. ResidencyLedger.kt does the I/O, the Keystore HMAC and
 * the sampling.
 *
 * One line is one JSON object, keys always in this order (the canonical form
 * the MAC covers is exactly the line's bytes up to, not including, `,"mac"`,
 * plus the closing brace):
 *
 *   v, seq, at, elapsedRealtime, bootId, svc, pid, startTicks, startedAt,
 *   alive, heartbeatAt, health, versionCode, reason, code, prev, mac
 *
 * `prev` is the hex SHA-256 of the previous line's exact bytes (without the
 * newline), "" for the first line ever written for that service. `seq` is
 * monotonic per service and survives rotation (residency.jsonl ->
 * residency.jsonl.1, two generations kept).
 *
 * scripts/shelly-mcp-server.js (read_residency) and scripts/residency-judge.js
 * re-implement the chain check; keep them in step with [verify].
 *
 * Pure: no Android imports, so it runs in JVM unit tests (ResidencyLedgerCoreTest).
 */
object ResidencyLedgerCore {
    const val VERSION = 1
    const val FILE = "residency.jsonl"
    const val FILE_PREV = "residency.jsonl.1"
    /** residency.jsonl is rotated to residency.jsonl.1 before it would grow past this. */
    const val MAX_BYTES = 512L * 1024
    /** The periodic sample interval (a chained exact alarm). */
    const val TICK_MS = 10 * 60_000L
    /** A line longer than this is never written (and never read back as a tail). */
    const val MAX_LINE_BYTES = 2048
    /** How much of the end of a file is read to find its last line. */
    const val TAIL_READ_BYTES = 8192
    const val MAX_SEATS = 8

    val REASONS: Set<String> = setOf("tick", "start", "exit", "restart", "stop", "halt", "reconcile", "boot", "overlay")

    private val CODE_RE = Regex("^[a-z0-9_]{1,32}$")
    private val SVC_RE = Regex("^[a-z0-9-]{1,40}$")
    private val SEAT_RE = Regex("^[a-z0-9_-]{1,32}$")
    private val BOOT_ID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val HEX64_RE = Regex("^[0-9a-f]{64}$")
    private val SIGNED_RE = Regex("^(\\{.*),\"mac\":\"([0-9a-f]{64})\"\\}$")
    private val START_TICKS_RE = Regex("^[0-9]{1,19}$")

    /** One /health poll: [ok] = ManagedServices.healthResponseOk, [ms] = how long it took. */
    data class Health(val ok: Boolean, val cliSeatKinds: List<String>?, val ms: Long)

    /** What is known about one service at one moment (no chain fields). */
    data class Sample(
        val at: Long,
        val elapsedRealtime: Long,
        val bootId: String?,
        val svc: String,
        val pid: Int?,
        val startTicks: Long?,
        val startedAt: Long?,
        val alive: Boolean,
        val heartbeatAt: Long?,
        val health: Health?,
        val versionCode: Long,
        val reason: String,
        val code: String?,
    )

    /** The last line written for a service, as kept outside the file (SharedPreferences). */
    data class Anchor(val seq: Long, val hash: String)

    /**
     * Where the next line goes: [seq] and [prev]. [anchorMismatch]: the file's
     * last line is not the anchored one (the file was truncated, replaced or
     * edited); the next line still chains to the anchor, so the break is
     * visible in the file itself.
     */
    data class Link(val seq: Long, val prev: String, val anchorMismatch: Boolean)

    fun bootIdOrNull(raw: String?): String? = raw?.trim()?.lowercase()?.takeIf { BOOT_ID_RE.matches(it) }

    /** Field 22 of /proc/<pid>/stat as CodexRemotePolicy.procStartTime returns it, or null. */
    fun startTicksOrNull(raw: String?): Long? = raw?.takeIf { START_TICKS_RE.matches(it) }?.toLongOrNull()

    /**
     * The ledger reason for a supervisor audit line ([action] start / stop,
     * [code] the audit code ManagedServiceSupervisor wrote, prefixed for an
     * automatic start or stop).
     */
    fun reasonForAudit(action: String, code: String): String = when {
        code == "halted" || code.startsWith("halt_") || code == "reconcile_halted" -> "halt"
        code.startsWith("restart_") -> "restart"
        code.startsWith("reconcile_") || code.startsWith("adopt_") -> "reconcile"
        action == "stop" -> "stop"
        else -> "start"
    }

    /** A code short enough for the line, or null. */
    fun cleanCode(code: String?): String? = code?.takeIf { CODE_RE.matches(it) }

    /**
     * The seat kinds council-tool reports as available, from its /health body
     * `{"ok":true,"cli_seat_kinds":{"codex":true,"claude":false}}`: the keys
     * whose value is exactly `true`, in sorted order (0..[MAX_SEATS] short
     * lowercase names), else null (absent or out of shape).
     */
    fun cliSeatKinds(body: String?): List<String>? {
        if (body == null || body.length > ManagedServices.HEALTH_MAX_BODY) return null
        return try {
            val obj = JSONObject(body).opt("cli_seat_kinds") as? JSONObject ?: return null
            if (obj.length() > MAX_SEATS) return null
            val out = ArrayList<String>()
            for (k in obj.keys()) {
                if (!SEAT_RE.matches(k)) return null
                val v = obj.opt(k) as? Boolean ?: return null
                if (v) out.add(k)
            }
            out.sorted()
        } catch (e: Exception) {
            null
        }
    }

    /** The body of a raw HTTP response (after the first CRLFCRLF), or null. */
    fun httpBody(raw: ByteArray): String? {
        for (i in 0..raw.size - 4) {
            if (raw[i] == 13.toByte() && raw[i + 1] == 10.toByte() && raw[i + 2] == 13.toByte() && raw[i + 3] == 10.toByte()) {
                return String(raw, i + 4, raw.size - i - 4, Charsets.UTF_8)
            }
        }
        return null
    }

    // ── Line building ──────────────────────────────────────────────────────

    private fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2).append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c < ' ' || c == ' ' || c == ' ' -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    private fun num(v: Long?): String = v?.toString() ?: "null"

    /**
     * The canonical (unsigned) line for [s] at [seq] after [prev], or null
     * when a field is out of shape (never a partly valid line).
     */
    fun canonical(s: Sample, seq: Long, prev: String): String? {
        if (seq < 1 || (prev.isNotEmpty() && !HEX64_RE.matches(prev))) return null
        if (!SVC_RE.matches(s.svc) || s.reason !in REASONS) return null
        if (s.code != null && !CODE_RE.matches(s.code)) return null
        if (s.bootId != null && !BOOT_ID_RE.matches(s.bootId)) return null
        if (s.pid != null && s.pid <= 0) return null
        if (s.startTicks != null && s.startTicks < 0) return null
        val health = s.health?.let { h ->
            if (h.ms < 0) return null
            val seats = h.cliSeatKinds?.let { k ->
                if (k.isEmpty() || k.size > MAX_SEATS || k.any { !SEAT_RE.matches(it) }) return null
                k.joinToString(",", "[", "]") { quote(it) }
            }
            buildString {
                append("{\"ok\":").append(h.ok)
                if (seats != null) append(",\"cliSeatKinds\":").append(seats)
                append(",\"ms\":").append(h.ms).append('}')
            }
        }
        return buildString {
            append("{\"v\":").append(VERSION)
            append(",\"seq\":").append(seq)
            append(",\"at\":").append(s.at)
            append(",\"elapsedRealtime\":").append(s.elapsedRealtime)
            append(",\"bootId\":").append(s.bootId?.let { quote(it) } ?: "null")
            append(",\"svc\":").append(quote(s.svc))
            append(",\"pid\":").append(s.pid?.toString() ?: "null")
            append(",\"startTicks\":").append(num(s.startTicks))
            append(",\"startedAt\":").append(num(s.startedAt))
            append(",\"alive\":").append(s.alive)
            append(",\"heartbeatAt\":").append(num(s.heartbeatAt))
            append(",\"health\":").append(health ?: "null")
            append(",\"versionCode\":").append(s.versionCode)
            append(",\"reason\":").append(quote(s.reason))
            append(",\"code\":").append(s.code?.let { quote(it) } ?: "null")
            append(",\"prev\":").append(quote(prev))
            append('}')
        }
    }

    /** The line as written: [canonical] with `"mac":"<hex>"` as its last member. */
    fun signed(canonical: String, macHex: String): String {
        require(canonical.endsWith("}") && HEX64_RE.matches(macHex))
        return canonical.substring(0, canonical.length - 1) + ",\"mac\":\"" + macHex + "\"}"
    }

    /** (canonical, mac) of a signed line, or null when it does not end in a mac member. */
    fun splitSigned(line: String): Pair<String, String>? {
        val m = SIGNED_RE.matchEntire(line) ?: return null
        return Pair(m.groupValues[1] + "}", m.groupValues[2])
    }

    fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** seq / prev / at of a line, or null when it is not a v1 ledger line. */
    data class Head(val seq: Long, val prev: String, val at: Long)

    fun head(line: String?): Head? = try {
        if (line == null || line.length > MAX_LINE_BYTES) null else {
            val o = JSONObject(line)
            val seq = (o.opt("seq") as? Number)?.toLong()
            val at = (o.opt("at") as? Number)?.toLong()
            val prev = o.opt("prev") as? String
            if (o.opt("v") != VERSION || seq == null || seq < 1 || at == null || prev == null ||
                (prev.isNotEmpty() && !HEX64_RE.matches(prev))
            ) null else Head(seq, prev, at)
        }
    } catch (e: Exception) {
        null
    }

    /**
     * The link for the next line from the [anchor] (SharedPreferences) and
     * the file's last line [tail] (current generation, else the rotated one).
     *
     *  - no anchor: continue the file (first use, or app data cleared).
     *  - the tail is the anchored line: continue it.
     *  - the tail is exactly one line past the anchor and chains to it (the
     *    process died between the append and the anchor commit): continue it.
     *  - anything else: continue the anchor and report the mismatch.
     */
    fun resolveLink(anchor: Anchor?, tail: String?): Link {
        val tailHead = head(tail)
        if (anchor == null) {
            if (tail == null || tailHead == null) return Link(1, "", anchorMismatch = false)
            return Link(tailHead.seq + 1, sha256Hex(tail), anchorMismatch = false)
        }
        if (tail != null && tailHead != null) {
            if (tailHead.seq == anchor.seq && sha256Hex(tail) == anchor.hash) {
                return Link(anchor.seq + 1, anchor.hash, anchorMismatch = false)
            }
            if (tailHead.seq == anchor.seq + 1 && tailHead.prev == anchor.hash) {
                return Link(tailHead.seq + 1, sha256Hex(tail), anchorMismatch = false)
            }
        }
        return Link(anchor.seq + 1, anchor.hash, anchorMismatch = true)
    }

    /** True when appending [addBytes] to a file of [size] must rotate it first. */
    fun shouldRotate(size: Long, addBytes: Int): Boolean = size > 0 && size + addBytes > MAX_BYTES

    /**
     * The last complete line in [chunk] (the end of a file, read from
     * [chunkStartsFile] = offset 0 or not), without its newline; null when
     * there is none or it is longer than [MAX_LINE_BYTES]. A chunk that does
     * not end in a newline has a torn last line: it is ignored.
     */
    fun lastLine(chunk: ByteArray, chunkStartsFile: Boolean): String? {
        val nl = '\n'.code.toByte()
        if (chunk.isEmpty()) return null
        // `end` is the index of the newline that closes the last complete line.
        var end = chunk.size - 1
        if (chunk[end] != nl) {
            // No trailing newline: the last line is torn; use the one before it.
            while (end >= 0 && chunk[end] != nl) end--
            if (end < 0) return null
        }
        var start = end - 1
        while (start >= 0 && chunk[start] != nl) start--
        if (start < 0 && !chunkStartsFile) return null
        val from = start + 1
        if (end - from <= 0 || end - from > MAX_LINE_BYTES) return null
        return String(chunk, from, end - from, Charsets.UTF_8)
    }

    // ── Verification ───────────────────────────────────────────────────────

    /**
     * [chainOk] false: the first break is at [brokenAtSeq] (the line whose
     * seq or prev does not follow the line before it) or the window holds an
     * unparseable line ([unparsed] > 0). [macChecked] false when no MAC
     * check was given (macOk / macBad are then 0). [anchorOk] null when no
     * anchor was given; false when the last line is not the anchored one
     * ([truncated] true when the anchor is past the last line).
     */
    data class Verification(
        val lines: Int,
        val firstSeq: Long?,
        val lastSeq: Long?,
        val chainOk: Boolean,
        val brokenAtSeq: Long?,
        val unparsed: Int,
        val macChecked: Boolean,
        val macOk: Int,
        val macBad: Int,
        val anchorOk: Boolean?,
        val truncated: Boolean,
    )

    /**
     * Verifies [lines] (oldest first, both generations, no newlines). The
     * first line's own prev is not checked unless it is seq 1 (prev must be
     * ""): older lines may have rotated away.
     */
    fun verify(lines: List<String>, anchor: Anchor?, macOk: ((canonical: String, mac: String) -> Boolean)?): Verification {
        var chainOk = true
        var brokenAt: Long? = null
        var unparsed = 0
        var good = 0
        var bad = 0
        var prevLine: String? = null
        var prevSeq: Long? = null
        var firstSeq: Long? = null
        var lastSeq: Long? = null
        var afterUnparsed = false
        for (line in lines) {
            val h = head(line)
            if (h == null) {
                unparsed++
                chainOk = false
                afterUnparsed = true
                prevLine = null
                prevSeq = null
                continue
            }
            if (firstSeq == null) firstSeq = h.seq
            lastSeq = h.seq
            val linkOk = if (prevLine == null || prevSeq == null) {
                // The first parseable line of the window (or after an unparseable
                // one): only seq 1 can be checked (its prev must be "").
                !(h.seq == 1L && h.prev.isNotEmpty())
            } else {
                h.seq == prevSeq + 1 && h.prev == sha256Hex(prevLine)
            }
            if (!linkOk || afterUnparsed) {
                chainOk = false
                if (brokenAt == null) brokenAt = h.seq
            }
            afterUnparsed = false
            if (macOk != null) {
                val split = splitSigned(line)
                if (split != null && runCatching { macOk(split.first, split.second) }.getOrDefault(false)) good++ else bad++
            }
            prevLine = line
            prevSeq = h.seq
        }
        var anchorOk: Boolean? = null
        var truncated = false
        if (anchor != null) {
            val last = lines.lastOrNull()
            anchorOk = last != null && head(last)?.seq == anchor.seq && sha256Hex(last) == anchor.hash
            truncated = (lastSeq ?: 0L) < anchor.seq
        }
        return Verification(
            lines = lines.size, firstSeq = firstSeq, lastSeq = lastSeq,
            chainOk = chainOk, brokenAtSeq = brokenAt, unparsed = unparsed,
            macChecked = macOk != null, macOk = good, macBad = bad,
            anchorOk = anchorOk, truncated = truncated,
        )
    }

    /** Splits a file's bytes into lines (no newlines); a torn last line (no newline) is kept as is. */
    fun splitLines(bytes: ByteArray): List<String> =
        String(bytes, Charsets.UTF_8).split('\n').let { if (it.lastOrNull() == "") it.dropLast(1) else it }
}
