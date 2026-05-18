package expo.modules.terminalemulator.scouter

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.widget.RemoteViews
import expo.modules.terminalemulator.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ScouterWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val store = ScouterStateStore(context)
        val snapshot = if (store.isEnabled()) store.latest() else null
        ids.forEach { id ->
            manager.updateAppWidget(id, render(context, snapshot))
        }
    }

    companion object {
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, ScouterWidgetProvider::class.java)
            val ids = manager.getAppWidgetIds(component)
            if (ids.isEmpty()) return
            val store = ScouterStateStore(context)
            val snapshot = if (store.isEnabled()) store.latest() else null
            ids.forEach { id ->
                manager.updateAppWidget(id, render(context, snapshot))
            }
        }

        private fun render(context: Context, snapshot: SessionSnapshot?): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.scouter_widget_medium)
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse("shelly://scouter")
            }
            val pendingIntent = if (launchIntent != null) {
                PendingIntent.getActivity(
                    context,
                    9100,
                    launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            } else null
            if (pendingIntent != null) {
                views.setOnClickPendingIntent(R.id.scouter_widget_root, pendingIntent)
            }

            if (snapshot == null) {
                views.setTextViewText(R.id.scouter_title, "Scouter")
                views.setTextViewText(R.id.scouter_source_badge, "SH")
                views.setTextViewText(R.id.scouter_detail, "Waiting for Claude Code or Codex")
                views.setTextViewText(R.id.scouter_metrics, "Open Shelly to start observing")
                views.setTextViewText(R.id.scouter_usage, "No local session snapshot yet")
                views.setInt(R.id.scouter_status_dot, "setColorFilter", Color.GRAY)
                return views
            }

            val project = displayProjectName(snapshot.projectName)
            val sourceName = displaySourceName(snapshot.source)
            val branch = snapshot.gitBranch?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
            val title = "$sourceName · $project$branch"
            val stale = isStale(snapshot)
            val detail = if (stale) "Stale · ${displayStatus(snapshot, project)}" else displayStatus(snapshot, project)
            val metrics = usageSummary(snapshot)
            val timing = listOfNotNull(
                "Last ${formatTime(snapshot.lastEventAt)}",
                durationSummary(snapshot),
                snapshot.lastMessage?.takeIf { it.isNotBlank() }?.let { "Msg ${shorten(it.redactForScouter(), 34)}" }
            ).joinToString(" · ")

            views.setTextViewText(R.id.scouter_title, title)
            views.setTextViewText(R.id.scouter_source_badge, snapshot.source.badge())
            views.setTextViewText(R.id.scouter_detail, detail.redactForScouter())
            views.setTextViewText(R.id.scouter_metrics, metrics)
            views.setTextViewText(R.id.scouter_usage, timing)
            views.setInt(R.id.scouter_status_dot, "setColorFilter", colorForStatus(snapshot.currentStatus, stale))
            return views
        }

        private fun displaySourceName(source: ScouterSource): String = when (source) {
            ScouterSource.CLAUDE_CODE -> "Claude Code"
            ScouterSource.CODEX -> "Codex"
            ScouterSource.SHELLY -> "Shelly"
        }

        private fun displayStatus(snapshot: SessionSnapshot, project: String): String {
            val tool = snapshot.currentTool?.takeIf { it.isNotBlank() }
            val file = snapshot.currentFile?.takeIf { it.isNotBlank() }?.let { displayPathLeaf(it) }
            return when (snapshot.currentStatus) {
                ScouterStatus.IDLE -> "Waiting in $project"
                ScouterStatus.THINKING -> "Thinking in $project"
                ScouterStatus.TOOL_RUNNING -> {
                    val action = tool?.let { "Running $it" } ?: "Running tool"
                    file?.let { "$action on $it" } ?: "$action in $project"
                }
                ScouterStatus.WAITING_PERMISSION -> "Waiting for permission in $project"
                ScouterStatus.COMPLETED -> "Completed in $project"
                ScouterStatus.ERROR -> "Error in $project"
            }.redactForScouter()
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
            stale -> Color.rgb(122, 150, 122)
            status == ScouterStatus.IDLE -> Color.rgb(122, 150, 122)
            status == ScouterStatus.THINKING -> Color.rgb(125, 219, 125)
            status == ScouterStatus.TOOL_RUNNING -> Color.rgb(47, 175, 47)
            status == ScouterStatus.WAITING_PERMISSION -> Color.rgb(158, 217, 93)
            status == ScouterStatus.COMPLETED -> Color.rgb(155, 196, 155)
            status == ScouterStatus.ERROR -> Color.rgb(255, 92, 92)
            else -> Color.rgb(122, 150, 122)
        }

        private fun formatTokens(tokens: Long): String {
            return if (tokens >= 1000) String.format(Locale.US, "%.1fK", tokens / 1000.0) else tokens.toString()
        }

        private fun usageSummary(snapshot: SessionSnapshot): String {
            val parts = mutableListOf<String>()
            snapshot.modelName?.takeIf { it.isNotBlank() }?.let { parts += shortModelName(it) }
            if (snapshot.tokensUsed > 0L) parts += "${formatTokens(snapshot.tokensUsed)} tok"
            if (snapshot.inputTokens > 0L || snapshot.outputTokens > 0L) {
                parts += "in ${formatTokens(snapshot.inputTokens)} / out ${formatTokens(snapshot.outputTokens)}"
            }
            val cacheTokens = snapshot.cacheCreationInputTokens + snapshot.cacheReadInputTokens
            if (cacheTokens > 0L) parts += "cache ${formatTokens(cacheTokens)}"
            if (snapshot.totalCostUsd > 0.0) parts += "$" + String.format(Locale.US, "%.2f", snapshot.totalCostUsd)
            snapshot.contextPercentRemaining?.let { parts += String.format(Locale.US, "%.0f%% ctx", it) }
            return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ") ?: "Session ${shortSessionId(snapshot.sessionId)}"
        }

        private fun durationSummary(snapshot: SessionSnapshot): String? {
            val durationMs = snapshot.lastEventAt - snapshot.sessionStartAt
            if (durationMs < 0L) return null
            val minutes = durationMs / 60_000L
            return when {
                minutes < 1L -> "<1m"
                minutes < 60L -> "${minutes}m"
                else -> "${minutes / 60L}h ${minutes % 60L}m"
            }
        }

        private fun shortSessionId(sessionId: String): String {
            return if (sessionId.length > 10) sessionId.take(8) else sessionId
        }

        private fun shorten(value: String, max: Int): String {
            val cleaned = value.replace(Regex("\\s+"), " ").trim()
            return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
        }

        private fun shortModelName(model: String): String {
            return model
                .removePrefix("claude-")
                .removePrefix("gpt-")
                .replace("-2025", "")
                .replace("-2026", "")
                .take(18)
        }

        private fun formatTime(time: Long): String {
            val pattern = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) "HH:mm:ss" else "HH:mm"
            return SimpleDateFormat(pattern, Locale.US).format(Date(time))
        }

        private const val STALE_AFTER_MS = 10 * 60 * 1000L
    }
}
