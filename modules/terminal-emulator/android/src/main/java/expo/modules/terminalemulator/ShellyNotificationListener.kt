package expo.modules.terminalemulator

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * NOTIFY-001 Increment 0 (dormant, flag-OFF): pure plumbing for cross-app
 * notification read + reply.
 *
 * This is Increment 0 ONLY — plumbing, nothing downstream consumes this yet.
 * The L1/L2 capability catalog
 * (docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md) flags
 * NOTIFY-001 as CRITICAL risk: "all notifications = perfect exfiltration
 * source, untrusted firehose". Any FUTURE increment that lets notification
 * content reach an agent prompt MUST classify it as tainted per CAP-001
 * (see lib/capability-envelope.ts's classifyEgress) — untrusted notification
 * text is exactly the kind of attacker-reachable input that taint-tracking
 * exists to contain (a poisoned notification could otherwise trick an agent
 * into spending a live secret or egressing to a non-allowlist host). Increment
 * 0 does not forward anything anywhere, so there is nothing to taint-tag yet.
 *
 * Dormant discipline mirrors BootCompletedReceiver.kt exactly: gate on a
 * SharedPreferences-backed flag (default false) at the very top of
 * onNotificationPosted, log at Log.i that a notification arrived but the
 * listener is dormant, and return BEFORE reading any notification content —
 * not even for logging. Only once the flag is on do we read the four named
 * extras fields (never the whole Bundle — it can carry large image/media
 * attachments) and even then, for this increment, only log field lengths and
 * package name, never raw third-party notification content into logcat.
 */
class ShellyNotificationListener : NotificationListenerService() {
    companion object {
        private const val TAG = "ShellyNotificationListener"
        private const val PREFS = "shelly_notification_listener"
        private const val ENABLED_KEY = "enabled"

        /** Native enable flag for the notification listener. Defaults false (dormant). */
        fun notificationListenerEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(ENABLED_KEY, false)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val context = applicationContext
        if (!notificationListenerEnabled(context)) {
            Log.i(TAG, "Notification received; listener disabled (dormant), nothing captured")
            return
        }

        // Flag is on. Increment 0: capture ONLY the four named fields (never the
        // full extras Bundle — it can carry large image/media attachments), each
        // read defensively so a malformed extras bundle from a hostile or broken
        // app can't crash the listener. Log lengths/package only — never the raw
        // title/text content — to avoid leaking third-party notification content
        // into logcat. Nothing is persisted or forwarded yet; that is Increment 1.
        try {
            val packageName = runCatching { sbn.packageName }.getOrNull() ?: "<unknown>"
            val postTime = runCatching { sbn.postTime }.getOrDefault(0L)
            val extras = runCatching { sbn.notification?.extras }.getOrNull()
            val title = runCatching {
                extras?.getCharSequence(Notification.EXTRA_TITLE)
            }.getOrNull()
            val text = runCatching {
                extras?.getCharSequence(Notification.EXTRA_TEXT)
            }.getOrNull()

            Log.i(
                TAG,
                "Notification captured (dormant consumer): pkg=$packageName " +
                    "titleLen=${title?.length ?: 0} textLen=${text?.length ?: 0} postTime=$postTime",
            )
        } catch (e: Exception) {
            Log.w(TAG, "Notification capture failed defensively", e)
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val context = applicationContext
        if (!notificationListenerEnabled(context)) {
            Log.i(TAG, "Notification removal received; listener disabled (dormant), nothing captured")
            return
        }
        val packageName = runCatching { sbn.packageName }.getOrNull() ?: "<unknown>"
        Log.i(TAG, "Notification removed (dormant consumer): pkg=$packageName")
    }
}
