package expo.modules.terminalemulator

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/**
 * Run tickets for agent runs started through MCP `run_agent` (plan: typed MCP
 * operations with always-allow rules, section (c) "Run state store").
 *
 * One file per run: `$HOME/.shelly-mcp-queue/runs/<handle>.json` (owner-only,
 * written as tmp + rename). `get_run_result` reads it. States:
 *
 *   accepted -> running -> succeeded | failed | skipped | cancelled | lost
 *
 * `accepted` is written by TerminalEmulatorModule.runAgentForMcp BEFORE the
 * intent is sent, so a lost intent shows up as `lost` (the stale rule) and
 * never as a silent hole. TerminalSessionService moves it to `running` and to
 * a terminal state.
 *
 * Integrity: the files are same-uid writable like everything under $HOME. A
 * forged ticket can only make `get_run_result` lie to the MCP client, which is
 * why every result is labelled untrusted there. Nothing here grants anything.
 *
 * The pure half (codec, transitions, stale rule, run-log choice, outcome
 * mapping, pruning) has no Android dependency and is unit-tested by
 * McpRunTicketsTest. The I/O half below it needs a device.
 */
object McpRunTickets {
    private const val TAG = "McpRunTickets"

    const val VERSION = 1
    const val STATE_ACCEPTED = "accepted"
    const val STATE_RUNNING = "running"
    const val STATE_SUCCEEDED = "succeeded"
    const val STATE_FAILED = "failed"
    const val STATE_SKIPPED = "skipped"
    const val STATE_CANCELLED = "cancelled"
    const val STATE_LOST = "lost"

    val TERMINAL_STATES: Set<String> = setOf(STATE_SUCCEEDED, STATE_FAILED, STATE_SKIPPED, STATE_CANCELLED, STATE_LOST)
    val ALL_STATES: Set<String> = setOf(STATE_ACCEPTED, STATE_RUNNING) + TERMINAL_STATES

    /** Short reason codes only; never free text from the run. */
    const val REASON_CRASHED = "crashed"
    const val REASON_HALTED = "halted"
    const val REASON_BUSY = "busy"
    const val REASON_DISABLED = "disabled"
    const val REASON_BACKOFF = "backoff"
    const val REASON_REFUSED = "refused"
    const val REASON_ERROR = "error"
    const val REASON_UNAVAILABLE = "unavailable"
    const val REASON_STALE = "stale"
    const val REASON_LAUNCH_FAILED = "launch_failed"
    /** The MCP token was regenerated while the run was live (cancelLive). */
    const val REASON_REVOKED = "revoked"
    /** Refused at start (McpRunAuthorization): the signed deadline passed before the service started it. */
    const val REASON_EXPIRED = "expired"
    /** Refused at start: the agent was edited after the approval (binding differs). */
    const val REASON_TARGET_CHANGED = "target_changed"
    /** Refused at start: no launch grant for this handle (never registered, used, or process restarted). */
    const val REASON_UNAUTHORIZED = "unauthorized"
    val REASONS: Set<String> = setOf(
        REASON_CRASHED, REASON_HALTED, REASON_BUSY, REASON_DISABLED, REASON_BACKOFF,
        REASON_REFUSED, REASON_ERROR, REASON_UNAVAILABLE, REASON_STALE, REASON_LAUNCH_FAILED,
        REASON_REVOKED, REASON_EXPIRED, REASON_TARGET_CHANGED, REASON_UNAUTHORIZED,
    )

    /** Native exit codes for a run refused before it started (AgentRuntime). */
    val SKIP_EXIT_CODES: Set<Int> = setOf(129, 130)

    const val ACCEPTED_STALE_MS = 2L * 60L * 1000L
    const val RUNNING_STALE_MS = 35L * 60L * 1000L
    const val RETENTION_MS = 24L * 60L * 60L * 1000L
    const val MAX_PER_PRINCIPAL = 100
    const val MAX_OUTPUT_BYTES = 64 * 1024
    const val MAX_TICKET_CHARS = 16 * 1024
    const val MAX_PREVIEW_CHARS = 500
    const val MAX_ERROR_CHARS = 500
    const val MAX_SAVED_PATH_CHARS = 1024
    private const val MAX_RUN_LOG_BYTES = 256L * 1024L

    private val HANDLE_RE = Regex("^mr_[0-9a-f]{32}$")
    private val PRINCIPAL_RE = Regex("^[0-9a-f]{32}$")
    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val REQUEST_ID_RE = Regex("^[A-Za-z0-9_-]{8,64}$")
    private val TICKET_KEYS = setOf(
        "v", "handle", "principal", "requestId", "agentId", "state", "reason", "acceptedAt",
        "startedAt", "finishedAt", "exitCode", "runLog", "outputFile",
    )
    private val RUN_LOG_KEYS = setOf("timestamp", "status", "outputPreview", "errorMessage", "savedPath")

    fun isValidHandle(h: String?): Boolean = h != null && HANDLE_RE.matches(h)
    fun isValidPrincipal(p: String?): Boolean = p != null && PRINCIPAL_RE.matches(p)
    fun isValidAgentId(a: String?): Boolean = a != null && AGENT_ID_RE.matches(a)
    fun isValidRequestId(r: String?): Boolean = r == null || REQUEST_ID_RE.matches(r)
    fun isTerminal(state: String): Boolean = state in TERMINAL_STATES

