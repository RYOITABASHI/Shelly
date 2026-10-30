package expo.modules.terminalemulator.monitor

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.HomeInitializer
import expo.modules.terminalemulator.NativeAgentRunRegistry
import java.io.File
import java.io.RandomAccessFile
import org.json.JSONObject

/**
 * Disk reader for the MONITOR widget: picks the most relevant run under
 * `$HOME/.shelly/agents/logs/<agentId>/progress.jsonl` and maps it through
 * [MonitorWidgetModel]. Only agents that still exist (`agents/<id>.json`) are
 * considered, so a deleted agent's leftover log never shows up.
 *
 * "Most relevant" = a live run (no run_end, written recently or known to
 * AgentRuntime) if any, else the most recently written file.
 */
object MonitorWidgetRepository {
    private const val TAG = "MonitorWidget"
    private val SAFE_AGENT_ID = Regex("^[A-Za-z0-9_-]+$")
    /** Writers cap the file at 256 KiB; read at most a little more (tail). */
    private const val MAX_READ_BYTES = 320 * 1024L
    /** Files parsed per refresh at most (most recently written first). */
    private const val MAX_CANDIDATES = 6

    /**
     * @param recheckDelayMs when to look again although nothing was written
     *   (the shown live run may go silent); null = no re-check needed.
     */
    data class Snapshot(
        val model: MonitorWidgetModel.Model?,
        val agentName: String?,
        val recheckDelayMs: Long? = null
    )

    fun agentsDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context.applicationContext), ".shelly/agents")

    fun logsDir(context: Context): File = File(agentsDir(context), "logs")

    fun isSafeAgentId(id: String?): Boolean = id != null && SAFE_AGENT_ID.matches(id)

    /** @param holders who holds which agent's run open (MonitorWidgetUpdater). */
    fun load(
        context: Context,
        holders: MonitorRunHolders,
        nowMs: Long = System.currentTimeMillis()
    ): Snapshot {
        val agents = agentsDir(context)
        val logs = File(agents, "logs")
        val candidates = (logs.listFiles { f -> f.isDirectory && SAFE_AGENT_ID.matches(f.name) } ?: emptyArray())
            .asSequence()
            .filter { File(agents, "${it.name}.json").isFile }
            .map { File(it, "progress.jsonl") }
            .filter { it.isFile && it.length() > 0 }
            .sortedByDescending { it.lastModified() }
            .take(MAX_CANDIDATES)
            .toList()
        if (candidates.isEmpty()) return Snapshot(null, null)

        val built = ArrayList<MonitorWidgetModel.Candidate>()
        for (file in candidates) {
            val agentId = file.parentFile?.name ?: continue
            val run = runCatching { MonitorProgress.parse(readTail(file)) }
                .onFailure { Log.w(TAG, "progress parse failed for $agentId", it) }
                .getOrNull() ?: continue
            if (run.agentId != agentId) continue
            val nativeActive = holders.nativeActive(agentId) ||
                NativeAgentRunRegistry.activeRunStartedAt(agentId) != null
            val chainActive = holders.chainActive(agentId)
            val model = MonitorWidgetModel.build(
                run = run,
                nowMs = nowMs,
                nativeRunActive = nativeActive,
                chainActive = chainActive,
                heldEndedAtMs = holders.endedAt(agentId),
                iteration = readIteration(File(file.parentFile, "checkpoint.json"))
            )
            built += MonitorWidgetModel.Candidate(run, model, nativeActive, chainActive)
        }
        val pick = MonitorWidgetModel.pick(built) ?: return Snapshot(null, null)
        return Snapshot(
            pick.model,
            readAgentName(agents, pick.model.agentId),
            MonitorWidgetModel.recheckDelayMs(pick.run, nowMs, pick.model.live, pick.nativeActive, pick.chainActive)
        )
    }

    private fun readTail(file: File): String {
        val len = file.length()
        if (len <= MAX_READ_BYTES) return file.readText(Charsets.UTF_8)
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(len - MAX_READ_BYTES)
            val buf = ByteArray(MAX_READ_BYTES.toInt())
            raf.readFully(buf)
            // The first (partial) line is dropped by the parser as malformed.
            return String(buf, Charsets.UTF_8)
        }
    }

    /** checkpoint.json `iteration` (continuous mode), when present and sane. */
    private fun readIteration(file: File): Int? {
        if (!file.isFile || file.length() > 64 * 1024) return null
        return runCatching {
            val v = JSONObject(file.readText(Charsets.UTF_8)).opt("iteration")
            (v as? Number)?.toInt()?.takeIf { it in 1..1_000_000 }
        }.getOrNull()
    }

    private fun readAgentName(agents: File, agentId: String): String? = runCatching {
        val file = File(agents, "$agentId.json")
        if (!file.isFile || file.length() > 512 * 1024) return@runCatching null
        JSONObject(file.readText(Charsets.UTF_8)).optString("name").trim().takeIf { it.isNotEmpty() }
    }.getOrNull()
}
