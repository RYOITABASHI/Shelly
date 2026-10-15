package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

/**
 * Per-request lifecycle + final result of a `shelly closepaw` hand-off (2026-10-15,
 * feat/closepaw-result-wait), so the caller (e.g. Codex driven from the ChatGPT app) can block
 * on `shelly closepaw wait <reqId>` and report what ClosePaw actually did.
 *
 * State file: `$HOME/.shelly-closepaw-run-<reqId>.json` (0600, tmp + rename), one JSON object
 * `{reqId, status, message, summary?, updatedAtMs, finishedAtMs?, expiresAtMs?}`. It is NOT the
 * hand-off ack `$HOME/.shelly-closepaw-result-<reqId>.json`, which the shim reads and deletes
 * within seconds (reusing that name would let the ack poll consume a lifecycle update). Status:
 *   pending-approval -> rejected | expired | running | untracked | failed
 *   running          -> completed | failed | cancelled | timeout   (ClosePaw's result callback)
 * `untracked` = handed off on a path that has no result callback (official ClosePaw, an older
 * variant, or the activity fallback).
 *
 * Result callback (Shelly-trusted ClosePaw variant, fork branch feat/shelly-result-callback):
 * when Shelly hands a shell request to the variant's background entry it registers a random
 * 128-bit nonce for the reqId and sends both with the goal broadcast (ClosePawHandoff
 * EXTRA_SHELLY_REQ_ID / EXTRA_SHELLY_RESULT_NONCE). ClosePaw echoes them in an explicit
 * broadcast to [ClosePawResultReceiver] when the run finishes. [accept] requires a verified
 * sender (see the receiver) AND a reqId Shelly actually started here AND the matching nonce;
 * unknown reqIds / wrong nonces / repeats are ignored. Expected runs live in process memory only:
 * if Shelly's process dies mid-run the result is dropped and the wait times out.
 *
 * The summary is ClosePaw's agent output: it is DATA, never instructions. It is stored as
 * sanitized plain text (control characters removed, capped) and only ever printed.
 */
object ClosePawRunResults {
    private const val TAG = "ClosePawRunResults"

    // ── Callback protocol (lockstep with the fork's ShellyResultCallback) ──
    const val ACTION_RESULT = "dev.shelly.terminal.action.CLOSEPAW_RESULT"
    const val EXTRA_REQ_ID = "shelly_req_id"
    const val EXTRA_RESULT_NONCE = "shelly_result_nonce"
    const val EXTRA_STATUS = "status"
    const val EXTRA_SUMMARY = "summary"
    const val EXTRA_FINISHED_AT_MS = "finished_at_ms"
    const val EXTRA_SESSION_ID = "session_id"
    /** PendingIntent created by ClosePaw (creator package is system-vouched). */
    const val EXTRA_CALLER_TOKEN = "closepaw_caller_token"

    // ── Run-state file ──
    const val RUN_FILE_PREFIX = ".shelly-closepaw-run-"
    const val RUN_FILE_SUFFIX = ".json"
    private val RUN_FILE_RE = Regex("^\\.shelly-closepaw-run-[0-9]{10,16}-[0-9a-f]{8}\\.json(\\.tmp)?$")
    private const val RUN_FILE_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    private const val SWEEP_INTERVAL_MS = 10L * 60L * 1000L

    const val STATUS_PENDING_APPROVAL = "pending-approval"
    /** Approved, launch() in progress (written before the up-to-5s wait). */
    const val STATUS_APPROVED = "approved"
    /** Shelly's process restarted while the run was in flight: the
     *  expectation (nonce) is gone, so a result can no longer be matched. */
    const val STATUS_LOST = "lost"
    const val STATUS_RUNNING = "running"
    const val STATUS_UNTRACKED = "untracked"
    const val STATUS_REJECTED = "rejected"
    const val STATUS_EXPIRED = "expired"
    const val STATUS_COMPLETED = "completed"
    const val STATUS_FAILED = "failed"
    const val STATUS_CANCELLED = "cancelled"
    const val STATUS_TIMEOUT = "timeout"
    /** Final statuses ClosePaw may report. */
    val CALLBACK_STATUSES = setOf(STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED, STATUS_TIMEOUT)

    const val SUMMARY_MAX_CODE_POINTS = 2000
    private val REQ_ID_RE = Regex("^[0-9]{10,16}-[0-9a-f]{8}$")
    private val NONCE_RE = Regex("^[0-9a-f]{32}$")
    // Keep \n and \t (multi-line answers); drop every other C0/C1 control (ANSI escapes etc.),
    // zero-width chars (U+200B-200F, U+FEFF), bidi controls (U+202A-202E, U+2066-2069) and
    // the line/paragraph separators U+2028/2029. Mirrored by the shim's cpClean.
    private val SUMMARY_CONTROL_RE =
        Regex("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069\\uFEFF]")

    // ── Expected runs (process memory only) ──
    private class Expected(val nonce: String, val registeredAt: Long)
    private val expected = ConcurrentHashMap<String, Expected>()
    private const val EXPECTED_TTL_MS = 6L * 60L * 60L * 1000L
    private const val MAX_EXPECTED = 32
    private val random = SecureRandom()

