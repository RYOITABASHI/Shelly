package expo.modules.terminalemulator

import org.json.JSONArray
import org.json.JSONObject

/**
 * The pure half of launcher ingress Phase 2 (phase 2 fact sheet §1–§5): the
 * owner's asynchronous decision on a pending submission (C6), the approval
 * inbox, the derived `stale` state, and the D2 reader — the MCP typed ops
 * `get_launcher_submission`, `list_launcher_submissions` and
 * `mark_launcher_submission_consumed`. No Android dependency: the JVM test
 * LauncherSubmissionCoreTest covers it. The I/O half is LauncherSubmissions.
 *
 * D8: no new approval store, decision kind or rule format. A decision is one
 * of the existing kinds (deny / once / always, store/mcp-approval-store.ts),
 * taken through the existing approval modal; "always" writes the existing C3
 * rule (launcher principal × submit_instruction × hayato) into
 * McpAlwaysAllowStore. Nothing here ever logs or audits the instruction text.
 */
object LauncherSubmissionCore {
    const val OP_GET = IngressDecision.OP_GET_LAUNCHER_SUBMISSION
    const val OP_LIST = IngressDecision.OP_LIST_LAUNCHER_SUBMISSIONS
    const val OP_CONSUME = IngressDecision.OP_MARK_LAUNCHER_SUBMISSION_CONSUMED
    val READER_OPS: Set<String> = setOf(OP_GET, OP_LIST, OP_CONSUME)

    /** Derived, never stored: approved and not consumed within [LauncherIngressLimits.STALE_AFTER_MS]. */
    const val STATE_STALE = "stale"
    /** Inbox only: a synchronous refusal (read back from the audit log; there is no record). */
    const val STATE_DENIED = "denied"

    private val SUBMISSION_ID_RE = Regex("^ls_[0-9a-f]{32}$")
    private val LAUNCHER_PRINCIPAL_RE = Regex("^launcher:[0-9a-f]{32}$")
    private val CODE_RE = Regex("^[a-z_]{1,32}$")

    // ── States ────────────────────────────────────────────────────────────

    /**
     * The state a reader or the inbox sees: expiry applied, and `approved`
     * past [LauncherIngressLimits.STALE_AFTER_MS] since its approval shown as
     * [STATE_STALE]. Never written (no deletion, no state change on disk).
     */
    fun viewState(s: McpRunTickets.Submission, now: Long): String {
        val cur = McpRunTickets.applySubmissionExpiry(s, now)
        if (cur.state == McpRunTickets.SUB_APPROVED && now - (cur.decidedAt ?: cur.acceptedAt) > LauncherIngressLimits.STALE_AFTER_MS) {
            return STATE_STALE
        }
        return cur.state
    }

    fun expiresAt(s: McpRunTickets.Submission): Long = s.acceptedAt + LauncherIngressLimits.APPROVAL_WINDOW_MS

    /** The reason区分 a non-approved state is reported with (reader and inbox). */
    fun reasonFor(state: String): String = when (state) {
        McpRunTickets.SUB_PENDING -> "awaiting_approval"
        McpRunTickets.SUB_DENIED_BY_USER -> "denied_by_user"
        McpRunTickets.SUB_EXPIRED -> "expired"
        McpRunTickets.SUB_CONSUMED -> "consumed"
        STATE_STALE -> "stale"
        else -> "unknown"
    }

    /** A launcher audit line about [s] (fixed fields only; never the text). */
    fun recordLine(kind: String, code: String, s: McpRunTickets.Submission): IngressAuditWriter.LauncherLine =
        IngressAuditWriter.LauncherLine(
            kind = kind, event = IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code = code, principal = s.principal,
            certDigest = s.certDigest, schemaVersion = s.schemaVersion, submissionId = s.id, correlationRef = s.correlationRef,
            tainted = s.untrusted, exemptApplied = s.exemptApplied, textSha256 = s.textSha256, textCodePoints = s.textCodePoints,
        )

    // ── The owner's decision (C6) ─────────────────────────────────────────

    /** The existing decision kinds (store/mcp-approval-store.ts McpApprovalDecision). Nothing else. */
    enum class UserDecision { DENY, ONCE, ALWAYS }

    fun parseUserDecision(raw: String?): UserDecision? = when (raw) {
        "deny" -> UserDecision.DENY
        "once" -> UserDecision.ONCE
        "always" -> UserDecision.ALWAYS
        else -> null
    }

