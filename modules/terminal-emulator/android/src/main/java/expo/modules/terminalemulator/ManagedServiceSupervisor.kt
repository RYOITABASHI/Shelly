package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File

/**
 * Native supervisor for the long-running services in ManagedServices.REGISTRY
 * (MCP op `service_control`, P1 batch S1). Same shape as CodexRemoteHost: the
 * process is spawned by this app process (ProcessBuilder + linker64 bash),
 * never by the MCP server's node process, and lives under
 * TerminalSessionService, which stays in the foreground while any service
 * runs ([keepsServiceAlive]).
 *
 * S1 scope: start / stop / status on request. Not here (stage S2): bringing a
 * service back after the app process dies, an app update or a reboot, and
 * restarting a supervised process that exits by itself. A process that exits
 * by itself is recorded (`state.json` exitedAt / exitCode, never stoppedAt),
 * so `status` reports it as `dead` rather than `stopped`.
 *
 * Files (all under `<home>/.shelly/services/<id>/`, written only here):
 *   state.json   ManagedServices.Record of the last start / exit / stop
 *   output.log   the service's stdout+stderr (rotated to output.log.1 at 1 MiB on start)
 *
 * Identity: a pid is only ever signalled after re-reading its /proc starttime
 * (and, for a process this supervisor did not spawn, its cmdline), so a reused
 * pid or a forged state.json / heartbeat cannot point a stop at another
 * process. Never signals this app process.
 *
 * STOP-ALL: a start is refused while `.shelly/agents/.halted` is present (or
 * cannot be checked); while any service runs, a watcher stops them all when it
 * appears.
 *
 * Audit: every start / stop outcome is written natively
 * (IngressAuditWriter.appendServiceControlLine, kind `mcp_service_control`).
 */
object ManagedServiceSupervisor {
    private const val TAG = "ManagedServiceSupervisor"
    private const val HALT_POLL_MS = 5_000L
    /** A start that dies within this is reported `launch_failed`. */
    private const val LAUNCH_SETTLE_MS = 1_500L
    private const val STOP_GRACE_MS = 5_000L

    /**
     * [spec]: the exact Spec this process was launched from. While it is alive,
     * resolvedSpec answers with it instead of re-reading the on-device launch
     * spec, so a stop / STOP-ALL can never lose the process to a launch-spec
     * file that was deleted, broken or edited after the start.
     */
    private class Running(
        val id: String, val proc: java.lang.Process, val pid: Int, val startTime: String, val startedAt: Long,
        val spec: ManagedServices.Spec,
    ) {
        @Volatile var stopping = false
    }

    private val lock = Object()
    /** Serializes control calls (a stop waits up to [STOP_GRACE_MS]). */
    private val controlLock = Object()
    private val running = HashMap<String, Running>()
    @Volatile private var haltWatcher: Thread? = null

    fun keepsServiceAlive(): Boolean = synchronized(lock) { running.isNotEmpty() }

    private fun home(context: Context): File = HomeInitializer.getHomeDir(context)

    // ── Entry point (TerminalEmulatorModule.serviceControl) ────────────────

    /**
     * [principal]: the MCP client (32 hex) for the audit line, or null.
     * Returns the fields lib/mcp-service-control.ts parseServiceControlResult reads.
     */
    fun control(context: Context, action: String, serviceId: String, principal: String?): Map<String, Any?> {
        val base = ManagedServices.spec(serviceId)
        if (base == null || action !in ManagedServices.ACTIONS) {
            throw IllegalArgumentException("unknown service or action")
        }
        val app = context.applicationContext
        synchronized(controlLock) {
            val spec = resolvedSpec(app, base)
            if (spec.stopOnly) ensureHaltWatcher(app)
            return when (action) {
                "start" -> start(app, spec, principal)
                "stop" -> stop(app, spec, principal, reason = "request")
                else -> result("status", spec, status(app, spec))
            }
        }
    }

    // ── council-facade: on-device launch spec resolution ────────────────────
    //
    // REGISTRY's own "council-facade" entry never changes (launch = null,
    // shape only); every caller here that needs its launch asks resolvedSpec
    // for a copy with launch/health filled in from the on-device file
    // (ExternalSpec), or the same launch=null Spec back when the file is
    // absent or invalid. Re-validated on every call, except while a process
    // this supervisor spawned is alive: then the Spec it was started from is
    // returned (Running.spec), so stop / STOP-ALL / status keep describing that
    // process even if the file is deleted, broken or edited meanwhile; a file
    // change takes effect at the next start.