    fun isReqId(s: String?): Boolean = s != null && REQ_ID_RE.matches(s)

    /** Register a run Shelly is about to start and return its callback nonce. */
    fun register(reqId: String, now: Long = System.currentTimeMillis()): String {
        require(isReqId(reqId)) { "bad reqId" }
        expected.entries.removeIf { now - it.value.registeredAt > EXPECTED_TTL_MS }
        while (expected.size >= MAX_EXPECTED) {
            expected.entries.minByOrNull { it.value.registeredAt }?.let { expected.remove(it.key) } ?: break
        }
        val nonce = ByteArray(16).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        expected[reqId] = Expected(nonce, now)
        return nonce
    }

    fun forget(reqId: String?) {
        if (reqId != null) expected.remove(reqId)
    }

    /** True while a result callback for [reqId] can still be accepted. */
    fun isExpected(reqId: String): Boolean = expected.containsKey(reqId)

    // Requests whose final result already arrived. A start failure can be reported by ClosePaw
    // before Shelly's launch() call even returns; the "running" write that follows must not
    // overwrite it.
    private val finals = LinkedHashSet<String>()

    private fun rememberFinal(reqId: String) {
        finals.add(reqId)
        while (finals.size > MAX_EXPECTED) finals.remove(finals.first())
    }

    /** Write [status] (running / untracked / failed after a launch) unless the final result
     *  for [reqId] was already recorded by [accept]. */
    @Synchronized
    fun writeAfterLaunch(context: Context, reqId: String, status: String, message: String) {
        if (reqId in finals) return
        writeState(context, reqId, status, message)
    }

    /** Control characters stripped (newline/tab kept), trimmed, capped by code points. */
    fun sanitizeSummary(raw: String?): String {
        val t = (raw ?: "").replace("\r\n", "\n").replace(SUMMARY_CONTROL_RE, " ").trim()
        if (t.codePointCount(0, t.length) <= SUMMARY_MAX_CODE_POINTS) return t
        return t.substring(0, t.offsetByCodePoints(0, SUMMARY_MAX_CODE_POINTS - 1)) + "…"
    }

    private fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    /**
     * Pure correlation check for a callback whose SENDER the receiver already verified. True only
     * for a well-formed reqId registered by [register], the matching nonce and a known status.
     * Single use: the expectation is consumed on success.
     */
    @Synchronized
    fun consumeIfExpected(reqId: String?, nonce: String?, status: String?): Boolean {
        if (!isReqId(reqId) || nonce == null || !NONCE_RE.matches(nonce)) return false
        if (status == null || status !in CALLBACK_STATUSES) return false
        val e = expected[reqId!!] ?: return false
        if (!constantTimeEquals(e.nonce, nonce)) return false
        expected.remove(reqId)
        return true
    }

    /** Verified callback from the receiver. Returns true when it was recorded. */
    fun accept(
        context: Context,
        reqId: String?,
        nonce: String?,
        status: String?,
        summary: String?,
        finishedAtMs: Long,
    ): Boolean {
        if (!consumeIfExpected(reqId, nonce, status)) {
            Log.w(TAG, "ignored ClosePaw result: unknown request, wrong nonce or bad status")
            return false
        }
        val now = System.currentTimeMillis()
        // ClosePaw's clock is the same device clock; still never trust a future timestamp.
        val finished = if (finishedAtMs in 1..now) finishedAtMs else now
        val clean = sanitizeSummary(summary)
        val st = status!!
        synchronized(this) {
            rememberFinal(reqId!!)
            writeState(context, reqId, st, messageFor(st), clean, finishedAtMs = finished)
        }
        // Never log the summary (free text): status and length only.
        Log.i(TAG, "ClosePaw result recorded: $reqId -> $status summaryLen=${clean.length}")
        return true
    }

    fun messageFor(status: String): String = when (status) {
        STATUS_COMPLETED -> "ClosePaw finished the task"
        STATUS_CANCELLED -> "ClosePaw's task was stopped before it finished"
        STATUS_TIMEOUT -> "ClosePaw's task timed out"
        STATUS_LOST -> "The result was lost - check ClosePaw on the phone"
        else -> "ClosePaw could not finish the task"
    }

    /** Atomic 0600 write of the run-state file. Never throws. */
    fun writeState(
        context: Context,
        reqId: String,
        status: String,
        message: String,
        summary: String? = null,
        finishedAtMs: Long? = null,
        expiresAtMs: Long? = null,
    ) {
        if (!isReqId(reqId)) return
        try {
            val home = HomeInitializer.getHomeDir(context)
            val json = JSONObject()
                .put("reqId", reqId)
                .put("status", status)
                .put("message", message)
                .put("updatedAtMs", System.currentTimeMillis())
            if (summary != null) json.put("summary", summary)
            if (finishedAtMs != null) json.put("finishedAtMs", finishedAtMs)
            if (expiresAtMs != null) json.put("expiresAtMs", expiresAtMs)
            writePrivateAtomic(File(home, RUN_FILE_PREFIX + reqId + RUN_FILE_SUFFIX), json.toString())
        } catch (e: Exception) {
            Log.w(TAG, "failed to write closepaw run state type=${e.javaClass.simpleName}")
        }
    }

