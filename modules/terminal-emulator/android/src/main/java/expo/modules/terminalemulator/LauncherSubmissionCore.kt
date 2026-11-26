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
    /** A synchronous refusal of a verified caller (a text-free denial record, McpRunTickets.Denial). */
    const val STATE_DENIED = "denied"

    private val SUBMISSION_ID_RE = Regex("^ls_[0-9a-f]{32}$")

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

    /** A denial record as the inbox and the reader see it: state [STATE_DENIED], its reason区分 and code, never any text. */
    fun deniedJson(d: McpRunTickets.Denial): JSONObject {
        val o = JSONObject().put("kind", "denied").put("id", d.id).put("state", STATE_DENIED).put("at", d.at)
            .put("code", d.code).put("reason", d.reason)
        if (d.correlationRef != null) o.put("correlationRef", d.correlationRef)
        if (d.ref != null) o.put("ref", d.ref)
        return o
    }

    /** One inbox row before the cap: its time, a tie-break key, whether it is still decidable, and its JSON. */
    class InboxRow(val at: Long, val key: String, val pending: Boolean, val json: JSONObject)

    /**
     * The inbox retention (P2-B3, "the shorter of the newest 50 and 7 days")
     * over the COMBINED rows (records + denials): nothing older than
     * [LauncherIngressLimits.INBOX_MAX_AGE_MS] unless still pending, then at
     * most [LauncherIngressLimits.INBOX_MAX_RECORDS] in total, dropping the
     * oldest non-pending rows first. Pending rows (at most MAX_PENDING per
     * principal, fewer than the cap) are kept while decidable; if there were
     * ever more pending rows than the cap, the newest of them are kept. The
     * result never exceeds the cap. Newest first.
     */
    fun capInbox(rows: List<InboxRow>, now: Long): List<InboxRow> {
        val cap = LauncherIngressLimits.INBOX_MAX_RECORDS
        val byNewest = compareByDescending<InboxRow> { it.at }.thenByDescending { it.key }
        val live = rows.filter { it.pending || now - it.at <= LauncherIngressLimits.INBOX_MAX_AGE_MS }
        val pending = live.filter { it.pending }.sortedWith(byNewest).take(cap)
        val others = live.filter { !it.pending }.sortedWith(byNewest).take(cap - pending.size)
        return (pending + others).sortedWith(byNewest)
    }

    /**
     * The inbox (P2-B3): submission records and denial records, newest first,
     * capped by [capInbox]. No text: the prompt asks for it separately
     * ([promptJson]).
     */
    fun inboxJson(subs: List<McpRunTickets.Submission>, denials: List<McpRunTickets.Denial>, now: Long, halted: Boolean): String {
        val rows = ArrayList<InboxRow>()
        for (s in subs) {
            val state = viewState(s, now)
            val pending = state == McpRunTickets.SUB_PENDING
            val cur = McpRunTickets.applySubmissionExpiry(s, now)
            val o = JSONObject().put("kind", "record").put("id", s.id).put("state", state).put("at", s.acceptedAt)
                .put("untrusted", s.untrusted).put("codePoints", s.textCodePoints)
            if (cur.decidedAt != null) o.put("decidedAt", cur.decidedAt)
            if (cur.consumedAt != null) o.put("consumedAt", cur.consumedAt)
            if (cur.approvedVia != null) o.put("approvedVia", cur.approvedVia)
            if (cur.correlationRef != null) o.put("correlationRef", cur.correlationRef)
            if (pending) o.put("expiresAt", expiresAt(s))
            if (state != McpRunTickets.SUB_APPROVED) o.put("reason", reasonFor(state))
            rows.add(InboxRow(s.acceptedAt, s.id, pending, o))
        }
        for (d in denials) rows.add(InboxRow(d.at, d.id, false, deniedJson(d)))
        val items = JSONArray()
        for (r in capInbox(rows, now)) items.put(r.json)
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

    /** The submission id a valid get / consume names; null for list (and before the arguments were checked). */
    fun idOf(args: ReaderArgs?): String? = when (args) {
        is ReaderArgs.Get -> args.id
        is ReaderArgs.Consume -> args.id
        is ReaderArgs.ListAll -> null
        null -> null
    }

    /** The facts, read lazily and in order. Implementations must not throw (fail closed inside). */
    interface ReaderSteps {
        fun typedOpsOn(): Boolean
        fun epochCurrent(): Boolean
        /** STOP-ALL; true when it can't be checked. */
        fun halted(): Boolean
    }

    sealed class ReaderOutcome {
        /** [id]: the submission id once the arguments were valid (get / consume), for the audit line; null before that and for list. */
        data class Refuse(val refusal: McpTypedOpDecision.Refusal, val id: String? = null) : ReaderOutcome()
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
            IngressDecision.Stage.EPOCH to { if (!s.epochCurrent()) ReaderOutcome.Refuse(REVOKED, idOf(args)) else null },
            IngressDecision.Stage.STOP_ALL to { if (s.halted()) ReaderOutcome.Refuse(HALTED, idOf(args)) else null },
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

    /** A denial record as the reader sees it: state `denied`, its time and reason, never text (nothing to approve or consume). */
    fun deniedReaderItem(d: McpRunTickets.Denial): JSONObject =
        JSONObject().put("submission_id", d.id).put("state", STATE_DENIED).put("denied_at", d.at).put("reason", d.reason)

    /**
     * list_launcher_submissions: submissions and denial records, newest first,
     * inside the inbox retention ([capInbox]), at most [limit]; never any text.
     */
    fun listData(subs: List<McpRunTickets.Submission>, denials: List<McpRunTickets.Denial>, now: Long, limit: Int): JSONObject {
        val rows = subs.map { InboxRow(it.acceptedAt, it.id, viewState(it, now) == McpRunTickets.SUB_PENDING, readerItem(it, now, null)) } +
            denials.map { InboxRow(it.at, it.id, false, deniedReaderItem(it)) }
        val arr = JSONArray()
        for (r in capInbox(rows, now).take(limit.coerceIn(1, LauncherIngressLimits.READER_LIST_MAX))) arr.put(r.json)
        return JSONObject().put("submissions", arr).put("count", arr.length())
    }

    /** mark_launcher_submission_consumed's answer: never the text. */
    fun consumeData(s: McpRunTickets.Submission, now: Long, already: Boolean): JSONObject =
        readerItem(s, now, null).put("already_consumed", already)
}
