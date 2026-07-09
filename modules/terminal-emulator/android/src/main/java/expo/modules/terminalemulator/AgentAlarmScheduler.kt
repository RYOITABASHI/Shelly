package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.Calendar

/**
 * Single source of truth for scheduling/cancelling scheduled-agent alarms.
 *
 * Background-execution fix (2026-06-27): the old path armed the AlarmManager at a
 * manifest BroadcastReceiver (AgentAlarmReceiver) which then started the foreground
 * service. On Android 14+ / Samsung One UI (API 36) the alarm fired but the broadcast
 * was NOT delivered to the app's cached/frozen process while the device was idle, so
 * onReceive never ran and the agent never executed unattended (verified on-device:
 * AMS received the broadcast at the cron minute, but the receiver's first log line
 * never printed, no FGS, no output — while a manual UI-triggered run worked fine).
 *
 * We now target the alarm PendingIntent DIRECTLY at TerminalSessionService via
 * getForegroundService(): AlarmManager's exact-while-idle delivery treats it as a
 * privileged FGS launch (it carries the temporary while-idle allowlist to the
 * target), with no broadcast trampoline to be deferred. The next-fire re-arm moves
 * into the service, which now carries the interval/cron extras and owns the loop.
 *
 * AgentAlarmReceiver is kept only as a backward-compat bridge for alarms armed by an
 * older build before this change; it now delegates re-arming here so those agents
 * self-migrate to the service PendingIntent on their next fire.
 */
object AgentAlarmScheduler {
    private const val TAG = "AgentAlarmScheduler"
    private const val PREFS = "shelly_agent_ids"

