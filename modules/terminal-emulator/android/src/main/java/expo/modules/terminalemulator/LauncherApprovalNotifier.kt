package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Launcher ingress Phase 2 (phase 2 fact sheet P2-A1 (b)): the "please
 * review" notification for a pending launcher submission while Shelly is in
 * the background, the same shape as AgentAddHandoff's: its tap only opens
 * Shelly, where the foreground approval prompt (RN, hooks/use-launcher-approval.ts)
 * shows the oldest pending submission. The notification never carries the
 * instruction text (lock screen, other apps' listeners); it is cancelled once
 * nothing is pending and times out with the approval window.
 *
 * Everything runs on one background thread: the Binder thread of the
 * launcher Provider only enqueues ([onPending]) and never waits (R4).
 */
object LauncherApprovalNotifier {
    private const val TAG = "LauncherApproval"
    const val CHANNEL_ID = "launcher_submission_review"
    // Next to AgentAddHandoff / ClosePaw's 0x37C1A0xx ids, unused elsewhere.
    const val NOTIFICATION_ID = 0x37C1A048
    private const val REQUEST_CODE = 0x37C1A049

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ShellyLauncherApproval").apply { isDaemon = true }
    }

    /** A pending submission was just written: post the notification unless Shelly is in the foreground. Never blocks. */
    fun onPending(context: Context) {
        val app = context.applicationContext
        try {
            executor.execute {
                try {
                    if (!AgentAddHandoff.isForeground()) post(app)
                } catch (e: Exception) {
                    Log.w(TAG, "review notification failed type=${e.javaClass.simpleName}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "review notification not queued type=${e.javaClass.simpleName}")
        }
    }

    /** After a decision or an expiry: cancel the notification when nothing is pending any more. Never blocks. */
    fun refreshAsync(context: Context) {
        val app = context.applicationContext
        try {
            executor.execute {
                try {
                    if (McpRunTickets.pendingTotal(app) == 0) cancel(app)
                } catch (e: Exception) {
                    Log.w(TAG, "review notification refresh failed type=${e.javaClass.simpleName}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "review notification refresh not queued type=${e.javaClass.simpleName}")
        }
    }

    fun cancel(context: Context) {
        runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID) }
    }

    private fun post(context: Context): Boolean {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return false
        if (!nm.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.launcher_review_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.launcher_review_channel_description) }
            nm.createNotificationChannel(channel)
            if (nm.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        // The tap only opens Shelly; RN then shows the oldest pending submission.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return false
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val tap = PendingIntent.getActivity(
            context,
            REQUEST_CODE,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID).setTimeoutAfter(LauncherIngressLimits.APPROVAL_WINDOW_MS)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
        }
        builder
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentTitle(context.getString(R.string.launcher_review_notification_title))
            .setContentText(context.getString(R.string.launcher_review_notification_body))
            .setStyle(Notification.BigTextStyle().bigText(context.getString(R.string.launcher_review_notification_body)))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(tap)
            .setAutoCancel(true)
        nm.notify(NOTIFICATION_ID, builder.build())
        return true
    }
}
