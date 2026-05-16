package expo.modules.terminalemulator.scouter

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
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
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
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
                views.setTextViewText(R.id.scouter_title, "Scouter · waiting")
                views.setTextViewText(R.id.scouter_source_badge, "SH")
                views.setTextViewText(R.id.scouter_detail, "No agent session yet")
                views.setTextViewText(R.id.scouter_metrics, "Open Shelly and start Claude Code or Codex")
                views.setInt(R.id.scouter_status_dot, "setColorFilter", Color.GRAY)
                return views
            }

            val branch = snapshot.gitBranch?.let { " · $it" }.orEmpty()
            val title = "${snapshot.projectName}$branch"
            val detail = listOfNotNull(snapshot.currentTool, snapshot.currentFile).joinToString(" · ")
                .ifBlank { snapshot.currentStatus.name.lowercase(Locale.US).replace('_', ' ') }
            val metrics = buildString {
                if (snapshot.totalCostUsd > 0.0) append("$").append(String.format(Locale.US, "%.2f", snapshot.totalCostUsd)).append(" · ")
                if (snapshot.tokensUsed > 0L) append(formatTokens(snapshot.tokensUsed)).append(" tokens · ")
                snapshot.contextPercentRemaining?.let { append(String.format(Locale.US, "%.0f%% context · ", it)) }
                append("updated ").append(formatTime(snapshot.lastEventAt))
            }

            views.setTextViewText(R.id.scouter_title, title)
            views.setTextViewText(R.id.scouter_source_badge, snapshot.source.badge())
            views.setTextViewText(R.id.scouter_detail, detail.redactForScouter())
            views.setTextViewText(R.id.scouter_metrics, metrics)
            views.setInt(R.id.scouter_status_dot, "setColorFilter", colorForStatus(snapshot.currentStatus))
            return views
        }

        private fun colorForStatus(status: ScouterStatus): Int = when (status) {
            ScouterStatus.IDLE -> Color.rgb(120, 120, 120)
            ScouterStatus.THINKING -> Color.rgb(59, 130, 246)
            ScouterStatus.TOOL_RUNNING -> Color.rgb(34, 197, 94)
            ScouterStatus.WAITING_PERMISSION -> Color.rgb(249, 115, 22)
            ScouterStatus.COMPLETED -> Color.rgb(45, 212, 191)
            ScouterStatus.ERROR -> Color.rgb(239, 68, 68)
        }

        private fun formatTokens(tokens: Long): String {
            return if (tokens >= 1000) String.format(Locale.US, "%.1fK", tokens / 1000.0) else tokens.toString()
        }

        private fun formatTime(time: Long): String {
            val pattern = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) "HH:mm:ss" else "HH:mm"
            return SimpleDateFormat(pattern, Locale.US).format(Date(time))
        }
    }
}
