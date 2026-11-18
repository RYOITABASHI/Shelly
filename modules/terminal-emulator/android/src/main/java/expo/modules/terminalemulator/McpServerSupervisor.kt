package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.security.SecureRandom

/**
 * Owns the MCP server process lifecycle (the node process MCPBridge spawns):
 * who wants it running, with which token / tool switches / bridge key, and
 * bringing it back when it dies while it is still wanted.
 *
 * Two ways a server becomes wanted:
 *  - In-app ([startFromApp]): hooks/use-mcp-server-bridge.ts on app start and
 *    on every settings change, exactly as before, with RN's own per-start
 *    bridge key. RN then verifies the queue requests that process signs.
 *  - Headless ([onServiceStart] with nothing wanted yet): boot /
 *    package-replaced (McpServerAutostartReceiver) or a START_STICKY restart
 *    of McpServerService after the app process died. Settings and token come
 *    from McpAutostartStore (the Keystore-encrypted mirror RN writes); the
 *    bridge key is generated here and never leaves this process (not logged,
 *    not exposed to JS, passed to node on stdin by MCPBridge). Requests the
 *    headless server queues can therefore not be verified by anyone until RN
 *    starts; that is intended: exec / write need RN's approval UI and simply
 *    wait (and time out) while Shelly is not open — unless the owner turned
 *    on "MCP: Run without approval" (McpSkipApprovalStore): with exec on, a
 *    McpRawToolConsumer (one per wanted server, bound to its bridge key and
 *    token, in both modes) drains `raw-requests/`, runs the call itself when
 *    that switch is on, and otherwise hands it to RN's requests/. Snapshot reads
 *    (list_agents / list_repos) and git_status are answered by the script
 *    itself and work headless. Typed ops (PR 6) do not wait for RN: with
 *    typed ops on, a McpTypedOpConsumer (one per wanted server, bound to its
 *    bridge key, in both modes) drains `typed-requests/`, runs a request an
 *    always-allow rule clears, hands a no-match to RN only while RN's bridge
 *    heartbeat is fresh, and refuses `not_attended` otherwise; get_run_result
 *    is read by the script itself.
 *
 * RN adoption = clean restart: when RN mounts it revokes pending queue
 * requests and calls startMCPServer with a fresh key (under
 * withMcpServerLock, unchanged); MCPBridge.start sees a different key and
 * restarts the process. No API ever returns a bridge key to JS.
 *
 * OFF wins: RN turning the setting off calls setMCPAutostartMirror(false),
 * which clears the mirror and calls [stop] (process stopped, nothing wanted,
 * service stopped). A headless restart re-reads the mirror first and gives
 * up when it is OFF/unreadable, so it can never resurrect a server the owner
 * turned off, nor run one with switches broader than the mirror says.
 *
 * Runtime: a headless start runs HomeInitializer.initialize (once per app
 * process; re-extracts ~/.shelly-mcp-server.js from the APK assets, so it is
 * fresh after an update) and LibExtractor.ensureExtracted (re-extracts node
 * when the APK identity changed) before MCPBridge.start, without RN — the
 * same native path CodexRemoteHost.spawnHost uses.
 *
 * Restart policy: a watchdog thread polls every [POLL_MS]; a dead process
 * that is still wanted is restarted with backoff ([MIN_BACKOFF_MS] doubling
 * to [MAX_BACKOFF_MS]), reset once a process has stayed up [HEALTHY_AFTER_MS].
 * A restart keeps the same token, switches and bridge key (an app-started
 * server stays verifiable by the RN that holds the key).
 *
 * Service ordering (Codex review 2026-11-15): every stopService request and
 * every startForegroundService that belongs to a state transition is issued
 * while holding [lock], in the same critical section as that transition
 * (the boot / update receiver's start is the one exception: it runs on the
 * main thread, and a late start is harmless because the service re-checks). Both are synchronous binder
 * calls to the ActivityManager, so the order AMS sees equals the order of
 * the transitions: a stop decided under an older state can no longer land
 * after a newer start and kill that start's service. (The service's own
 * stopSelf(startId) is already safe: AMS ignores it once a newer start was
 * requested.)
 *
 * Service destroyed while a server is still wanted (startForeground refused,
 * a stopSelf from an earlier start racing a start that could not request the
 * service, the system tearing it down): the design is "while wanted, the
 * foreground service is up, best effort" (an in-app server keeps running even
 * when the service cannot start), so the watchdog RESTORES it: it requests
 * the service again with the same backoff as process restarts. The server
 * itself is not stopped. If the system keeps refusing, the attempts settle
 * at one per [MAX_BACKOFF_MS] while wanted.
 */
