package expo.modules.terminalemulator

import android.content.Context
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.SecureRandom
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The ONLY consumer of `$HOME/.shelly-mcp-queue/raw-requests/` (MCP
 * run_command / write_file; the server routes them here whatever the
 * settings, scripts/shelly-mcp-server.js RAW_REQUEST_TOOLS). Owned by
 * McpServerSupervisor: one instance per wanted server with exec on, bound to
 * that server's bridge key and token; it runs from the foreground service's
 * process whether or not RN is alive, so it keeps working in the background
 * and while the screen is locked. Same architecture as McpTypedOpConsumer.
 *
 * Per request file (claim and decide on one HandlerThread, in order):
 *  1. Claim: rename into `raw-requests/claimed/<name>.<random>` (the
 *     single-consumer lock; a failed rename means it is not ours).
 *  2. Verify: McpTypedOpDecision.parseRequest (RN's verifyMcpRequest: bridge
 *     key MAC first, name, freshness, replay, fields); the tool must be
 *     run_command / write_file. A file that fails is dropped unanswered with
 *     an audit line. McpReplayGuard admits each callId once.
 *  3. Route, decided ONCE per callId (McpRawToolDecision.route):
 *     - HAND_OFF (the owner's Keystore-verified "MCP: Run without approval"
 *       switch is off, exec is off, or STOP-ALL is on): the single-use
 *       handoff token `handoffs/<callId>`, then the ORIGINAL file is moved into
 *       `requests/` without overwriting (McpHandoffMove). RN then answers it
 *       exactly as before, with the approval tap — whether or not it is in the
 *       foreground right now (the request waits for it, as it always did). RN
 *       runs a raw tool from requests/ only with that token, so a copy of a
 *       signed file can never be run by both sides. One way: after the move
 *       this class never writes that request's result.
 *     - EXECUTE: queued to a small worker pool and run here, without RN:
 *       the gate (the bundled scripts/mcp-raw-gate-entry.ts helper, i.e. RN's
 *       own TS judgement, fed from the APK assets to `node -` so no shell-
 *       writable file decides it; refused when it cannot be evaluated or the
 *       POLICY-001 rules cannot be verified), write_file's real-path checks
 *       against $HOME and the Sidebar repos from the token-MAC'd snapshot
 *       (home only when it does not verify), re-resolved right before the
 *       write, which opens with O_NOFOLLOW (O_EXCL for a new file) and checks
 *       the opened file's /proc/self/fd path, type and link count before it
 *       truncates; run_command runs with the SHELLY_INGRESS* prefix inside a
 *       recorded window (McpNativeIngress) with a capped timeout. An audit line
 *       is written BEFORE anything runs (a failed write refuses) and another
 *       when it finished. Neither logcat nor the audit carries the command,
 *       the path, the content or the output.
 *  Results are created in place with O_EXCL and never replace one.
 *
 * Epoch: as McpTypedOpConsumer, the instance is the epoch (a token
 * regeneration stops the server, which retires this consumer and clears
 * raw-requests/). The last re-check (epoch, exec, the switch, STOP-ALL,
 * deadline) and the "executing" audit line happen inside [commitLock];
 * [stop] takes it after setting `stopped`, so nothing new starts once stop()
 * returned. A command already running is not killed (its own timeout ends
 * it, as on the RN path); its result is not written when the epoch ended.
 *
 * STOP-ALL turns the switch OFF ([McpSkipApprovalStore.setOff]) the moment
 * this consumer sees the `.halted` sentinel (each request and each rescan).
 */
