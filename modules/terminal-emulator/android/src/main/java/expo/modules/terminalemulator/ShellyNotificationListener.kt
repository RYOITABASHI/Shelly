package expo.modules.terminalemulator

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * NOTIFY-001 Increment 0+1 (flag-gated, default OFF): cross-app notification
 * read + trigger-and-react agent dispatch.
 *
 * The L1/L2 capability catalog
 * (docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md) flags
 * NOTIFY-001 as CRITICAL risk: "all notifications = perfect exfiltration
 * source, untrusted firehose". Increment 1 is the first increment that lets a
 * notification's ARRIVAL (package name only — never title/text content)
 * reach an agent: when the flag is on and at least one on-disk agent has
 * opted in via `notificationTrigger.packageNames`, a matching notification
 * fires that agent as an immediate one-shot run with `tainted=true` threaded
 * all the way through TerminalSessionService.ACTION_RUN_AGENT →
 * AgentRuntime.runAgent → the generated agent script → the capability broker's
 * http.request op, per CAP-001 (see lib/capability-envelope.ts's
 * classifyEgress). Untrusted notification-triggered input is exactly the
 * kind of attacker-reachable input that taint-tracking exists to contain (a
 * poisoned/spoofed notification could otherwise trick an agent into
 * spending a live secret or egressing to a non-allowlist host) — so the
 * whole triggered run is coarsely tainted, not just the notification text
 * itself (which this increment still never reads for dispatch purposes;
 * only the sender package name is used to look up a match).
 *
 * This is a trigger-and-react design, not an inbox: no captured notification
 * is ever persisted to a new directory. The lookup reads the SAME on-disk
 * agent cards (the per-agent JSON files under $HOME/.shelly/agents) that
 * already exist for every other run path, and firing is a plain Intent to
 * TerminalSessionService, identical in shape to a manual "Once" run (no
 * interval/cron extras) — no new storage is introduced by this increment.
 *
 * Dormant discipline mirrors BootCompletedReceiver.kt exactly: gate on a
 * SharedPreferences-backed flag (default false) at the very top of
 * onNotificationPosted, log at Log.i that a notification arrived but the
 * listener is dormant, and return BEFORE reading any notification content —
 * not even for logging. Only once the flag is on do we read the four named
 * extras fields (never the whole Bundle — it can carry large image/media
 * attachments) and even then, for this increment, only log field lengths and
 * package name, never raw third-party notification content into logcat. The
 * second natural gate is data-driven, not a flag: if no on-disk agent has
 * `notificationTrigger` set, the lookup below matches nothing and no run is
 * ever fired.
 *
 * On-device testing with a real mail app (Spark) showed the OS can deliver
 * several rapid onNotificationPosted calls for what a user perceives as one
 * logical event (initial post, then removed+reposted, then updated again),
 * each independently matching the same agent — so a per-agent debounce
 * (see [shouldFireNow]) suppresses repeat fires of the same agent within a
 * short window, without persisting anything new to disk.
 */
