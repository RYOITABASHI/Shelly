package expo.modules.terminalemulator

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream

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
    /** How much of the audit file's tail the inbox reads for synchronous refusals. */
    private const val AUDIT_TAIL_BYTES = 256 * 1024

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

    /** The inbox JSON (LauncherSubmissionCore.inboxJson), or null when the records can't be read. Never throws. */
    fun inboxJson(context: Context): String? = try {
        val subs = McpRunTickets.allSubmissionsCurrent(context)
        if (subs == null) {
            null
        } else {
            val denied = readAuditTail(context).mapNotNull { LauncherSubmissionCore.deniedFromAuditLine(it) }
            LauncherSubmissionCore.inboxJson(subs, denied, System.currentTimeMillis(), StopAllSwitches.halted(context))
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

    /** The complete lines of the last [AUDIT_TAIL_BYTES] of `audits/mcp-ingress-audit.jsonl`; empty when unreadable. */
    private fun readAuditTail(context: Context): List<String> = try {
        val f = File(HomeInitializer.getHomeDir(context), ".shelly/agents/audits/${IngressAuditWriter.MCP_AGENTLESS_FILE}")
        val st = try { Os.lstat(f.path) } catch (e: Exception) { null }
        if (st == null || !OsConstants.S_ISREG(st.st_mode)) {
            emptyList()
        } else {
            val fd = Os.open(f.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK, 0)
            try {
                // A stream over a FileDescriptor does not own it on Android: the fd is closed below.
                val input = FileInputStream(fd)
                val size = Os.fstat(fd).st_size
                val skip = if (size > AUDIT_TAIL_BYTES) size - AUDIT_TAIL_BYTES else 0L
                if (skip > 0L) input.channel.position(skip)
                val buf = ByteArray(AUDIT_TAIL_BYTES)
                var n = 0
                while (n < buf.size) {
                    val r = input.read(buf, n, buf.size - n)
                    if (r < 0) break
                    n += r
                }
                val lines = String(buf, 0, n, Charsets.UTF_8).split('\n')
                // A tail that starts mid-file starts mid-line: drop that first piece.
                (if (skip > 0L) lines.drop(1) else lines).filter { it.isNotBlank() }
            } finally {
                runCatching { Os.close(fd) }
            }
        }
    } catch (e: Exception) {
        emptyList()
    }

    // ── The D2 reader (McpTypedOpConsumer) ────────────────────────────────

    private class Reply(val code: String, val json: String, val audited: Boolean = false)

    private fun kindOf(args: LauncherSubmissionCore.ReaderArgs): String = when (args) {
        is LauncherSubmissionCore.ReaderArgs.Get -> "launcher_submission_get"
        is LauncherSubmissionCore.ReaderArgs.ListAll -> "launcher_submission_list"
        is LauncherSubmissionCore.ReaderArgs.Consume -> "launcher_submission_consume"
    }

    /** A refusal's audit line (best effort; the answer is the refusal either way). */
    fun auditRefusal(context: Context, tool: String, principal: String?, code: String) {
        val kind = when (tool) {
            LauncherSubmissionCore.OP_GET -> "launcher_submission_get"
            LauncherSubmissionCore.OP_LIST -> "launcher_submission_list"
            LauncherSubmissionCore.OP_CONSUME -> "launcher_submission_consume"
            else -> return
        }
        if (!IngressAuditWriter.appendSubmissionReaderLine(context, kind, principal, null, code, null)) {
            Log.w(TAG, "reader audit line not written ($kind $code)")
        }
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
                        if (subs == null) {
                            refuse(LauncherSubmissionCore.STORE_FAILED)
                        } else {
                            val data = LauncherSubmissionCore.listData(subs, System.currentTimeMillis(), args.limit)
                            val count = data.optInt("count", 0)
                            if (!line("ok", count)) {
                                Reply("audit_failed", LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED), audited = true)
                            } else {
                                Reply("ok", LauncherSubmissionCore.okResult(data), audited = true)
                            }
                        }
                    }
                }
                is LauncherSubmissionCore.ReaderArgs.Get -> McpRunTickets.submissionUpdate<Reply>(
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
                is LauncherSubmissionCore.ReaderArgs.Consume -> {
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
