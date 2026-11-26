package expo.modules.terminalemulator

import android.content.Context
import android.util.Log

/**
 * The I/O half of launcher ingress Phase 2 (pure half: LauncherSubmissionCore).
 *
 *  - [decide]: the owner's decision on a pending submission, taken in the
 *    existing MCP approval modal (RN) with the existing kinds deny / once /
 *    always. Audit line first (launcher_submit_approved / _user_denied), then
 *    the record; "always" then writes the existing C3 rule into
 *    McpAlwaysAllowStore. Lock order as the launcher Provider:
 *    TrustedCallerStore → McpRunTickets → McpAlwaysAllowStore.
 *  - [promptJson] / [inboxJson]: what RN shows. The text goes only to the
 *    on-device prompt of a pending submission.
 *  - [answerReader]: the D2 reader ops, called by McpTypedOpConsumer after the
 *    shared stage order passed. The text goes only to an approved, not stale
 *    submission's `get_launcher_submission`, after its audit line was written.
 *
 * Nothing here logs or audits the instruction text.
 */
object LauncherSubmissions {
    private const val TAG = "LauncherSubmissions"

    // ── The owner's decision (C6) ─────────────────────────────────────────

    /**
     * [decision] is one of the existing kinds (`deny` | `once` | `always`);
     * anything else is refused. Returns `{ok, code, state?, rule?}`. Never throws.
     */
    fun decide(context: Context, id: String, decision: String): String {
        val d = LauncherSubmissionCore.parseUserDecision(decision)
            ?: return LauncherSubmissionCore.decisionResult(false, "invalid", null)
        if (!McpRunTickets.isSubmissionId(id)) return LauncherSubmissionCore.decisionResult(false, "invalid", null)
        return try {
            synchronized(TrustedCallerStore) {
                var plan: LauncherSubmissionCore.DecisionPlan? = null
                val out = McpRunTickets.submissionUpdate<String>(
                    context, id,
                    body = { cur, _, now ->
                        val p = LauncherSubmissionCore.planUserDecision(
                            cur, d, now,
                            halted = StopAllSwitches.halted(context),
                            registrationValid = cur != null &&
                                LauncherSubmissionCore.registrationValid(TrustedCallerStore.entry(context, IngressOrigin.LAUNCHER), cur),
                        )
                        plan = p
                        when (p) {
                            is LauncherSubmissionCore.DecisionPlan.Refuse ->
                                Pair(LauncherSubmissionCore.decisionResult(false, p.code, cur?.let { LauncherSubmissionCore.viewState(it, now) }), McpRunTickets.SubmissionChange.None)
                            is LauncherSubmissionCore.DecisionPlan.Write -> Pair(
                                LauncherSubmissionCore.decisionResult(true, p.auditCode, p.next.state),
                                McpRunTickets.SubmissionChange.Rewrite(p.next, p.dropText) {
                                    IngressAuditWriter.appendLauncherLine(context, LauncherSubmissionCore.recordLine(p.auditKind, p.auditCode, p.next))
                                },
                            )
                        }
                    },
                    onResult = { answer, result ->
                        when (result) {
                            McpRunTickets.SubmissionWriteResult.WRITTEN -> {
                                val p = plan
                                if (p is LauncherSubmissionCore.DecisionPlan.Write && p.addRule) {
                                    // The existing C3 rule (launcher principal × submit_instruction × hayato), no bind.
                                    val added = try {
                                        McpAlwaysAllowStore.add(
                                            context, p.next.principal, IngressDecision.OP_SUBMIT_INSTRUCTION, LauncherIngressCore.TARGET, null,
                                            context.getString(R.string.launcher_review_rule_label),
                                        )
                                    } catch (e: Exception) {
                                        null
                                    }
                                    val ruleOk = added != null && org.json.JSONObject(added).optBoolean("ok", false)
                                    LauncherSubmissionCore.decisionResult(true, p.auditCode, p.next.state, if (ruleOk) "added" else "failed")
                                } else {
                                    answer
                                }
                            }
                            McpRunTickets.SubmissionWriteResult.NOT_WRITTEN -> answer
                            McpRunTickets.SubmissionWriteResult.REFUSED_BY_AUDIT -> LauncherSubmissionCore.decisionResult(false, "audit_failed", null)
                            McpRunTickets.SubmissionWriteResult.FAILED -> LauncherSubmissionCore.decisionResult(false, "store_failed", null)
                        }
                    },
                )
                if (plan is LauncherSubmissionCore.DecisionPlan.Write) LauncherApprovalNotifier.refreshAsync(context)
                out ?: LauncherSubmissionCore.decisionResult(false, "store_failed", null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "decision failed type=${e.javaClass.simpleName}")
            LauncherSubmissionCore.decisionResult(false, "store_failed", null)
        }
    }

    // ── What RN shows ─────────────────────────────────────────────────────

    /** The prompt of a pending submission (with its text, for the on-device prompt only), or null. Never throws. */
    fun promptJson(context: Context, id: String): String? {
        if (!McpRunTickets.isSubmissionId(id)) return null
        return try {
            McpRunTickets.submissionUpdate<String?>(
                context, id,
                body = { cur, text, now ->
                    val json = if (cur == null || LauncherSubmissionCore.viewState(cur, now) != McpRunTickets.SUB_PENDING) {
                        null
                    } else {
                        text()?.let { LauncherSubmissionCore.promptJson(cur, it, now) }
                    }
                    Pair(json, McpRunTickets.SubmissionChange.None)
                },
                onResult = { answer, _ -> answer },
            )
        } catch (e: Exception) {
            Log.w(TAG, "prompt read failed type=${e.javaClass.simpleName}")
            null
        }
    }

    /**
     * The inbox JSON (LauncherSubmissionCore.inboxJson): the submission
     * records and the denial records kept next to them (McpRunTickets.Denial),
     * or null when either can't be read. Never throws.
     */
    fun inboxJson(context: Context): String? = try {
        val subs = McpRunTickets.allSubmissionsCurrent(context)
        val denials = McpRunTickets.allDenialsCurrent(context)
        if (subs == null || denials == null) {
            null
        } else {
            LauncherSubmissionCore.inboxJson(subs, denials, System.currentTimeMillis(), StopAllSwitches.halted(context))
        }
    } catch (e: Exception) {
        Log.w(TAG, "inbox read failed type=${e.javaClass.simpleName}")
        null
    }

    /** The pending ids, oldest first, and STOP-ALL (LauncherSubmissionCore.pendingJson); null when unreadable. Never throws. */
    fun pendingJson(context: Context): String? = try {
        val subs = McpRunTickets.allSubmissionsCurrent(context)
        if (subs == null) null else LauncherSubmissionCore.pendingJson(subs, System.currentTimeMillis(), StopAllSwitches.halted(context))
    } catch (e: Exception) {
        Log.w(TAG, "pending read failed type=${e.javaClass.simpleName}")
        null
    }

    // ── The D2 reader (McpTypedOpConsumer) ────────────────────────────────

    private class Reply(val code: String, val json: String, val audited: Boolean = false)

    private fun kindOf(args: LauncherSubmissionCore.ReaderArgs): String = when (args) {
        is LauncherSubmissionCore.ReaderArgs.Get -> "launcher_submission_get"
        is LauncherSubmissionCore.ReaderArgs.ListAll -> "launcher_submission_list"
        is LauncherSubmissionCore.ReaderArgs.Consume -> "launcher_submission_consume"
    }

    /**
     * A refusal's audit line. [submissionId]: the id of a get / consume whose
     * arguments were valid (null when they were not, and for list). Returns
     * whether the line was written: the caller answers `audit_failed` instead
     * of the refusal when it was not (P2-C4, fail closed like every reader answer).
     */
    fun auditRefusal(context: Context, tool: String, principal: String?, submissionId: String?, code: String): Boolean {
        val kind = when (tool) {
            LauncherSubmissionCore.OP_GET -> "launcher_submission_get"
            LauncherSubmissionCore.OP_LIST -> "launcher_submission_list"
            LauncherSubmissionCore.OP_CONSUME -> "launcher_submission_consume"
            else -> return false
        }
        val id = if (tool == LauncherSubmissionCore.OP_LIST || !McpRunTickets.isSubmissionId(submissionId)) null else submissionId
        val ok = IngressAuditWriter.appendSubmissionReaderLine(context, kind, principal, id, code, null)
        if (!ok) Log.w(TAG, "reader audit line not written ($kind $code)")
        return ok
    }

    /**
     * One reader op that passed the stage order. [recheck] (the epoch, the
     * setting, STOP-ALL) runs again under the record lock, right before
     * anything is returned or written. Every answer is audited (principal,
     * submission id, code; never the text); an answer whose line could not be
     * written is `audit_failed` instead (fail closed). Never throws.
     */
    fun answerReader(
        context: Context,
        principal: String,
        args: LauncherSubmissionCore.ReaderArgs,
        recheck: () -> McpTypedOpDecision.Refusal?,
    ): String {
        val kind = kindOf(args)
        val id: String? = when (args) {
            is LauncherSubmissionCore.ReaderArgs.Get -> args.id
            is LauncherSubmissionCore.ReaderArgs.Consume -> args.id
            is LauncherSubmissionCore.ReaderArgs.ListAll -> null
        }
        fun refuse(r: McpTypedOpDecision.Refusal) = Reply(r.code, LauncherSubmissionCore.errorResult(r))
        fun line(code: String, count: Int? = null) = IngressAuditWriter.appendSubmissionReaderLine(context, kind, principal, id, code, count)

        val reply: Reply = try {
            when (args) {
                is LauncherSubmissionCore.ReaderArgs.ListAll -> {
                    val r = recheck()
                    if (r != null) {
                        refuse(r)
                    } else {
                        val subs = McpRunTickets.allSubmissionsCurrent(context)
                        val denials = McpRunTickets.allDenialsCurrent(context)
                        if (subs == null || denials == null) {
                            refuse(LauncherSubmissionCore.STORE_FAILED)
                        } else {
                            val data = LauncherSubmissionCore.listData(subs, denials, System.currentTimeMillis(), args.limit)
                            val count = data.optInt("count", 0)
                            if (!line("ok", count)) {
                                Reply("audit_failed", LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED), audited = true)
                            } else {
                                Reply("ok", LauncherSubmissionCore.okResult(data), audited = true)
                            }
                        }
                    }
                }
                // A denial record (synchronous refusal): state denied and its reason, never text.
                is LauncherSubmissionCore.ReaderArgs.Get -> McpRunTickets.readDenial(context, args.id)?.let { d ->
                    val r = recheck()
                    if (r != null) refuse(r) else Reply("ok", LauncherSubmissionCore.okResult(LauncherSubmissionCore.deniedReaderItem(d)))
                } ?: McpRunTickets.submissionUpdate<Reply>(
                    context, args.id,
                    body = { cur, text, now ->
                        val r = recheck()
                        val answerOf = when {
                            r != null -> refuse(r)
                            cur == null -> refuse(LauncherSubmissionCore.NOT_FOUND)
                            LauncherSubmissionCore.viewState(cur, now) == McpRunTickets.SUB_APPROVED -> {
                                val t = text()
                                when {
                                    t == null -> refuse(LauncherSubmissionCore.TEXT_UNAVAILABLE)
                                    // The text leaves only after its line was written (fail closed).
                                    !line("ok_text") -> Reply("audit_failed", LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED), audited = true)
                                    else -> Reply("ok_text", LauncherSubmissionCore.okResult(LauncherSubmissionCore.readerItem(cur, now, t)), audited = true)
                                }
                            }
                            // Any other state: state, times and reason only, never the text.
                            else -> Reply("ok", LauncherSubmissionCore.okResult(LauncherSubmissionCore.readerItem(cur, now, null)))
                        }
                        Pair(answerOf, McpRunTickets.SubmissionChange.None)
                    },
                    onResult = { answer, _ -> answer },
                ) ?: refuse(LauncherSubmissionCore.STORE_FAILED)
                is LauncherSubmissionCore.ReaderArgs.Consume -> if (McpRunTickets.readDenial(context, args.id) != null) {
                    // A denial record was never approved: it can't be consumed.
                    recheck()?.let { refuse(it) } ?: refuse(LauncherSubmissionCore.NOT_APPROVED)
                } else {
                    McpRunTickets.submissionUpdate<Reply>(
                        context, args.id,
                        body = { cur, _, now ->
                            val r = recheck()
                            when {
                                r != null -> Pair(refuse(r), McpRunTickets.SubmissionChange.None)
                                cur == null -> Pair(refuse(LauncherSubmissionCore.NOT_FOUND), McpRunTickets.SubmissionChange.None)
                                // Idempotent per id: consumed again answers consumed, never the text.
                                cur.state == McpRunTickets.SUB_CONSUMED ->
                                    Pair(Reply("already_consumed", LauncherSubmissionCore.okResult(LauncherSubmissionCore.consumeData(cur, now, true))), McpRunTickets.SubmissionChange.None)
                                else -> {
                                    val n = McpRunTickets.withConsumed(cur, now)
                                    if (n == null) {
                                        Pair(refuse(LauncherSubmissionCore.NOT_APPROVED), McpRunTickets.SubmissionChange.None)
                                    } else {
                                        Pair(
                                            Reply("consumed", LauncherSubmissionCore.okResult(LauncherSubmissionCore.consumeData(n, now, false)), audited = true),
                                            // The text is deleted once consumed: nobody may read it any more.
                                            McpRunTickets.SubmissionChange.Rewrite(n, true) { line("consumed") },
                                        )
                                    }
                                }
                            }
                        },
                        onResult = { answer, result ->
                            when (result) {
                                McpRunTickets.SubmissionWriteResult.WRITTEN, McpRunTickets.SubmissionWriteResult.NOT_WRITTEN -> answer
                                McpRunTickets.SubmissionWriteResult.REFUSED_BY_AUDIT ->
                                    Reply("audit_failed", LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED), audited = true)
                                McpRunTickets.SubmissionWriteResult.FAILED -> refuse(LauncherSubmissionCore.STORE_FAILED)
                            }
                        },
                    ) ?: refuse(LauncherSubmissionCore.STORE_FAILED)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "reader failed type=${e.javaClass.simpleName}")
            refuse(LauncherSubmissionCore.STORE_FAILED)
        }
        if (!reply.audited && !line(reply.code)) {
            // Every answer is audited; one whose line is missing is not given.
            return LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED)
        }
        return reply.json
    }
}
