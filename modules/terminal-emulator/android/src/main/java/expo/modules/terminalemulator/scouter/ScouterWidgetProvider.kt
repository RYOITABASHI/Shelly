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
import android.util.Log
import android.widget.RemoteViews
import expo.modules.terminalemulator.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ScouterWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        runCatching { updateWidgets(context, manager, ids) }
            .onFailure { Log.w(TAG, "Scouter widget update failed", it) }
    }

    companion object {
        fun updateAll(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val component = ComponentName(context, ScouterWidgetProvider::class.java)
                val ids = manager.getAppWidgetIds(component)
                if (ids.isEmpty()) return
                updateWidgets(context, manager, ids)
            }.onFailure { Log.w(TAG, "Scouter widget updateAll failed", it) }
        }

        private fun updateWidgets(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val store = ScouterStateStore(context)
            val snapshots = if (store.isEnabled()) store.all() else emptyList()
            val load = ScouterSystemSampler(context).sample()
            ids.forEach { id ->
                runCatching { manager.updateAppWidget(id, render(context, snapshots, load)) }
                    .onFailure { Log.w(TAG, "Scouter widget update failed for id=$id", it) }
            }
        }

        private fun render(context: Context, snapshots: List<SessionSnapshot>, load: ScouterSystemLoad): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.scouter_widget_medium)
            launchPendingIntent(context)?.let { views.setOnClickPendingIntent(R.id.scouter_widget_root, it) }

            val codex = latestFor(snapshots, ScouterSource.CODEX)
            val local = latestFor(snapshots, ScouterSource.LOCAL_LLM)
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
                    "FLOW in -- / out -- · CACHE --"
                ).joinToString("\n")
            )
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
                views.setInt(dotId, "setColorFilter", Color.rgb(122, 150, 122))
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

        private fun launchPendingIntent(context: Context): PendingIntent? {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse("shelly://scouter")
            } ?: return null
            return PendingIntent.getActivity(
                context,
                9100,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
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
            return when (snapshot.currentStatus) {
                ScouterStatus.IDLE -> "Waiting in $project"
                ScouterStatus.THINKING -> "Thinking in $project"
                ScouterStatus.TOOL_RUNNING -> {
                    val action = tool?.let { "Running $it" } ?: "Running tool"
                    file?.let { "$action on $it" } ?: "$action in $project"
                }
                ScouterStatus.WAITING_PERMISSION -> "Waiting permission"
                ScouterStatus.COMPLETED -> "Completed in $project"
                ScouterStatus.ERROR -> "Error in $project"
            }
        }

        private fun localStatus(snapshot: SessionSnapshot): String {
            val backend = snapshot.localBackend?.takeIf { it != "offline" } ?: snapshot.modelName
            return when {
                snapshot.localBackend == "offline" -> "Offline · no endpoint"
                snapshot.currentStatus == ScouterStatus.TOOL_RUNNING -> "Busy · ${backend ?: "local"}"
                else -> "Ready · ${backend ?: "local"}"
            }
        }

        private fun metricsLine(snapshot: SessionSnapshot): String {
            return if (snapshot.source == ScouterSource.LOCAL_LLM) localMetrics(snapshot) else codexMetrics(snapshot)
        }

        private fun codexMetrics(snapshot: SessionSnapshot): String {
            val lines = mutableListOf<String>()
            val contextParts = mutableListOf<String>()
            contextParts += contextGauge(snapshot)
            snapshot.modelName?.takeIf { it.isNotBlank() }?.let { contextParts += "MODEL ${shortModelName(it)}" }
            if (snapshot.contextPercentRemaining != null && snapshot.tokensUsed > 0L) {
                contextParts += "TOK ${formatTokens(snapshot.tokensUsed)}"
            }
            lines += contextParts.filter { it.isNotBlank() }.joinToString(" · ")

            val flowParts = mutableListOf<String>()
            if (snapshot.inputTokens > 0L || snapshot.outputTokens > 0L) {
                flowParts += "FLOW in ${formatTokens(snapshot.inputTokens)} / out ${formatTokens(snapshot.outputTokens)}"
            }
            if (snapshot.reasoningOutputTokens > 0L) flowParts += "REASON ${formatTokens(snapshot.reasoningOutputTokens)}"
            val cacheTokens = snapshot.cacheCreationInputTokens + snapshot.cacheReadInputTokens
            if (cacheTokens > 0L) flowParts += "CACHE ${formatTokens(cacheTokens)}"
            if (flowParts.isEmpty()) {
                flowParts += "TRACE ${formatTime(snapshot.lastEventAt)}"
                flowParts += "SID ${shortSessionId(snapshot.sessionId)}"
            }
            lines += flowParts.joinToString(" · ")

            return lines.filter { it.isNotBlank() }.joinToString("\n")
        }

        private fun localMetrics(snapshot: SessionSnapshot): String {
            val lines = mutableListOf<String>()
            val wave = snapshot.tokensPerSecond?.takeIf { it > 0.0 }?.let { sparkline(it, 80.0) } ?: "........"
            val tps = snapshot.tokensPerSecond?.takeIf { it > 0.0 }?.let {
                String.format(Locale.US, "TPS %.1f", it)
            } ?: "TPS --"
            lines += "WAVE $wave · $tps"
            val linkParts = mutableListOf<String>()
            snapshot.latencyMs?.let { linkParts += "PING ${it}ms" } ?: run { linkParts += "PING --ms" }
            snapshot.localEndpoint?.let { linkParts += "END ${shortEndpoint(it)}" } ?: run { linkParts += "END none" }
            snapshot.queueSize?.let { linkParts += "Q $it" }
            lines += linkParts.joinToString(" · ")
            return lines.filter { it.isNotBlank() }.joinToString("\n")
        }

        private fun loadLine(load: ScouterSystemLoad): String {
            val cpu = load.cpuPercent?.let { String.format(Locale.US, "%.0f%%", it) } ?: "--%"
            val memory = load.ramAvailableMb?.let { "RAM ${formatMegabytes(it)} free" }
            return listOfNotNull("LOAD CPU $cpu", memory).joinToString(" · ")
        }

        private fun contextGauge(snapshot: SessionSnapshot): String {
            val remaining = snapshot.contextPercentRemaining
            if (remaining != null) {
                val used = (100.0 - remaining).coerceIn(0.0, 100.0)
                return "CTX ${bar(used)} ${used.toInt()}%"
            }
            return if (snapshot.tokensUsed > 0L) "TOK ${formatTokens(snapshot.tokensUsed)}" else ""
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
            status == ScouterStatus.IDLE -> Color.rgb(155, 196, 155)
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

        private fun formatMegabytes(value: Long): String {
            return if (value >= 1024L) String.format(Locale.US, "%.1fG", value / 1024.0) else "${value}M"
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
                .removePrefix("gpt-")
                .replace("-2025", "")
                .replace("-2026", "")
                .take(18)
        }

        private fun formatTime(time: Long): String {
            val pattern = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) "HH:mm:ss" else "HH:mm"
            return SimpleDateFormat(pattern, Locale.US).format(Date(time))
        }

        private const val TAG = "ScouterWidget"
        private const val STALE_AFTER_MS = 10 * 60 * 1000L
    }
}
