package expo.modules.terminalemulator

import android.content.Context
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.SecureRandom
import org.json.JSONObject

/**
 * The ONLY consumer of `$HOME/.shelly-mcp-queue/typed-requests/` (PR 6,
 * headless typed ops; plan section (b2) and the 2026-11-15 addendum, Option 2).
 * Owned by McpServerSupervisor: one instance per wanted server with typed ops
 * on, bound to that server's bridge key; it runs whether the server was
 * started by the app or headless, because the script always routes run_agent
 * here and RN never reads this directory.
 *
 * Per request file (all on one HandlerThread, so requests are handled one at a
 * time):
 *  1. Claim: rename `typed-requests/<callId>.json` to
 *     `typed-requests/claimed/<callId>.json.<random>`. The rename is the
 *     single-consumer lock: a failed rename means someone else has it, and
 *     nothing else is touched. The random suffix means a second file with the
 *     same name can never replace a claimed one.
 *  2. Verify (McpTypedOpDecision.parseRequest = RN's verifyMcpRequest, MAC
 *     first). A file that fails is dropped without an answer, exactly as RN's
 *     processRequestFile does (it logs and deletes), plus an audit line.
 *  3. Decide (McpTypedOpDecision.decide, RN's order; the always-allow store is
 *     read only after every deny class) and finish with exactly one of:
 *     - refuse: one error result + audit line, claimed file deleted;
 *     - existing run (repeated requestId): one ok result, deleted;
 *     - execute: audit line (rule id, principal, op, target) BEFORE the launch
 *       — a failed audit write refuses instead — then McpRunLauncher (accepted
 *       ticket before the intent, no origin / tainted extras), one result,
 *       deleted;
 *     - hand off (no match, RN live): audit line, the single-use handoff token
 *       `handoffs/<callId>` (RN runs a typed op from requests/ only with it, so
 *       a same-uid copy of the signed file can never run twice), then the
 *       ORIGINAL file is moved from claimed/ into `requests/` without
 *       overwriting. One way: after the move this class never writes that
 *       request's result. If the move (or the token write) fails while the
 *       file is still in claimed/ and nothing is at the destination, the token
 *       is removed and the request refused with its own code `handoff_failed`
 *       (logcat + an `mcp_typed_op_handoff_failed` audit line carry the errno
 *       name) — never `not_attended`, which means nobody was there to approve;
 *       otherwise nothing is written (ambiguous = no second writer).
 *  A result file is created in place with O_EXCL and never replaces one (the
 *  script retries a torn read until its deadline). The handoff move is
 *  McpHandoffMove: renameat2(RENAME_NOREPLACE) (atomic, EEXIST = not handed
 *  off). It used to be Os.link + unlink, which SELinux refuses to apps on
 *  app_data_file, so every handoff on device failed (build 2964). Only where
 *  renameat2 is unavailable (API < 30, ENOSYS, EINVAL) it is lstat-absent then
 *  rename — a same-uid-only check-then-rename window; the moved file still
 *  needs a valid bridge-key MAC and the single-use handoff token before RN
 *  acts on it (see McpHandoffMove).
 *
 * Commit vs. retirement: the last re-check, the audit line, the ticket and the
 * intent happen inside [commitLock]; [stop] sets `stopped` and then takes
 * [commitLock], so once stop() returns no launch of this instance can start
 * (a stalled worker past the join timeout included).
 *
 * Orphans: claimed files older than 120 s (the script gave up after 100 s)
 * are deleted with an audit line and no result — never re-run — at start and
 * on each rescan. Younger ones are never touched.
 *
 * Epoch (plan Q-G): RN's queueEpoch is RN memory. Natively the epoch is this
 * instance: a token regeneration always stops the server (supervisor.stop)
 * and starts it with a new bridge key, which stops this consumer, waits for
 * the request in progress, clears typed-requests/, and starts a new one.
 * [isCurrent] (not stopped and still the supervisor's consumer) is checked at
 * step 3 and again right before the ticket is written.
 */
