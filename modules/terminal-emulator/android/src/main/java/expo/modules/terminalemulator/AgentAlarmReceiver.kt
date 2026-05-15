package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.AlarmManager
import android.app.PendingIntent
import android.os.Build
import android.util.Log

/**
 * BroadcastReceiver for scheduled agent execution.
 * Triggered by AlarmManager, then delegates work to Shelly's foreground
 * service. The receiver stays short-lived; the service owns long-running
 * execution through Shelly's bundled Plan B runtime.
 */
class AgentAlarmReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AgentAlarmReceiver"
        const val EXTRA_AGENT_ID = "agent_id"
        const val EXTRA_INTERVAL_MS = "interval_ms"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID) ?: return
        val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)
        Log.i(TAG, "Alarm triggered for agent: $agentId")

        try {
            val serviceIntent = Intent(context, TerminalSessionService::class.java).apply {
                action = TerminalSessionService.ACTION_RUN_AGENT
                putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Shelly agent service for $agentId", e)
        }

        if (intervalMs > 0) {
            scheduleNext(context.applicationContext, agentId, intervalMs)
        }
    }

    private fun scheduleNext(context: Context, agentId: String, intervalMs: Long) {
        try {
            val triggerAt = System.currentTimeMillis() + intervalMs
            val nextIntent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra(EXTRA_AGENT_ID, agentId)
                putExtra(EXTRA_INTERVAL_MS, intervalMs)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                getAgentRequestCode(context, agentId),
                nextIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            } else {
                alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            }
            Log.i(TAG, "Next agent alarm scheduled: $agentId in ${intervalMs}ms")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule next agent alarm for $agentId", e)
        }
    }

    private fun getAgentRequestCode(context: Context, agentId: String): Int {
        val prefs = context.getSharedPreferences("shelly_agent_ids", Context.MODE_PRIVATE)
        val existing = prefs.getInt(agentId, -1)
        if (existing >= 0) return existing
        val nextId = prefs.getInt("_next_id", 1000)
        prefs.edit().putInt(agentId, nextId).putInt("_next_id", nextId + 1).apply()
        return nextId
    }
}
