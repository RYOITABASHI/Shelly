package expo.modules.terminalemulator

import android.app.NotificationManager
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
 * Control state:
 *   CodexRemoteAutostart (prefs + Keystore HMAC)  the ON switch; set ON only
 *                                          by the in-app Settings toggle
 *   $HOME/.shelly/codex-remote-autostart-off-request
 *                                          `shelly codex autostart off`
 *   $HOME/.shelly/codex-remote-autostart   mirror for `shelly codex status`
 *                                          (written here, never read here)
 *   $HOME/.shelly/agents/.halted           STOP-ALL (latched + turns ON off)
 *   $HOME/tmp/shelly-codex-remote.stopped  `shelly codex stop` / notification
 *                                          Exit; cleared only when the user
 *                                          opens Shelly ([onUserAppLaunch])
 *   $HOME/tmp/shelly-codex-remote.host     "<pid> <starttime> [native]" -- the
 *                                          shim's single-instance state file
 *   $HOME/tmp/shelly-codex-remote.log      host output (health signal)
 *
 * The host only runs while the foreground service is in the foreground and
 * notifications are enabled, so the "ChatGPT can run commands on this phone"
 * notification is always visible while it runs.
 *
 * Network: a default-network callback keeps an online flag (no start
 * attempts while offline). After the default network changes or comes back,
 * the host gets [CodexRemotePolicy.NETWORK_GRACE_MS]; it is restarted only if
 * its log then shows an explicit disconnect and no later available/connected
 * line. The lines seen are logged so the patterns can be tuned on device.
 */
object CodexRemoteHost {
    private const val TAG = "CodexRemoteHost"
    const val AUTOSTART_MIRROR_FILE = ".shelly/codex-remote-autostart"
    const val OFF_REQUEST_FILE = ".shelly/codex-remote-autostart-off-request"
    const val HALT_SENTINEL = ".shelly/agents/.halted"
    const val STATE_FILE = "tmp/shelly-codex-remote.host"
    const val STOPPED_FILE = "tmp/shelly-codex-remote.stopped"
    const val LOG_FILE = "tmp/shelly-codex-remote.log"
    private const val SUPERVISOR_LOG_FILE = "tmp/shelly-codex-remote.supervisor.log"
    private const val BG_TMP = "tmp/shelly-codex-bg"
    private const val POLL_MS = 5_000L

    // `shelly codex __host` runs in a non-interactive bash that sources the
    // generated ~/.bashrc (as Codex's own `bash -lc` and AgentRuntime do),
    // matching the interactive PTY shell the shim normally runs in: that
    // shell is spawned WITHOUT LD_PRELOAD (bashrc v180), so spawnHost() must
    // not set it either -- see the env below. `unset LD_PRELOAD` here only
    // clears the variable; it cannot unmap a wrapper that was preloaded into
    // this bash, and a wrapper-loaded bash exec'ing codex_tui lost the
    // wrapper's LD_PRELOAD on the way (exec-wrapper v226), which is how
    // build 2603's host died with "No such file or directory" at
    // fs::canonicalize("/data/data/com.termux"). Output goes to a file, so
    // the supervisor never waits on a pipe; host death is seen via
    // waitFor()/pid.
    internal const val HOST_COMMAND =
        "exec >\"\$HOME/$SUPERVISOR_LOG_FILE\" 2>&1 </dev/null\n" +
            "{ [ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\"; } >/dev/null 2>&1 </dev/null\n" +
            "unset LD_PRELOAD\n" +
            "type __shelly_codex_remote >/dev/null 2>&1 || exit 127\n" +
            "__shelly_codex_remote __host\n"

    private val lock = Object()
    @Volatile private var started = false
    @Volatile private var hostThreadAlive = false
    @Volatile private var online = true
    @Volatile private var lastActive = false
    @Volatile private var haltLatched = false
    @Volatile private var hostProcess: java.lang.Process? = null
    @Volatile private var hostPid = 0
    @Volatile private var hostStart: String? = null
    /** pid -> starttime of the host and every descendant seen while it ran. */
    private val recordedTree = HashMap<Int, String>()
    private var currentNetwork: Network? = null
    private var consecutiveFailures = 0
    private var nextAttemptAt = 0L
    private var healthCheckAt = 0L
    private var healthLogMark = 0L
    private var lastMirror: Boolean? = null