    /** The submission was accepted from the launcher registration that is still in force. */
    fun registrationValid(entry: TrustedCallerStore.Entry?, s: McpRunTickets.Submission): Boolean =
        entry != null && entry.origin == IngressOrigin.LAUNCHER && entry.enabled && s.certDigest in entry.pins

    sealed class DecisionPlan {
        /** Nothing is written; [code] goes back to RN only. */
        data class Refuse(val code: String) : DecisionPlan()
        /** Audit [auditKind] / [auditCode] first, then write [next]; [addRule]: then the C3 always-allow rule. */
        data class Write(val next: McpRunTickets.Submission, val auditKind: String, val auditCode: String, val addRule: Boolean, val dropText: Boolean) : DecisionPlan()
    }

    /**
     * The owner's decision on [cur] (expiry applied by the caller or here).
     * Only a pending, not expired submission can be decided (expired stays
     * expired, P2-A4). Denying is always possible; approving is refused while
     * STOP-ALL is on or when the launcher registration that accepted it is no
     * longer in force (disabled, removed, re-pinned). "always" approves this
     * one and asks for the C3 rule; whether a later submission is approved at
     * once by it is still LauncherIngressCore.decide's call (untainted only).
     */
    fun planUserDecision(cur: McpRunTickets.Submission?, decision: UserDecision, now: Long, halted: Boolean, registrationValid: Boolean): DecisionPlan {
        if (cur == null) return DecisionPlan.Refuse("not_found")
        if (viewState(cur, now) != McpRunTickets.SUB_PENDING) return DecisionPlan.Refuse("not_pending")
        if (decision == UserDecision.DENY) {
            val next = McpRunTickets.withUserDecision(cur, false, now) ?: return DecisionPlan.Refuse("not_pending")
            return DecisionPlan.Write(next, "launcher_submit_user_denied", "denied_user", addRule = false, dropText = true)
        }
        if (halted) return DecisionPlan.Refuse("halted")
        if (!registrationValid) return DecisionPlan.Refuse("registration_changed")
        val next = McpRunTickets.withUserDecision(cur, true, now) ?: return DecisionPlan.Refuse("not_pending")
        return if (decision == UserDecision.ALWAYS) {
            DecisionPlan.Write(next, "launcher_submit_approved", "approved_always", addRule = true, dropText = false)
        } else {
            DecisionPlan.Write(next, "launcher_submit_approved", "approved_user", addRule = false, dropText = false)
        }
    }

    fun decisionResult(ok: Boolean, code: String, state: String?, rule: String? = null): String {
        val o = JSONObject().put("ok", ok).put("code", code)
        if (state != null) o.put("state", state)
        if (rule != null) o.put("rule", rule)
        return o.toString()
    }

    /** The approval prompt's content: only for a pending submission. The text is for the on-device prompt only. */
    fun promptJson(s: McpRunTickets.Submission, text: String, now: Long): String? {
        if (viewState(s, now) != McpRunTickets.SUB_PENDING) return null
        val o = JSONObject().put("v", 1).put("id", s.id).put("text", text).put("acceptedAt", s.acceptedAt)
            .put("expiresAt", expiresAt(s)).put("untrusted", s.untrusted).put("codePoints", s.textCodePoints)
        if (s.correlationRef != null) o.put("correlationRef", s.correlationRef)
        return o.toString()
    }

    // ── The inbox (§2, read-only presentation) ────────────────────────────

    /** A synchronous refusal of a verified caller, read back from its audit line. */
    data class DeniedEntry(val at: Long, val code: String, val submissionId: String?, val correlationRef: String?)

    /**
     * One `launcher_submit_denied` audit line of a VERIFIED caller (it has a
     * launcher principal; unverified callers are not the owner and are not
     * shown), or null. Display only: nothing is decided from it.
     */
    fun deniedFromAuditLine(line: String): DeniedEntry? = try {
        val o = JSONObject(line)
        val principal = o.opt("principal") as? String
        val code = o.opt("code") as? String
        val ts = (o.opt("ts") as? String)?.let { McpTypedOpDecision.parseIsoMs(it) }
        val id = o.opt("submission_id") as? String
        val corr = o.opt("correlation_ref") as? String
        if (o.opt("kind") != "launcher_submit_denied" || o.opt("event") != IngressAuditWriter.LAUNCHER_EVENT_SUBMIT ||
            principal == null || !LAUNCHER_PRINCIPAL_RE.matches(principal) || code == null || !CODE_RE.matches(code) || ts == null
        ) {
            null
        } else {
            DeniedEntry(
                ts, code,
                if (id != null && SUBMISSION_ID_RE.matches(id)) id else null,
                if (corr != null && IngressAuditWriter.CORRELATION_REF_RE.matches(corr)) corr else null,
            )
        }
    } catch (e: Exception) {
        null
    }