class ShellyNotificationListener : NotificationListenerService() {
    companion object {
        private const val TAG = "ShellyNotificationListener"
        const val PREFS = "shelly_notification_listener"
        const val ENABLED_KEY = "enabled"

        /** Native enable flag for the notification listener. Defaults false (dormant). */
        fun notificationListenerEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(ENABLED_KEY, false)

        /** Minimum time between two notification-triggered runs of the SAME agent.
         *  Notification-posting apps (mail/chat sync) commonly emit several rapid
         *  onNotificationPosted calls for what a user perceives as one logical
         *  event (post, remove+repost, content update) — without this, a single
         *  "new mail" event can fire the same agent ~10x in a few seconds
         *  (confirmed on-device). In-memory only, not persisted: this is a
         *  best-effort anti-spam guard, not a security boundary, and resets
         *  cleanly on process restart (a genuinely new notification after
         *  restart is a legitimate re-trigger, not a bug to guard against). */
        private const val TRIGGER_DEBOUNCE_MS = 60_000L

        // Pure-logic debounce core (see TriggerDebouncer.kt for the testability
        // rationale). Uses SystemClock.elapsedRealtime() (monotonic, ticks during
        // sleep, not wall-clock) rather than System.currentTimeMillis(): a backward
        // wall-clock jump between two rapid onNotificationPosted calls must not
        // defeat the suppression this exists to provide.
        private val triggerDebouncer = TriggerDebouncer(TRIGGER_DEBOUNCE_MS)

        /** Returns true (and records the fire) if [agentId] may fire now; false if
         *  it fired within the last [TRIGGER_DEBOUNCE_MS] and this call should be
         *  suppressed as a burst repeat. */
        private fun shouldFireNow(agentId: String): Boolean =
            triggerDebouncer.shouldFireNow(agentId, SystemClock.elapsedRealtime())
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val context = applicationContext
        if (!notificationListenerEnabled(context)) {
            Log.i(TAG, "Notification received; listener disabled (dormant), nothing captured")
            return
        }

        // Flag is on. Increment 0: capture ONLY the four named fields (never the
        // full extras Bundle — it can carry large image/media attachments), each
        // read defensively so a malformed extras bundle from a hostile or broken
        // app can't crash the listener. Log lengths/package only — never the raw
        // title/text content — to avoid leaking third-party notification content
        // into logcat. Nothing is persisted or forwarded yet; that is Increment 1.
        try {
            val packageName = runCatching { sbn.packageName }.getOrNull() ?: "<unknown>"
            val postTime = runCatching { sbn.postTime }.getOrDefault(0L)
            val extras = runCatching { sbn.notification?.extras }.getOrNull()
            val title = runCatching {
                extras?.getCharSequence(Notification.EXTRA_TITLE)
            }.getOrNull()
            val text = runCatching {
                extras?.getCharSequence(Notification.EXTRA_TEXT)
            }.getOrNull()

            Log.i(
                TAG,
                "Notification captured (dormant consumer): pkg=$packageName " +
                    "titleLen=${title?.length ?: 0} textLen=${text?.length ?: 0} postTime=$postTime",
            )

            // Increment 1: look up any agent(s) that opted into this package via
            // notificationTrigger.packageNames, and fire each as an immediate,
            // one-shot, tainted run. Wrapped in its own try so a lookup/dispatch
            // failure can never take down onNotificationPosted (this runs on the
            // system notification-listener binder thread).
            try {
                val matchedAgentIds = findAgentsTriggeredBy(context, packageName)
                for (agentId in matchedAgentIds) {
                    if (!shouldFireNow(agentId)) {
                        Log.i(TAG, "Notification from $packageName matched agent $agentId but debounced (fired within last ${TRIGGER_DEBOUNCE_MS}ms)")
                        continue
                    }
                    Log.i(TAG, "Notification from $packageName triggering agent $agentId (tainted run)")
                    fireAgentRun(context, agentId)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Notification-trigger agent lookup/dispatch failed defensively", e)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Notification capture failed defensively", e)
        }
    }

    /**
     * Scans the per-agent JSON files under $HOME/.shelly/agents (NOT
     * recursive — does not descend into plans/, which holds PlanSpec files,
     * not agent cards) for enabled agents whose
     * notificationTrigger.packageNames contains [packageName] (exact,
     * case-sensitive match). A single malformed agent file is skipped
     * defensively so it can't block the rest of the scan.
     */
    private fun findAgentsTriggeredBy(context: Context, packageName: String): List<String> {
        val homeDir = HomeInitializer.getHomeDir(context)
        val agentsDir = File(homeDir, ".shelly/agents")
        val files = agentsDir.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?: return emptyList()

        val matched = mutableListOf<String>()
        for (file in files) {
            try {
                val expectedId = file.name.removeSuffix(".json")
                val json = JSONObject(file.readText())
                if (json.optString("id") != expectedId) continue
                if (!json.optBoolean("enabled", false)) continue
                val packageNames = json.optJSONObject("notificationTrigger")
                    ?.optJSONArray("packageNames")
                    ?: continue
                var matchesPackage = false
                for (i in 0 until packageNames.length()) {
                    if (packageNames.optString(i) == packageName) {
                        matchesPackage = true
                        break
                    }
                }
                if (matchesPackage) matched.add(expectedId)
            } catch (e: Exception) {
                Log.w(TAG, "Skipping malformed agent file ${file.name} during notification-trigger scan", e)
            }
        }
        return matched
    }

    /**
     * Fires an immediate, one-shot, tainted run of [agentId] — same shape as a
     * manual "Once" run (no EXTRA_INTERVAL_MS/EXTRA_CRON, so
     * TerminalSessionService computes unattended=false). The STOP-ALL
     * kill-switch check already lives inside TerminalSessionService's
     * ACTION_RUN_AGENT handler, so it is not duplicated here.
     */
    private fun fireAgentRun(context: Context, agentId: String) {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            putExtra(TerminalSessionService.EXTRA_TAINTED, true)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val context = applicationContext
        if (!notificationListenerEnabled(context)) {
            Log.i(TAG, "Notification removal received; listener disabled (dormant), nothing captured")
            return
        }
        val packageName = runCatching { sbn.packageName }.getOrNull() ?: "<unknown>"
        Log.i(TAG, "Notification removed (dormant consumer): pkg=$packageName")
    }
}
