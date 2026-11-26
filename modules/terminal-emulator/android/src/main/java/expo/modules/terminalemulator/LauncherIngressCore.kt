package expo.modules.terminalemulator

import java.security.MessageDigest

/**
 * The pure half of LauncherIngressProvider's `submit_instruction` (fact sheet
 * §1, §3, §5; D1). No Android dependency: LauncherIngressCoreTest covers it.
 *
 * Contract: the request is the call() extras — `instruction_text` (required,
 * 1..4,000 code points), `correlation_ref` and `submission_nonce` (optional).
 * Any other key is never trusted for anything (identity, approval, priority);
 * its mere presence makes the submission tainted (D1: only the schema's
 * fields can be exempt). The answer is `accepted` (approval `approved` or
 * `pending`) or `denied` with a fixed reason. Pending never blocks the call.
 *
 * submit_instruction starts nothing: no command, file write or agent run. An
 * approved submission waits until Hayato's MCP reader takes it (phase 2 D2:
 * LauncherSubmissionCore, get_launcher_submission / mark_launcher_submission_consumed).
 */
object LauncherIngressCore {
    const val METHOD_SUBMIT = "submit_instruction"
    const val METHOD_GET_FEED = "get_stream_feed"
    const val TARGET = "hayato"
    const val SCHEMA_VERSION = 1

    const val KEY_TEXT = "instruction_text"
    const val KEY_CORRELATION = "correlation_ref"
    const val KEY_NONCE = "submission_nonce"

    /** The reason values shared with the launcher (fact sheet §1.3; the補完 values are D7). */
    enum class Reason { VERIFY_FAILED, PAYLOAD_TOO_LARGE, INVALID_PAYLOAD, STOP_ALL_ACTIVE, GATE_DENIED, DISABLED, BUSY, INTERNAL_ERROR }

