package expo.modules.terminalemulator

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.util.Log
import java.io.File
import java.security.SecureRandom

/**
 * The launcher ingress (fact sheet §1–§5; authority `${applicationId}.ingress`,
 * exported, no Android permission: authorization is the caller check below).
 *
 * call("submit_instruction", null, extras) on a Binder thread:
 *   1. Who: the Binder calling UID → exactly one package → the registered
 *      package and a pinned certificate (LauncherCallerVerifierCore against
 *      TrustedCallerStore; nothing in extras is an identity). A failure is
 *      VERIFY_FAILED with no detail; the audit line says which check failed.
 *   2. What: the payload (LauncherIngressCore.checkPayload).
 *   3. The decision, under the submission lock (and, when the approve-all
 *      switch is on, its decision token, so STOP-ALL can't race it):
 *      LauncherIngressCore.decide through IngressDecision's stage order.
 *   4. Audit line first, then the record (McpRunTickets submission);
 *      either failing is INTERNAL_ERROR (fail closed).
 * Pending is answered at once (`accepted`, approval `pending`); nothing here
 * waits for RN, the UI or a person. Every answer is a Bundle; no exception
 * ever reaches the caller. Nothing logs the text.
 *
 * call("get_stream_feed"): the same caller check, then the stored stream
 * feed (StreamFeedStore; answer shape StreamFeedCore.readResponse, C7).
 *
 * Phase 1: a pending submission stays `pending_approval` until it expires
 * (10 min); the asynchronous approval that decides it (C6) is Phase 2.
 */
class LauncherIngressProvider : ContentProvider() {
    companion object {
        private const val TAG = "LauncherIngress"
        private val random = SecureRandom()

        fun newSubmissionId(): String {
            val b = ByteArray(16).also { random.nextBytes(it) }
            return "ls_" + b.joinToString("") { "%02x".format(it) }
        }

        internal fun toBundle(m: Map<String, Any>): Bundle {
            val b = Bundle()
            for ((k, v) in m) {
                when (v) {
                    is String -> b.putString(k, v)
                    is Boolean -> b.putBoolean(k, v)
                    is Int -> b.putInt(k, v)
                    is Long -> b.putLong(k, v)
                }
            }
            return b
        }

        /** Audit lines of callers that fail verification (any app can call an exported Provider). */
        private val unverifiedAudit = LauncherIngressCore.AuditThrottle()

        /** [corr]: a verified caller's reference (A2); null before verification. */
        private fun internalError(corr: String? = null): Bundle = toBundle(LauncherIngressCore.denied(LauncherIngressCore.Reason.INTERNAL_ERROR, null, corr))
    }

