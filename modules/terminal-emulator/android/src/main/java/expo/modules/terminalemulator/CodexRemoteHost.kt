package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File
import java.io.RandomAccessFile

/**
 * "Keep ChatGPT connected": runs `shelly codex __host` (the official
 * `codex remote-control --no-daemon`, with the exact env the terminal shim
 * uses because it is the same ~/.bashrc function) under
 * TerminalSessionService, restarts it with backoff, and stops it when the
 * user turns it off.
 *
 * All control state is files, so the shim, the RN Settings row, the boot
 * receiver and this supervisor agree without IPC:
 *   $HOME/.shelly/codex-remote-autostart   "on" = the user's choice
 *   $HOME/.shelly/codex-remote-paired      written after a successful
 *                                          `shelly codex pair --background`
 *   $HOME/.shelly/agents/.halted           STOP-ALL (lib/agent-manager.ts)
 *   $HOME/tmp/shelly-codex-remote.stopped  `shelly codex stop` / notification
 *                                          Exit; cleared once per app process
 *   $HOME/tmp/shelly-codex-remote.host     "<pid> <starttime> [native]" -- the
 *                                          shim's single-instance state file
 *   $HOME/tmp/shelly-codex-remote.log      host output (health signal)
 *
 * Network: a default-network callback keeps an online flag (no start
 * attempts while offline) and, after the default network changes or comes
 * back, gives the host [CodexRemotePolicy.NETWORK_GRACE_MS] to log that it
 * is available/connected again; otherwise the host is restarted. Changes
 * inside the grace window are debounced into one check.
 */
object CodexRemoteHost {
    private const val TAG = "CodexRemoteHost"
    const val AUTOSTART_FILE = ".shelly/codex-remote-autostart"
    const val PAIRED_FILE = ".shelly/codex-remote-paired"
    const val HALT_SENTINEL = ".shelly/agents/.halted"
    const val STATE_FILE = "tmp/shelly-codex-remote.host"
    const val STOPPED_FILE = "tmp/shelly-codex-remote.stopped"
    const val LOG_FILE = "tmp/shelly-codex-remote.log"
    private const val BG_TMP = "tmp/shelly-codex-bg"
    private const val POLL_MS = 5_000L

    // `shelly codex __host` runs in a non-interactive bash that sources the
    // generated ~/.bashrc (as Codex's own `bash -lc` and AgentRuntime do) and
    // then drops the global exec-wrapper preload, matching the interactive
    // PTY shell the shim normally runs in.
    internal const val HOST_COMMAND =
        "{ [ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\"; } >/dev/null 2>&1 </dev/null\n" +
            "unset LD_PRELOAD\n" +
            "type __shelly_codex_remote >/dev/null 2>&1 || exit 127\n" +
            "__shelly_codex_remote __host\n"

    private val lock = Object()
    @Volatile private var appContext: Context? = null
    @Volatile private var started = false
    @Volatile private var hostThreadAlive = false
    @Volatile private var online = true
    @Volatile private var lastActive = false
    private var currentNetwork: Network? = null
    private var consecutiveFailures = 0
    private var nextAttemptAt = 0L
    private var healthCheckAt = 0L
    private var healthLogMark = 0L

    // ── Inputs ──────────────────────────────────────────────────────────

    private fun home(context: Context): File = HomeInitializer.getHomeDir(context)

    fun readInputs(context: Context, ignoreStopMarker: Boolean = false): CodexRemotePolicy.Inputs {
        val home = home(context)
        val autostart = runCatching { File(home, AUTOSTART_FILE).readText().trim() == "on" }.getOrDefault(false)
        // Fail closed: if the STOP-ALL sentinel cannot be checked, treat as halted.
        val halted = runCatching { File(home, HALT_SENTINEL).exists() }.getOrDefault(true)
        return CodexRemotePolicy.Inputs(
            autostartOn = autostart,
            paired = File(home, PAIRED_FILE).isFile,
            halted = halted,
            stopRequested = !ignoreStopMarker && File(home, STOPPED_FILE).exists(),
        )
    }

    /** Desired state for receivers / app start (a fresh process clears the stop marker). */
    fun wantsAutostart(context: Context): Boolean =
        CodexRemotePolicy.shouldRun(readInputs(context, ignoreStopMarker = true))

    /** TerminalSessionService keeps itself foreground while this is true. */
    fun keepsServiceAlive(context: Context): Boolean =
        hostThreadAlive || runCatching { CodexRemotePolicy.shouldRun(readInputs(context)) }.getOrDefault(false)

    /** A tracked host (native or `pair --background`) is alive. Drives the notification text. */
    fun isHostActive(): Boolean = lastActive

    fun trackedHost(context: Context): CodexRemotePolicy.HostState? {
        val state = CodexRemotePolicy.parseState(runCatching { File(home(context), STATE_FILE).readText() }.getOrNull())
            ?: return null
        val cur = CodexRemotePolicy.procStartTime(readProcStat(state.pid)) ?: return null
        return if (cur == state.startTime) state else null
    }

    private fun readProcStat(pid: Int): String? = runCatching { File("/proc/$pid/stat").readText() }.getOrNull()