    private const val FACADE_ID = "council-facade"
    @Volatile private var lastFacadeAudit: Triple<Boolean, String, String?>? = null

    private fun resolvedSpec(context: Context, base: ManagedServices.Spec): ManagedServices.Spec {
        if (base.launch != null || base.id != FACADE_ID) return base
        val live = synchronized(lock) { running[base.id] }
        if (live != null && startOf(live.pid) == live.startTime) return live.spec
        val fromFile = resolveFacadeSpec(context, base)
        // A live facade named by state.json outranks the file: the file may have
        // been deleted, broken or changed since that process was launched, and
        // only its launch-time identity still verifies (and so stops) it. The
        // file's full Spec is used only when it launches that same script.
        val persisted = recoveredFacadeSpec(context, base) ?: return fromFile
        if (fromFile.launch != null && fromFile.launch.script == persisted.launch?.script) return fromFile
        Log.w(TAG, "council-facade: using the launch-time identity from state.json (pid live, spec file unusable or changed)")
        return persisted
    }

    /**
     * A persisted live facade this process did not spawn (it survived an app
     * restart), as a stop-only Spec, or null. Used by the Exit sweep and the
     * STOP-ALL watcher, which otherwise only know [running].
     */
    private fun persistedOrphan(context: Context): ManagedServices.Spec? {
        val base = ManagedServices.spec(FACADE_ID) ?: return null
        val live = synchronized(lock) { running[base.id] }
        if (live != null && startOf(live.pid) == live.startTime) return null
        return recoveredFacadeSpec(context, base)
    }

    /**
     * Called when the app's service starts (TerminalSessionService.onCreate):
     * if a facade from before an app restart is still alive, the STOP-ALL
     * watcher watches it too. Runs its /proc checks off the caller's thread.
     */
    fun adoptPersisted(context: Context) {
        val app = context.applicationContext
        Thread({
            runCatching { if (persistedOrphan(app) != null) ensureHaltWatcher(app) }
        }, "ShellySvcAdopt").apply { isDaemon = true; start() }
    }

    /**
     * The launch-spec file is unusable, but state.json may still name a live
     * facade (started by this supervisor before an app restart): its persisted
     * script, re-verified against /proc (same uid, pid + starttime, cmdline is
     * exactly `node <home>/<script>`), yields a stop-only Spec, so stop and
     * STOP-ALL never depend on the mutable launch-spec file. A start under it
     * is refused (Spec.stopOnly).
     */
    private fun recoveredFacadeSpec(context: Context, base: ManagedServices.Spec): ManagedServices.Spec? {
        val rec = readRecord(context, base.id) ?: return null
        val script = rec.script ?: return null
        if (rec.stoppedAt != null || rec.exitedAt != null || startOf(rec.pid) != rec.startTime) return null
        val launch = ManagedServices.Launch(script, emptyList(), ManagedServices.DEFAULT_ENV, workDir = script.substringBefore('/'))
        if (!isServiceProcess(context, launch, rec.pid)) return null
        return base.copy(launch = launch, stopOnly = true)
    }

    private fun resolveFacadeSpec(context: Context, base: ManagedServices.Spec): ManagedServices.Spec {
        val home = home(context)
        val file = File(home, "${ManagedServices.serviceDir(base.id)}/${ExternalSpec.FILE}")
        val text = readSmall(file, ExternalSpec.MAX_BYTES)
        val parsed = ExternalSpec.parse(text, home.absolutePath)
        // The digest is recorded only for a usable spec: a refused file may hold
        // a literal secret, and even its hash stays out of the audit.
        val digest = if (parsed.launch != null) text?.let { sha256Hex(it) } else null
        val outcome = Triple(parsed.launch != null, parsed.reason, digest)
        if (lastFacadeAudit != outcome) {
            lastFacadeAudit = outcome
            if (!IngressAuditWriter.appendServiceControlSpecLine(context, base.id, outcome.first, outcome.second, digest)) {
                Log.w(TAG, "council-facade spec audit line not written (reason=${parsed.reason})")
            }
            if (parsed.launch == null) Log.w(TAG, "council-facade launch spec not usable: reason=${parsed.reason}")
        }
        if (parsed.launch == null) return base
        return base.copy(launch = parsed.launch, health = parsed.health)
    }