    /** The launcher reason区分 (fact sheet §1.3) of a denial audit code. */
    fun reasonForDeniedCode(code: String): String = when {
        code == "halted" -> LauncherIngressCore.Reason.STOP_ALL_ACTIVE.name
        code == "disabled" -> LauncherIngressCore.Reason.DISABLED.name
        code == "busy" -> LauncherIngressCore.Reason.BUSY.name
        code.endsWith("_too_large") -> LauncherIngressCore.Reason.PAYLOAD_TOO_LARGE.name
        code == "verify_changed" -> LauncherIngressCore.Reason.VERIFY_FAILED.name
        code == "rule_changed" || code == "duplicate_closed" -> LauncherIngressCore.Reason.GATE_DENIED.name
        code == "internal_error" || code == "rate_history_failed" -> LauncherIngressCore.Reason.INTERNAL_ERROR.name
        code.startsWith("text_") || code.startsWith("correlation_") || code.startsWith("nonce_") || code.startsWith("payload_") ->
            LauncherIngressCore.Reason.INVALID_PAYLOAD.name
        else -> LauncherIngressCore.Reason.GATE_DENIED.name
    }

    /**
     * The inbox (P2-B3): records and synchronous refusals, newest first,
     * retention the shorter of the newest [LauncherIngressLimits.INBOX_MAX_RECORDS]
     * and [LauncherIngressLimits.INBOX_MAX_AGE_MS] (a pending one is always
     * listed while it can still be decided). No text: the prompt asks for it
     * separately ([promptJson]).
     */
    fun inboxJson(subs: List<McpRunTickets.Submission>, denied: List<DeniedEntry>, now: Long, halted: Boolean): String {
        class Row(val at: Long, val key: String, val pending: Boolean, val json: JSONObject)
        val rows = ArrayList<Row>()
        for (s in subs) {
            val state = viewState(s, now)
            val pending = state == McpRunTickets.SUB_PENDING
            if (!pending && now - s.acceptedAt > LauncherIngressLimits.INBOX_MAX_AGE_MS) continue
            val cur = McpRunTickets.applySubmissionExpiry(s, now)
            val o = JSONObject().put("kind", "record").put("id", s.id).put("state", state).put("at", s.acceptedAt)
                .put("untrusted", s.untrusted).put("codePoints", s.textCodePoints)
            if (cur.decidedAt != null) o.put("decidedAt", cur.decidedAt)
            if (cur.consumedAt != null) o.put("consumedAt", cur.consumedAt)
            if (cur.approvedVia != null) o.put("approvedVia", cur.approvedVia)
            if (cur.correlationRef != null) o.put("correlationRef", cur.correlationRef)
            if (pending) o.put("expiresAt", expiresAt(s))
            if (state != McpRunTickets.SUB_APPROVED) o.put("reason", reasonFor(state))
            rows.add(Row(s.acceptedAt, s.id, pending, o))
        }
        for ((i, d) in denied.withIndex()) {
            if (now - d.at > LauncherIngressLimits.INBOX_MAX_AGE_MS) continue
            val o = JSONObject().put("kind", "denied").put("state", STATE_DENIED).put("at", d.at)
                .put("code", d.code).put("reason", reasonForDeniedCode(d.code))
            if (d.submissionId != null) o.put("id", d.submissionId)
            if (d.correlationRef != null) o.put("correlationRef", d.correlationRef)
            rows.add(Row(d.at, "d%08d".format(i), false, o))
        }
        val sorted = rows.sortedWith(compareByDescending<Row> { it.at }.thenByDescending { it.key })
        val kept = ArrayList<Row>()
        for (r in sorted) if (r.pending || kept.count { !it.pending } < LauncherIngressLimits.INBOX_MAX_RECORDS) kept.add(r)
        val items = JSONArray()
        for (r in kept) items.put(r.json)
        return JSONObject().put("v", 1).put("now", now).put("halted", halted).put("items", items).toString()
    }

