package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Backward-compat bridge for scheduled-agent alarms armed by an OLDER build, which
 * targeted this BroadcastReceiver via PendingIntent.getBroadcast and then started the
 * foreground service.
 *
 * As of 2026-06-27 new alarms are armed DIRECTLY at TerminalSessionService via
 * AgentAlarmScheduler (getForegroundService) — the broadcast trampoline was being
 * dropped for cached/frozen background processes on Android 14+/Samsung One UI, so
 * unattended fires never reached the agent. Re-registration on app launch
 * (scheduleAgent) cancels these legacy broadcast alarms and migrates them to the
 * service. This receiver remains only so any straggler legacy alarm that still fires
 * before migration starts the agent and re-arms itself on the new path.
 */
class AgentAlarmReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AgentAlarmReceiver"
        const val EXTRA_AGENT_ID = "agent_id"
        const val EXTRA_INTERVAL_MS = "interval_ms"
        const val EXTRA_CRON = "cron"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID)
        if (agentId.isNullOrBlank()) {
            Log.w(TAG, "Legacy alarm received without agent id")
            return
        }
        val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)
        val cron = intent.getStringExtra(EXTRA_CRON)
        Log.i(TAG, "Legacy alarm triggered for agent: $agentId")
        val app = context.applicationContext

        try {
            val serviceIntent = Intent(app, TerminalSessionService::class.java).apply {
                action = TerminalSessionService.ACTION_RUN_AGENT
                putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(serviceIntent)
            } else {
                app.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Shelly agent service for $agentId", e)
        }

        // Re-arm via the new path so a legacy agent self-migrates to the service alarm.
        if (intervalMs > 0 || !cron.isNullOrBlank()) {
            try {
                AgentAlarmScheduler.scheduleNext(app, agentId, intervalMs, cron)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to re-arm next alarm for $agentId", e)
            }
        }
    }
}