    private fun sha256Hex(text: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * One GET /health to 127.0.0.1:<port> over a plain socket (never a proxy,
     * never a redirect), bounded as a whole by [timeoutMs]: connect and every
     * read get only the time left, and at most ManagedServices.HEALTH_MAX_RESPONSE
     * bytes are read before giving up. The answer is
     * ManagedServices.healthResponseOk (200 + JSON `ok` the boolean true).
     */
    private fun pollHealth(port: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        fun left(): Int = (deadline - System.currentTimeMillis()).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        return try {
            java.net.Socket(java.net.Proxy.NO_PROXY).use { sock ->
                val addr = java.net.InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
                if (left() <= 0) return false
                sock.connect(java.net.InetSocketAddress(addr, port), left())
                sock.getOutputStream().apply {
                    write("GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    flush()
                }
                val input = sock.getInputStream()
                val cap = ManagedServices.HEALTH_MAX_RESPONSE
                val buf = ByteArray(cap + 1)
                var n = 0
                while (n <= cap) {
                    val t = left()
                    if (t <= 0) return false
                    sock.soTimeout = t
                    val r = input.read(buf, n, buf.size - n)
                    if (r < 0) break
                    n += r
                }
                if (n > cap) return false
                ManagedServices.healthResponseOk(buf.copyOf(n))
            }
        } catch (e: Exception) {
            false
        }
    }

    private fun result(code: String, spec: ManagedServices.Spec, s: ManagedServices.Status): Map<String, Any?> = mapOf(
        "code" to code,
        "serviceId" to spec.id,
        "state" to s.state.wire,
        "pid" to s.pid,
        "startedAt" to s.startedAt,
        "lastHeartbeatAt" to s.lastHeartbeatAt,
        "supervised" to s.supervised,
        "exitCode" to s.exitCode,
        "exitedAt" to s.exitedAt,
    )

    private fun audit(context: Context, principal: String?, action: String, spec: ManagedServices.Spec, code: String) {
        if (!IngressAuditWriter.appendServiceControlLine(context, principal, action, spec.id, code)) {
            Log.w(TAG, "audit line not written (${spec.id} $action $code)")
        }
    }

    // ── Status ─────────────────────────────────────────────────────────────

    fun status(context: Context, spec: ManagedServices.Spec): ManagedServices.Status {
        val now = System.currentTimeMillis()
        val record = readRecord(context, spec.id)
        val health = spec.health
        if (health != null) {
            // No heartbeat file to cross-check a pid against: findLive only
            // ever returns a process this supervisor spawned or one its own
            // record/cmdline match verifies, never a guess from the poll.
            val live = findLive(context, spec, record, null)
            val healthy = pollHealth(health.port, health.timeoutMs)
            if (live != null) {
                val beat = if (healthy) ManagedServices.Beat(live.pid, now) else null
                return ManagedServices.decide(spec, live, record, beat, now)
            }
            // Alive at that port, but not a pid this supervisor can verify
            // (started outside Shelly, or started before an app update moved
            // its own cmdline check): reported running without a pid, same as
            // "not_running" elsewhere answers without one.
            if (healthy) return ManagedServices.Status(ManagedServices.State.RUNNING, null, null, now, supervised = false)
            return ManagedServices.decide(spec, null, record, null, now)
        }
        val beat = spec.heartbeat?.let { hb ->
            ManagedServices.parseBeat(readSmall(File(home(context), hb.file)))
        }
        return ManagedServices.decide(spec, findLive(context, spec, record, beat), record, beat, now)
    }

    /**
     * The live process of [spec], if any: the one this supervisor spawned
     * (pid + starttime), else the recorded one or the heartbeat's pid when its
     * /proc cmdline is this service (a loop started from a terminal tab).
     */
    private fun findLive(
        context: Context, spec: ManagedServices.Spec, record: ManagedServices.Record?, beat: ManagedServices.Beat?,
    ): ManagedServices.Live? {
        val launch = spec.launch ?: return null
        synchronized(lock) { running[spec.id] }?.let { r ->
            if (startOf(r.pid) == r.startTime) return ManagedServices.Live(r.pid, r.startedAt, supervised = true)
        }
        fun verified(pid: Int): Boolean = isServiceProcess(context, launch, pid)
        if (record != null && record.stoppedAt == null && record.exitedAt == null &&
            startOf(record.pid) == record.startTime && verified(record.pid)
        ) {
            return ManagedServices.Live(record.pid, record.startedAt, supervised = false)
        }
        val bp = beat?.pid ?: 0
        if (bp > 1 && verified(bp)) return ManagedServices.Live(bp, null, supervised = false)
        return null
    }

    /** Every spelling of the app home a process may carry in its argv. */
    private fun homeSpellings(context: Context): List<String> {
        val home = home(context)
        val pkg = context.packageName
        return listOfNotNull(
            home.absolutePath,
            runCatching { home.canonicalPath }.getOrNull(),
            "/data/data/$pkg/files/home",
            "/data/user/0/$pkg/files/home",
        ).distinct()
    }

    /** Same uid, not this process, and its cmdline is exactly this service (ManagedServices.cmdlineMatches). */
    private fun isServiceProcess(context: Context, launch: ManagedServices.Launch, pid: Int): Boolean =
        pid > 1 && pid != Process.myPid() &&
            CodexRemotePolicy.procUid(readProc(pid, "status")) == Process.myUid() &&
            ManagedServices.cmdlineMatches(launch, ManagedServices.scriptPaths(launch, homeSpellings(context)), readProc(pid, "cmdline"))

    // ── Start ──────────────────────────────────────────────────────────────

    private fun start(context: Context, spec: ManagedServices.Spec, principal: String?): Map<String, Any?> {
        val launch = spec.launch
        if (launch == null) {
            audit(context, principal, "start", spec, "not_configured")
            return result("not_configured", spec, status(context, spec))
        }
        if (spec.stopOnly) {
            // Recovered from state.json only to stop a running facade: never a
            // launch (its env would be incomplete). already_running when live.
            val s = status(context, spec)
            if (s.pid != null) {
                audit(context, principal, "start", spec, "already_running")
                return result("already_running", spec, s)
            }
            audit(context, principal, "start", spec, "not_configured")
            return result("not_configured", spec, status(context, spec))
        }
        if (StopAllSwitches.halted(context)) {
            audit(context, principal, "start", spec, "halted")
            return result("halted", spec, status(context, spec))
        }
        val before = status(context, spec)
        // A health-checked service with no verifiable pid still counts as
        // running (status() reports RUNNING with pid=null for that case): a
        // second spawn would only race the port the first one already holds.
        if (before.pid != null || before.state == ManagedServices.State.RUNNING) {
            audit(context, principal, "start", spec, "already_running")
            return result("already_running", spec, before)
        }
        val home = home(context)
        val script = File(home, launch.script)
        val scriptOk = runCatching {
            val st = Os.lstat(script.path)
            OsConstants.S_ISREG(st.st_mode)
        }.getOrDefault(false)
        if (!scriptOk) {
            audit(context, principal, "start", spec, "not_installed")
            return result("not_installed", spec, before)
        }
        val code = try {
            spawn(context, spec, launch)
        } catch (e: Exception) {
            Log.e(TAG, "start ${spec.id} failed: ${e.javaClass.simpleName}")
            "launch_failed"
        }
        audit(context, principal, "start", spec, code)
        if (code == "started") requestForegroundService(context)
        return result(code, spec, status(context, spec))
    }

    private fun spawn(context: Context, spec: ManagedServices.Spec, launch: ManagedServices.Launch): String {
        HomeInitializer.initialize(context) // regenerates a stale ~/.bashrc after an update (as CodexRemoteHost)
        val libDir = LibExtractor.extractAll(context)
        val bashPath = LibExtractor.getBashPath(context)
        val home = home(context)
        val dir = serviceDir(context, spec.id) ?: return "launch_failed"
        val log = File(dir, ManagedServices.OUTPUT_LOG)
        // output.log / output.log.1 must not be symlinks (the shell appends through the leaf).
        if (!ManagedServices.prepareOutputLog(dir)) {
            Log.w(TAG, "start ${spec.id}: output log refused (symlink or I/O error)")
            return "launch_failed"
        }
        val lib = libDir.absolutePath
        val pb = ProcessBuilder(
            "/system/bin/linker64", bashPath, "-c",
            ManagedServices.hostCommand(launch, home.absolutePath, lib, log.absolutePath),
        )
        pb.directory(home)
        pb.redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("PATH", "$lib:$lib/node_modules/npm/bin:$lib/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin")
            put("HOME", home.absolutePath)
            put("TERM", "dumb")
            put("LANG", "en_US.UTF-8")
            put("LD_LIBRARY_PATH", lib) // the bash itself needs it; the service's own value is set by hostCommand
            put("SHELL", bashPath)
            put("TERMINFO", "$lib/terminfo")
        }
        // Re-check right before the spawn (the switch may have flipped while extracting).
        if (StopAllSwitches.halted(context)) return "halted"
        val startedAt = System.currentTimeMillis()
        val proc = pb.start()
        runCatching { proc.outputStream.close() }
        Thread({ runCatching { proc.inputStream.use { s -> val b = ByteArray(4096); while (s.read(b) >= 0) Unit } } },
            "ShellySvcDrain-${spec.id}").apply { isDaemon = true; start() }
        val pid = pidOf(proc)
        val start = pid?.let { startOf(it) }
        if (pid == null || start == null) {
            Log.w(TAG, "start ${spec.id}: pid not readable; stopping the process")
            runCatching { proc.destroyForcibly() }
            return "launch_failed"
        }
        val r = Running(spec.id, proc, pid, start, startedAt, spec)
        synchronized(lock) { running[spec.id] = r }
        val recorded = writeRecord(
            context, spec.id,
            ManagedServices.Record(pid, start, startedAt, script = launch.script.takeIf { ManagedServices.RECORD_SCRIPT_RE.matches(it) }),
        )
        Thread({ waitForExit(context, spec, r) }, "ShellySvc-${spec.id}").apply { isDaemon = true; start() }
        // Without its record a service could not be reported dead later: never
        // answer `started` for it. The waiter removes it from [running].
        if (!recorded) {
            Log.w(TAG, "start ${spec.id}: state.json not written; stopping the process")
            r.stopping = true
            signalVerified(mapOf(pid to start), Process.SIGNAL_KILL)
            return "launch_failed"
        }
        // STOP-ALL raised while it was being spawned: the script also checks
        // right before it execs node; this closes the gap on this side.
        if (StopAllSwitches.halted(context)) {
            r.stopping = true
            updateRecord(context, spec.id, pid, start) { it.copy(stoppedAt = System.currentTimeMillis()) }
            signalVerified(mapOf(pid to start), Process.SIGNAL_KILL)
            return "halted"
        }
        Log.i(TAG, "started ${spec.id} pid=$pid")
        ensureHaltWatcher(context)
        // A service that cannot start (missing node, a syntax error) exits at once.
        val deadline = System.currentTimeMillis() + LAUNCH_SETTLE_MS
        while (System.currentTimeMillis() < deadline) {
            if (startOf(pid) != start) return "launch_failed"
            Thread.sleep(100)
        }
        return "started"
    }

    private fun waitForExit(context: Context, spec: ManagedServices.Spec, r: Running) {
        val code = runCatching { r.proc.waitFor() }.getOrDefault(-1)
        val now = System.currentTimeMillis()
        synchronized(lock) { if (running[spec.id] === r) running.remove(spec.id) }
        Log.i(TAG, "${spec.id} pid=${r.pid} exited code=$code after ${now - r.startedAt}ms stopping=${r.stopping}")
        // A stop writes stoppedAt itself; an exit by itself leaves it unset (= dead).
        // Only this run's record: a newer start's record is never overwritten.
        updateRecord(context, spec.id, r.pid, r.startTime) { it.copy(exitedAt = now, exitCode = code) }
        TerminalSessionService.instance?.onCodexRemoteChanged() // re-checks whether the service may stop
    }

    private fun requestForegroundService(context: Context) {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_MANAGED_SERVICE_KEEPALIVE
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        } catch (e: Exception) {
            Log.w(TAG, "could not start the foreground service: ${e.javaClass.simpleName}")
        }
    }

