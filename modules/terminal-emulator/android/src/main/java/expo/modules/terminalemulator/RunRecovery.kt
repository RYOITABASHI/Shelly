package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * S5 executor recovery (fact sheet executor-recovery + S5-0 supplement).
 *
 * The PlanSpec executor cannot record its own instant death (SIGKILL, LMK, a
 * process-tree teardown, the host app dying, the native 30-minute timeout).
 * This object is the outside observer, and the decisions themselves live in
 * scripts/shelly-run-recovery.js (`$HOME/.shelly-run-recovery.js`, unit-tested
 * there); this side only supplies what needs the device:
 *
 *  - a launch record per executor launch (`logs/<id>/run-launches.jsonl`:
 *    launch id, scheduled occurrence, origin, the run it re-fires) written
 *    right before the executor starts, so a dead run can be tied to its slot;
 *  - `finalize` after every runPlanAgent executor exit (0 included): the
 *    driver's terminal record + `plan_orphaned` for a run with no end;
 *  - `sweep` on every schedule reconcile (app start, boot, package replaced,
 *    the hourly watchdog): closes runs whose executor is gone;
 *  - the hang watchdog (a thread of runPlanAgent, no new process): from 10
 *    minutes into a run, once a minute, checks whether the executor still has
 *    a worker process (a descendant other than the agent driver) and asks the
 *    script; tier 1 (no worker + no progress for 10 min): freezes the
 *    executor tree (SIGSTOP), re-checks the worker and the progress stream,
 *    then either kills the tree and has the script close the run as
 *    `plan_hung`, or resumes it (SIGCONT) and has the script record
 *    `plan_hung_cancelled`; tier 2 (worker alive + no progress for 30 min) is
 *    recorded only;
 *  - the one-time re-fire the script decided (`refire`), dispatched as an
 *    ACTION_RUN_AGENT carrying the original run id, and the dispatch outcome
 *    reported back (`refire-result`) so the record says what happened.
 *
 * Everything here is best-effort: a failure logs and changes nothing about
 * the run itself.
 */
object RunRecovery {
    private const val TAG = "RunRecovery"
    const val SCRIPT_NAME = ".shelly-run-recovery.js"
    private const val OP_TIMEOUT_MS = 60_000
    private const val WATCHDOG_TICK_MS = 60_000L
    /** S5-0 §2 tier 1: the earliest a run can be hung. */
    const val HANG_ABORT_NO_PROGRESS_MS = 10L * 60L * 1000L
    /** S5-0 §2 tier 2: a run with a live worker is only checked from here on. */
    const val HANG_SUSPECT_NO_PROGRESS_MS = 30L * 60L * 1000L
    private const val LAUNCH_FILE = "run-launches.jsonl"
    private const val LAUNCH_PREV_FILE = "run-launches.prev.jsonl"
    private const val LAUNCH_FILE_MAX_BYTES = 64L * 1024L
    private const val AGENT_DRIVER_SCRIPT = "shelly-agent-driver.js"
    private const val EXECUTOR_SCRIPT = "shelly-plan-executor.js"

    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val RUN_ID_RE = Regex("^[A-Za-z0-9_.:#-]{1,200}$")
    private val random = SecureRandom()
    private val launchFileLock = Any()

    data class Refire(val agentId: String, val origRunId: String, val refireRunId: String, val scheduledAt: Long)
    data class OpResult(
        val ok: Boolean,
        val verdict: String?,
        val refires: List<Refire>,
        /** hang-check `hung`: the run it names and the progress stream size it read. */
        val runStartTs: String? = null,
        val progressBytes: Long = -1L,
        val noProgressMs: Long = -1L,
        /** sweep: MCP re-fire requests left waiting (a live executor of their agent). */
        val pendingRequests: Int = 0
    )

    private val FAILED = OpResult(false, null, emptyList())
    private const val PROGRESS_FILE = "progress.jsonl"
    private const val PROGRESS_RECHECK_MAX_BYTES = 256L * 1024L

    fun isValidRunId(v: String?): Boolean = v != null && RUN_ID_RE.matches(v)

