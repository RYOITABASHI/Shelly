package expo.modules.terminalemulator.scouter

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.AgentAlarmScheduler
import expo.modules.terminalemulator.HomeInitializer
import java.io.File
import org.json.JSONObject

// lastRunStatus mirrors AgentRunLog['status'] from lib/agent-manager.ts
// ("success" | "error" | "skipped" | "unavailable"), read from the newest
// file under ~/.shelly/agents/logs/<id>/*.json. Null means no run-log file
// was found yet (agent has never run, or the log dir is empty/unreadable).
data class ScouterWidgetAgentTarget(
    val agentId: String,
    val name: String,
    val cron: String,
    val nextRunAt: Long,
    val lastRunStatus: String? = null,
    val lastRunAt: Long? = null
)

/**
 * Disk-backed source of truth for the widget's RUN targets (up to 3 rows).
 *
 * The RN agent store is intentionally not persisted, so native widget rendering
 * must never retain an in-memory Agent reference. Every render and every tap
 * re-reads ~/.shelly/agents/<id>.json, verifies that the filename and embedded id
 * match, and requires a materialized run artifact. This also prevents a stale
 * widget PendingIntent from running an agent that was deleted or disabled after
 * the widget was rendered.
 */
object WidgetAgentRepository {
    private const val TAG = "WidgetAgentRepository"
    private val SAFE_AGENT_ID = Regex("^[A-Za-z0-9_-]+$")
    private const val DEFAULT_WIDGET_AGENT_LIMIT = 3

    /** Up to [limit] enabled, scheduled agents ordered by soonest next-fire. */
    fun nextScheduledAgents(context: Context, limit: Int = DEFAULT_WIDGET_AGENT_LIMIT): List<ScouterWidgetAgentTarget> {
        val candidates = readScheduledAgents(context)
        return candidates
            .sortedWith(compareBy<ScouterWidgetAgentTarget> { it.nextRunAt }.thenBy { it.agentId })
            .take(limit)
    }

    /** Back-compat single-target accessor; kept for callers that only need one. */
    fun nextScheduled(context: Context): ScouterWidgetAgentTarget? =
        nextScheduledAgents(context, 1).firstOrNull()

    fun scheduledById(context: Context, agentId: String): ScouterWidgetAgentTarget? {
        if (!SAFE_AGENT_ID.matches(agentId)) return null
        return readScheduledAgent(context, agentId)
    }

    private fun readScheduledAgents(context: Context): List<ScouterWidgetAgentTarget> {
        val agentsDir = agentsDir(context)
        val files = agentsDir.listFiles { file -> file.isFile && file.extension == "json" } ?: return emptyList()
        return files.mapNotNull { file ->
            val fileId = file.name.removeSuffix(".json")
            if (!SAFE_AGENT_ID.matches(fileId)) return@mapNotNull null
            readScheduledAgentFile(agentsDir, file, fileId)
        }
    }

    private fun readScheduledAgent(context: Context, agentId: String): ScouterWidgetAgentTarget? {
        val agentsDir = agentsDir(context)
        val file = File(agentsDir, "$agentId.json")
        if (!file.isFile) return null
        return readScheduledAgentFile(agentsDir, file, agentId)
    }

    private fun readScheduledAgentFile(
        agentsDir: File,
        file: File,
        expectedId: String
    ): ScouterWidgetAgentTarget? {
        return try {
            val json = JSONObject(file.readText())
            val id = json.optString("id").trim()
            if (id != expectedId || !SAFE_AGENT_ID.matches(id)) return null
            if (!json.optBoolean("enabled", false)) return null
            val cron = (
                if (json.isNull("schedule")) null
                else json.optString("schedule").trim().ifBlank { null }
            ) ?: return null
            val nextRunAt = AgentAlarmScheduler.nextTriggerAt(cron) ?: return null
            val hasRunArtifact = File(agentsDir, "run-agent-$id.sh").isFile ||
                File(agentsDir, "plans/plan-agent-$id.json").isFile
            if (!hasRunArtifact) return null
            val (lastRunStatus, lastRunAt) = readLastRunStatus(agentsDir, id)
            ScouterWidgetAgentTarget(
                agentId = id,
                name = json.optString("name").trim().ifBlank { id },
                cron = cron,
                nextRunAt = nextRunAt,
                lastRunStatus = lastRunStatus,
                lastRunAt = lastRunAt
            )
        } catch (error: Exception) {
            Log.w(TAG, "Ignoring invalid agent metadata ${file.name}", error)
            null
        }
    }

    // Best-effort read of the most recent run-log written by
    // lib/agent-manager.ts (runAgentInBackground/runAgentOrchestrated) at
    // ~/.shelly/agents/logs/<id>/<epochMs>.json. Filenames are the run's
    // epoch-ms timestamp, so the lexicographically-last *.json file is also
    // the most recent run (stable while epoch-ms keeps a constant digit
    // count, true for the foreseeable future). Never throws; any I/O or
    // parse failure just yields "no last-run data" rather than failing the
    // whole agent row.
    private fun readLastRunStatus(agentsDir: File, agentId: String): Pair<String?, Long?> {
        return try {
            val logDir = File(agentsDir, "logs/$agentId")
            val files = logDir.listFiles { f -> f.isFile && f.extension == "json" }
            if (files.isNullOrEmpty()) return null to null
            val latest = files.maxByOrNull { it.nameWithoutExtension.toLongOrNull() ?: 0L } ?: return null to null
            val json = JSONObject(latest.readText())
            val status = json.optString("status").takeIf {
                it == "success" || it == "error" || it == "skipped" || it == "unavailable"
            }
            val timestamp = json.optLong("timestamp", 0L).takeIf { it > 0L }
            status to timestamp
        } catch (error: Exception) {
            Log.w(TAG, "Ignoring unreadable run-log for $agentId", error)
            null to null
        }
    }

    private fun agentsDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context.applicationContext), ".shelly/agents")
}
