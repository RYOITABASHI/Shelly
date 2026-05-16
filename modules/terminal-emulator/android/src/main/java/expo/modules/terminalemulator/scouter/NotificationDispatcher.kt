package expo.modules.terminalemulator.scouter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import expo.modules.terminalemulator.R

class NotificationDispatcher(private val context: Context) {
    private val notificationManager = context.getSystemService(NotificationManager::class.java)

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationManager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Scouter",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Scouter agent session updates"
                }
            )
        }
    }

    fun maybeNotify(event: ScouterEvent, snapshot: SessionSnapshot) {
        when (snapshot.currentStatus) {
            ScouterStatus.ERROR -> notify(
                9201,
                "Scouter error",
                event.errorMessage ?: snapshot.lastError ?: "${snapshot.projectName} failed"
            )
            ScouterStatus.COMPLETED -> notify(
                9202,
                "Agent completed",
                "${snapshot.source.badge()} · ${snapshot.projectName}"
            )
            else -> Unit
        }
    }

    fun notifyLongRunning(snapshot: SessionSnapshot) {
        notify(9203, "Agent still running", "${snapshot.currentTool ?: "Tool"} · ${snapshot.projectName}")
    }

    private fun notify(id: Int, title: String, text: String) {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val pendingLaunch = if (launchIntent != null) {
            PendingIntent.getActivity(
                context,
                id,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else null

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        val notification = builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(pendingLaunch)
            .setAutoCancel(true)
            .build()
        notificationManager.notify(id, notification)
    }

    companion object {
        private const val CHANNEL_ID = "scouter"
    }
}