object McpServerSupervisor {
    private const val TAG = "McpServerSupervisor"
    private const val POLL_MS = 5_000L
    private const val MIN_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 60_000L
    private const val HEALTHY_AFTER_MS = 60_000L

    /** Never logged: holds the token and the bridge key. */
    private class Desired(
        val token: String,
        val exec: Boolean,
        val readTerminal: Boolean,
        val diagnostics: Boolean,
        val typedOps: Boolean,
        val bridgeKey: String,
        val fromApp: Boolean,
    ) {
        override fun toString(): String = "Desired(exec=$exec, readTerminal=$readTerminal, diagnostics=$diagnostics, typedOps=$typedOps, fromApp=$fromApp)"
    }

    private val lock = Object()
    @Volatile private var desired: Desired? = null
    @Volatile private var watching = false
    @Volatile private var homeInitialized = false
    /**
     * Bumped (under [lock]) by every in-app start and every stop. A headless
     * start that began under an older generation is stale: it must not spawn
     * after the owner turned the server off or the app took over while it
     * was extracting the runtime (Codex review 2026-11-15).
     */
    private var generation = 0L
    private var failures = 0
    private var nextAttemptAt = 0L
    private var startedAt = 0L
    /** Set by McpServerService.onCreate / onDestroy (main thread, no lock: never block it on [lock]). */
    @Volatile private var serviceAlive = false
    /** Under [lock]: earliest time the watchdog may request the service again, and how often it did. */
    private var serviceRetryAt = 0L
    private var serviceRestores = 0
    /**
     * The one McpTypedOpConsumer (PR 6): exists exactly while a server with
     * typed ops is wanted, bound to that server's bridge key (app-started or
     * headless — the script routes run_agent to typed-requests/ either way and
     * RN never reads it). Replaced / stopped only under [lock]; read without
     * it (volatile) by the consumer's own epoch check, so the consumer never
     * takes [lock] and stopping it under [lock] cannot deadlock.
     */
    @Volatile private var typedOpConsumer: McpTypedOpConsumer? = null
    /**
     * The one McpRawToolConsumer: exists exactly while a server with exec on is
     * wanted, bound to that server's bridge key and token (the script routes
     * run_command / write_file to raw-requests/ in both modes and RN never
     * reads it). Same locking rules as [typedOpConsumer].
     */
    @Volatile private var rawToolConsumer: McpRawToolConsumer? = null

    /** For the notification text: (exec, readTerminal, diagnostics) of the wanted server, or null. */
    fun wantedSwitches(): Triple<Boolean, Boolean, Boolean>? =
        desired?.let { Triple(it.exec, it.readTerminal, it.diagnostics) }

    fun isWanted(): Boolean = desired != null

    /** The wanted server has typed ops on (McpTypedOpConsumer step 1, with the mirror). */
    fun typedOpsWanted(): Boolean = desired?.typedOps == true

    /** McpTypedOpConsumer's native epoch: [c] is still the live consumer. */
    fun isCurrentTypedOpConsumer(c: McpTypedOpConsumer): Boolean = typedOpConsumer === c

    /** McpRawToolConsumer's native epoch: [c] is still the live consumer. */
    fun isCurrentRawToolConsumer(c: McpRawToolConsumer): Boolean = rawToolConsumer === c

    /**
     * Running, or wanted and waiting for the watchdog to restart it. Token
     * regeneration (lib/mcp-token.ts) uses this as "was running": a wanted
     * but momentarily dead server must also be stopped and restarted with
     * the new token, or the watchdog would bring it back on the old one.
     */
    fun isRunningOrWanted(): Boolean = desired != null || MCPBridge.isRunning()

    // ── Entry points ────────────────────────────────────────────────────

