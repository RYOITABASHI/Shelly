package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.FileObserver
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import expo.modules.terminalemulator.scouter.AgentActionApprovalBridge
import expo.modules.terminalemulator.scouter.NotificationDispatcher
import expo.modules.terminalemulator.scouter.ScouterStateStore
import expo.modules.terminalemulator.scouter.ScouterWidgetProvider
import expo.modules.terminalemulator.scouter.WidgetAgentRepository
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * Foreground service that keeps the Shelly process alive when the user
 * swipes the app from the recent-tasks list.
 *
 * Behaviour mirrors Termux's TermuxService:
 * - Shows a persistent, silent, low-priority notification
 * - Holds the process via startForeground()
 * - Survives onTaskRemoved() by re-posting startForeground (Android restarts
 *   the service via START_STICKY even if the OS kills it)
 */
class TerminalSessionService : Service() {

    companion object {
        private const val TAG = "TerminalSessionService"
        const val CHANNEL_ID = "shelly_terminal_session"
        const val NOTIFICATION_ID = 7734  // "SHEL" on a phone keypad
        const val ACTION_UPDATE_NOTIFICATION = "expo.modules.terminalemulator.UPDATE_NOTIFICATION"
        const val ACTION_STOP = "expo.modules.terminalemulator.STOP"
        const val ACTION_RUN_AGENT = "expo.modules.terminalemulator.RUN_AGENT"
        const val EXTRA_AGENT_ID = "agent_id"
        // Carried on the alarm-fired RUN_AGENT intent so the service can re-arm the
        // next fire itself (the alarm now targets the service directly, not the
        // receiver, so the re-schedule loop lives here).
        const val EXTRA_INTERVAL_MS = "interval_ms"
        const val EXTRA_CRON = "cron"
        const val EXTRA_TAINTED = "tainted"
        const val EXTRA_MANUAL = "manual"
        // NOTIFY-001 Increment 3 (sender-gated notification text channel): the
        // sanitized, bounded body text of an authorized-sender notification and
        // its source package. Only ShellyNotificationListener sets these; any
        // run carrying text is FORCED tainted below regardless of EXTRA_TAINTED.
        const val EXTRA_NOTIFICATION_TEXT = "notification_text"
        const val EXTRA_NOTIFICATION_PACKAGE = "notification_package"
        const val EXTRA_NOTIFICATION_TRIGGER = "notification_trigger"
        // Mirrors ShellyNotificationListener.MAX_INBOUND_NOTIFICATION_TEXT /
        // lib/telegram-inbound.ts MAX_INBOUND_TEXT — defensive re-bound at the
        // service boundary (the service is not exported, but bounding twice is
        // cheap and keeps a future caller honest).
        private const val MAX_NOTIFICATION_TEXT_CHARS = 1000
        private const val CIRCUIT_BREAKER_PREFS = "shelly_agent_circuit_breaker"
        private const val CIRCUIT_BREAKER_THRESHOLD = 3

        /**
         * Authoritative session registry. Lives here (Service companion) rather
         * than on [TerminalEmulatorModule] so that live PTY sessions survive
         * Module re-instantiation events (RN bridge reload, dev-client refresh,
         * or any future scenario where the Expo Module is recreated without the
         * OS process dying). As long as the foreground service is alive, the
         * Linux process — and with it the forked PTY children — stays alive,
         * so these ShellyTerminalSession handles remain valid.
         *
         * When the OS kernel OOM-kills the whole process, the companion object
         * resets too and callers fall back to Case C (transcript replay).
         */
        val sessionRegistry = mutableMapOf<String, ShellyTerminalSession>()
        private val activeAgentRuns = AtomicInteger(0)
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created sessions=${sessionRegistry.size} ids=${sessionRegistry.keys.joinToString(",")}")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand action=${intent?.action ?: "default"} sessions=${sessionRegistry.size} ids=${sessionRegistry.keys.joinToString(",")}")
        when (intent?.action) {
            ACTION_STOP -> {
                Log.i(TAG, "Stop action received — stopping service")
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_UPDATE_NOTIFICATION -> {
                val info = intent.getStringExtra("session_info") ?: ""
                updateNotification(info)
                return START_STICKY
            }
            ACTION_RUN_AGENT -> {
                val agentId = intent.getStringExtra(EXTRA_AGENT_ID)
                if (agentId.isNullOrBlank()) {
                    Log.w(TAG, "RUN_AGENT action received without agent id")
                    startForegroundWithNotification(null)
                    return START_STICKY
                }
                if (isGloballyHalted()) {
                    // STOP-ALL kill-switch (lib/agent-manager.ts haltAllAgents()).
                    // Scheduled runs are already blocked by alarm uninstall + the JS
                    // manual-run gate, but this is the single native chokepoint every
                    // OTHER dispatch source funnels through — currently the
                    // notification-listener trigger (NOTIFY-001), and any future
                    // native trigger — so it must fail closed here too rather than
                    // rely on each caller remembering to check upstream.
                    Log.i(TAG, "RUN_AGENT for $agentId suppressed: globally halted (STOP-ALL)")
                    if (!hasProtectedWork()) {
                        startForegroundWithNotification(null)
                        stopForeground(STOP_FOREGROUND_REMOVE)
                        stopSelf(startId)
                        return START_NOT_STICKY
                    }
                    startForegroundWithNotification(null)
                    return START_STICKY
                }
                val notificationText = intent.getStringExtra(EXTRA_NOTIFICATION_TEXT)
                    ?.take(MAX_NOTIFICATION_TEXT_CHARS)?.takeIf { it.isNotBlank() }
                val notificationPackage = intent.getStringExtra(EXTRA_NOTIFICATION_PACKAGE)
                    ?.take(256)?.takeIf { it.isNotBlank() }
                // Inbound notification text is untrusted third-party content by
                // definition — force the taint even if a caller forgot the extra.
                val tainted = intent.getBooleanExtra(EXTRA_TAINTED, false) || notificationText != null
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)
                val cron = intent.getStringExtra(EXTRA_CRON)
                val manual = intent.getBooleanExtra(EXTRA_MANUAL, false)
                val scheduled = intervalMs > 0 || !cron.isNullOrBlank()
                val notificationTriggered = intent.getBooleanExtra(EXTRA_NOTIFICATION_TRIGGER, false)
                val widgetAgent = if (manual) WidgetAgentRepository.scheduledById(applicationContext, agentId) else null
                if (manual && widgetAgent == null) {
                    // A widget PendingIntent can outlive the rendered RemoteViews.
                    // Re-read disk at tap time and refuse deleted, disabled,
                    // malformed, or no-longer-scheduled agents rather than trusting
                    // stale extras or an RN in-memory reference.
                    Log.i(TAG, "Manual widget RUN_AGENT for $agentId refused: registered scheduled agent not found")
                    if (!hasProtectedWork()) {
                        startForegroundWithNotification(null)
                        stopForeground(STOP_FOREGROUND_REMOVE)
                        stopSelf(startId)
                        return START_NOT_STICKY
                    }
                    startForegroundWithNotification(null)
                    return START_STICKY
                }
                // A widget tap runs without an Activity/attending user. Mark it
                // unattended so per-action approval remains fail-closed exactly as
                // for an AlarmManager fire, even though it intentionally carries no
                // interval/cron extras and must not re-arm the schedule.
                val unattended = scheduled || manual || (notificationTriggered && !isAppUiForeground())
                startForegroundWithNotification("Agent running in background")
                if (manual) {
                    ScouterStateStore(applicationContext).recordWidgetAgentRunStarted(
                        agentId,
                        widgetAgent!!.name
                    )
                    ScouterWidgetProvider.updateAll(applicationContext, force = true)
                }
                runAgentInBackground(agentId, tainted, unattended, manual, widgetAgent?.name, notificationText, notificationPackage, intervalMs, cron)
                return START_STICKY
            }
        }