class McpTypedOpConsumer(context: Context, private val bridgeKey: String) {
    companion object {
        private const val TAG = "McpTypedOpConsumer"
        private const val RESCAN_MS = 5_000L
        private const val STOP_JOIN_MS = 3_000L
        private const val MAX_REQUEST_BYTES = 64 * 1024
        private const val MAX_AGENT_BYTES = 1024 * 1024
        private const val MAX_POLICY_BYTES = 256 * 1024
        private const val HEARTBEAT_MAX_BYTES = 64
        private const val TOKEN_RE_SRC = "^[0-9a-f]{64}$"

        fun queueDir(context: Context): File = File(HomeInitializer.getHomeDir(context), ".shelly-mcp-queue")
        fun typedDir(context: Context): File = File(queueDir(context), "typed-requests")
        fun claimedDir(context: Context): File = File(typedDir(context), "claimed")
        fun handoffsDir(context: Context): File = File(queueDir(context), "handoffs")
        /** Lock-screen approvals for RN (McpLockScreenApproval.token), one per callId. */
        fun lockApprovalsDir(context: Context): File = File(queueDir(context), "lock-approvals")

        /**
         * Deletes every pending typed request and claimed file (token revoke /
         * new bridge key; the counterpart of RN's revokePendingMCPRequests for
         * requests/). Call only after the owning consumer stopped.
         */
        fun clearPending(context: Context) {
            try {
                for (dir in listOf(typedDir(context), claimedDir(context), handoffsDir(context), lockApprovalsDir(context))) {
                    val files = dir.listFiles() ?: continue
                    for (f in files) {
                        if (isRegular(f)) runCatching { Os.remove(f.path) }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "clearing pending typed requests failed type=${e.javaClass.simpleName}")
            }
        }

        private fun lstatOrNull(f: File): android.system.StructStat? = try { Os.lstat(f.path) } catch (e: Exception) { null }
        private fun isRegular(f: File): Boolean = lstatOrNull(f)?.let { OsConstants.S_ISREG(it.st_mode) } ?: false
        private fun lexists(f: File): Boolean = lstatOrNull(f) != null

        /**
         * The device file system for McpHandoffMove (see its doc for the two
         * routes). renameat2 only on API 30+: below that bionic has no
         * renameat2 and the app seccomp filter may not allow the syscall.
         */
        internal val handoffFs = object : McpHandoffMove.Fs {
            override fun renameNoReplace(src: String, dst: String): Int {
                if (Build.VERSION.SDK_INT < 30) return McpHandoffMove.UNAVAILABLE
                return try {
                    ShellyJNI.renameNoReplace(src, dst)
                } catch (e: Throwable) {
                    // UnsatisfiedLinkError / ExceptionInInitializerError: no native route.
                    Log.w(TAG, "renameNoReplace unavailable type=${e.javaClass.simpleName}")
                    McpHandoffMove.UNAVAILABLE
                }
            }

            override fun exists(path: String): Boolean = try {
                Os.lstat(path)
                true
            } catch (e: android.system.ErrnoException) {
                e.errno != OsConstants.ENOENT
            } catch (e: Exception) {
                true
            }

            override fun rename(src: String, dst: String): Int = try {
                Os.rename(src, dst)
                0
            } catch (e: android.system.ErrnoException) {
                e.errno
            } catch (e: Exception) {
                McpHandoffMove.EIO
            }
        }

        fun agentsDir(context: Context): File = File(HomeInitializer.getHomeDir(context), ".shelly/agents")

        /**
         * `~/.shelly/agents/<id>.json` with a matching id and `enabled: true`,
         * else null (also on any read error). Shared with McpRunLauncher's
         * start-time check.
         */
        internal fun resolveAgentOnDisk(agentsDir: File, agentId: String): JSONObject? = try {
            val bytes = readRegular(File(agentsDir, "$agentId.json"), MAX_AGENT_BYTES)
            if (bytes == null) {
                null
            } else {
                val o = JSONObject(String(bytes, Charsets.UTF_8))
                if (o.opt("id") == agentId && o.opt("enabled") == true) o else null
            }
        } catch (e: Exception) {
            null
        }

        /** The STOP-ALL sentinel; true when it can't be checked. */
        internal fun haltedOnDisk(agentsDir: File): Boolean = try {
            lexists(File(agentsDir, ".halted"))
        } catch (e: Exception) {
            true
        }

        /** Step 7 for [agent] from `policy.json` (McpTypedOpPolicy); UNDECIDABLE on any error. */
        internal fun policyDecisionOnDisk(agentsDir: File, agent: JSONObject): McpTypedOpPolicy.Decision = try {
            val actions = McpTypedOpPolicy.declaredActions(agent)
            val policy = File(agentsDir, "policy.json")
            if (actions.isEmpty() || !lexists(policy)) {
                McpTypedOpPolicy.decide(actions, null)
            } else {
                val bytes = try { readRegular(policy, MAX_POLICY_BYTES) } catch (e: Exception) { null }
                if (bytes == null) {
                    McpTypedOpPolicy.decide(actions, null, policyUnreadable = true)
                } else {
                    McpTypedOpPolicy.decide(actions, String(bytes, Charsets.UTF_8))
                }
            }
        } catch (e: Exception) {
            McpTypedOpPolicy.Decision.UNDECIDABLE
        }

        /** `policy.json` as McpRunLauncher's start-time check sees it. */
        data class PolicyFile(
            /** SHA-256 hex of the bytes, or McpRunAuthorization.POLICY_ABSENT when it does not exist. */
            val pin: String,
            /** Missing, or only whitespace (RN: the empty policy). */
            val blank: Boolean,
            /** Not blank and not a `shelly.user-policy` document with `userPolicy.rules` (McpTypedOpPolicy.isMalformed). */
            val malformed: Boolean,
        )

        /** Null when it exists but can't be read (not regular, symlink, too big, I/O error). */
        internal fun policyFileOnDisk(agentsDir: File): PolicyFile? = try {
            val policy = File(agentsDir, "policy.json")
            if (!lexists(policy)) {
                PolicyFile(McpRunAuthorization.POLICY_ABSENT, blank = true, malformed = false)
            } else {
                readRegular(policy, MAX_POLICY_BYTES)?.let { b ->
                    val text = String(b, Charsets.UTF_8)
                    val pin = java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
                    PolicyFile(pin, blank = text.isBlank(), malformed = McpTypedOpPolicy.isMalformed(text))
                }
            }
        } catch (e: Exception) {
            null
        }

        /** At most [max] bytes of a regular, not symlinked file; null when missing / not regular / larger. */
        private fun readRegular(f: File, max: Int): ByteArray? {
            val st = lstatOrNull(f) ?: return null
            if (!OsConstants.S_ISREG(st.st_mode) || st.st_size > max) return null
            val fd = Os.open(f.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
            // A stream over a FileDescriptor does not own it on Android: closing
            // the stream leaves the fd open, so close it here (as IngressAuditWriter).
            try {
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
            } finally {
                runCatching { Os.close(fd) }
            }
        }
    }

    private val app: Context = context.applicationContext
    private val home: File = HomeInitializer.getHomeDir(app)
    private val typedDir = typedDir(app)
    private val claimedDir = claimedDir(app)
    private val requestsDir = File(queueDir(app), "requests")
    private val resultsDir = File(queueDir(app), "results")
    private val heartbeatFile = File(queueDir(app), "bridge-heartbeat")
    private val handoffsDir = handoffsDir(app)
    private val lockApprovalsDir = lockApprovalsDir(app)
    /** Held across the final re-check → audit → ticket → intent; see the class doc. */
    private val commitLock = Object()
    private val agentsDir = File(home, ".shelly/agents")
    private val random = SecureRandom()

    /**
     * callIds this instance accepted (one per bridge key), each kept until its
     * signed request can no longer be fresh — never evicted by count; full of
     * live entries = new requests are dropped (McpReplayGuard). Handler thread only.
     */
    private val seen = McpReplayGuard()

    @Volatile private var stopped = false
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var observer: FileObserver? = null
    @Volatile private var scanQueued = false

    fun hasKey(key: String): Boolean = key == bridgeKey

    /** The native epoch: false once stopped or replaced. */
    fun isCurrent(): Boolean = !stopped && McpServerSupervisor.isCurrentTypedOpConsumer(this)

    // ── Lifecycle ─────────────────────────────────────────────────────────

    @Synchronized
    fun start() {
        if (stopped || thread != null) return
        try {
            ensurePrivateDir(typedDir)
            ensurePrivateDir(claimedDir)
        } catch (e: Exception) {
            Log.w(TAG, "typed-requests dir not usable type=${e.javaClass.simpleName}; consumer not started")
            return
        }
        val t = HandlerThread("ShellyMcpTypedOps").also { it.start() }
        val h = Handler(t.looper)
        thread = t
        handler = h
        observer = startObserver()
        h.post { sweepOrphans() }
        requestScan()
        h.postDelayed(object : Runnable {
            override fun run() {
                if (stopped) return
                sweepOrphans()
                scanNow()
                h.postDelayed(this, RESCAN_MS)
            }
        }, RESCAN_MS)
        Log.i(TAG, "started")
    }

    /**
     * Stops watching, drops queued work and waits (bounded) for the request in
     * progress. [clearPending]: also delete every pending typed request (new
     * bridge key / token revoke); skipped when the worker did not finish in
     * time (the sweep resolves what is left).
     */
    fun stop(clearPending: Boolean) {
        stopped = true
        // Barrier: wait for a launch already committing (it re-checked before
        // `stopped` flipped); none can begin after this returns.
        synchronized(commitLock) { }
        val t: HandlerThread? = synchronized(this) {
            stopped = true
            runCatching { observer?.stopWatching() }
            observer = null
            handler?.removeCallbacksAndMessages(null)
            handler = null
            val th = thread
            thread = null
            th
        }
        var finished = true
        if (t != null) {
            t.quitSafely()
            if (Thread.currentThread() !== t) {
                runCatching { t.join(STOP_JOIN_MS) }
                finished = !t.isAlive
            }
        }
        // Requests waiting for RN after the foreground step: the epoch ended,
        // answer `revoked` (RN's answer) — only once the worker is gone, so the
        // poll can no longer hand one off. Otherwise just remove the overlays
        // (each also removes itself after its wait).
        if (finished) {
            revokeForegroundWaits()
        } else {
            for (w in foregroundWaits.values) McpApprovalForeground.hide(w.overlay)
            for (w in lockWaits.values) McpLockScreenPrompt.close(app, w.entry)
        }
        if (clearPending && finished) McpTypedOpConsumer.clearPending(app)
        Log.i(TAG, "stopped clearPending=$clearPending finished=$finished")
    }

    private fun startObserver(): FileObserver? = try {
        // inotify can drop events; the periodic rescan (RESCAN_MS) covers that.
        val mask = FileObserver.CREATE or FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE
        val o = if (Build.VERSION.SDK_INT >= 29) {
            object : FileObserver(typedDir, mask) {
                override fun onEvent(event: Int, path: String?) = onDirEvent(event, path)
            }
        } else {
            @Suppress("DEPRECATION")
            object : FileObserver(typedDir.absolutePath, mask) {
                override fun onEvent(event: Int, path: String?) = onDirEvent(event, path)
            }
        }
        o.startWatching()
        o
    } catch (e: Exception) {
        Log.w(TAG, "typed-requests observer not started (the periodic rescan still runs) type=${e.javaClass.simpleName}")
        null
    }

    private fun onDirEvent(event: Int, path: String?) {
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

    // ── Scan, claim, sweep ────────────────────────────────────────────────

    private fun scanNow() {
        if (stopped) return
        val names = try { typedDir.list() } catch (e: Exception) { null } ?: return
        for (name in names.sorted()) {
            if (stopped) return
            if (!McpTypedOpDecision.REQUEST_FILE_RE.matches(name)) continue
            val claimed = claim(name) ?: continue
            try {
                process(name, claimed)
            } catch (e: Throwable) {
                // Never re-run: the claimed file stays for the sweep, nothing is answered.
                Log.w(TAG, "typed request failed type=${e.javaClass.simpleName}")
            }
        }
    }

    /** rename(typed-requests/X, claimed/X.<rand>): the lock. Null = not ours. */
    private fun claim(name: String): File? {
        val source = File(typedDir, name)
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
            val st = lstatOrNull(f) ?: continue
            if (!McpTypedOpDecision.isOrphan(st.st_mtime * 1000L, now)) continue
            // Still waiting for a decision (the lock-screen prompt may stay up to 5 min).
            if (waitingClaimedPaths().contains(f.path)) continue
            audit("mcp_typed_op_dropped", null, null, "orphan")
            runCatching { Os.remove(f.path) }
        }
        // Unconsumed handoff tokens past the client's wait: useless, removed (no audit; no request).
        val tokens = try { handoffsDir.listFiles() } catch (e: Exception) { null }
        for (f in tokens ?: emptyArray()) {
            val st = lstatOrNull(f) ?: continue
            if (McpTypedOpDecision.isOrphan(st.st_mtime * 1000L, now)) runCatching { Os.remove(f.path) }
        }
        // Lock-screen approvals RN never consumed, past any request's approval deadline.
        val approvals = try { lockApprovalsDir.listFiles() } catch (e: Exception) { null }
        for (f in approvals ?: emptyArray()) {
            val st = lstatOrNull(f) ?: continue
            val mtime = st.st_mtime * 1000L
            if (mtime > 0L && now - mtime > McpInstallOpDecision.PRE_APPROVAL_MS + McpTypedOpDecision.ORPHAN_AGE_MS) runCatching { Os.remove(f.path) }
        }
    }

    private fun waitingClaimedPaths(): Set<String> =
        (foregroundWaits.values.map { it.claimed.path } + lockWaits.values.map { it.claimed.path }).toSet()

    // ── One request ───────────────────────────────────────────────────────

    private fun process(name: String, claimed: File) {
        val now = System.currentTimeMillis()
        val bytes = try { readRegular(claimed, MAX_REQUEST_BYTES) } catch (e: Exception) { null }
        val text = bytes?.let { String(it, Charsets.UTF_8) }
        val parsed = if (text == null) {
            McpTypedOpDecision.Parsed.Drop("bad_request")
        } else {
            McpTypedOpDecision.parseRequest(text, name, bridgeKey, now) { seen.isSeen(it) }
        }
        val request = when (parsed) {
            is McpTypedOpDecision.Parsed.Drop -> {
                // RN's processRequestFile: unauthenticated / stale / replayed
                // files are dropped without an answer.
                Log.w(TAG, "dropped typed request file (${parsed.reason})")
                audit("mcp_typed_op_dropped", null, null, parsed.reason)
                delete(claimed)
                return
            }
            is McpTypedOpDecision.Parsed.Ok -> parsed.request
        }
        if (!seen.admit(request.callId, request.receivedAtMs, now)) {
            // Every remembered callId is still inside its validity window:
            // forgetting one would make its captured request replayable, so
            // this one is not run (fail closed, unanswered like a replay).
            Log.w(TAG, "dropped typed request file (replay set full)")
            audit("mcp_typed_op_dropped", null, request.principal, "replay_capacity")
            delete(claimed)
            return
        }
        // Answered already (e.g. a copy of an answered file): never a second writer.
        if (lexists(resultFile(request.callId))) {
            audit("mcp_typed_op_dropped", null, request.principal, "replay")
            delete(claimed)
            return
        }
        // put_stream_feed (StreamFeedCore, C7) has its own decision; everything
        // else is run_agent's (an unknown tool is refused there at ARGS).
        if (request.tool == StreamFeedCore.OP) {
            processStreamFeed(request, name, claimed, now)
            return
        }
        // The launcher submission reader (phase 2 D2) is answered here, never handed to RN.
        if (request.tool in LauncherSubmissionCore.READER_OPS) {
            processSubmissionReader(request, claimed)
            return
        }
        // read_terminal_output while RN is not live (McpNativeReadDecision; phase B-1).
        if (request.tool in McpNativeReadDecision.OPS) {
            processNativeRead(request, claimed)
            return
        }
        // service_control / request_pipeline_refire (ServiceControlDecision; phase A).
        if (request.tool in ServiceControlDecision.OPS) {
            processServiceOp(request, name, claimed, now)
            return
        }
        // update_delivery_script / update_pipeline_config (McpInstallOpDecision; phase B-2)
        // and stage_install (with the foreground-for-approval step).
        if (request.tool in McpInstallOpDecision.OPS) {
            processInstallOp(request, name, claimed, now)
            return
        }
        when (val outcome = McpTypedOpDecision.decide(request, steps, now)) {
            is McpTypedOpDecision.Outcome.Refuse -> {
                refuse(request, claimed, outcome.refusal, outcome.agentId, outcome.taint)
            }
            is McpTypedOpDecision.Outcome.Existing -> {
                writeResult(request.callId, McpTypedOpDecision.existingResult(outcome.ticket, outcome.agentId))
                delete(claimed)
                Log.i(TAG, "run_agent requestId repeated; answered with the existing run")
            }
            is McpTypedOpDecision.Outcome.Execute -> execute(request, claimed, outcome)
            is McpTypedOpDecision.Outcome.Handoff -> handOff(request, name, claimed, outcome.agentId)
        }
    }

    private fun refuse(request: McpTypedOpDecision.Request, claimed: File, r: McpTypedOpDecision.Refusal, agentId: String?, taint: Boolean) {
        audit(if (taint) "ingress_tainted_refused" else "mcp_typed_op_refused", agentId, request.principal, r.code)
        writeResult(request.callId, McpTypedOpDecision.errorResult(r))
        delete(claimed)
        Log.i(TAG, "run_agent refused (${r.code})")
    }

    private fun execute(request: McpTypedOpDecision.Request, claimed: File, x: McpTypedOpDecision.Outcome.Execute) {
        val handle = newHandle()
        var refusal: McpTypedOpDecision.Refusal? = null
        var taint = false
        // beforeWrite runs under McpRunTickets' lock after the requestId and
        // busy checks: the last re-check of everything the rule match relied
        // on, then the audit line — the launch happens only if it was written.
        // What authorized this launch, re-checked by the launcher under the
        // ticket lock and again when the service starts the run.
        val grant = McpRunAuthorization.Grant(
            agentId = x.agentId,
            principal = request.principal,
            deadlineMs = request.receivedAtMs + McpTypedOpDecision.MAX_REQUEST_AGE_MS,
            bind = x.bind,
            ruleId = x.ruleId,
            target = x.target,
            policyPin = McpRunLauncher.actionRule(app, request.principal, x.target, x.bind)?.actionPolicyPin,
        )
        val result = synchronized(commitLock) {
            McpRunLauncher.launch(app, x.agentId, handle, request.principal, x.requestId, grant) {
                refusal = recheck(request.principal, x)
                if (refusal?.code == "tainted") taint = true
                // The epoch once more, last, under commitLock (stop() waits on it).
                if (refusal == null && !isCurrent()) refusal = McpTypedOpDecision.REVOKED
                // The client stops waiting at the signed deadline: never launch after it.
                if (refusal == null && McpTypedOpDecision.isExpired(request.receivedAtMs, System.currentTimeMillis())) {
                    refusal = McpTypedOpDecision.EXPIRED
                }
                if (refusal == null &&
                    !IngressAuditWriter.appendNativeMcpLine(app, "mcp_typed_op_executing", x.agentId, request.principal, null, x.ruleId, x.target)
                ) {
                    refusal = McpTypedOpDecision.AUDIT_FAILED
                }
                refusal == null
            }
        }
        when (result) {
            McpRunLauncher.Result.Started -> {
                writeResult(request.callId, McpTypedOpDecision.startedResult(handle, x.agentId, x.requestId))
                delete(claimed)
                Log.i(TAG, "always-allow rule ${x.ruleId} matched; run_agent started headless")
            }
            is McpRunLauncher.Result.Existing -> {
                writeResult(request.callId, McpTypedOpDecision.existingResult(result.ticket, x.agentId))
                delete(claimed)
            }
            McpRunLauncher.Result.Busy -> refuse(request, claimed, McpTypedOpDecision.BUSY, x.agentId, false)
            McpRunLauncher.Result.Refused -> refuse(request, claimed, refusal ?: McpTypedOpDecision.LAUNCH_FAILED, x.agentId, taint)
            McpRunLauncher.Result.Failed -> refuse(request, claimed, McpTypedOpDecision.LAUNCH_FAILED, x.agentId, false)
        }
    }

    /** Null when the request may still run exactly as matched. */
    private fun recheck(principal: String, x: McpTypedOpDecision.Outcome.Execute): McpTypedOpDecision.Refusal? {
        if (!isCurrent()) return McpTypedOpDecision.REVOKED
        if (!steps.typedOpsOn()) return McpTypedOpDecision.DISABLED
        val agent = steps.resolveAgent(x.agentId) ?: return McpTypedOpDecision.UNKNOWN_AGENT
        if (steps.halted()) return McpTypedOpDecision.HALTED
        if (steps.tainted(x.agentId)) return McpTypedOpDecision.TAINTED
        val approved = steps.actionRule(principal, x.target, x.bind) == x.ruleId
        if (!approved) when (steps.step7(agent)) {
            McpTypedOpPolicy.Decision.POLICY_DENIED -> return McpTypedOpDecision.POLICY_DENIED
            McpTypedOpPolicy.Decision.UNDECIDABLE -> return McpTypedOpDecision.TARGET_CHANGED
            McpTypedOpPolicy.Decision.CLEARABLE -> Unit
        }
        val bind = try { McpAgentBinding.bindingHash(agent) } catch (e: Exception) { null }
        if (bind != x.bind) return McpTypedOpDecision.TARGET_CHANGED
        if (!approved && steps.matchRule(principal, x.target, x.bind) != x.ruleId) return McpTypedOpDecision.TARGET_CHANGED
        return null
    }

    private fun handOff(
        request: McpTypedOpDecision.Request,
        name: String,
        claimed: File,
        agentId: String?,
        feed: Boolean = false,
        svc: ServiceControlDecision.Args? = null,
        install: Boolean = false,
    ) {
        val dest = File(requestsDir, name)
        val token = File(handoffsDir, request.callId)
        // The line first: a line without a move is harmless, a move without a line is not.
        when {
            svc != null -> svcAudit(svc.op, request.principal, svc, "handed_off")
            install -> installAudit(request, "handed_off")
            feed -> feedAudit(request.principal, "handed_off")
            else -> audit("mcp_typed_op_handed_off", agentId, request.principal, null)
        }
        val result = if (writeHandoffToken(token, request.callId)) McpHandoffMove.move(claimed.path, dest.path, handoffFs) else null
        if (result is McpHandoffMove.Result.Moved) {
            // One way: from here on RN alone answers this request.
            Log.i(TAG, "${request.tool} handed to RN (no rule match) route=${result.route}")
            return
        }
        // Its own code and errno, never `not_attended` (that hid this on device, build 2964).
        val why = McpHandoffMove.failureCode(result)
        val errno = (result as? McpHandoffMove.Result.Failed)?.errno ?: -1
        val route = (result as? McpHandoffMove.Result.Failed)?.route ?: "-"
        Log.w(TAG, "handoff move failed code=$why errno=$errno route=$route")
        when {
            svc != null -> svcAudit(svc.op, request.principal, svc, "handoff_failed")
            install -> installAudit(request, "handoff_failed")
            feed -> feedAudit(request.principal, "handoff_failed")
            else -> audit("mcp_typed_op_handoff_failed", agentId, request.principal, why)
        }
        val refusal = McpHandoffMove.refusalAfterFailure(lexists(claimed), lexists(dest))
        if (refusal != null) {
            // Still ours and not in RN's queue: refuse instead (and void the token).
            runCatching { Os.remove(token.path) }
            when {
                // The handoff_failed line was just written: answer without a second one.
                svc != null -> svcAnswer(request, claimed, ServiceControlDecision.errorResult(
                    ServiceControlDecision.Refusal(refusal.code, ServiceControlDecision.HANDOFF_FAILED_MESSAGE)))
                install -> svcAnswer(request, claimed, McpInstallOpDecision.errorResult(
                    McpInstallOpDecision.Refusal(refusal.code, McpInstallOpDecision.HANDOFF_FAILED_MESSAGE)))
                feed -> feedRefuse(request, claimed, refusal)
                else -> refuse(request, claimed, refusal, agentId, false)
            }
        } else {
            Log.w(TAG, "handoff state unknown; not answering (no second writer)")
        }
    }

    // ── put_stream_feed (StreamFeedCore / StreamFeedStore; C7) ────────────

    private fun processStreamFeed(request: McpTypedOpDecision.Request, name: String, claimed: File, now: Long) {
        when (val outcome = StreamFeedCore.decide(request, feedSteps, now)) {
            is StreamFeedCore.Outcome.Refuse -> feedRefuse(request, claimed, outcome.refusal)
            is StreamFeedCore.Outcome.Execute -> feedExecute(request, claimed, outcome)
            StreamFeedCore.Outcome.Handoff -> handOff(request, name, claimed, null, feed = true)
        }
    }

    private fun feedRefuse(request: McpTypedOpDecision.Request, claimed: File, r: McpTypedOpDecision.Refusal) {
        feedAudit(request.principal, r.code)
        writeResult(request.callId, StreamFeedCore.errorResult(r))
        delete(claimed)
        Log.i(TAG, "put_stream_feed refused (${r.code})")
    }

    /**
     * A rule matched: under [commitLock] re-check the epoch, the setting, the
     * deadline and that the same rule still matches, then store (the store
     * re-checks STOP-ALL and writes the `storing` audit line before the
     * write; previous feed kept on any failure).
     */
    private fun feedExecute(request: McpTypedOpDecision.Request, claimed: File, x: StreamFeedCore.Outcome.Execute) {
        val put: Any = synchronized(commitLock) {
            when {
                !isCurrent() -> StreamFeedCore.REVOKED
                !feedSteps.typedOpsOn() -> StreamFeedCore.DISABLED
                McpTypedOpDecision.isExpired(request.receivedAtMs, System.currentTimeMillis()) -> StreamFeedCore.EXPIRED
                feedSteps.matchRule(request.principal) != x.ruleId -> StreamFeedCore.TARGET_CHANGED
                else -> StreamFeedStore.put(app, x.feed, request.principal, request.receivedAtMs + McpTypedOpDecision.MAX_REQUEST_AGE_MS)
            }
        }
        when (put) {
            is StreamFeedStore.PutResult.Stored -> {
                writeResult(request.callId, StreamFeedCore.storedResult(put.sha256, put.bytes, put.receivedAt))
                delete(claimed)
                Log.i(TAG, "always-allow rule ${x.ruleId} matched; stream feed stored headless bytes=${put.bytes}")
            }
            // The store wrote its own audit line for these.
            is StreamFeedStore.PutResult.Refused -> {
                writeResult(request.callId, StreamFeedCore.errorResult(put.refusal))
                delete(claimed)
                Log.i(TAG, "put_stream_feed not stored (${put.refusal.code})")
            }
            is McpTypedOpDecision.Refusal -> feedRefuse(request, claimed, put)
            else -> feedRefuse(request, claimed, StreamFeedCore.STORE_FAILED)
        }
    }

    private val feedSteps = object : StreamFeedCore.Steps {
        override fun typedOpsOn(): Boolean = steps.typedOpsOn()
        override fun epochCurrent(): Boolean = isCurrent()
        // Strict (only ENOENT is "off"), unlike haltedOnDisk.
        override fun halted(): Boolean = StreamFeedStore.haltedStrict(app)
        override fun matchRule(principal: String): String? = try {
            McpAlwaysAllowStore.findMatch(McpAlwaysAllowStore.read(app).rules, principal, StreamFeedCore.OP, StreamFeedCore.TARGET, null)?.id
        } catch (e: Exception) {
            null
        }
        override fun rnLive(): Boolean = steps.rnLive()
    }

    private fun feedAudit(principal: String?, code: String) {
        if (!IngressAuditWriter.appendStreamFeedLine(app, principal, code, null, null, null)) {
            Log.w(TAG, "audit line not written (${IngressAuditWriter.STREAM_FEED_KIND} $code)")
        }
    }

    // ── Launcher submission reader (LauncherSubmissionCore; phase 2 D2) ───

    /**
     * get / list / mark-consumed: the shared stage order (setting → arguments
     * → epoch → STOP-ALL), no always-allow and no approval; then, under
     * [commitLock] and again under the record lock, the epoch, the setting,
     * STOP-ALL and the signed deadline once more before anything is returned
     * or written. One result, the claimed file deleted. Never the text in a
     * log or audit line.
     */
    private fun processSubmissionReader(request: McpTypedOpDecision.Request, claimed: File) {
        val result = synchronized(commitLock) {
            when (val outcome = LauncherSubmissionCore.decideReader(request, readerSteps)) {
                is LauncherSubmissionCore.ReaderOutcome.Refuse ->
                    // Every reader answer is audited; a refusal whose line could not be written is audit_failed.
                    if (LauncherSubmissions.auditRefusal(app, request.tool, request.principal, outcome.id, outcome.refusal.code)) {
                        LauncherSubmissionCore.errorResult(outcome.refusal)
                    } else {
                        LauncherSubmissionCore.errorResult(LauncherSubmissionCore.AUDIT_FAILED)
                    }
                is LauncherSubmissionCore.ReaderOutcome.Proceed -> LauncherSubmissions.answerReader(app, request.principal, outcome.args) {
                    when {
                        !isCurrent() -> LauncherSubmissionCore.REVOKED
                        !readerSteps.typedOpsOn() -> LauncherSubmissionCore.DISABLED
                        readerSteps.halted() -> LauncherSubmissionCore.HALTED
                        McpTypedOpDecision.isExpired(request.receivedAtMs, System.currentTimeMillis()) -> LauncherSubmissionCore.EXPIRED
                        else -> null
                    }
                }
            }
        }
        writeResult(request.callId, result)
        delete(claimed)
        Log.i(TAG, "${request.tool} answered")
    }

    private val readerSteps = object : LauncherSubmissionCore.ReaderSteps {
        override fun typedOpsOn(): Boolean = steps.typedOpsOn()
        override fun epochCurrent(): Boolean = isCurrent()
        // Strict (only ENOENT is "off"; any other lstat failure is STOP-ALL), as put_stream_feed.
        override fun halted(): Boolean = StreamFeedStore.haltedStrict(app)
    }

    // ── read_terminal_output (McpNativeReadDecision, phase B-1) ──────────

    /**
     * The transcript straight from the native session registry: no approval,
     * no handoff, no audit line (RN writes none for reads). One result, the
     * claimed file deleted. Never the text in a log line.
     */
    private fun processNativeRead(request: McpTypedOpDecision.Request, claimed: File) {
        val result = McpNativeReadDecision.answerTerminal(request.args, nativeReadSteps)
        writeResult(request.callId, result)
        delete(claimed)
        Log.i(TAG, "${request.tool} answered natively")
    }

    private val nativeReadSteps = object : McpNativeReadDecision.Steps {
        // RN's settings.mcpReadTerminalEnabled: the wanted server's switch and
        // the Keystore mirror (McpAutostartStore; missing / unreadable = OFF).
        override fun readTerminalOn(): Boolean = try {
            McpServerSupervisor.readTerminalWanted() && (McpAutostartStore.read(app)?.readTerminal == true)
        } catch (e: Exception) {
            false
        }

        override fun epochCurrent(): Boolean = isCurrent()

        // The registry is a plain map the module also touches; read one entry.
        override fun transcript(sessionId: String, maxLines: Int): String? {
            val session = synchronized(TerminalSessionService.sessionRegistry) {
                TerminalSessionService.sessionRegistry[sessionId]
            } ?: return null
            return session.getTranscriptText(maxLines)
        }
    }

    // ── service_control / request_pipeline_refire (ServiceControlDecision) ──

    /**
     * RN's ladder without RN (see ServiceControlDecision): a refusal or
     * `not_attended` is answered here; a rule / "Skip all approvals" match
     * runs here after RN's re-checks (under [commitLock], so once stop()
     * returns nothing of this instance runs); the dialog case is handed to RN
     * only while it is live. Same result JSON and audit codes as RN.
     */
    private fun processServiceOp(request: McpTypedOpDecision.Request, name: String, claimed: File, now: Long) {
        val outcome = try {
            ServiceControlDecision.decide(request, svcSteps, now)
        } catch (e: Exception) {
            // RN's catch around the ladder: native_error (with the checked fields).
            val a = ServiceControlDecision.validate(request.tool, request.args) as? ServiceControlDecision.Args
            ServiceControlDecision.Outcome.Refuse(nativeErrorFor(request.tool), a, audit = a != null)
        }
        when (outcome) {
            is ServiceControlDecision.Outcome.Refuse -> svcRefuse(request, claimed, outcome.refusal, outcome.args, outcome.audit)
            is ServiceControlDecision.Outcome.Execute -> svcExecute(request, claimed, outcome)
            is ServiceControlDecision.Outcome.Handoff -> handOff(request, name, claimed, null, svc = outcome.args)
        }
    }

    private fun nativeErrorFor(tool: String) = ServiceControlDecision.Refusal(
        "native_error",
        if (tool == ServiceControlDecision.OP_PIPELINE_REFIRE) ServiceControlDecision.REFIRE_NATIVE_ERROR else ServiceControlDecision.SERVICE_NATIVE_ERROR,
    )

    /**
     * RN's refuse(): with checked arguments, a request whose epoch ended
     * meanwhile is answered (and audited) as `revoked`; then one line with the
     * code, the error result, the claimed file deleted.
     */
    private fun svcRefuse(
        request: McpTypedOpDecision.Request,
        claimed: File,
        r: ServiceControlDecision.Refusal,
        args: ServiceControlDecision.Args?,
        auditIt: Boolean = true,
    ) {
        val refusal = if (args != null && r.code != "revoked" && !isCurrent()) {
            ServiceControlDecision.Refusal("revoked", ServiceControlDecision.REVOKED_ERROR)
        } else {
            r
        }
        if (auditIt) svcAudit(request.tool, request.principal, args, refusal.code)
        svcAnswer(request, claimed, ServiceControlDecision.errorResult(refusal))
        Log.i(TAG, "${request.tool} refused (${refusal.code})")
    }

    private fun svcAnswer(request: McpTypedOpDecision.Request, claimed: File, json: String) {
        writeResult(request.callId, json)
        delete(claimed)
    }

    private fun svcExecute(request: McpTypedOpDecision.Request, claimed: File, x: ServiceControlDecision.Outcome.Execute) {
        val a = x.args
        // RN writes the stage line before its execute().
        svcAudit(a.op, request.principal, a, x.auditCode)
        if (x.via == ServiceControlDecision.Via.RULE) Log.i(TAG, "always-allow rule ${x.ruleId} matched ${a.op} ${a.target}")
        else Log.i(TAG, "${a.op} ${a.target} auto-approved once (approveAllWithoutAsking)")
        // A Refusal goes through svcRefuse (audited); a String is the final answer (its lines are written).
        val answer: Any = synchronized(commitLock) {
            ServiceControlDecision.recheck(request, x, svcSteps, System.currentTimeMillis())
                ?: when (a) {
                    is ServiceControlDecision.Args.Service -> runService(request, a)
                    is ServiceControlDecision.Args.Refire -> runRefire(request, a)
                }
        }
        when (answer) {
            is ServiceControlDecision.Refusal -> svcRefuse(request, claimed, answer, a)
            is String -> {
                svcAnswer(request, claimed, answer)
                Log.i(TAG, "${a.op} answered headless")
            }
            else -> svcRefuse(request, claimed, nativeErrorFor(a.op), a)
        }
    }

    /** RN's execute() for service_control after the re-checks. Refusal or the final result JSON. */
    private fun runService(request: McpTypedOpDecision.Request, a: ServiceControlDecision.Args.Service): Any {
        val raw = try {
            ManagedServiceSupervisor.control(app, a.action, a.serviceId, request.principal)
        } catch (e: Exception) {
            Log.w(TAG, "service_control native call failed type=${e.javaClass.simpleName}")
            return nativeErrorFor(a.op)
        }
        if (!isCurrent()) return ServiceControlDecision.Refusal("revoked", ServiceControlDecision.REVOKED_ERROR)
        val st = ServiceControlDecision.parseServiceResult(raw, a.serviceId)
            ?: return ServiceControlDecision.Refusal("native_error", ServiceControlDecision.SERVICE_STATE_UNREADABLE)
        // The supervisor wrote the start / stop outcome line; status gets one here.
        if (a.action == "status") svcAudit(a.op, request.principal, a, "status")
        return ServiceControlDecision.serviceResult(a.action, st)
    }

    /** RN's execute() for request_pipeline_refire after the re-checks. */
    private fun runRefire(request: McpTypedOpDecision.Request, a: ServiceControlDecision.Args.Refire): Any {
        val raw = try {
            McpPipelineRefire.request(app, a.pipelineId, request.principal)
        } catch (e: Exception) {
            Log.w(TAG, "request_pipeline_refire native call failed type=${e.javaClass.simpleName}")
            return nativeErrorFor(a.op)
        }
        if (!isCurrent()) return ServiceControlDecision.Refusal("revoked", ServiceControlDecision.REVOKED_ERROR)
        val parsed = ServiceControlDecision.parseRefireResult(raw.code, raw.requestId)
            ?: return ServiceControlDecision.Refusal("native_error", ServiceControlDecision.REFIRE_OUTCOME_UNREADABLE)
        if (!ServiceControlDecision.isRefireAccepted(parsed.code)) return ServiceControlDecision.refireRefusal(a.pipelineId, parsed.code)
        svcAudit(a.op, request.principal, a, parsed.code, parsed.requestId)
        return ServiceControlDecision.refireResult(a.pipelineId, parsed)
    }

    /** The op's own line (`mcp_service_control` / `mcp_pipeline_refire`), as RN writes it. */
    private fun svcAudit(op: String, principal: String?, args: ServiceControlDecision.Args?, code: String, requestId: String? = null) {
        val ok = when (args) {
            is ServiceControlDecision.Args.Service ->
                IngressAuditWriter.appendServiceControlDrainLine(app, principal, args.action, args.serviceId, code)
            is ServiceControlDecision.Args.Refire ->
                IngressAuditWriter.appendPipelineRefireLine(app, principal, args.pipelineId, code, requestId)
            null -> if (op == ServiceControlDecision.OP_PIPELINE_REFIRE) {
                IngressAuditWriter.appendPipelineRefireLine(app, principal, null, code, null)
            } else {
                IngressAuditWriter.appendServiceControlDrainLine(app, principal, null, null, code)
            }
        }
        if (!ok) Log.w(TAG, "audit line not written ($op $code)")
    }

    // ── update_delivery_script / update_pipeline_config (McpInstallOpDecision) ──

    /**
     * RN's ladder up to its tap (see McpInstallOpDecision): a refusal, the
     * pre-approval timeout or `not_attended` is answered here with RN's result
     * JSON and audit line; the tap case is handed to RN only while it is live,
     * and RN runs its whole ladder (content checks, dialog, write) again.
     * Nothing here writes the script or the config.
     */
    private fun processInstallOp(request: McpTypedOpDecision.Request, name: String, claimed: File, now: Long) {
        val outcome = try {
            McpInstallOpDecision.decide(request, installSteps, now)
        } catch (e: Exception) {
            Log.w(TAG, "${request.tool} decision failed type=${e.javaClass.simpleName}")
            null
        }
        when (outcome) {
            is McpInstallOpDecision.Outcome.Answer -> installAnswer(request, claimed, outcome)
            McpInstallOpDecision.Outcome.Handoff -> handOff(request, name, claimed, null, install = true)
            is McpInstallOpDecision.Outcome.Foreground -> startForeground(request, name, claimed, outcome.waitUntilMs)
            is McpInstallOpDecision.Outcome.LockScreen -> startLockScreen(request, name, claimed, outcome.waitUntilMs)
            // Not returned by decide().
            McpInstallOpDecision.Outcome.Wait -> delete(claimed)
            // Fail closed and silent: the client times out; nothing ran.
            null -> delete(claimed)
        }
    }

    /** RN's refusal / timeout / `not_attended` answer, with its audit line(s). */
    private fun installAnswer(request: McpTypedOpDecision.Request, claimed: File, outcome: McpInstallOpDecision.Outcome.Answer) {
        outcome.foregroundFailure?.let { installAudit(request, "foreground_failed", it) }
        installAudit(request, outcome.auditCode)
        val (extra, result) = McpInstallOpDecision.afterAudit(request.tool, outcome, isCurrent())
        if (extra != null) installAudit(request, extra)
        svcAnswer(request, claimed, result)
        Log.i(TAG, "${request.tool} answered natively (${outcome.auditCode}${outcome.foregroundFailure?.let { " after foreground_failed $it" } ?: ""})")
    }

    // ── Foreground for approval (McpApprovalForeground; owner decision 2026-11-29) ──

    /** A request waiting for RN after Shelly was brought to the front. Handler thread only (plus [stop]). */
    private class ForegroundWait(
        val request: McpTypedOpDecision.Request,
        val name: String,
        val claimed: File,
        val waitUntilMs: Long,
        val overlay: McpApprovalForeground.Handle,
        var rnLiveSinceMs: Long? = null,
    )

    private val foregroundWaits = java.util.concurrent.ConcurrentHashMap<String, ForegroundWait>()

    /**
     * RN is not live and the phone is interactive, unlocked and Shelly may draw
     * overlays (McpInstallOpDecision.decide): show the overlay, start the
     * activity, then poll the heartbeat on this thread (other typed requests
     * are not held up) until afterForeground() hands off or answers.
     */
    private fun startForeground(request: McpTypedOpDecision.Request, name: String, claimed: File, waitUntilMs: Long) {
        val overlay = try {
            McpApprovalForeground.show(app, waitUntilMs)
        } catch (e: Exception) {
            Log.w(TAG, "${request.tool} foreground failed type=${e.javaClass.simpleName}")
            null
        }
        if (overlay == null) {
            installAnswer(request, claimed, McpInstallOpDecision.notAttended(request.tool, McpInstallOpDecision.FG_START_FAILED))
            return
        }
        installAudit(request, "foregrounded")
        Log.i(TAG, "${request.tool} needs the tap: Shelly brought to the front, waiting for RN")
        val w = ForegroundWait(request, name, claimed, waitUntilMs, overlay)
        foregroundWaits[request.callId] = w
        pollForeground(w)
    }

    private fun pollForeground(w: ForegroundWait) {
        if (stopped) return
        val now = System.currentTimeMillis()
        if (w.rnLiveSinceMs == null && steps.rnLive()) w.rnLiveSinceMs = now
        val outcome = try {
            McpInstallOpDecision.afterForeground(w.request, installSteps, now, w.waitUntilMs, w.rnLiveSinceMs)
        } catch (e: Exception) {
            Log.w(TAG, "${w.request.tool} foreground poll failed type=${e.javaClass.simpleName}")
            null
        }
        if (outcome == McpInstallOpDecision.Outcome.Wait) {
            val h = synchronized(this) { handler }
            if (h != null && h.postDelayed({ pollForeground(w) }, McpInstallOpDecision.FOREGROUND_POLL_MS)) return
            // No thread to poll on (stopping): stop() answers what is left.
            return
        }
        if (foregroundWaits.remove(w.request.callId) == null) return
        McpApprovalForeground.hide(w.overlay)
        when (outcome) {
            is McpInstallOpDecision.Outcome.Answer -> installAnswer(w.request, w.claimed, outcome)
            McpInstallOpDecision.Outcome.Handoff -> handOff(w.request, w.name, w.claimed, null, install = true)
            // Fail closed and silent (as processInstallOp): the client times out; nothing ran.
            else -> delete(w.claimed)
        }
    }

    /** stop(): the epoch ended while requests waited (for RN or a lock-screen decision) — RN's answer is `revoked`. */
    private fun revokeForegroundWaits() {
        for (callId in foregroundWaits.keys.toList()) {
            val w = foregroundWaits.remove(callId) ?: continue
            McpApprovalForeground.hide(w.overlay)
            runCatching {
                installAudit(w.request, "revoked")
                svcAnswer(w.request, w.claimed, McpInstallOpDecision.revokedResult())
            }
        }
        for (callId in lockWaits.keys.toList()) {
            val w = lockWaits.remove(callId) ?: continue
            McpLockScreenPrompt.close(app, w.entry)
            runCatching {
                installAudit(w.request, "revoked")
                svcAnswer(w.request, w.claimed, McpInstallOpDecision.revokedResult())
            }
        }
    }

    // -- Lock-screen approval (McpLockScreenApproval / McpLockScreenPrompt; owner decision 2026-11-29) --

    private class LockWait(
        val request: McpTypedOpDecision.Request,
        val name: String,
        val claimed: File,
        val waitUntilMs: Long,
        val entry: McpLockScreenPrompt.Entry,
    )

    private val lockWaits = java.util.concurrent.ConcurrentHashMap<String, LockWait>()

    /**
     * Locked (or screen off), RN not live, notifications and the full-screen
     * intent allowed (McpInstallOpDecision.decide): post the full-screen
     * prompt, then poll its decision on this thread until afterLockScreen()
     * hands off (approved after the keyguard was dismissed), answers RN's
     * `denied`, or gives up at the wait's end.
     */
    private fun startLockScreen(request: McpTypedOpDecision.Request, name: String, claimed: File, waitUntilMs: Long) {
        val entry = try {
            McpLockScreenPrompt.open(app, request, waitUntilMs)
        } catch (e: Exception) {
            Log.w(TAG, "${request.tool} lock-screen prompt failed type=${e.javaClass.simpleName}")
            null
        }
        if (entry == null) {
            installAnswer(request, claimed, McpInstallOpDecision.notAttended(request.tool, McpInstallOpDecision.FG_START_FAILED))
            return
        }
        installAudit(request, "lock_screen_shown")
        Log.i(TAG, "${request.tool} needs the tap: lock-screen prompt shown")
        val w = LockWait(request, name, claimed, waitUntilMs, entry)
        lockWaits[request.callId] = w
        pollLock(w)
    }

    private fun pollLock(w: LockWait) {
        if (stopped) return
        val now = System.currentTimeMillis()
        val outcome = try {
            McpInstallOpDecision.afterLockScreen(w.request, installSteps, now, w.waitUntilMs, w.entry.machine.state(now))
        } catch (e: Exception) {
            Log.w(TAG, "${w.request.tool} lock-screen poll failed type=${e.javaClass.simpleName}")
            null
        }
        if (outcome == McpInstallOpDecision.Outcome.Wait) {
            val h = synchronized(this) { handler }
            if (h != null && h.postDelayed({ pollLock(w) }, McpLockScreenApproval.POLL_MS)) return
            return // stopping: stop() answers what is left
        }
        if (lockWaits.remove(w.request.callId) == null) return
        McpLockScreenPrompt.close(app, w.entry)
        when (outcome) {
            McpInstallOpDecision.Outcome.Handoff -> {
                installAudit(w.request, "lock_screen_approved")
                val expiresAt = w.request.receivedAtMs + McpInstallOpDecision.PRE_APPROVAL_MS
                if (writeLockApproval(w.request, expiresAt)) {
                    handOff(w.request, w.name, w.claimed, null, install = true)
                } else {
                    // Without the token RN would ask again; nobody is there to tap: say so.
                    installAudit(w.request, "handoff_failed")
                    svcAnswer(w.request, w.claimed, McpInstallOpDecision.errorResult(
                        McpInstallOpDecision.Refusal("handoff_failed", McpInstallOpDecision.HANDOFF_FAILED_MESSAGE)))
                }
            }
            is McpInstallOpDecision.Outcome.Answer -> {
                if (outcome.auditCode == "denied") installAudit(w.request, "lock_screen_denied")
                installAnswer(w.request, w.claimed, outcome)
            }
            else -> delete(w.claimed)
        }
    }

    /** `lock-approvals/<callId>` = McpLockScreenApproval.token, created 0600, never over an existing file. */
    private fun writeLockApproval(request: McpTypedOpDecision.Request, expiresAtMs: Long): Boolean = try {
        ensurePrivateDir(lockApprovalsDir)
        val file = File(lockApprovalsDir, request.callId)
        if (lexists(file)) Os.remove(file.path) // stale or planted: never trusted, replaced
        val fd = Os.open(
            file.path,
            OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
            384, /* 0600 */
        )
        try {
            val value = McpLockScreenApproval.token(bridgeKey, request.callId, request.tool, expiresAtMs)
            FileOutputStream(fd).use { it.write(value.toByteArray(Charsets.US_ASCII)) }
        } finally {
            runCatching { Os.close(fd) } // the stream does not own the fd
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "lock-screen approval not written type=${e.javaClass.simpleName}")
        false
    }

    /** The op's own line (`mcp_update_delivery_script` / `mcp_update_pipeline_config` / `mcp_stage_install`), RN's shape. */
    private fun installAudit(request: McpTypedOpDecision.Request, code: String, reason: String? = null) {
        val ok = IngressAuditWriter.appendMcpLine(app, null, McpInstallOpDecision.auditJson(request.tool, request.principal, code, reason))
        if (!ok) Log.w(TAG, "audit line not written (${request.tool} $code)")
    }

    private val installSteps = object : McpInstallOpDecision.Steps {
        override fun epochCurrent(): Boolean = isCurrent()
        override fun execOn(): Boolean = svcSteps.execOn()
        override fun rnLive(): Boolean = steps.rnLive()
        override fun foregroundBlocker(): String? = try {
            McpApprovalForeground.blocker(app)
        } catch (e: Exception) {
            McpInstallOpDecision.FG_START_FAILED
        }
        override fun lockScreenBlocker(): String? = try {
            McpLockScreenPrompt.blocker(app)
        } catch (e: Exception) {
            McpInstallOpDecision.FG_START_FAILED
        }
    }

    private val svcSteps = object : ServiceControlDecision.Steps {
        override fun epochCurrent(): Boolean = isCurrent()

        // RN's settings.mcpExecEnabled: the wanted server's switch and the
        // Keystore mirror RN writes on every settings change and app start
        // (McpAutostartStore; missing / unreadable = OFF, fail closed).
        override fun execOn(): Boolean = try {
            McpServerSupervisor.execWanted() && (McpAutostartStore.read(app)?.exec == true)
        } catch (e: Exception) {
            false
        }

        override fun typedOpsOn(): Boolean = steps.typedOpsOn()

        // `.halted` present, or it cannot be checked.
        override fun halted(): Boolean = StopAllSwitches.halted(app)

        override fun matchRule(principal: String, op: String, target: String, bind: String): String? = try {
            McpAlwaysAllowStore.findMatch(McpAlwaysAllowStore.read(app).rules, principal, op, target, bind)?.id
        } catch (e: Exception) {
            null
        }

        override fun approveAllOn(): Boolean = try {
            ApproveAllStore.isOn(app)
        } catch (e: Exception) {
            false
        }

        override fun rnLive(): Boolean = steps.rnLive()
    }

    // ── Facts (each fails closed) ─────────────────────────────────────────

    private val steps = object : McpTypedOpDecision.Steps {
        // Both the wanted server's switch and the Keystore mirror RN writes on
        // every settings change (OFF / unreadable = disabled, fail closed).
        override fun typedOpsOn(): Boolean = try {
            McpServerSupervisor.typedOpsWanted() && (McpAutostartStore.read(app)?.typedOps == true)
        } catch (e: Exception) {
            false
        }

        override fun epochCurrent(): Boolean = isCurrent()

        override fun resolveAgent(agentId: String): JSONObject? = resolveAgentOnDisk(agentsDir, agentId)

        override fun halted(): Boolean = haltedOnDisk(agentsDir)

        override fun tainted(agentId: String): Boolean = AgentIngressTaint.runTaintReason(app, agentId) != null

        override fun actionRule(principal: String, target: String, bind: String): String? = try {
            McpRunLauncher.actionRule(app, principal, target, bind)?.id
        } catch (e: Exception) { null }

        override fun step7(agent: JSONObject): McpTypedOpPolicy.Decision = policyDecisionOnDisk(agentsDir, agent)

        override fun existingTicket(principal: String, requestId: String): McpRunTickets.Ticket? =
            McpRunTickets.findIdempotentForMcp(app, principal, requestId)

        override fun matchRule(principal: String, target: String, bind: String): String? = try {
            McpAlwaysAllowStore.findMatch(McpAlwaysAllowStore.read(app).rules, principal, "run_agent", target, bind)?.takeIf { it.actionPolicyPin == null }?.id
        } catch (e: Exception) {
            null
        }

        override fun rnLive(): Boolean = try {
            val bytes = readRegular(heartbeatFile, HEARTBEAT_MAX_BYTES)
            McpTypedOpDecision.isRnLive(bytes?.let { String(it, Charsets.US_ASCII) }, System.currentTimeMillis())
        } catch (e: Exception) {
            false
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private fun newHandle(): String {
        val b = ByteArray(16).also { random.nextBytes(it) }
        return "mr_" + b.joinToString("") { "%02x".format(it) }
    }

    private fun resultFile(callId: String): File = File(resultsDir, "$callId.json")

    /**
     * Creates `results/<callId>.json` in place with O_CREAT | O_EXCL: it is
     * written only if no result exists, and never replaces one (an atomic
     * no-replace; the script retries a half-written read until its deadline).
     * Best effort: a failure leaves the client to its 100 s timeout.
     */
    private fun writeResult(callId: String, json: String) {
        val final = resultFile(callId)
        try {
            if (!resultsDir.isDirectory) resultsDir.mkdirs()
            val fd = Os.open(
                final.path,
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
                384, /* 0600 */
            )
            try {
                FileOutputStream(fd).use { it.write(json.toByteArray(Charsets.UTF_8)) }
            } finally {
                runCatching { Os.close(fd) } // the stream does not own the fd
            }
            McpFdProbe.log(TAG, "result")
        } catch (e: Exception) {
            val errno = (e as? android.system.ErrnoException)?.errno
            if (errno == OsConstants.EEXIST) Log.w(TAG, "result already present; not overwritten")
            else Log.w(TAG, "result not written type=${e.javaClass.simpleName}")
        }
    }

    /** handoffs/<callId> = the HMAC token, created fresh (0600, no symlink follow). */
    private fun writeHandoffToken(token: File, callId: String): Boolean = try {
        ensurePrivateDir(handoffsDir)
        if (lexists(token)) Os.remove(token.path) // stale or planted: never trusted, replaced
        val fd = Os.open(
            token.path,
            OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
            384, /* 0600 */
        )
        try {
            val value = McpTypedOpDecision.handoffToken(bridgeKey, callId)
            if (!Regex(TOKEN_RE_SRC).matches(value)) throw IllegalStateException("token")
            FileOutputStream(fd).use { it.write(value.toByteArray(Charsets.US_ASCII)) }
        } finally {
            runCatching { Os.close(fd) } // the stream does not own the fd
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "handoff token not written type=${e.javaClass.simpleName}")
        false
    }

    private fun delete(f: File) {
        try {
            Os.remove(f.path)
        } catch (e: Exception) {
            // The sweep removes it after 120 s; it is never re-run (it is in claimed/).
        }
    }

    private fun audit(kind: String, agentId: String?, principal: String?, code: String?) {
        if (!IngressAuditWriter.appendNativeMcpLine(app, kind, agentId, principal, code)) {
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
