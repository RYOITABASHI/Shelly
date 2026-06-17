package expo.modules.terminalemulator.scouter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.Locale

class NotificationDispatcher(private val context: Context) {
    private val notificationManager = context.getSystemService(NotificationManager::class.java)
    // Dedup state lives in its own prefs file so it never contends with the
    // ScouterStateStore lock. Each category records the last event key it fired
    // on; a new distinct key replaces the prior notification (stable IDs below)
    // and an unchanged key is skipped (no spam).
    private val dedupPrefs = context.getSharedPreferences("scouter_notifications", Context.MODE_PRIVATE)

    init {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Per-category channels so the user controls each type from the OS
                // notification settings (mute / importance / sound / vibration).
                // Actionable types (approval, choice) and errors default to HIGH so
                // they pop as heads-up; completions / long-running are quiet (LOW).
                val channels = listOf(
                    Triple(CH_APPROVAL, "Codex approvals", NotificationManager.IMPORTANCE_HIGH),
                    Triple(CH_CHOICE, "Codex choices", NotificationManager.IMPORTANCE_HIGH),
                    Triple(CH_ERROR, "Errors", NotificationManager.IMPORTANCE_HIGH),
                    Triple(CH_RATE, "Rate limits", NotificationManager.IMPORTANCE_DEFAULT),
                    Triple(CH_COMPLETED, "Completions", NotificationManager.IMPORTANCE_LOW),
                    Triple(CH_RUNNING, "Long-running", NotificationManager.IMPORTANCE_LOW)
                )
                channels.forEach { (id, name, importance) ->
                    notificationManager.createNotificationChannel(
                        NotificationChannel(id, name, importance).apply {
                            description = "Scouter: $name"
                        }
                    )
                }
                // Drop the old single channel so it doesn't linger as an orphan in
                // the OS settings list. Best-effort; ignored if already gone.
                runCatching { notificationManager.deleteNotificationChannel(LEGACY_CHANNEL_ID) }
                    .onFailure { Log.w(TAG, "Failed to delete legacy Scouter channel", it) }
            }
        }.onFailure { Log.w(TAG, "Failed to create Scouter notification channels", it) }
    }

    // Maps a stable notification id to its category channel (O+). Pre-O the
    // channel id is ignored by the builder, so a missing match is harmless.
    private fun channelForId(id: Int): String = when (id) {
        ID_APPROVAL -> CH_APPROVAL
        ID_CHOICE -> CH_CHOICE
        ID_ERROR -> CH_ERROR
        ID_RATE -> CH_RATE
        ID_REPLY -> CH_COMPLETED
        ID_LONG_RUNNING -> CH_RUNNING
        in 9400 until 9900 -> CH_APPROVAL
        else -> CH_RATE
    }

    // Single entry point per Scouter event. `conversation` is the widget
    // conversation for the bound Codex session (approval text, choice options,
    // widget status) when reachable; null-safe throughout. The whole body is
    // wrapped so a notification failure never disturbs event processing.
    fun maybeNotify(
        event: ScouterEvent,
        snapshot: SessionSnapshot,
        conversation: ScouterWidgetConversation? = null,
        boundPtySessionId: String? = null
    ) {
        when (snapshot.currentStatus) {
            ScouterStatus.ERROR -> notify(
                ID_ERROR,
                "Scouter error",
                event.errorMessage ?: snapshot.lastError ?: "${snapshot.projectName} failed"
            )
            ScouterStatus.COMPLETED -> notifyCompleted(snapshot, conversation)
            ScouterStatus.WAITING_PERMISSION -> notifyApprovalNeeded(snapshot, conversation, boundPtySessionId)
            else -> Unit
        }

        // Drive the remaining triggers off independent signals so they are not
        // mutually exclusive with the status switch above. Each is internally
        // deduped, so it is safe to evaluate them on every event.
        notifyChoiceWaiting(snapshot, conversation, boundPtySessionId)
        notifyRateLimited(snapshot)

        // Cancel resolved interactive notifications so a stale ALLOW/DENY or
        // choice card never lingers after the prompt has moved on.
        cancelResolvedInteractiveNotifications(snapshot, conversation)
    }

    fun notifyLongRunning(snapshot: SessionSnapshot) {
        notify(ID_LONG_RUNNING, "Agent still running", "${snapshot.currentTool ?: "Tool"} · ${snapshot.projectName}")
    }

    // --- Live-poll entry points (additive) -----------------------------------
    // Public wrappers for the live PTS poll. They REUSE the existing private
    // logic + dedup, so they only fire for a genuinely new state and never spam.
    // Guarded so a notification failure never propagates back into the poll.

    fun notifyChoiceWaitingNow(
        snapshot: SessionSnapshot,
        conversation: ScouterWidgetConversation?,
        boundPtySessionId: String?
    ) {
        runCatching { notifyChoiceWaiting(snapshot, conversation, boundPtySessionId) }
            .onFailure { Log.w(TAG, "live choice notify failed", it) }
    }

    fun notifyUsageLimitedNow(snapshot: SessionSnapshot, summary: String) {
        runCatching {
            val key = "${snapshot.sessionId}|usage|$summary"
            // Own dedup key (not KEY_LAST_RATE) so the live usage-limit poll and
            // the JSONL notifyRateLimited never reset each other's dedup. They
            // still share ID_RATE so they replace rather than stack.
            if (!shouldFire(KEY_LAST_USAGE, key)) return
            notify(ID_RATE, "Codex usage limit", summary.ifBlank { "Codex usage limit reached" })
        }.onFailure { Log.w(TAG, "live usage-limit notify failed", it) }
    }

    // --- Reply completed (with text) -----------------------------------------

    private fun notifyCompleted(snapshot: SessionSnapshot, conversation: ScouterWidgetConversation?) {
        val reply = latestReplyText(snapshot, conversation)
        val header = "${snapshot.source.badge()} · ${snapshot.projectName}"
        // Dedup on the completion timestamp + reply so the same finished turn is
        // not re-announced when later snapshot events carry the same COMPLETED
        // status.
        val key = "${snapshot.sessionId}|${snapshot.lastEventAt}|${reply ?: ""}"
        if (!shouldFire(KEY_LAST_REPLY, key)) return
        if (reply.isNullOrBlank()) {
            notify(ID_REPLY, "Agent completed", header)
        } else {
            val truncated = truncate(reply, REPLY_MAX_CHARS)
            notify(
                id = ID_REPLY,
                title = "Agent completed",
                text = truncated,
                bigText = truncated,
                subText = header
            )
        }
    }

    private fun latestReplyText(snapshot: SessionSnapshot, conversation: ScouterWidgetConversation?): String? {
        val answer = conversation?.lastAnswer?.takeIf { it.isNotBlank() }
        val answerAt = conversation?.lastAnswerAt ?: 0L
        // Prefer the parsed assistant message when it belongs to (or is newer
        // than) this completion; otherwise fall back to the snapshot's last
        // message which the COMPLETED event itself carried.
        if (answer != null && answerAt >= snapshot.lastEventAt - REPLY_FRESHNESS_SLOP_MS) {
            return answer.redactForScouter()
        }
        snapshot.lastMessage?.takeIf { it.isNotBlank() }?.let { return it.redactForScouter() }
        return answer?.redactForScouter()
    }

    // --- Approval needed ------------------------------------------------------

    private fun notifyApprovalNeeded(
        snapshot: SessionSnapshot,
        conversation: ScouterWidgetConversation?,
        boundPtySessionId: String?
    ) {
        // Gate on the SAME conditions the widget uses to show actionable
        // ALLOW/DENY pills, plus an explicit policy guard: never alert when the
        // session auto-approves.
        if (snapshot.source != ScouterSource.CODEX) return
        if (isAutoApprovePolicy(snapshot.approvalPolicy)) return
        val approvalAt = conversation?.lastApprovalAt ?: 0L
        val approvalText = conversation?.lastApproval?.takeIf { it.isNotBlank() } ?: return
        if (approvalAt <= 0L) return
        // If a decision has already been recorded for this approval, the pending
        // prompt is resolved — don't (re-)alert.
        val decision = ScouterStateStore.approvalDecisionFromStatus(conversation.widgetStatus)
        val statusAt = conversation.widgetStatusAt ?: 0L
        if (decision != null && statusAt >= approvalAt) return

        // Dedup on the approval anchor (its timestamp). A genuinely new approval
        // has a new lastApprovalAt, so it fires exactly once.
        if (!shouldFire(KEY_LAST_APPROVAL, approvalAt.toString())) return

        val codexSessionId = snapshot.sessionId
        val ptySessionId = boundPtySessionId
        val allow = approvalActionPendingIntent(
            allow = true,
            codexSessionId = codexSessionId,
            ptySessionId = ptySessionId,
            approvalAt = approvalAt,
            approvalText = approvalText
        )
        val deny = approvalActionPendingIntent(
            allow = false,
            codexSessionId = codexSessionId,
            ptySessionId = ptySessionId,
            approvalAt = approvalAt,
            approvalText = approvalText
        )
        // Collapsed view stays short; expanded (BigText) shows the full command /
        // diff being approved so the user knows exactly what they're allowing.
        val redacted = approvalText.redactForScouter()
        notify(
            id = ID_APPROVAL,
            title = "Codex needs approval",
            text = truncate(redacted, REPLY_MAX_CHARS),
            bigText = truncate(redacted, APPROVAL_MAX_CHARS),
            actions = listOf(
                action("Allow", allow),
                action("Deny", deny)
            ),
            autoCancel = false
        )
    }

    fun notifyAgentEscalationNeeded(request: AgentEscalationRequest) {
        runCatching {
            if (!shouldFire(KEY_LAST_AGENT_ESCALATION, request.key)) return

            val actionNonce = AgentEscalationBridge.registerActionNonce(request.runId, request.reqId)
            val allow = agentEscalationActionPendingIntent(allow = true, request, actionNonce)
            val deny = agentEscalationActionPendingIntent(allow = false, request, actionNonce)
            val reason = request.reason?.takeIf { it.isNotBlank() }
            val signalLine = request.signals.takeIf { it.isNotEmpty() }?.joinToString(", ")
            val body = listOfNotNull(
                request.command.redactForScouter(),
                reason?.let { "Reason: ${it.redactForScouter()}" },
                signalLine?.let { "Signals: $it" },
                request.cwd?.takeIf { it.isNotBlank() }?.let { "cwd: ${it.redactForScouter()}" },
            ).joinToString("\n")

            notify(
                id = AgentEscalationBridge.notificationId(request.runId, request.reqId),
                title = "Agent ${shorten(request.agentId, 32)}: approve boundary op?",
                text = truncate(request.command.redactForScouter(), REPLY_MAX_CHARS),
                bigText = truncate(body, APPROVAL_MAX_CHARS),
                actions = listOf(
                    action("Allow", allow),
                    action("Deny", deny)
                ),
                autoCancel = false
            )
        }.onFailure { Log.w(TAG, "agent escalation notify failed", it) }
    }

    // --- Choice waiting -------------------------------------------------------

    private fun notifyChoiceWaiting(
        snapshot: SessionSnapshot,
        conversation: ScouterWidgetConversation?,
        boundPtySessionId: String?
    ) {
        if (snapshot.source != ScouterSource.CODEX) return
        if (conversation?.widgetStatus != ScouterStateStore.choicePendingStatus()) return
        val statusAt = conversation.widgetStatusAt ?: 0L
        if (statusAt <= 0L) return

        // Dedup on the choice onset (its timestamp).
        if (!shouldFire(KEY_LAST_CHOICE, statusAt.toString())) return

        val summary = conversation.widgetError?.takeIf { it.isNotBlank() }
            ?.let { truncate(it.redactForScouter(), REPLY_MAX_CHARS) }
            ?: "Codex is waiting for a terminal selection"

        // Android notifications have a small practical action-button budget, so
        // the first 3 parsed options become buttons. The expanded body lists all
        // parsed options.
        val actionOptions = conversation.choiceOptions.take(3)
        val codexSessionId = snapshot.sessionId
        val ptySessionId = boundPtySessionId
        val actions = actionOptions.map { option ->
            action(
                shorten("${option.index}. ${option.label}", 24),
                choiceSelectActionPendingIntent(codexSessionId, ptySessionId, option)
            )
        }
        // Expanded body lists the menu text + every option, so the choice is
        // readable even on surfaces that hide action buttons (e.g. some lockscreens
        // / minimal launchers). Buttons stay for one-tap selection where available.
        val optionLines = conversation.choiceOptions.joinToString("\n") { shorten("${it.index}. ${it.label}", 80) }
        val bigText = listOf(summary, optionLines).filter { it.isNotBlank() }.joinToString("\n")
        notify(
            id = ID_CHOICE,
            title = "Codex is waiting for a choice",
            text = summary,
            bigText = bigText,
            actions = actions,
            autoCancel = false
        )
    }

    // --- Rate-limit hit -------------------------------------------------------

    private fun notifyRateLimited(snapshot: SessionSnapshot) {
        if (snapshot.rateLimitStatus != ScouterRateLimitStatus.LIMITED) return

        // Dedup on the limit onset: prefer the explicit reset time as a stable
        // marker for the throttle window; otherwise use the session + retry hint.
        val onsetKey = "${snapshot.sessionId}|" +
            (snapshot.rateLimitResetAt
                ?: snapshot.rateLimitPrimaryResetAt
                ?: snapshot.retryAfterSeconds
                ?: "limited").toString()
        if (!shouldFire(KEY_LAST_RATE, onsetKey)) return

        val hint = rateLimitHint(snapshot)
        notify(
            ID_RATE,
            "Codex rate limited",
            hint ?: "Usage limit reached for ${snapshot.projectName}"
        )
    }

    private fun rateLimitHint(snapshot: SessionSnapshot): String? {
        val parts = mutableListOf<String>()
        snapshot.rateLimitResetAt?.let {
            val remaining = ((it - System.currentTimeMillis()) / 1000L)
            if (remaining > 0L) parts += "Resets in ${formatDuration(remaining)}"
        }
        if (parts.isEmpty()) {
            snapshot.retryAfterSeconds?.takeIf { it > 0L }?.let {
                parts += "Retry in ${formatDuration(it)}"
            }
        }
        snapshot.rateLimitRemainingRequests?.let { parts += "Req left $it" }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    // --- Cancellation of resolved interactive notifications -------------------

    private fun cancelResolvedInteractiveNotifications(
        snapshot: SessionSnapshot,
        conversation: ScouterWidgetConversation?
    ) {
        // Only the bound-Codex conversation is authoritative for these interactive
        // notifications, so skip when this event is not for the bound session
        // (conversation == null) to avoid prematurely cancelling a still-pending
        // approval/choice when an unrelated session's event arrives.
        if (conversation == null) return
        // Approval resolved: status moved past pending (a decision recorded) or
        // the bound session is no longer waiting for permission.
        val approvalResolved = snapshot.currentStatus != ScouterStatus.WAITING_PERMISSION ||
            ScouterStateStore.approvalDecisionFromStatus(conversation.widgetStatus) != null
        if (approvalResolved) {
            runCatching { notificationManager.cancel(ID_APPROVAL) }
                .onFailure { Log.w(TAG, "Failed to cancel approval notification", it) }
        }
        // Choice resolved: widget status is no longer choice_pending.
        if (conversation.widgetStatus != ScouterStateStore.choicePendingStatus()) {
            runCatching { notificationManager.cancel(ID_CHOICE) }
                .onFailure { Log.w(TAG, "Failed to cancel choice notification", it) }
        }
    }

    // --- Dedup helper ---------------------------------------------------------

    // Returns true exactly when `key` differs from the last value recorded under
    // `prefKey` (and records it). Empty keys never fire. Persisted in
    // SharedPreferences like the rest of Scouter so dedup survives process death.
    private fun shouldFire(prefKey: String, key: String): Boolean {
        if (key.isBlank()) return false
        val previous = dedupPrefs.getString(prefKey, null)
        if (previous == key) return false
        dedupPrefs.edit().putString(prefKey, key).apply()
        return true
    }

    // --- PendingIntent builders (reuse ScouterWidgetPromptActivity intents) ---
    // Distinct request codes (9300+) from the widget's (9100-9110) so notification
    // PendingIntents never clobber the widget's.

    private fun approvalActionPendingIntent(
        allow: Boolean,
        codexSessionId: String?,
        ptySessionId: String?,
        approvalAt: Long,
        approvalText: String?
    ): PendingIntent {
        val intent = Intent(context, ScouterWidgetPromptActivity::class.java)
            .setAction(
                if (allow) {
                    ScouterWidgetPromptActivity.ACTION_APPROVAL_ALLOW
                } else {
                    ScouterWidgetPromptActivity.ACTION_APPROVAL_DENY
                }
            )
            .putExtra(ScouterWidgetPromptActivity.EXTRA_CODEX_SESSION_ID, codexSessionId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_PTY_SESSION_ID, ptySessionId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_APPROVAL_AT, approvalAt)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_APPROVAL_TEXT, approvalText)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_NO_HISTORY or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            )
        return PendingIntent.getActivity(
            context,
            if (allow) REQ_APPROVAL_ALLOW else REQ_APPROVAL_DENY,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun agentEscalationActionPendingIntent(
        allow: Boolean,
        request: AgentEscalationRequest,
        actionNonce: String
    ): PendingIntent {
        val intent = Intent(context, ScouterWidgetPromptActivity::class.java)
            .setAction(
                if (allow) {
                    ScouterWidgetPromptActivity.ACTION_AGENT_ESCALATION_ALLOW
                } else {
                    ScouterWidgetPromptActivity.ACTION_AGENT_ESCALATION_DENY
                }
            )
            .putExtra(ScouterWidgetPromptActivity.EXTRA_AGENT_ESCALATION_RUN_ID, request.runId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_AGENT_ESCALATION_REQ_ID, request.reqId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_AGENT_ESCALATION_AGENT_ID, request.agentId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_AGENT_ESCALATION_ACTION_NONCE, actionNonce)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_NO_HISTORY or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            )
        val key = "${request.runId}:${request.reqId}:${if (allow) "allow" else "deny"}"
        val requestCode = REQ_AGENT_ESCALATION_BASE + (key.hashCode() and 0x7fffffff) % REQ_AGENT_ESCALATION_SPAN
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun choiceSelectActionPendingIntent(
        codexSessionId: String?,
        ptySessionId: String?,
        option: ChoiceOption
    ): PendingIntent {
        val intent = Intent(context, ScouterWidgetPromptActivity::class.java)
            .setAction(ScouterWidgetPromptActivity.ACTION_CHOICE_SELECT)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_CODEX_SESSION_ID, codexSessionId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_PTY_SESSION_ID, ptySessionId)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_CHOICE_INDEX, option.index)
            .putExtra(ScouterWidgetPromptActivity.EXTRA_CHOICE_LABEL, option.label)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK or
                    Intent.FLAG_ACTIVITY_NO_HISTORY or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            )
        // Distinct request code per option index so the action PendingIntents do
        // not coalesce (extras would otherwise be shared).
        return PendingIntent.getActivity(
            context,
            REQ_CHOICE_BASE + option.index,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    // --- Low-level notify -----------------------------------------------------

    @Suppress("DEPRECATION")
    private fun action(title: String, pendingIntent: PendingIntent): Notification.Action {
        // Icon may be null on all supported API levels (mirrors
        // TerminalSessionService); avoids inventing a drawable resource.
        return Notification.Action.Builder(null as android.graphics.drawable.Icon?, title, pendingIntent).build()
    }

    private fun notify(
        id: Int,
        title: String,
        text: String,
        bigText: String? = null,
        subText: String? = null,
        actions: List<Notification.Action> = emptyList(),
        autoCancel: Boolean = true
    ) {
        runCatching {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pendingLaunch = if (launchIntent != null) {
                PendingIntent.getActivity(
                    context,
                    id,
                    launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            } else null

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, channelForId(id))
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            builder
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(pendingLaunch)
                .setAutoCancel(autoCancel)
            subText?.let { builder.setSubText(it) }
            bigText?.let { builder.setStyle(Notification.BigTextStyle().bigText(it)) }
            actions.forEach { builder.addAction(it) }
            notificationManager.notify(id, builder.build())
        }
            .onFailure { Log.w(TAG, "Failed to post Scouter notification id=$id", it) }
    }

    // --- Small utilities ------------------------------------------------------

    private fun isAutoApprovePolicy(policy: String?): Boolean =
        policy?.trim()?.lowercase(Locale.US) == "never"

    private fun truncate(value: String, max: Int): String {
        val cleaned = value.replace(Regex("\\s+"), " ").trim()
        return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
    }

    private fun shorten(value: String, max: Int): String = truncate(value, max)

    private fun formatDuration(seconds: Long): String =
        if (seconds >= 60L) "${seconds / 60L}m" else "${seconds}s"

    companion object {
        private const val TAG = "ScouterNotification"
        // Legacy single channel (pre-2026-06), deleted on init now that each
        // category has its own channel below.
        private const val LEGACY_CHANNEL_ID = "scouter"
        private const val CH_APPROVAL = "scouter_approval"
        private const val CH_CHOICE = "scouter_choice"
        private const val CH_ERROR = "scouter_error"
        private const val CH_RATE = "scouter_rate"
        private const val CH_COMPLETED = "scouter_completed"
        private const val CH_RUNNING = "scouter_running"

        // Stable notification IDs per category so a new state REPLACES the prior
        // notification (never stacks). Distinct from the existing 9201-9203.
        private const val ID_ERROR = 9201
        private const val ID_LONG_RUNNING = 9203
        private const val ID_APPROVAL = 9301
        private const val ID_CHOICE = 9302
        private const val ID_RATE = 9303
        private const val ID_REPLY = 9304

        // Action PendingIntent request codes, distinct from the widget's
        // 9100-9110 so notification actions never clobber the widget's intents.
        private const val REQ_APPROVAL_ALLOW = 9310
        private const val REQ_APPROVAL_DENY = 9311
        private const val REQ_CHOICE_BASE = 9320
        private const val REQ_AGENT_ESCALATION_BASE = 9400
        private const val REQ_AGENT_ESCALATION_SPAN = 500

        // Dedup pref keys.
        private const val KEY_LAST_APPROVAL = "last_approval_at"
        private const val KEY_LAST_AGENT_ESCALATION = "last_agent_escalation"
        private const val KEY_LAST_CHOICE = "last_choice_at"
        private const val KEY_LAST_RATE = "last_rate_onset"
        private const val KEY_LAST_USAGE = "last_usage_onset"
        private const val KEY_LAST_REPLY = "last_reply_key"

        private const val REPLY_MAX_CHARS = 120
        // Expanded (BigText) approval body: long enough to show the full command /
        // diff being approved without unbounded growth.
        private const val APPROVAL_MAX_CHARS = 400
        // Allow the assistant message to be counted as "this turn's reply" even
        // when its parsed timestamp slightly precedes the COMPLETED event.
        private const val REPLY_FRESHNESS_SLOP_MS = 30_000L
    }
}
