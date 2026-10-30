package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Continuous mode (DEFERRED.md 継続モード Increment 1): the Android side of a
 * "keep going until I stop it" loop. The decision itself is the pure
 * [ContinuousStopPolicy]; this object gathers its inputs from disk, records a
 * stop, owns the per-loop ongoing notification and the Stop action.
 *
 * Files (all inside the existing per-agent log dir, no new directory):
 *   logs/<id>/checkpoint.json  written by the executor / .sh at the end of every
 *                              iteration (lib/agent-continuous.ts documents the
 *                              shape); native only adds stoppedReason/stoppedAt.
 *   logs/<id>/continuous.stop  per-agent stop marker (notification Stop).
 * Native also keeps its own iteration counter + loop start in SharedPreferences
 * so a corrupt or deleted checkpoint can never extend a loop.
 */
object ContinuousLoop {
    private const val TAG = "ContinuousLoop"
    const val CHANNEL_ID = "shelly_continuous_loop"
    private const val PREFS = "shelly_continuous_loops"
    private const val PREF_SEP = "|"
    private const val RUNNING_NOTIFICATION_BASE = 0x37C20000
    private const val STOPPED_NOTIFICATION_BASE = 0x37C28000
    private const val NOTIFICATION_SPAN = 0x8000
    const val CHECKPOINT_FILE = "checkpoint.json"
    const val STOP_MARKER_FILE = "continuous.stop"
    /** Notification extra naming the loop agent (cancelStaleRunningNotifications). */
    const val EXTRA_LOOP_AGENT_ID = "shelly.continuous.agentId"
    const val CHECKPOINT_VERSION = 1

    /** What native reads back from checkpoint.json (fail closed = [EMPTY]). */
    data class CheckpointView(
        val iteration: Int,
        val startedAt: Long?,
        val doneStreak: Int,
        val consecutiveFailures: Int,
        val usageDay: String?,
        val usageUsd: Double,
        val stoppedReason: String?,
        val stoppedAt: Long?,
    ) {
        companion object {
            val EMPTY = CheckpointView(0, null, 0, 0, null, 0.0, null, null)
        }
    }

    sealed class Gate {
        data class Run(val iteration: Int) : Gate()
        data class Stop(val reason: ContinuousStopReason) : Gate()
    }

    // ── Paths ────────────────────────────────────────────────────────────────

    private fun home(context: Context): File = HomeInitializer.getHomeDir(context)
    private fun logDir(homeDir: File, agentId: String) = File(homeDir, ".shelly/agents/logs/$agentId")
    fun checkpointFile(homeDir: File, agentId: String) = File(logDir(homeDir, agentId), CHECKPOINT_FILE)
    fun stopMarker(homeDir: File, agentId: String) = File(logDir(homeDir, agentId), STOP_MARKER_FILE)

    /** The stop marker counts for the loop it was written in; one older than
     *  this loop's start (a previous loop the user re-enabled) is removed.
     *  Fails closed: an unreadable marker state means "stop". */
    fun stopRequested(homeDir: File, agentId: String, loopStart: Long): Boolean = try {
        val marker = stopMarker(homeDir, agentId)
        when {
            !marker.exists() -> false
            ContinuousStopPolicy.markerApplies(marker.lastModified(), loopStart) -> true
            else -> {
                marker.delete()
                false
            }
        }
    } catch (_: Exception) {
        true
    }

    // ── Agent config ─────────────────────────────────────────────────────────

    private fun readAgentJson(homeDir: File, agentId: String): JSONObject? = try {
        val file = File(homeDir, ".shelly/agents/$agentId.json")
        if (!file.isFile) null else JSONObject(file.readText()).takeIf { it.optString("id") == agentId }
    } catch (e: Exception) {
        Log.w(TAG, "Failed to read agent json for $agentId", e)
        null
    }

