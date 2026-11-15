package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Foreground service that keeps the Shelly process (and with it the MCP
 * server node process, see McpServerSupervisor) alive while the owner has the
 * MCP server enabled — including after a reboot or an app update, before
 * Shelly is opened (McpServerAutostartReceiver).
 *
 * Android notes (targetSdk 36 via Expo SDK 54 / RN 0.81 defaults; verified
 * against developer.android.com on 2026-11-15):
 *  - Android 12+ background FGS-start restriction: starting from a receiver of
 *    ACTION_BOOT_COMPLETED / ACTION_MY_PACKAGE_REPLACED is a listed exemption
 *    ("restrictions-bg-start": "After the device reboots and receives the
 *    ACTION_BOOT_COMPLETED, ACTION_LOCKED_BOOT_COMPLETED, or
 *    ACTION_MY_PACKAGE_REPLACED intent action in a broadcast receiver").
 *  - Android 14+: type declared in the manifest (specialUse), the
 *    FOREGROUND_SERVICE_SPECIAL_USE permission (app.config.ts) and the
 *    PROPERTY_SPECIAL_USE_FGS_SUBTYPE property (module AndroidManifest.xml);
 *    startForeground passes FOREGROUND_SERVICE_TYPE_SPECIAL_USE.
 *  - Android 15+: BOOT_COMPLETED receivers may not launch dataSync, camera,
 *    mediaPlayback, phoneCall, mediaProjection or microphone FGS
 *    ("behavior-changes-15"); specialUse is not on that list, and has no
 *    6-hour limit (that applies to dataSync / mediaProcessing only).
 *  - A START_STICKY restart after the process was killed: the
 *    restrictions-bg-start exemption list does not name it (an independent
 *    review said the Service reference exempts sticky FGS restarts; not
 *    confirmed in the fetched text). Either way, if startForeground is
 *    refused there, the service stops itself and the server stays down until
 *    the next app open / boot (residual risk, see DEFERRED.md).
 *
 * The notification is mandatory (it is what makes this a foreground service)
 * and tells the owner the server is listening. It has no "turn off" action on
 * purpose: the owner's switch is the in-app setting, which also clears the
 * native mirror (McpAutostartStore). Battery-optimization exemption is never
 * requested here.
 */
class McpServerService : Service() {

    companion object {
        private const val TAG = "McpServerService"
        const val CHANNEL_ID = "shelly_mcp_server"
        const val NOTIFICATION_ID = 7736
        const val ACTION_START = "expo.modules.terminalemulator.MCP_SERVER_START"
        const val EXTRA_REASON = "reason"
        private const val PORT = 8767 // MCPBridge.PORT
    }

    /** Main thread only. A worker's late post must not touch a stopped service. */
    private var destroyed = false

    override fun onCreate() {
        super.onCreate()
        McpServerSupervisor.onServiceCreated()
        createNotificationChannel()
    }

    override fun onDestroy() {
        destroyed = true
        // Destroyed while a server is still wanted: the supervisor's watchdog
        // requests the service again (restore, not stop; see
        // McpServerSupervisor "Service destroyed while a server is still wanted").
        McpServerSupervisor.onServiceDestroyed()
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // null intent = START_STICKY restart after the process died.
        val reason = intent?.getStringExtra(EXTRA_REASON)?.take(40)
            ?: if (intent == null) "service restart" else "start"
        Log.i(TAG, "onStartCommand reason=$reason")
        // startForeground first: required within a few seconds of
        // startForegroundService, before any slow work.
        if (!startForegroundCompat()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        Thread({
            val wanted = runCatching { McpServerSupervisor.onServiceStart(applicationContext, reason) }
                .onFailure { Log.w(TAG, "MCP server start failed", it) }
                .getOrDefault(false)
            Handler(Looper.getMainLooper()).post {
                if (destroyed) return@post
                if (wanted && McpServerSupervisor.isWanted()) {
                    // Refresh the text with the switches actually in effect.
                    startForegroundCompat()
                } else {
                    // stopSelf(startId): a newer start (e.g. the owner just
                    // turned the server on in the app) keeps the service.
                    stopSelf(startId)
                }
            }
        }, "ShellyMcpServiceStart").start()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "MCP server",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shown while Shelly's MCP server is listening for remote MCP clients"
                setShowBadge(false)
                setSound(null, null)
                enableLights(false)
                enableVibration(false)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingLaunch = if (launchIntent != null) {
            PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        } else null
        val switches = McpServerSupervisor.wantedSwitches()
        val text = if (switches == null) {
            "Starting the MCP server…"
        } else {
            val (exec, readTerminal, diagnostics) = switches
            "Listening on port $PORT for clients with your MCP token. " +
                "Exec/write: ${if (exec) "on (each call needs your approval in Shelly)" else "off"}. " +
                "Read terminal: ${if (readTerminal) "on" else "off"}. " +
                "Diagnostics: ${if (diagnostics) "on" else "off"}. Turn it off in Shelly's settings."
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        return builder
            .setContentTitle("Shelly - MCP server on")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setOngoing(true)
            .setContentIntent(pendingLaunch)
            .build()
    }

    private fun startForegroundCompat(): Boolean = try {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "startForeground refused (${e.javaClass.simpleName})")
        false
    }
}