    // ── Inputs ──────────────────────────────────────────────────────────

    private fun home(context: Context): File = HomeInitializer.getHomeDir(context)

    private fun haltSentinelPresent(context: Context): Boolean =
        // Fail closed: if the STOP-ALL sentinel cannot be checked, treat as halted.
        runCatching { File(home(context), HALT_SENTINEL).exists() }.getOrDefault(true)

    /**
     * The warning notification can actually be shown: app notifications on
     * AND the foreground-service channel not blocked by the user.
     */
    private fun notificationsEnabled(context: Context): Boolean = runCatching {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return@runCatching false
        if (!nm.areNotificationsEnabled()) return@runCatching false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = nm.getNotificationChannel(TerminalSessionService.CHANNEL_ID)
            // Not created yet = the service will create it at default importance.
            channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
        } else {
            true
        }
    }.getOrDefault(false)

    fun readInputs(context: Context): CodexRemotePolicy.Inputs = CodexRemotePolicy.Inputs(
        autostartOn = CodexRemoteAutostart.isOn(context),
        halted = haltLatched || haltSentinelPresent(context),
        stopRequested = File(home(context), STOPPED_FILE).exists(),
        serviceForeground = TerminalSessionService.instance?.isForegroundNow == true,
        notificationsEnabled = notificationsEnabled(context),
    )

    /** TerminalSessionService keeps itself foreground while this is true. */
    fun keepsServiceAlive(context: Context): Boolean =
        hostThreadAlive || runCatching { CodexRemotePolicy.wanted(readInputs(context)) }.getOrDefault(false)

    /** A tracked host (native or `pair --background`) is alive. Drives the notification text. */
    fun isHostActive(): Boolean = lastActive

    fun trackedHost(context: Context): CodexRemotePolicy.HostState? {
        // Prefer the pid of the process we spawned over the shell-written file.
        val pid = hostPid
        val start = hostStart
        if (pid > 1 && start != null && startOf(pid) == start) {
            return CodexRemotePolicy.HostState(pid, start, nativeOwned = true)
        }
        val state = CodexRemotePolicy.parseState(runCatching { File(home(context), STATE_FILE).readText() }.getOrNull())
            ?: return null
        if (state.pid == Process.myPid()) return null
        return if (startOf(state.pid) == state.startTime) state else null
    }

    private fun readProcFile(pid: Int, name: String): String? =
        runCatching { File("/proc/$pid/$name").readText() }.getOrNull()

    private fun startOf(pid: Int): String? = CodexRemotePolicy.procStartTime(readProcFile(pid, "stat"))

    // ── Lifecycle ───────────────────────────────────────────────────────

    /** Starts the supervisor thread once per process (TerminalSessionService.onCreate). */
    fun ensureWatching(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            if (started) { lock.notifyAll(); return }
            started = true
        }
        registerNetworkCallback(app)
        Thread({ loop(app) }, "ShellyCodexRemote").apply { isDaemon = true; start() }
        Log.i(TAG, "supervisor started")
    }

    fun wake() = synchronized(lock) { lock.notifyAll() }

    /**
     * The user opened Shelly (Expo Module OnCreate): forget `shelly codex stop`
     * and bring the service up if the host is wanted. A START_STICKY / LMK
     * restart or a boot/update broadcast does NOT clear the stop marker.
     */
    fun onUserAppLaunch(context: Context) {
        runCatching { File(home(context), STOPPED_FILE).delete() }
        requestStartIfWanted(context, "app launch")
    }

    /** App start / boot / package replaced: bring the foreground service up if wanted. */
    fun requestStartIfWanted(context: Context, reason: String) {
        val app = context.applicationContext
        if (haltSentinelPresent(app)) {
            // STOP-ALL survived a restart: make the switch OFF for good, so a
            // later resume of agents does not silently bring the host back.
            haltLatched = true
            if (CodexRemoteAutostart.isOn(app)) CodexRemoteAutostart.setOff(app, "STOP-ALL at start")
            writeMirror(app, false)
        }
        val i = readInputs(app)
        if (!CodexRemotePolicy.wanted(i)) {
            Log.i(TAG, "$reason: not wanted (on=${i.autostartOn} halted=${i.halted} stopped=${i.stopRequested})")
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

    /**
     * The Settings toggle (RN only). ON is refused while STOP-ALL is active;
     * an ON here is also the explicit in-app resume that clears the latch.
     */
    fun setAutostartFromApp(context: Context, enabled: Boolean): Map<String, Any> {
        if (enabled) {
            if (haltSentinelPresent(context)) {
                Log.i(TAG, "setAutostartFromApp(on) refused: STOP-ALL is active")
                return status(context)
            }
            haltLatched = false
            CodexRemoteAutostart.setOn(context)
            File(home(context), OFF_REQUEST_FILE).delete()
            File(home(context), STOPPED_FILE).delete()
            writeMirror(context, true)
            requestStartIfWanted(context, "settings on")
        } else {
            turnOff(context, "settings off", sweepStragglers = false)
        }
        wake()
        return status(context)
    }

    /** Notification "Disconnect": OFF + stop every same-uid remote-control process. */
    fun disconnect(context: Context) {
        turnOff(context, "notification disconnect", sweepStragglers = true)
        wake()
    }

    /** Notification "Exit": like `shelly codex stop` (back when the user next opens Shelly). */
    fun stopUntilNextStart(context: Context) {
        val stopped = File(home(context), STOPPED_FILE)
        runCatching { stopped.parentFile?.mkdirs(); stopped.writeText("") }
        stopHost(context, "exit", nativeOnly = false)
        wake()
    }

    private fun turnOff(context: Context, reason: String, sweepStragglers: Boolean) {
        CodexRemoteAutostart.setOff(context, reason)
        writeMirror(context, false)
        stopHost(context, reason, nativeOnly = false)
        if (sweepStragglers) killRemoteControlStragglers(reason)
    }

    fun status(context: Context): Map<String, Any> {
        val i = readInputs(context)
        return mapOf(
            "enabled" to i.autostartOn,
            "halted" to i.halted,
            "running" to (trackedHost(context) != null),
            "online" to online,
            "notificationsEnabled" to i.notificationsEnabled,
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
        val home = home(context)

        // STOP-ALL: latch for this process and turn the persistent switch off,
        // so only an in-app re-enable can bring it back.
        if (haltSentinelPresent(context) && !haltLatched) {
            haltLatched = CodexRemotePolicy.latchHalt(haltLatched, true)
            Log.i(TAG, "STOP-ALL observed: latching and turning Keep ChatGPT connected off")
            turnOff(context, "STOP-ALL", sweepStragglers = true)
        }
        // `shelly codex autostart off` (any same-uid process may ask for OFF).
        val offRequest = File(home, OFF_REQUEST_FILE)
        if (offRequest.exists()) {
            offRequest.delete()
            turnOff(context, "shell off request", sweepStragglers = false)
        }

        val inputs = readInputs(context)
        writeMirror(context, inputs.autostartOn)
        val tracked = trackedHost(context)
        publishActive(tracked != null)
        if (tracked != null && tracked.nativeOwned) recordTree(tracked.pid)

        if (!CodexRemotePolicy.mayRun(inputs)) {
            healthCheckAt = 0L
            if (tracked != null && CodexRemotePolicy.shouldStopUnwanted(inputs, tracked.nativeOwned)) {
                Log.i(TAG, "host may not run (on=${inputs.autostartOn} halted=${inputs.halted} stopped=${inputs.stopRequested} fg=${inputs.serviceForeground} notif=${inputs.notificationsEnabled})")
                stopHost(context, "may not run", nativeOnly = !inputs.halted)
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
                val verdict = CodexRemotePolicy.networkVerdict(since)
                Log.i(TAG, "network check verdict=$verdict lines=${CodexRemotePolicy.interestingLines(since)}")
                if (verdict == CodexRemotePolicy.NetworkVerdict.DISCONNECTED) {
                    synchronized(lock) { consecutiveFailures = 0; nextAttemptAt = 0L }
                    stopHost(context, "network change", nativeOnly = false)
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
                val home = home(context)
                File(home, "tmp").mkdirs()
                val lib = libDir.absolutePath
                // Same envp as shelly-exec.c's execSubprocess, MINUS
                // LD_PRELOAD: the host bash must not carry libexec_wrapper.so,
                // exactly like the interactive PTY shell (see HOST_COMMAND).
                // The codex() function adds the preload to the codex_tui
                // launch itself; a bash that already has the wrapper mapped
                // would see that exec go through the wrapper's codex-child
                // scrub and start Codex without it (build 2603 regression).
                val pb = ProcessBuilder("/system/bin/linker64", bashPath, "-c", HOST_COMMAND)
                pb.directory(home)
                pb.redirectErrorStream(true)
                pb.environment().apply {
                    clear()
                    put("PATH", "$lib:$lib/node_modules/npm/bin:$lib/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin")
                    put("HOME", home.absolutePath)
                    put("TERM", "dumb")
                    put("LANG", "en_US.UTF-8")
                    put("LD_LIBRARY_PATH", lib)
                    put("SHELL", bashPath)
                    put("TERMINFO", "$lib/terminfo")
                }
                // Re-check right before the spawn: the gates may have changed.
                if (!CodexRemotePolicy.mayRun(readInputs(context)) || !online) {
                    Log.i(TAG, "spawn skipped: no longer allowed")
                    exitCode = 0
                    return@Thread
                }
                Log.i(TAG, "starting `shelly codex __host`")
                val proc = pb.start()
                runCatching { proc.outputStream.close() }
                Thread({ runCatching { proc.inputStream.use { s -> val b = ByteArray(4096); while (s.read(b) >= 0) Unit } } },
                    "ShellyCodexRemoteDrain").apply { isDaemon = true; start() }
                val pid = pidOf(proc)
                val start = pid?.let { startOf(it) }
                synchronized(lock) {
                    hostProcess = proc
                    hostPid = pid ?: 0
                    hostStart = start
                    recordedTree.clear()
                    if (pid != null && start != null) recordedTree[pid] = start
                }
                publishActive(pid != null && start != null)
                exitCode = proc.waitFor()
                Log.i(TAG, "host exited code=$exitCode after ${System.currentTimeMillis() - startedAt}ms")
            } catch (e: Exception) {
                Log.e(TAG, "host launch failed", e)
            } finally {
                // Anything the host left behind (recorded with its start time).
                killRecorded("host exited")
                val ran = System.currentTimeMillis() - startedAt
                synchronized(lock) {
                    hostProcess = null
                    hostPid = 0
                    hostStart = null
                    if (ran >= CodexRemotePolicy.HEALTHY_RUN_MS) consecutiveFailures = 0 else consecutiveFailures++
                    nextAttemptAt = System.currentTimeMillis() +
                        CodexRemotePolicy.restartDelayMs(exitCode, consecutiveFailures)
                    hostThreadAlive = false
                    lock.notifyAll()
                }
                cleanupState(context)
                publishActive(trackedHost(context) != null)
                notifyService()
            }
        }, "ShellyCodexRemoteHost").apply { isDaemon = true; start() }
    }

    /** java.lang.Process has no public pid() before API 33; libcore's UNIXProcess keeps it in "pid". */
    private fun pidOf(proc: java.lang.Process): Int? {
        val valid: (Int?) -> Int? = { p -> p?.takeIf { it > 1 && it != Process.myPid() } }
        if (Build.VERSION.SDK_INT >= 33) {
            val p = valid(runCatching { proc.javaClass.getMethod("pid").invoke(proc).toString().toInt() }.getOrNull())
            if (p != null) return p
        }
        val p = valid(runCatching {
            val f = proc.javaClass.getDeclaredField("pid")
            f.isAccessible = true
            f.getInt(proc)
        }.getOrNull())
        if (p == null) Log.w(TAG, "could not read the host pid from ${proc.javaClass.name}; falling back to the state file")
        return p
    }

    // ── Stop ────────────────────────────────────────────────────────────

    private fun recordTree(root: Int) {
        val parents = processParents()
        val found = HashMap<Int, String>()
        for (p in CodexRemotePolicy.descendants(root, parents)) startOf(p)?.let { found[p] = it }
        synchronized(lock) { recordedTree.putAll(found) }
    }

    /**
     * SIGTERM the tracked host and its recorded/current descendants, then
     * SIGKILL survivors after re-verifying each (pid, starttime). Never
     * signals this app process. [nativeOnly] leaves a hand-started host alone.
     */
    fun stopHost(context: Context, reason: String, nativeOnly: Boolean) {
        val host = trackedHost(context) ?: return
        if (nativeOnly && !host.nativeOwned) return
        Log.i(TAG, "stopping host pid=${host.pid} native=${host.nativeOwned} ($reason)")
        val targets = HashMap<Int, String>()
        targets[host.pid] = host.startTime
        for (p in CodexRemotePolicy.descendants(host.pid, processParents())) startOf(p)?.let { targets[p] = it }
        if (host.nativeOwned) synchronized(lock) { targets.putAll(recordedTree) }
        signalVerified(targets, 15)
        var i = 0
        while (i < 10 && startOf(host.pid) == host.startTime) { Thread.sleep(300); i++ }
        signalVerified(targets, Process.SIGNAL_KILL)
        cleanupState(context)
        publishActive(false)
        notifyService()
    }

    private fun killRecorded(reason: String) {
        val targets = synchronized(lock) { HashMap(recordedTree).also { recordedTree.clear() } }
        if (targets.isEmpty()) return
        val alive = CodexRemotePolicy.signalable(targets, { p -> startOf(p) }, Process.myPid())
        if (alive.isEmpty()) return
        Log.i(TAG, "cleaning up ${alive.size} leftover host process(es) ($reason)")
        signalVerified(targets, 15)
        Thread.sleep(500)
        signalVerified(targets, Process.SIGNAL_KILL)
    }

    private fun signalVerified(targets: Map<Int, String>, signal: Int) {
        for (pid in CodexRemotePolicy.signalable(targets, { p -> startOf(p) }, Process.myPid())) {
            runCatching { Process.sendSignal(pid, signal) }
        }
    }

    /**
     * Disconnect / STOP-ALL: any same-uid process whose argv has
     * `remote-control` (a host started some other way, or orphaned).
     */
    fun killRemoteControlStragglers(reason: String) {
        val myUid = Process.myUid()
        val targets = HashMap<Int, String>()
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            if (pid == Process.myPid() || pid <= 1) return@forEach
            if (CodexRemotePolicy.procUid(readProcFile(pid, "status")) != myUid) return@forEach
            if (!CodexRemotePolicy.isRemoteControlCmdline(readProcFile(pid, "cmdline"))) return@forEach
            startOf(pid)?.let { targets[pid] = it }
        }
        if (targets.isEmpty()) return
        Log.i(TAG, "stopping ${targets.size} remote-control process(es) ($reason)")
        signalVerified(targets, 15)
        Thread.sleep(500)
        signalVerified(targets, Process.SIGNAL_KILL)
    }

    private fun processParents(): Map<Int, Int> {
        val out = HashMap<Int, Int>()
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            CodexRemotePolicy.procParentPid(readProcFile(pid, "stat"))?.let { out[pid] = it }
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

    private fun writeMirror(context: Context, on: Boolean) {
        if (lastMirror == on) return
        lastMirror = on
        runCatching {
            val f = File(home(context), AUTOSTART_MIRROR_FILE)
            f.parentFile?.mkdirs()
            f.writeText(if (on) "on\n" else "off\n")
        }
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
            Log.w(TAG, "network callback registration failed; network-change checks disabled", e)
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

    private fun publishActive(active: Boolean) {
        if (active == lastActive) return
        lastActive = active
        notifyService()
    }

    private fun notifyService() {
        TerminalSessionService.instance?.onCodexRemoteChanged()
    }
}
