package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File

/**
 * A2ABridge — spawns/stops scripts/shelly-a2a-server.js, a minimal A2A
 * (Agent2Agent) protocol server exposing Shelly's read-only `list_agents`
 * skill to any A2A client on the same network. See that script's own doc
 * comment for the protocol details and the file-queue IPC bridge (mirrored
 * on the RN side by lib/a2a-bridge.ts) it uses to reach the agent list,
 * which lives in RN's JS state and isn't otherwise reachable from a
 * separate Node process.
 *
 * Unlike VoiceBridge's session-scoped voice process, this is meant to run
 * for as long as the setting is on and the app process is alive — started
 * once (from settings toggle-on or app launch if already enabled), left
 * running, stopped on toggle-off. No foreground service yet, so the server
 * goes down if Android kills the app process; that's a known, acceptable
 * MVP limitation (same "same-Wi-Fi/VPN, app must be running" scope already
 * established for the planned MCP server work) rather than an oversight.
 *
 * Spawn mechanics (ProcessBuilder + `/system/bin/linker64` + the bundled
 * node binary) are the exact same proven pattern as VoiceBridge.kt / the
 * "Linker64 Trick" diagnostic in TerminalEmulatorModule.kt — see either for
 * why this needs ProcessBuilder rather than the batch
 * ShellyJNI.execSubprocess path everything else uses (this needs a
 * long-lived process, not a run-to-completion one, though unlike voice
 * there's no live stdin/stdout piping needed here — the server talks HTTP,
 * not process pipes).
 */
object A2ABridge {
    private const val TAG = "A2ABridge"
    private const val PORT = 8766

    private var process: Process? = null

    fun isRunning(): Boolean = process?.isAlive == true

    @Synchronized
    fun start(context: Context): Boolean {
        if (isRunning()) return true

        val homeDir = HomeInitializer.getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context)
        val scriptPath = File(homeDir, ".shelly-a2a-server.js").absolutePath
        val nodePath = File(libDir, "node").absolutePath
        val queueDir = File(homeDir, ".shelly-a2a-queue")
        queueDir.mkdirs()

        if (!File(scriptPath).exists() || !File(nodePath).exists()) {
            Log.e(TAG, "A2A runtime not extracted yet (script or node binary missing)")
            return false
        }

        val pb = ProcessBuilder("/system/bin/linker64", nodePath, scriptPath, queueDir.absolutePath, PORT.toString())
        pb.environment()["LD_LIBRARY_PATH"] = libDir.absolutePath
        pb.environment()["HOME"] = homeDir.absolutePath
        pb.directory(homeDir)
        pb.redirectErrorStream(false)
        return try {
            val proc = pb.start()
            process = proc
            // Drain stderr in a daemon-ish thread so the script's own
            // `log()` lines don't fill the pipe buffer and block it —
            // Process streams aren't auto-drained the way ShellyJNI's
            // batch exec output is.
            Thread {
                try {
                    proc.errorStream.bufferedReader().forEachLine { Log.i(TAG, it) }
                } catch (_: Exception) {}
            }.apply { name = "A2ABridge-stderr"; start() }
            true
        } catch (e: Exception) {
            Log.e(TAG, "failed to spawn A2A server: ${e.message}")
            false
        }
    }

    @Synchronized
    fun stop() {
        val proc = process ?: return
        process = null
        try {
            proc.destroy()
        } catch (_: Exception) {}
    }
}
