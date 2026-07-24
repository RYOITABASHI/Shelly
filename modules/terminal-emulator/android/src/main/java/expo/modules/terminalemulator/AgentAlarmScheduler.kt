package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.io.File
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
    private val requestCodeLock = Any()

    // ── L1 BOOT-AUTOSTART (production-default ON, see P0-2 note below) ─────────
    // AlarmManager alarms are cleared on reboot, so scheduled agents stop firing
    // after a restart. When the boot-autostart flag is enabled, schedule()
    // persists {agentId -> intervalMs|cron} here and BootCompletedReceiver re-arms
    // them on BOOT_COMPLETED.
    private const val BOOT_PREFS = "shelly_boot_autostart"
    private const val BOOT_SCHEDULES = "shelly_boot_schedules"
    private const val BOOT_ENABLED_KEY = "enabled"
    // P0-2 (2026-07-15): flag default flipped false -> true. 2026-07-13 Batch 10
    // landed this dormant pending on-device reboot/Doze/One UI verification (see
    // DEFERRED.md) — the code path was reviewed and believed correct; what was
    // missing was device confirmation, not a known defect. schedule()/cancel()
    // already gate their persist/forget calls on bootAutostartEnabled(), so
    // registering a schedule now always persists it for boot recovery with no
    // separate step. There is still no production UI setter for this flag by
    // design (internal rollout gate, not a user-facing toggle); on-device
    // reboot/Doze/One UI confirmation remains the required follow-up.
    private const val BOOT_FIELD_SEP = "\u0001" // control char, never in a cron string

    /** Native enable flag for boot autostart. Defaults true (P0-2: reboot
     *  persistence is production-default ON; see comment above). */
    fun bootAutostartEnabled(context: Context): Boolean =
        context.getSharedPreferences(BOOT_PREFS, Context.MODE_PRIVATE)
            .getBoolean(BOOT_ENABLED_KEY, true)

    private fun persistScheduleForBoot(context: Context, agentId: String, intervalMs: Long, cron: String?) {
        context.getSharedPreferences(BOOT_SCHEDULES, Context.MODE_PRIVATE)
            .edit()
            .putString(agentId, "$intervalMs$BOOT_FIELD_SEP${cron ?: ""}")
            .apply()
    }

    private fun forgetScheduleForBoot(context: Context, agentId: String) {
        context.getSharedPreferences(BOOT_SCHEDULES, Context.MODE_PRIVATE)
            .edit().remove(agentId).apply()
    }

    /** Re-arm every persisted scheduled agent (called by BootCompletedReceiver on
     *  boot). Returns the count re-armed. No-op unless the flag is enabled. */
    fun rearmAllFromPersistedSchedules(context: Context): Int {
        if (!bootAutostartEnabled(context)) return 0
        if (isGloballyHalted(context)) {
            Log.i(TAG, "Boot re-arm suppressed: globally halted (STOP-ALL)")
            return 0
        }
        val prefs = context.getSharedPreferences(BOOT_SCHEDULES, Context.MODE_PRIVATE)
        var count = 0
        for ((agentId, raw) in prefs.all) {
            if (agentId.isNullOrBlank() || raw !is String) continue
            val parts = raw.split(BOOT_FIELD_SEP)
            val intervalMs = parts.getOrNull(0)?.toLongOrNull() ?: 0L
            val cron = parts.getOrNull(1)?.ifBlank { null }
            try {
                if (scheduleNext(context, agentId, intervalMs, cron)) count++
            } catch (e: Exception) {
                Log.e(TAG, "Boot re-arm failed for $agentId", e)
            }
        }
        Log.i(TAG, "Boot re-armed $count scheduled agent(s)")
        return count
    }

    /**
     * Mirrors lib/agent-manager.ts's halt sentinel and TerminalSessionService's
     * execution-time guard. STOP-ALL promises that no agent alarm is armed, so
     * boot restoration must stop before activating any persisted schedule.
     * Unexpected I/O failures default to not-halted, matching the existing
     * native and JS checks rather than treating uncertainty as an implicit halt.
     */
    private fun isGloballyHalted(context: Context): Boolean {
        return try {
            File(HomeInitializer.getHomeDir(context), ".shelly/agents/.halted").exists()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to check global halt sentinel; defaulting to not-halted", e)
            false
        }
    }

    private fun piFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    /** Stable per-agent request code, shared with the legacy receiver path. */
    fun getAgentRequestCode(context: Context, agentId: String): Int = synchronized(requestCodeLock) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getInt(agentId, -1)
        if (existing >= 0) return@synchronized existing
        val nextId = prefs.getInt("_next_id", 1000)
        prefs.edit().putInt(agentId, nextId).putInt("_next_id", nextId + 1).apply()
        nextId
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

    /**
     * Widget/manual operation using the exact RUN_AGENT service contract as an
     * alarm fire, but with a separate request-code allocation and a manual marker.
     * The separate allocation is security/reliability critical: PendingIntent
     * identity ignores extras, so reusing the alarm request code with
     * FLAG_UPDATE_CURRENT would replace the scheduled operation's interval/cron
     * extras and silently break its re-arm loop.
     */
    fun manualRunPendingIntent(context: Context, agentId: String): PendingIntent {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            putExtra(TerminalSessionService.EXTRA_MANUAL, true)
        }
        val rc = getAgentRequestCode(context, "widget-run:$agentId")
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
        // Dormant boot-autostart: only persist when enabled, so the live path is
        // byte-preserved with the flag OFF.
        if (bootAutostartEnabled(context)) persistScheduleForBoot(context, agentId, intervalMs, cron)
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
        if (bootAutostartEnabled(context)) forgetScheduleForBoot(context, agentId)
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
     *
     * [notBeforeMs] (Agent.startNotBefore, epoch ms) implements deferred-start
     * scheduling ("来週あたりから" / "starting next week") by simply moving the
     * computation's anchor forward — every branch below already computes "the
     * soonest matching time at or after now", so anchoring `now`/`target` to the
     * later of (actual now, notBeforeMs) makes the exact same logic return the
     * first occurrence on/after the requested start. Mirrors
     * lib/agent-scheduler.ts's nextTriggerMs(cron, notBefore).
     */
    fun nextTriggerAt(cron: String?, notBeforeMs: Long? = null): Long? {
        if (cron.isNullOrBlank()) return null
        val parts = cron.trim().split(Regex("\\s+"))
        if (parts.size != 5) return null

        val minute = parts[0]
        val hour = parts[1]
        val dayOfMonth = parts[2]
        val month = parts[3]
        val dayOfWeek = parts[4]
        val anchorMs = if (notBeforeMs != null && notBeforeMs > System.currentTimeMillis()) notBeforeMs else System.currentTimeMillis()
        val now = Calendar.getInstance().apply { timeInMillis = anchorMs }
        val target = Calendar.getInstance().apply { timeInMillis = anchorMs }

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
            // Cron "*/N" for the hour field resets at midnight each day rather
            // than counting continuously — valid hours are {0, N, 2N, ...}
            // clamped to 0-23, so for N that doesn't divide 24 evenly (e.g.
            // 23, 5, 7) simple modulo arithmetic lands on the wrong hour
            // (e.g. 46 % 24 = 22 instead of the correct 0). Enumerate today's
            // remaining valid hours and fall through to hour 0 tomorrow.
            var nextHour = -1
            var h = 0
            while (h < 24) {
                if (h > currentHour) {
                    nextHour = h
                    break
                }
                h += everyHour
            }
            if (nextHour == -1) {
                target.add(Calendar.DAY_OF_YEAR, 1)
                target.set(Calendar.HOUR_OF_DAY, 0)
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