    // ── Lifecycle ───────────────────────────────────────────────────────

    /** Starts the supervisor thread once per process (TerminalSessionService.onCreate). */
    fun ensureWatching(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            if (started) { lock.notifyAll(); return }
            started = true
            appContext = app
        }
        // "until Shelly next starts": a new process forgets `shelly codex stop`.
        runCatching { File(home(app), STOPPED_FILE).delete() }
        registerNetworkCallback(app)
        Thread({ loop(app) }, "ShellyCodexRemote").apply { isDaemon = true; start() }
        Log.i(TAG, "supervisor started")
    }

    fun wake() = synchronized(lock) { lock.notifyAll() }

    /** App start / boot / package replaced: bring the foreground service up if wanted. */
    fun requestStartIfWanted(context: Context, reason: String) {
        val app = context.applicationContext
        if (!wantsAutostart(app)) {
            Log.i(TAG, "$reason: autostart not wanted (off, not paired, or STOP-ALL)")
            return
        }
        Log.i(TAG, "$reason: starting foreground service for the Codex remote host")
        val intent = Intent(app, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_CODEX_REMOTE_START
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
        } catch (e: Exception) {
            Log.w(TAG, "$reason: could not start the foreground service", e)
        }
    }

    /** Settings toggle / `shelly codex autostart` equivalent. Never marks the device paired. */
    fun setAutostart(context: Context, enabled: Boolean) {
        val home = home(context)
        val f = File(home, AUTOSTART_FILE)
        if (enabled) {
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "${f.name}.tmp.${Process.myPid()}")
            tmp.writeText("on\n")
            if (!tmp.renameTo(f)) { f.writeText("on\n"); tmp.delete() }
            File(home, STOPPED_FILE).delete()
            requestStartIfWanted(context, "setAutostart")
        } else {
            f.delete()
            stopTrackedHost(context, "autostart off")
        }
        wake()
    }

    /** Notification "Disconnect": autostart off + stop whatever host is tracked. */
    fun disconnect(context: Context) {
        setAutostart(context, false)
    }

    /** Notification "Exit": like `shelly codex stop` (back on the next app start if autostart is on). */
    fun stopUntilNextStart(context: Context) {
        val stopped = File(home(context), STOPPED_FILE)
        runCatching { stopped.parentFile?.mkdirs(); stopped.writeText("") }
        stopTrackedHost(context, "exit")
        wake()
    }

    fun status(context: Context): Map<String, Any> {
        val i = readInputs(context)
        return mapOf(
            "enabled" to i.autostartOn,
            "paired" to i.paired,
            "halted" to i.halted,
            "running" to (trackedHost(context) != null),
            "online" to online,
        )
    }

    // ── Supervisor loop ─────────────────────────────────────────────────

    private fun loop(context: Context) {
        while (true) {
            var waitMs = POLL_MS
            try {
                waitMs = reconcile(context).coerceIn(250L, POLL_MS)
            } catch (e: Exception) {
                Log.w(TAG, "reconcile failed", e)
            }
            synchronized(lock) { runCatching { lock.wait(waitMs) } }
        }
    }

    /** Returns how long to wait before the next pass. */
    private fun reconcile(context: Context): Long {
        val now = System.currentTimeMillis()
        val inputs = readInputs(context)
        val tracked = trackedHost(context)
        publishActive(context, tracked != null)

        if (!CodexRemotePolicy.shouldRun(inputs)) {
            healthCheckAt = 0L
            if (tracked != null && CodexRemotePolicy.shouldStopUnwanted(inputs, tracked.nativeOwned)) {
                stopTrackedHost(context, if (inputs.halted) "STOP-ALL" else "no longer wanted")
            }
            if (!hostThreadAlive) notifyService()
            return POLL_MS
        }

        if (tracked != null) {
            val due = healthCheckAt
            if (due != 0L) {
                if (now < due) return due - now
                healthCheckAt = 0L
                val since = readLogSince(context, healthLogMark)
                if (CodexRemotePolicy.logShowsReconnect(since)) {
                    Log.i(TAG, "network change: host reported it is available again")
                } else {
                    Log.i(TAG, "network change: no reconnect within ${CodexRemotePolicy.NETWORK_GRACE_MS}ms; restarting the host")
                    synchronized(lock) { consecutiveFailures = 0; nextAttemptAt = 0L }
                    stopTrackedHost(context, "network change")
                }
            }
            return POLL_MS
        }
        if (hostThreadAlive) return POLL_MS
        if (!online) return POLL_MS // wait for onAvailable; never spin while offline
        val at = synchronized(lock) { nextAttemptAt }
        if (now < at) return at - now
        spawnHost(context)
        return POLL_MS
    }

    private fun spawnHost(context: Context) {
        hostThreadAlive = true
        Thread({
            val startedAt = System.currentTimeMillis()
            var exitCode = 1
            try {
                HomeInitializer.initialize(context) // regenerates a stale ~/.bashrc after an update
                val libDir = LibExtractor.extractAll(context)
                val bashPath = LibExtractor.getBashPath(context)
                Log.i(TAG, "starting `shelly codex __host`")
                val result = ShellyJNI.execSubprocess(
                    "/system/bin/linker64",
                    bashPath,
                    libDir.absolutePath,
                    home(context).absolutePath,
                    HOST_COMMAND,
                    Int.MAX_VALUE,
                )
                exitCode = result.getOrNull(0)?.toIntOrNull() ?: 1
                val err = result.getOrNull(2).orEmpty().take(300)
                Log.i(TAG, "host exited code=$exitCode after ${System.currentTimeMillis() - startedAt}ms ${if (err.isNotBlank()) "stderr=$err" else ""}")
            } catch (e: Exception) {
                Log.e(TAG, "host launch failed", e)
            } finally {
                val ran = System.currentTimeMillis() - startedAt
                synchronized(lock) {
                    if (ran >= CodexRemotePolicy.HEALTHY_RUN_MS) consecutiveFailures = 0
                    else if (exitCode != CodexRemotePolicy.EXIT_ALREADY_RUNNING) consecutiveFailures++
                    nextAttemptAt = System.currentTimeMillis() +
                        CodexRemotePolicy.restartDelayMs(exitCode, consecutiveFailures)
                    hostThreadAlive = false
                    lock.notifyAll()
                }
                cleanupState(context)
                notifyService()
            }
        }, "ShellyCodexRemoteHost").apply { isDaemon = true; start() }
    }

    // ── Stop ────────────────────────────────────────────────────────────

    /** SIGTERM the tracked host's process tree, then SIGKILL survivors. */
    fun stopTrackedHost(context: Context, reason: String) {
        val host = trackedHost(context) ?: return
        Log.i(TAG, "stopping host pid=${host.pid} native=${host.nativeOwned} ($reason)")
        val pids = listOf(host.pid) + CodexRemotePolicy.descendants(host.pid, processParents())
        for (p in pids) runCatching { Process.sendSignal(p, 15) }
        var i = 0
        while (i < 10 && CodexRemotePolicy.procStartTime(readProcStat(host.pid)) == host.startTime) {
            Thread.sleep(300)
            i++
        }
        for (p in pids) runCatching { Process.sendSignal(p, Process.SIGNAL_KILL) }
        cleanupState(context)
        publishActive(context, false)
    }

    private fun processParents(): Map<Int, Int> {
        val out = HashMap<Int, Int>()
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            CodexRemotePolicy.procParentPid(readProcStat(pid))?.let { out[pid] = it }
        }
        return out
    }

    private fun cleanupState(context: Context) {
        if (trackedHost(context) != null) return
        val home = home(context)
        File(home, STATE_FILE).delete()
        File(home, "$STATE_FILE.sock").delete()
        File(home, BG_TMP).listFiles()?.filter { it.name.startsWith("codex-rc-") }?.forEach { it.deleteRecursively() }
    }

    // ── Network ─────────────────────────────────────────────────────────

    private fun registerNetworkCallback(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        online = cm.activeNetwork != null
        currentNetwork = cm.activeNetwork
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val changed = synchronized(lock) {
                        val wasOffline = !online
                        val switched = wasOffline || (currentNetwork != null && currentNetwork != network)
                        currentNetwork = network
                        online = true
                        if (wasOffline) { consecutiveFailures = 0; nextAttemptAt = 0L }
                        switched
                    }
                    if (changed) onNetworkChanged(context)
                    wake()
                }

                override fun onLost(network: Network) {
                    synchronized(lock) {
                        if (network == currentNetwork) {
                            online = cm.activeNetwork != null
                            currentNetwork = cm.activeNetwork
                        }
                    }
                    Log.i(TAG, "default network lost; online=$online")
                    wake()
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "network callback registration failed; network-change restarts disabled", e)
        }
    }

    private fun onNetworkChanged(context: Context) {
        if (trackedHost(context) == null) return
        synchronized(lock) {
            // Debounce: a burst of changes collapses into one check measured
            // from the latest change, against the log written since the first.
            if (healthCheckAt == 0L) healthLogMark = File(home(context), LOG_FILE).length()
            healthCheckAt = System.currentTimeMillis() + CodexRemotePolicy.NETWORK_GRACE_MS
        }
        Log.i(TAG, "default network changed; checking the host in ${CodexRemotePolicy.NETWORK_GRACE_MS}ms")
    }

    private fun readLogSince(context: Context, mark: Long): String {
        val f = File(home(context), LOG_FILE)
        return runCatching {
            RandomAccessFile(f, "r").use { raf ->
                val len = raf.length()
                // A restarted host truncates the log: read it all.
                val from = if (mark in 0..len) mark else 0L
                val n = (len - from).coerceAtMost(64 * 1024L).toInt()
                raf.seek(len - n)
                val buf = ByteArray(n)
                raf.readFully(buf)
                String(buf, Charsets.UTF_8)
            }
        }.getOrDefault("")
    }

    // ── Service notification ────────────────────────────────────────────

    private fun publishActive(context: Context, active: Boolean) {
        if (active == lastActive) return
        lastActive = active
        notifyService()
    }

    private fun notifyService() {
        TerminalSessionService.instance?.onCodexRemoteChanged()
    }
}
