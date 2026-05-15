package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
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

    fun runAgent(context: Context, agentId: String): AgentRunResult {
        val appContext = context.applicationContext
        val libDir = LibExtractor.extractAll(appContext)
        val homeDir = HomeInitializer.getHomeDir(appContext)
        val bashPath = LibExtractor.getBashPath(appContext)
        val scriptPath = File(homeDir, ".shelly/agents/run-agent-$agentId.sh").absolutePath
        val script = File(scriptPath)

        if (!script.exists()) {
            val message = "missing script: $scriptPath"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }

        val libPath = libDir.absolutePath
        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
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
        if (exitCode == 0) {
            Log.i(TAG, "Agent $agentId completed via Shelly runtime")
        } else {
            Log.e(TAG, "Agent $agentId failed via Shelly runtime: exit=$exitCode stderr=${stderr.take(300)}")
            writeReceiverLog(
                homeDir,
                agentId,
                "error",
                "exit=$exitCode stderr=${stderr.take(500)} stdout=${stdout.take(500)}"
            )
        }

        return AgentRunResult(agentId, exitCode, stdout, stderr)
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
