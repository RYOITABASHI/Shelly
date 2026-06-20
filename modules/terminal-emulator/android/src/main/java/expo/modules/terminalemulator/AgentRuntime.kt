package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.scouter.NotificationDispatcher
import expo.modules.terminalemulator.scouter.AgentEscalationBridge
import org.json.JSONObject
import java.io.File

data class AgentRunResult(
    val agentId: String,
    val exitCode: Int,
    val stdout: String,
    val stderr: String
) {
    val success: Boolean get() = exitCode == 0
}

/**
 * Executes scheduled agent scripts with Shelly's bundled Plan B runtime.
 *
 * This replaces the old Termux RUN_COMMAND bridge for background agents. The
 * script is sourced from Shelly bash because direct shebang execution from
 * app-private storage is blocked on modern Android target SDKs.
 */
object AgentRuntime {
    private const val TAG = "AgentRuntime"
    private const val DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
    private const val CURRENT_SCRIPT_VERSION = 8

    fun runAgent(context: Context, agentId: String): AgentRunResult {
        val appContext = context.applicationContext
        HomeInitializer.initialize(appContext)
        val homeDir = HomeInitializer.getHomeDir(appContext)
        val libDir = try {
            LibExtractor.extractAll(appContext)
        } catch (e: Exception) {
            val message = "runtime extraction failed before script: ${e.javaClass.simpleName}: ${e.message}"
            Log.e(TAG, message, e)
            writeReceiverLog(homeDir, agentId, "error", message)
            return AgentRunResult(agentId, 125, "", message)
        }
        val bashPath = LibExtractor.getBashPath(appContext)
        val scriptPath = File(homeDir, ".shelly/agents/run-agent-$agentId.sh").absolutePath
        val script = File(scriptPath)

        if (!script.exists()) {
            val message = "missing script: $scriptPath"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        val scriptVersion = readScriptVersion(script)
        if (scriptVersion < CURRENT_SCRIPT_VERSION) {
            val message = "stale script: $scriptPath version=$scriptVersion expected=$CURRENT_SCRIPT_VERSION. Open Shelly or run the agent manually once to regenerate it."
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(appContext).notifyAgentResult(
                agentId = agentId,
                status = "error",
                preview = message
            )
            return AgentRunResult(agentId, 126, "", message)
        }

        val libPath = libDir.absolutePath
        val escalationPublicKeySha256 = AgentEscalationBridge.verifierPublicKeySha256(appContext)
        Log.i(
            TAG,
            "Agent $agentId starting via Shelly runtime script=$scriptPath version=$scriptVersion pinInjected=${escalationPublicKeySha256.isNotBlank()}"
        )
        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
            append(" && export SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256=")
            append(shellQuote(escalationPublicKeySha256))
            append(" && readonly SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256")
            append(" && { [ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\" || true; }")
            append(" && . ")
            append(shellQuote(scriptPath))
        }

        val result = ShellyJNI.execSubprocess(
            "/system/bin/linker64",
            bashPath,
            libPath,
            homeDir.absolutePath,
            command,
            DEFAULT_TIMEOUT_MS
        )

        val exitCode = result.getOrNull(0)?.toIntOrNull() ?: 1
        val stdout = result.getOrNull(1).orEmpty()
        val stderr = result.getOrNull(2).orEmpty()
        val notificationPosted = postAgentResultNotificationIfRequested(appContext, homeDir, agentId)
        if (exitCode == 0) {
            Log.i(TAG, "Agent $agentId completed via Shelly runtime")
        } else {
            Log.e(TAG, "Agent $agentId failed via Shelly runtime: exit=$exitCode stderr=${stderr.take(300)}")
            if (!notificationPosted) {
                NotificationDispatcher(appContext).notifyAgentResult(
                    agentId = agentId,
                    status = "error",
                    preview = "Agent script failed. exit=$exitCode stderr=${stderr.take(300)}"
                )
            }
            writeReceiverLog(
                homeDir,
                agentId,
                "error",
                "exit=$exitCode stderr=${stderr.take(500)} stdout=${stdout.take(500)}"
            )
        }

        return AgentRunResult(agentId, exitCode, stdout, stderr)
    }

    private fun postAgentResultNotificationIfRequested(context: Context, homeDir: File, agentId: String): Boolean {
        val request = File(homeDir, ".shelly/agents/logs/$agentId/native-result-notification.json")
        if (!request.isFile) return false
        try {
            val json = JSONObject(request.readText())
            NotificationDispatcher(context).notifyAgentResult(
                agentId = json.optString("agentId", agentId).ifBlank { agentId },
                status = json.optString("status", "success"),
                preview = json.optString("preview", "")
            )
            return true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post agent result notification for $agentId", e)
            return false
        } finally {
            runCatching { request.delete() }
        }
    }

    private fun readScriptVersion(script: File): Int {
        return try {
            script.useLines { lines ->
                val versionRegex = Regex("""^SHELLY_AGENT_SCRIPT_VERSION=(\d+)\s*$""")
                for (line in lines.take(20)) {
                    val version = versionRegex.find(line.trim())
                        ?.groupValues
                        ?.getOrNull(1)
                        ?.toIntOrNull()
                    if (version != null) return@useLines version
                }
                0
            } ?: 0
        } catch (_: Exception) {
            0
        }
    }

    private fun writeReceiverLog(homeDir: File, agentId: String, status: String, message: String) {
        try {
            val logDir = File(homeDir, ".shelly/agents/logs/$agentId")
            logDir.mkdirs()
            val ts = System.currentTimeMillis()
            val safeMessage = message
                .replace("\\", "\\\\")
                .replace("\"", "'")
                .replace("\n", " ")
            File(logDir, "$ts-receiver.json").writeText(
                "{\"agentId\":\"$agentId\",\"timestamp\":$ts,\"status\":\"$status\",\"errorMessage\":\"$safeMessage\"}\n"
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write receiver log for $agentId", e)
        }
    }

    private fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\\''") + "'"
}
