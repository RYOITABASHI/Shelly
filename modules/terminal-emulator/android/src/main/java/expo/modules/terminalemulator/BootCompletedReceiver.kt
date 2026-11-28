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
 * AgentAlarmScheduler.rearmAllFromPersistedSchedules), then asks TerminalSessionService
 * for a catch-up reconcile (AgentAlarmScheduler.reconcile). MY_PACKAGE_REPLACED
 * (an in-app update kills a run in flight) only reconciles.
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
        // Only AOSP protected broadcasts (system-sender only): BOOT_COMPLETED
        // and MY_PACKAGE_REPLACED. No QUICKBOOT_POWERON (spoofable) /
        // LOCKED_BOOT_COMPLETED (needs directBootAware, which breaks
        // MODE_PRIVATE prefs pre-unlock).
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext
        if (action == Intent.ACTION_BOOT_COMPLETED) {
            // Residency evidence (independent of the autostart flag): a `boot`
            // line per supervised service and the 10-minute tick re-armed (a
            // reboot cleared it). Bounded by the broadcast's goAsync window.
            val pending = runCatching { goAsync() }.getOrNull()
            ResidencyLedger.onBoot(app) { runCatching { pending?.finish() } }
        }
        if (!AgentAlarmScheduler.bootAutostartEnabled(app)) {
            Log.i(TAG, "$action received; autostart disabled via override flag, nothing to re-arm")
            return
        }
        if (action == Intent.ACTION_BOOT_COMPLETED) {
            // A reboot cleared every alarm: re-arm the next future occurrences
            // here (cheap, no service needed), then reconcile in the service
            // (a run that fell into the downtime may still run late).
            try {
                val count = AgentAlarmScheduler.rearmAllFromPersistedSchedules(app)
                Log.i(TAG, "Boot autostart re-armed $count scheduled agent(s)")
            } catch (e: Exception) {
                Log.e(TAG, "Boot autostart re-arm failed", e)
            }
            AgentAlarmScheduler.startReconcileService(app, AgentAlarmScheduler.RECONCILE_REASON_BOOT)
        } else {
            // An update keeps armed alarms but kills a run in flight. No
            // blanket forward re-arm here (it would replace a deferred, still
            // pending alarm); reconcile decides per schedule.
            AgentAlarmScheduler.startReconcileService(app, AgentAlarmScheduler.RECONCILE_REASON_PACKAGE_REPLACED)
        }
    }
}