    /**
     * The cheap poll RN runs while Shelly is in the foreground: the pending,
     * still decidable submissions, oldest first (P2-B2: one prompt at a time,
     * oldest first), and whether STOP-ALL is on (then nothing is prompted).
     */
    fun pendingJson(subs: List<McpRunTickets.Submission>, now: Long, halted: Boolean): String {
        val ids = JSONArray()
        subs.filter { viewState(it, now) == McpRunTickets.SUB_PENDING }
            .sortedWith(compareBy<McpRunTickets.Submission>({ it.acceptedAt }, { it.id }))
            .forEach { ids.put(it.id) }
        return JSONObject().put("v", 1).put("halted", halted).put("ids", ids).toString()
    }

    // ── The D2 reader (MCP typed ops) ─────────────────────────────────────

    sealed class ReaderArgs {
        data class Get(val id: String) : ReaderArgs()
        data class ListAll(val limit: Int) : ReaderArgs()
        data class Consume(val id: String) : ReaderArgs()
    }

    private fun bad(m: String) = McpTypedOpDecision.Refusal("invalid_params", m)

    val DISABLED = McpTypedOpDecision.Refusal("disabled", McpTypedOpDecision.TYPED_OPS_DISABLED_MESSAGE)
    val REVOKED = McpTypedOpDecision.Refusal("revoked", "cancelled: the MCP token is no longer valid")
    val HALTED = McpTypedOpDecision.Refusal("halted", "all agents are stopped (STOP-ALL is on); launcher submissions are not read or consumed")
    val EXPIRED = McpTypedOpDecision.Refusal("approval_timeout", "the request expired before it could be answered")
    val NOT_FOUND = McpTypedOpDecision.Refusal("not_found", "no launcher submission with that id (it may have been pruned)")
    val NOT_APPROVED = McpTypedOpDecision.Refusal("not_approved", "only an approved, not stale submission can be consumed; read its state with get_launcher_submission")
    val TEXT_UNAVAILABLE = McpTypedOpDecision.Refusal("text_unavailable", "the approved submission's text could not be read intact; nothing was returned")
    val AUDIT_FAILED = McpTypedOpDecision.Refusal("audit_failed", "nothing was returned: the audit line could not be written")
    val STORE_FAILED = McpTypedOpDecision.Refusal("store_failed", "the submission record could not be read or written")

    /** Strict arguments per op. Returns [ReaderArgs] or a Refusal. Never throws. */
    fun validateReaderArgs(tool: String, args: JSONObject): Any {
        return try {
            val keys = HashSet<String>()
            val it = args.keys()
            while (it.hasNext()) keys.add(it.next())
            when (tool) {
                OP_GET, OP_CONSUME -> {
                    val extra = keys.firstOrNull { k -> k != "submissionId" }
                    if (extra != null) return bad("unknown argument: ${extra.take(40)}")
                    val id = args.opt("submissionId") as? String
                    if (id == null || !SUBMISSION_ID_RE.matches(id)) return bad("submissionId must match ^ls_[0-9a-f]{32}\$")
                    if (tool == OP_GET) ReaderArgs.Get(id) else ReaderArgs.Consume(id)
                }
                OP_LIST -> {
                    val extra = keys.firstOrNull { k -> k != "limit" }
                    if (extra != null) return bad("unknown argument: ${extra.take(40)}")
                    if (!args.has("limit")) return ReaderArgs.ListAll(LauncherIngressLimits.READER_LIST_DEFAULT)
                    val raw = args.opt("limit")
                    val n: Long? = when (raw) {
                        is Int -> raw.toLong()
                        is Long -> raw
                        is Double -> if (raw == Math.floor(raw) && !raw.isInfinite()) raw.toLong() else null
                        else -> null
                    }
                    if (n == null || n < 1L || n > LauncherIngressLimits.READER_LIST_MAX.toLong()) {
                        return bad("limit must be an integer 1..${LauncherIngressLimits.READER_LIST_MAX}")
                    }
                    ReaderArgs.ListAll(n.toInt())
                }
                else -> bad("unknown tool: ${tool.take(40)}")
            }
        } catch (e: Exception) {
            bad("invalid arguments")
        }
    }