    /** In-app start (TerminalEmulatorModule.startMCPServer). Same contract as MCPBridge.start. */
    fun startFromApp(context: Context, token: String, exec: Boolean, readTerminal: Boolean, diagnostics: Boolean, typedOps: Boolean, bridgeKey: String): Boolean {
        val app = context.applicationContext
        val ok = synchronized(lock) {
            generation += 1
            // A new bridge key is the native queueEpoch: the old consumer stops
            // (waiting for its request in progress) and its pending typed
            // requests are cleared before the new server can write any.
            retireStaleTypedOpConsumerLocked(bridgeKey, typedOps)
            retireStaleRawToolConsumerLocked(bridgeKey, token, exec)
            val started = MCPBridge.start(app, token, exec, readTerminal, diagnostics, typedOps, bridgeKey)
            // Nothing wanted => nothing running: MCPBridge.start can refuse
            // (bad key / blank token) before touching an older process.
            if (!started) MCPBridge.stop()
            desired = if (started) Desired(token, exec, readTerminal, diagnostics, typedOps, bridgeKey, fromApp = true) else null
            resetBackoff()
            if (started) {
                startedAt = System.currentTimeMillis()
                startServiceLocked(app, "app start")
            } else {
                stopServiceLocked(app)
            }
            syncTypedOpConsumerLocked(app)
            syncRawToolConsumerLocked(app)
            lock.notifyAll()
            started
        }
        if (ok) ensureWatching(app)
        return ok
    }

    /** In-app stop, or the setting turned OFF. Nothing is wanted afterwards. */
    fun stop(context: Context, reason: String) {
        val app = context.applicationContext
        synchronized(lock) {
            generation += 1
            desired = null
            resetBackoff()
            MCPBridge.stop()
            // Server stop / token revoke: consumer stopped, pending typed requests cleared.
            syncTypedOpConsumerLocked(app)
            syncRawToolConsumerLocked(app)
            stopServiceLocked(app)
            lock.notifyAll()
        }
        Log.i(TAG, "stopped ($reason)")
    }

    /**
     * Boot / package replaced. Only asks for the service when the mirror says
     * ON; the service re-checks everything before starting anything.
     */
    fun requestAutostart(context: Context, reason: String) {
        val app = context.applicationContext
        if (!McpAutostartStore.isOn(app)) {
            Log.i(TAG, "$reason: MCP server auto-start not wanted (setting off or mirror unreadable)")
            return
        }
        Log.i(TAG, "$reason: starting the MCP server foreground service")
        // Not under [lock]: this runs in BroadcastReceiver.onReceive on the
        // main thread, and the lock can be held while node starts / stops.
        // Only stops can be stale in a harmful way; a late start just makes
        // the service re-check everything (onServiceStart) and stop itself.
        sendStartIntent(app, reason)
    }

    /** McpServerService.onCreate (main thread). */
    fun onServiceCreated() {
        serviceAlive = true
    }

    /**
     * McpServerService.onDestroy (main thread; must not wait for [lock],
     * which can be held while node is spawned or stopped). The watchdog
     * restores the service if a server is still wanted (see the class doc).
     */
    fun onServiceDestroyed() {
        serviceAlive = false
        if (desired != null) Log.i(TAG, "MCP foreground service destroyed while the server is wanted; the watchdog restores it")
    }

    /**
     * McpServerService.onStartCommand (worker thread). Returns whether a
     * server is wanted (the service stops itself when not).
     */
    fun onServiceStart(context: Context, reason: String): Boolean {
        val app = context.applicationContext
        ensureWatching(app)
        val startGeneration = synchronized(lock) {
            if (desired != null) {
                // Already wanted (app start, or an earlier headless start);
                // the watchdog handles a dead process.
                lock.notifyAll()
                return true
            }
            generation
        }
        if (!McpAutostartStore.isOn(app)) {
            Log.i(TAG, "$reason: not starting (setting off or mirror unreadable)")
            return false
        }
        // Slow (may extract the runtime): done outside the lock, so the
        // result is re-validated below.
        runCatching { ensureRuntime(app) }
            .onFailure { Log.w(TAG, "$reason: runtime extraction failed (${it.javaClass.simpleName}); will retry", it) }
        synchronized(lock) {
            if (desired != null) { lock.notifyAll(); return true } // the app won the race
            if (generation != startGeneration) {
                // Stopped (or started and stopped by the app) meanwhile.
                Log.i(TAG, "$reason: headless start superseded; not starting")
                return false
            }
            // Re-read under the lock: RN clears the mirror BEFORE it calls
            // stop(), so a cleared mirror is seen here, and a mirror still ON
            // here is followed by stop() (which takes this lock) killing it.
            val cfg = McpAutostartStore.read(app)
            if (cfg == null) {
                Log.i(TAG, "$reason: not starting (setting off or mirror unreadable)")
                return false
            }
            val key = newBridgeKey()
            retireStaleTypedOpConsumerLocked(key, cfg.typedOps)
            retireStaleRawToolConsumerLocked(key, cfg.token, cfg.exec)
            val ok = MCPBridge.start(app, cfg.token, cfg.exec, cfg.readTerminal, cfg.diagnostics, cfg.typedOps, key)
            // Wanted even if this attempt failed: the watchdog retries with backoff.
            desired = Desired(cfg.token, cfg.exec, cfg.readTerminal, cfg.diagnostics, cfg.typedOps, key, fromApp = false)
            syncTypedOpConsumerLocked(app)
            syncRawToolConsumerLocked(app)
            resetBackoff()
            if (ok) {
                startedAt = System.currentTimeMillis()
            } else {
                failures = 1
                nextAttemptAt = System.currentTimeMillis() + MIN_BACKOFF_MS
            }
            Log.i(TAG, "$reason: headless start ok=$ok exec=${cfg.exec} readTerminal=${cfg.readTerminal} diagnostics=${cfg.diagnostics} typedOps=${cfg.typedOps}")
            lock.notifyAll()
        }
        return true
    }

