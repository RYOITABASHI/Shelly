package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Foreground service (specialUse, subtype connectivity_guardian) that keeps
 * the Shelly process alive while the connectivity guardian runs an ON / OFF
 * sequence (up to a few minutes: the Tailscale
 * verification and the ClosePaw settle wait), and stays RESIDENT while an
 * OFF obligation may exist (ConnectivityGuardianCore.wantsResident: online
 * after ON, the loss debounce), so the in-process Wi-Fi loss callback is live
 * and the 45 s debounce starts at the real loss even with the app closed.
 * It stops when nothing runs and no obligation is left (OFF done, toggle
 * off): ConnectivityGuardian.keepResident.
 * Same Android notes as McpServerService (Android 14+ type + permission +
 * subtype property; specialUse is not barred from BOOT_COMPLETED on 15+).
 * Started from BOOT / exact-alarm receivers (both FGS-start exemptions);
 * when the start is refused the guardian hops through an exact alarm or runs
 * without the service (ConnectivityGuardian.startRunner).
 */
class ConnectivityGuardianService : Service() {
    companion object {
        private const val TAG = "ConnectivityGuardianSvc"
        const val CHANNEL_ID = "shelly_connectivity_guardian"
        const val NOTIFICATION_ID = 7737

        /** Set on the main thread once in the foreground; cleared (under the
         *  ConnectivityGuardian monitor) right before it stops. */
        @Volatile private var running = false
        @Volatile private var instance: ConnectivityGuardianService? = null

        fun isRunning(): Boolean = running

        /** Stop the service if it is up and ConnectivityGuardian no longer
         *  needs it. Safe from any thread; decides on the main thread. */
        fun stopIfIdle() {
            Handler(Looper.getMainLooper()).post {
                val svc = instance ?: return@post
                if (svc.destroyed) return@post
                val stop = synchronized(ConnectivityGuardian) {
                    if (ConnectivityGuardian.keepResident(svc.applicationContext)) {
                        false
                    } else {
                        running = false
                        true
                    }
                }
                if (stop) svc.stopSelf(svc.lastStartId)
            }
        }

        /** False when Android refused the start (e.g. background restriction). */
        fun start(context: Context): Boolean = try {
            val intent = Intent(context, ConnectivityGuardianService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "service start refused type=${e.javaClass.simpleName}")
            false
        }
    }

    /** Main thread only. */
    private var destroyed = false
    private var lastStartId = 0

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Wi-Fi autopilot", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the Wi-Fi autopilot switches wireless debugging / Tailscale"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        destroyed = true
        running = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        if (!startForegroundCompat()) {
            // Run best effort without the service rather than drop the sequence.
            ConnectivityGuardian.drain(applicationContext) {}
            stopSelf(startId)
            return START_NOT_STICKY
        }
        instance = this
        running = true
        // A recovery entry point: reconcile against Wi-Fi (on the worker, not
        // the main thread: it commits state), then run whatever is queued;
        // stay resident afterwards while an OFF obligation may exist.
        val app = applicationContext
        ConnectivityGuardian.drain(app, prelude = { ConnectivityGuardian.onServiceStart(app) }) { stopIfIdle() }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat(): Boolean = try {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }
        val notification = builder
            .setContentTitle("Shelly - Wi-Fi autopilot")
            .setContentText("Checking wireless debugging and Tailscale…")
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setOngoing(true)
            .build()
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
