package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * MCPBridge — spawns/stops scripts/shelly-mcp-server.js, a minimal MCP
 * (Model Context Protocol) server exposing a small set of READ-ONLY tools
 * (read_terminal_output, git_status, list_agents, list_repos) to an MCP
 * client (Claude Code, Claude Desktop) on the same network. See that
 * script's own doc comment for the protocol details, why it targets the
 * older initialize+Mcp-Session-Id flow rather than the newer stateless
 * 2026-07-28 revision, and the file-queue IPC bridge (mirrored on the RN
 * side by lib/mcp-server-bridge.ts) it uses to reach RN's JS state.
 *
 * Structurally a near-duplicate of A2ABridge.kt (long-lived process, same
 * ProcessBuilder + linker64 spawn mechanics, no foreground service yet) —
 * kept as a separate class/process/port rather than merged into one server
 * because MCP and A2A are different protocols with different request
 * shapes; sharing a listener would mean branching protocol dispatch inside
 * one script for no real benefit at this scale. Revisit if both grow.
 */
object MCPBridge {
    private const val TAG = "MCPBridge"
    private const val PORT = 8767 // keep in sync with lib/mcp-token.ts MCP_SERVER_PORT
    private const val STOP_GRACE_MS = 2000L

    private var process: Process? = null

    fun isRunning(): Boolean = process?.isAlive == true

    @Synchronized
    fun start(context: Context, token: String): Boolean {
        if (token.isBlank()) {
            Log.e(TAG, "no token provided")
            return false
        }
        if (isRunning()) return true

        val homeDir = HomeInitializer.getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context)
        val scriptPath = File(homeDir, ".shelly-mcp-server.js").absolutePath
        val nodePath = File(libDir, "node").absolutePath
        val queueDir = File(homeDir, ".shelly-mcp-queue")
        queueDir.mkdirs()

        if (!File(scriptPath).exists() || !File(nodePath).exists()) {
            Log.e(TAG, "MCP runtime not extracted yet (script or node binary missing)")
            return false
        }

        val pb = ProcessBuilder("/system/bin/linker64", nodePath, scriptPath, queueDir.absolutePath, PORT.toString())
        pb.environment()["LD_LIBRARY_PATH"] = libDir.absolutePath
        pb.environment()["HOME"] = homeDir.absolutePath
        pb.environment()["SHELLY_MCP_TOKEN"] = token
        pb.directory(homeDir)
        pb.redirectErrorStream(false)
        return try {
            val proc = pb.start()
            process = proc
            Thread {
                try {
                    proc.errorStream.bufferedReader().forEachLine { Log.i(TAG, it) }
                } catch (_: Exception) {}
            }.apply { name = "MCPBridge-stderr"; start() }
            true
        } catch (e: Exception) {
            Log.e(TAG, "failed to spawn MCP server: ${e.message}")
            false
        }
    }

    /**
     * Stops the server and waits for the process to actually exit, so a
     * restart (token regeneration, see lib/mcp-token.ts) never overlaps an
     * old process that still holds the port and still accepts the old token.
     * SIGTERM first (the script closes every open connection and exits), then
     * SIGKILL if it hasn't exited within the grace period.
     */
    @Synchronized
    fun stop() {
        val proc = process ?: return
        process = null
        try {
            proc.destroy()
            if (!proc.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "MCP server did not exit on SIGTERM; killing")
                proc.destroyForcibly()
                if (!proc.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                    Log.e(TAG, "MCP server still alive after SIGKILL")
                }
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            runCatching { proc.destroyForcibly() }
        } catch (_: Exception) {
            runCatching { proc.destroyForcibly() }
        }
    }
}