    fun newLaunchId(agentId: String, startedAtMs: Long): String {
        val b = ByteArray(3)
        random.nextBytes(b)
        return "$agentId-$startedAtMs-" + b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /**
     * Appends this launch to `logs/<agentId>/run-launches.jsonl` (rotated to
     * `.prev` past 64 KB). [startedAtMs] must be taken before the executor
     * starts: the script ties a run to the latest launch at or before its
     * plan_start.
     */
    fun writeLaunchRecord(
        homeDir: File,
        agentId: String,
        launchId: String,
        startedAtMs: Long,
        scheduledAtMs: Long?,
        origin: String,
        unattended: Boolean,
        refireOf: String?
    ) {
        if (!AGENT_ID_RE.matches(agentId) || !isValidRunId(launchId)) return
        try {
            synchronized(launchFileLock) {
                val dir = File(homeDir, ".shelly/agents/logs/$agentId")
                dir.mkdirs()
                val file = File(dir, LAUNCH_FILE)
                if (file.isFile && file.length() > LAUNCH_FILE_MAX_BYTES) {
                    file.renameTo(File(dir, LAUNCH_PREV_FILE))
                }
                val o = JSONObject()
                    .put("v", 1)
                    .put("launchId", launchId)
                    .put("agentId", agentId)
                    .put("startedAt", startedAtMs)
                    .put("scheduledAt", if (scheduledAtMs != null && scheduledAtMs > 0) scheduledAtMs else JSONObject.NULL)
                    .put("origin", origin.take(32))
                    .put("unattended", unattended)
                    .put("refireOf", if (isValidRunId(refireOf)) refireOf else JSONObject.NULL)
                file.appendText(o.toString() + "\n")
            }
        } catch (e: Exception) {
            Log.w(TAG, "launch record for $agentId failed type=${e.javaClass.simpleName}")
        }
    }

    /**
     * Appends the end of this launch (`{"event":"end", launchId, endedAt}`) to
     * the same file, after the executor process returned (any way). The script
     * ties a run to a launch only when its plan_start lies between the launch's
     * start and end records (matchLaunches); a launch with no end record (native
     * died with it) stays open-ended.
     */
    fun endLaunch(homeDir: File, agentId: String, launchId: String, endedAtMs: Long) {
        if (!AGENT_ID_RE.matches(agentId) || !isValidRunId(launchId)) return
        try {
            synchronized(launchFileLock) {
                val dir = File(homeDir, ".shelly/agents/logs/$agentId")
                dir.mkdirs()
                val o = JSONObject()
                    .put("v", 1)
                    .put("event", "end")
                    .put("launchId", launchId)
                    .put("agentId", agentId)
                    .put("endedAt", endedAtMs)
                File(dir, LAUNCH_FILE).appendText(o.toString() + "\n")
            }
        } catch (e: Exception) {
            Log.w(TAG, "launch end record for $agentId failed type=${e.javaClass.simpleName}")
        }
    }

    data class Launch(val launchId: String, val startedAtMs: Long, val watchdog: Watchdog)

    /**
     * runPlanAgent, right before the executor starts: the launch record (its
     * time precedes the run's plan_start; a re-fire keeps the id it was given
     * when it was decided) and the hang watchdog for this launch.
     */
    fun beginLaunch(
        context: Context,
        homeDir: File,
        agentId: String,
        recoveryLaunchId: String?,
        scheduledAtMs: Long?,
        origin: String,
        unattended: Boolean,
        refireOf: String?
    ): Launch {
        val startedAtMs = System.currentTimeMillis()
        val launchId = recoveryLaunchId?.takeIf { isValidRunId(it) } ?: newLaunchId(agentId, startedAtMs)
        writeLaunchRecord(homeDir, agentId, launchId, startedAtMs, scheduledAtMs, origin, unattended, refireOf)
        return Launch(launchId, startedAtMs, startWatchdog(context, homeDir, agentId, startedAtMs, launchId))
    }

    // ── the script ───────────────────────────────────────────────────────

    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"

    private fun runOp(context: Context, homeDir: File, args: List<String>): OpResult =
        runOpLine(context, homeDir, args)?.let { parseResult(it) } ?: FAILED

    /** Runs one script op; its last non-blank stdout line, or null. */
    private fun runOpLine(context: Context, homeDir: File, args: List<String>): String? {
        val script = File(homeDir, SCRIPT_NAME)
        if (!script.isFile) {
            Log.w(TAG, "recovery script missing; skipped ${args.firstOrNull { !it.startsWith("--") } ?: ""}")
            return null
        }
        val libPath = LibExtractor.getLibDir(context).absolutePath
        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
            // Same reason as runPlanAgent: the exec wrapper's LD_PRELOAD aborts bionic node.
            append(" && unset LD_PRELOAD && /system/bin/linker64 ")
            append(shellQuote("$libPath/node"))
            append(" ")
            append(shellQuote(script.absolutePath))
            append(" --home ")
            append(shellQuote(homeDir.absolutePath))
            append(" --executor ")
            append(shellQuote(File(homeDir, ".shelly-plan-executor.js").absolutePath))
            for (a in args) {
                append(" ")
                append(shellQuote(a))
            }
        }
        val result = try {
            ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                LibExtractor.getBashPath(context),
                libPath,
                homeDir.absolutePath,
                command,
                OP_TIMEOUT_MS
            )
        } catch (e: Throwable) {
            Log.e(TAG, "recovery script failed to start type=${e.javaClass.simpleName}")
            return null
        }
        val stdout = result.getOrNull(1).orEmpty()
        return stdout.lineSequence().lastOrNull { it.isNotBlank() }
    }

    /** The script's one JSON line → [OpResult]. Never throws. */
    fun parseResult(line: String): OpResult = try {
        val o = JSONObject(line)
        val refires = ArrayList<Refire>()
        val arr = o.optJSONArray("refire")
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val r = arr.optJSONObject(i) ?: continue
                val agentId = r.optString("agentId", "")
                val orig = r.optString("origRunId", "")
                val refireRunId = r.optString("refireRunId", "")
                val scheduledAt = r.optLong("scheduledAt", 0L)
                if (AGENT_ID_RE.matches(agentId) && isValidRunId(orig) && isValidRunId(refireRunId) && scheduledAt > 0) {
                    refires.add(Refire(agentId, orig, refireRunId, scheduledAt))
                }
            }
        }
        OpResult(
            o.optBoolean("ok", false),
            if (o.has("verdict")) o.optString("verdict") else null,
            refires,
            o.optString("runStartTs", "").takeIf { it.isNotEmpty() && it.length <= 64 },
            o.optLong("progressBytes", -1L),
            o.optLong("noProgressMs", -1L),
            o.optInt("pendingRequests", 0).coerceAtLeast(0)
        )
    } catch (e: Exception) {
        FAILED
    }

    /**
     * After every runPlanAgent executor exit (0 included): closes this
     * launch's run when it left no plan_finish, and adds the exit record to a
     * run already closed by the watchdog or a sweep. [runStartTs] is this
     * launch's own declaration of its run when it has one (the run its
     * watchdog aborted): the exit is then attributed to that run even when
     * its launch record could not be tied to it.
     */
    fun finalize(context: Context, homeDir: File, agentId: String, exitCode: Int, launchStartedAtMs: Long, launchId: String, timedOut: Boolean, runStartTs: String? = null): OpResult {
        val args = arrayListOf(
            "--op", "finalize",
            "--agent-id", agentId,
            "--exit-code", exitCode.toString(),
            "--launch-started-at-ms", launchStartedAtMs.toString(),
            "--launch-id", launchId,
            "--timed-out", if (timedOut) "1" else "0"
        )
        if (runStartTs != null && runStartTs.isNotEmpty() && runStartTs.length <= 64) {
            args.add("--run-start-ts")
            args.add(runStartTs)
        }
        val r = runOp(context, homeDir, args)
        if (!r.ok) Log.w(TAG, "finalize for $agentId did not complete")
        return r
    }

    private fun hangCheck(context: Context, homeDir: File, agentId: String, workerAlive: Boolean, launchStartedAtMs: Long): OpResult =
        runOp(context, homeDir, listOf(
            "--op", "hang-check",
            "--agent-id", agentId,
            "--worker-alive", if (workerAlive) "1" else "0",
            "--launch-started-at-ms", launchStartedAtMs.toString()
        ))

    /**
     * [launchId] / [launchStartedAtMs] name the watchdog's own launch: the
     * script lets this declaration win over a launch matching that ties the
     * run elsewhere (plan_exit_attribution_conflict, no borrowed identity).
     */
    private fun hangAbort(context: Context, homeDir: File, agentId: String, runStartTs: String, noProgressMs: Long, launchId: String, launchStartedAtMs: Long): OpResult =
        runOp(context, homeDir, listOf(
            "--op", "hang-abort",
            "--agent-id", agentId,
            "--run-start-ts", runStartTs,
            "--no-progress-ms", noProgressMs.coerceAtLeast(0L).toString(),
            "--launch-id", launchId,
            "--launch-started-at-ms", launchStartedAtMs.toString()
        ))

    private fun hangCancel(context: Context, homeDir: File, agentId: String, runStartTs: String, why: String): OpResult =
        runOp(context, homeDir, listOf(
            "--op", "hang-cancel",
            "--agent-id", agentId,
            "--run-start-ts", runStartTs,
            "--why", why
        ))

    /**
     * True when the progress stream moved past [bytesSeen] (the size the
     * hang-check read) with anything other than a heartbeat, or shrank
     * (rotated: a new run). An unreadable or unparsable tail counts as
     * progress (never kill on doubt).
     */
    fun progressAdvanced(homeDir: File, agentId: String, bytesSeen: Long): Boolean {
        if (bytesSeen < 0) return true
        return try {
            val f = File(homeDir, ".shelly/agents/logs/$agentId/$PROGRESS_FILE")
            val len = f.length()
            if (len < bytesSeen) return true
            if (len == bytesSeen) return false
            if (len - bytesSeen > PROGRESS_RECHECK_MAX_BYTES) return true
            val buf = ByteArray((len - bytesSeen).toInt())
            java.io.RandomAccessFile(f, "r").use { raf ->
                raf.seek(bytesSeen)
                raf.readFully(buf)
            }
            String(buf, Charsets.UTF_8).split('\n').any { line ->
                if (line.isBlank()) return@any false
                try {
                    JSONObject(line).optString("kind", "") != "heartbeat"
                } catch (e: Exception) {
                    true
                }
            }
        } catch (e: Exception) {
            true
        }
    }

    /**
     * The startup sweep (S5-0 §2 (c)): on a schedule reconcile, off the main
     * thread. Closes every agent's dead open run, dispatches the re-fires the
     * script decided, and ends the MCP run tickets a dead process left
     * `running` (McpRunTickets.reconcileAfterRestart).
     */
    fun sweepInBackground(context: Context, reason: String) {
        val app = context.applicationContext
        Thread({
            try {
                val homeDir = HomeInitializer.getHomeDir(app)
                runCatching { McpRunTickets.reconcileAfterRestart(app) }
                    .onFailure { Log.w(TAG, "ticket reconcile failed type=${it.javaClass.simpleName}") }
                val r = runOp(app, homeDir, listOf("--op", "sweep"))
                Log.i(TAG, "sweep ($reason) ok=${r.ok} refires=${r.refires.size} pendingRequests=${r.pendingRequests}")
                dispatchRefires(app, r.refires)
                // An MCP re-fire request still waiting (its agent's executor
                // was alive) is taken by a later reconcile pass.
                if (r.pendingRequests > 0) armRequestFollowUp(app)
            } catch (e: Throwable) {
                Log.e(TAG, "sweep ($reason) failed type=${e.javaClass.simpleName}")
            }
        }, "shelly-run-recovery-sweep").start()
    }

    // ── an MCP-requested re-fire (search parity item 4) ──────────────────

    /** What `--op refire-request` answered: [code] accepted, duplicate or a refusal code. */
    data class RefireRequestResult(val code: String, val requestId: String?)

    private val REQUEST_CODE_RE = Regex("^[a-z_]{1,32}$")
    private val REQUEST_ID_RE = Regex("^rq-[0-9]{1,16}-[0-9a-f]{8}$")
    private val PRINCIPAL_RE = Regex("^[0-9a-f]{32}$")
    private val PIPELINE_ID_RE = Regex("^[a-z0-9-]{1,32}$")
    /** A request a sweep could not take yet is looked at again by this reconcile tick. */
    private const val REQUEST_FOLLOW_UP_MS = 5L * 60L * 1000L

    /**
     * Records an MCP re-fire request for [agentId] (the caller resolved
     * [pipelineId] to it and checked the web-search opt-in) through the
     * recovery script, under its lock. An accepted request is in the agent's
     * audit before this returns (it outlives a kill); a sweep is started now
     * to turn it into an S5 re-fire, and a reconcile tick is armed as the
     * fallback. Blocking: call off the main thread. Never throws.
     */
    fun requestRefire(context: Context, agentId: String, pipelineId: String, principal: String?): RefireRequestResult {
        if (!AGENT_ID_RE.matches(agentId) || !PIPELINE_ID_RE.matches(pipelineId)) return RefireRequestResult("invalid_params", null)
        val app = context.applicationContext
        return try {
            val homeDir = HomeInitializer.getHomeDir(app)
            val args = mutableListOf("--op", "refire-request", "--agent-id", agentId, "--pipeline-id", pipelineId)
            if (principal != null && PRINCIPAL_RE.matches(principal)) args += listOf("--principal", principal)
            val r = runOpLine(app, homeDir, args)?.let { parseRefireRequest(it) } ?: RefireRequestResult("native_error", null)
            Log.i(TAG, "re-fire request agent=$agentId pipeline=$pipelineId code=${r.code}")
            if (r.code == "accepted") {
                armRequestFollowUp(app)
                sweepInBackground(app, "mcp-refire")
            }
            r
        } catch (e: Throwable) {
            Log.e(TAG, "re-fire request failed type=${e.javaClass.simpleName}")
            RefireRequestResult("native_error", null)
        }
    }

    /** The script's refire-request line → [RefireRequestResult]; native_error when it is not one. Never throws. */
    fun parseRefireRequest(line: String): RefireRequestResult = try {
        val o = JSONObject(line)
        val code = o.optString("code", "")
        if (!o.optBoolean("ok", false) || o.optString("op", "") != "refire-request" || !REQUEST_CODE_RE.matches(code)) {
            RefireRequestResult("native_error", null)
        } else {
            RefireRequestResult(code, o.optString("requestId", "").takeIf { REQUEST_ID_RE.matches(it) })
        }
    } catch (e: Exception) {
        RefireRequestResult("native_error", null)
    }

    private fun armRequestFollowUp(context: Context) {
        runCatching { AgentAlarmScheduler.armReconcileWatchdogNoLaterThan(context, System.currentTimeMillis() + REQUEST_FOLLOW_UP_MS) }
            .onFailure { Log.w(TAG, "re-fire request follow-up not armed type=${it.javaClass.simpleName}") }
    }

    /** How a dispatch ended: the service took it, it was refused / threw, or we could not tell. */
    enum class Dispatch(val arg: String) { OK("1"), FAILED("0"), UNKNOWN("unknown") }

    private const val DISPATCH_WAIT_MS = 10_000L

    /**
     * Dispatches each decided re-fire as an ACTION_RUN_AGENT through
     * TerminalSessionService (every service and runtime gate applies: STOP-ALL,
     * enabled, backoff), then reports the outcome to the script
     * (`--op refire-result`). The script recorded only the intent
     * (`plan_refire_pending`) before this. A failed dispatch is recorded as
     * refired=false (never retried: at most one re-fire). A dispatch the
     * service took is only `plan_refire_dispatched`: the service can still
     * refuse it, so `plan_refire` / refired=true wait for the re-fire's own
     * launch record (its finalize, or a sweep).
     */
    fun dispatchRefires(context: Context, refires: List<Refire>) {
        if (refires.isEmpty()) return
        val homeDir = try {
            HomeInitializer.getHomeDir(context.applicationContext)
        } catch (e: Throwable) {
            null
        }
        for (r in refires) {
            val outcome = dispatchOne(context, r)
            Log.i(TAG, "re-fire dispatch agent=${r.agentId} of=${r.origRunId} as=${r.refireRunId} outcome=$outcome")
            if (homeDir == null) continue
            val res = runOp(context, homeDir, listOf(
                "--op", "refire-result",
                "--agent-id", r.agentId,
                "--run-id", r.origRunId,
                "--refire-run-id", r.refireRunId,
                "--dispatched", outcome.arg
            ))
            if (!res.ok) Log.w(TAG, "re-fire outcome for ${r.agentId} not recorded; a sweep settles it")
        }
    }

    private fun dispatchOne(context: Context, r: Refire): Dispatch {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, r.agentId)
            putExtra(TerminalSessionService.EXTRA_RECOVERY_REFIRE_OF, r.origRunId)
            putExtra(TerminalSessionService.EXTRA_RECOVERY_LAUNCH_ID, r.refireRunId)
            putExtra(TerminalSessionService.EXTRA_RECOVERY_SCHEDULED_AT, r.scheduledAt)
        }
        return try {
            val svc = TerminalSessionService.instance
            if (svc != null) {
                // The same in-process path reconcile uses for late runs: no
                // background foreground-service start to be refused. Run on the
                // main thread and wait for it, so the outcome is known.
                val main = android.os.Looper.getMainLooper()
                if (android.os.Looper.myLooper() == main) {
                    svc.onStartCommand(intent, 0, 0)
                    Dispatch.OK
                } else {
                    val done = CountDownLatch(1)
                    val outcome = AtomicReference(Dispatch.UNKNOWN)
                    val posted = android.os.Handler(main).post {
                        try {
                            svc.onStartCommand(intent, 0, 0)
                            outcome.set(Dispatch.OK)
                        } catch (e: Throwable) {
                            Log.e(TAG, "re-fire dispatch failed agent=${r.agentId} type=${e.javaClass.simpleName}")
                            outcome.set(Dispatch.FAILED)
                        } finally {
                            done.countDown()
                        }
                    }
                    if (!posted) return Dispatch.FAILED
                    if (done.await(DISPATCH_WAIT_MS, TimeUnit.MILLISECONDS)) outcome.get() else Dispatch.UNKNOWN
                }
            } else {
                val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                if (started == null) Dispatch.FAILED else Dispatch.OK
            }
        } catch (e: Throwable) {
            Log.e(TAG, "re-fire dispatch failed agent=${r.agentId} type=${e.javaClass.simpleName}")
            Dispatch.FAILED
        }
    }

    // ── processes (/proc, same uid) ──────────────────────────────────────

    fun readExecutorPid(homeDir: File, agentId: String): Int? = try {
        File(homeDir, ".shelly/agents/locks/$agentId.pid").readText().trim().toIntOrNull()?.takeIf { it > 0 }
    } catch (e: Exception) {
        null
    }

    private fun cmdline(pid: Int): List<String>? = try {
        File("/proc/$pid/cmdline").readBytes().toString(Charsets.UTF_8).split('\u0000')
    } catch (e: Exception) {
        null
    }

    /** True when [pid] is the PlanSpec executor running [agentId]. */
    fun isExecutorProcess(pid: Int, agentId: String): Boolean {
        val argv = cmdline(pid) ?: return false
        if (argv.none { it.endsWith(EXECUTOR_SCRIPT) }) return false
        val i = argv.indexOf("--agent-id")
        return i >= 0 && i + 1 < argv.size && argv[i + 1] == agentId
    }

    private fun parentOf(pid: Int): Int? = try {
        val stat = File("/proc/$pid/stat").readText()
        val close = stat.lastIndexOf(')')
        if (close < 0 || close + 2 > stat.length) null else stat.substring(close + 2).split(' ').getOrNull(1)?.toIntOrNull()
    } catch (e: Exception) {
        null
    }

    fun descendantsOf(root: Int): List<Int> {
        val children = HashMap<Int, MutableList<Int>>()
        val names = File("/proc").list() ?: return emptyList()
        for (n in names) {
            val pid = n.toIntOrNull() ?: continue
            val parent = parentOf(pid) ?: continue
            children.getOrPut(parent) { mutableListOf() }.add(pid)
        }
        val seen = HashSet<Int>()
        val out = ArrayList<Int>()
        val queue = ArrayDeque<Int>()
        queue.addLast(root)
        seen.add(root)
        while (queue.isNotEmpty()) {
            val p = queue.removeFirst()
            for (c in children[p].orEmpty()) {
                if (seen.add(c)) {
                    out.add(c)
                    queue.addLast(c)
                }
            }
        }
        return out
    }

    /**
     * S5-0 §2: the executor has a worker — a live descendant other than the
     * agent driver (a driver whose CLI died is not a worker). A descendant
     * whose command line cannot be read counts as a worker (never abort on
     * doubt).
     */
    fun workerAlive(executorPid: Int): Boolean =
        descendantsOf(executorPid).any { pid ->
            val argv = cmdline(pid) ?: return@any true
            argv.none { it.endsWith(AGENT_DRIVER_SCRIPT) }
        }

    private fun killTree(root: Int) {
        val tree = listOf(root) + descendantsOf(root)
        for (p in tree) {
            runCatching { Os.kill(p, OsConstants.SIGKILL) }
        }
    }

    /** /proc/<pid>/stat field 22 (start time, clock ticks since boot): tells a pid apart from its reuse. */
    private fun procStartTime(pid: Int): Long? = try {
        val stat = File("/proc/$pid/stat").readText()
        val close = stat.lastIndexOf(')')
        if (close < 0 || close + 2 >= stat.length) null else stat.substring(close + 2).split(' ').getOrNull(19)?.toLongOrNull()
    } catch (e: Exception) {
        null
    }

    /**
     * One marker per freeze (`freeze-<agentId>.<freezeStartMs>.json`): a
     * marker a failed thaw left behind is never overwritten by the agent's
     * next freeze, so the sweep can still thaw what it lists.
     */
    private fun freezeMarker(homeDir: File, agentId: String, freezeStartMs: Long) =
        File(homeDir, ".shelly/agents/locks/freeze-$agentId.$freezeStartMs.json")

    /**
     * Persists "these processes are (about to be) stopped" BEFORE any of them
     * is: `locks/freeze-<agentId>.<freezeStartMs>.json` {v, agentId,
     * runStartTs, at, pids: [{pid, startTime}]}. Every pid has its start time
     * (freezeTree stops no pid whose start time it could not read). A
     * watchdog that dies mid-freeze (the app process killed, anything
     * uncaught) leaves the tree stopped; the next sweep finds the marker
     * older than the script's FREEZE_STALE_MS and sends SIGCONT to each pid
     * whose start time still matches (shelly-run-recovery.js
     * releaseStaleFreezes). False when it could not be written: nothing is
     * stopped then.
     */
    private fun writeFreezeMarker(homeDir: File, agentId: String, freezeStartMs: Long, runStartTs: String, pids: Map<Int, Long>): Boolean = try {
        val arr = org.json.JSONArray()
        for ((p, startTime) in pids) {
            arr.put(JSONObject().put("pid", p).put("startTime", startTime))
        }
        val o = JSONObject()
            .put("v", 1)
            .put("agentId", agentId)
            .put("runStartTs", runStartTs)
            .put("at", System.currentTimeMillis())
            .put("pids", arr)
        val file = freezeMarker(homeDir, agentId, freezeStartMs)
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(file)
    } catch (e: Exception) {
        Log.w(TAG, "freeze marker for $agentId not written type=${e.javaClass.simpleName}")
        false
    }

    private fun clearFreezeMarker(homeDir: File, agentId: String, freezeStartMs: Long) {
        runCatching { freezeMarker(homeDir, agentId, freezeStartMs).delete() }
    }

    /** One-letter /proc state of [pid] ('T' / 't' = stopped), or null when the process is gone or unreadable. */
    private fun procState(pid: Int): Char? = try {
        val stat = File("/proc/$pid/stat").readText()
        val close = stat.lastIndexOf(')')
        if (close < 0 || close + 2 >= stat.length) null else stat[close + 2]
    } catch (e: Exception) {
        null
    }

    private fun sendStop(pid: Int): Boolean = try {
        Os.kill(pid, OsConstants.SIGSTOP)
        true
    } catch (e: android.system.ErrnoException) {
        e.errno == OsConstants.ESRCH // already gone: nothing to spawn from
    } catch (e: Throwable) {
        false
    }

    /**
     * SIGSTOPs the executor and its descendants until no new descendant
     * appears, then confirms from /proc that every one is stopped. Each batch
     * of pids is known before it is stopped: it is added to [stopped] (the
     * caller's set, so the caller can always thaw exactly what was stopped,
     * even when this throws) and persisted by [persist] first, each pid with
     * its /proc start time; a batch that cannot be persisted is not stopped,
     * and neither is a batch holding a pid whose start time could not be read
     * (a marker without it could never be thawed safely: the sweep cannot
     * tell the pid from a reuse). Anything not confirmed (a missing start
     * time, a persist or kill error, a process still running after the wait,
     * a descendant that appeared after the last round) returns false: the
     * caller cancels the kill (freeze-failed).
     */
    private fun freezeTree(root: Int, stopped: MutableSet<Int>, persist: (Map<Int, Long>) -> Boolean): Boolean {
        var ok = true
        var settled = false
        val startTimes = LinkedHashMap<Int, Long>()
        // The first batch is the whole tree as listed now; later batches are what appeared since.
        var batch: List<Int> = listOf(root) + descendantsOf(root)
        for (round in 0 until 6) {
            val fresh = batch.filter { it !in stopped }
            if (fresh.isEmpty()) {
                settled = true
                break
            }
            val freshStart = HashMap<Int, Long>()
            for (p in fresh) {
                // No start time: this pid is never stopped (nor the rest of its batch).
                val st = procStartTime(p) ?: return false
                freshStart[p] = st
            }
            stopped.addAll(fresh)
            startTimes.putAll(freshStart)
            if (!persist(startTimes)) {
                // Not on disk: these were never stopped; nothing more is.
                stopped.removeAll(fresh.toSet())
                for (p in fresh) startTimes.remove(p)
                return false
            }
            for (p in fresh) {
                if (!sendStop(p)) ok = false
            }
            batch = descendantsOf(root)
        }
        if (!settled) ok = false
        // Signal delivery is asynchronous: wait (briefly) for the stopped state.
        // Only a process that is gone (no /proc entry) or whose state reads
        // stopped / dead counts; an unreadable state is not a confirmation.
        val deadline = System.currentTimeMillis() + 500L
        while (ok) {
            val pending = stopped.filter { p ->
                if (!File("/proc/$p").exists()) return@filter false
                val st = procState(p)
                st == null || (st != 'T' && st != 't' && st != 'Z' && st != 'X')
            }
            if (pending.isEmpty()) break
            if (System.currentTimeMillis() >= deadline) {
                ok = false
                break
            }
            Thread.sleep(20L)
        }
        if (ok && descendantsOf(root).any { it !in stopped }) ok = false
        return ok
    }

    /**
     * Sends [sig] to each pid; true only when every one went out (or the
     * process is already gone: ESRCH, nothing left stopped). The freeze
     * marker is removed only on true; otherwise it stays for the sweep.
     */
    private fun signalAll(pids: Collection<Int>, sig: Int): Boolean {
        var all = true
        for (p in pids) {
            try {
                Os.kill(p, sig)
            } catch (e: android.system.ErrnoException) {
                if (e.errno != OsConstants.ESRCH) all = false
            } catch (e: Throwable) {
                all = false
            }
        }
        return all
    }

    private fun thawTree(pids: Collection<Int>): Boolean = signalAll(pids, OsConstants.SIGCONT)

    /**
     * Tier 1, right before the kill: with the tree frozen (no new spawn, no
     * new write), the executor must still be this agent's, have no worker,
     * and have written no progress since the hang-check read the stream.
     * Returns null to proceed, else why the kill is cancelled.
     */
    private fun recheckBeforeKill(homeDir: File, agentId: String, pid: Int, progressBytes: Long): String? = when {
        !isExecutorProcess(pid, agentId) -> "executor-gone"
        workerAlive(pid) -> "worker"
        progressAdvanced(homeDir, agentId, progressBytes) -> "progress"
        else -> null
    }

    // ── the hang watchdog (a thread of runPlanAgent) ─────────────────────

    class Watchdog internal constructor() {
        internal val stop = AtomicBoolean(false)
        internal val monitor = Object()
        /** True once the watchdog closed the run as hung and killed the executor. */
        val aborted = AtomicBoolean(false)
        /** The run (its plan_start ts) the watchdog aborted, declared to finalize. */
        @Volatile var abortedRunStartTs: String? = null
        val refires: MutableList<Refire> = Collections.synchronizedList(ArrayList())
        @Volatile internal var suspectRecorded = false
        @Volatile internal var noWorkerLastTick = false
        internal var thread: Thread? = null

        fun stop() {
            stop.set(true)
            synchronized(monitor) { monitor.notifyAll() }
            // A hang check in flight (up to the script timeout) finishes first,
            // so its verdict and re-fire are never dropped.
            runCatching { thread?.join(OP_TIMEOUT_MS + 10_000L) }
        }
    }

    fun startWatchdog(context: Context, homeDir: File, agentId: String, launchStartedAtMs: Long, launchId: String): Watchdog {
        val w = Watchdog()
        val t = Thread({
            try {
                while (!w.stop.get()) {
                    synchronized(w.monitor) {
                        if (!w.stop.get()) w.monitor.wait(WATCHDOG_TICK_MS)
                    }
                    if (w.stop.get()) break
                    val elapsed = System.currentTimeMillis() - launchStartedAtMs
                    if (elapsed < HANG_ABORT_NO_PROGRESS_MS) continue
                    val pid = readExecutorPid(homeDir, agentId) ?: continue
                    if (!isExecutorProcess(pid, agentId)) continue
                    val worker = workerAlive(pid)
                    // Tier 1 needs two consecutive samples without a worker: one
                    // sample can fall between two broker / driver spawns.
                    val prevNoWorker = w.noWorkerLastTick
                    w.noWorkerLastTick = !worker
                    if (!worker && !prevNoWorker && elapsed < HANG_SUSPECT_NO_PROGRESS_MS) continue
                    // A run with a worker is only checked for tier 2 (30 min), once.
                    if (worker && (elapsed < HANG_SUSPECT_NO_PROGRESS_MS || w.suspectRecorded)) continue
                    if (w.stop.get()) break
                    val r = hangCheck(context, homeDir, agentId, worker, launchStartedAtMs)
                    when (r.verdict) {
                        "suspect" -> {
                            w.suspectRecorded = true
                            Log.w(TAG, "agent $agentId hung-suspect (worker alive, no progress 30 min): recorded only")
                        }
                        "hung" -> {
                            val runStartTs = r.runStartTs ?: continue
                            if (w.stop.get()) break
                            // Every way out of the freeze but the kill thaws what was
                            // stopped (finally), and the marker on disk lets a sweep
                            // thaw it if this thread or the app dies in between.
                            val frozen = LinkedHashSet<Int>()
                            val freezeStartMs = System.currentTimeMillis()
                            var killing = false
                            var signalled = false
                            var why: String? = "freeze-failed"
                            try {
                                val confirmed = try {
                                    freezeTree(pid, frozen) { writeFreezeMarker(homeDir, agentId, freezeStartMs, runStartTs, it) }
                                } catch (e: Throwable) {
                                    false
                                }
                                why = try {
                                    if (!confirmed) "freeze-failed" else recheckBeforeKill(homeDir, agentId, pid, r.progressBytes)
                                } catch (e: Throwable) {
                                    "worker"
                                }
                                if (why == null) {
                                    Log.w(TAG, "agent $agentId hung (no worker, no progress 10 min): aborting executor pid=$pid")
                                    killing = true
                                    killTree(pid)
                                    // Anything frozen outside the tree by now (reparented) is still stopped: kill it too.
                                    signalled = signalAll(frozen, OsConstants.SIGKILL)
                                }
                            } finally {
                                if (!killing) signalled = thawTree(frozen)
                                // Removed only when every signal it covers went out; else the
                                // marker stays and the sweep retries the SIGCONT (start time checked).
                                if (signalled) {
                                    clearFreezeMarker(homeDir, agentId, freezeStartMs)
                                } else {
                                    Log.w(TAG, "agent $agentId freeze marker kept: a signal did not go out")
                                }
                            }
                            if (why != null) {
                                w.noWorkerLastTick = false
                                Log.w(TAG, "agent $agentId hung verdict cancelled before the kill: $why")
                                hangCancel(context, homeDir, agentId, runStartTs, why)
                                continue
                            }
                            w.abortedRunStartTs = runStartTs
                            w.aborted.set(true)
                            val closed = hangAbort(context, homeDir, agentId, runStartTs, r.noProgressMs, launchId, launchStartedAtMs)
                            w.refires.addAll(closed.refires)
                            break
                        }
                    }
                }
            } catch (e: Throwable) {
                Log.e(TAG, "hang watchdog for $agentId failed type=${e.javaClass.simpleName}")
            }
        }, "shelly-hang-watchdog")
        t.isDaemon = true
        w.thread = t
        t.start()
        return w
    }
}