    /** The loop config of a continuous agent, or null for any other agent. A
     *  present-but-malformed `continuous` object still yields the default
     *  limits (it is never read as "not continuous"). */
    fun readConfig(json: JSONObject): ContinuousConfig? {
        if (!json.has("continuous") || json.isNull("continuous")) return null
        val c = json.optJSONObject("continuous") ?: JSONObject()
        fun long(key: String): Long? = if (c.has(key) && !c.isNull(key)) c.optDouble(key, Double.NaN).takeIf { !it.isNaN() }?.toLong() else null
        return ContinuousStopPolicy.normalize(
            cooldownMs = long("cooldownMs"),
            maxIterations = long("maxIterations")?.coerceIn(0L, Int.MAX_VALUE.toLong())?.toInt(),
            maxWallMs = long("maxWallMs"),
            goalCheck = c.optBoolean("goalCheck", false),
            dailyBudgetJpy = long("dailyBudgetJpy"),
            loopStartedAt = long("loopStartedAt"),
        )
    }

    fun configFor(context: Context, agentId: String): ContinuousConfig? =
        readAgentJson(home(context), agentId)?.let { readConfig(it) }

    private fun agentName(homeDir: File, agentId: String): String =
        readAgentJson(homeDir, agentId)?.optString("name")?.takeIf { it.isNotBlank() } ?: agentId

    // ── Checkpoint ───────────────────────────────────────────────────────────

    fun readCheckpoint(file: File): CheckpointView = try {
        if (!file.isFile) CheckpointView.EMPTY else parseCheckpoint(file.readText())
    } catch (e: Exception) {
        Log.w(TAG, "Unreadable checkpoint ${file.path}; treating as iteration 0", e)
        CheckpointView.EMPTY
    }

    fun parseCheckpoint(text: String): CheckpointView = try {
        val json = JSONObject(text)
        if (json.optInt("v", -1) != CHECKPOINT_VERSION) {
            CheckpointView.EMPTY
        } else {
            val usage = json.optJSONObject("usage")
            fun nonNegInt(o: JSONObject?, key: String): Int =
                o?.optDouble(key, 0.0)?.takeIf { !it.isNaN() && it > 0 }?.coerceAtMost(1_000_000.0)?.toInt() ?: 0
            CheckpointView(
                iteration = nonNegInt(json, "iteration"),
                startedAt = json.optDouble("startedAt", Double.NaN).takeIf { !it.isNaN() && it > 0 }?.toLong(),
                doneStreak = nonNegInt(json, "doneStreak"),
                consecutiveFailures = nonNegInt(json, "consecutiveFailures"),
                usageDay = usage?.optString("day")?.takeIf { it.isNotBlank() },
                usageUsd = usage?.optDouble("usd", 0.0)?.takeIf { !it.isNaN() && it > 0 } ?: 0.0,
                stoppedReason = json.optString("stoppedReason").takeIf { it.isNotBlank() },
                stoppedAt = json.optDouble("stoppedAt", Double.NaN).takeIf { !it.isNaN() && it > 0 }?.toLong(),
            )
        }
    } catch (_: Exception) {
        CheckpointView.EMPTY
    }

    /** A checkpoint left over from a PREVIOUS loop (re-enable started a new
     *  one) carries nothing for this loop. */
    private fun checkpointForLoop(view: CheckpointView, loopStart: Long): CheckpointView {
        val started = view.startedAt ?: return view
        return if (started + 1000 < loopStart) CheckpointView.EMPTY else view
    }

