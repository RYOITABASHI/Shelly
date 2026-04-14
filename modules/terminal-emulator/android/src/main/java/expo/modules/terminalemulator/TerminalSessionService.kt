package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

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
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
        }

        // Default: start/restart with base notification
        startForegroundWithNotification(null)
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // This is the key method — called when user swipes app from recents.
        // Re-assert foreground status so Android doesn't kill the process.
        Log.i(TAG, "onTaskRemoved — re-asserting foreground service")
        startForegroundWithNotification(null)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "Service destroyed")
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
}