class McpRawToolConsumer(context: Context, private val bridgeKey: String, private val token: String) {
    companion object {
        private const val TAG = "McpRawToolConsumer"
        private const val RESCAN_MS = 5_000L
        private const val STOP_JOIN_MS = 3_000L
        private const val WORKERS = 2
        private const val QUEUE_CAPACITY = 8
        private const val MAX_POLICY_BYTES = 256 * 1024
        private const val MAX_SNAPSHOT_BYTES = 256 * 1024
        private const val MAX_GATE_OUTPUT_BYTES = 64 * 1024
        private const val GATE_TIMEOUT_MS = 20_000L
        private const val GATE_ASSET = "shelly-mcp-raw-gate.js"
        private const val EVENT_RUN = "mcp_run_command"
        private const val EVENT_WRITE = "mcp_write_file"

        fun rawDir(context: Context): File = File(McpTypedOpConsumer.queueDir(context), "raw-requests")
        fun claimedDir(context: Context): File = File(rawDir(context), "claimed")

        /** Deletes every pending raw request and claimed file. Call only after the owning consumer stopped. */
        fun clearPending(context: Context) {
            try {
                for (dir in listOf(rawDir(context), claimedDir(context))) {
                    val files = dir.listFiles() ?: continue
                    for (f in files) if (isRegular(f)) runCatching { Os.remove(f.path) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "clearing pending raw requests failed type=${e.javaClass.simpleName}")
            }
        }

        @Volatile private var gateBundle: String? = null

        private fun lstatOrNull(path: String): android.system.StructStat? = try { Os.lstat(path) } catch (e: Exception) { null }
        private fun isRegular(f: File): Boolean = lstatOrNull(f.path)?.let { OsConstants.S_ISREG(it.st_mode) } ?: false
        private fun lexists(f: File): Boolean = lstatOrNull(f.path) != null

        /** At most [max] bytes of a regular, not symlinked file; null when missing / not regular / larger. */
        private fun readRegular(f: File, max: Int): ByteArray? {
            val st = lstatOrNull(f.path) ?: return null
            if (!OsConstants.S_ISREG(st.st_mode) || st.st_size > max) return null
            val fd = Os.open(f.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
            FileInputStream(fd).use { input ->
                val buf = ByteArray(max + 1)
                var n = 0
                while (n < buf.size) {
                    val r = input.read(buf, n, buf.size - n)
                    if (r < 0) break
                    n += r
                }
                if (n > max) return null
                return buf.copyOf(n)
            }
        }

        /** The real file system for McpRawToolDecision.resolveWriteTarget. */
        internal val deviceFs = object : McpRawToolDecision.Fs {
            override fun lstat(path: String): McpRawToolDecision.Stat? {
                val st = lstatOrNull(path) ?: return null
                val kind = when {
                    OsConstants.S_ISLNK(st.st_mode) -> McpRawToolDecision.Kind.LINK
                    OsConstants.S_ISREG(st.st_mode) -> McpRawToolDecision.Kind.FILE
                    OsConstants.S_ISDIR(st.st_mode) -> McpRawToolDecision.Kind.DIR
                    else -> McpRawToolDecision.Kind.OTHER
                }
                return McpRawToolDecision.Stat(kind, st.st_nlink)
            }

            override fun isDirFollow(path: String): Boolean = try {
                OsConstants.S_ISDIR(Os.stat(path).st_mode)
            } catch (e: Exception) {
                false
            }

            // Android's canonicalize is realpath(3) (no cache), i.e. `cd -P && pwd -P`.
            override fun realPath(path: String): String? = try { File(path).canonicalPath } catch (e: Exception) { null }
        }
    }

    private val app: Context = context.applicationContext
    private val home: File = HomeInitializer.getHomeDir(app)
    private val homePath: String = home.absolutePath
    private val queueDir = McpTypedOpConsumer.queueDir(app)
    private val rawDir = rawDir(app)
    private val claimedDir = claimedDir(app)
    private val requestsDir = File(queueDir, "requests")
    private val resultsDir = File(queueDir, "results")
    private val handoffsDir = McpTypedOpConsumer.handoffsDir(app)
    private val snapshotFile = File(queueDir, "snapshot.json")
    private val agentsDir = File(home, ".shelly/agents")
    private val commitLock = Object()
    private val random = SecureRandom()
    /** callIds this instance accepted (handler thread only). */
    private val seen = McpReplayGuard()

    @Volatile private var stopped = false
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var observer: FileObserver? = null
    private var workers: ThreadPoolExecutor? = null
    @Volatile private var scanQueued = false

    fun hasKey(key: String, tok: String): Boolean = key == bridgeKey && tok == token

    fun isCurrent(): Boolean = !stopped && McpServerSupervisor.isCurrentRawToolConsumer(this)

    // ── Lifecycle ─────────────────────────────────────────────────────────

    @Synchronized
    fun start() {
        if (stopped || thread != null) return
        try {
            ensurePrivateDir(rawDir)
            ensurePrivateDir(claimedDir)
        } catch (e: Exception) {
            Log.w(TAG, "raw-requests dir not usable type=${e.javaClass.simpleName}; consumer not started")
            return
        }
        val t = HandlerThread("ShellyMcpRawTools").also { it.start() }
        val h = Handler(t.looper)
        thread = t
        handler = h
        workers = ThreadPoolExecutor(WORKERS, WORKERS, 30L, TimeUnit.SECONDS, ArrayBlockingQueue(QUEUE_CAPACITY)) { r ->
            Thread(r, "ShellyMcpRawWorker").apply { isDaemon = true }
        }
        observer = startObserver()
        h.post { sweepOrphans() }
        requestScan()
        h.postDelayed(object : Runnable {
            override fun run() {
                if (stopped) return
                sweepOrphans()
                if (haltedOnDisk()) turnOffForStopAll()
                scanNow()
                h.postDelayed(this, RESCAN_MS)
            }
        }, RESCAN_MS)
        Log.i(TAG, "started")
    }

    fun stop(clearPending: Boolean) {
        stopped = true
        synchronized(commitLock) { }
        val (t, pool) = synchronized(this) {
            stopped = true
            runCatching { observer?.stopWatching() }
            observer = null
            handler?.removeCallbacksAndMessages(null)
            handler = null
            val th = thread
            thread = null
            val p = workers
            workers = null
            th to p
        }
        // Queued (not started) calls never run; their claimed files are cleared or swept.
        runCatching { pool?.shutdownNow() }
        var finished = true
        if (t != null) {
            t.quitSafely()
            if (Thread.currentThread() !== t) {
                runCatching { t.join(STOP_JOIN_MS) }
                finished = !t.isAlive
            }
        }
        if (clearPending && finished) clearPending(app)
        Log.i(TAG, "stopped clearPending=$clearPending finished=$finished")
    }

    private fun startObserver(): FileObserver? = try {
        val mask = FileObserver.CREATE or FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE
        val o = if (Build.VERSION.SDK_INT >= 29) {
            object : FileObserver(rawDir, mask) {
                override fun onEvent(event: Int, path: String?) = onDirEvent(path)
            }
        } else {
            @Suppress("DEPRECATION")
            object : FileObserver(rawDir.absolutePath, mask) {
                override fun onEvent(event: Int, path: String?) = onDirEvent(path)
            }
        }
        o.startWatching()
        o
    } catch (e: Exception) {
        Log.w(TAG, "raw-requests observer not started (the periodic rescan still runs) type=${e.javaClass.simpleName}")
        null
    }

    private fun onDirEvent(path: String?) {
        if (path != null && McpTypedOpDecision.REQUEST_FILE_RE.matches(path)) requestScan()
    }

    private fun requestScan() {
        if (stopped || scanQueued) return
        val h = synchronized(this) { handler } ?: return
        scanQueued = true
        h.post {
            scanQueued = false
            scanNow()
        }
    }

    // ── Scan, claim, sweep (handler thread) ───────────────────────────────

    private fun scanNow() {
        if (stopped) return
        val names = try { rawDir.list() } catch (e: Exception) { null } ?: return
        for (name in names.sorted()) {
            if (stopped) return
            if (!McpTypedOpDecision.REQUEST_FILE_RE.matches(name)) continue
            val claimed = claim(name) ?: continue
            try {
                process(name, claimed)
            } catch (e: Throwable) {
                Log.w(TAG, "raw request failed type=${e.javaClass.simpleName}")
            }
        }
    }

    private fun claim(name: String): File? {
        val source = File(rawDir, name)
        if (!isRegular(source)) return null
        val bytes = ByteArray(8).also { random.nextBytes(it) }
        val target = File(claimedDir, "$name.${bytes.joinToString("") { "%02x".format(it) }}")
        return try {
            Os.rename(source.path, target.path)
            target
        } catch (e: Exception) {
            null
        }
    }

    private fun sweepOrphans() {
        val now = System.currentTimeMillis()
        val claimed = try { claimedDir.listFiles() } catch (e: Exception) { null }
        for (f in claimed ?: emptyArray()) {
            val st = lstatOrNull(f.path) ?: continue
            if (!McpTypedOpDecision.isOrphan(st.st_mtime * 1000L, now)) continue
            audit("mcp_raw_tool_dropped", null, null, "orphan", EVENT_RUN)
            runCatching { Os.remove(f.path) }
        }
        // Unconsumed handoff tokens past the client's wait (as McpTypedOpConsumer; no audit).
        val tokens = try { handoffsDir.listFiles() } catch (e: Exception) { null }
        for (f in tokens ?: emptyArray()) {
            val st = lstatOrNull(f.path) ?: continue
            if (McpTypedOpDecision.isOrphan(st.st_mtime * 1000L, now)) runCatching { Os.remove(f.path) }
        }
    }

    private fun process(name: String, claimed: File) {
        val now = System.currentTimeMillis()
        val bytes = try { readRegular(claimed, McpRawToolDecision.MAX_REQUEST_BYTES) } catch (e: Exception) { null }
        val parsed = if (bytes == null) {
            McpTypedOpDecision.Parsed.Drop("bad_request")
        } else {
            McpTypedOpDecision.parseRequest(String(bytes, Charsets.UTF_8), name, bridgeKey, now) { seen.isSeen(it) }
        }
        val request = when (parsed) {
            is McpTypedOpDecision.Parsed.Drop -> {
                Log.w(TAG, "dropped raw request file (${parsed.reason})")
                audit("mcp_raw_tool_dropped", null, null, parsed.reason, EVENT_RUN)
                delete(claimed)
                return
            }
            is McpTypedOpDecision.Parsed.Ok -> parsed.request
        }
        val event = eventOf(request.tool)
        if (event == null) {
            audit("mcp_raw_tool_dropped", null, request.principal, "bad_request", EVENT_RUN)
            delete(claimed)
            return
        }
        if (!seen.admit(request.callId, request.receivedAtMs, now)) {
            Log.w(TAG, "dropped raw request file (replay set full)")
            audit("mcp_raw_tool_dropped", null, request.principal, "replay_capacity", event)
            delete(claimed)
            return
        }
        if (lexists(resultFile(request.callId))) {
            audit("mcp_raw_tool_dropped", null, request.principal, "replay", event)
            delete(claimed)
            return
        }
        val halted = haltedOnDisk()
        if (halted) turnOffForStopAll()
        when (McpRawToolDecision.route(skipOn(), execOn(), halted)) {
            McpRawToolDecision.Route.HAND_OFF -> handOff(request, name, claimed, event)
            McpRawToolDecision.Route.EXECUTE -> {
                val pool = synchronized(this) { workers }
                try {
                    if (pool == null) throw RejectedExecutionException("stopped")
                    pool.execute { runSafely(request, claimed, event) }
                } catch (e: RejectedExecutionException) {
                    finish(request, claimed, event, "mcp_raw_tool_refused", "busy", McpRawToolDecision.errorResult(McpRawToolDecision.BUSY_ERROR))
                }
            }
        }
    }

    private fun eventOf(tool: String): String? = when (tool) {
        "run_command" -> EVENT_RUN
        "write_file" -> EVENT_WRITE
        else -> null
    }

    private fun handOff(request: McpTypedOpDecision.Request, name: String, claimed: File, event: String) {
        val dest = File(requestsDir, name)
        val tokenFile = File(handoffsDir, request.callId)
        audit("mcp_raw_tool_handed_off", null, request.principal, null, event)
        val result = if (writeHandoffToken(tokenFile, request.callId)) McpHandoffMove.move(claimed.path, dest.path, McpTypedOpConsumer.handoffFs) else null
        if (result is McpHandoffMove.Result.Moved) {
            Log.i(TAG, "${request.tool} handed to RN for the approval tap route=${result.route}")
            return
        }
        val why = McpHandoffMove.failureCode(result)
        Log.w(TAG, "raw handoff move failed code=$why")
        audit("mcp_raw_tool_handoff_failed", null, request.principal, why, event)
        if (McpHandoffMove.refusalAfterFailure(lexists(claimed), lexists(dest)) != null) {
            runCatching { Os.remove(tokenFile.path) }
            finish(request, claimed, event, "mcp_raw_tool_refused", "handoff_failed", McpRawToolDecision.errorResult(McpRawToolDecision.HANDOFF_FAILED_ERROR))
        } else {
            Log.w(TAG, "raw handoff state unknown; not answering (no second writer)")
        }
    }

    // ── Execution (worker threads) ────────────────────────────────────────

    private fun runSafely(request: McpTypedOpDecision.Request, claimed: File, event: String) {
        try {
            when (request.tool) {
                "run_command" -> runCommand(request, claimed, event)
                "write_file" -> writeFile(request, claimed, event)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "${request.tool} failed type=${e.javaClass.simpleName}")
            finish(request, claimed, event, "mcp_raw_tool_refused", "internal_error", McpRawToolDecision.errorResult("Shelly failed to run the call (${e.javaClass.simpleName})"))
        }
    }

    /** Null when the call may still run now; otherwise the (code, message) to refuse with. Under [commitLock]. */
    private fun recheckLocked(request: McpTypedOpDecision.Request): Pair<String, String>? {
        if (!isCurrent()) return "revoked" to McpRawToolDecision.REVOKED_ERROR
        if (!execOn()) return "disabled" to McpRawToolDecision.EXEC_DISABLED_ERROR
        if (haltedOnDisk()) {
            turnOffForStopAll()
            return "halted" to McpRawToolDecision.SKIP_TURNED_OFF_ERROR
        }
        if (!skipOn()) return "skip_off" to McpRawToolDecision.SKIP_TURNED_OFF_ERROR
        if (McpTypedOpDecision.isExpired(request.receivedAtMs, System.currentTimeMillis())) return "expired" to McpRawToolDecision.EXPIRED_ERROR
        return null
    }

    private fun runCommand(request: McpTypedOpDecision.Request, claimed: File, event: String) {
        val args = McpRawToolDecision.parseRunCommand(request.args)
            ?: return finish(request, claimed, event, "mcp_raw_tool_refused", "invalid_params", McpRawToolDecision.errorResult(McpRawToolDecision.COMMAND_REQUIRED))
        val (policyText, sealOk) = policyForGate()
        val gate = runGate(McpRawToolDecision.gateInputRunCommand(homePath, args.command, args.cwd, policyText, sealOk))
        if (gate.refused) {
            Log.i(TAG, "run_command refused by the gate")
            return finish(request, claimed, event, "mcp_raw_tool_refused", "gate", McpRawToolDecision.errorResult(McpRawToolDecision.GATE_PREFIX + gate.summary))
        }
        val timeout = McpRawToolDecision.effectiveTimeoutMs(args.requestedTimeoutMs, request.receivedAtMs, System.currentTimeMillis())
            ?: return finish(request, claimed, event, "mcp_raw_tool_refused", "expired", McpRawToolDecision.errorResult(McpRawToolDecision.EXPIRED_ERROR))
        val (libDir, _) = LibExtractor.ensureExtracted(app)
        val libPath = libDir.absolutePath
        val bashPath = LibExtractor.getBashPath(app)
        NativeExecEnvironment.seedTls(app, homePath)
        val script = NativeExecEnvironment.wrap(libPath, homePath, McpRawToolDecision.execScript(args.command, args.cwd, request.principal, request.callId))
        // The ingress window is journaled (persistent, Keystore-HMAC'd) BEFORE
        // the command starts, with the agent requests that already exist: a
        // request the command writes stays MCP-originated even if this process
        // dies before RN drains it (McpNativeIngress). No journal, no run.
        val refusal = synchronized(commitLock) {
            val r = recheckLocked(request)
                ?: run {
                    val before = McpRawToolDecision.agentRequestIds(runCatching { home.list() }.getOrNull())
                    if (before == null || !McpNativeIngress.openWindow(app, request.callId, request.principal, before)) {
                        "journal_failed" to "not run: the MCP ingress journal could not be written"
                    } else if (!IngressAuditWriter.appendNativeMcpLine(app, "mcp_raw_tool_executing", null, request.principal, null, event = event)) {
                        McpNativeIngress.closeWindow(app, request.callId, McpRawToolDecision.agentRequestIds(runCatching { home.list() }.getOrNull()))
                        "audit_failed" to McpRawToolDecision.AUDIT_FAILED_ERROR
                    } else {
                        null
                    }
                }
            r
        }
        if (refusal != null) return finish(request, claimed, event, "mcp_raw_tool_refused", refusal.first, McpRawToolDecision.errorResult(refusal.second))
        val out: Array<String> = try {
            ShellyJNI.execSubprocess("/system/bin/linker64", bashPath, libPath, homePath, script, timeout.toInt())
        } finally {
            // Ids that appeared are recorded; a failed listing leaves the window
            // open, recovered (fail closed) on the next journal read.
            McpNativeIngress.closeWindow(app, request.callId, McpRawToolDecision.agentRequestIds(runCatching { home.list() }.getOrNull()))
        }
        val exit = out.getOrNull(0)?.toIntOrNull() ?: -1
        Log.i(TAG, "run_command ran headless exit=$exit")
        if (!isCurrent()) {
            // RN's rule: nothing accepted under a revoked token gets an answer.
            audit("mcp_raw_tool_done", null, request.principal, "revoked", event)
            delete(claimed)
            return
        }
        finish(request, claimed, event, "mcp_raw_tool_done", if (exit == 0) "ok" else "failed",
            McpRawToolDecision.commandResult(out.getOrNull(1) ?: "", out.getOrNull(2) ?: "", exit))
    }

    private fun writeFile(request: McpTypedOpDecision.Request, claimed: File, event: String) {
        val args = McpRawToolDecision.parseWriteFile(request.args)
        val roots = allowedRoots()
        val first = McpRawToolDecision.resolveWriteTarget(args.path, roots, deviceFs)
        if (first is McpRawToolDecision.Target.Err) {
            Log.i(TAG, "write_file refused (path)")
            return finish(request, claimed, event, "mcp_raw_tool_refused", "path", McpRawToolDecision.errorResult(first.error))
        }
        val realPath = (first as McpRawToolDecision.Target.Ok).realPath
        val (policyText, sealOk) = policyForGate()
        val gate = runGate(McpRawToolDecision.gateInputWriteFile(homePath, realPath, args.path, policyText, sealOk))
        if (gate.refused) {
            Log.i(TAG, "write_file refused by the gate")
            return finish(request, claimed, event, "mcp_raw_tool_refused", "gate", McpRawToolDecision.errorResult(McpRawToolDecision.GATE_PREFIX + gate.summary))
        }
        val bytes = args.content.toByteArray(Charsets.UTF_8)
        var error: String? = null
        var code = "ok"
        val refusal = synchronized(commitLock) {
            val r = recheckLocked(request) ?: run {
                // Resolve again right before the write: a symlink swapped in
                // since the check must not redirect it.
                val again = McpRawToolDecision.resolveWriteTarget(args.path, roots, deviceFs)
                if (again !is McpRawToolDecision.Target.Ok || again.realPath != realPath) {
                    "target_changed" to "refused: the target changed before the write${if (again is McpRawToolDecision.Target.Err) " (${again.error})" else ""}"
                } else if (!IngressAuditWriter.appendNativeMcpLine(app, "mcp_raw_tool_executing", null, request.principal, null, event = event)) {
                    "audit_failed" to McpRawToolDecision.AUDIT_FAILED_ERROR
                } else {
                    error = writeVerified(realPath, bytes) {
                        val now = McpRawToolDecision.resolveWriteTarget(args.path, roots, deviceFs)
                        now is McpRawToolDecision.Target.Ok && now.realPath == realPath
                    }
                    if (error != null) code = "failed"
                    null
                }
            }
            r
        }
        if (refusal != null) return finish(request, claimed, event, "mcp_raw_tool_refused", refusal.first, McpRawToolDecision.errorResult(refusal.second))
        Log.i(TAG, "write_file ran headless ok=${error == null}")
        val e = error
        finish(request, claimed, event, "mcp_raw_tool_done", code,
            if (e != null) McpRawToolDecision.errorResult(e) else McpRawToolDecision.writeResult(realPath, args.content.length))
    }

    /**
     * Replaces [realPath] by a new file instead of writing into the existing
     * inode (a hard link swapped in after the check can then never be
     * rewritten through its other name):
     *  1. open the parent directory (O_DIRECTORY | O_NOFOLLOW) and check that
     *     its /proc/self/fd path is exactly the checked real parent;
     *  2. create a private temp file in it THROUGH that directory fd
     *     (`/proc/self/fd/<dirfd>/<name>`, O_CREAT | O_EXCL | O_NOFOLLOW, 0600;
     *     an existing target's permission bits are kept), write, fsync;
     *  3. right before the rename: [stillChecked] re-resolves the target
     *     against the allowed roots (must still be [realPath]), the dir fd
     *     path is re-checked, and an existing target must still be a regular
     *     file with one link (else refused);
     *  4. rename the temp file over the target through the same dir fd (atomic;
     *     it replaces the name, never follows a link), then fsync the dir.
     * android.system.Os has no renameat; `/proc/self/fd/<dirfd>/…` gives the
     * same "relative to this opened directory" resolution. Null on success.
     */
    private fun writeVerified(realPath: String, bytes: ByteArray, stillChecked: () -> Boolean): String? {
        val slash = realPath.lastIndexOf('/')
        if (slash <= 0 || slash == realPath.length - 1) return "refused: the target has no parent directory"
        val parent = realPath.substring(0, slash)
        val leaf = realPath.substring(slash + 1)
        val dirFd = try {
            Os.open(parent, OsConstants.O_RDONLY or OsConstants.O_DIRECTORY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
        } catch (e: android.system.ErrnoException) {
            return "could not open the parent directory (${OsConstants.errnoName(e.errno) ?: e.errno})"
        }
        val dirPfd = try { ParcelFileDescriptor.dup(dirFd) } catch (e: Exception) { runCatching { Os.close(dirFd) }; return "could not open the parent directory" }
        var tmpName: String? = null
        try {
            val dirLink = "/proc/self/fd/${dirPfd.fd}"
            fun dirIsChecked(): Boolean = runCatching { Os.readlink(dirLink) }.getOrNull() == parent &&
                OsConstants.S_ISDIR(Os.fstat(dirFd).st_mode)
            if (!dirIsChecked()) return "refused: the parent directory is not the checked one"
            fun targetState(): Pair<Boolean, Int>? { // (exists, mode); null = refuse
                val st = try { Os.lstat("$dirLink/$leaf") } catch (e: android.system.ErrnoException) {
                    return if (e.errno == OsConstants.ENOENT) false to 384 else null
                }
                if (!OsConstants.S_ISREG(st.st_mode) || st.st_nlink != 1L) return null
                return true to (st.st_mode and 0x1ff)
            }
            val before = targetState() ?: return "refused: the target exists and is not a regular file with one link"
            val name = ".shelly-mcp-write-" + ByteArray(8).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) } + ".tmp"
            val fd = Os.open("$dirLink/$name", OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384)
            tmpName = name
            try {
                if (before.first) Os.fchmod(fd, before.second)
                var off = 0
                while (off < bytes.size) off += Os.write(fd, bytes, off, bytes.size - off)
                Os.fsync(fd)
            } finally {
                runCatching { Os.close(fd) }
            }
            if (!stillChecked() || !dirIsChecked()) return "refused: the target changed before the write"
            targetState() ?: return "refused: the target exists and is not a regular file with one link"
            Os.rename("$dirLink/$name", "$dirLink/$leaf")
            tmpName = null
            runCatching { Os.fsync(dirFd) }
            return null
        } catch (e: Exception) {
            return "write failed (${e.javaClass.simpleName})"
        } finally {
            tmpName?.let { t -> runCatching { Os.remove("/proc/self/fd/${dirPfd.fd}/$t") } }
            runCatching { dirPfd.close() }
            runCatching { Os.close(dirFd) }
        }
    }

    // ── Facts (each fails closed) ─────────────────────────────────────────

    /** The Keystore-verified owner switch. */
    private fun skipOn(): Boolean = try { McpSkipApprovalStore.isOn(app) } catch (e: Exception) { false }

    /** The wanted server's exec switch and the Keystore mirror RN writes (OFF / unreadable = off). */
    private fun execOn(): Boolean = try {
        McpServerSupervisor.wantedSwitches()?.first == true && McpAutostartStore.read(app)?.exec == true
    } catch (e: Exception) {
        false
    }

    /** The STOP-ALL sentinel; true when it can't be checked. */
    private fun haltedOnDisk(): Boolean = McpTypedOpConsumer.haltedOnDisk(agentsDir)

    private fun turnOffForStopAll() {
        StopAllSwitches.turnOff(app, "STOP-ALL")
    }

    /** policy.json text (null when absent) and whether it matches the native seal. */
    private fun policyForGate(): Pair<String?, Boolean> = try {
        val f = File(agentsDir, "policy.json")
        val present = lexists(f)
        val bytes = if (present) readRegular(f, MAX_POLICY_BYTES) else null
        if (present && bytes == null) {
            null to false
        } else {
            val seal = AgentPolicySeal.read(app)
            val ok = McpRawToolDecision.policySealAccepts(seal.seal, seal.everSealed, seal.valid, bytes)
            bytes?.let { String(it, Charsets.UTF_8) } to ok
        }
    } catch (e: Exception) {
        null to false
    }

    /** $HOME plus the Sidebar repos from the verified snapshot (home only when it does not verify). */
    private fun allowedRoots(): List<String> {
        val text = try { readRegular(snapshotFile, MAX_SNAPSHOT_BYTES)?.let { String(it, Charsets.UTF_8) } } catch (e: Exception) { null }
        val repos = McpRawToolDecision.repoPathsFromSnapshot(text, token) ?: emptyList()
        return listOf(homePath) + repos
    }

    /** RN's gate decision from the bundled helper (APK asset → `node -`); refused on any failure. */
    private fun runGate(input: JSONObject): McpRawToolDecision.GateVerdict {
        var proc: Process? = null
        return try {
            val bundle = gateBundle ?: app.assets.open(GATE_ASSET).use { String(it.readBytes(), Charsets.UTF_8) }.also { gateBundle = it }
            val (libDir, _) = LibExtractor.ensureExtracted(app)
            val node = File(libDir, "node").absolutePath
            val pb = ProcessBuilder("/system/bin/linker64", node, "-")
            val env = pb.environment()
            env.clear()
            env["LD_LIBRARY_PATH"] = libDir.absolutePath
            env["HOME"] = homePath
            env["PATH"] = "${libDir.absolutePath}:/system/bin"
            pb.directory(home)
            val p = pb.start()
            proc = p
            val stderrDrain = Thread { runCatching { p.errorStream.use { s -> val b = ByteArray(4096); while (s.read(b) >= 0) { } } } }
                .apply { isDaemon = true; start() }
            val outBuf = java.io.ByteArrayOutputStream()
            val stdoutReader = Thread {
                runCatching {
                    p.inputStream.use { s ->
                        val b = ByteArray(4096)
                        while (true) {
                            val n = s.read(b)
                            if (n < 0) break
                            if (outBuf.size() + n > MAX_GATE_OUTPUT_BYTES) break
                            outBuf.write(b, 0, n)
                        }
                    }
                }
            }.apply { isDaemon = true; start() }
            p.outputStream.use { it.write(McpRawToolDecision.gateScript(input, bundle).toByteArray(Charsets.UTF_8)) }
            stdoutReader.join(GATE_TIMEOUT_MS)
            if (stdoutReader.isAlive) {
                Log.w(TAG, "gate helper timed out")
                return McpRawToolDecision.parseGateOutput(null, null)
            }
            // stdout is at EOF, so node is exiting; bounded where the API allows.
            val exit = if (Build.VERSION.SDK_INT >= 26) {
                if (p.waitFor(5, TimeUnit.SECONDS)) p.exitValue() else null
            } else {
                p.waitFor()
            }
            stderrDrain.join(1_000L)
            McpRawToolDecision.parseGateOutput(String(outBuf.toByteArray(), Charsets.UTF_8), exit)
        } catch (e: Exception) {
            Log.w(TAG, "gate helper failed type=${e.javaClass.simpleName}")
            McpRawToolDecision.parseGateOutput(null, null)
        } finally {
            proc?.let { p -> runCatching { p.destroy() } }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private fun finish(request: McpTypedOpDecision.Request, claimed: File, event: String, kind: String, code: String, json: String) {
        audit(kind, null, request.principal, code, event)
        writeResult(request.callId, json)
        delete(claimed)
    }

    private fun resultFile(callId: String): File = File(resultsDir, "$callId.json")

    /** Creates `results/<callId>.json` with O_EXCL; never replaces one. Best effort. */
    private fun writeResult(callId: String, json: String) {
        try {
            if (!resultsDir.isDirectory) resultsDir.mkdirs()
            val fd = Os.open(
                resultFile(callId).path,
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
                384, /* 0600 */
            )
            FileOutputStream(fd).use { it.write(json.toByteArray(Charsets.UTF_8)) }
        } catch (e: Exception) {
            val errno = (e as? android.system.ErrnoException)?.errno
            if (errno == OsConstants.EEXIST) Log.w(TAG, "result already present; not overwritten")
            else Log.w(TAG, "result not written type=${e.javaClass.simpleName}")
        }
    }

    private fun writeHandoffToken(tokenFile: File, callId: String): Boolean = try {
        ensurePrivateDir(handoffsDir)
        if (lexists(tokenFile)) Os.remove(tokenFile.path)
        val fd = Os.open(
            tokenFile.path,
            OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
            384, /* 0600 */
        )
        val value = McpTypedOpDecision.handoffToken(bridgeKey, callId)
        FileOutputStream(fd).use { it.write(value.toByteArray(Charsets.US_ASCII)) }
        true
    } catch (e: Exception) {
        Log.w(TAG, "handoff token not written type=${e.javaClass.simpleName}")
        false
    }

    private fun delete(f: File) {
        runCatching { Os.remove(f.path) }
    }

    private fun audit(kind: String, agentId: String?, principal: String?, code: String?, event: String) {
        if (!IngressAuditWriter.appendNativeMcpLine(app, kind, agentId, principal, code, event = event)) {
            Log.w(TAG, "audit line not written ($kind ${code ?: ""})")
        }
    }

    private fun ensurePrivateDir(dir: File) {
        dir.mkdirs()
        val st = Os.lstat(dir.path)
        if (!OsConstants.S_ISDIR(st.st_mode)) throw java.io.IOException("not a directory")
        Os.chmod(dir.path, 448 /* 0700 */)
    }
}