    // ── Watchdog ────────────────────────────────────────────────────────

    private fun ensureWatching(app: Context) {
        synchronized(lock) {
            if (watching) { lock.notifyAll(); return }
            watching = true
        }
        Thread({ loop(app) }, "ShellyMcpSupervisor").apply { isDaemon = true; start() }
        Log.i(TAG, "watchdog started")
    }

    private fun loop(app: Context) {
        while (true) {
            var waitMs = POLL_MS
            try {
                waitMs = reconcile(app).coerceIn(250L, POLL_MS)
            } catch (e: Exception) {
                Log.w(TAG, "reconcile failed", e)
            }
            synchronized(lock) { runCatching { lock.wait(waitMs) } }
        }
    }

    /** Returns how long to wait before the next pass. */
    private fun reconcile(app: Context): Long {
        return synchronized(lock) {
            val d = desired ?: return POLL_MS
            val now = System.currentTimeMillis()
            restoreServiceIfNeededLocked(app, now)
            if (MCPBridge.isRunning()) {
                if (failures > 0 && now - startedAt >= HEALTHY_AFTER_MS) resetBackoff()
                return POLL_MS
            }
            if (now < nextAttemptAt) return nextAttemptAt - now

            var use = d
            if (!d.fromApp) {
                // Headless: the mirror must still say ON, and its settings win.
                val cfg = McpAutostartStore.read(app)
                if (cfg == null) {
                    // Same critical section as clearing `desired`: no newer
                    // start can slip in before this stop request (finding 5).
                    generation += 1
                    desired = null
                    resetBackoff()
                    stopServiceLocked(app)
                    syncTypedOpConsumerLocked(app)
                    syncRawToolConsumerLocked(app)
                    Log.i(TAG, "MCP server died and the mirror is OFF/unreadable; not restarting")
                    return POLL_MS
                }
                use = Desired(cfg.token, cfg.exec, cfg.readTerminal, cfg.diagnostics, cfg.typedOps, d.bridgeKey, fromApp = false)
                desired = use
                // The mirror's typed-ops switch may have changed (same key).
                syncTypedOpConsumerLocked(app)
                syncRawToolConsumerLocked(app)
            }
            runCatching { ensureRuntime(app) }
                .onFailure { Log.w(TAG, "runtime extraction before restart failed (${it.javaClass.simpleName})") }
            val ok = MCPBridge.start(app, use.token, use.exec, use.readTerminal, use.diagnostics, use.typedOps, use.bridgeKey)
            if (ok) startedAt = now
            failures += 1
            nextAttemptAt = now + backoffMs(failures)
            Log.i(TAG, "MCP server was not running; restart ok=$ok attempt=$failures fromApp=${use.fromApp}")
            return POLL_MS
        }
    }

    /** Under [lock], with a server wanted: re-request a destroyed foreground service, with backoff. */
    private fun restoreServiceIfNeededLocked(app: Context, now: Long) {
        if (serviceAlive || now < serviceRetryAt) return
        serviceRestores += 1
        Log.i(TAG, "MCP foreground service is not running while the server is wanted; restoring (attempt=$serviceRestores)")
        startServiceLocked(app, "restore")
        serviceRetryAt = now + backoffMs(serviceRestores)
    }