    private fun writeAtomic(target: File, text: String) {
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, ".${target.name}.native.${android.os.Process.myPid()}.${System.currentTimeMillis()}.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(target)) {
            tmp.delete()
            throw IllegalStateException("rename failed for ${target.path}")
        }
    }

    // ── Native loop counter (SharedPreferences, survives a lost checkpoint) ──

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun storedLoop(context: Context, agentId: String): Pair<Long, Int>? {
        val raw = prefs(context).getString(agentId, null) ?: return null
        val parts = raw.split(PREF_SEP)
        val start = parts.getOrNull(0)?.toLongOrNull() ?: return null
        val count = parts.getOrNull(1)?.toIntOrNull()?.coerceAtLeast(0) ?: 0
        return start to count
    }

    /** This loop's start: the JS-recorded loopStartedAt, else native's own
     *  first-seen time (stored once). */
    fun loopStart(context: Context, agentId: String, config: ContinuousConfig, nowMs: Long): Long {
        config.loopStartedAt?.let { return it }
        storedLoop(context, agentId)?.let { return it.first }
        prefs(context).edit().putString(agentId, "$nowMs${PREF_SEP}0").commit()
        return nowMs
    }

    fun nativeCount(context: Context, agentId: String, loopStart: Long): Int {
        val stored = storedLoop(context, agentId) ?: return 0
        return if (stored.first == loopStart) stored.second else 0
    }

    private fun recordIterationStarted(context: Context, agentId: String, loopStart: Long): Int {
        val next = nativeCount(context, agentId, loopStart) + 1
        prefs(context).edit().putString(agentId, "$loopStart$PREF_SEP$next").commit()
        return next
    }

    // ── Decision ─────────────────────────────────────────────────────────────

    private fun isGloballyHalted(homeDir: File): Boolean = try {
        File(homeDir, ".shelly/agents/.halted").exists()
    } catch (_: Exception) {
        true
    }

    private fun today(nowMs: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(nowMs))

    fun evaluate(context: Context, agentId: String, config: ContinuousConfig, breakerFailures: Int, nowMs: Long = System.currentTimeMillis()): ContinuousStopReason? {
        val homeDir = home(context)
        val loopStart = loopStart(context, agentId, config, nowMs)
        val checkpoint = checkpointForLoop(readCheckpoint(checkpointFile(homeDir, agentId)), loopStart)
        val json = readAgentJson(homeDir, agentId)
        val inputs = ContinuousStopInputs(
            nowMs = nowMs,
            userStopRequested = stopRequested(homeDir, agentId, loopStart),
            agentEnabled = json?.optBoolean("enabled", false) == true,
            globallyHalted = isGloballyHalted(homeDir),
            iterationsDone = ContinuousStopPolicy.iterationsDone(nativeCount(context, agentId, loopStart), checkpoint.iteration),
            loopStartedAt = loopStart,
            spentUsdToday = if (checkpoint.usageDay == today(nowMs)) checkpoint.usageUsd else 0.0,
            consecutiveFailures = maxOf(breakerFailures, checkpoint.consecutiveFailures),
            doneStreak = checkpoint.doneStreak,
            // A stop native recorded for this loop is sticky (see recordedStop).
            recordedStop = ContinuousStopPolicy.recordedStop(checkpoint.stoppedReason, checkpoint.stoppedAt, loopStart),
        )
        return ContinuousStopPolicy.evaluate(config, inputs)
    }

    /** Before an alarm-fired iteration. Run → the iteration number now starting
     *  (counted immediately, so a crash mid-run still uses up an iteration). */
    fun gateBeforeRun(context: Context, agentId: String, config: ContinuousConfig, breakerFailures: Int): Gate {
        val now = System.currentTimeMillis()
        val reason = evaluate(context, agentId, config, breakerFailures, now)
        if (reason != null) return Gate.Stop(reason)
        val loopStart = loopStart(context, agentId, config, now)
        val homeDir = home(context)
        val checkpoint = checkpointForLoop(readCheckpoint(checkpointFile(homeDir, agentId)), loopStart)
        val started = recordIterationStarted(context, agentId, loopStart)
        val iteration = maxOf(started, checkpoint.iteration + 1)
        postRunning(context, agentId, agentName(homeDir, agentId), iteration, null)
        return Gate.Run(iteration)
    }

    /** After an iteration: null = re-armed (returns nothing to do), else the
     *  stop reason that was recorded. */
    fun afterRun(context: Context, agentId: String, config: ContinuousConfig, breakerFailures: Int, breakerTripped: Boolean): ContinuousStopReason? {
        val reason = if (breakerTripped) ContinuousStopReason.CONSECUTIVE_FAILURES
        else evaluate(context, agentId, config, breakerFailures)
        if (reason != null) {
            finalizeStop(context, agentId, reason)
            return reason
        }
        val homeDir = home(context)
        val nextAt = System.currentTimeMillis() + config.cooldownMs
        val armed = try {
            AgentAlarmScheduler.scheduleNextIfAgentEnabled(context, agentId, config.cooldownMs, null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to re-arm continuous agent $agentId", e)
            false
        }
        if (armed) {
            val loopStart = loopStart(context, agentId, config, System.currentTimeMillis())
            val done = ContinuousStopPolicy.iterationsDone(
                nativeCount(context, agentId, loopStart),
                checkpointForLoop(readCheckpoint(checkpointFile(homeDir, agentId)), loopStart).iteration,
            )
            postRunning(context, agentId, agentName(homeDir, agentId), done + 1, nextAt)
        } else {
            cancelRunningNotification(context, agentId)
        }
        return null
    }

    /**
     * Stop this loop: no re-arm, reason in checkpoint.json + a run log + one
     * plain notification. Idempotent per loop: a second call with the reason
     * already recorded for this loop only re-asserts the alarm cancel.
     */
    fun finalizeStop(context: Context, agentId: String, reason: ContinuousStopReason) {
        val homeDir = home(context)
        try {
            AgentAlarmScheduler.cancel(context, agentId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cancel alarm while stopping $agentId", e)
        }
        cancelRunningNotification(context, agentId)
        val now = System.currentTimeMillis()
        val config = configFor(context, agentId)
        val loopStart = config?.let { loopStart(context, agentId, it, now) } ?: 0L
        val file = checkpointFile(homeDir, agentId)
        val existing = readCheckpoint(file)
        val alreadyRecorded = existing.stoppedReason == reason.code && (existing.stoppedAt ?: 0L) >= loopStart
        if (reason.disablesAgent) disableAgent(homeDir, agentId)
        if (alreadyRecorded) return
        val message = stopMessage(reason)
        try {
            val existingJson: JSONObject? = try {
                if (file.isFile) JSONObject(file.readText()).takeIf { it.optInt("v", -1) == CHECKPOINT_VERSION } else null
            } catch (_: Exception) {
                null
            }
            val json = existingJson ?: JSONObject().apply {
                put("v", CHECKPOINT_VERSION)
                put("iteration", nativeCount(context, agentId, loopStart))
                put("startedAt", loopStart)
                put("summary", "")
                put("nextAction", "")
                put("consecutiveFailures", 0)
            }
            json.put("stoppedReason", reason.code)
            json.put("stoppedAt", now)
            writeAtomic(file, json.toString(2))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to record stop reason in checkpoint for $agentId", e)
        }
        try {
            val log = JSONObject().apply {
                put("agentId", agentId)
                put("timestamp", now)
                put("status", "skipped")
                put("outputPreview", message)
                put("durationMs", 0)
                put("toolUsed", "continuous")
                put("errorMessage", message)
            }
            // <epoch seconds>.json like every other run log (never clobber
            // the run's own log written in the same second).
            var sec = now / 1000
            while (File(logDir(homeDir, agentId), "$sec.json").exists()) sec++
            writeAtomic(File(logDir(homeDir, agentId), "$sec.json"), log.toString())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write stop run log for $agentId", e)
        }
        postStopped(context, agentId, agentName(homeDir, agentId), message)
        Log.i(TAG, "Continuous loop $agentId stopped: ${reason.code}")
    }

    private fun disableAgent(homeDir: File, agentId: String) {
        try {
            val file = File(homeDir, ".shelly/agents/$agentId.json")
            val json = JSONObject(file.readText())
            if (json.optString("id") != agentId) return
            if (!json.optBoolean("enabled", false)) return
            json.put("enabled", false)
            writeAtomic(file, json.toString(2))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to persist disabled state for stopped loop $agentId", e)
        }
    }

    private fun ja(): Boolean = Locale.getDefault().language == "ja"

    fun stopMessage(reason: ContinuousStopReason): String = if (ja()) {
        when (reason) {
            ContinuousStopReason.USER_STOP -> "継続実行を停止しました（ユーザーが停止）。"
            ContinuousStopReason.HALTED -> "継続実行を停止しました（全エージェント停止中）。"
            ContinuousStopReason.MAX_ITERATIONS -> "継続実行を停止しました（最大回数に達しました）。"
            ContinuousStopReason.MAX_WALL_TIME -> "継続実行を停止しました（最大時間に達しました）。"
            ContinuousStopReason.BUDGET -> "継続実行を停止しました（1日の有料API上限）。"
            ContinuousStopReason.CONSECUTIVE_FAILURES -> "継続実行を停止しました（3回連続で失敗）。"
            ContinuousStopReason.GOAL_REACHED -> "継続実行を終了しました（完了と判断）。"
        }
    } else {
        when (reason) {
            ContinuousStopReason.USER_STOP -> "Continuous run stopped (stopped by you)."
            ContinuousStopReason.HALTED -> "Continuous run stopped (all agents are stopped)."
            ContinuousStopReason.MAX_ITERATIONS -> "Continuous run stopped (maximum iterations reached)."
            ContinuousStopReason.MAX_WALL_TIME -> "Continuous run stopped (maximum time reached)."
            ContinuousStopReason.BUDGET -> "Continuous run stopped (daily paid-API budget)."
            ContinuousStopReason.CONSECUTIVE_FAILURES -> "Continuous run stopped (3 failures in a row)."
            ContinuousStopReason.GOAL_REACHED -> "Continuous run finished (the goal looks done)."
        }
    }

    // ── Stop action ──────────────────────────────────────────────────────────

    /** Notification Stop: marker first (so nothing re-arms), cancel the alarm,
     *  kill an in-flight run of THIS agent, then record the stop. Blocking
     *  (the kill waits ~1s) — call off the main thread. */
    fun requestStop(context: Context, agentId: String) {
        val homeDir = home(context)
        try {
            val marker = stopMarker(homeDir, agentId)
            marker.parentFile?.mkdirs()
            marker.writeText("stop ${System.currentTimeMillis()}\n")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write stop marker for $agentId", e)
        }
        try {
            AgentAlarmScheduler.cancel(context, agentId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cancel alarm on stop for $agentId", e)
        }
        val killed = try {
            killInflightRun(homeDir, agentId)
        } catch (e: Exception) {
            Log.w(TAG, "In-flight kill failed for $agentId", e)
            false
        }
        Log.i(TAG, "Stop requested for continuous loop $agentId (in-flight run signalled=$killed)")
        finalizeStop(context, agentId, ContinuousStopReason.USER_STOP)
    }

    private fun statField(pid: Int, n: Int): String? = try {
        val line = File("/proc/$pid/stat").readText()
        val rest = line.substring(line.lastIndexOf(") ") + 2).trim().split(Regex("\\s+"))
        rest.getOrNull(n - 1)
    } catch (_: Exception) {
        null
    }

    private fun cmdline(pid: Int): String = try {
        File("/proc/$pid/cmdline").readText().replace('\u0000', ' ')
    } catch (_: Exception) {
        ""
    }

    /**
     * Kotlin port of lib/agent-manager.ts haltInflightRunsCommand, scoped to one
     * agent's lock (locks/<id>.pid). Signals only a pid proven to be that run
     * (its /proc start time equals the one the .sh recorded, or its cmdline
     * names the PlanSpec executor); TERM first, KILL after 1s to it and every
     * descendant collected before signalling, each re-checked by start time.
     * The shared llama-server and its idle watcher are spared.
     */
    fun killInflightRun(homeDir: File, agentId: String): Boolean {
        val pidFile = File(homeDir, ".shelly/agents/locks/$agentId.pid")
        val pid = (try { pidFile.readText().trim().toIntOrNull() } catch (_: Exception) { null }) ?: return false
        if (pid <= 1 || pid == android.os.Process.myPid() || !File("/proc/$pid").isDirectory) return false
        val recorded = try { File(pidFile.path + ".lockdir/starttime").readText().trim() } catch (_: Exception) { "" }
        val isRun = (recorded.isNotEmpty() && recorded.all { it.isDigit() } && recorded == statField(pid, 20)) ||
            ContinuousStopPolicy.isOwnExecutorCmdline(cmdline(pid), agentId)
        if (!isRun) return false
        val spare = HashSet<Int>()
        for (name in listOf("models/llama-server.pid", "models/llama-server-watcher.pid")) {
            try { File(homeDir, name).readText().trim().toIntOrNull()?.let { spare.add(it) } } catch (_: Exception) {}
        }
        val victims = LinkedHashMap<Int, String?>()
        victims[pid] = statField(pid, 20)
        var front = setOf(pid)
        val procs = File("/proc").listFiles { f -> f.isDirectory && f.name.all { it.isDigit() } }?.mapNotNull { it.name.toIntOrNull() } ?: emptyList()
        while (front.isNotEmpty()) {
            val next = HashSet<Int>()
            for (p in procs) {
                if (victims.containsKey(p) || spare.contains(p)) continue
                val ppid = statField(p, 2)?.toIntOrNull() ?: continue
                if (!front.contains(ppid)) continue
                if (cmdline(p).contains("llama-server")) continue
                victims[p] = statField(p, 20)
                next.add(p)
            }
            front = next
        }
        runCatching { android.os.Process.sendSignal(pid, 15) }
        Thread.sleep(1000)
        val self = android.os.Process.myPid()
        for ((vp, vs) in victims) {
            if (vp == self || vs == null) continue
            if (vs == statField(vp, 20)) runCatching { android.os.Process.sendSignal(vp, 9) }
        }
        return true
    }

    // ── Notifications ────────────────────────────────────────────────────────

    private fun notificationIdFor(base: Int, agentId: String): Int =
        base + (agentId.hashCode() and 0x7fffffff) % NOTIFICATION_SPAN

    private fun ensureChannel(context: Context): NotificationManager? {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    if (ja()) "継続実行中のエージェント" else "Continuous agents",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = if (ja()) "止めるまで続けるエージェントの進行状況" else "Progress of agents that keep going until you stop them"
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
            )
        }
        return nm
    }

    private fun builder(context: Context): Notification.Builder {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
        }
    }

    fun runningText(name: String, iteration: Int, nextAtMs: Long?): String {
        val clock = nextAtMs?.let { SimpleDateFormat("HH:mm", Locale.US).format(Date(it)) }
        return if (ja()) {
            if (clock != null) "$name — 第${iteration}回 · 次 $clock" else "$name — 第${iteration}回 · 実行中"
        } else {
            if (clock != null) "$name — iteration $iteration · next $clock" else "$name — iteration $iteration · running"
        }
    }

    fun postRunning(context: Context, agentId: String, name: String, iteration: Int, nextAtMs: Long?) {
        try {
            val nm = ensureChannel(context) ?: return
            val stopIntent = Intent(context, TerminalSessionService::class.java).apply {
                action = TerminalSessionService.ACTION_STOP_CONTINUOUS
                putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            }
            val stopPi = PendingIntent.getService(
                context,
                AgentAlarmScheduler.getAgentRequestCode(context, "continuous-stop:$agentId"),
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val text = runningText(name, iteration, nextAtMs)
            val notification = builder(context)
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setContentTitle(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .apply { if (launch != null) setContentIntent(launch) }
                .addAction(Notification.Action.Builder(null, if (ja()) "停止" else "Stop", stopPi).build())
                .addExtras(android.os.Bundle().apply { putString(EXTRA_LOOP_AGENT_ID, agentId) })
                .build()
            nm.notify(notificationIdFor(RUNNING_NOTIFICATION_BASE, agentId), notification)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post continuous-loop notification for $agentId", e)
        }
    }

    /** Service (re)creation: drop only the ongoing loop notifications whose
     *  agent is no longer a continuous, enabled agent on disk (deleted /
     *  paused / stopped while no process was alive). A live loop between
     *  iterations keeps its notification — and its Stop button. */
    fun cancelStaleRunningNotifications(context: Context) {
        runCatching {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            val homeDir = home(context)
            for (sbn in nm.activeNotifications) {
                if (sbn.id < RUNNING_NOTIFICATION_BASE || sbn.id >= RUNNING_NOTIFICATION_BASE + NOTIFICATION_SPAN) continue
                val agentId = sbn.notification?.extras?.getString(EXTRA_LOOP_AGENT_ID)
                val json = agentId?.let { readAgentJson(homeDir, it) }
                val keep = ContinuousStopPolicy.keepRunningNotification(
                    agentId,
                    stillContinuous = json != null && readConfig(json) != null,
                    enabledOnDisk = json?.optBoolean("enabled", false) == true,
                )
                if (!keep) nm.cancel(sbn.id)
            }
        }
    }

    fun cancelRunningNotification(context: Context, agentId: String) {
        runCatching {
            context.getSystemService(NotificationManager::class.java)
                ?.cancel(notificationIdFor(RUNNING_NOTIFICATION_BASE, agentId))
        }
    }

    private fun postStopped(context: Context, agentId: String, name: String, message: String) {
        try {
            val nm = ensureChannel(context) ?: return
            val notification = builder(context)
                .setSmallIcon(android.R.drawable.ic_media_pause)
                .setContentTitle(name)
                .setContentText(message)
                .setStyle(Notification.BigTextStyle().bigText(message))
                .setAutoCancel(true)
                .build()
            nm.notify(notificationIdFor(STOPPED_NOTIFICATION_BASE, agentId), notification)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post continuous-loop stop notification for $agentId", e)
        }
    }
}
