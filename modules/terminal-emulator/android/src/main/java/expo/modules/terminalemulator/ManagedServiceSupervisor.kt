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

    private class Running(val id: String, val proc: java.lang.Process, val pid: Int, val startTime: String, val startedAt: Long) {
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
        val spec = ManagedServices.spec(serviceId)
        if (spec == null || action !in ManagedServices.ACTIONS) {
            throw IllegalArgumentException("unknown service or action")
        }
        val app = context.applicationContext
        synchronized(controlLock) {
            return when (action) {
                "start" -> start(app, spec, principal)
                "stop" -> stop(app, spec, principal, reason = "request")
                else -> result("status", spec, status(app, spec))
            }
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
        if (StopAllSwitches.halted(context)) {
            audit(context, principal, "start", spec, "halted")
            return result("halted", spec, status(context, spec))
        }
        val before = status(context, spec)
        if (before.pid != null) {
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
        val r = Running(spec.id, proc, pid, start, startedAt)
        synchronized(lock) { running[spec.id] = r }
        val recorded = writeRecord(context, spec.id, ManagedServices.Record(pid, start, startedAt))
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
        // right before `exec node`; this closes the gap on this side.
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
    fun stopAllSupervised(context: Context, reason: String) {
        val ids = synchronized(lock) { running.keys.toList() }
        for (id in ids) {
            val spec = ManagedServices.spec(id) ?: continue
            runCatching { synchronized(controlLock) { stop(context.applicationContext, spec, null, reason) } }
        }
    }

    // ── STOP-ALL ───────────────────────────────────────────────────────────

    private fun ensureHaltWatcher(context: Context) {
        synchronized(lock) {
            if (haltWatcher?.isAlive == true) return
            haltWatcher = Thread({
                while (true) {
                    val ids = synchronized(lock) { running.keys.toList() }
                    if (ids.isEmpty()) break
                    if (StopAllSwitches.halted(context)) {
                        for (id in ids) {
                            val spec = ManagedServices.spec(id) ?: continue
                            runCatching { synchronized(controlLock) { stop(context, spec, null, "STOP-ALL") } }
                        }
                    }
                    runCatching { Thread.sleep(HALT_POLL_MS) }
                }
                synchronized(lock) { haltWatcher = null }
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

    /** At most 4 KiB, never following a symlink at the leaf. */
    private fun readSmall(f: File): String? = runCatching {
        val st = Os.lstat(f.path)
        if (!OsConstants.S_ISREG(st.st_mode) || st.st_size > 4096) null else f.readText()
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