    private fun resetBackoff() {
        failures = 0
        nextAttemptAt = 0L
    }

    internal fun backoffMs(failures: Int): Long {
        if (failures <= 0) return 0L
        val shift = (failures - 1).coerceAtMost(10)
        return (MIN_BACKOFF_MS shl shift).coerceAtMost(MAX_BACKOFF_MS)
    }

    // ── Typed-op consumer (PR 6) ────────────────────────────────────────

    /**
     * Under [lock]: before a server with [newKey] starts, stop a consumer bound
     * to another key (or any consumer when typed ops will be off) and clear
     * the pending typed requests.
     */
    private fun retireStaleTypedOpConsumerLocked(newKey: String, typedOps: Boolean) {
        val c = typedOpConsumer ?: return
        if (typedOps && c.hasKey(newKey)) return
        typedOpConsumer = null
        c.stop(clearPending = true)
    }

    /**
     * Under [lock]: exactly one consumer while a server with typed ops is
     * wanted (bound to its key), none otherwise. A consumer that goes away
     * clears the pending typed requests (they were signed for a server that
     * is no longer wanted, or with a key that is no longer valid).
     */
    private fun syncTypedOpConsumerLocked(app: Context) {
        val d = desired
        val current = typedOpConsumer
        if (d != null && d.typedOps && current != null && current.hasKey(d.bridgeKey)) return
        if (current != null) {
            typedOpConsumer = null
            current.stop(clearPending = true)
        }
        if (d != null && d.typedOps) {
            val c = McpTypedOpConsumer(app, d.bridgeKey)
            typedOpConsumer = c
            c.start()
        }
    }

    // ── Raw-tool consumer ("MCP: Run without approval") ─────────────────

    /** Under [lock]: before a server with [newKey] / [token] starts, stop a consumer bound to another. */
    private fun retireStaleRawToolConsumerLocked(newKey: String, token: String, exec: Boolean) {
        val c = rawToolConsumer ?: return
        if (exec && c.hasKey(newKey, token)) return
        rawToolConsumer = null
        c.stop(clearPending = true)
    }

    /** Under [lock]: exactly one raw consumer while a server with exec is wanted, none otherwise. */
    private fun syncRawToolConsumerLocked(app: Context) {
        val d = desired
        val current = rawToolConsumer
        if (d != null && d.exec && current != null && current.hasKey(d.bridgeKey, d.token)) return
        if (current != null) {
            rawToolConsumer = null
            current.stop(clearPending = true)
        }
        if (d != null && d.exec) {
            val c = McpRawToolConsumer(app, d.bridgeKey, d.token)
            rawToolConsumer = c
            c.start()
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /** The extracted runtime is current for this APK (see the class doc). */
    private fun ensureRuntime(app: Context) {
        if (!homeInitialized) {
            HomeInitializer.initialize(app)
            homeInitialized = true
        }
        LibExtractor.ensureExtracted(app)
    }

    private fun newBridgeKey(): String {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }.also { bytes.fill(0) }
    }

    /** Hold [lock] (see "Service ordering" in the class doc). */
    private fun startServiceLocked(app: Context, reason: String) {
        // Give the requested service time to reach onCreate before the
        // watchdog considers restoring it.
        serviceRetryAt = System.currentTimeMillis() + MIN_BACKOFF_MS
        if (reason != "restore") serviceRestores = 0
        sendStartIntent(app, reason)
    }

    private fun sendStartIntent(app: Context, reason: String) {
        val intent = Intent(app, McpServerService::class.java).apply {
            action = McpServerService.ACTION_START
            putExtra(McpServerService.EXTRA_REASON, reason)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
        } catch (e: Exception) {
            // e.g. ForegroundServiceStartNotAllowedException (API 31+) outside
            // an exemption. An in-app server keeps running in-process; it is
            // just not protected by a foreground service.
            Log.w(TAG, "$reason: could not start the MCP foreground service (${e.javaClass.simpleName})")
        }
    }

    /** Hold [lock] (see "Service ordering" in the class doc). */
    private fun stopServiceLocked(app: Context) {
        runCatching { app.stopService(Intent(app, McpServerService::class.java)) }
            .onFailure { Log.w(TAG, "could not stop the MCP foreground service", it) }
    }
}