    private fun piFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    /** Stable per-agent request code, shared with the legacy receiver path. */
    fun getAgentRequestCode(context: Context, agentId: String): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getInt(agentId, -1)
        if (existing >= 0) return existing
        val nextId = prefs.getInt("_next_id", 1000)
        prefs.edit().putInt(agentId, nextId).putInt("_next_id", nextId + 1).apply()
        return nextId
    }

    /** The alarm operation: launch the FGS directly (no broadcast hop). */
    private fun runServicePendingIntent(
        context: Context,
        agentId: String,
        intervalMs: Long,
        cron: String?
    ): PendingIntent {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            putExtra(TerminalSessionService.EXTRA_INTERVAL_MS, intervalMs)
            if (!cron.isNullOrBlank()) putExtra(TerminalSessionService.EXTRA_CRON, cron)
        }
        val rc = getAgentRequestCode(context, agentId)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, rc, intent, piFlags())
        } else {
            PendingIntent.getService(context, rc, intent, piFlags())
        }
    }

    /** Legacy broadcast PI — only built to CANCEL alarms armed before this fix. */
    private fun legacyBroadcastPendingIntent(context: Context, agentId: String): PendingIntent {
        val intent = Intent(context, AgentAlarmReceiver::class.java).apply {
            putExtra(AgentAlarmReceiver.EXTRA_AGENT_ID, agentId)
        }
        return PendingIntent.getBroadcast(context, getAgentRequestCode(context, agentId), intent, piFlags())
    }

    /** Arm the alarm at an explicit time; migrates off any legacy broadcast alarm. */
    fun schedule(context: Context, agentId: String, intervalMs: Long, triggerAtMs: Long, cron: String?) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Migration: drop any alarm previously armed via the broadcast trampoline so
        // the same request code isn't double-armed at both a receiver and the service.
        try { am.cancel(legacyBroadcastPendingIntent(context, agentId)) } catch (_: Exception) {}
        val pi = runServicePendingIntent(context, agentId, intervalMs, cron)
        setExactWhileIdle(am, triggerAtMs, pi)
        Log.i(TAG, "Scheduled agent $agentId at $triggerAtMs (interval=${intervalMs}ms, cron=${cron ?: "-"})")
    }

    /** Re-arm the next fire (called by the service after a run, or the legacy receiver). */
    fun scheduleNext(context: Context, agentId: String, intervalMs: Long, cron: String?): Boolean {
        val triggerAt = nextTriggerAt(cron)
            ?: if (intervalMs > 0) System.currentTimeMillis() + intervalMs else return false
        schedule(context, agentId, intervalMs, triggerAt, cron)
        return true
    }

    /** Cancel BOTH the new service alarm and any legacy broadcast alarm. */
    fun cancel(context: Context, agentId: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        try { am.cancel(runServicePendingIntent(context, agentId, 0L, null)) } catch (_: Exception) {}
        try { am.cancel(legacyBroadcastPendingIntent(context, agentId)) } catch (_: Exception) {}
        Log.i(TAG, "Cancelled agent $agentId (service + legacy)")
    }

    private fun setExactWhileIdle(am: AlarmManager, triggerAtMs: Long, pi: PendingIntent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms())
            ) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Exact alarm denied; falling back to inexact alarm", e)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            }
        }
    }

    /**
     * Cron -> next fire epoch ms. Supports the 4 whitelisted shapes the JS scheduler
     * (lib/agent-scheduler.ts) emits: every-N-min (*​/N * * * *), every-N-hour
     * (0 *​/N * * *), daily (m h * * *), and weekly single/CSV DOW (m h * * 1,5).
     * Returns null for anything else.
     * Mirrors the logic previously in AgentAlarmReceiver.nextTriggerAt verbatim.
     */
    fun nextTriggerAt(cron: String?): Long? {
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

        val everyHour = Regex("^\\*/(\\d+)$").matchEntire(hour)?.groupValues?.get(1)?.toIntOrNull()
        if (everyHour != null && everyHour > 0 && minute == "0" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            target.set(Calendar.MINUTE, 0)
            target.set(Calendar.SECOND, 0)
            target.set(Calendar.MILLISECOND, 0)
            val currentHour = now.get(Calendar.HOUR_OF_DAY)
            val nextHour = ((currentHour + 1 + everyHour - 1) / everyHour) * everyHour
            if (nextHour >= 24) {
                target.add(Calendar.DAY_OF_YEAR, 1)
                target.set(Calendar.HOUR_OF_DAY, nextHour % 24)
            } else {
                target.set(Calendar.HOUR_OF_DAY, nextHour)
            }
            return target.timeInMillis
        }

        val parsedMinute = minute.toIntOrNull()

        // Daily-multi (comma-separated hour list, e.g. "8,21"), single shared minute.
        // Must be checked BEFORE the single-hour toIntOrNull() guard below: hour.toIntOrNull()
        // returns null for any comma-bearing string, so that guard would swallow this case
        // and return null before we ever got to look at it.
        if (parsedMinute != null && dayOfMonth == "*" && month == "*" && dayOfWeek == "*" &&
            Regex("^\\d+(,\\d+)+$").matches(hour)
        ) {
            val parsedHours = hour.split(",").map { it.toIntOrNull() }
            if (parsedHours.any { it == null || it !in 0..23 }) return null
            val hours = parsedHours.filterNotNull().distinct().sorted()
            var best: Long? = null
            for (h in hours) {
                val candidate = now.clone() as Calendar
                candidate.set(Calendar.HOUR_OF_DAY, h)
                candidate.set(Calendar.MINUTE, parsedMinute)
                candidate.set(Calendar.SECOND, 0)
                candidate.set(Calendar.MILLISECOND, 0)
                if (candidate.timeInMillis <= now.timeInMillis) {
                    candidate.add(Calendar.DAY_OF_YEAR, 1)
                }
                if (best == null || candidate.timeInMillis < best!!) {
                    best = candidate.timeInMillis
                }
            }
            return best
        }

        val parsedHour = hour.toIntOrNull()
        if (parsedMinute == null || parsedHour == null || dayOfMonth != "*" || month != "*") return null

        target.set(Calendar.HOUR_OF_DAY, parsedHour)
        target.set(Calendar.MINUTE, parsedMinute)
        target.set(Calendar.SECOND, 0)
        target.set(Calendar.MILLISECOND, 0)

        // Single day OR a comma list (e.g. "1,5" = Mon/Fri): re-arm at the SOONEST listed day.
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
}