    /** No work at app start (§8 R4). */
    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        return try {
            val ctx = context ?: return internalError()
            when (method) {
                LauncherIngressCore.METHOD_SUBMIT -> submit(ctx, extras)
                LauncherIngressCore.METHOD_GET_FEED -> getFeed(ctx)
                else -> toBundle(LauncherIngressCore.denied(LauncherIngressCore.Reason.INVALID_PAYLOAD, null, null))
            }
        } catch (t: Throwable) {
            Log.w(TAG, "call failed type=${t.javaClass.simpleName}")
            internalError()
        }
    }

    // ── submit_instruction ────────────────────────────────────────────────

    private class BundleExtras(private val b: Bundle) : LauncherIngressCore.Extras {
        override fun keys(): Set<String> = HashSet(b.keySet())
        override fun has(key: String): Boolean = b.containsKey(key)
        override fun string(key: String): String? = b.getString(key)
    }

    /** Android facts for the verifier. */
    internal class AndroidCallerFacts(private val ctx: Context) : LauncherCallerVerifierCore.Facts {
        override fun sdkInt(): Int = Build.VERSION.SDK_INT
        override fun packagesForUid(uid: Int): Array<String>? = ctx.packageManager.getPackagesForUid(uid)
        override fun hasCert(packageName: String, sha256: ByteArray): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                ctx.packageManager.hasSigningCertificate(packageName, sha256, PackageManager.CERT_INPUT_SHA256)
    }

    private sealed class Answer {
        class Deny(val reason: LauncherIngressCore.Reason, val code: String) : Answer()
        class Duplicate(val existing: McpRunTickets.Submission) : Answer()
        class Written(val s: McpRunTickets.Submission, val kind: String) : Answer()
        /** The audit line was written but the record was not: say so in a second line. */
        class RecordFailed(val s: McpRunTickets.Submission) : Answer()
        object AuditFailed : Answer()
    }

    private fun submit(ctx: Context, extras: Bundle?): Bundle {
        val uid = Binder.getCallingUid()
        val entry = TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER)
        val v = LauncherCallerVerifierCore.verify(uid, entry, AndroidCallerFacts(ctx))
        if (v !is LauncherCallerVerifierCore.Result.Verified) {
            val code = (v as LauncherCallerVerifierCore.Result.Failed).code
            val audited = unverifiedAudit.allow(System.currentTimeMillis()) && IngressAuditWriter.appendLauncherLine(
                ctx, IngressAuditWriter.LauncherLine("launcher_submit_denied", IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code),
            )
            // §8 R8: VERIFY_FAILED stays VERIFY_FAILED even when its audit line failed; no detail, no echo.
            return toBundle(LauncherIngressCore.denied(LauncherIngressCore.Reason.VERIFY_FAILED, if (audited) "launcher_submit_denied" else null, null))
        }
        val principal = v.principal
        val payload = LauncherIngressCore.checkPayload(extras?.let { BundleExtras(it) })
        // Kept on every verified answer, even when another field was refused (A2).
        val corr = LauncherIngressCore.correlationOf(extras?.let { BundleExtras(it) })
        // Set inside the commit (below) when STOP-ALL came on or the registration
        // changed after the decision: the record is then not written.
        var haltedAtCommit = false
        var entryChangedAtCommit = false
        var ruleChangedAtCommit = false
        var rateNotKeptAtCommit = false

        // An existing submission is audited with ITS reference, not the retry's.
        fun line(kind: String, code: String, s: McpRunTickets.Submission? = null, duplicate: Boolean? = null) =
            IngressAuditWriter.LauncherLine(
                kind = kind, event = IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code = code, principal = principal.wire,
                certDigest = v.certDigest, schemaVersion = LauncherIngressCore.SCHEMA_VERSION, submissionId = s?.id,
                correlationRef = if (duplicate == true) s?.correlationRef else corr, tainted = s?.untrusted, exemptApplied = s?.exemptApplied,
                textSha256 = s?.textSha256, textCodePoints = s?.textCodePoints, duplicate = duplicate,
            )

        fun attempt(approveAll: Boolean): Answer {
            val facts = object : LauncherIngressCore.Facts {
                override fun ingressEnabled(): Boolean = v.entry.enabled
                override fun halted(): Boolean = StopAllSwitches.halted(ctx)
                override fun exemptionBound(): Boolean = TrustedCallerStore.exemptionBound(v.entry, IngressDecision.OP_SUBMIT_INSTRUCTION)
                override fun matchRule(principalWire: String): String? = try {
                    McpAlwaysAllowStore.findMatch(
                        McpAlwaysAllowStore.read(ctx).rules, principalWire, IngressDecision.OP_SUBMIT_INSTRUCTION, LauncherIngressCore.TARGET, null,
                    )?.id
                } catch (e: Exception) {
                    null
                }
                override fun approveAllOn(): Boolean = approveAll
                override fun rateHistory(): List<Long>? = LauncherRateHistory.times(ctx)
            }
            return McpRunTickets.submissionTransaction<Answer>(
                ctx, principal.wire,
                body = { mine, now ->
                    when (val d = LauncherIngressCore.decide(principal, payload, mine, now, facts)) {
                        is LauncherIngressCore.Decision.Deny -> Pair(Answer.Deny(d.reason, d.code), McpRunTickets.SubmissionWrite.None)
                        is LauncherIngressCore.Decision.Duplicate -> Pair(Answer.Duplicate(d.existing), McpRunTickets.SubmissionWrite.None)
                        is LauncherIngressCore.Decision.Accept -> {
                            val p = (payload as LauncherIngressCore.PayloadResult.Ok).payload
                            val s = McpRunTickets.Submission(
                                id = newSubmissionId(), principal = principal.wire,
                                state = if (d.approved) McpRunTickets.SUB_APPROVED else McpRunTickets.SUB_PENDING,
                                acceptedAt = now, decidedAt = if (d.approved) now else null, nonce = p.nonce,
                                correlationRef = p.correlationRef, untrusted = d.taint.tainted, exemptApplied = d.taint.exemptApplied,
                                textSha256 = LauncherIngressCore.sha256Hex(p.text), textCodePoints = p.codePoints,
                                certDigest = v.certDigest, schemaVersion = LauncherIngressCore.SCHEMA_VERSION,
                                approvedVia = d.via, ruleId = d.ruleId,
                            )
                            val kind = if (d.approved) "launcher_submit_accepted" else "launcher_submit_pending"
                            val code = when (d.via) {
                                "rule" -> "approved_rule"
                                "approve_all" -> "approved_switch"
                                else -> "pending"
                            }
                            Pair(
                                Answer.Written(s, kind),
                                McpRunTickets.SubmissionWrite.Write(s, p.text) {
                                    // Commit boundary: STOP-ALL and the registration (enablement,
                                    // pins, exemption grant) once more, then the audit line.
                                    when {
                                        // The rate brake's history outside $HOME is kept BEFORE anything is
                                        // published; if it cannot be kept, nothing is (fail closed). It goes
                                        // first so its disk write does not sit between the re-checks below
                                        // and the audit line.
                                        !LauncherRateHistory.record(ctx, s.acceptedAt) -> { rateNotKeptAtCommit = true; false }
                                        StopAllSwitches.halted(ctx) -> { haltedAtCommit = true; false }
                                        TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER) != v.entry -> { entryChangedAtCommit = true; false }
                                        // An always-allow approval needs its rule to still be there.
                                        d.via == "rule" && facts.matchRule(principal.wire) != d.ruleId -> { ruleChangedAtCommit = true; false }
                                        else -> IngressAuditWriter.appendLauncherLine(ctx, line(kind, code, s))
                                    }
                                },
                            )
                        }
                    }
                },
                onResult = { answer, result ->
                    if (answer !is Answer.Written) {
                        answer
                    } else {
                        when (result) {
                            McpRunTickets.SubmissionWriteResult.WRITTEN -> answer
                            McpRunTickets.SubmissionWriteResult.REFUSED_BY_AUDIT -> when {
                                haltedAtCommit -> Answer.Deny(LauncherIngressCore.Reason.STOP_ALL_ACTIVE, "halted")
                                entryChangedAtCommit -> Answer.Deny(LauncherIngressCore.Reason.VERIFY_FAILED, "verify_changed")
                                // The rule was revoked between the decision and the write: nothing is recorded.
                                ruleChangedAtCommit -> Answer.Deny(LauncherIngressCore.Reason.GATE_DENIED, "rule_changed")
                                rateNotKeptAtCommit -> Answer.Deny(LauncherIngressCore.Reason.INTERNAL_ERROR, "rate_history_failed")
                                else -> Answer.AuditFailed
                            }
                            McpRunTickets.SubmissionWriteResult.FAILED -> Answer.RecordFailed(answer.s)
                            // A Write was asked for; NOT_WRITTEN can't happen. Fail closed.
                            McpRunTickets.SubmissionWriteResult.NOT_WRITTEN -> Answer.RecordFailed(answer.s)
                        }
                    }
                },
            ) ?: Answer.AuditFailed
        }

        // The registry lock is held from the decision to the record, so withdrawing
        // the exemption, changing the pins or disabling / removing the launcher in
        // Settings (TrustedCallerStore's @Synchronized writers) cannot fall between
        // the commit check and the write. Lock order: TrustedCallerStore → approval
        // switch token → McpRunTickets → McpAlwaysAllowStore (read); Settings takes
        // TrustedCallerStore → McpAlwaysAllowStore, nothing takes them the other way.
        // Everything from the registration re-check to the answer Bundle (the
        // audit lines included) runs under the registry lock: a revocation in
        // Settings is either before (nothing answered from the old registration)
        // or after the whole call.
        return synchronized(TrustedCallerStore) {
            // Verification ran before the lock: the registration must still be the
            // one that verified, or nothing (not even a nonce duplicate) is answered.
            val answer = if (TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER) != v.entry) {
                Answer.Deny(LauncherIngressCore.Reason.VERIFY_FAILED, "verify_changed")
            } else {
                val token = ApprovalSwitches.approveAllToken(ctx)
                if (token != null) ApprovalSwitches.withApproveAllToken(ctx, token) { attempt(true) } ?: attempt(false) else attempt(false)
            }

            when (answer) {
                is Answer.Written -> toBundle(
                    LauncherIngressCore.accepted(answer.s.id, answer.s.state == McpRunTickets.SUB_APPROVED, answer.s.untrusted, answer.kind, corr, false),
                )
                is Answer.Duplicate -> {
                    val s = answer.existing
                    val kind = if (s.state == McpRunTickets.SUB_APPROVED) "launcher_submit_accepted" else "launcher_submit_pending"
                    if (s.state == McpRunTickets.SUB_APPROVED || s.state == McpRunTickets.SUB_PENDING) {
                        if (!IngressAuditWriter.appendLauncherLine(ctx, line(kind, "duplicate", s, duplicate = true))) return internalError(s.correlationRef)
                        toBundle(LauncherIngressCore.accepted(s.id, s.state == McpRunTickets.SUB_APPROVED, s.untrusted, kind, s.correlationRef, true))
                    } else {
                        // The earlier submission was refused by a person or expired: the retry is not a new one (D7).
                        if (!IngressAuditWriter.appendLauncherLine(ctx, line("launcher_submit_denied", "duplicate_closed", s, duplicate = true))) {
                            return internalError(s.correlationRef)
                        }
                        val m = LinkedHashMap(LauncherIngressCore.denied(LauncherIngressCore.Reason.GATE_DENIED, "launcher_submit_denied", s.correlationRef))
                        m["submission_id"] = s.id
                        m["duplicate"] = true
                        toBundle(m)
                    }
                }
                is Answer.Deny -> {
                    val audited = IngressAuditWriter.appendLauncherLine(ctx, line("launcher_submit_denied", answer.code))
                    // §8 R8: a denial whose audit line could not be written is INTERNAL_ERROR,
                    // except VERIFY_FAILED (the registration changed at commit), which stays
                    // VERIFY_FAILED with no detail and no echo.
                    when {
                        answer.reason == LauncherIngressCore.Reason.VERIFY_FAILED ->
                            toBundle(LauncherIngressCore.denied(answer.reason, if (audited) "launcher_submit_denied" else null, null))
                        !audited -> internalError(corr)
                        else -> toBundle(LauncherIngressCore.denied(answer.reason, "launcher_submit_denied", corr))
                    }
                }
                is Answer.RecordFailed -> {
                    IngressAuditWriter.appendLauncherLine(ctx, line("launcher_submit_denied", "internal_error", answer.s))
                    internalError(corr)
                }
                Answer.AuditFailed -> internalError(corr)
            }
        }
    }

    // ── get_stream_feed (C7 answer shape: StreamFeedCore.readResponse) ────

    /** "principal|sha256" last audited as served (one `launcher_feed_read` ok line per caller and new feed, not per poll). */
    @Volatile private var lastServed: String? = null

    /**
     * Same caller check as submit_instruction; no approval, no STOP-ALL (a
     * read for display). VERIFY_FAILED / DISABLED never touch the store. The
     * feed text goes only into the answer Bundle: never a log or audit line.
     */
    private fun getFeed(ctx: Context): Bundle = try {
        feedAnswer(ctx)
    } catch (t: Throwable) {
        Log.w(TAG, "get_stream_feed failed type=${t.javaClass.simpleName}")
        toBundle(StreamFeedCore.readResponse(StreamFeedCore.State.Unreadable))
    }

    private fun feedAnswer(ctx: Context): Bundle {
        val v = LauncherCallerVerifierCore.verify(Binder.getCallingUid(), TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER), AndroidCallerFacts(ctx))
        fun line(code: String, principal: String? = null, cert: String? = null, sha: String? = null, bytes: Int? = null) =
            IngressAuditWriter.appendLauncherLine(
                ctx,
                IngressAuditWriter.LauncherLine(
                    "launcher_feed_read", IngressAuditWriter.LAUNCHER_EVENT_FEED, code,
                    principal = principal, certDigest = cert, feedSha256 = sha, feedBytes = bytes,
                ),
            )
        if (v !is LauncherCallerVerifierCore.Result.Verified) {
            if (unverifiedAudit.allow(System.currentTimeMillis())) line((v as LauncherCallerVerifierCore.Result.Failed).code)
            return toBundle(StreamFeedCore.deniedResponse(LauncherIngressCore.Reason.VERIFY_FAILED.name))
        }
        val principal = v.principal.wire
        if (!v.entry.enabled) {
            // §8 R8: an unwritten line is INTERNAL_ERROR (the C7 error shape).
            if (!line("disabled", principal, v.certDigest)) return toBundle(StreamFeedCore.readResponse(StreamFeedCore.State.Unreadable))
            return toBundle(StreamFeedCore.deniedResponse(LauncherIngressCore.Reason.DISABLED.name))
        }
        val state = StreamFeedStore.read(ctx)
        // From the final authorization check to the answer, under the registry lock:
        // a revocation in Settings either comes before (nothing served) or after.
        return synchronized(TrustedCallerStore) {
            // The read may have waited behind a feed write: if the launcher was
            // disabled, removed or re-pinned meanwhile, nothing is served.
            val nowEntry = TrustedCallerStore.entry(ctx, IngressOrigin.LAUNCHER)
            if (nowEntry != v.entry) {
                line("verify_changed", principal, v.certDigest)
                return toBundle(
                    StreamFeedCore.deniedResponse(
                        if (nowEntry != null && !nowEntry.enabled && nowEntry.copy(enabled = true, updatedAt = 0) == v.entry.copy(updatedAt = 0)) {
                            LauncherIngressCore.Reason.DISABLED.name
                        } else {
                            LauncherIngressCore.Reason.VERIFY_FAILED.name
                        },
                    ),
                )
            }
            when (state) {
                is StreamFeedCore.State.Present -> if (lastServed != "$principal|${state.stored.sha256}") {
                    // A new feed is served only after its line is written (fail closed, §8 R8).
                    if (!line("ok", principal, v.certDigest, state.stored.sha256, state.stored.bytes.size)) {
                        return toBundle(StreamFeedCore.readResponse(StreamFeedCore.State.Unreadable))
                    }
                    lastServed = "$principal|${state.stored.sha256}"
                }
                StreamFeedCore.State.Empty -> Unit
                StreamFeedCore.State.Unreadable -> line("feed_unreadable", principal, v.certDigest)
            }
            toBundle(StreamFeedCore.readResponse(state))
        }
    }

    // ── Not a data provider ───────────────────────────────────────────────

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

