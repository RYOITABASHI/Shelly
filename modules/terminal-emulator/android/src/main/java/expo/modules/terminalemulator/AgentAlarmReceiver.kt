package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.AlarmManager
import android.app.PendingIntent
import android.os.Build
import android.util.Log
import java.util.Calendar

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
        const val EXTRA_CRON = "cron"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra(EXTRA_AGENT_ID) ?: return
        val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)
        val cron = intent.getStringExtra(EXTRA_CRON)
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
            scheduleNext(context.applicationContext, agentId, intervalMs, cron)
        }
    }

    private fun scheduleNext(context: Context, agentId: String, intervalMs: Long, cron: String?) {
        try {
            val triggerAt = nextTriggerAt(cron) ?: (System.currentTimeMillis() + intervalMs)
            val nextIntent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra(EXTRA_AGENT_ID, agentId)
                putExtra(EXTRA_INTERVAL_MS, intervalMs)
                if (!cron.isNullOrBlank()) putExtra(EXTRA_CRON, cron)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                getAgentRequestCode(context, agentId),
                nextIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            scheduleAlarm(alarmManager, triggerAt, pendingIntent)
            Log.i(TAG, "Next agent alarm scheduled: $agentId at $triggerAt")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule next agent alarm for $agentId", e)
        }
    }

    private fun nextTriggerAt(cron: String?): Long? {
        if (cron.isNullOrBlank()) return null
        val parts = cron.trim().split(Regex("\\s+"))
        if (parts.size != 5) return null

        val minute = parts[0]
        val hour = parts[1]
        val dayOfMonth = parts[2]
        val month = parts[3]
        val dayOfWeek = parts[4]
        val now = Calendar.getInstance()
        val target = Calendar.getInstance()

        val everyMin = Regex("^\\*/(\\d+)$").matchEntire(minute)?.groupValues?.get(1)?.toIntOrNull()
        if (everyMin != null && everyMin > 0 && hour == "*" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            target.set(Calendar.SECOND, 0)
            target.set(Calendar.MILLISECOND, 0)
            val currentMinute = now.get(Calendar.MINUTE)
            val nextMinute = ((currentMinute + 1 + everyMin - 1) / everyMin) * everyMin
            if (nextMinute >= 60) {
                target.add(Calendar.HOUR_OF_DAY, 1)
                target.set(Calendar.MINUTE, nextMinute % 60)
            } else {
                target.set(Calendar.MINUTE, nextMinute)
            }
            return target.timeInMillis
        }

        val parsedMinute = minute.toIntOrNull()
        val parsedHour = hour.toIntOrNull()
        if (parsedMinute == null || parsedHour == null || dayOfMonth != "*" || month != "*") return null

        target.set(Calendar.HOUR_OF_DAY, parsedHour)
        target.set(Calendar.MINUTE, parsedMinute)
        target.set(Calendar.SECOND, 0)
        target.set(Calendar.MILLISECOND, 0)

        // Single day OR a comma list (e.g. "1,5" = Mon/Fri): mirror the TS
        // scheduler (lib/agent-scheduler.ts) and re-arm at the SOONEST listed day.
        if (Regex("^\\d+(,\\d+)*$").matches(dayOfWeek)) {
            var best: Long? = null
            for (token in dayOfWeek.split(",")) {
                val parsedDow = token.toIntOrNull() ?: continue
                val targetDow = if (parsedDow % 7 == 0) Calendar.SUNDAY else (parsedDow % 7) + 1
                val candidate = target.clone() as Calendar
                candidate.set(Calendar.DAY_OF_WEEK, targetDow)
                if (candidate.timeInMillis <= now.timeInMillis) {
                    candidate.add(Calendar.DAY_OF_YEAR, 7)
                }
                if (best == null || candidate.timeInMillis < best!!) {
                    best = candidate.timeInMillis
                }
            }
            return best
        }

        if (dayOfWeek != "*") return null
        if (target.timeInMillis <= now.timeInMillis) {
            target.add(Calendar.DAY_OF_YEAR, 1)
        }
        return target.timeInMillis
    }

    private fun scheduleAlarm(alarmManager: AlarmManager, triggerAt: Long, pendingIntent: PendingIntent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms())
            ) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Exact alarm denied; falling back to inexact alarm", e)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent)
            }
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