    private val NONCE_RE = Regex("^[A-Za-z0-9_-]{8,64}$")
    // C0 controls except tab / LF / CR, DEL, C1, and the bidi embedding /
    // override / isolate controls (they can make an approval screen show other
    // text than what is sent).
    private val UNSAFE_TEXT = Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]")

    /** A read-only view of the call() extras (the Provider wraps the Bundle). */
    interface Extras {
        fun keys(): Set<String>
        fun has(key: String): Boolean
        /** The value when it is a String, else null. */
        fun string(key: String): String?
    }

    data class Payload(
        val text: String,
        val codePoints: Int,
        val correlationRef: String?,
        val nonce: String?,
        /** Every key the caller sent (unknown ones included): for the D1 schema check only. */
        val fields: Set<String>,
    )

    sealed class PayloadResult {
        data class Ok(val payload: Payload) : PayloadResult()
        /** [code] is for the audit line. */
        data class Bad(val reason: Reason, val code: String) : PayloadResult()
    }

    /** True when every UTF-16 surrogate in [s] is paired. */
    private fun wellFormed(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) return false
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return false
            i++
        }
        return true
    }

    /** Fact sheet §1.1, §8 R3/R5. Over a limit is refused, never cut. */
    fun checkPayload(e: Extras?): PayloadResult {
        if (e == null) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "payload_missing")
        val keys = try { e.keys() } catch (x: Exception) { return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "payload_unreadable") }
        if (!e.has(KEY_TEXT)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "text_missing")
        val text = e.string(KEY_TEXT) ?: return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "text_type")
        if (!wellFormed(text)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "text_encoding")
        val cp = text.codePointCount(0, text.length)
        if (cp > LauncherIngressLimits.MAX_TEXT_CODE_POINTS) return PayloadResult.Bad(Reason.PAYLOAD_TOO_LARGE, "text_too_large")
        if (text.isBlank()) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "text_empty")
        if (UNSAFE_TEXT.containsMatchIn(text)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "text_control")
        var corr: String? = null
        if (e.has(KEY_CORRELATION)) {
            val c = e.string(KEY_CORRELATION) ?: return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "correlation_type")
            if (!wellFormed(c)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "correlation_invalid")
            if (c.codePointCount(0, c.length) > LauncherIngressLimits.MAX_CORRELATION_CODE_POINTS) {
                return PayloadResult.Bad(Reason.PAYLOAD_TOO_LARGE, "correlation_too_large")
            }
            if (!IngressAuditWriter.CORRELATION_REF_RE.matches(c)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "correlation_invalid")
            corr = c
        }
        var nonce: String? = null
        if (e.has(KEY_NONCE)) {
            val n = e.string(KEY_NONCE) ?: return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "nonce_type")
            if (n.codePointCount(0, n.length) > 64) return PayloadResult.Bad(Reason.PAYLOAD_TOO_LARGE, "nonce_too_large")
            if (!NONCE_RE.matches(n)) return PayloadResult.Bad(Reason.INVALID_PAYLOAD, "nonce_invalid")
            nonce = n
        }
        return PayloadResult.Ok(Payload(text, cp, corr, nonce, keys))
    }

    /**
     * The caller's correlation_ref on its own (§8 R5), so a verified request
     * keeps its reference even when another field is refused. Null when absent
     * or not the allowed shape (never echoed then).
     */
    fun correlationOf(e: Extras?): String? = try {
        val c = if (e != null && e.has(KEY_CORRELATION)) e.string(KEY_CORRELATION) else null
        if (c != null && IngressAuditWriter.CORRELATION_REF_RE.matches(c)) c else null
    } catch (x: Exception) {
        null
    }

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /**
     * D1 rate brake: false (not a human rate → tainted) when this submission
     * comes less than RATE_MIN_INTERVAL_MS after the previous one, carries
     * more code points than RATE_MAX_CODE_POINTS_PER_SECOND × the seconds
     * since the previous one, or is more than RATE_MAX_IN_WINDOW in
     * RATE_WINDOW_MS. [previous]: earlier acceptance times of this principal.
     */
    fun humanRate(now: Long, previous: List<Long>, codePoints: Int): Boolean {
        val past = previous.filter { it <= now }
        val last = past.maxOrNull()
        if (last != null) {
            val dt = now - last
            if (dt < LauncherIngressLimits.RATE_MIN_INTERVAL_MS) return false
            if (codePoints.toLong() * 1000L > LauncherIngressLimits.RATE_MAX_CODE_POINTS_PER_SECOND.toLong() * dt) return false
        }
        // A future-stamped record (clock moved back) counts against the window too.
        val inWindow = previous.count { now - it < LauncherIngressLimits.RATE_WINDOW_MS } + 1
        return inWindow <= LauncherIngressLimits.RATE_MAX_IN_WINDOW
    }

    /**
     * Caps the audit lines callers that fail verification can cause: any
     * installed app can call the exported Provider, and each refused call
     * would otherwise append a line. A fixed window of
     * [LauncherIngressLimits.UNVERIFIED_AUDIT_MAX_IN_WINDOW] lines per
     * [LauncherIngressLimits.UNVERIFIED_AUDIT_WINDOW_MS]; a clock that moves
     * back starts a new window. Only the audit line is skipped: the answer
     * stays VERIFY_FAILED. Verified callers are never throttled here.
     */
    class AuditThrottle(
        private val max: Int = LauncherIngressLimits.UNVERIFIED_AUDIT_MAX_IN_WINDOW,
        private val windowMs: Long = LauncherIngressLimits.UNVERIFIED_AUDIT_WINDOW_MS,
    ) {
        private var windowStart: Long? = null
        private var count = 0

        @Synchronized
        fun allow(now: Long): Boolean {
            val start = windowStart
            if (start == null || now < start || now - start >= windowMs) {
                windowStart = now
                count = 0
            }
            if (count >= max) return false
            count++
            return true
        }
    }

    /** The facts the decision reads, all from the device (never from the caller). */
    interface Facts {
        /** The registry entry is enabled. */
        fun ingressEnabled(): Boolean
        /** STOP-ALL (`.halted`), true when it can't be checked. */
        fun halted(): Boolean
        /** TrustedCallerStore.exemptionBound for this op. */
        fun exemptionBound(): Boolean
        /** The always-allow rule (principal, submit_instruction, hayato), or null. */
        fun matchRule(principalWire: String): String?
        /** The ingress-wide "approve all without asking" switch (with its decision token held by the caller). */
        fun approveAllOn(): Boolean
        /**
         * Earlier acceptance times kept outside `$HOME` (LauncherRateHistory),
         * read together with [decide]'s records; null when that history cannot
         * be read, which makes the rate not human (fail closed).
         */
        fun rateHistory(): List<Long>? = emptyList()
    }

    sealed class Decision {
        data class Deny(val reason: Reason, val code: String) : Decision()
        /** A repeated nonce: answer with this submission, write nothing. */
        data class Duplicate(val existing: McpRunTickets.Submission) : Decision()
        data class Accept(
            val approved: Boolean,
            /** rule / approve_all when approved at once; null when pending. */
            val via: String?,
            val ruleId: String?,
            val taint: IngressOrigin.Verdict,
        ) : Decision()
    }

    /**
     * The decision, through the shared stage order (IngressDecision.evaluate,
     * op submit_instruction): setting → arguments → STOP-ALL → taint (D1;
     * never refuses here, it only takes away the unattended approvals) →
     * nonce → always-allow rule → approve-all switch → otherwise pending, or
     * BUSY when [LauncherIngressLimits.MAX_PENDING] are already undecided.
     * [mine]: this principal's submissions, expiry applied.
     */
    fun decide(
        principal: IngressDecision.Principal,
        payload: PayloadResult,
        mine: List<McpRunTickets.Submission>,
        now: Long,
        f: Facts,
    ): Decision {
        var ok: Payload? = null
        var taint = IngressOrigin.Verdict(true, false, IngressOrigin.Why.DEFAULT)
        val hooks: Map<IngressDecision.Stage, () -> Decision?> = mapOf(
            IngressDecision.Stage.SETTING to { if (!f.ingressEnabled()) Decision.Deny(Reason.DISABLED, "disabled") else null },
            IngressDecision.Stage.ARGS to {
                when (payload) {
                    is PayloadResult.Bad -> Decision.Deny(payload.reason, payload.code)
                    is PayloadResult.Ok -> { ok = payload.payload; null }
                }
            },
            IngressDecision.Stage.STOP_ALL to { if (f.halted()) Decision.Deny(Reason.STOP_ALL_ACTIVE, "halted") else null },
            IngressDecision.Stage.TAINT to {
                val p = ok!!
                val bound = f.exemptionBound()
                // The record history ($HOME) and the history outside it, together.
                val kept = if (bound) f.rateHistory() else null
                val human = bound && kept != null &&
                    humanRate(now, (McpRunTickets.acceptedTimes(mine, principal.wire) + kept).distinct(), p.codePoints)
                taint = IngressOrigin.taintFor(
                    IngressOrigin.Facts(principal.origin, IngressDecision.OP_SUBMIT_INSTRUCTION, SCHEMA_VERSION, p.fields, bound, human),
                )
                null
            },
            IngressDecision.Stage.IDEMPOTENT to {
                val nonce = ok!!.nonce
                val existing = if (nonce != null) McpRunTickets.findByNonce(mine, principal.wire, nonce, now) else null
                if (existing != null) Decision.Duplicate(existing) else null
            },
            // Tainted input never gets an unattended approval (Shelly invariant).
            IngressDecision.Stage.ALWAYS_ALLOW to {
                val ruleId = if (taint.tainted) null else f.matchRule(principal.wire)
                if (ruleId != null) Decision.Accept(true, "rule", ruleId, taint) else null
            },
            IngressDecision.Stage.APPROVE_ALL to {
                if (!taint.tainted && f.approveAllOn()) Decision.Accept(true, "approve_all", null, taint) else null
            },
        )
        val decided = IngressDecision.evaluate(IngressDecision.OP_SUBMIT_INSTRUCTION, hooks)
        if (decided != null) return decided
        if (McpRunTickets.pendingCount(mine, principal.wire, now) >= LauncherIngressLimits.MAX_PENDING) {
            return Decision.Deny(Reason.BUSY, "busy")
        }
        return Decision.Accept(false, null, null, taint)
    }
    // ── end decide

    /** The response Bundle's content (fact sheet §1.2), as a plain map. */
    fun denied(reason: Reason, auditEvent: String?, correlationRef: String?): Map<String, Any> {
        val m = LinkedHashMap<String, Any>()
        m["status"] = "denied"
        m["reason"] = reason.name
        if (auditEvent != null) m["audit_event"] = auditEvent
        if (correlationRef != null) m["correlation_ref"] = correlationRef
        return m
    }

    fun accepted(submissionId: String, approved: Boolean, untrusted: Boolean, auditEvent: String, correlationRef: String?, duplicate: Boolean): Map<String, Any> {
        val m = LinkedHashMap<String, Any>()
        m["status"] = "accepted"
        m["approval"] = if (approved) "approved" else "pending"
        m["submission_id"] = submissionId
        m["audit_event"] = auditEvent
        m["untrusted"] = untrusted
        if (correlationRef != null) m["correlation_ref"] = correlationRef
        if (duplicate) m["duplicate"] = true
        return m
    }
}
