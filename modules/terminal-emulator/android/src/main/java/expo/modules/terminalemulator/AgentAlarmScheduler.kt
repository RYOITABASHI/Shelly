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
            when (persistedAgentEnabledState(context, agentId)) {
                AgentScheduleReconcileCore.Enabled.DISABLED -> {
                    cancel(context, agentId)
                    Log.i(TAG, "Boot re-arm removed stale schedule for missing/disabled agent $agentId")
                    continue
                }
                AgentScheduleReconcileCore.Enabled.UNKNOWN -> {
                    // Transient read/parse failure: keep the boot entry so the
                    // reconcile watchdog (armed below) re-arms it once the
                    // file reads again. Never cancel on uncertainty.
                    Log.w(TAG, "Boot re-arm deferred for $agentId: agent file unreadable; schedule kept")
                    continue
                }
                AgentScheduleReconcileCore.Enabled.ENABLED -> Unit
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
        // Alarms (the watchdog included) are cleared by a reboot.
        runCatching { ensureReconcileWatchdog(context, force = true) }
            .onFailure { Log.e(TAG, "Boot: failed to arm the reconcile watchdog", it) }
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
        when (persistedAgentEnabledState(context, agentId)) {
            AgentScheduleReconcileCore.Enabled.DISABLED -> {
                cancel(context, agentId)
                Log.i(TAG, "Re-arm removed stale schedule for missing/disabled agent $agentId")
                return false
            }
            AgentScheduleReconcileCore.Enabled.UNKNOWN -> {
                // A transient I/O / parse failure used to CANCEL the schedule
                // and its boot entry here, ending the chain for good. Keep
                // both; the reconcile watchdog re-arms once the file reads.
                Log.w(TAG, "Re-arm deferred for $agentId: agent file unreadable; schedule and boot entry kept")
                audit(context, agentId, "rearm_deferred_unreadable", null)
                runCatching { ensureReconcileWatchdog(context) }
                return false
            }
            AgentScheduleReconcileCore.Enabled.ENABLED -> Unit
        }
        val notBefore = readAgentJsonQuiet(context, agentId)?.let { optLongOrNull(it, "startNotBefore") }
        return scheduleNext(context, agentId, intervalMs, cron, notBefore)
    }

    /**
     * ENABLED / DISABLED (file missing, id mismatch, enabled != true) /
     * UNKNOWN (the file exists but could not be read or parsed — transient;
     * callers keep whatever is armed instead of cancelling).
     */
    fun persistedAgentEnabledState(context: Context, agentId: String): AgentScheduleReconcileCore.Enabled {
        val agentFile = agentJsonFile(context, agentId)
        return try {
            if (!agentFile.isFile) return AgentScheduleReconcileCore.Enabled.DISABLED
            val json = JSONObject(agentFile.readText())
            if (json.optString("id") == agentId && json.optBoolean("enabled", false)) {
                AgentScheduleReconcileCore.Enabled.ENABLED
            } else {
                AgentScheduleReconcileCore.Enabled.DISABLED
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read scheduled agent $agentId; treating as unknown (schedule kept)", e)
            AgentScheduleReconcileCore.Enabled.UNKNOWN
        }
    }

    private fun readAgentJsonQuiet(context: Context, agentId: String): JSONObject? = try {
        val file = agentJsonFile(context, agentId)
        if (!file.isFile) null else JSONObject(file.readText()).takeIf { it.optString("id") == agentId }
    } catch (_: Exception) {
        null
    }

    private fun optLongOrNull(json: JSONObject, key: String): Long? =
        if (!json.has(key) || json.isNull(key)) null
        else (json.opt(key) as? Number)?.toLong()?.takeIf { it > 0 }

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
        cron: String?,
        scheduledAtMs: Long = 0L
    ): PendingIntent {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            putExtra(TerminalSessionService.EXTRA_INTERVAL_MS, intervalMs)
            if (!cron.isNullOrBlank()) putExtra(TerminalSessionService.EXTRA_CRON, cron)
            // The occurrence this alarm is armed for: the fire's identity for
            // claimOccurrence (delivery time is not — a deferred delivery can
            // cross the next cron boundary). FLAG_UPDATE_CURRENT replaces it on
            // every re-arm, and there is one pending alarm per PendingIntent,
            // so the delivered value is always the armed time.
            if (scheduledAtMs > 0) putExtra(TerminalSessionService.EXTRA_SCHEDULED_AT, scheduledAtMs)
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
        val pi = runServicePendingIntent(context, agentId, intervalMs, cron, triggerAtMs)
        val exact = setExactWhileIdle(context, am, triggerAtMs, pi, agentId)
        Log.i(TAG, "Scheduled agent $agentId at $triggerAtMs (interval=${intervalMs}ms, cron=${cron ?: "-"}, exact=$exact)")
        // Dormant boot-autostart: only persist when enabled, so the live path is
        // byte-preserved with the flag OFF.
        if (bootAutostartEnabled(context)) persistScheduleForBoot(context, agentId, intervalMs, cron)
        // A recurring cron schedule exists: make sure the reconcile watchdog
        // is armed (only moves it if none is armed; never pushes it later).
        if (isReconcilableCron(cron)) {
            runCatching { ensureReconcileWatchdog(context) }
                .onFailure { Log.e(TAG, "Failed to arm the reconcile watchdog", it) }
        }
    }

    /** Re-arm the next fire (called by the service before/after a run, boot,
     *  reconcile, or the legacy receiver). [notBeforeMs] = Agent.startNotBefore. */
    fun scheduleNext(context: Context, agentId: String, intervalMs: Long, cron: String?, notBeforeMs: Long? = null): Boolean {
        val triggerAt = nextTriggerAt(cron, notBeforeMs)
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
        // Continuous mode: a loop with no armed alarm is not running — drop its
        // ongoing "iteration N · next hh:mm" notification (pause / delete /
        // STOP-ALL / circuit breaker all funnel through here).
        ContinuousLoop.cancelRunningNotification(context, agentId)
        Log.i(TAG, "Cancelled agent $agentId (service + legacy)")
        // No recurring schedule left: the watchdog has nothing to watch.
        runCatching { if (!hasReconcilableSchedules(context)) cancelReconcileWatchdog(context) }
    }

    /**
     * Arms [pi] exact-while-idle when permitted. Returns false when it had to
     * fall back to an inexact alarm. That fallback used to be silent; an
     * inexact alarm gets no foreground-service-start exemption in Doze, so the
     * run it carries may never start (doze-scheduler-diagnosis §3.1). Every
     * fallback now writes a distinct, greppable line: logcat
     * `EXACT_ALARM_FALLBACK agent=<id> reason=<no-access|security-exception>`
     * and an `exact_alarm_fallback` row in logs/schedule-reconcile.jsonl.
     * [agentId] is the agent id, or "reconcile-watchdog".
     */
    private fun setExactWhileIdle(context: Context, am: AlarmManager, triggerAtMs: Long, pi: PendingIntent, agentId: String): Boolean {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms())
            ) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
                return true
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            }
            logExactFallback(context, agentId, "no-access", null)
        } catch (e: SecurityException) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            }
            logExactFallback(context, agentId, "security-exception", e)
        }
        return false
    }

    private fun logExactFallback(context: Context, agentId: String, reason: String, e: Exception?) {
        Log.w(TAG, "EXACT_ALARM_FALLBACK agent=$agentId reason=$reason: armed an INEXACT alarm; in Doze its service start may be refused", e)
        audit(context, agentId, "exact_alarm_fallback", JSONObject().put("reason", reason))
    }

    // ── Reconcile (catch-up) ─────────────────────────────────────────────────
    // doze-scheduler-diagnosis §6 Option 2. A recurring occurrence whose alarm
    // was lost used to be dropped; reconcile() runs it late inside a bounded
    // window (AgentScheduleReconcileCore) through the same ACTION_RUN_AGENT
    // service path, or records it as missed and re-arms. Entry points all go
    // through TerminalSessionService ACTION_SCHEDULE_RECONCILE: boot,
    // MY_PACKAGE_REPLACED, exact-alarm access granted, the hourly watchdog
    // below, and the JS startup repair (bridge reconcileAgentSchedules()).

    const val RECONCILE_REASON_BOOT = "boot"
    const val RECONCILE_REASON_PACKAGE_REPLACED = "package-replaced"
    const val RECONCILE_REASON_EXACT_GRANTED = "exact-alarm-granted"
    const val RECONCILE_REASON_WATCHDOG = "watchdog"
    const val RECONCILE_REASON_APP = "app"

    private const val RECONCILE_PREFS = "shelly_schedule_reconcile"
    private const val WATCHDOG_AT_KEY = "_watchdog_at"
    private const val CLAIMED_PREFIX = "claimed:"
    /** Wall time the current claim was taken (claim lifecycle, see
     *  AgentScheduleReconcileCore.occurrenceClaimState). */
    private const val CLAIMED_AT_PREFIX = "claimedAt:"
    /** The occurrence whose run actually started (markOccurrenceStarted). */
    private const val STARTED_PREFIX = "started:"
    /** The occurrence whose dispatch AgentRuntime refused before launch
     *  (markOccurrenceSettled): never re-dispatched. */
    private const val SETTLED_PREFIX = "settled:"
    /** The occurrence whose dispatch was refused because a previous run was
     *  still active (markOccurrenceDeferred): recoverable as soon as no run
     *  is live. Cleared by the next reservation of it. */
    private const val DEFERRED_PREFIX = "deferred:"
    /** Pending recovery tick of a reservation that has not started yet
     *  (armReservationRecovery); cleared when its run starts. */
    private const val RECOVERY_PREFIX = "recoveryAt:"
    /** The tick the last reconcile pass asked for (its WAIT_GRACE / WAIT_CLAIM
     *  follow-ups or the hourly period), so relaxing a recovery tick never
     *  pushes the watchdog past a pass's own follow-up. */
    private const val RECONCILE_TICK_KEY = "_reconcile_tick_at"
    /** Stable request code of the watchdog PendingIntent. Its Intent action
     *  (ACTION_SCHEDULE_RECONCILE) already differs from every agent alarm's. */
    private const val WATCHDOG_REQUEST_CODE = 7737
    private const val AUDIT_FILE = ".shelly/agents/logs/schedule-reconcile.jsonl"
    private const val AUDIT_MAX_BYTES = 128 * 1024L

    /** A recurring cron that reconcile can reason about (not one-shot, not a
     *  continuous loop's interval-only alarm, and a shape lastTriggerAt knows). */
    fun isReconcilableCron(cron: String?): Boolean =
        !cron.isNullOrBlank() && !isOneShotCron(cron) && lastTriggerAt(cron, System.currentTimeMillis()) != null

    private fun persistedSchedules(context: Context): List<Triple<String, Long, String?>> =
        context.getSharedPreferences(BOOT_SCHEDULES, Context.MODE_PRIVATE).all.mapNotNull { (agentId, raw) ->
            if (agentId.isNullOrBlank() || raw !is String) return@mapNotNull null
            val parts = raw.split(BOOT_FIELD_SEP)
            Triple(agentId, parts.getOrNull(0)?.toLongOrNull() ?: 0L, parts.getOrNull(1)?.ifBlank { null })
        }

    fun hasReconcilableSchedules(context: Context): Boolean =
        persistedSchedules(context).any { isReconcilableCron(it.third) }

    /** Live run of this agent: the same per-agent locks the executor / .sh
     *  (locks/<id>.pid, pid alive) and the attended chain (locks/<id>.chain.lock)
     *  hold — AgentRuntime's "previous run still active" and the Sidebar's
     *  RUNNING list read the same files. A chain lock counts only while it is
     *  not stale under acquireChainLock's own policy
     *  (AgentScheduleReconcileCore.isChainLockLive on its `acquired-at`; a
     *  missing / garbage `acquired-at` is stale, as on the acquire side), so a
     *  lock left by a killed run cannot suppress recovery forever. A run this
     *  process is executing (NativeAgentRunRegistry, from the top of
     *  AgentRuntime.runAgent — i.e. also while it is still extracting the
     *  runtime, before any lock file exists) is live too. Errors count as
     *  running (no late run). */
    fun isAgentRunLive(context: Context, agentId: String): Boolean = try {
        if (NativeAgentRunRegistry.activeRunStartedAt(agentId) != null) {
            true
        } else {
            val locks = File(HomeInitializer.getHomeDir(context), ".shelly/agents/locks")
            val chain = File(locks, "$agentId.chain.lock")
            val chainLive = chain.isDirectory && run {
                val acquiredAt = AgentScheduleReconcileCore.parseChainLockAcquiredAt(
                    File(chain, "acquired-at").takeIf { it.isFile }?.readText()
                )
                AgentScheduleReconcileCore.isChainLockLive(acquiredAt, System.currentTimeMillis()).also { live ->
                    if (!live) Log.w(TAG, "Stale chain lock for $agentId (acquired-at=$acquiredAt) ignored")
                }
            }
            if (chainLive) {
                true
            } else {
                val pidFile = File(locks, "$agentId.pid")
                val pid = if (pidFile.isFile) pidFile.readText().trim().toIntOrNull() else null
                pid != null && pid > 0 && File("/proc/$pid").exists()
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "Run-lock check failed for $agentId; treating as running", e)
        true
    }

    /** Result of one reconcile pass: the late runs the service must dispatch
     *  through its own ACTION_RUN_AGENT handler. */
    data class ReconcileResult(val lateRuns: List<Intent>, val decisions: Map<String, String>)

    /**
     * One pass over every persisted schedule (shelly_boot_schedules).
     * Never runs anything itself: late runs come back as ACTION_RUN_AGENT
     * intents (origin "schedule", EXTRA_LATE, EXTRA_EXPECTED_AT) so every
     * service gate still applies. An occurrence runs at most once: a late
     * run RESERVES it (claimOccurrence) and the run marks it STARTED
     * (markOccurrenceStarted); only a reservation that never started is
     * re-dispatched, after CLAIM_ABANDON_MS and only inside its window.
     */
    fun reconcile(context: Context, reason: String): ReconcileResult {
        val now = System.currentTimeMillis()
        val decisions = LinkedHashMap<String, String>()
        if (isGloballyHalted(context)) {
            // STOP-ALL promises no armed agent alarm; the watchdog goes too
            // (RESUME re-installs schedules, which re-arms it).
            Log.i(TAG, "Reconcile ($reason) suppressed: globally halted (STOP-ALL)")
            runCatching { cancelReconcileWatchdog(context) }
            return ReconcileResult(emptyList(), decisions)
        }
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        val lateRuns = ArrayList<Intent>()
        var followUpAt: Long? = null
        // Agents this pass actually decided (not SKIP_UNKNOWN, no exception):
        // only their due recovery deadlines count as serviced.
        val decided = HashSet<String>()
        val scheduledIds = HashSet<String>()
        for ((agentId, intervalMs, cron) in persistedSchedules(context)) {
            scheduledIds += agentId
            try {
                val oneShotAt = oneShotAtMs(cron)
                if (oneShotAt != null) {
                    // One-shots keep their own grace/retire rules. Only an
                    // access grant re-arms a future one (now exact).
                    if (reason == RECONCILE_REASON_EXACT_GRANTED && oneShotAt > now &&
                        persistedAgentEnabledState(context, agentId) == AgentScheduleReconcileCore.Enabled.ENABLED &&
                        !oneShotAlreadyFired(context, agentId, oneShotAt)
                    ) {
                        schedule(context, agentId, 0L, oneShotAt, cron)
                    }
                    continue
                }
                // Continuous loops (interval, no cron) keep end-of-run + cooldown.
                if (cron.isNullOrBlank()) continue
                val enabled = persistedAgentEnabledState(context, agentId)
                val json = if (enabled == AgentScheduleReconcileCore.Enabled.ENABLED) readAgentJsonQuiet(context, agentId) else null
                val running = enabled == AgentScheduleReconcileCore.Enabled.ENABLED && isAgentRunLive(context, agentId)
                val logAt = latestRunLogAt(context, agentId)
                val jsonLastRun = json?.let { optLongOrNull(it, "lastRun") }
                val lastRunAt = listOfNotNull(logAt, jsonLastRun).maxOrNull()
                val notBefore = json?.let { optLongOrNull(it, "startNotBefore") }
                val claimedFor = prefs.getLong(CLAIMED_PREFIX + agentId, -1L).takeIf { it > 0 }
                val claimedAt = prefs.getLong(CLAIMED_AT_PREFIX + agentId, -1L).takeIf { it > 0 }
                val startedFor = prefs.getLong(STARTED_PREFIX + agentId, -1L).takeIf { it > 0 }
                val settledFor = prefs.getLong(SETTLED_PREFIX + agentId, -1L).takeIf { it > 0 }
                val deferredFor = prefs.getLong(DEFERRED_PREFIX + agentId, -1L).takeIf { it > 0 }
                val occurrence = lastTriggerAt(cron, now)
                val decision = AgentScheduleReconcileCore.decide(
                    AgentScheduleReconcileCore.Inputs(
                        nowMs = now,
                        halted = false,
                        enabled = enabled,
                        running = running,
                        occurrenceMs = occurrence,
                        previousOccurrenceMs = occurrence?.let { lastTriggerAt(cron, it - 1) },
                        lastRunAt = lastRunAt,
                        createdAt = json?.let { optLongOrNull(it, "createdAt") },
                        startNotBefore = notBefore,
                        intervalMs = intervalMs,
                        claimedForMs = claimedFor,
                        claimedAtMs = claimedAt,
                        startedForMs = startedFor,
                        settledForMs = settledFor,
                        deferredForMs = deferredFor,
                    )
                )
                decisions[agentId] = decision.action.code
                when (decision.action) {
                    AgentScheduleReconcileCore.Action.SKIP_HALTED -> Unit
                    AgentScheduleReconcileCore.Action.SKIP_DISABLED -> {
                        cancel(context, agentId)
                        Log.i(TAG, "Reconcile ($reason) removed stale schedule for missing/disabled agent $agentId")
                    }
                    AgentScheduleReconcileCore.Action.SKIP_UNKNOWN ->
                        Log.w(TAG, "Reconcile ($reason) skipped $agentId: agent file unreadable; schedule kept")
                    AgentScheduleReconcileCore.Action.SKIP_RUNNING -> {
                        Log.i(TAG, "Reconcile ($reason) skipped $agentId: a run is live")
                        // A reservation whose run is still preparing (live in
                        // this process, not yet STARTED), or an occurrence
                        // DEFERRED behind this live run: keep a recovery tick
                        // pending (the process may die before it starts; the
                        // deferred one runs late once this run ends), only
                        // while the occurrence is still inside its window.
                        if (occurrence != null && claimedFor == occurrence && startedFor != occurrence && settledFor != occurrence && claimedAt != null &&
                            now - occurrence <= decision.windowMs
                        ) {
                            val recoveryAt = armReservationRecovery(context, agentId, now)
                            followUpAt = minOf(followUpAt ?: recoveryAt, recoveryAt)
                        }
                    }
                    AgentScheduleReconcileCore.Action.WAIT_GRACE -> {
                        // Leave a possibly deferred, still pending alarm alone;
                        // look again right after the grace ends.
                        val at = decision.expectedAt!! + AgentScheduleReconcileCore.RECONCILE_GRACE_MS +
                            AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS
                        followUpAt = minOf(followUpAt ?: at, at)
                        Log.i(TAG, "Reconcile ($reason) $agentId: occurrence ${decision.expectedAt} inside grace; follow-up at $at")
                    }
                    AgentScheduleReconcileCore.Action.WAIT_CLAIM -> {
                        // A reservation for this occurrence is in flight (or
                        // its dispatcher just died): keep the chain armed and
                        // look again once it would count as abandoned.
                        scheduleNext(context, agentId, intervalMs, cron, notBefore)
                        val at = (claimedAt ?: now) + AgentScheduleReconcileCore.CLAIM_ABANDON_MS +
                            AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS
                        followUpAt = minOf(followUpAt ?: at, at)
                        Log.i(TAG, "Reconcile ($reason) $agentId: occurrence ${decision.expectedAt} reserved, not started; follow-up at $at")
                    }
                    AgentScheduleReconcileCore.Action.LATE_RUN -> {
                        val expectedAt = decision.expectedAt!!
                        val redispatch = AgentScheduleReconcileCore.occurrenceClaimState(expectedAt, claimedFor, claimedAt, startedFor, settledFor, deferredFor, now) in
                            setOf(AgentScheduleReconcileCore.ClaimState.ABANDONED, AgentScheduleReconcileCore.ClaimState.DEFERRED)
                        // RESERVE the occurrence first (atomic with the regular
                        // fire path's claim), so neither a second pass nor an
                        // already-queued regular alarm runs it while this
                        // dispatch is in flight. The run itself marks it
                        // STARTED (TerminalSessionService); a reservation that
                        // never starts (crash, failed dispatch) is recoverable
                        // after CLAIM_ABANDON_MS (WAIT_CLAIM / re-dispatch here).
                        if (claimOccurrence(context, agentId, expectedAt) != Claim.CLAIMED) {
                            decisions[agentId] = "claimed"
                            scheduleNext(context, agentId, intervalMs, cron, notBefore)
                            continue
                        }
                        // Recovery tick for this reservation, armed NOW (not
                        // only at the end of the pass): if the process dies
                        // before the run starts, a reconcile pass comes back
                        // just after the reservation counts as abandoned and
                        // re-dispatches it while it is still inside its window.
                        val recoveryAt = armReservationRecovery(context, agentId, now)
                        followUpAt = minOf(followUpAt ?: recoveryAt, recoveryAt)
                        lateRuns += Intent(context, TerminalSessionService::class.java).apply {
                            action = TerminalSessionService.ACTION_RUN_AGENT
                            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
                            putExtra(TerminalSessionService.EXTRA_INTERVAL_MS, intervalMs)
                            putExtra(TerminalSessionService.EXTRA_CRON, cron)
                            putExtra(TerminalSessionService.EXTRA_LATE, true)
                            putExtra(TerminalSessionService.EXTRA_EXPECTED_AT, expectedAt)
                        }
                        Log.w(TAG, "SCHEDULE_LATE_RUN agent=$agentId expectedAt=$expectedAt lateBy=${now - expectedAt}ms reason=$reason redispatch=$redispatch")
                        audit(context, agentId, "late_run", JSONObject()
                            .put("expectedAt", expectedAt).put("lateByMs", now - expectedAt).put("trigger", reason)
                            .put("redispatch", redispatch))
                        // Re-arm AFTER the late run is queued: a failure here
                        // must not strand the reservation without its dispatch
                        // (the run's own arm-before-run re-arms again anyway).
                        runCatching { scheduleNext(context, agentId, intervalMs, cron, notBefore) }
                            .onFailure { Log.e(TAG, "Reconcile ($reason) re-arm after late run failed for $agentId", it) }
                    }
                    AgentScheduleReconcileCore.Action.MISSED -> {
                        val expectedAt = decision.expectedAt!!
                        Log.w(TAG, "SCHEDULE_MISSED agent=$agentId expectedAt=$expectedAt lateBy=${now - expectedAt}ms window=${decision.windowMs}ms reason=$reason; not run late, next occurrence re-armed")
                        audit(context, agentId, "missed", JSONObject()
                            .put("expectedAt", expectedAt).put("lateByMs", now - expectedAt)
                            .put("windowMs", decision.windowMs).put("trigger", reason))
                        scheduleNext(context, agentId, intervalMs, cron, notBefore)
                    }
                    AgentScheduleReconcileCore.Action.REARM ->
                        scheduleNext(context, agentId, intervalMs, cron, notBefore)
                }
                // Reached only when the decision's action completed.
                if (decision.action != AgentScheduleReconcileCore.Action.SKIP_UNKNOWN) decided += agentId
            } catch (e: Exception) {
                Log.e(TAG, "Reconcile ($reason) failed for $agentId", e)
            }
        }
        if (hasReconcilableSchedules(context)) {
            val next = now + AgentScheduleReconcileCore.RECONCILE_WATCHDOG_PERIOD_MS
            val recoveryTick = runCatching { pendingRecoveryTick(context, now, decided, scheduledIds) }
                .onFailure { Log.e(TAG, "Reconcile ($reason) could not read pending recovery ticks", it) }
                .getOrNull()
            val tick = listOfNotNull(next, followUpAt, recoveryTick).minOrNull() ?: next
            prefs.edit().putLong(RECONCILE_TICK_KEY, tick).apply()
            armReconcileWatchdog(context, tick)
        } else {
            cancelReconcileWatchdog(context)
        }
        Log.i(TAG, "Reconcile ($reason) done: ${decisions.entries.joinToString(",") { "${it.key}=${it.value}" }}")
        return ReconcileResult(lateRuns, decisions)
    }

    /**
     * One run per occurrence, shared by the regular alarm fire
     * (TerminalSessionService ACTION_RUN_AGENT, identity = EXTRA_SCHEDULED_AT)
     * and reconcile's late run (identity = the occurrence): an atomic
     * check-and-RESERVE of this agent's occurrence. Lifecycle (TS
     * occurrenceClaimState): reserved here → started by
     * [markOccurrenceStarted] right before the run; a reservation that never
     * starts is abandoned after CLAIM_ABANDON_MS and may be taken again.
     *  - CLAIMED: newly reserved and committed to disk (survives process death);
     *  - ALREADY_CLAIMED: this occurrence has started or settled, or another
     *    path holds a fresh reservation for it;
     *  - NOT_DURABLE: commit() failed. SharedPreferences updates its in-memory
     *    map before persisting, so the previous values are restored: a failed
     *    claim must not look ALREADY_CLAIMED to the other path. A regular fire
     *    still runs; a late run is not sent.
     */
    enum class Claim { CLAIMED, ALREADY_CLAIMED, NOT_DURABLE }

    @Synchronized
    fun claimOccurrence(context: Context, agentId: String, occurrenceMs: Long, nowMs: Long = System.currentTimeMillis()): Claim {
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        val key = CLAIMED_PREFIX + agentId
        val atKey = CLAIMED_AT_PREFIX + agentId
        val previous = if (prefs.contains(key)) prefs.getLong(key, -1L) else null
        val previousAt = if (prefs.contains(atKey)) prefs.getLong(atKey, -1L) else null
        val startedFor = prefs.getLong(STARTED_PREFIX + agentId, -1L).takeIf { it > 0 }
        val settledFor = prefs.getLong(SETTLED_PREFIX + agentId, -1L).takeIf { it > 0 }
        val deferredKey = DEFERRED_PREFIX + agentId
        val previousDeferred = if (prefs.contains(deferredKey)) prefs.getLong(deferredKey, -1L) else null
        when (AgentScheduleReconcileCore.occurrenceClaimState(occurrenceMs, previous, previousAt?.takeIf { it > 0 }, startedFor, settledFor, previousDeferred?.takeIf { it > 0 }, nowMs)) {
            AgentScheduleReconcileCore.ClaimState.STARTED,
            AgentScheduleReconcileCore.ClaimState.SETTLED,
            AgentScheduleReconcileCore.ClaimState.RESERVED -> return Claim.ALREADY_CLAIMED
            // An old reservation (or a deferred occurrence) whose run is still
            // preparing in THIS process (e.g. a long runtime extraction after
            // an update) is not taken over.
            AgentScheduleReconcileCore.ClaimState.ABANDONED,
            AgentScheduleReconcileCore.ClaimState.DEFERRED ->
                if (NativeAgentRunRegistry.activeRunStartedAt(agentId) != null) return Claim.ALREADY_CLAIMED
            AgentScheduleReconcileCore.ClaimState.NONE -> Unit
        }
        // A deferred mark stays: if this re-dispatch dies without an outcome,
        // the occurrence is deferred (recoverable) again once abandoned. It
        // ends when the occurrence starts or settles.
        if (prefs.edit().putLong(key, occurrenceMs).putLong(atKey, nowMs).commit()) return Claim.CLAIMED
        // Roll the in-memory values back (their own persistence is best-effort).
        runCatching {
            val undo = prefs.edit()
            if (previous == null) undo.remove(key) else undo.putLong(key, previous)
            if (previousAt == null) undo.remove(atKey) else undo.putLong(atKey, previousAt)
            undo.commit()
        }
        Log.e(TAG, "SCHEDULE_CLAIM_NOT_DURABLE agent=$agentId occurrence=$occurrenceMs: claim could not be persisted")
        audit(context, agentId, "claim_not_durable", JSONObject().put("expectedAt", occurrenceMs))
        return Claim.NOT_DURABLE
    }

    /**
     * The run of [occurrenceMs] is starting (TerminalSessionService, right
     * before runAgentInBackground): from now on it never runs again
     * (occurrenceClaimState STARTED). Also (re)writes the claim, so the mark
     * holds even when the fire ran unreserved after a NOT_DURABLE claim. A
     * failed commit is logged and the run proceeds: while it runs its lock
     * protects it, once finished its run log does.
     */
    @Synchronized
    fun markOccurrenceStarted(context: Context, agentId: String, occurrenceMs: Long): Boolean {
        val ok = runCatching {
            context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE).edit()
                .putLong(STARTED_PREFIX + agentId, occurrenceMs)
                .putLong(CLAIMED_PREFIX + agentId, occurrenceMs)
                .remove(DEFERRED_PREFIX + agentId)
                .commit()
        }.getOrDefault(false)
        if (!ok) {
            Log.e(TAG, "SCHEDULE_START_MARK_NOT_DURABLE agent=$agentId occurrence=$occurrenceMs")
            audit(context, agentId, "start_mark_not_durable", JSONObject().put("expectedAt", occurrenceMs))
        } else {
            // Started: its recovery tick is no longer needed.
            runCatching { relaxReservationRecovery(context, agentId) }
                .onFailure { Log.w(TAG, "Could not relax the recovery tick for $agentId", it) }
        }
        return ok
    }

    /**
     * The dispatch of [occurrenceMs] reached AgentRuntime and was refused
     * there before the executor launched (disabled, failure backoff,
     * extraction failure, missing / stale script or plan, …): SETTLED — it is
     * never re-dispatched (those refusals are governed by the failure /
     * backoff / circuit-breaker machinery; a re-dispatch would be refused
     * again). Called only for a scheduled occurrence (TerminalSessionService);
     * manual / widget / MCP runs never touch claims. A failed commit leaves
     * the reservation, which turns abandoned and is re-dispatched inside its
     * window (the refusal's own log usually settles it anyway).
     */
    @Synchronized
    fun markOccurrenceSettled(context: Context, agentId: String, occurrenceMs: Long, reason: String): Boolean {
        val ok = runCatching {
            context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE).edit()
                .putLong(SETTLED_PREFIX + agentId, occurrenceMs)
                .putLong(CLAIMED_PREFIX + agentId, occurrenceMs)
                .remove(DEFERRED_PREFIX + agentId)
                .commit()
        }.getOrDefault(false)
        Log.i(TAG, "SCHEDULE_SETTLED agent=$agentId occurrence=$occurrenceMs durable=$ok: refused before launch")
        audit(context, agentId, "settled", JSONObject().put("expectedAt", occurrenceMs).put("durable", ok).put("reason", reason.take(160)))
        if (ok) {
            runCatching { relaxReservationRecovery(context, agentId) }
                .onFailure { Log.w(TAG, "Could not relax the recovery tick for $agentId", it) }
        }
        return ok
    }

    /**
     * The dispatch of [occurrenceMs] was refused because a previous run of
     * the agent was still active (AgentRuntime.PREVIOUS_RUN_ACTIVE_MESSAGE):
     * DEFERRED — not settled. Reconcile may run it late, inside its window,
     * once no run is live; a recovery tick is armed so a pass comes back (and
     * keeps coming back while the run is live, see SKIP_RUNNING). The claim
     * time is reset to now (so this recovery tick, not the original
     * reservation, bounds it). A failed commit leaves the reservation
     * (abandoned later; its refusal log then counts as evidence, so the
     * occurrence is not retried).
     */
    @Synchronized
    fun markOccurrenceDeferred(context: Context, agentId: String, occurrenceMs: Long): Boolean {
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val ok = runCatching {
            val edit = prefs.edit()
                .putLong(DEFERRED_PREFIX + agentId, occurrenceMs)
                .putLong(CLAIMED_PREFIX + agentId, occurrenceMs)
                // The claim's age bounds its recovery ticks (pendingRecoveryTick);
                // a fire that ran unreserved (NOT_DURABLE) had none.
                .putLong(CLAIMED_AT_PREFIX + agentId, now)
            edit.commit()
        }.getOrDefault(false)
        Log.i(TAG, "SCHEDULE_DEFERRED agent=$agentId occurrence=$occurrenceMs durable=$ok: previous run still active")
        audit(context, agentId, "deferred", JSONObject().put("expectedAt", occurrenceMs).put("durable", ok))
        if (ok) {
            runCatching { armReservationRecovery(context, agentId, now) }
                .onFailure { Log.e(TAG, "Could not arm the deferred-occurrence recovery tick for $agentId", it) }
        }
        return ok
    }

    /**
     * A reservation was just taken for [agentId] (reconcile late run or a
     * regular fire): if its run never starts (process death, failed
     * dispatch), a reconcile pass must come back right after the
     * reservation counts as abandoned, while the occurrence is still inside
     * its window. Records the deadline and pulls the watchdog in to it (never
     * pushes an earlier tick later). Returns the deadline.
     */
    @Synchronized
    fun armReservationRecovery(context: Context, agentId: String, nowMs: Long = System.currentTimeMillis()): Long {
        val at = nowMs + AgentScheduleReconcileCore.CLAIM_ABANDON_MS + AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        prefs.edit().putLong(RECOVERY_PREFIX + agentId, at).apply()
        try {
            val armed = prefs.getLong(WATCHDOG_AT_KEY, 0L)
            val piAlive = watchdogPendingIntent(context, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) != null
            if (!(piAlive && armed > nowMs && armed <= at)) armReconcileWatchdog(context, at)
        } catch (e: Exception) {
            Log.e(TAG, "Could not arm the reservation recovery tick for $agentId", e)
        }
        return at
    }

    /** Earliest persisted reservation recovery deadline (any agent), due or
     *  not; null when none is pending. A value <= now means a recovery pass
     *  is owed right away. */
    private fun earliestRecoveryNeed(prefs: android.content.SharedPreferences): Long? =
        prefs.all.mapNotNull { (k, v) -> if (k.startsWith(RECOVERY_PREFIX)) v as? Long else null }.minOrNull()

    /**
     * End of a reconcile pass: the earliest persisted reservation recovery
     * deadline the watchdog must still honour, so a pass never replaces a
     * pending recovery tick with its hourly one. A deadline that is due was
     * serviced only if this pass actually decided that agent ([decided]);
     * otherwise (agent file unreadable, per-agent failure) it is retried
     * CLAIM_ABANDON_MS + 1 min later, for as long as its reservation is
     * younger than the 2 h window cap. Deadlines of agents without a
     * schedule, or past the cap, are dropped.
     */
    private fun pendingRecoveryTick(context: Context, now: Long, decided: Set<String>, scheduledIds: Set<String>): Long? {
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        val edit = prefs.edit()
        var earliest: Long? = null
        for ((key, value) in prefs.all) {
            if (!key.startsWith(RECOVERY_PREFIX)) continue
            val agentId = key.removePrefix(RECOVERY_PREFIX)
            val at = value as? Long
            val claimedAt = prefs.getLong(CLAIMED_AT_PREFIX + agentId, -1L)
            val keep = when {
                at == null || agentId !in scheduledIds -> null
                at > now -> at
                agentId in decided -> null
                claimedAt > 0 && now - claimedAt <= AgentScheduleReconcileCore.CATCH_UP_WINDOW_CAP_MS ->
                    now + AgentScheduleReconcileCore.CLAIM_ABANDON_MS + AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS
                else -> null
            }
            if (keep == null) edit.remove(key) else if (keep != at) edit.putLong(key, keep)
            if (keep != null) earliest = minOf(earliest ?: keep, keep)
        }
        edit.apply()
        return earliest
    }

    /**
     * The reserved run of [agentId] started: drop its recovery deadline and,
     * if the watchdog is armed EARLIER than anything still needs, push it
     * back out to the earliest remaining need — another pending recovery, the
     * last reconcile pass's own tick, or the hourly period — so a run that
     * starts normally costs no extra reconcile pass.
     */
    private fun relaxReservationRecovery(context: Context, agentId: String) {
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        if (!prefs.contains(RECOVERY_PREFIX + agentId)) return
        prefs.edit().remove(RECOVERY_PREFIX + agentId).apply()
        if (isGloballyHalted(context) || !hasReconcilableSchedules(context)) return
        val now = System.currentTimeMillis()
        val armed = prefs.getLong(WATCHDOG_AT_KEY, 0L)
        if (armed <= now) return
        val pending = earliestRecoveryNeed(prefs)
        // Another reservation's recovery is overdue (its pass has not run
        // yet): whatever is armed may be that pass — leave it alone.
        if (pending != null && pending <= now) return
        val tick = prefs.getLong(RECONCILE_TICK_KEY, 0L).takeIf { it > now }
        val target = listOfNotNull(pending, tick, now + AgentScheduleReconcileCore.RECONCILE_WATCHDOG_PERIOD_MS).minOrNull() ?: return
        if (armed < target) armReconcileWatchdog(context, target)
    }

    /** The service intent every reconcile entry point sends. */
    fun reconcileServiceIntent(context: Context, reason: String): Intent =
        Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_SCHEDULE_RECONCILE
            putExtra(TerminalSessionService.EXTRA_RECONCILE_REASON, reason)
        }

    /**
     * Receivers / the bridge: hand a reconcile pass to TerminalSessionService
     * (ACTION_SCHEDULE_RECONCILE). BOOT_COMPLETED, MY_PACKAGE_REPLACED and the
     * exact-alarm grant broadcast all allow a foreground-service start. If
     * the start is refused anyway, the watchdog is (re-)armed so a later tick
     * reconciles. Returns whether the service start was accepted.
     */
    fun startReconcileService(context: Context, reason: String): Boolean {
        val app = context.applicationContext
        return try {
            val intent = reconcileServiceIntent(app, reason)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Reconcile service start refused ($reason); arming the watchdog instead", e)
            audit(app, "-", "reconcile_start_refused", JSONObject().put("trigger", reason).put("error", e.javaClass.simpleName))
            runCatching { ensureReconcileWatchdog(app, force = true) }
            false
        }
    }

    private fun watchdogPendingIntent(context: Context, flags: Int = piFlags()): PendingIntent? {
        val intent = reconcileServiceIntent(context, RECONCILE_REASON_WATCHDOG)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, WATCHDOG_REQUEST_CODE, intent, flags)
        } else {
            PendingIntent.getService(context, WATCHDOG_REQUEST_CODE, intent, flags)
        }
    }

    /** Arm the watchdog at [atMs] (exact while idle; inexact fallback is
     *  logged — a late reconcile is still useful). */
    fun armReconcileWatchdog(context: Context, atMs: Long) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = watchdogPendingIntent(context) ?: return
        setExactWhileIdle(context, am, atMs, pi, "reconcile-watchdog")
        context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE).edit().putLong(WATCHDOG_AT_KEY, atMs).apply()
        Log.i(TAG, "Reconcile watchdog armed at $atMs")
    }

    /**
     * Arm the watchdog one period out unless one is already armed for an
     * earlier future time (never pushes a pending tick later, so a grace
     * follow-up survives later schedule() calls). [force] re-arms regardless
     * (after a reboot every alarm is gone). The PendingIntent's existence is
     * part of "already armed": a force-stop / reboot removes it.
     */
    fun ensureReconcileWatchdog(context: Context, force: Boolean = false) {
        if (isGloballyHalted(context)) return
        if (!hasReconcilableSchedules(context)) return
        val now = System.currentTimeMillis()
        val period = AgentScheduleReconcileCore.RECONCILE_WATCHDOG_PERIOD_MS
        // Never later than a pending reservation recovery deadline (a due one
        // gets a pass a minute from now): re-arming here — including the
        // forced re-arm after a refused service start or a reboot — must not
        // replace a recovery tick with the hourly one.
        val prefs = context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE)
        // Per deadline: an overdue one becomes "a minute from now", a future
        // one stays as is; then the earliest.
        val recovery = prefs.all.mapNotNull { (k, v) ->
            if (k.startsWith(RECOVERY_PREFIX)) (v as? Long)?.let {
                if (it <= now) now + AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS else it
            } else null
        }.minOrNull()
        val target = minOf(now + period, recovery ?: (now + period))
        if (!force) {
            val armedAt = prefs.getLong(WATCHDOG_AT_KEY, 0L)
            val piAlive = watchdogPendingIntent(context, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) != null
            if (piAlive && armedAt > now && armedAt <= target) return
        }
        armReconcileWatchdog(context, target)
    }

    fun cancelReconcileWatchdog(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        watchdogPendingIntent(context, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let {
            runCatching { am.cancel(it) }
            runCatching { it.cancel() }
        }
        context.getSharedPreferences(RECONCILE_PREFS, Context.MODE_PRIVATE).edit().remove(WATCHDOG_AT_KEY).apply()
    }

    /**
     * One JSON line per scheduling event in ~/.shelly/agents/logs/
     * schedule-reconcile.jsonl (outside every logs/<id>/ dir, so it is never
     * read as a run log). Bounded: past 128 KB the older half is dropped.
     * Device evidence for doze-scheduler-diagnosis §7; best-effort.
     */
    @Synchronized
    fun audit(context: Context, agentId: String, event: String, extra: JSONObject?) {
        try {
            val file = File(HomeInitializer.getHomeDir(context), AUDIT_FILE)
            file.parentFile?.mkdirs()
            if (file.isFile && file.length() > AUDIT_MAX_BYTES) {
                val lines = file.readLines()
                file.writeText(lines.drop(lines.size / 2).joinToString("\n", postfix = "\n"))
            }
            val row = (extra ?: JSONObject()).put("ts", System.currentTimeMillis()).put("agentId", agentId).put("event", event)
            file.appendText(row.toString() + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "Schedule audit write failed ($event, $agentId)", e)
        }
    }

    /**
     * Cron -> most recent fire epoch ms at or before [nowMs] (an occurrence
     * exactly at nowMs counts). Mirrors lib/agent-scheduler.ts lastTriggerMs
     * for the shapes nextTriggerAt below supports (every-N-min, every-N-hour,
     * daily, daily-multi, weekly single/CSV DOW), with the same field guards as
     * nextTriggerAt. One-shot sentinels and anything else → null. Used only by
     * reconcile().
     */
    fun lastTriggerAt(cron: String?, nowMs: Long): Long? {
        if (cron.isNullOrBlank()) return null
        if (cron.trim().startsWith("@")) return null
        val parts = cron.trim().split(Regex("\\s+"))
        if (parts.size != 5) return null

        val minute = parts[0]
        val hour = parts[1]
        val dayOfMonth = parts[2]
        val month = parts[3]
        val dayOfWeek = parts[4]
        val now = Calendar.getInstance().apply { timeInMillis = nowMs }
        val target = Calendar.getInstance().apply { timeInMillis = nowMs }

        val everyMin = Regex("^\\*/(\\d+)$").matchEntire(minute)?.groupValues?.get(1)?.toIntOrNull()
        if (everyMin != null && everyMin > 0 && hour == "*" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            target.set(Calendar.SECOND, 0)
            target.set(Calendar.MILLISECOND, 0)
            target.set(Calendar.MINUTE, (now.get(Calendar.MINUTE) / everyMin) * everyMin)
            return target.timeInMillis
        }

        val everyHour = Regex("^\\*/(\\d+)$").matchEntire(hour)?.groupValues?.get(1)?.toIntOrNull()
        if (everyHour != null && everyHour > 0 && minute == "0" && dayOfMonth == "*" && month == "*" && dayOfWeek == "*") {
            target.set(Calendar.MINUTE, 0)
            target.set(Calendar.SECOND, 0)
            target.set(Calendar.MILLISECOND, 0)
            // Valid hours are {0, N, 2N, ...} within the day: the latest one at
            // or before the current hour (hour 0 always qualifies).
            target.set(Calendar.HOUR_OF_DAY, (now.get(Calendar.HOUR_OF_DAY) / everyHour) * everyHour)
            return target.timeInMillis
        }

        val parsedMinute = minute.toIntOrNull()

        // Daily-multi ("m 8,21 * * *"): the latest listed hour at or before now,
        // else yesterday's. Checked before the single-hour guard (as in nextTriggerAt).
        if (parsedMinute != null && dayOfMonth == "*" && month == "*" && dayOfWeek == "*" &&
            Regex("^\\d+(,\\d+)+$").matches(hour)
        ) {
            val parsedHours = hour.split(",").map { it.toIntOrNull() }
            if (parsedHours.any { it == null || it !in 0..23 }) return null
            var best: Long? = null
            for (h in parsedHours.filterNotNull().distinct()) {
                val candidate = now.clone() as Calendar
                candidate.set(Calendar.HOUR_OF_DAY, h)
                candidate.set(Calendar.MINUTE, parsedMinute)
                candidate.set(Calendar.SECOND, 0)
                candidate.set(Calendar.MILLISECOND, 0)
                if (candidate.timeInMillis > now.timeInMillis) candidate.add(Calendar.DAY_OF_YEAR, -1)
                if (best == null || candidate.timeInMillis > best!!) best = candidate.timeInMillis
            }
            return best
        }

        val parsedHour = hour.toIntOrNull()
        if (parsedMinute == null || parsedHour == null || dayOfMonth != "*" || month != "*") return null

        target.set(Calendar.HOUR_OF_DAY, parsedHour)
        target.set(Calendar.MINUTE, parsedMinute)
        target.set(Calendar.SECOND, 0)
        target.set(Calendar.MILLISECOND, 0)

        // Weekly single day or CSV ("1,5"): the most recent listed day. Like
        // lib/agent-scheduler.ts parseDowList, any value > 7 rejects the field.
        if (Regex("^\\d+(,\\d+)*$").matches(dayOfWeek)) {
            val days = dayOfWeek.split(",").map { it.toIntOrNull() ?: return null }
            if (days.any { it > 7 }) return null
            val todayDow = target.get(Calendar.DAY_OF_WEEK) - 1 // 0 = Sunday, like JS getDay()
            var best: Long? = null
            for (day in days.map { it % 7 }.distinct()) {
                val candidate = target.clone() as Calendar
                var daysSince = (todayDow - day + 7) % 7
                if (daysSince == 0 && candidate.timeInMillis > now.timeInMillis) daysSince = 7
                candidate.add(Calendar.DAY_OF_YEAR, -daysSince)
                if (best == null || candidate.timeInMillis > best!!) best = candidate.timeInMillis
            }
            return best
        }

        if (dayOfWeek != "*") return null
        // Daily: today at h:m if already reached, else yesterday.
        if (target.timeInMillis > now.timeInMillis) target.add(Calendar.DAY_OF_YEAR, -1)
        return target.timeInMillis
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