    // ── Stop ───────────────────────────────────────────────────────────────

    private fun stop(context: Context, spec: ManagedServices.Spec, principal: String?, reason: String): Map<String, Any?> {
        if (spec.launch == null) {
            audit(context, principal, "stop", spec, "not_configured")
            return result("not_configured", spec, status(context, spec))
        }
        val before = status(context, spec)
        val pid = before.pid
        if (pid == null) {
            audit(context, principal, "stop", spec, "not_running")
            return result("not_running", spec, before)
        }
        val start = startOf(pid)
        if (start == null) {
            audit(context, principal, "stop", spec, "not_running")
            return result("not_running", spec, status(context, spec))
        }
        val now = System.currentTimeMillis()
        val ours = synchronized(lock) { running[spec.id] }?.takeIf { it.pid == pid && it.startTime == start }
        // Not spawned here: right before signalling, check again that the pid is
        // still exactly this service (it may have exec'd something else).
        if (ours == null && !isServiceProcess(context, spec.launch, pid)) {
            audit(context, principal, "stop", spec, "not_running")
            return result("not_running", spec, status(context, spec))
        }
        ours?.stopping = true
        // Mark the stop first, so the exit is never read as a crash.
        synchronized(recordLock) {
            val rec = readRecord(context, spec.id)
            writeRecord(
                context, spec.id,
                if (rec != null && rec.pid == pid && rec.startTime == start) rec.copy(stoppedAt = now)
                else ManagedServices.Record(pid, start, before.startedAt ?: now, stoppedAt = now),
            )
        }
        Log.i(TAG, "stopping ${spec.id} pid=$pid ($reason)")
        val targets = HashMap<Int, String>()
        targets[pid] = start
        for (p in CodexRemotePolicy.descendants(pid, processParents())) startOf(p)?.let { targets[p] = it }
        signalVerified(targets, 15)
        val deadline = System.currentTimeMillis() + STOP_GRACE_MS
        while (System.currentTimeMillis() < deadline && startOf(pid) == start) Thread.sleep(200)
        signalVerified(targets, Process.SIGNAL_KILL)
        var i = 0
        while (i < 10 && startOf(pid) == start) { Thread.sleep(100); i++ }
        val code = if (startOf(pid) == start) "stop_failed" else "stopped"
        audit(context, principal, "stop", spec, code)
        TerminalSessionService.instance?.onCodexRemoteChanged()
        return result(code, spec, status(context, spec))
    }

