package expo.modules.terminalemulator.scouter

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.AgentAlarmScheduler
import expo.modules.terminalemulator.HomeInitializer
import java.io.File
import org.json.JSONObject

data class ScouterWidgetAgentTarget(
    val agentId: String,
    val name: String,
    val cron: String,
    val nextRunAt: Long
)

/**
 * Disk-backed source of truth for the widget's single RUN target.
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

    fun nextScheduled(context: Context): ScouterWidgetAgentTarget? {
        val candidates = readScheduledAgents(context)
        return candidates.minWithOrNull(compareBy<ScouterWidgetAgentTarget> { it.nextRunAt }.thenBy { it.agentId })
    }

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
            ScouterWidgetAgentTarget(
                agentId = id,
                name = json.optString("name").trim().ifBlank { id },
                cron = cron,
                nextRunAt = nextRunAt
            )
        } catch (error: Exception) {
            Log.w(TAG, "Ignoring invalid agent metadata ${file.name}", error)
            null
        }
    }

    private fun agentsDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context.applicationContext), ".shelly/agents")
}
