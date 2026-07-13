package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/** Self-contained on-device reply test. It never targets another app or contact. */
object DmReplyTestNotifier {
    const val CHANNEL_ID = "shelly_dm_reply_test"
    const val NOTIFICATION_ID = 9960
    const val RESULT_KEY = "dm_reply_test_input"
    const val KEY_RECEIVED_TEXT = "dm_reply_test_received_text"
    const val KEY_RECEIVED_AT_MS = "dm_reply_test_received_at_ms"
    private const val TAG = "DmReplyTestNotifier"

    fun post(context: Context): Boolean = runCatching {
        val manager = context.getSystemService(NotificationManager::class.java)
            ?: error("NotificationManager unavailable")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID,
                "Shelly DM reply self-test",
                NotificationManager.IMPORTANCE_DEFAULT,
            ))
        }
        val input = RemoteInput.Builder(RESULT_KEY).setLabel("Reply").build()
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, DmReplyTestReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0,
        )
        val actionBuilder = Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Reply", pendingIntent)
            .addRemoteInput(input)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            actionBuilder.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
        }
        val action = actionBuilder.build()
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        manager.notify(NOTIFICATION_ID, builder
            .setContentTitle("Shelly DM reply self-test")
            .setContentText("Synthetic notification; no real contact is involved")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .addAction(action)
            .setAutoCancel(false)
            .build())
        Log.i(TAG, "Synthetic test notification posted")
    }.onFailure { Log.w(TAG, "Synthetic test notification failed", it) }.isSuccess

    fun clear(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }
}

class DmReplyTestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        runCatching {
            val text = RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(DmReplyTestNotifier.RESULT_KEY)?.toString() ?: return
            Log.i(TAG, "Synthetic reply received textLen=${text.length}")
            context.getSharedPreferences(ShellyNotificationListener.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(DmReplyTestNotifier.KEY_RECEIVED_TEXT, text)
                .putLong(DmReplyTestNotifier.KEY_RECEIVED_AT_MS, System.currentTimeMillis())
                .apply()
        }.onFailure { Log.w(TAG, "Synthetic reply receive failed", it) }
    }

    companion object { private const val TAG = "DmReplyTestReceiver" }
}