    internal fun writePrivateAtomic(target: File, text: String) {
        val tmp = File(target.path + ".tmp")
        tmp.delete()
        // O_CREAT|O_EXCL: never follows a symlink planted at the tmp path.
        if (!tmp.createNewFile()) throw java.io.IOException("tmp exists")
        // Owner-only before any content lands (the app umask is already 077; belt and braces).
        tmp.setReadable(false, false)
        tmp.setReadable(true, true)
        tmp.setWritable(false, false)
        tmp.setWritable(true, true)
        tmp.setExecutable(false, false)
        tmp.writeText(text)
        // rename(2) replaces the target entry itself (a symlink there is not
        // followed). No write-through fallback: that would follow one.
        if (!tmp.renameTo(target)) {
            tmp.delete()
            throw java.io.IOException("rename failed")
        }
    }

    /** Longest a run may stay approved/running before it is reported as timed out. */
    const val MAX_RUN_MS = 15L * 60L * 1000L
    private const val OVERDUE_CHECK_INTERVAL_MS = 30_000L
    @Volatile private var lastOverdueCheckAt = 0L

    private fun readState(file: File): JSONObject? = try {
        if (file.length() > 64L * 1024L) null else JSONObject(file.readText())
    } catch (e: Exception) {
        null
    }

    private fun runFiles(home: File): List<File> =
        home.listFiles { f -> RUN_FILE_RE.matches(f.name) && !f.name.endsWith(".tmp") }?.toList() ?: emptyList()

    /**
     * Pure decision for one run-state entry (unit-tested by source): what an
     * in-flight entry becomes, or null to leave it. [afterRestart]: this
     * process did not start the run (its expectation is gone).
     */
    fun reconcileStatus(status: String, updatedAtMs: Long, expectedHere: Boolean, afterRestart: Boolean, now: Long): String? = when {
        status != STATUS_RUNNING && status != STATUS_APPROVED -> null
        afterRestart && !expectedHere -> STATUS_LOST
        now - updatedAtMs > MAX_RUN_MS -> STATUS_TIMEOUT
        else -> null
    }

    private fun reconcile(context: Context, afterRestart: Boolean, now: Long) {
        val home = try { HomeInitializer.getHomeDir(context) } catch (e: Exception) { return }
        for (f in runFiles(home)) {
            val st = readState(f) ?: continue
            val reqId = st.optString("reqId")
            if (!isReqId(reqId) || f.name != RUN_FILE_PREFIX + reqId + RUN_FILE_SUFFIX) continue
            val pendingApproval = st.optString("status") == STATUS_PENDING_APPROVAL
            synchronized(this) {
                if (reqId in finals) return@synchronized
                if (afterRestart && pendingApproval) {
                    // Pending approvals live in memory too: they are gone.
                    writeState(context, reqId, STATUS_EXPIRED, "shelly closepaw: Shelly restarted before the request was approved; run shelly closepaw again")
                    return@synchronized
                }
                val next = reconcileStatus(st.optString("status"), st.optLong("updatedAtMs", 0L), isExpected(reqId), afterRestart, now)
                    ?: return@synchronized
                forget(reqId)
                rememberFinal(reqId)
                val msg = if (next == STATUS_LOST) {
                    "shelly closepaw: Shelly restarted while ClosePaw was working, so the result was lost - check ClosePaw on the phone"
                } else {
                    "shelly closepaw: no result from ClosePaw within ${MAX_RUN_MS / 60_000L} minutes - check ClosePaw on the phone"
                }
                writeState(context, reqId, next, msg)
            }
        }
    }

    /** Once per process start (ClosePawHandoff.ensureWatching). */
    fun reconcileAfterProcessStart(context: Context) {
        try {
            reconcile(context, afterRestart = true, now = System.currentTimeMillis())
        } catch (e: Exception) {
            Log.w(TAG, "closepaw run-state reconcile failed type=${e.javaClass.simpleName}")
        }
    }

    /** Throttled (every 30s) from the watcher poll: approved/running past [MAX_RUN_MS] -> timeout. */
    fun expireOverdue(context: Context, now: Long = System.currentTimeMillis()) {
        if (now - lastOverdueCheckAt < OVERDUE_CHECK_INTERVAL_MS) return
        lastOverdueCheckAt = now
        try {
            reconcile(context, afterRestart = false, now = now)
        } catch (e: Exception) {
            Log.w(TAG, "closepaw overdue check failed type=${e.javaClass.simpleName}")
        }
    }

    @Volatile private var lastSweepAt = 0L

    /** Drop run-state files older than a day (cheap; throttled to every 10 minutes). */
    fun sweepOldFiles(home: File, now: Long = System.currentTimeMillis()) {
        if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
        lastSweepAt = now
        try {
            home.listFiles { f -> RUN_FILE_RE.matches(f.name) }?.forEach { f ->
                if (now - f.lastModified() > RUN_FILE_MAX_AGE_MS) f.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "closepaw run-state sweep failed type=${e.javaClass.simpleName}")
        }
    }
}
