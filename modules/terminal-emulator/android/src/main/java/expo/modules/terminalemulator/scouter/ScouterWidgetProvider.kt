package expo.modules.terminalemulator.scouter

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import expo.modules.terminalemulator.R
import expo.modules.terminalemulator.TerminalSessionService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ScouterWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_WAIT_EXPIRY_REFRESH -> {
                val pending = goAsync()
                enqueueUpdate(context, null, pending::finish, force = true)
            }
            AppWidgetManager.ACTION_APPWIDGET_UPDATE -> {
                val ids = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS)
                val pending = goAsync()
                enqueueUpdate(context, ids, pending::finish)
            }
            AppWidgetManager.ACTION_APPWIDGET_OPTIONS_CHANGED -> {
                val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
                val ids = if (id != AppWidgetManager.INVALID_APPWIDGET_ID) intArrayOf(id) else null
                val pending = goAsync()
                enqueueUpdate(context, ids, pending::finish)
            }
            else -> super.onReceive(context, intent)
        }
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        enqueueUpdate(context, ids)
    }

    companion object {
        fun updateAll(context: Context, force: Boolean = false) {
            enqueueUpdate(context, null, force = force)
        }

        private val widgetExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "ScouterWidgetUpdate").apply { isDaemon = true }
        }
        private val coalescedUpdateRunning = AtomicBoolean(false)
        private val coalescedUpdatePending = AtomicBoolean(false)

        private fun enqueueUpdate(
            context: Context,
            ids: IntArray?,
            onDone: (() -> Unit)? = null,
            force: Boolean = false
        ) {
            val appContext = context.applicationContext
            val coalescible = ids == null && onDone == null
            if (coalescible && !force) {
                coalescedUpdatePending.set(true)
                if (!coalescedUpdateRunning.compareAndSet(false, true)) return
                widgetExecutor.execute { drainCoalescedUpdates(appContext) }
                return
            }

            widgetExecutor.execute {
                try {
                    performUpdate(appContext, ids)
                } catch (error: Throwable) {
                    Log.w(TAG, "Scouter widget async update failed", error)
                } finally {
                    onDone?.invoke()
                }
            }
        }

        private fun drainCoalescedUpdates(context: Context) {
            try {
                while (coalescedUpdatePending.getAndSet(false)) {
                    try {
                        performUpdate(context, null)
                    } catch (error: Throwable) {
                        Log.w(TAG, "Scouter widget async update failed", error)
                    }
                }
            } finally {
                coalescedUpdateRunning.set(false)
                if (
                    coalescedUpdatePending.get() &&
                    coalescedUpdateRunning.compareAndSet(false, true)
                ) {
                    widgetExecutor.execute { drainCoalescedUpdates(context) }
                }
            }
        }

        private fun performUpdate(context: Context, ids: IntArray?) {
            val manager = AppWidgetManager.getInstance(context)
            val targetIds = ids?.takeIf { it.isNotEmpty() }
                ?: manager.getAppWidgetIds(ComponentName(context, ScouterWidgetProvider::class.java))
            if (targetIds.isEmpty()) return
            updateWidgets(context, manager, targetIds)
        }

        private fun updateWidgets(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val store = ScouterStateStore(context)
            val snapshots = if (store.isEnabled()) store.all() else emptyList()
            val binding = if (store.isEnabled()) store.widgetCodexBinding() else null
            val conversation = if (store.isEnabled()) store.widgetConversation(binding?.codexSessionId) else null
            val load = runCatching { ScouterSystemSampler(context).sample() }
                .getOrElse {
                    Log.w(TAG, "Scouter widget system sample failed; using lightweight load", it)
                    lightweightLoad()
                }
            scheduleWaitExpiryRefresh(context, conversation)
            ids.forEach { id ->
                runCatching { manager.updateAppWidget(id, render(context, snapshots, binding, conversation, load)) }
                    .onFailure { Log.w(TAG, "Scouter widget update failed for id=$id", it) }
            }
        }

        private fun scheduleWaitExpiryRefresh(context: Context, conversation: ScouterWidgetConversation?) {
            val status = conversation?.widgetStatus
            val statusAt = conversation?.widgetStatusAt
            if (statusAt == null) {
                cancelWaitExpiryRefresh(context)
                return
            }
            val displayMs = when {
                status in WAITING_WIDGET_STATUSES -> WIDGET_WAIT_DISPLAY_TIMEOUT_MS
                status == ScouterStateStore.choicePendingStatus() -> WIDGET_CHOICE_DISPLAY_TIMEOUT_MS
                status == "approval_allow" || status == "approval_deny" -> WIDGET_APPROVAL_SENT_DISPLAY_MS
                else -> null
            }
            if (displayMs == null) {
                cancelWaitExpiryRefresh(context)
                return
            }
            val elapsed = System.currentTimeMillis() - statusAt
            if (elapsed < 0L || elapsed > displayMs) {
                cancelWaitExpiryRefresh(context)
                return
            }
            val delayMs = displayMs - elapsed + WAIT_EXPIRY_REFRESH_SLOP_MS
            val dueAt = System.currentTimeMillis() + delayMs
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pendingIntent = waitExpiryRefreshPendingIntent(context)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, dueAt, pendingIntent)
            }
        }

        private fun cancelWaitExpiryRefresh(context: Context) {
            val pendingIntent = existingWaitExpiryRefreshPendingIntent(context) ?: return
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarmManager.cancel(pendingIntent)
            pendingIntent.cancel()
        }

        private fun waitExpiryRefreshPendingIntent(context: Context): PendingIntent {
            return PendingIntent.getBroadcast(
                context,
                9104,
                waitExpiryRefreshIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun existingWaitExpiryRefreshPendingIntent(context: Context): PendingIntent? {
            return PendingIntent.getBroadcast(
                context,
                9104,
                waitExpiryRefreshIntent(context),
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun waitExpiryRefreshIntent(context: Context): Intent =
            Intent(context, ScouterWidgetProvider::class.java)
                .setAction(ACTION_WAIT_EXPIRY_REFRESH)

        private fun lightweightLoad(): ScouterSystemLoad {
            val runtime = Runtime.getRuntime()
            return ScouterSystemLoad(
                sampledAt = System.currentTimeMillis(),
                cpuPercent = null,
                appCpuPercent = null,
                appPssMb = null,
                appHeapUsedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024L * 1024L),
                appHeapMaxMb = runtime.maxMemory() / (1024L * 1024L),
                ramAvailableMb = null,
                ramTotalMb = null
            )
        }

        private fun render(
            context: Context,
            snapshots: List<SessionSnapshot>,
            binding: ScouterWidgetCodexBinding?,
            conversation: ScouterWidgetConversation?,
            load: ScouterSystemLoad
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.scouter_widget_medium)
            launchPendingIntent(context)?.let { views.setOnClickPendingIntent(R.id.scouter_widget_root, it) }
            promptPendingIntent(context)?.let { views.setOnClickPendingIntent(R.id.scouter_codex_ask, it) }

            val boundCodex = latestCodexForBinding(snapshots, binding)
            val codex = boundCodex ?: latestFor(snapshots, ScouterSource.CODEX)
            val local = latestFor(snapshots, ScouterSource.LOCAL_LLM)
            val boundScreen = inspectBoundCodexScreen(binding)
            bindCodexApprovalActions(views, context, binding, boundCodex, conversation, boundScreen)
            bindRow(
                views = views,
                snapshot = codex,
                dotId = R.id.scouter_codex_dot,
                titleId = R.id.scouter_codex_title,
                badgeId = R.id.scouter_codex_badge,
                detailId = R.id.scouter_codex_detail,
                metricsId = R.id.scouter_codex_metrics,
                emptyTitle = "AGENT: CODEX",
                emptyBadge = "CX",
                emptyDetail = "STATE  WAIT [..] no Codex session",
                emptyMetrics = listOf(
                    "CTX [..........] --% · TOK --",
                    "FLOW in -- / out -- · CACHE -- · RATE --"
                ).joinToString("\n")
            )
            codex?.let {
                views.setTextViewText(R.id.scouter_codex_metrics, codexMetrics(it, conversation))
            }
            val approvalIsActionable = hasActionableApproval(binding, boundCodex, conversation, boundScreen)
            // Usage/limit line: visible only when there is a rate/limit summary
            // for a live Codex session and no approval is taking over the bottom
            // row; hidden (and cleared) otherwise so it never shows stale data.
            val usageLine = if (approvalIsActionable) null else codex?.let { codexUsageLine(it, conversation) }
            if (usageLine.isNullOrBlank()) {
                views.setTextViewText(R.id.scouter_codex_usage, "")
                views.setViewVisibility(R.id.scouter_codex_usage, View.GONE)
            } else {
                views.setTextViewText(R.id.scouter_codex_usage, usageLine)
                views.setViewVisibility(R.id.scouter_codex_usage, View.VISIBLE)
            }
            // Path A: bound terminal is live and currently showing the
            // interactive numbered prompt. When 2-3 options parse cleanly, render
            // tappable choice pills that write the chosen digit directly to the
            // PTY (mirrors the approval ALLOW/DENY pills).
            val livePathAChoices = if (boundScreen.state == BoundCodexScreenState.INTERACTIVE) {
                boundScreen.choiceOptions.takeIf { it.size in 2..3 }
            } else {
                null
            }
            val choiceScreen = when {
                boundScreen.state == BoundCodexScreenState.INTERACTIVE -> boundScreen
                !approvalIsActionable && boundScreen.state == BoundCodexScreenState.READY -> storedChoicePendingScreen(conversation)
                else -> null
            }
            if (livePathAChoices != null) {
                bindCodexChoicePending(views, choiceScreen ?: boundScreen)
                bindCodexChoicePills(views, context, binding, boundCodex, livePathAChoices)
            } else if (choiceScreen != null) {
                bindCodexChoicePending(views, choiceScreen)
            } else {
                views.setTextViewText(R.id.scouter_codex_ask, context.getString(R.string.scouter_ask_agent_chat_short))
                bindCodexConversation(views, boundCodex, conversation, showStoredChoicePending = false)
            }
            bindRow(
                views = views,
                snapshot = local,
                dotId = R.id.scouter_local_dot,
                titleId = R.id.scouter_local_title,
                badgeId = R.id.scouter_local_badge,
                detailId = R.id.scouter_local_detail,
                metricsId = R.id.scouter_local_metrics,
                emptyTitle = "MODEL: LOCAL LLM",
                emptyBadge = "LL",
                emptyDetail = "HEALTH LINK [--] no local endpoint",
                emptyMetrics = listOf(
                    "WAVE ........ · TPS --",
                    "PING --ms · PROBE 8080/11434"
                ).joinToString("\n")
            )
            val latestAt = listOfNotNull(codex?.lastEventAt, local?.lastEventAt).maxOrNull()
            views.setTextViewText(
                R.id.scouter_footer,
                "${loadLine(load)} · ${latestAt?.let { "updated ${formatTime(it)}" } ?: "updated --:--:--"}"
            )
            return views
        }

        private fun inspectBoundCodexScreen(binding: ScouterWidgetCodexBinding?): BoundCodexScreen {
            val ptySessionId = binding?.ptySessionId?.takeIf { it.isNotBlank() }
                ?: return BoundCodexScreen(BoundCodexScreenState.MISSING)
            val session = TerminalSessionService.sessionRegistry[ptySessionId]
                ?: return BoundCodexScreen(BoundCodexScreenState.MISSING)
            if (!session.isAlive()) return BoundCodexScreen(BoundCodexScreenState.STALE)
            val screenText = runCatching { session.getScreenText() }.getOrDefault("")
            if (!isActiveCodexScreen(screenText)) return BoundCodexScreen(BoundCodexScreenState.STALE)
            if (isApprovalPromptScreen(screenText)) return BoundCodexScreen(BoundCodexScreenState.APPROVAL)
            if (isInteractivePromptScreen(screenText)) {
                return BoundCodexScreen(
                    BoundCodexScreenState.INTERACTIVE,
                    interactivePromptSummary(screenText),
                    parseInteractiveChoices(screenText)
                )
            }
            return BoundCodexScreen(BoundCodexScreenState.READY)
        }

        private fun bindCodexChoicePending(views: RemoteViews, screen: BoundCodexScreen) {
            val message = screen.message?.takeIf { it.isNotBlank() }
                ?: "Codex is waiting for terminal selection"
            views.setViewVisibility(R.id.scouter_codex_allow, View.GONE)
            views.setViewVisibility(R.id.scouter_codex_deny, View.GONE)
            views.setViewVisibility(R.id.scouter_codex_ask, View.VISIBLE)
            views.setInt(R.id.scouter_codex_dot, "setColorFilter", HUD_GREEN)
            views.setTextColor(R.id.scouter_codex_title, HUD_GREEN)
            views.setTextColor(R.id.scouter_codex_detail, HUD_GREEN)
            views.setTextColor(R.id.scouter_codex_metrics, HUD_GREEN)
            views.setTextColor(R.id.scouter_codex_ask, HUD_GREEN)
            views.setTextViewText(R.id.scouter_codex_title, "AGENT  CHOICE REQUIRED")
            views.setTextViewText(R.id.scouter_codex_ask, "CHOICE WAITING")
            views.setTextViewText(R.id.scouter_codex_detail, "STATE [!!] TERMINAL CHOICE WAITING")
            views.setTextViewText(R.id.scouter_codex_metrics, "SELECT 1/2/3 IN TERMINAL · prompt queue blocked")
            views.setTextViewText(R.id.scouter_codex_usage, "")
            views.setViewVisibility(R.id.scouter_codex_usage, View.GONE)
            views.setViewVisibility(R.id.scouter_codex_conversation, View.VISIBLE)
            views.setTextColor(R.id.scouter_codex_conversation, HUD_GREEN)
            views.setTextViewText(
                R.id.scouter_codex_conversation,
                "CHOICE REQUIRED  ${shorten(message.redactForScouter(), 104)}"
            )
        }

        // Renders 2-3 numbered choices onto the approval pill row, reusing
        // scouter_codex_allow (option 1), scouter_codex_deny (option 2) and
        // scouter_codex_choice3 (option 3). Each pill shows the option's label,
        // is retinted HUD green (so the reused DENY pill isn't read as a
        // rejection), and is wired to write the option's own digit. Extra pills
        // are hidden; ASK is hidden so the urgent choice comes forward. Mirrors
        // bindCodexApprovalActions.
        private fun bindCodexChoicePills(
            views: RemoteViews,
            context: Context,
            binding: ScouterWidgetCodexBinding?,
            codex: SessionSnapshot?,
            options: List<ChoiceOption>
        ) {
            val pillIds = intArrayOf(
                R.id.scouter_codex_allow,
                R.id.scouter_codex_deny,
                R.id.scouter_codex_choice3
            )
            views.setViewVisibility(R.id.scouter_codex_ask, View.GONE)
            pillIds.forEachIndexed { slot, pillId ->
                val option = options.getOrNull(slot)
                if (option == null) {
                    views.setViewVisibility(pillId, View.GONE)
                    return@forEachIndexed
                }
                val pillLabel = shorten("${option.index}. ${option.label}", 24)
                views.setTextViewText(pillId, pillLabel)
                views.setTextColor(pillId, HUD_GREEN)
                views.setViewVisibility(pillId, View.VISIBLE)
                views.setOnClickPendingIntent(
                    pillId,
                    choiceSelectPendingIntent(context, binding, codex, option)
                )
            }
        }

        private fun choiceSelectPendingIntent(
            context: Context,
            binding: ScouterWidgetCodexBinding?,
            codex: SessionSnapshot?,
            option: ChoiceOption
        ): PendingIntent {
            val launchIntent = Intent(context, ScouterWidgetPromptActivity::class.java)
                .setAction(ScouterWidgetPromptActivity.ACTION_CHOICE_SELECT)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_CODEX_SESSION_ID, codex?.sessionId ?: binding?.codexSessionId)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_PTY_SESSION_ID, binding?.ptySessionId)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_CHOICE_INDEX, option.index)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_CHOICE_LABEL, option.label)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TASK or
                        Intent.FLAG_ACTIVITY_NO_HISTORY or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            // Distinct request code per option index so the three pills get
            // distinct PendingIntents (extras would otherwise be coalesced).
            return PendingIntent.getActivity(
                context,
                CHOICE_SELECT_REQUEST_BASE + option.index,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun storedChoicePendingScreen(conversation: ScouterWidgetConversation?): BoundCodexScreen? {
            if (conversation?.widgetStatus != ScouterStateStore.choicePendingStatus()) return null
            val statusAt = conversation.widgetStatusAt ?: 0L
            if (statusAt <= 0L || System.currentTimeMillis() - statusAt > WIDGET_CHOICE_DISPLAY_TIMEOUT_MS) {
                return null
            }
            val message = conversation.widgetError?.takeIf { it.isNotBlank() }
                ?: "Codex is waiting for terminal selection"
            return BoundCodexScreen(BoundCodexScreenState.INTERACTIVE, message)
        }

        private fun bindRow(
            views: RemoteViews,
            snapshot: SessionSnapshot?,
            dotId: Int,
            titleId: Int,
            badgeId: Int,
            detailId: Int,
            metricsId: Int,
            emptyTitle: String,
            emptyBadge: String,
            emptyDetail: String,
            emptyMetrics: String
        ) {
            if (snapshot == null) {
                views.setTextViewText(titleId, emptyTitle)
                views.setTextViewText(badgeId, emptyBadge)
                views.setTextViewText(detailId, emptyDetail)
                views.setTextViewText(metricsId, emptyMetrics)
                views.setInt(dotId, "setColorFilter", Color.rgb(18, 181, 62))
                return
            }

            val stale = isStale(snapshot)
            val project = displayProjectName(snapshot.projectName).uppercase(Locale.US)
            val title = when (snapshot.source) {
                ScouterSource.CODEX -> "AGENT  CODEX@$project"
                ScouterSource.LOCAL_LLM -> "MODEL  ${shorten(snapshot.modelName ?: snapshot.localBackend ?: project, 22)}"
                else -> "$project · ${displaySourceName(snapshot.source)}"
            }
            views.setTextViewText(titleId, title.redactForScouter())
            views.setTextViewText(badgeId, snapshot.source.badge())
            views.setTextViewText(detailId, statusLine(snapshot, project, stale).redactForScouter())
            views.setTextViewText(metricsId, metricsLine(snapshot))
            views.setInt(dotId, "setColorFilter", colorForStatus(snapshot.currentStatus, stale))
        }

        private fun latestFor(snapshots: List<SessionSnapshot>, source: ScouterSource): SessionSnapshot? {
            return snapshots.filter { it.source == source }.maxByOrNull { it.lastEventAt }
        }

        private fun latestCodexForBinding(
            snapshots: List<SessionSnapshot>,
            binding: ScouterWidgetCodexBinding?
        ): SessionSnapshot? {
            val target = normalizeCodexSessionId(binding?.codexSessionId) ?: return null
            return snapshots
                .filter { it.source == ScouterSource.CODEX && normalizeCodexSessionId(it.sessionId) == target }
                .maxByOrNull { it.lastEventAt }
        }

        private fun launchPendingIntent(context: Context): PendingIntent? {
            val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("shelly://scouter"))
                .setPackage(context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(
                context,
                9100,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun promptPendingIntent(context: Context): PendingIntent? {
            val launchIntent = Intent(context, ScouterWidgetPromptActivity::class.java)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TASK or
                        Intent.FLAG_ACTIVITY_NO_HISTORY or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            return PendingIntent.getActivity(
                context,
                9101,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun approvalPendingIntent(
            context: Context,
            allow: Boolean,
            binding: ScouterWidgetCodexBinding?,
            codex: SessionSnapshot?,
            approvalAt: Long?,
            approvalText: String?
        ): PendingIntent {
            val launchIntent = Intent(context, ScouterWidgetPromptActivity::class.java)
                .setAction(
                    if (allow) {
                        ScouterWidgetPromptActivity.ACTION_APPROVAL_ALLOW
                    } else {
                        ScouterWidgetPromptActivity.ACTION_APPROVAL_DENY
                    }
                )
                .putExtra(ScouterWidgetPromptActivity.EXTRA_CODEX_SESSION_ID, codex?.sessionId ?: binding?.codexSessionId)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_PTY_SESSION_ID, binding?.ptySessionId)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_APPROVAL_AT, approvalAt ?: 0L)
                .putExtra(ScouterWidgetPromptActivity.EXTRA_APPROVAL_TEXT, approvalText)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TASK or
                        Intent.FLAG_ACTIVITY_NO_HISTORY or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            return PendingIntent.getActivity(
                context,
                if (allow) 9102 else 9103,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun bindCodexApprovalActions(
            views: RemoteViews,
            context: Context,
            binding: ScouterWidgetCodexBinding?,
            codex: SessionSnapshot?,
            conversation: ScouterWidgetConversation?,
            boundScreen: BoundCodexScreen
        ) {
            val hasApproval = hasActionableApproval(binding, codex, conversation, boundScreen)
            views.setViewVisibility(R.id.scouter_codex_allow, if (hasApproval) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.scouter_codex_deny, if (hasApproval) View.VISIBLE else View.GONE)
            // While an approval is pending the ALLOW/DENY pills take over the
            // bottom row; hide the ASK pill so they don't stack (G2: urgent
            // action comes forward).
            views.setViewVisibility(R.id.scouter_codex_ask, if (hasApproval) View.GONE else View.VISIBLE)
            if (hasApproval) {
                views.setOnClickPendingIntent(
                    R.id.scouter_codex_allow,
                    approvalPendingIntent(
                        context,
                        allow = true,
                        binding = binding,
                        codex = codex,
                        approvalAt = conversation?.lastApprovalAt,
                        approvalText = conversation?.lastApproval
                    )
                )
                views.setOnClickPendingIntent(
                    R.id.scouter_codex_deny,
                    approvalPendingIntent(
                        context,
                        allow = false,
                        binding = binding,
                        codex = codex,
                        approvalAt = conversation?.lastApprovalAt,
                        approvalText = conversation?.lastApproval
                    )
                )
            }
        }

        private fun hasActionableApproval(
            binding: ScouterWidgetCodexBinding?,
            codex: SessionSnapshot?,
            conversation: ScouterWidgetConversation?,
            boundScreen: BoundCodexScreen
        ): Boolean {
            // Skip-approval: when the bound Codex runs with approvals auto-handled
            // (approval_policy == "never"), Codex never emits an approval prompt, so
            // the ALLOW/DENY pills must never show. Suppress deterministically rather
            // than relying on WAITING_PERMISSION simply never firing.
            if (isAutoApprovePolicy(codex?.approvalPolicy)) return false
            val lastApprovalAt = conversation?.lastApprovalAt ?: 0L
            val widgetStatusAt = conversation?.widgetStatusAt ?: 0L
            val decisionAfterApproval = ScouterStateStore.approvalDecisionFromStatus(conversation?.widgetStatus) != null &&
                (lastApprovalAt <= 0L || widgetStatusAt >= lastApprovalAt)
            return !binding?.codexSessionId.isNullOrBlank() &&
                !binding?.ptySessionId.isNullOrBlank() &&
                boundScreen.state != BoundCodexScreenState.INTERACTIVE &&
                codex?.currentStatus == ScouterStatus.WAITING_PERMISSION &&
                !isStale(codex) &&
                lastApprovalAt > 0L &&
                !conversation?.lastApproval.isNullOrBlank() &&
                !decisionAfterApproval
        }

        // True when the Codex session is running with approvals auto-handled.
        // "never" is codex-rs's no-prompt policy (also reached via --full-auto /
        // --dangerously-bypass-approvals-and-sandbox, normalized upstream). null /
        // any other value => approvals may still be requested (current behavior).
        private fun isAutoApprovePolicy(policy: String?): Boolean {
            return policy?.trim()?.lowercase(Locale.US) == "never"
        }

        private fun displaySourceName(source: ScouterSource): String = when (source) {
            ScouterSource.CODEX -> "Codex"
            ScouterSource.LOCAL_LLM -> "Local"
            ScouterSource.SHELLY -> "Shelly"
        }

        private fun statusLine(snapshot: SessionSnapshot, project: String, stale: Boolean): String {
            val status = if (snapshot.source == ScouterSource.LOCAL_LLM) {
                localStatus(snapshot)
            } else {
                agentStatus(snapshot, project)
            }
            val label = if (snapshot.source == ScouterSource.LOCAL_LLM) "HEALTH" else "STATE "
            return if (stale) {
                "STALE ${statusSignal(snapshot.currentStatus, stale)} $status"
            } else {
                "$label ${statusSignal(snapshot.currentStatus, stale)} $status"
            }
        }

        private fun agentStatus(snapshot: SessionSnapshot, project: String): String {
            val tool = snapshot.currentTool?.takeIf { it.isNotBlank() }
            val file = snapshot.currentFile?.takeIf { it.isNotBlank() }?.let { displayPathLeaf(it) }
            val base = when (snapshot.currentStatus) {
                ScouterStatus.IDLE -> "Waiting in $project"
                ScouterStatus.THINKING -> "Thinking in $project"
                ScouterStatus.TOOL_RUNNING -> {
                    val action = tool?.let { "Running $it" } ?: "Running tool"
                    file?.let { "$action on $it" } ?: "$action in $project"
                }
                ScouterStatus.WAITING_PERMISSION -> "Permission needed"
                ScouterStatus.COMPLETED -> "Completed in $project"
                ScouterStatus.ERROR -> "Error in $project"
            }
            // Explicit auto-approve indicator so the user knows approvals are
            // handled automatically (no ALLOW/DENY pills will appear). Subtle,
            // single token, reuses the existing scouter_codex_detail slot.
            return if (isAutoApprovePolicy(snapshot.approvalPolicy)) "$base · AUTO" else base
        }

        private fun localStatus(snapshot: SessionSnapshot): String {
            val backend = snapshot.localBackend?.takeIf { it != "offline" } ?: snapshot.modelName
            return when {
                snapshot.localBackend == "offline" -> "Offline · no endpoint"
                snapshot.currentStatus == ScouterStatus.ERROR -> "Error · ${backend ?: "local"}"
                snapshot.currentStatus == ScouterStatus.TOOL_RUNNING -> "Busy · ${backend ?: "local"}"
                else -> "Ready · ${backend ?: "local"}"
            }
        }

        private fun metricsLine(snapshot: SessionSnapshot): String {
            return if (snapshot.source == ScouterSource.LOCAL_LLM) {
                localMetrics(snapshot)
            } else {
                codexMetrics(snapshot)
            }
        }

        // Clean single line bound to scouter_codex_metrics: the consumed-token
        // count plus the context gauge and short model name. The noisy
        // FLOW/REASON/CACHE/SID/TRACE breakdown lives in ScouterDetailModal.
        private fun codexMetrics(snapshot: SessionSnapshot, conversation: ScouterWidgetConversation? = null): String {
            val parts = mutableListOf<String>()
            if (snapshot.tokensUsed > 0L) parts += "TOK ${formatTokens(snapshot.tokensUsed)}"
            contextGaugeOnly(snapshot)?.let { parts += it }
            snapshot.modelName?.takeIf { it.isNotBlank() }?.let { parts += "MODEL ${shortModelName(it)}" }
            return parts.filter { it.isNotBlank() }.joinToString(" · ")
        }

        // Usage/limit line bound to scouter_codex_usage. Returns the rate-limit /
        // status-window summary (e.g. "LIMIT 5H 20% · WK 58% · RESET 14:05" or
        // "RATE LIMITED · ..."), or null when there is nothing meaningful to show.
        private fun codexUsageLine(snapshot: SessionSnapshot, conversation: ScouterWidgetConversation? = null): String? {
            // Rate-limit / status-window summary (ordering unchanged from before).
            // Computed first so the spent-cost token can be appended alongside it
            // for a "budget" read: remaining quota + dollars spent this session.
            val rate: String? = run {
                // Prefer the continuous structured rate_limits snapshot when present.
                structuredRateLimitLine(snapshot)?.let { return@run it }
                val windowLimitLine = statusWindowLimitLine(
                    snapshot,
                    conversation?.lastAnswer,
                    snapshot.lastMessage,
                    snapshot.lastError
                )
                if (windowLimitLine != null) return@run windowLimitLine
                if (needsDedicatedRateLimitLine(snapshot)) return@run rateLimitLine(snapshot)
                null
            }
            // Session cost: totalCostUsd lives in the model but was never surfaced
            // on the widget. Show it whenever > 0, even when no rate line exists, so
            // a cost-only usage line still appears. Approval state already forces
            // this whole line off at the call site, so cost is hidden then too.
            val cost = snapshot.totalCostUsd.takeIf { it > 0.0 }
                ?.let { "COST $" + String.format(Locale.US, "%.2f", it) }
            return listOfNotNull(rate, cost).takeIf { it.isNotEmpty() }?.joinToString(" · ")
        }

        // Continuous remaining display from the parsed Codex rate_limits snapshot.
        // Semantics: 5H/WK show REMAINING percent (100 - used_percent), e.g. "5H 80%"
        // means 80% of the window is still available. RESET is the wall-clock time the
        // primary (5H) window refills. Returns null when no structured field is present
        // so callers fall back to the text-scrape path unchanged.
        private fun structuredRateLimitLine(snapshot: SessionSnapshot): String? {
            val primaryRemaining = snapshot.rateLimitPrimaryUsedPercent?.let { (100.0 - it).coerceIn(0.0, 100.0) }
            val secondaryRemaining = snapshot.rateLimitSecondaryUsedPercent?.let { (100.0 - it).coerceIn(0.0, 100.0) }
            if (primaryRemaining == null && secondaryRemaining == null) return null
            val parts = mutableListOf("LIMIT")
            primaryRemaining?.let { parts += "5H ${formatPercent(it)}" }
            secondaryRemaining?.let { parts += "WK ${formatPercent(it)}" }
            snapshot.rateLimitPrimaryResetAt?.let { parts += "RESET ${formatDeviceTime(it)}" }
            return parts.joinToString(" · ")
        }

        private fun bindCodexConversation(
            views: RemoteViews,
            codex: SessionSnapshot?,
            conversation: ScouterWidgetConversation?,
            showStoredChoicePending: Boolean = true
        ) {
            val preview = widgetConversationPreview(codex, conversation, showStoredChoicePending)
            if (preview == null) {
                views.setViewVisibility(R.id.scouter_codex_conversation, View.GONE)
                views.setTextViewText(R.id.scouter_codex_conversation, "")
                return
            }
            views.setViewVisibility(R.id.scouter_codex_conversation, View.VISIBLE)
            views.setTextColor(R.id.scouter_codex_conversation, preview.color)
            views.setTextViewText(R.id.scouter_codex_conversation, preview.text)
        }

        private fun widgetConversationPreview(
            codex: SessionSnapshot?,
            conversation: ScouterWidgetConversation?,
            showStoredChoicePending: Boolean = true
        ): WidgetConversationPreview? {
            if (conversation == null) {
                if (codex?.currentStatus == ScouterStatus.WAITING_PERMISSION && !isStale(codex)) {
                    return WidgetConversationPreview(
                        "APPROVAL  Codex permission requested",
                        HUD_GREEN
                    )
                }
                return null
            }
            val isApprovalFailure = conversation.widgetStatus == ScouterStateStore.approvalFailedStatus()
            val isChoicePending = conversation.widgetStatus == ScouterStateStore.choicePendingStatus()
            val widgetPromptAt = conversation.widgetPromptAt ?: 0L
            val lastAnswerAt = conversation.lastAnswerAt ?: 0L
            val lastPromptAt = conversation.lastPromptAt ?: 0L
            val lastApprovalAt = conversation.lastApprovalAt ?: 0L
            val widgetStatusAt = conversation.widgetStatusAt ?: 0L
            val latestPromptAt = maxOf(widgetPromptAt, lastPromptAt)
            val answer = conversation.lastAnswer?.takeIf { it.isNotBlank() }
            val approval = conversation.lastApproval?.takeIf { it.isNotBlank() }
            val approvalDecision = ScouterStateStore.approvalDecisionFromStatus(conversation.widgetStatus)
            val isApprovalPending = conversation.widgetStatus?.startsWith("approval_pending_") == true
            val isApprovalSending = conversation.widgetStatus?.startsWith("approval_sending_") == true
            if (isChoicePending && showStoredChoicePending) {
                val message = conversation.widgetError?.takeIf { it.isNotBlank() }
                    ?: "Codex is waiting for a terminal choice"
                return WidgetConversationPreview(
                    "CHOICE  ${shorten(message.redactForScouter(), 96)}",
                    HUD_GREEN
                )
            }
            if (
                approvalDecision != null &&
                isApprovalPending
            ) {
                return WidgetConversationPreview(
                    "APPROVAL ${approvalDecisionLabel(approvalDecision)} queued",
                    HUD_GREEN
                )
            }
            if (
                approvalDecision != null &&
                isApprovalSending
            ) {
                return WidgetConversationPreview(
                    "APPROVAL ${approvalDecisionLabel(approvalDecision)} sending",
                    HUD_GREEN
                )
            }
            val approvalDecisionAfterEvent = approvalDecision != null &&
                !isApprovalPending &&
                !isApprovalSending &&
                (lastApprovalAt <= 0L || widgetStatusAt >= lastApprovalAt)
            if (approvalDecisionAfterEvent) {
                val ageMs = System.currentTimeMillis() - widgetStatusAt
                if (ageMs <= WIDGET_APPROVAL_SENT_DISPLAY_MS) {
                    return WidgetConversationPreview(
                        "APPROVAL ${approvalDecisionLabel(approvalDecision)} sent",
                        HUD_GREEN
                    )
                }
            }
            val liveApproval = codex?.currentStatus == ScouterStatus.WAITING_PERMISSION && !isStale(codex)
            if (liveApproval && !approvalDecisionAfterEvent) {
                val text = approval ?: "Codex permission requested"
                return WidgetConversationPreview(
                    "APPROVAL  ${shorten(text.redactForScouter(), 120)}",
                    HUD_GREEN
                )
            }
            conversation.widgetError?.takeIf { it.isNotBlank() && !isChoicePending }?.let {
                val label = if (isApprovalFailure) "APPROVAL ERROR" else "ASK ERROR"
                return WidgetConversationPreview(
                    "$label  ${shorten(it.redactForScouter(), 96)}",
                    HUD_GREEN
                )
            }
            if (
                answer != null &&
                lastAnswerAt >= latestPromptAt &&
                lastAnswerAt > widgetStatusAt
            ) {
                return WidgetConversationPreview(
                    "RESULT  ${shorten(answer.redactForScouter(), 128)}",
                    HUD_GREEN
                )
            }
            if (answer != null && lastAnswerAt >= latestPromptAt) {
                return WidgetConversationPreview(
                    "RESULT  ${shorten(answer.redactForScouter(), 128)}",
                    HUD_GREEN
                )
            }
            val prompt = if (widgetPromptAt >= lastPromptAt) conversation.widgetPrompt else conversation.lastPrompt
            if (!prompt.isNullOrBlank()) {
                val label = if (isActiveWidgetWait(conversation, widgetPromptAt, lastAnswerAt)) {
                    "WAIT   "
                } else {
                    "YOU    "
                }
                return WidgetConversationPreview(
                    "$label${shorten(prompt.redactForScouter(), 128)}",
                    HUD_GREEN
                )
            }
            return WidgetConversationPreview(
                "ASK ready when Codex is bound",
                HUD_GREEN
            )
        }

        private fun approvalDecisionLabel(decision: String): String = if (decision == "deny") "NO" else "OK"

        private fun isActiveWidgetWait(
            conversation: ScouterWidgetConversation,
            widgetPromptAt: Long,
            lastAnswerAt: Long
        ): Boolean {
            if (conversation.widgetStatus !in WAITING_WIDGET_STATUSES) return false
            if (widgetPromptAt <= lastAnswerAt) return false
            val statusAt = conversation.widgetStatusAt ?: widgetPromptAt
            if (statusAt <= 0L) return false
            return System.currentTimeMillis() - statusAt <= WIDGET_WAIT_DISPLAY_TIMEOUT_MS
        }

        private data class WidgetConversationPreview(
            val text: String,
            val color: Int
        )

        private fun needsDedicatedRateLimitLine(snapshot: SessionSnapshot): Boolean {
            val status = snapshot.rateLimitStatus ?: inferScouterRateLimitFromText(snapshot.lastError).status
            return status == ScouterRateLimitStatus.LIMITED ||
                status == ScouterRateLimitStatus.HOT ||
                snapshot.rateLimitRemainingRequests != null ||
                snapshot.rateLimitRemainingTokens != null ||
                (cooldownSeconds(snapshot) ?: 0L) > 0L
        }

        private fun compactRateLimitLabel(snapshot: SessionSnapshot): String? {
            val status = snapshot.rateLimitStatus ?: inferScouterRateLimitFromText(snapshot.lastError).status
            return when (status) {
                ScouterRateLimitStatus.OK -> "RATE OK"
                ScouterRateLimitStatus.UNKNOWN -> "RATE --"
                null -> null
                else -> null
            }
        }

        private fun defaultRateLimitLabel(snapshot: SessionSnapshot): String {
            val status = snapshot.rateLimitStatus ?: inferScouterRateLimitFromText(snapshot.lastError).status
            return when (status) {
                ScouterRateLimitStatus.OK -> "LIMIT OK"
                ScouterRateLimitStatus.UNKNOWN, null -> "LIMIT --"
                ScouterRateLimitStatus.HOT -> "LIMIT HOT"
                ScouterRateLimitStatus.LIMITED -> "LIMITED"
            }
        }

        private fun rateLimitLine(snapshot: SessionSnapshot): String {
            val status = snapshot.rateLimitStatus ?: inferScouterRateLimitFromText(snapshot.lastError).status
            val statusText = when (status) {
                ScouterRateLimitStatus.LIMITED -> "LIMITED"
                ScouterRateLimitStatus.HOT -> "HOT"
                ScouterRateLimitStatus.OK -> "OK"
                ScouterRateLimitStatus.UNKNOWN -> "--"
                null -> "--"
            }
            val parts = mutableListOf("RATE $statusText")
            snapshot.rateLimitRemainingRequests?.let { parts += "REQ $it" }
            snapshot.rateLimitRemainingTokens?.let { parts += "TOKREM ${formatTokens(it)}" }
            val reset = rateResetLabel(snapshot)
            when {
                reset != null -> parts += reset
                status == ScouterRateLimitStatus.OK -> parts += "LIMIT no throttle"
                status == null || status == ScouterRateLimitStatus.UNKNOWN -> parts += "LIMIT unknown"
            }
            return parts.joinToString(" · ")
        }

        private fun localMetrics(snapshot: SessionSnapshot): String {
            val parts = mutableListOf<String>()
            snapshot.localEndpoint?.let { parts += "END ${shortEndpoint(it)}" } ?: run { parts += "END none" }
            snapshot.tokensPerSecond?.takeIf { it > 0.0 }?.let {
                parts += String.format(Locale.US, "TPS %.1f", it)
            }
            snapshot.queueSize?.let { parts += "Q $it" }
            snapshot.latencyMs?.let { parts += "PING ${it}ms" }
            return "LOCAL " + parts.joinToString(" · ")
        }

        private fun loadLine(load: ScouterSystemLoad): String {
            val cpu = load.appCpuPercent?.let { String.format(Locale.US, "%.0f%%", it) } ?: "--%"
            val memory = load.ramAvailableMb?.let { "RAM ${formatMegabytes(it)} free" }
            return listOfNotNull("LOAD CPU $cpu", memory).joinToString(" · ")
        }

        private fun contextGaugeOnly(snapshot: SessionSnapshot): String? {
            val remaining = snapshot.contextPercentRemaining ?: return null
            val used = (100.0 - remaining).coerceIn(0.0, 100.0)
            return "CTX ${bar(used)} ${used.toInt()}%"
        }

        private fun statusSignal(status: ScouterStatus, stale: Boolean): String {
            if (stale) return "[--]"
            val frame = ((System.currentTimeMillis() / 1000L) % 4L).toInt()
            return when (status) {
                ScouterStatus.TOOL_RUNNING -> listOf("[>..]", "[>>.]", "[>>>]", "[.>>]")[frame]
                ScouterStatus.THINKING -> listOf("[o..]", "[.o.]", "[..o]", "[.o.]")[frame]
                ScouterStatus.WAITING_PERMISSION -> "[??]"
                ScouterStatus.ERROR -> "[!!]"
                ScouterStatus.COMPLETED -> "[OK]"
                ScouterStatus.IDLE -> "[..]"
            }
        }

        private fun bar(percent: Double): String {
            val filled = ((percent.coerceIn(0.0, 100.0) / 10.0).toInt()).coerceIn(0, 10)
            return "[" + "#".repeat(filled) + ".".repeat(10 - filled) + "]"
        }

        private fun sparkline(value: Double, max: Double): String {
            val levels = listOf("▁", "▂", "▃", "▄", "▅", "▆", "▇", "█")
            val level = ((value.coerceIn(0.0, max) / max) * (levels.size - 1)).toInt()
            val wave = listOf(-3, -1, 1, 3, 2, 0, -2, 0)
            return wave.joinToString("") { offset -> levels[(level + offset).coerceIn(0, levels.lastIndex)] }
        }

        private fun shortEndpoint(endpoint: String): String {
            return endpoint.substringAfterLast(':', endpoint).let { port ->
                if (port.isNotBlank() && port.all { it.isDigit() }) ":$port" else shorten(endpoint, 16)
            }
        }

        private fun statusWindowLimitLine(snapshot: SessionSnapshot, vararg texts: String?): String? {
            val text = texts.firstOrNull { value ->
                val lower = value?.lowercase(Locale.US).orEmpty()
                lower.contains("5h") ||
                    lower.contains("5-hour") ||
                    lower.contains("five-hour") ||
                    lower.contains("weekly") ||
                    lower.contains("week limit") ||
                    lower.contains("usage limit")
            } ?: return null
            val fiveHour = percentForLimitWindow(text, FIVE_HOUR_LIMIT_RE)
            val weekly = percentForLimitWindow(text, WEEKLY_LIMIT_RE)
            if (fiveHour == null && weekly == null) return null
            val parts = mutableListOf("LIMIT")
            fiveHour?.let { parts += "5H ${formatPercent(it)}" }
            weekly?.let { parts += "WK ${formatPercent(it)}" }
            rateResetLabel(snapshot)?.let { parts += it }
            return parts.joinToString(" · ")
        }

        private fun rateResetLabel(snapshot: SessionSnapshot): String? {
            val cooldown = cooldownSeconds(snapshot)
            return when {
                snapshot.rateLimitResetAt != null && cooldown != null && cooldown > 0L -> "RESET ${formatDeviceTime(snapshot.rateLimitResetAt)}"
                cooldown != null && cooldown > 0L -> "RESET ${formatDuration(cooldown)}"
                else -> null
            }
        }

        private fun percentForLimitWindow(text: String, label: Regex): Double? {
            val lines = text.lines().map { it.trim() }.filter { it.isNotBlank() }
            for (line in lines) {
                if (!label.containsMatchIn(line)) continue
                LIMIT_PERCENT_RE.findAll(line).forEach { match ->
                    match.groupValues.getOrNull(1)?.toDoubleOrNull()?.let {
                        return it.coerceIn(0.0, 100.0)
                    }
                }
            }
            return null
        }

        private fun formatPercent(value: Double): String {
            return if (value % 1.0 == 0.0) {
                "${value.toInt()}%"
            } else {
                String.format(Locale.US, "%.1f%%", value)
            }
        }

        private fun formatDeviceTime(epochMs: Long): String {
            val zone = TimeZone.getDefault()
            return SimpleDateFormat("HH:mm z", Locale.US).apply {
                timeZone = zone
            }.format(Date(epochMs))
        }

        private fun isActiveCodexScreen(screenText: String): Boolean {
            if (screenText.isBlank()) return false
            val lines = screenText.lines().map { it.trimEnd() }
            var lastCodexPrompt = -1
            var lastShellPrompt = -1
            lines.forEachIndexed { index, line ->
                when {
                    line.contains("OpenAI Codex", ignoreCase = true) ||
                        CODEX_STATUS_RE.containsMatchIn(line) -> lastCodexPrompt = index
                    SHELL_PROMPT_RE.matches(line.trim()) -> lastShellPrompt = index
                }
            }
            return lastCodexPrompt >= 0 && lastCodexPrompt > lastShellPrompt
        }

        private fun isApprovalPromptScreen(screenText: String): Boolean {
            val recentLines = screenText
                .lines()
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .takeLast(8)
            if (recentLines.isEmpty()) return false
            val tail = recentLines.joinToString("\n")
            val hasApprovalKeyword = APPROVAL_KEYWORD_RE.containsMatchIn(tail)
            val hasChoice = recentLines.any { APPROVAL_CHOICE_RE.containsMatchIn(it) }
            return hasApprovalKeyword && hasChoice
        }

        private fun isInteractivePromptScreen(screenText: String): Boolean {
            val recentLines = screenText
                .lines()
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .takeLast(12)
            if (recentLines.isEmpty()) return false
            val tail = recentLines.joinToString("\n")
            val hasInteractiveKeyword = INTERACTIVE_PROMPT_KEYWORD_RE.containsMatchIn(tail)
            val numberedChoices = recentLines.count { INTERACTIVE_NUMBERED_CHOICE_RE.containsMatchIn(it) }
            val hasFocusedChoice = recentLines.any { INTERACTIVE_FOCUSED_CHOICE_RE.containsMatchIn(it) }
            return hasInteractiveKeyword && (numberedChoices >= 2 || hasFocusedChoice)
        }

        // Parses numbered choices (e.g. "1. Switch to gpt-5.4-mini") from the
        // tail of the interactive prompt screen into tappable options. Strips an
        // optional focus caret (">") and the "<digit>." / "<digit>)" prefix,
        // keeping the digit as the option index. Caps usable options at 3 and
        // returns empty (→ banner fallback) when 0 or >3 are parsed, or when
        // duplicate indices appear (ambiguous/unsafe to map to a single digit).
        private fun parseInteractiveChoices(screenText: String): List<ChoiceOption> {
            val recentLines = screenText
                .lines()
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .takeLast(12)
            val out = mutableListOf<ChoiceOption>()
            val seen = mutableSetOf<Int>()
            for (line in recentLines) {
                val match = INTERACTIVE_CHOICE_CAPTURE_RE.find(line) ?: continue
                val index = match.groupValues.getOrNull(1)?.toIntOrNull() ?: continue
                val label = match.groupValues.getOrNull(2).orEmpty().trim()
                if (label.isBlank()) continue
                if (!seen.add(index)) return emptyList()
                out += ChoiceOption(index, shorten(label.redactForScouter(), 36))
                if (out.size > 3) return emptyList()
            }
            if (out.size < 1 || out.size > 3) return emptyList()
            return out
        }

        private fun interactivePromptSummary(screenText: String): String {
            val recentLines = screenText
                .lines()
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .takeLast(12)
            return recentLines.firstOrNull { INTERACTIVE_PROMPT_KEYWORD_RE.containsMatchIn(it) }
                ?: recentLines.firstOrNull { INTERACTIVE_FOCUSED_CHOICE_RE.containsMatchIn(it) }
                ?: "Codex is waiting for terminal selection"
        }

        private fun displayProjectName(raw: String): String {
            val value = raw.redactForScouter().trim().trim('"', '\'')
            if (value.isBlank()) return "Shelly"
            val lower = value.lowercase(Locale.US)
            if ("dev-shelly-terminal-files-home" in lower || "dev.shelly.terminal/files/home" in lower) {
                return "home"
            }
            if ("/" in value || "\\" in value) {
                return displayPathLeaf(value).ifBlank { "Shelly" }
            }
            return value
        }

        private fun displayPathLeaf(raw: String): String {
            return raw.replace('\\', '/')
                .trimEnd('/')
                .substringAfterLast('/')
                .ifBlank { raw }
        }

        private fun isStale(snapshot: SessionSnapshot): Boolean {
            return System.currentTimeMillis() - snapshot.lastEventAt > STALE_AFTER_MS
        }

        private fun colorForStatus(status: ScouterStatus, stale: Boolean = false): Int = when {
            stale -> HUD_GREEN_STALE
            else -> HUD_GREEN
        }

        private fun formatTokens(tokens: Long): String {
            return if (tokens >= 1000) String.format(Locale.US, "%.1fK", tokens / 1000.0) else tokens.toString()
        }

        private fun formatMegabytes(value: Long): String {
            return if (value >= 1024L) String.format(Locale.US, "%.1fG", value / 1024.0) else "${value}M"
        }

        private fun cooldownSeconds(snapshot: SessionSnapshot): Long? {
            snapshot.rateLimitResetAt?.let { resetAt ->
                val remaining = ((resetAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
                if (remaining > 0L) return remaining
            }
            return snapshot.retryAfterSeconds?.takeIf { it > 0L && snapshot.rateLimitResetAt == null }
        }

        private fun formatDuration(seconds: Long): String {
            return if (seconds >= 60L) "${seconds / 60L}m" else "${seconds}s"
        }

        private fun shortSessionId(sessionId: String): String {
            return if (sessionId.length > 10) sessionId.take(8) else sessionId
        }

        private fun normalizeCodexSessionId(sessionId: String?): String? {
            val trimmed = sessionId?.trim().orEmpty()
            if (trimmed.isBlank()) return null
            return CODEX_SESSION_UUID_SUFFIX_RE.find(trimmed)?.groupValues?.getOrNull(1) ?: trimmed
        }

        private fun shorten(value: String, max: Int): String {
            val cleaned = value.replace(Regex("\\s+"), " ").trim()
            return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
        }

        private fun shortModelName(model: String): String {
            return model
                .removePrefix("gpt-")
                .replace("-2025", "")
                .replace("-2026", "")
                .take(18)
        }

        private fun formatTime(time: Long): String {
            val pattern = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) "HH:mm:ss" else "HH:mm"
            return SimpleDateFormat(pattern, Locale.US).format(Date(time))
        }

        private enum class BoundCodexScreenState {
            READY,
            APPROVAL,
            INTERACTIVE,
            MISSING,
            STALE
        }

        private data class BoundCodexScreen(
            val state: BoundCodexScreenState,
            val message: String? = null,
            val choiceOptions: List<ChoiceOption> = emptyList()
        )

        private const val TAG = "ScouterWidget"
        private const val ACTION_WAIT_EXPIRY_REFRESH =
            "expo.modules.terminalemulator.scouter.WIDGET_WAIT_EXPIRY_REFRESH"
        private const val STALE_AFTER_MS = 10 * 60 * 1000L
        private const val WIDGET_WAIT_DISPLAY_TIMEOUT_MS = 2 * 60 * 1000L
        private const val WIDGET_CHOICE_DISPLAY_TIMEOUT_MS = 30 * 60 * 1000L
        private const val WIDGET_APPROVAL_SENT_DISPLAY_MS = 12 * 1000L
        private const val WAIT_EXPIRY_REFRESH_SLOP_MS = 350L
        // Base request code for choice-select PendingIntents; the option index is
        // added so each pill (1/2/3) gets a distinct PendingIntent. Kept clear of
        // 9100-9104 used by launch/prompt/approval/wait-refresh intents.
        private const val CHOICE_SELECT_REQUEST_BASE = 9110
        private val CODEX_SESSION_UUID_SUFFIX_RE =
            Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
        private val FIVE_HOUR_LIMIT_RE = Regex("""(?i)\b(?:5\s*h|5-hour|five[- ]hour)\b""")
        private val WEEKLY_LIMIT_RE = Regex("""(?i)\b(?:weekly|week)\b""")
        private val LIMIT_PERCENT_RE = Regex("""(?i)(?:<\s*)?(\d{1,3}(?:\.\d+)?)\s*%""")
        private val CODEX_STATUS_RE = Regex("""\b(?:gpt|o\d|codex)[A-Za-z0-9_.-]*\b.*[·•]\s*/""", RegexOption.IGNORE_CASE)
        private val SHELL_PROMPT_RE = Regex("""^(?:[~\w./:@+-]+\s*)?[$#]\s*$""")
        private val APPROVAL_KEYWORD_RE = Regex("""\b(?:approval|approve|permission|allow|deny)\b""", RegexOption.IGNORE_CASE)
        private val APPROVAL_CHOICE_RE = Regex("""\b(?:y/n|yes/no|allow|deny|approve|reject)\b|^\s*(?:[^A-Za-z0-9\s]\s*)?(?:\d+[\).]\s*)?(?:yes|no|y|n)\b(?:\s*[,):.-]|\s*$)|[\[(]\s*[yY]\s*/\s*[nN]\s*[\])]""", RegexOption.IGNORE_CASE)
        private val INTERACTIVE_PROMPT_KEYWORD_RE = Regex("""(?:Approaching rate limits|Switch to\b.*\bmodel\b|Keep current model|Would you like to make the following edits|Yes,\s*proceed|don't ask again|Press enter to confirm|esc to go back|rate limit reminders|select an option|choose an option)""", RegexOption.IGNORE_CASE)
        private val INTERACTIVE_NUMBERED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)?\d+[\).]\s+\S""")
        private val INTERACTIVE_FOCUSED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)\d+[\).]\s+\S""")
        // Capturing variant of INTERACTIVE_NUMBERED_CHOICE_RE: group 1 = digit,
        // group 2 = label text after the "<digit>." / "<digit>)" marker.
        private val INTERACTIVE_CHOICE_CAPTURE_RE = Regex("""^\s*(?:[>]\s*)?(\d+)[\).]\s+(\S.*)$""")
        private val WAITING_WIDGET_STATUSES = setOf(
            "pending_terminal",
            "sending",
            ScouterStateStore.approvalPendingStatus("allow"),
            ScouterStateStore.approvalPendingStatus("deny"),
            ScouterStateStore.approvalSendingStatus("allow"),
            ScouterStateStore.approvalSendingStatus("deny")
        )
        private val HUD_GREEN = Color.rgb(0, 255, 65)
        private val HUD_GREEN_STALE = Color.rgb(52, 232, 94)
    }
}
