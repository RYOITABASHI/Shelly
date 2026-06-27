package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
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
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

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
                // Global kill-switch (STOP-ALL): while halted, refuse to run. Scheduled
                // fires are already prevented by alarm cancellation in haltAllAgents, but
                // a MANUAL fire (widget one-tap RUN) is a direct service start that
                // bypasses the alarm layer — so this sentinel check is what enforces the
                // kill-switch for the widget path (and is defense-in-depth for any alarm
                // that races a halt). The sentinel is written/cleared by RN
                // (agent-manager.ts haltAllAgents/resumeAllAgents) at
                // $HOME/.shelly/agents/.halted.
                if (isAgentsHalted()) {
                    Log.w(TAG, "RUN_AGENT refused: agents halted (STOP-ALL) — $agentId")
                    // getForegroundService requires a prompt startForeground; satisfy it
                    // then stop so nothing runs and no notification lingers.
                    startForegroundWithNotification(null)
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return START_NOT_STICKY
                }
                startForegroundWithNotification("Agent running in background")
                runAgentInBackground(agentId)
                // Alarm-fired runs carry interval/cron — re-arm the next fire here now
                // that the alarm targets this service directly (no receiver in the
                // loop). A manual run (no interval/cron extras) is a no-op.
                val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)
                val cron = intent.getStringExtra(EXTRA_CRON)
                if (intervalMs > 0 || !cron.isNullOrBlank()) {
                    try {
                        AgentAlarmScheduler.scheduleNext(applicationContext, agentId, intervalMs, cron)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to re-arm next alarm for $agentId", e)
                    }
                }
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

    private fun runAgentInBackground(agentId: String) {
        activeAgentRuns.incrementAndGet()
        Thread {
            val wakeLock = acquireAgentWakeLock(agentId)
            // B: watch the action-approval request dir natively from the FGS so a
            // draft/notify/webhook approval notification still posts when the app is
            // backgrounded or the RN JS thread is paused/thermal-killed (the RN
            // 500ms poll in app/_layout.tsx only runs while the Activity is alive).
            val approvalObserver = startAgentActionApprovalObserver()
            try {
                // AgentRuntime announces the run outcome itself (agent-result /
                // error notification); we don't need its return value here.
                AgentRuntime.runAgent(applicationContext, agentId)
            } catch (e: Exception) {
                Log.e(TAG, "Agent $agentId crashed while running", e)
            } finally {
                runCatching { approvalObserver?.stopWatching() }
                releaseAgentWakeLock(wakeLock, agentId)
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

    /** STOP-ALL kill-switch sentinel (written by RN agent-manager haltAllAgents).
     *  Its presence means every agent run — scheduled OR manual — must be refused. */
    private fun isAgentsHalted(): Boolean =
        try {
            File(HomeInitializer.getHomeDir(applicationContext), ".shelly/agents/.halted").exists()
        } catch (e: Exception) {
            // Deliberate fail-OPEN: the RN in-memory `halted` flag + alarm cancellation
            // are the primary kill-switch; this sentinel only backstops the cross-process
            // manual (widget) path. A filesystem error on app-private storage is extremely
            // unlikely, and the per-action gate + unattended fail-closed still apply
            // downstream, so a missed sentinel check is not a new attack surface.
            Log.e(TAG, "Failed to check halt sentinel — proceeding (fail-open)", e)
            false
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
