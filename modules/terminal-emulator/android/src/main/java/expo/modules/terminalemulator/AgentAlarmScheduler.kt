package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.terminalemulator.scouter.NotificationDispatcher
import org.json.JSONObject
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
            if (!isPersistedAgentEnabled(context, agentId)) {
                cancel(context, agentId)
                Log.i(TAG, "Boot re-arm removed stale schedule for missing/disabled agent $agentId")
                continue
            }
            val parts = raw.split(BOOT_FIELD_SEP)
            val intervalMs = parts.getOrNull(0)?.toLongOrNull() ?: 0L
            val cron = parts.getOrNull(1)?.ifBlank { null }
            // One-shot ('@once <epochMs>', lib/agent-oneshot.ts planOneShotArm):
            // future -> re-arm at its instant; past but within the grace
            // window -> a catch-up fire a few seconds out; older -> retire as
            // MISSED and never fire a stale run on boot.
            val oneShotAt = oneShotAtMs(cron)
            if (oneShotAt != null) {
                val now = System.currentTimeMillis()
                try {
                    when {
                        // Started (fire marker) or already ran / retired —
                        // e.g. a reboot mid-run. Never re-fire it.
                        oneShotAlreadyFired(context, agentId, oneShotAt) -> {
                            completeOneShot(context, agentId, ONE_SHOT_STATUS_DONE, cron)
                            Log.i(TAG, "Boot re-arm: one-shot $agentId already fired; retired, not re-armed")
                        }
                        oneShotAt > now -> {
                            schedule(context, agentId, 0L, oneShotAt, cron)
                            count++
                        }
                        now - oneShotAt <= ONE_SHOT_GRACE_MS -> {
                            schedule(context, agentId, 0L, now + ONE_SHOT_CATCHUP_DELAY_MS, cron)
                            count++
                            Log.i(TAG, "Boot re-arm: one-shot $agentId was due ${now - oneShotAt}ms ago; catch-up fire armed")
                        }
                        else -> {
                            if (completeOneShot(context, agentId, ONE_SHOT_STATUS_MISSED, cron)) {
                                notifyOneShotNotRun(context, agentId, "was due ${now - oneShotAt}ms before boot — past the grace window, so it was not run late")
                            }
                            Log.i(TAG, "Boot re-arm: one-shot $agentId missed (due ${now - oneShotAt}ms ago, past grace); not fired")
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Boot re-arm failed for one-shot $agentId", e)
                }
                continue
            }
            try {
                if (scheduleNext(context, agentId, intervalMs, cron)) count++
            } catch (e: Exception) {
                Log.e(TAG, "Boot re-arm failed for $agentId", e)
            }
        }
        Log.i(TAG, "Boot re-armed $count scheduled agent(s)")
        return count
    }

    // ── One-shot schedules (lib/agent-oneshot.ts) ────────────────────────────
    // A one-shot agent stores schedule = "@once <epochMs>" and is armed with
    // intervalMs=0 and that sentinel as its cron extra. It is never a valid
    // cron, so nextTriggerAt() returns null and scheduleNext() can never re-arm
    // it; TerminalSessionService retires it after its single fire.
    private const val ONE_SHOT_PREFIX = "@once "
    /** Mirrors lib/agent-oneshot.ts ONE_SHOT_GRACE_MS. */
    const val ONE_SHOT_GRACE_MS = 10 * 60 * 1000L
    /** Mirrors lib/agent-oneshot.ts ONE_SHOT_CATCHUP_DELAY_MS. */
    const val ONE_SHOT_CATCHUP_DELAY_MS = 5 * 1000L
    const val ONE_SHOT_STATUS_DONE = "done"
    const val ONE_SHOT_STATUS_MISSED = "missed"

    /** The fire instant of a one-shot sentinel, or null for anything else. */
    fun oneShotAtMs(cron: String?): Long? {
        val trimmed = cron?.trim() ?: return null
        if (!trimmed.startsWith(ONE_SHOT_PREFIX)) return null
        return trimmed.removePrefix(ONE_SHOT_PREFIX).trim().toLongOrNull()
    }

    fun isOneShotCron(cron: String?): Boolean = oneShotAtMs(cron) != null

    /** Mirrors lib/agent-oneshot.ts FIRED_EARLY_TOLERANCE_MS. */
    private const val ONE_SHOT_FIRED_EARLY_TOLERANCE_MS = 60 * 1000L
    /** AgentRuntime refusal exit codes (disabled / backoff / halted /
     *  previous run active): the run never started. */
    private val ONE_SHOT_NOT_RUN_EXIT_CODES = setOf(129, 130)

    private fun agentJsonFile(context: Context, agentId: String): File =
        File(HomeInitializer.getHomeDir(context), ".shelly/agents/$agentId.json")

    private fun readAgentJson(context: Context, agentId: String): JSONObject? = try {
        val file = agentJsonFile(context, agentId)
        if (!file.isFile) null
        else JSONObject(file.readText()).takeIf { it.optString("id") == agentId }
    } catch (e: Exception) {
        Log.w(TAG, "Failed to read agent metadata for one-shot $agentId", e)
        null
    }

    /** Newest run-log timestamp for this agent (logs are never rewritten by JS,
     *  so a stale RN metadata write can never erase this evidence). */
    private fun latestRunLogAt(context: Context, agentId: String): Long? = try {
        File(HomeInitializer.getHomeDir(context), ".shelly/agents/logs/$agentId")
            .listFiles { file -> file.isFile && file.extension == "json" }
            ?.mapNotNull { file ->
                runCatching {
                    val json = JSONObject(file.readText())
                    if (json.optString("agentId") != agentId || !json.has("timestamp")) null
                    else json.optLong("timestamp")
                }.getOrNull()
            }
            ?.maxOrNull()
    } catch (e: Exception) {
        null
    }

    /**
     * Disk evidence that the one-shot due at [atMs] already fired: a terminal
     * oneShotStatus for that same schedule, a start marker (oneShotFiredAt,
     * written BEFORE the run), or any run log at/after its instant (minus the
     * early tolerance). Used by the fire path and boot re-arm so neither a
     * stale RN write (enabled:true from an old snapshot) nor a reboot/kill
     * mid-run can produce a second run.
     */
    fun oneShotAlreadyFired(context: Context, agentId: String, atMs: Long): Boolean {
        val min = atMs - ONE_SHOT_FIRED_EARLY_TOLERANCE_MS
        val json = readAgentJson(context, agentId)
        if (json != null && oneShotAtMs(json.optString("schedule")) == atMs) {
            val status = json.optString("oneShotStatus")
            if (status == ONE_SHOT_STATUS_DONE || status == ONE_SHOT_STATUS_MISSED) return true
            if (!json.isNull("oneShotFiredAt") && json.optLong("oneShotFiredAt", 0L) >= min) return true
        }
        val lastLog = latestRunLogAt(context, agentId)
        return lastLog != null && lastLog >= min
    }

    /** Fire-path decision for an alarm carrying a one-shot cron extra. */
    enum class OneShotFireGate { RUN, SKIP }

    /**
     * Gate an alarm-delivered one-shot fire BEFORE the run starts:
     *  - already fired (see oneShotAlreadyFired) → re-assert "done", skip;
     *  - the agent's schedule on disk is no longer this one-shot (stale alarm)
     *    → skip without touching anything;
     *  - delivered later than the grace window (device clock jump / long
     *    Doze) → retire as "missed" + one notification, skip;
     *  - otherwise persist the start marker + drop the boot entry FIRST, so a
     *    kill/reboot mid-run can never re-fire it, then RUN.
     */
    fun gateOneShotFire(context: Context, agentId: String, cron: String?): OneShotFireGate {
        val atMs = oneShotAtMs(cron) ?: return OneShotFireGate.RUN
        if (oneShotAlreadyFired(context, agentId, atMs)) {
            completeOneShot(context, agentId, ONE_SHOT_STATUS_DONE, cron)
            Log.i(TAG, "One-shot $agentId fire suppressed: already fired")
            return OneShotFireGate.SKIP
        }
        val file = agentJsonFile(context, agentId)
        val json = readAgentJson(context, agentId)
        if (json == null || oneShotAtMs(json.optString("schedule")) != atMs) {
            Log.i(TAG, "One-shot $agentId fire suppressed: schedule on disk is no longer @once $atMs")
            return OneShotFireGate.SKIP
        }
        val now = System.currentTimeMillis()
        if (now - atMs > ONE_SHOT_GRACE_MS) {
            if (completeOneShot(context, agentId, ONE_SHOT_STATUS_MISSED, cron)) {
                notifyOneShotNotRun(context, agentId, "the alarm was delivered ${(now - atMs) / 60000} min late — past the grace window, so it was not run late")
            }
            return OneShotFireGate.SKIP
        }
        try {
            json.put("oneShotFiredAt", now)
            file.writeText(json.toString(2))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to persist one-shot start marker for $agentId", e)
        }
        forgetScheduleForBoot(context, agentId)
        return OneShotFireGate.RUN
    }

    /** "done" when the run actually started (any outcome), "missed" when it was
     *  refused before starting (exit 129/130) or crashed before returning. */
    fun oneShotOutcomeStatus(result: AgentRunResult?): String =
        if (result == null || result.exitCode in ONE_SHOT_NOT_RUN_EXIT_CODES) ONE_SHOT_STATUS_MISSED
        else ONE_SHOT_STATUS_DONE

    fun notifyOneShotNotRun(context: Context, agentId: String, reason: String) {
        try {
            val name = readAgentJson(context, agentId)?.optString("name")?.takeIf { it.isNotBlank() }
            NotificationDispatcher(context).notifyAgentResult(
                agentId = agentId,
                status = "skipped",
                preview = "One-time run did not run: $reason. Re-schedule it to try again.",
                agentName = name,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to post one-shot not-run notification for $agentId", e)
        }
    }

    /**
     * Retire a one-shot agent: cancel its alarm + boot entry, then persist
     * enabled=false and the terminal oneShotStatus ("done" after its fire,
     * "missed" when it could not run). The agent JSON and its run logs stay —
     * the user deletes or re-schedules it. Only touches the agent while its
     * disk schedule is still the one-shot [cron] that fired (a re-schedule
     * during the run must not be cancelled), and the FIRST terminal status
     * wins (a later stale caller can't flip missed↔done). Returns true when
     * this call wrote a new terminal status.
     */
    fun completeOneShot(context: Context, agentId: String, status: String, cron: String?): Boolean {
        val expectedAt = oneShotAtMs(cron)
        val file = agentJsonFile(context, agentId)
        val json = readAgentJson(context, agentId)
        if (json != null && expectedAt != null && oneShotAtMs(json.optString("schedule")) != expectedAt) {
            Log.i(TAG, "One-shot $agentId was re-scheduled; completion of @once $expectedAt ignored")
            return false
        }
        try {
            cancel(context, agentId)
        } catch (e: Exception) {
            Log.e(TAG, "One-shot completion failed to cancel alarm for $agentId", e)
        }
        if (json == null) return false
        return try {
            val existing = json.optString("oneShotStatus")
            val alreadyTerminal = existing == ONE_SHOT_STATUS_DONE || existing == ONE_SHOT_STATUS_MISSED
            json.put("enabled", false)
            if (!alreadyTerminal) {
                json.put("oneShotStatus", status)
                json.put("oneShotResolvedAt", System.currentTimeMillis())
            }
            file.writeText(json.toString(2))
            Log.i(TAG, "One-shot $agentId retired (${if (alreadyTerminal) existing else status})")
            !alreadyTerminal
        } catch (e: Exception) {
            Log.e(TAG, "One-shot completion failed to persist state for $agentId", e)
            false
        }
    }

    /**
     * Re-arm after an alarm-fired run only while the persisted agent still exists
     * and is enabled. A delete/pause may race an in-flight run; treating that
     * terminal state as an ordinary run failure recreates the boot schedule that
     * delete/pause just removed and produces a permanent zombie loop.
     */
    fun scheduleNextIfAgentEnabled(
        context: Context,
        agentId: String,
        intervalMs: Long,
        cron: String?
    ): Boolean {
        if (!isPersistedAgentEnabled(context, agentId)) {
            cancel(context, agentId)
            Log.i(TAG, "Post-run re-arm removed stale schedule for missing/disabled agent $agentId")
            return false
        }
        return scheduleNext(context, agentId, intervalMs, cron)
    }

    private fun isPersistedAgentEnabled(context: Context, agentId: String): Boolean {
        val agentFile = File(HomeInitializer.getHomeDir(context), ".shelly/agents/$agentId.json")
        return try {
            if (!agentFile.isFile) return false
            val json = JSONObject(agentFile.readText())
            json.optString("id") == agentId && json.optBoolean("enabled", false)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to verify scheduled agent $agentId; suppressing re-arm", e)
            false
        }
    }

    /**
     * Mirrors lib/agent-manager.ts's halt sentinel and TerminalSessionService's
     * execution-time guard. STOP-ALL promises that no agent alarm is armed, so
     * boot restoration must stop before activating any persisted schedule.
     * Unexpected I/O failures fail closed: uncertainty must never re-enable a
     * kill switch or restore alarms that STOP-ALL was intended to suppress.
     */
    private fun isGloballyHalted(context: Context): Boolean {
        return try {
            File(HomeInitializer.getHomeDir(context), ".shelly/agents/.halted").exists()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to check global halt sentinel; defaulting to halted (fail closed)", e)
            true
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
        // Cancellation is authoritative even if boot autostart is currently off:
        // retaining an old entry would resurrect the agent if the flag is later
        // enabled, and makes delete/pause cleanup dependent on unrelated state.
        forgetScheduleForBoot(context, agentId)
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