    /** The service notification's Exit: stop every supervised service (no MCP principal). */
    fun stopAllSupervised(context: Context, reason: String): Boolean {
        val app = context.applicationContext
        // Each round takes the snapshot under controlLock, so a start that is
        // in progress finishes first and is in the snapshot (or in the next
        // round's). Only live entries count: an exited one whose waiter has
        // not removed it yet does not cause another round. Every wait is
        // bounded (a start, then one stop per service: about STOP_GRACE_MS).
        val emptied = ManagedServices.sweepUntilEmpty(ManagedServices.EXIT_SWEEP_MAX_ROUNDS) {
            synchronized(controlLock) {
                val live = synchronized(lock) { running.values.filter { startOf(it.pid) == it.startTime }.map { it.id } }
                for (id in live) {
                    val base = ManagedServices.spec(id) ?: continue
                    runCatching { stop(app, resolvedSpec(app, base), null, reason) }
                }
                live.size
            }
        }
        if (!emptied) Log.w(TAG, "stopAllSupervised($reason): services still running after ${ManagedServices.EXIT_SWEEP_MAX_ROUNDS} rounds")
        // A facade that survived an app restart is not in [running]: stopped
        // from its persisted, /proc-verified launch identity.
        val orphanStopped = synchronized(controlLock) {
            val orphan = persistedOrphan(app) ?: return@synchronized true
            runCatching { stop(app, orphan, null, reason)["code"] in setOf("stopped", "not_running") }.getOrDefault(false)
        }
        return emptied && orphanStopped
    }