        // Default: start/restart with base notification
        if (!hasProtectedWork()) {
            Log.i(TAG, "Default start with no sessions — not keeping empty service sticky")
            startForegroundWithNotification(null)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
            return START_NOT_STICKY
        }
        startForegroundWithNotification(null)
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // This is the key method — called when user swipes app from recents.
        // Re-assert foreground status so Android doesn't kill the process.
        Log.i(TAG, "onTaskRemoved — re-asserting foreground service")
        if (!hasProtectedWork()) {
            stopSelf()
        } else {
            startForegroundWithNotification(null)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "Service destroyed sessions=${sessionRegistry.size} ids=${sessionRegistry.keys.joinToString(",")}")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Private helpers ─────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Terminal Session",
                NotificationManager.IMPORTANCE_LOW      // no sound, no heads-up
            ).apply {
                description = "Keeps terminal sessions alive in the background"
                setShowBadge(false)
                setSound(null, null)
                enableLights(false)
                enableVibration(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(extraInfo: String?): Notification {
        // Tapping the notification opens the app
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingLaunch = if (launchIntent != null) {
            PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else null

        // "Exit" action to stop the service + kill sessions
        val stopIntent = Intent(this, TerminalSessionService::class.java).apply {
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val sessionCount = sessionRegistry.size
        val contentText = when {
            extraInfo?.isNotBlank() == true -> extraInfo
            sessionCount == 1 -> "Terminal session active"
            sessionCount > 1 -> "$sessionCount terminal sessions active"
            else -> "Terminal running"
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }

        return builder
            .setContentTitle("Shelly")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_manage) // system icon — replace with your own later
            .setOngoing(true)
            .setContentIntent(pendingLaunch)
            .addAction(
                Notification.Action.Builder(
                    null, "Exit", pendingStop
                ).build()
            )
            .build()
    }

    private fun startForegroundWithNotification(info: String?) {
        val notification = buildNotification(info)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // API 34+: must specify foregroundServiceType
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground", e)
        }
    }

    private fun updateNotification(info: String) {
        val notification = buildNotification(info)
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun runAgentInBackground(
        agentId: String,
        tainted: Boolean,
        unattended: Boolean,
        widgetManual: Boolean = false,
        widgetAgentName: String? = null,
        notificationText: String? = null,
        notificationPackage: String? = null,
        intervalMs: Long = 0L,
        cron: String? = null
    ) {
        activeAgentRuns.incrementAndGet()
        Thread {
            val wakeLock = acquireAgentWakeLock(agentId)
            // B: watch the action-approval request dir natively from the FGS so a
            // draft/notify/webhook approval notification still posts when the app is
            // backgrounded or the RN JS thread is paused/thermal-killed (the RN
            // 500ms poll in app/_layout.tsx only runs while the Activity is alive).
            val approvalObserver = startAgentActionApprovalObserver()
            var runResult: AgentRunResult? = null
            var crashType: String? = null
            try {
                // AgentRuntime announces the run outcome itself (agent-result /
                // error notification); we don't need its return value here.
                runResult = AgentRuntime.runAgent(
                    applicationContext,
                    agentId,
                    tainted = tainted,
                    unattended = unattended,
                    notificationText = notificationText,
                    notificationPackage = notificationPackage
                )
            } catch (e: Exception) {
                Log.e(TAG, "Agent $agentId crashed while running", e)
                crashType = e.javaClass.simpleName
            } finally {
                runCatching { approvalObserver?.stopWatching() }
                releaseAgentWakeLock(wakeLock, agentId)
            }

            // Decide the next alarm only after the unattended run outcome is
            // known. This makes the circuit breaker independent of RN/foreground
            // log sync. The counter is native-persistent across process death;
            // the third consecutive failure disables metadata and cancels both
            // live and boot-restored schedules before another alarm can be armed.
            if (intervalMs > 0 || !cron.isNullOrBlank()) {
                val shouldRearm = recordScheduledRunOutcome(agentId, !scheduledRunFailed(agentId, runResult))
                if (shouldRearm) {
                    try {
                        AgentAlarmScheduler.scheduleNextIfAgentEnabled(applicationContext, agentId, intervalMs, cron)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to re-arm next alarm for $agentId", e)
                    }
                }
            }

            if (widgetManual) {
                val result = runResult
                ScouterStateStore(applicationContext).recordWidgetAgentRunFinished(
                    agentId = agentId,
                    agentName = widgetAgentName ?: agentId,
                    success = result?.success == true,
                    error = when {
                        crashType != null -> "runtime $crashType"
                        result == null -> "runtime unavailable"
                        result.success -> null
                        else -> "exit ${result.exitCode}"
                    }
                )
                ScouterWidgetProvider.updateAll(applicationContext, force = true)
            }

            // The run outcome (success/failure + a readable preview) is announced
            // exactly once by the agent-result notification (NotificationDispatcher),
            // so we deliberately do NOT post a separate "Agent completed: <id>" card
            // here — that was duplicate noise. We only manage the ongoing foreground
            // notification's lifecycle.
            val remainingAgents = activeAgentRuns.decrementAndGet()
            if (sessionRegistry.isEmpty() && remainingAgents <= 0) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            } else {
                // Terminals are still alive (or another agent is running): revert the
                // ongoing notification to its base text instead of leaving it on the
                // "Agent running" line.
                updateNotification("")
            }
        }.apply {
            name = "ShellyAgent-$agentId"
            isDaemon = true
            start()
        }
    }

    private fun hasProtectedWork(): Boolean =
        sessionRegistry.isNotEmpty() || activeAgentRuns.get() > 0

    /**
     * Mirrors lib/agent-manager.ts's haltSentinelPath() ($HOME/.shelly/agents/.halted).
     * Written/removed by haltAllAgents()/resumeAllAgents() on the JS side; this is a
     * plain file existence check so a JS-thread pause/kill can never mask the halt.
     * Fails closed on unexpected I/O: losing the ability to verify a kill switch
     * must never be interpreted as permission to execute.
     */
    private fun isGloballyHalted(): Boolean {
        return try {
            val homeDir = HomeInitializer.getHomeDir(applicationContext)
            File(homeDir, ".shelly/agents/.halted").exists()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to check global halt sentinel; defaulting to halted (fail closed)", e)
            true
        }
    }

    private fun isAppUiForeground(): Boolean {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun scheduledRunFailed(agentId: String, result: AgentRunResult?): Boolean {
        if (result == null) return true
        if (result.success) return false
        return try {
            val homeDir = HomeInitializer.getHomeDir(applicationContext)
            val logDir = File(homeDir, ".shelly/agents/logs/$agentId")
            val latestStatus = logDir.listFiles { file -> file.isFile && file.extension == "json" }
                ?.mapNotNull { file ->
                    runCatching {
                        val json = JSONObject(file.readText())
                        if (json.optString("agentId") != agentId || !json.has("timestamp")) null
                        else json.optLong("timestamp") to json.optString("status")
                    }.getOrNull()
                }
                ?.maxByOrNull { it.first }
                ?.second
                ?: return true
            // Match the JS circuit breaker: skipped and transient unavailable
            // outcomes break the error streak; only status=error increments it.
            latestStatus == "error"
        } catch (e: Exception) {
            Log.w(TAG, "Could not classify scheduled outcome for $agentId; counting as failure", e)
            true
        }
    }

    @Synchronized
    private fun recordScheduledRunOutcome(agentId: String, success: Boolean): Boolean {
        val prefs = getSharedPreferences(CIRCUIT_BREAKER_PREFS, Context.MODE_PRIVATE)
        if (success) {
            prefs.edit().remove(agentId).commit()
            return true
        }
        val failures = prefs.getInt(agentId, 0) + 1
        if (!prefs.edit().putInt(agentId, failures).commit()) {
            Log.e(TAG, "Circuit breaker counter persistence failed for $agentId; suppressing re-arm")
            disableScheduledAgent(agentId)
            return false
        }
        if (failures < CIRCUIT_BREAKER_THRESHOLD) return true

        Log.e(TAG, "Circuit breaker tripped for $agentId after $failures consecutive failures")
        // A later explicit re-enable starts a fresh consecutive-failure window.
        prefs.edit().remove(agentId).commit()
        disableScheduledAgent(agentId)
        return false
    }

    private fun disableScheduledAgent(agentId: String) {
        try {
            AgentAlarmScheduler.cancel(applicationContext, agentId)
        } catch (e: Exception) {
            Log.e(TAG, "Circuit breaker failed to cancel alarm for $agentId", e)
        }
        try {
            val homeDir = HomeInitializer.getHomeDir(applicationContext)
            val agentFile = File(homeDir, ".shelly/agents/$agentId.json")
            val json = JSONObject(agentFile.readText())
            if (json.optString("id") == agentId) {
                json.put("enabled", false)
                agentFile.writeText(json.toString(2))
            } else {
                Log.e(TAG, "Circuit breaker refused metadata update for $agentId: id mismatch")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Circuit breaker failed to persist disabled state for $agentId", e)
        }
    }

    private fun acquireAgentWakeLock(agentId: String): PowerManager.WakeLock? {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shelly:agent:$agentId").also {
                it.setReferenceCounted(false)
                it.acquire(35 * 60 * 1000L)
                Log.i(TAG, "Agent WakeLock acquired: $agentId")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire agent WakeLock for $agentId", e)
            null
        }
    }

    private fun releaseAgentWakeLock(wakeLock: PowerManager.WakeLock?, agentId: String) {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock.release()
                Log.i(TAG, "Agent WakeLock released: $agentId")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release agent WakeLock for $agentId", e)
        }
    }

    /**
     * B: native FileObserver on the agent-action-approval request dir. Posts the
     * approval notification via NotificationDispatcher independent of the RN JS
     * thread, so approvals survive backgrounding / thermal throttling (the RN
     * 500ms poll only runs while the Activity is alive). Dedupes by runId; the RN
     * poll still handles cancel/cleanup + foreground responsiveness.
     */
    private fun startAgentActionApprovalObserver(): FileObserver? {
        return try {
            val dir = AgentActionApprovalBridge.requestDir(applicationContext)
            val mask = FileObserver.CREATE or FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE
            val seen = java.util.Collections.synchronizedSet(HashSet<String>())
            val observer = if (Build.VERSION.SDK_INT >= 29) {
                object : FileObserver(dir, mask) {
                    override fun onEvent(event: Int, path: String?) = onApprovalRequestEvent(dir, path, seen)
                }
            } else {
                @Suppress("DEPRECATION")
                object : FileObserver(dir.absolutePath, mask) {
                    override fun onEvent(event: Int, path: String?) = onApprovalRequestEvent(dir, path, seen)
                }
            }
            observer.startWatching()
            observer
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start agent action approval observer", e)
            null
        }
    }

    private fun onApprovalRequestEvent(dir: File, path: String?, seen: MutableSet<String>) {
        if (path == null || !path.startsWith("action-") || !path.endsWith(".json")) return
        try {
            val request = AgentActionApprovalBridge.fromRequestFile(applicationContext, File(dir, path)) ?: return
            if (!seen.add(request.runId)) return
            NotificationDispatcher(applicationContext).notifyAgentActionApprovalNeeded(request)
            Log.i(TAG, "Approval notification posted via FGS observer run=${request.runId}")
        } catch (e: Exception) {
            Log.w(TAG, "FGS approval observer dispatch failed for $path", e)
        }
    }
}