    /** The summary of one run log (a `.json` file in `~/.shelly/agents/logs/<id>/`) copied into a ticket. */
    data class RunLogSummary(
        val timestamp: Long,
        val status: String,
        val outputPreview: String,
        val errorMessage: String,
        val savedPath: String?,
    )

    data class Ticket(
        val handle: String,
        val principal: String,
        val requestId: String?,
        val agentId: String,
        val state: String,
        val reason: String?,
        val acceptedAt: Long,
        val startedAt: Long?,
        val finishedAt: Long?,
        val exitCode: Int?,
        val runLog: RunLogSummary?,
        val outputFile: String?,
    )

    fun isValidTicket(t: Ticket): Boolean =
        isValidHandle(t.handle) && isValidPrincipal(t.principal) && isValidRequestId(t.requestId) &&
            isValidAgentId(t.agentId) && t.state in ALL_STATES && (t.reason == null || t.reason in REASONS) &&
            t.acceptedAt >= 0 && (t.startedAt == null || t.startedAt >= 0) && (t.finishedAt == null || t.finishedAt >= 0) &&
            (t.outputFile == null || t.outputFile == outputFileName(t.handle))

    fun outputFileName(handle: String): String = "$handle.out"

    fun newTicket(handle: String, principal: String, requestId: String?, agentId: String, now: Long): Ticket? {
        val t = Ticket(handle, principal, requestId, agentId, STATE_ACCEPTED, null, now, null, null, null, null, null)
        return if (isValidTicket(t)) t else null
    }

    // ── Codec ────────────────────────────────────────────────────────────────

    fun encode(t: Ticket): String {
        val o = JSONObject()
            .put("v", VERSION)
            .put("handle", t.handle)
            .put("principal", t.principal)
            .put("agentId", t.agentId)
            .put("state", t.state)
            .put("acceptedAt", t.acceptedAt)
        if (t.requestId != null) o.put("requestId", t.requestId)
        if (t.reason != null) o.put("reason", t.reason)
        if (t.startedAt != null) o.put("startedAt", t.startedAt)
        if (t.finishedAt != null) o.put("finishedAt", t.finishedAt)
        if (t.exitCode != null) o.put("exitCode", t.exitCode)
        if (t.runLog != null) {
            val l = JSONObject()
                .put("timestamp", t.runLog.timestamp)
                .put("status", t.runLog.status)
                .put("outputPreview", t.runLog.outputPreview)
                .put("errorMessage", t.runLog.errorMessage)
            if (t.runLog.savedPath != null) l.put("savedPath", t.runLog.savedPath)
            o.put("runLog", l)
        }
        if (t.outputFile != null) o.put("outputFile", t.outputFile)
        return o.toString()
    }