    // ── STOP-ALL ───────────────────────────────────────────────────────────

    private fun ensureHaltWatcher(context: Context) {
        synchronized(lock) {
            if (haltWatcher?.isAlive == true) return
            haltWatcher = Thread({
                while (true) {
                    // The emptiness check and clearing haltWatcher are one step
                    // under [lock]: a start registers in [running] under the same
                    // lock before it calls ensureHaltWatcher, so it either is
                    // seen here or finds haltWatcher already null and starts a
                    // new watcher (never an exiting one that skips it).
                    var orphan: ManagedServices.Spec? = null
                    val ids = synchronized(lock) {
                        val ids = running.keys.toList()
                        orphan = runCatching { persistedOrphan(context) }.getOrNull()
                        if (ids.isEmpty() && orphan == null) {
                            haltWatcher = null
                            null
                        } else ids
                    } ?: break
                    if (StopAllSwitches.halted(context)) {
                        for (id in ids) {
                            val base = ManagedServices.spec(id) ?: continue
                            runCatching { synchronized(controlLock) { stop(context, resolvedSpec(context, base), null, "STOP-ALL") } }
                        }
                        if (orphan != null) {
                            runCatching {
                                synchronized(controlLock) { persistedOrphan(context)?.let { stop(context, it, null, "STOP-ALL") } }
                            }
                        }
                    }
                    runCatching { Thread.sleep(HALT_POLL_MS) }
                }
            }, "ShellySvcHalt").apply { isDaemon = true; start() }
        }
    }

