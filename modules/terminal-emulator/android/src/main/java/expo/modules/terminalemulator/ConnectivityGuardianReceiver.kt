package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the connectivity guardian after a reboot (BOOT_COMPLETED) and an
 * app update (MY_PACKAGE_REPLACED): PendingIntent network registrations do
 * not survive either. Re-registers the Wi-Fi callback and, when Wi-Fi is
 * already up, enqueues the ON sequence. Toggle OFF / mirror unreadable =
 * nothing happens (ConnectivityGuardian.onBoot).
 *
 * exported=true like McpServerAutostartReceiver: both actions are
 * system-only protected broadcasts, and anything else is ignored here.
 */
class ConnectivityGuardianReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val reason = if (action == Intent.ACTION_BOOT_COMPLETED) "boot" else "package replaced"
        val pending = goAsync()
        Thread({
            try {
                ConnectivityGuardian.onBoot(context, reason)
            } finally {
                pending.finish()
            }
        }, "ShellyGuardianBoot").start()
    }
}

/**
 * The guardian's own broadcasts: the Wi-Fi PendingIntent callback
 * (ACTION_WIFI_AVAILABLE), the loss-debounce alarm, the run hop alarm and the
 * watchdog alarm. NOT exported: only Shelly's own PendingIntents (sent by
 * ConnectivityService / AlarmManager on Shelly's behalf) reach it.
 */
class ConnectivityGuardianEventReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ConnectivityGuardian.ACTION_WIFI_AVAILABLE,
            ConnectivityGuardian.ACTION_DEBOUNCE,
            ConnectivityGuardian.ACTION_RUN,
            ConnectivityGuardian.ACTION_WATCHDOG -> Unit
            else -> return
        }
        val pending = goAsync()
        Thread({
            try {
                ConnectivityGuardian.onInternalBroadcast(context, intent)
            } finally {
                pending.finish()
            }
        }, "ShellyGuardianEvent").start()
    }
}
