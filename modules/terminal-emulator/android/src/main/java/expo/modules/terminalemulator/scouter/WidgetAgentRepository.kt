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

    // bug #163: a malformed run-log JSON (e.g. the double-escaped-output race
    // in lib/agent-executor.ts's json_escape_text/json_string_file, fixed in
    // AGENT_SCRIPT_VERSION v40 — see that file's changelog comment) made
    // readLastRunStatus() below throw org.json.JSONException on EVERY 60s
    // widget poll, forever, for the same file: no crash, but unbounded log
    // spam, and it starved the widget row of ANY status once an agent's
    // newest run-log happened to be the corrupt one (older, valid runs were
    // never even attempted). Track already-seen-corrupt files (by absolute
    // path + last-modified stamp, so a file that gets deleted/recreated with
    // the same name is given a fresh chance) so the same broken file is only
    // ever logged once, not once per poll. Process-lifetime cache only,
    // deliberately not persisted — it clears itself on app restart, by which
    // point the underlying log file has likely been pruned anyway (run-logs
    // are capped at the last 30 per agent).
    private val knownCorruptRunLogs = mutableSetOf<String>()

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
        // Non-agent state files can share this directory (e.g. dm-pairings.json,
        // a JSON *array* of DM pairings — its filename "dm-pairings" happens to
        // match SAFE_AGENT_ID's charset, so the filename filter above doesn't
        // exclude it). org.json's JSONObject(String) constructor embeds the
        // *entire remaining source text* in its JSONException message when the
        // input isn't an object (JSONTokener.syntaxError appends "at character
        // N of <source>"), so letting that exception reach any Log call would
        // leak file contents (e.g. contact names/IDs) to logcat on every widget
        // poll. Check the shape before parsing so mismatched files are skipped
        // silently, with no exception ever constructed from their content.
        val text = try {
            file.readText()
        } catch (error: Exception) {
            Log.w(TAG, "Ignoring unreadable agent metadata: ${file.name}")
            return null
        }
        if (text.trimStart().firstOrNull() != '{') return null
        return try {
            val json = JSONObject(text)
            val id = json.optString("id").trim()
            if (id != expectedId || !SAFE_AGENT_ID.matches(id)) return null
            if (!json.optBoolean("enabled", false)) return null
            val cron = (
                if (json.isNull("schedule")) null
                else json.optString("schedule").trim().ifBlank { null }
            ) ?: return null
            val startNotBefore = if (json.has("startNotBefore") && !json.isNull("startNotBefore")) json.optLong("startNotBefore") else null
            val nextRunAt = AgentAlarmScheduler.nextTriggerAt(cron, startNotBefore) ?: return null
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
            // Filename only — never pass `error` here, its message can embed
            // raw file content (see the shape-check comment above).
            Log.w(TAG, "Ignoring invalid agent metadata: ${file.name}")
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
    //
    // bug #163: previously only ever tried the single newest file — if THAT
    // one happened to be malformed JSON, the row showed no status at all
    // even though older, perfectly valid run-logs for the same agent existed
    // right next to it. Now walks newest-first and falls through to the next
    // file on a parse failure, so one corrupt log no longer blanks the row.
    private fun readLastRunStatus(agentsDir: File, agentId: String): Pair<String?, Long?> {
        val logDir = File(agentsDir, "logs/$agentId")
        val files = logDir.listFiles { f -> f.isFile && f.extension == "json" }
        if (files.isNullOrEmpty()) return null to null
        val candidates = files.sortedByDescending { it.nameWithoutExtension.toLongOrNull() ?: 0L }
        for (file in candidates) {
            val parsed = tryReadRunLogStatus(file) ?: continue
            return parsed
        }
        return null to null
    }

    // Returns null (not a status pair) when the file fails to parse, so the
    // caller can skip it and try the next-oldest run-log instead of treating
    // "no data" as the final answer for the whole agent.
    private fun tryReadRunLogStatus(file: File): Pair<String?, Long?>? {
        return try {
            val json = JSONObject(file.readText())
            val status = json.optString("status").takeIf {
                it == "success" || it == "error" || it == "skipped" || it == "unavailable"
            }
            val timestamp = json.optLong("timestamp", 0L).takeIf { it > 0L }
            status to timestamp
        } catch (error: Exception) {
            val cacheKey = "${file.absolutePath}:${file.lastModified()}"
            if (knownCorruptRunLogs.add(cacheKey)) {
                // Filename only, same reasoning as readScheduledAgentFile above —
                // a run-log JSONException's message can embed raw file content.
                Log.w(TAG, "Ignoring unreadable run-log: ${file.name}")
            }
            null
        }
    }

    private fun agentsDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context.applicationContext), ".shelly/agents")
}