    /** The facts, read lazily and in order. Implementations must not throw (fail closed inside). */
    interface ReaderSteps {
        fun typedOpsOn(): Boolean
        fun epochCurrent(): Boolean
        /** STOP-ALL; true when it can't be checked. */
        fun halted(): Boolean
    }

    sealed class ReaderOutcome {
        data class Refuse(val refusal: McpTypedOpDecision.Refusal) : ReaderOutcome()
        data class Proceed(val args: ReaderArgs) : ReaderOutcome()
    }

    /**
     * A reader op through the shared stage order (IngressDecision.evaluate):
     * setting → arguments → epoch → STOP-ALL. No always-allow and no approval
     * tap: the owner already decided on what an approved submission says, and
     * the reader is its intended recipient (D2). STOP-ALL refuses reads and
     * consumption alike (nothing is handed on while everything is stopped).
     */
    fun decideReader(req: McpTypedOpDecision.Request, s: ReaderSteps): ReaderOutcome {
        if (req.tool !in READER_OPS) return ReaderOutcome.Refuse(bad("unknown tool: ${req.tool.take(40)}"))
        var args: ReaderArgs? = null
        val hooks: Map<IngressDecision.Stage, () -> ReaderOutcome?> = mapOf(
            IngressDecision.Stage.SETTING to { if (!s.typedOpsOn()) ReaderOutcome.Refuse(DISABLED) else null },
            IngressDecision.Stage.ARGS to {
                when (val v = validateReaderArgs(req.tool, req.args)) {
                    is ReaderArgs -> { args = v; null }
                    is McpTypedOpDecision.Refusal -> ReaderOutcome.Refuse(v)
                    else -> ReaderOutcome.Refuse(bad("invalid arguments"))
                }
            },
            IngressDecision.Stage.EPOCH to { if (!s.epochCurrent()) ReaderOutcome.Refuse(REVOKED) else null },
            IngressDecision.Stage.STOP_ALL to { if (s.halted()) ReaderOutcome.Refuse(HALTED) else null },
        )
        val refused = IngressDecision.evaluate(req.tool, hooks)
        if (refused != null) return refused
        val a = args ?: return ReaderOutcome.Refuse(bad("invalid arguments"))
        return ReaderOutcome.Proceed(a)
    }

    /**
     * One submission as the reader sees it (fact sheet §4 C2): `approved` →
     * id, state, times, correlation_ref and (only when [text] is given) the
     * full instruction_text; every other state → id, state, times and reason,
     * never the text, whatever [text] is.
     */
    fun readerItem(s: McpRunTickets.Submission, now: Long, text: String?): JSONObject {
        val state = viewState(s, now)
        val cur = McpRunTickets.applySubmissionExpiry(s, now)
        val o = JSONObject().put("submission_id", s.id).put("state", state).put("accepted_at", s.acceptedAt)
        if (cur.decidedAt != null) o.put("decided_at", cur.decidedAt)
        if (cur.consumedAt != null) o.put("consumed_at", cur.consumedAt)
        if (state == McpRunTickets.SUB_APPROVED) {
            if (cur.correlationRef != null) o.put("correlation_ref", cur.correlationRef)
            if (text != null) o.put("instruction_text", text)
        } else {
            o.put("reason", reasonFor(state))
        }
        return o
    }

    fun okResult(data: JSONObject): String = JSONObject().put("ok", true).put("data", data).toString()

    fun errorResult(r: McpTypedOpDecision.Refusal): String = JSONObject().put("ok", false).put("error", r.message).put("code", r.code).toString()

    /** list_launcher_submissions: newest first, inside the inbox retention, at most [limit]; never any text. */
    fun listData(subs: List<McpRunTickets.Submission>, now: Long, limit: Int): JSONObject {
        val arr = JSONArray()
        val shown = subs.filter { now - it.acceptedAt <= LauncherIngressLimits.INBOX_MAX_AGE_MS }
            .sortedWith(compareByDescending<McpRunTickets.Submission> { it.acceptedAt }.thenByDescending { it.id })
            .take(limit.coerceIn(1, LauncherIngressLimits.READER_LIST_MAX))
        for (s in shown) arr.put(readerItem(s, now, null))
        return JSONObject().put("submissions", arr).put("count", arr.length())
    }

    /** mark_launcher_submission_consumed's answer: never the text. */
    fun consumeData(s: McpRunTickets.Submission, now: Long, already: Boolean): JSONObject =
        readerItem(s, now, null).put("already_consumed", already)
}