/**
 * The D1 rate brake's history, kept outside `$HOME` (noBackupFilesDir) and in
 * memory, in addition to the submission records under `$HOME/.shelly-mcp-queue`
 * (which agents' file tools can reach). The brake reads the union, so deleting
 * the records alone does not reset it. A history file that exists but does not
 * parse reads as null: the brake then fails closed (tainted). Same-UID code
 * outside the gate (Shelly's own terminal) can still reach this file — the
 * boundary documented for McpAlwaysAllowStore. Times only, never text.
 */
internal object LauncherRateHistory {
    private const val MAX = 32
    private val mem = ArrayList<Long>()
    private var loaded = false
    private var corrupt = false

    private fun file(ctx: Context) = File(File(ctx.noBackupFilesDir, "launcher-ingress"), "rate-v1")

    private fun load(ctx: Context) {
        if (loaded) return
        loaded = true
        try {
            val f = file(ctx)
            if (!f.exists()) return
            for (line in f.readText(Charsets.US_ASCII).split('\n')) {
                if (line.isEmpty()) continue
                val t = line.toLongOrNull()
                if (t == null || t < 0) { corrupt = true; return }
                mem.add(t)
            }
            mem.sort()
            while (mem.size > MAX) mem.removeAt(0)
        } catch (e: Exception) {
            corrupt = true
        }
    }

    /** Earlier acceptance times; null when the stored history cannot be read (fail closed). */
    @Synchronized
    fun times(ctx: Context): List<Long>? {
        load(ctx)
        return if (corrupt) null else ArrayList(mem)
    }

    /**
     * Adds [t] (in memory at once, so a failed write still counts it in this
     * process) and persists. False when it was not persisted: the caller then
     * publishes nothing.
     */
    @Synchronized
    fun record(ctx: Context, t: Long): Boolean {
        load(ctx)
        mem.add(t)
        mem.sort()
        while (mem.size > MAX) mem.removeAt(0)
        return try {
            val f = file(ctx)
            val dir = f.parentFile ?: return false
            if (!dir.isDirectory && !dir.mkdirs()) return false
            ClosePawRunResults.writePrivateAtomic(f, mem.joinToString("\n"))
            // A rewritten file holds every time this process knows (a corrupt one included none of its own).
            corrupt = false
            true
        } catch (e: Exception) {
            Log.w("LauncherIngress", "rate history not written type=${e.javaClass.simpleName}")
            false
        }
    }
}