    // ── Files ──────────────────────────────────────────────────────────────

    /** `<home>/.shelly/services/<id>`, created if needed; null if any part of it is a link. */
    private fun serviceDir(context: Context, id: String): File? {
        val home = home(context).canonicalFile
        val dir = File(home, ManagedServices.serviceDir(id))
        if (!dir.isDirectory && !dir.mkdirs()) return null
        return if (dir.canonicalFile.path == dir.absoluteFile.path) dir else null
    }

    private fun readRecord(context: Context, id: String): ManagedServices.Record? =
        ManagedServices.parseRecord(readSmall(File(home(context), "${ManagedServices.serviceDir(id)}/${ManagedServices.RECORD_FILE}")))

    /** Guards every read-modify-write of state.json (waiters, starts, stops). */
    private val recordLock = Object()

    /** Applies [change] only if state.json still describes this run (pid + starttime). */
    private fun updateRecord(context: Context, id: String, pid: Int, startTime: String, change: (ManagedServices.Record) -> ManagedServices.Record) {
        synchronized(recordLock) {
            val rec = readRecord(context, id) ?: return
            if (rec.pid == pid && rec.startTime == startTime) writeRecord(context, id, change(rec))
        }
    }

    /** False when not written (the leaf or its temp is a symlink, or I/O failed); logged. */
    private fun writeRecord(context: Context, id: String, r: ManagedServices.Record): Boolean {
        synchronized(recordLock) {
            val dir = serviceDir(context, id)
            val ok = dir != null && ManagedServices.writeRecordFile(dir, r, Thread.currentThread().id.toString())
            if (!ok) Log.w(TAG, "state.json not written for $id (symlink leaf or I/O error)")
            return ok
        }
    }

    /** At most [maxBytes] (4 KiB by default), never following a symlink at the leaf. */
    private fun readSmall(f: File, maxBytes: Long = 4096): String? = runCatching {
        val st = Os.lstat(f.path)
        if (!OsConstants.S_ISREG(st.st_mode) || st.st_size > maxBytes) null else f.readText()
    }.getOrNull()

    // ── /proc ──────────────────────────────────────────────────────────────

    private fun readProc(pid: Int, name: String): String? =
        runCatching { File("/proc/$pid/$name").readText() }.getOrNull()

    private fun startOf(pid: Int): String? = CodexRemotePolicy.procStartTime(readProc(pid, "stat"))

    private fun processParents(): Map<Int, Int> {
        val out = HashMap<Int, Int>()
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            CodexRemotePolicy.procParentPid(readProc(pid, "stat"))?.let { out[pid] = it }
        }
        return out
    }

    private fun signalVerified(targets: Map<Int, String>, signal: Int) {
        for (pid in CodexRemotePolicy.signalable(targets, { p -> startOf(p) }, Process.myPid())) {
            runCatching { Process.sendSignal(pid, signal) }
        }
    }

    /** java.lang.Process has no public pid() before API 33 (same as CodexRemoteHost.pidOf). */
    private fun pidOf(proc: java.lang.Process): Int? {
        val valid: (Int?) -> Int? = { p -> p?.takeIf { it > 1 && it != Process.myPid() } }
        if (Build.VERSION.SDK_INT >= 33) {
            val p = valid(runCatching { proc.javaClass.getMethod("pid").invoke(proc).toString().toInt() }.getOrNull())
            if (p != null) return p
        }
        return valid(runCatching {
            val f = proc.javaClass.getDeclaredField("pid")
            f.isAccessible = true
            f.getInt(proc)
        }.getOrNull())
    }
}
