package expo.modules.terminalemulator.scouter

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import expo.modules.terminalemulator.R
import expo.modules.terminalemulator.AgentAlarmScheduler
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Agent-launcher widget (redesigned 2026-07-18 per design review).
 *
 * Primary job: an agent launch pad + health-status list for up to
 * [MAX_WIDGET_AGENT_ROWS] nearest-upcoming scheduled agents — NOT a
 * Codex/local-LLM session monitor. The prior version of this file bound a
 * live Codex session HUD (title/status/DOING/reply preview/model metrics/
 * token usage/rate-limit timer), approval + interactive-choice pills, and a
 * LOCAL LLM health row. All of that was removed from the WIDGET LAYOUT in
 * this pass; the underlying sampling/watcher infrastructure
 * (ScouterSystemSampler / JsonlWatcher / LocalLlmSampler, driven by
 * ScouterLifecycleService) is untouched and keeps running — it also backs
 * app/scouter.tsx and other JS-side consumers, not just this widget. See
 * docs/superpowers/DEFERRED.md for the full rationale and the deferred
 * notification-based follow-up.
 */
class ScouterWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
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
            val enabled = store.isEnabled()
            // Only the in-flight manual/scheduled agent-run marker
            // (widgetAgentRunId/Status/StatusAt) is still needed from
            // ScouterStateStore, to show a "running" glyph on the matching
            // row. The Codex/local-LLM session snapshots, terminal binding,
            // and usage-limit overrides that used to drive the removed
            // monitor UI are intentionally no longer read here.
            val conversation = if (enabled) store.widgetConversation() else null
            val agents = if (enabled) {
                WidgetAgentRepository.nextScheduledAgents(context, MAX_WIDGET_AGENT_ROWS)
            } else {
                emptyList()
            }
            ids.forEach { id ->
                runCatching {
                    manager.updateAppWidget(id, render(context, agents, conversation))
                }
                    .onFailure { Log.w(TAG, "Scouter widget update failed for id=$id", it) }
            }
        }

        private fun render(
            context: Context,
            agents: List<ScouterWidgetAgentTarget>,
            conversation: ScouterWidgetConversation?
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.scouter_widget_medium)
            launchPendingIntent(context)?.let { views.setOnClickPendingIntent(R.id.scouter_widget_root, it) }
            promptPendingIntent(context)?.let { views.setOnClickPendingIntent(R.id.scouter_codex_ask, it) }
            bindHeader(views, context, agents)
            bindPet(views, context)
            bindAgentRows(views, context, agents, conversation)
            return views
        }

        // Header: overall status dot (green, or red + failure count when any
        // of the SHOWN agents' last run errored) + static "AGENTS" title.
        private fun bindHeader(views: RemoteViews, context: Context, agents: List<ScouterWidgetAgentTarget>) {
            views.setTextViewText(R.id.scouter_header_title, context.getString(R.string.scouter_widget_header_title))
            val failedCount = agents.count { it.lastRunStatus == "error" }
            if (failedCount > 0) {
                views.setInt(R.id.scouter_header_dot, "setColorFilter", HUD_RED)
                views.setTextViewText(
                    R.id.scouter_header_badge,
                    context.getString(R.string.scouter_widget_header_failed, failedCount)
                )
                views.setViewVisibility(R.id.scouter_header_badge, View.VISIBLE)
            } else {
                views.setInt(R.id.scouter_header_dot, "setColorFilter", HUD_GREEN)
                views.setViewVisibility(R.id.scouter_header_badge, View.GONE)
            }
        }

        // Pet mascot: decorative only, per the product owner's explicit
        // charm-value override — the image stays, but the old tap-to-cycle
        // skin interaction (a separate "show pet" pill plus a transparent
        // touch-catcher overlay, both dropped from the layout, plus the
        // click binding this ImageView itself used to carry) is fully
        // removed as a low-value misclick source. Visibility still
        // respects the existing ScouterCodexPet on/off preference: a user
        // who had a pet showing before this redesign keeps seeing it, there
        // is just no more in-widget control to change that preference.
        // Animation state is always IDLE now since the widget no longer
        // tracks a live Codex session to react to.
        private fun bindPet(views: RemoteViews, context: Context) {
            if (!ScouterCodexPet.hasPet(context) || !ScouterCodexPet.isVisible(context)) {
                views.setViewVisibility(R.id.scouter_codex_pet, View.GONE)
                return
            }
            val frame = ScouterCodexPet.frameBitmap(context, ScouterCodexPet.State.IDLE, System.currentTimeMillis())
            if (frame == null) {
                views.setViewVisibility(R.id.scouter_codex_pet, View.GONE)
                return
            }
            views.setImageViewBitmap(R.id.scouter_codex_pet, frame)
            views.setViewVisibility(R.id.scouter_codex_pet, View.VISIBLE)
        }

        private data class AgentRowIds(
            val rowId: Int,
            val glyphId: Int,
            val nameId: Int,
            val nextId: Int,
            val runId: Int
        )

        private val ROW_IDS = listOf(
            AgentRowIds(
                R.id.scouter_agent_row_1,
                R.id.scouter_agent_row_1_glyph,
                R.id.scouter_agent_row_1_name,
                R.id.scouter_agent_row_1_next,
                R.id.scouter_agent_row_1_run
            ),
            AgentRowIds(
                R.id.scouter_agent_row_2,
                R.id.scouter_agent_row_2_glyph,
                R.id.scouter_agent_row_2_name,
                R.id.scouter_agent_row_2_next,
                R.id.scouter_agent_row_2_run
            ),
            AgentRowIds(
                R.id.scouter_agent_row_3,
                R.id.scouter_agent_row_3_glyph,
                R.id.scouter_agent_row_3_name,
                R.id.scouter_agent_row_3_next,
                R.id.scouter_agent_row_3_run
            )
        )

        // Binds up to MAX_WIDGET_AGENT_ROWS fixed row slots (RemoteViews has
        // no dynamic list adapter without a RemoteViewsService, and no other
        // widget-like surface in this app uses one — grepped, none found —
        // so 3 fixed slots shown/hidden per-render is the simplest correct
        // approach, matching the visibility="gone" pattern this layout
        // already used for the old single-agent row). Each row: name,
        // last-result glyph (or a running indicator for the one agent
        // matching ScouterStateStore's single global in-flight run marker),
        // next-fire time, and a RUN pill wired directly to
        // AgentAlarmScheduler.manualRunPendingIntent — the exact existing
        // mechanism, now bound per-row instead of once. The row itself
        // (outside the RUN pill) opens the app via agentDetailPendingIntent.
        private fun bindAgentRows(
            views: RemoteViews,
            context: Context,
            agents: List<ScouterWidgetAgentTarget>,
            conversation: ScouterWidgetConversation?
        ) {
            ROW_IDS.forEachIndexed { index, ids ->
                val agent = agents.getOrNull(index)
                if (agent == null) {
                    views.setViewVisibility(ids.rowId, View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(ids.rowId, View.VISIBLE)
                views.setTextViewText(ids.nameId, shorten(agent.name.redactForScouter(), 22))

                val isRunning = conversation?.widgetAgentRunId == agent.agentId &&
                    conversation.widgetAgentRunStatus == ScouterStateStore.WIDGET_AGENT_STATUS_RUNNING
                if (isRunning) {
                    val elapsedLabel = conversation?.widgetAgentRunStatusAt
                        ?.let { "${((System.currentTimeMillis() - it) / 1000L).coerceAtLeast(0L)}s" }
                        ?: "…"
                    views.setTextViewText(ids.glyphId, GLYPH_RUNNING)
                    views.setTextColor(ids.glyphId, HUD_BRIGHT)
                    views.setTextViewText(
                        ids.nextId,
                        context.getString(R.string.scouter_widget_agent_row_next_running, elapsedLabel)
                    )
                    views.setTextColor(ids.nextId, HUD_BRIGHT)
                } else {
                    val (glyph, glyphColor) = glyphForLastRun(agent.lastRunStatus)
                    views.setTextViewText(ids.glyphId, glyph)
                    views.setTextColor(ids.glyphId, glyphColor)
                    views.setTextViewText(
                        ids.nextId,
                        context.getString(R.string.scouter_widget_agent_row_next, formatAgentRunTime(agent.nextRunAt))
                    )
                    views.setTextColor(ids.nextId, HUD_GREEN_STALE)
                }

                views.setOnClickPendingIntent(
                    ids.runId,
                    AgentAlarmScheduler.manualRunPendingIntent(context, agent.agentId)
                )
                views.setOnClickPendingIntent(ids.rowId, agentDetailPendingIntent(context, agent.agentId))
            }
            views.setViewVisibility(R.id.scouter_agent_empty, if (agents.isEmpty()) View.VISIBLE else View.GONE)
        }

        // ✓ success, ✗ error, • skipped/unavailable (declined or transient —
        // not a hard verdict), – never run / unknown. Mirrors the glyph
        // semantics lib/agent-manager.ts already uses for its own ✅/❌/⏸️
        // badges (a run's truthful status lives in the run-log, not the
        // static agent.json's lastResult field — see
        // WidgetAgentRepository.readLastRunStatus).
        private fun glyphForLastRun(status: String?): Pair<String, Int> = when (status) {
            "success" -> GLYPH_SUCCESS to HUD_GREEN
            "error" -> GLYPH_ERROR to HUD_RED
            "skipped", "unavailable" -> GLYPH_SKIPPED to HUD_DIM
            else -> GLYPH_NEVER to HUD_DIM
        }

        private fun formatAgentRunTime(timestamp: Long): String =
            SimpleDateFormat("EEE HH:mm", Locale.getDefault()).format(Date(timestamp))

        private fun shorten(value: String, max: Int): String {
            val cleaned = value.replace(Regex("\\s+"), " ").trim()
            return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
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

        // Row tap ("open app to that agent's detail"): grepped app/_layout.tsx
        // and found no existing per-agent deep-link handler — only generic
        // targets are wired today (shelly://scouter, shelly://browser,
        // shelly:///agent-chat). This reuses the exact same mechanism as
        // launchPendingIntent (Intent.ACTION_VIEW on a shelly:// URI, same
        // package/flags) and forward-compatibly attaches ?agentId=<id> so a
        // future small JS change can scope the Scouter/Sidebar surface to
        // this one agent. Today it opens the same generic Scouter detail
        // panel as tapping the widget background (normalizeDeepLinkTarget in
        // app/_layout.tsx reads only hostname/path, so the extra query
        // param is harmlessly ignored) — this is a known, documented
        // limitation, not a silent gap. Distinct request code per agent id
        // so all 3 rows get distinct PendingIntents.
        private fun agentDetailPendingIntent(context: Context, agentId: String): PendingIntent {
            val uri = Uri.parse("shelly://scouter").buildUpon()
                .appendQueryParameter("agentId", agentId)
                .build()
            val launchIntent = Intent(Intent.ACTION_VIEW, uri)
                .setPackage(context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val requestCode = AGENT_DETAIL_REQUEST_BASE + ((agentId.hashCode() and 0x7FFFFFFF) % 10_000)
            return PendingIntent.getActivity(
                context,
                requestCode,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private const val TAG = "ScouterWidget"
        private const val MAX_WIDGET_AGENT_ROWS = 3
        // Base request code for per-agent row-tap PendingIntents; kept clear
        // of 9100/9101 used by the root-launch/ASK-prompt intents above.
        private const val AGENT_DETAIL_REQUEST_BASE = 9200
        private const val GLYPH_SUCCESS = "✓"
        private const val GLYPH_ERROR = "✗"
        private const val GLYPH_SKIPPED = "•"
        private const val GLYPH_NEVER = "–"
        private const val GLYPH_RUNNING = "⏳"
        private val HUD_GREEN = Color.rgb(0, 255, 65)
        private val HUD_GREEN_STALE = Color.rgb(52, 232, 94)
        private val HUD_BRIGHT = Color.rgb(120, 255, 140)
        private val HUD_RED = Color.rgb(255, 76, 76)
        private val HUD_DIM = Color.rgb(95, 191, 125)
    }
}