    private fun keysOf(o: JSONObject): Set<String> {
        val out = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) out.add(it.next())
        return out
    }

    private fun optLongStrict(o: JSONObject, key: String): Long? {
        if (!o.has(key)) return null
        val v = o.get(key)
        if (v !is Int && v !is Long) throw IllegalArgumentException(key)
        return (v as Number).toLong()
    }

    private fun optStringStrict(o: JSONObject, key: String): String? {
        if (!o.has(key)) return null
        return o.get(key) as? String ?: throw IllegalArgumentException(key)
    }

    /** Null when anything is off (unknown version or key, a malformed field). */
    fun decode(text: String): Ticket? {
        try {
            if (text.length > MAX_TICKET_CHARS) return null
            val o = JSONObject(text)
            if (!TICKET_KEYS.containsAll(keysOf(o))) return null
            if (o.opt("v") != VERSION) return null
            val exit = optLongStrict(o, "exitCode")
            if (exit != null && (exit < Int.MIN_VALUE || exit > Int.MAX_VALUE)) return null
            val runLog = if (o.has("runLog")) {
                val l = o.get("runLog") as? JSONObject ?: return null
                if (!RUN_LOG_KEYS.containsAll(keysOf(l))) return null
                RunLogSummary(
                    timestamp = optLongStrict(l, "timestamp") ?: return null,
                    status = optStringStrict(l, "status") ?: return null,
                    outputPreview = optStringStrict(l, "outputPreview") ?: return null,
                    errorMessage = optStringStrict(l, "errorMessage") ?: return null,
                    savedPath = optStringStrict(l, "savedPath"),
                )
            } else null
            val t = Ticket(
                handle = optStringStrict(o, "handle") ?: return null,
                principal = optStringStrict(o, "principal") ?: return null,
                requestId = optStringStrict(o, "requestId"),
                agentId = optStringStrict(o, "agentId") ?: return null,
                state = optStringStrict(o, "state") ?: return null,
                reason = optStringStrict(o, "reason"),
                acceptedAt = optLongStrict(o, "acceptedAt") ?: return null,
                startedAt = optLongStrict(o, "startedAt"),
                finishedAt = optLongStrict(o, "finishedAt"),
                exitCode = exit?.toInt(),
                runLog = runLog,
                outputFile = optStringStrict(o, "outputFile"),
            )
            return if (isValidTicket(t)) t else null
        } catch (e: Exception) {
            return null
        }
    }

    // ── Transitions ──────────────────────────────────────────────────────────

    /** accepted -> running; accepted|running -> any terminal state; nothing leaves a terminal state. */
    fun canTransition(from: String, to: String): Boolean = when (from) {
        STATE_ACCEPTED -> to == STATE_RUNNING || to in TERMINAL_STATES
        STATE_RUNNING -> to in TERMINAL_STATES
        else -> false
    }

    /** Null when the ticket is not `accepted`. */
    fun withRunning(t: Ticket, now: Long): Ticket? =
        if (canTransition(t.state, STATE_RUNNING)) t.copy(state = STATE_RUNNING, startedAt = now) else null

    /**
     * May the service run [agentId] for this ticket? Only an `accepted`, not yet
     * stale ticket for the same agent and principal.
     */
    fun mayStart(t: Ticket, agentId: String, principal: String?, now: Long): Boolean =
        t.agentId == agentId && principal != null && t.principal == principal &&
            applyStale(t, now).state == STATE_ACCEPTED

    /** Null when [state] is not terminal or the ticket already finished. */
    fun withFinished(
        t: Ticket,
        state: String,
        reason: String?,
        exitCode: Int?,
        runLog: RunLogSummary?,
        outputFile: String?,
        now: Long,
    ): Ticket? {
        if (state !in TERMINAL_STATES || !canTransition(t.state, state)) return null
        if (reason != null && reason !in REASONS) return null
        return t.copy(
            state = state,
            reason = reason,
            finishedAt = now,
            exitCode = exitCode,
            runLog = runLog,
            outputFile = outputFile,
        )
    }

    /**
     * The stale rule: `accepted` for longer than [ACCEPTED_STALE_MS] (the intent
     * never reached the service) or `running` for longer than [RUNNING_STALE_MS]
     * (past the ~30 min native wall clock; the process died) becomes `lost`.
     * Returns the ticket unchanged otherwise.
     */
    fun applyStale(t: Ticket, now: Long): Ticket {
        val stale = when (t.state) {
            STATE_ACCEPTED -> now - t.acceptedAt > ACCEPTED_STALE_MS
            STATE_RUNNING -> now - (t.startedAt ?: t.acceptedAt) > RUNNING_STALE_MS
            else -> false
        }
        return if (stale) t.copy(state = STATE_LOST, reason = REASON_STALE, finishedAt = now) else t
    }

    /**
     * Token revoke: a live (accepted / running, after the stale rule) ticket of
     * [principal] (null = any principal) becomes `cancelled`/`revoked`. Null
     * when there is nothing to cancel. An `accepted` ticket cancelled here is
     * never started (markRunning refuses it); a `running` one keeps running
     * but its ticket stays cancelled (markFinished can't leave a terminal state).
     */
    fun withCancelled(t: Ticket, principal: String?, now: Long): Ticket? {
        if (principal != null && t.principal != principal) return null
        val s = applyStale(t, now)
        if (isTerminal(s.state)) return null
        return withFinished(s, STATE_CANCELLED, REASON_REVOKED, null, null, null, now)
    }

    // ── Run log choice and outcome ───────────────────────────────────────────

    private fun clip(s: String, max: Int): String {
        if (s.length <= max) return s
        var end = max
        if (end > 0 && Character.isHighSurrogate(s[end - 1])) end--
        return s.substring(0, end)
    }

    /**
     * Parses one run-log file's text. Null when it is not a log of [agentId]
     * with a numeric millisecond `timestamp` and a string `status`.
     */
    fun parseRunLog(text: String, agentId: String): RunLogSummary? = try {
        val o = JSONObject(text)
        val ts = o.opt("timestamp")
        val status = o.opt("status")
        if (o.optString("agentId") != agentId || (ts !is Int && ts !is Long) || status !is String) {
            null
        } else {
            val saved = o.opt("savedPath") as? String
            RunLogSummary(
                timestamp = (ts as Number).toLong(),
                status = clip(status, 32),
                outputPreview = clip(o.opt("outputPreview") as? String ?: "", MAX_PREVIEW_CHARS),
                errorMessage = clip(o.opt("errorMessage") as? String ?: "", MAX_ERROR_CHARS),
                savedPath = saved?.takeIf { it.isNotEmpty() && it.length <= MAX_SAVED_PATH_CHARS },
            )
        }
    } catch (e: Exception) {
        null
    }

    /**
     * Was a log stamped [timestamp] written during this run? At or after
     * [runStartMs] — the rule TerminalSessionService.scheduledRunFailed uses —
     * and, unlike there, at or before [runEndMs], so a NEXT run that starts
     * before the ticket is finished cannot lend its log. A whole-second stamp
     * (the legacy .sh executor's `${TS}000`) is compared with runStartMs floored
     * to the second; a millisecond stamp (PlanSpec executor, native receiver
     * logs) with runStartMs itself, so an earlier run's log from the same second
     * does not count. Residual: a .sh log of an earlier run that ended in the
     * very second this run began; the per-agent lock makes such an overlap end
     * this run as skipped (its own ms receiver log is then newer).
     */
    fun isWithinRun(timestamp: Long, runStartMs: Long, runEndMs: Long): Boolean {
        val lower = if (timestamp % 1000L == 0L) (runStartMs / 1000L) * 1000L else runStartMs
        return timestamp >= lower && timestamp <= runEndMs
    }

    /**
     * This run's log: the newest one [isWithinRun]. Null when no log qualifies
     * (the run died before writing one, or never started): the ticket then
     * relies on the exit code alone.
     */
    fun chooseRunLog(logs: List<RunLogSummary>, runStartMs: Long, runEndMs: Long): RunLogSummary? =
        logs.filter { isWithinRun(it.timestamp, runStartMs, runEndMs) }.maxByOrNull { it.timestamp }

    /** A short reason code for a refused/skipped run, from its (untrusted) message. */
    fun skipReason(message: String?): String {
        val m = message?.lowercase() ?: return REASON_REFUSED
        return when {
            "kill-switch" in m || "all agents are stopped" in m || "halted" in m -> REASON_HALTED
            "previous run still active" in m || "still active" in m || "lock held" in m -> REASON_BUSY
            "disabled" in m -> REASON_DISABLED
            "backoff" in m -> REASON_BACKOFF
            else -> REASON_REFUSED
        }
    }

    data class Outcome(val state: String, val reason: String?)

    /**
     * Pure outcome of a finished run. [exitCode] null means the runtime crashed
     * or returned nothing (`failed`/`crashed`). Exit codes 129/130 (refused
     * before start) are `skipped`. Otherwise the run log's status wins:
     * success -> succeeded, error/unavailable -> failed, skipped -> skipped;
     * with no usable log the exit code decides (0 -> succeeded, else failed).
     * A log never upgrades a non-zero exit: `success` needs exit code 0.
     */
    fun outcomeOf(exitCode: Int?, stderr: String?, log: RunLogSummary?): Outcome {
        if (exitCode == null) return Outcome(STATE_FAILED, REASON_CRASHED)
        if (exitCode in SKIP_EXIT_CODES) return Outcome(STATE_SKIPPED, skipReason(log?.errorMessage?.takeIf { it.isNotEmpty() } ?: stderr))
        return when (log?.status) {
            "success" -> if (exitCode == 0) Outcome(STATE_SUCCEEDED, null) else Outcome(STATE_FAILED, REASON_ERROR)
            "error" -> Outcome(STATE_FAILED, REASON_ERROR)
            "unavailable" -> Outcome(STATE_FAILED, REASON_UNAVAILABLE)
            "skipped" -> Outcome(STATE_SKIPPED, skipReason(log?.errorMessage))
            else -> if (exitCode == 0) Outcome(STATE_SUCCEEDED, null) else Outcome(STATE_FAILED, REASON_ERROR)
        }
    }

    // ── requestId idempotency and the busy limit (both consumers) ────────────

    /** lib/mcp-typed-ops.ts REQUEST_ID_WINDOW_MS. */
    const val REQUEST_ID_WINDOW_MS = 10L * 60L * 1000L
    /** lib/mcp-typed-ops.ts MAX_LIVE_RUNS_PER_PRINCIPAL. */
    const val MAX_LIVE_RUNS_PER_PRINCIPAL = 2

    /**
     * lib/mcp-typed-ops.ts findIdempotentTicket: same principal and requestId,
     * accepted within [REQUEST_ID_WINDOW_MS] (and not more than a minute in the
     * future); the newest such ticket.
     */
    fun findIdempotent(tickets: List<Ticket>, principal: String, requestId: String, now: Long): Ticket? =
        tickets.filter {
            it.principal == principal && it.requestId == requestId &&
                now - it.acceptedAt <= REQUEST_ID_WINDOW_MS && it.acceptedAt - now <= 60_000L
        }.maxByOrNull { it.acceptedAt }

    /** lib/mcp-typed-ops.ts liveRunCount, on tickets with the stale rule applied. */
    fun liveCount(tickets: List<Ticket>, principal: String, now: Long): Int =
        tickets.count { it.principal == principal && !isTerminal(applyStale(it, now).state) }

    sealed class Accept {
        /** The accepted ticket was written; send the intent. */
        object Written : Accept()
        /** [ticket] already holds this principal's requestId: return it, launch nothing. */
        data class Existing(val ticket: Ticket) : Accept()
        object Busy : Accept()
        /** [beforeWrite] said no; nothing was written. */
        object Refused : Accept()
        object Failed : Accept()
    }

    // ── Pruning ──────────────────────────────────────────────────────────────

    /** What pruning needs to know about one ticket file. */
    data class PruneEntry(val handle: String, val principal: String, val state: String, val acceptedAt: Long)

    /**
     * Handles to delete: every ticket accepted more than [RETENTION_MS] ago, then,
     * per principal, the oldest beyond [MAX_PER_PRINCIPAL]. A live ticket
     * (accepted / running) is never removed by the count cap; the stale rule
     * ends those first.
     */
    fun handlesToPrune(entries: List<PruneEntry>, now: Long): Set<String> {
        val out = HashSet<String>()
        val kept = ArrayList<PruneEntry>()
        for (e in entries) {
            if (now - e.acceptedAt > RETENTION_MS) out.add(e.handle) else kept.add(e)
        }
        for ((_, group) in kept.groupBy { it.principal }) {
            if (group.size <= MAX_PER_PRINCIPAL) continue
            var excess = group.size - MAX_PER_PRINCIPAL
            for (e in group.sortedWith(compareBy<PruneEntry>({ it.acceptedAt }, { it.handle }))) {
                if (excess <= 0) break
                if (!isTerminal(e.state)) continue
                out.add(e.handle)
                excess--
            }
        }
        return out
    }

    /**
     * Pure: [bytes] cut to at most [maxBytes] without splitting a UTF-8 sequence,
     * decoded strictly. Null when the bytes are not valid UTF-8.
     */
    fun utf8Prefix(bytes: ByteArray, maxBytes: Int): String? {
        var end = minOf(bytes.size, maxOf(0, maxBytes))
        if (end < bytes.size) {
            // Back off continuation bytes (10xxxxxx) and the lead byte they belong to.
            while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, 0, end))
                .toString()
        } catch (e: CharacterCodingException) {
            null
        }
    }

    // ── I/O (device only) ────────────────────────────────────────────────────

    fun runsDir(context: Context): File = File(HomeInitializer.getHomeDir(context), ".shelly-mcp-queue/runs")

    private fun ensureRunsDir(context: Context): File {
        val dir = runsDir(context)
        dir.mkdirs()
        if (!OsConstants.S_ISDIR(Os.lstat(dir.path).st_mode)) throw java.io.IOException("runs is not a directory")
        dir.setReadable(false, false)
        dir.setReadable(true, true)
        dir.setWritable(false, false)
        dir.setWritable(true, true)
        dir.setExecutable(false, false)
        dir.setExecutable(true, true)
        return dir
    }

    /** lstat-based: true for a dangling symlink too. */
    private fun lexists(file: File): Boolean = try {
        Os.lstat(file.path)
        true
    } catch (e: Exception) {
        false
    }

    private fun isRegularFile(file: File): Boolean = try {
        OsConstants.S_ISREG(Os.lstat(file.path).st_mode)
    } catch (e: Exception) {
        false
    }

    private fun lstatIfPresent(file: File) = try {
        Os.lstat(file.path)
    } catch (e: ErrnoException) {
        if (e.errno != OsConstants.ENOENT) throw e
        null
    }

    /** At most [maxBytes] of a regular (not symlinked) file; null when missing or not regular. */
    private fun readCapped(file: File, maxBytes: Int, failOnStatError: Boolean = false): ByteArray? {
        val regular = if (failOnStatError) {
            lstatIfPresent(file)?.let { OsConstants.S_ISREG(it.st_mode) } == true
        } else {
            isRegularFile(file)
        }
        if (!regular) return null
        val stream = try {
            FileInputStream(file)
        } catch (e: FileNotFoundException) {
            if (failOnStatError && lstatIfPresent(file) == null) return null
            throw e
        }
        stream.use { input ->
            val buf = ByteArray(maxBytes)
            var n = 0
            while (n < maxBytes) {
                val r = input.read(buf, n, maxBytes - n)
                if (r < 0) break
                n += r
            }
            return buf.copyOf(n)
        }
    }

    /**
     * At most [maxBytes] of [file], only when the file this read actually
     * opened was last written within [startMs, endMs]. Everything is checked
     * against the open descriptor: it is a regular file, the path still names
     * that same inode (not a symlink, not replaced by a next run's atomic
     * rename), its millisecond mtime is in range, and its size and mtime did
     * not change while it was read. Null otherwise.
     */
    private fun readIfWrittenWithin(file: File, startMs: Long, endMs: Long, maxBytes: Int): ByteArray? {
        FileInputStream(file).use { input ->
            val fd = input.fd
            val before = Os.fstat(fd)
            if (!OsConstants.S_ISREG(before.st_mode)) return null
            val mtime = file.lastModified()
            val atPath = Os.lstat(file.path)
            if (atPath.st_ino != before.st_ino || atPath.st_dev != before.st_dev) return null
            if (mtime < startMs || mtime > endMs) return null
            val buf = ByteArray(maxBytes)
            var n = 0
            while (n < maxBytes) {
                val r = input.read(buf, n, maxBytes - n)
                if (r < 0) break
                n += r
            }
            val after = Os.fstat(fd)
            if (after.st_mtime != before.st_mtime || after.st_size != before.st_size) return null
            val again = Os.lstat(file.path)
            if (again.st_ino != before.st_ino || again.st_dev != before.st_dev) return null
            return buf.copyOf(n)
        }
    }

    private fun ticketFile(dir: File, handle: String): File = File(dir, "$handle.json")

    private fun readTicketFile(dir: File, handle: String, failOnStatError: Boolean = false): Ticket? {
        val f = ticketFile(dir, handle)
        val bytes = readCapped(f, MAX_TICKET_CHARS + 1, failOnStatError) ?: return null
        if (bytes.size > MAX_TICKET_CHARS) return null
        val t = decode(String(bytes, Charsets.UTF_8)) ?: return null
        return if (t.handle == handle) t else null
    }

    private fun writeTicket(dir: File, t: Ticket) {
        ClosePawRunResults.writePrivateAtomic(ticketFile(dir, t.handle), encode(t))
    }

    /** [incoming]: the ticket about to be written, counted so the cap holds after the write. */
    private fun prune(dir: File, now: Long, incoming: PruneEntry?) {
        val files = dir.listFiles() ?: return
        val entries = ArrayList<PruneEntry>()
        if (incoming != null) entries.add(incoming)
        val known = HashSet<String>()
        for (f in files) {
            val name = f.name
            if (!name.endsWith(".json")) continue
            val handle = name.removeSuffix(".json")
            val t = if (isValidHandle(handle)) readTicketFile(dir, handle) else null
            if (t == null) {
                // Not a ticket this code wrote (or unreadable): only age removes it.
                if (now - f.lastModified() > RETENTION_MS) f.delete()
                continue
            }
            known.add(handle)
            entries.add(PruneEntry(handle, t.principal, applyStale(t, now).state, t.acceptedAt))
        }
        val drop = handlesToPrune(entries, now) - setOfNotNull(incoming?.handle)
        for (h in drop) {
            ticketFile(dir, h).delete()
            File(dir, outputFileName(h)).delete()
        }
        // Output snapshots and leftovers whose ticket is gone.
        for (f in files) {
            val name = f.name
            if (name.endsWith(".json")) continue
            val base = name.substringBefore('.')
            if (base in known && base !in drop && name == outputFileName(base)) continue
            if (name.endsWith(".tmp") && now - f.lastModified() <= ACCEPTED_STALE_MS) continue
            f.delete()
        }
    }

    /**
     * Writes the `accepted` ticket. False (nothing sent) when an argument is
     * invalid, the handle is already used, or the write fails.
     */
    @Synchronized
    fun writeAccepted(context: Context, handle: String, principal: String, requestId: String?, agentId: String): Boolean {
        val now = System.currentTimeMillis()
        val t = newTicket(handle, principal, requestId, agentId, now) ?: return false
        return try {
            val dir = ensureRunsDir(context)
            runCatching { prune(dir, now, PruneEntry(t.handle, t.principal, t.state, t.acceptedAt)) }.onFailure { Log.w(TAG, "prune failed type=${it.javaClass.simpleName}") }
            val f = ticketFile(dir, handle)
            if (lexists(f) || lexists(File(dir, outputFileName(handle)))) {
                Log.w(TAG, "run handle already used")
                return false
            }
            writeTicket(dir, t)
            true
        } catch (e: Exception) {
            Log.w(TAG, "accepted ticket write failed type=${e.javaClass.simpleName}")
            false
        }
    }

    /** Every decodable ticket of [principal] in [dir] (raw, stale rule not applied). */
    private fun ticketsOf(dir: File, principal: String): List<Ticket> {
        if (!lexists(dir)) return emptyList()
        val files = dir.listFiles() ?: throw java.io.IOException("runs not listable")
        val out = ArrayList<Ticket>()
        for (f in files) {
            val name = f.name
            if (!name.endsWith(".json")) continue
            val handle = name.removeSuffix(".json")
            if (!isValidHandle(handle)) continue
            val t = readTicketFile(dir, handle) ?: continue
            if (t.principal == principal) out.add(t)
        }
        return out
    }

    /**
     * Read only: [principal]'s ticket for [requestId] inside the window (stale
     * rule applied), or null — also on any read error (the launch then goes
     * through [acceptForMcp], which checks again under this lock). For the
     * headless consumer's "repeated requestId returns the existing run" step.
     */
    @Synchronized
    fun findIdempotentForMcp(context: Context, principal: String, requestId: String): Ticket? = try {
        if (!isValidPrincipal(principal) || !isValidRequestId(requestId)) {
            null
        } else {
            val now = System.currentTimeMillis()
            findIdempotent(ticketsOf(runsDir(context), principal), principal, requestId, now)?.let { applyStale(it, now) }
        }
    } catch (e: Exception) {
        Log.w(TAG, "findIdempotentForMcp failed type=${e.javaClass.simpleName}")
        null
    }

    /**
     * The single create-if-absent both MCP launch paths use (RN's
     * runAgentForMcp and the headless McpTypedOpConsumer), under this object's
     * lock: a ticket of [principal] with [requestId] inside the window wins
     * (Existing, nothing written), then the busy limit, then [beforeWrite]
     * (the caller's last re-check + audit line; false = Refused), then the
     * `accepted` ticket is written. A client retrying after a timeout can land
     * on either path and still gets one run.
     */
    @Synchronized
    fun acceptForMcp(
        context: Context,
        handle: String,
        principal: String,
        requestId: String?,
        agentId: String,
        beforeWrite: () -> Boolean,
    ): Accept {
        return try {
            if (!isValidHandle(handle) || !isValidPrincipal(principal) || !isValidRequestId(requestId) || !isValidAgentId(agentId)) {
                return Accept.Failed
            }
            val now = System.currentTimeMillis()
            val mine = ticketsOf(runsDir(context), principal)
            if (requestId != null) {
                findIdempotent(mine, principal, requestId, now)?.let { return Accept.Existing(applyStale(it, now)) }
            }
            if (liveCount(mine, principal, now) >= MAX_LIVE_RUNS_PER_PRINCIPAL) return Accept.Busy
            if (!beforeWrite()) return Accept.Refused
            if (writeAccepted(context, handle, principal, requestId, agentId)) Accept.Written else Accept.Failed
        } catch (e: Exception) {
            Log.w(TAG, "acceptForMcp failed type=${e.javaClass.simpleName}")
            Accept.Failed
        }
    }

    /**
     * Moves an `accepted` ticket to `running`. False when there is no such
     * ticket, it is for another agent or principal, it is not `accepted`
     * (already ran, or ended as lost / cancelled), it is stale, [authorize]
     * refuses, or the write fails: the caller then does NOT run the agent.
     *
     * [authorize] (McpRunLauncher.authorizeStart) runs under this object's
     * lock — the same lock as [cancelLive] (token revoke) — right before the
     * transition: the launch grant (signed deadline, approved binding, rule)
     * re-checked against the current state. A refusal (a ticket reason) ends
     * the ticket `skipped` with that reason. Never throws.
     */
    @Synchronized
    fun markRunning(context: Context, handle: String, agentId: String, principal: String?, authorize: () -> String?): Boolean {
        try {
            if (!isValidHandle(handle)) return false
            val dir = ensureRunsDir(context)
            val t = readTicketFile(dir, handle) ?: run {
                Log.w(TAG, "markRunning: no ticket")
                return false
            }
            val now = System.currentTimeMillis()
            if (!mayStart(t, agentId, principal, now)) {
                Log.w(TAG, "markRunning: ticket does not allow this run (state=${t.state})")
                return false
            }
            val refused = try { authorize() } catch (e: Exception) { REASON_UNAUTHORIZED }
            if (refused != null) {
                Log.w(TAG, "markRunning: launch authorization no longer holds ($refused)")
                val reason = if (refused in REASONS) refused else REASON_UNAUTHORIZED
                withFinished(t, STATE_SKIPPED, reason, null, null, null, System.currentTimeMillis())?.let { writeTicket(dir, it) }
                return false
            }
            val next = withRunning(t, now) ?: return false
            writeTicket(dir, next)
            return true
        } catch (e: Exception) {
            Log.w(TAG, "markRunning failed type=${e.javaClass.simpleName}")
            return false
        }
    }

    /** Ends an `accepted` ticket of this agent and principal that never ran (e.g. STOP-ALL). Never throws. */
    @Synchronized
    fun markEndedWithoutRun(context: Context, handle: String, agentId: String, principal: String?, state: String, reason: String) {
        try {
            if (!isValidHandle(handle)) return
            val dir = ensureRunsDir(context)
            val t = readTicketFile(dir, handle) ?: return
            if (t.agentId != agentId || principal == null || t.principal != principal || t.state != STATE_ACCEPTED) return
            val next = withFinished(t, state, reason, null, null, null, System.currentTimeMillis()) ?: return
            writeTicket(dir, next)
        } catch (e: Exception) {
            Log.w(TAG, "ticket end failed type=${e.javaClass.simpleName}")
        }
    }

    private fun findRunLog(context: Context, agentId: String, runStartMs: Long, runEndMs: Long): RunLogSummary? {
        if (!isValidAgentId(agentId)) return null
        val logDir = File(HomeInitializer.getHomeDir(context), ".shelly/agents/logs/$agentId")
        val files = logDir.listFiles { f -> f.isFile && f.extension == "json" } ?: return null
        val floor = (runStartMs / 1000L) * 1000L
        val logs = files.mapNotNull { f ->
            runCatching {
                // Cheap pre-filter: a file last written before this run started cannot be its log.
                if (f.lastModified() < floor - 1000L || f.length() > MAX_RUN_LOG_BYTES) null
                else readCapped(f, MAX_RUN_LOG_BYTES.toInt())?.let { parseRunLog(String(it, Charsets.UTF_8), agentId) }
            }.getOrNull()
        }
        return chooseRunLog(logs, runStartMs, runEndMs)
    }

    /**
     * Snapshots `.shelly/tmp/agent-result-<id>.md` (the next run overwrites it)
     * to `runs/<handle>.out`, at most [MAX_OUTPUT_BYTES]. Only a file last
     * written during this run (mtime in [runStartMs, runEndMs]) counts: an
     * older one is a previous run's, a newer one the next run's. Absent for the legacy .sh path, which deletes the
     * result file at its own cleanup (gap E1): the ticket then has no outputFile.
     */
    private fun snapshotOutput(context: Context, dir: File, handle: String, agentId: String, runStartMs: Long, runEndMs: Long): String? {
        if (!isValidAgentId(agentId)) return null
        val src = File(HomeInitializer.getHomeDir(context), ".shelly/tmp/agent-result-$agentId.md")
        // Missing on the legacy .sh path (it deletes the file at cleanup): no snapshot.
        if (!isRegularFile(src)) return null
        val bytes = readIfWrittenWithin(src, runStartMs, runEndMs, MAX_OUTPUT_BYTES + 4) ?: return null
        val text = utf8Prefix(bytes, MAX_OUTPUT_BYTES) ?: return null
        ClosePawRunResults.writePrivateAtomic(File(dir, outputFileName(handle)), text)
        return outputFileName(handle)
    }

    /**
     * Ends a ticket from the run's result: null [result] (crash / nothing
     * returned) is `failed`/`crashed`. The run log and output snapshot are best
     * effort; the ticket reaches a terminal state without them. Never throws.
     */
    @Synchronized
    fun markFinished(context: Context, handle: String, result: AgentRunResult?, runStartMs: Long, runEndMs: Long) {
        try {
            if (!isValidHandle(handle)) return
            val dir = ensureRunsDir(context)
            val t = readTicketFile(dir, handle) ?: run {
                Log.w(TAG, "markFinished: no ticket")
                return
            }
            val log = if (result != null) {
                runCatching { findRunLog(context, t.agentId, runStartMs, runEndMs) }.getOrNull()
            } else null
            val outcome = outcomeOf(result?.exitCode, result?.stderr, log)
            val out = if (result != null && outcome.state != STATE_SKIPPED) {
                runCatching { snapshotOutput(context, dir, handle, t.agentId, runStartMs, runEndMs) }
                    .onFailure { Log.w(TAG, "output snapshot failed type=${it.javaClass.simpleName}") }
                    .getOrNull()
            } else null
            val next = withFinished(t, outcome.state, outcome.reason, result?.exitCode, log, out, System.currentTimeMillis())
                ?: run {
                    Log.w(TAG, "markFinished: ticket is ${t.state}")
                    return
                }
            writeTicket(dir, next)
            Log.i(TAG, "run ticket finished state=${next.state} reason=${next.reason ?: "-"}")
        } catch (e: Exception) {
            Log.w(TAG, "markFinished failed type=${e.javaClass.simpleName}")
        }
    }

    /** Ticket JSON with the stale rule applied (and persisted), or null. Never throws. */
    @Synchronized
    fun readTicketJson(context: Context, handle: String): String? = try {
        if (!isValidHandle(handle)) {
            null
        } else {
            val dir = runsDir(context)
            val t = readTicketFile(dir, handle)
            if (t == null) {
                null
            } else {
                val now = System.currentTimeMillis()
                val s = applyStale(t, now)
                if (s != t) runCatching { writeTicket(ensureRunsDir(context), s) }
                encode(s)
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "ticket read failed type=${e.javaClass.simpleName}")
        null
    }

    /**
     * Every ticket of [principal] (stale rule applied, not persisted) as a JSON
     * array of ticket objects, for the bridge's requestId lookup and busy count.
     * Null when [principal] is invalid or the directory can't be read. Never throws.
     */
    @Synchronized
    fun listForPrincipalJson(context: Context, principal: String): String? = try {
        if (!isValidPrincipal(principal)) {
            null
        } else {
            val dir = runsDir(context)
            val arr = org.json.JSONArray()
            if (lexists(dir)) {
                val files = dir.listFiles() ?: throw java.io.IOException("runs not listable")
                val now = System.currentTimeMillis()
                for (f in files) {
                    val name = f.name
                    if (!name.endsWith(".json")) continue
                    val handle = name.removeSuffix(".json")
                    if (!isValidHandle(handle)) continue
                    val t = readTicketFile(dir, handle) ?: continue
                    if (t.principal != principal) continue
                    arr.put(JSONObject(encode(applyStale(t, now))))
                }
            }
            arr.toString()
        }
    } catch (e: Exception) {
        Log.w(TAG, "ticket list failed type=${e.javaClass.simpleName}")
        null
    }

    /**
     * Token revoke: every live ticket of [principal] (null = all) becomes
     * `cancelled`/`revoked` (see [withCancelled]). The count cancelled, or -1
     * when the directory could not be read or a write failed. Never throws.
     */
    @Synchronized
    fun cancelLive(context: Context, principal: String?): Int {
        try {
            if (principal != null && !isValidPrincipal(principal)) return -1
            val dir = runsDir(context)
            if (lstatIfPresent(dir) == null) return 0
            val files = dir.listFiles() ?: return -1
            val now = System.currentTimeMillis()
            var n = 0
            var failed = false
            for (f in files) {
                val name = f.name
                if (!name.endsWith(".json")) continue
                val handle = name.removeSuffix(".json")
                if (!isValidHandle(handle)) continue
                val t = readTicketFile(dir, handle, failOnStatError = true) ?: continue
                val next = withCancelled(t, principal, now) ?: continue
                try {
                    writeTicket(dir, next)
                    n++
                } catch (e: Exception) {
                    failed = true
                }
            }
            return if (failed) -1 else n
        } catch (e: Exception) {
            Log.w(TAG, "ticket cancel failed type=${e.javaClass.simpleName}")
            return -1
        }
    }

    /** The output snapshot, cut to [maxBytes] (at most [MAX_OUTPUT_BYTES]) on a UTF-8 boundary, or null. */
    fun readOutput(context: Context, handle: String, maxBytes: Int): String? = try {
        if (!isValidHandle(handle)) {
            null
        } else {
            val cap = maxBytes.coerceIn(0, MAX_OUTPUT_BYTES)
            val bytes = readCapped(File(runsDir(context), outputFileName(handle)), cap + 4)
            if (bytes == null) null else utf8Prefix(bytes, cap)
        }
    } catch (e: Exception) {
        Log.w(TAG, "output read failed type=${e.javaClass.simpleName}")
        null
    }
}
