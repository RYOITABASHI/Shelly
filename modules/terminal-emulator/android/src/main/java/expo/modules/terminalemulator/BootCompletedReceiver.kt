package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * L1 BOOT-AUTOSTART (production-default ON since P0-2, 2026-07-15).
 *
 * AlarmManager alarms armed via setExactAndAllowWhileIdle are CLEARED by the OS on
 * reboot, so scheduled agents silently stop firing after a restart. This receiver
 * re-arms every persisted scheduled agent on BOOT_COMPLETED (via
 * AgentAlarmScheduler.rearmAllFromPersistedSchedules).
 *
 * AgentAlarmScheduler.bootAutostartEnabled() now defaults true, so
 * rearmAllFromPersistedSchedules actively re-arms on a normal install; the flag
 * check below is kept as the gate it always was (an internal rollout kill switch,
 * not a user-facing setting — no production setter flips it to false today) and
 * as a safety net for a test/debug build that explicitly disables it. The receiver
 * must be declared exported=true to receive the system BOOT_COMPLETED broadcast;
 * its BroadcastReceiver runs before RN is up, which is exactly why the re-arm
 * reads from native SharedPreferences rather than the JS agent store.
 */
class BootCompletedReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "BootCompletedReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Only the AOSP protected BOOT_COMPLETED (system-sender only). No
        // QUICKBOOT_POWERON (spoofable) / LOCKED_BOOT_COMPLETED (needs
        // directBootAware, which breaks MODE_PRIVATE prefs pre-unlock).
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = context.applicationContext
        if (!AgentAlarmScheduler.bootAutostartEnabled(app)) {
            Log.i(TAG, "Boot received; autostart disabled via override flag, nothing to re-arm")
            return
        }
        try {
            val count = AgentAlarmScheduler.rearmAllFromPersistedSchedules(app)
            Log.i(TAG, "Boot autostart re-armed $count scheduled agent(s)")
        } catch (e: Exception) {
            Log.e(TAG, "Boot autostart re-arm failed", e)
        }
    }
}
