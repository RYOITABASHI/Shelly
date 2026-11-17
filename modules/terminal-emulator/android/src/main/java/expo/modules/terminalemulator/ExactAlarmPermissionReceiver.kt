package expo.modules.terminalemulator

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED: the user
 * granted "Alarms & reminders" (API 31+; a revoke kills the app instead of
 * broadcasting). Every agent alarm armed while access was missing is INEXACT
 * and stays that way until it fires — and an inexact alarm gets no
 * foreground-service-start exemption in Doze (doze-scheduler-diagnosis §3.1).
 * Forward to TerminalSessionService ACTION_SCHEDULE_RECONCILE: the reconcile
 * pass re-arms every schedule (now exact), re-arms future one-shots at their
 * instant, and runs a just-missed occurrence late. The broadcast is
 * system-sent; exported=false (CodexRemoteAutostartReceiver pattern).
 */
class ExactAlarmPermissionReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "ExactAlarmPermReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED) return
        val app = context.applicationContext
        Log.i(TAG, "Exact-alarm access changed; reconciling agent schedules")
        AgentAlarmScheduler.startReconcileService(app, AgentAlarmScheduler.RECONCILE_REASON_EXACT_GRANTED)
    }
}
