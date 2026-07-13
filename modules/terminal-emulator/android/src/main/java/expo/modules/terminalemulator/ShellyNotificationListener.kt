package expo.modules.terminalemulator

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

data class PairingCandidate(
    val packageName: String,
    val notificationId: Int,
    val notificationTag: String?,
    val shortcutId: String?,
    val title: String,
    val textPreview: String,
)

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
        const val REPLY_ENABLED_KEY = "reply_enabled"

        @Volatile
        private var activeInstance: ShellyNotificationListener? = null

        private const val REPLY_DEBOUNCE_MS = 10_000L
        private val lastReplyAtMs = ConcurrentHashMap<String, Long>()

        /** Native enable flag for the notification listener. Defaults false (dormant). */
        fun notificationListenerEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(ENABLED_KEY, false)

        /** Independent send-side gate. Defaults false even when notification reads are enabled. */
        fun notificationReplyEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(REPLY_ENABLED_KEY, false)

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

        private fun shouldReplyNow(packageName: String): Boolean {
            val now = SystemClock.elapsedRealtime()
            val previous = lastReplyAtMs.put(packageName, now)
            return previous == null || now - previous >= REPLY_DEBOUNCE_MS
        }

        private fun findReplyAction(sbn: StatusBarNotification): Notification.Action? =
            sbn.notification?.actions?.firstOrNull { action ->
                val inputs = action.remoteInputs
                !inputs.isNullOrEmpty() &&
                    ((Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                        action.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY) ||
                        inputs.any { it.allowFreeFormInput })
            }

        private fun sendReply(
            context: Context,
            sbn: StatusBarNotification,
            action: Notification.Action,
            replyText: String,
        ): Boolean = runCatching {
            val inputs = action.remoteInputs ?: return false
            val fillIn = Intent()
            val results = Bundle()
            inputs.forEach { results.putCharSequence(it.resultKey, replyText) }
            RemoteInput.addResultsToIntent(inputs, fillIn, results)
            action.actionIntent.send(context, 0, fillIn)
            Log.i(TAG, "sendReply: pkg=${sbn.packageName} textLen=${replyText.length} sent=true")
            true
        }.onFailure {
            Log.w(TAG, "sendReply: pkg=${sbn.packageName} textLen=${replyText.length} sent=false", it)
        }.getOrDefault(false)

        /** Legacy/self-test entry point: most recent replyable notification from an exact package. */
        fun attemptSendReply(context: Context, packageName: String, replyText: String): Boolean {
            if (!notificationListenerEnabled(context) || !notificationReplyEnabled(context)) return false
            if (!shouldReplyNow(packageName)) return false
            val sbn = runCatching { activeInstance?.activeNotifications }
                .getOrNull()?.filter { it.packageName == packageName && findReplyAction(it) != null }
                ?.maxByOrNull { it.postTime } ?: return false
            return sendReply(context, sbn, findReplyAction(sbn) ?: return false, replyText)
        }

        fun findNotificationMatchingCode(code: String): List<PairingCandidate> {
            if (code.isBlank()) return emptyList()
            val instance = activeInstance ?: return emptyList()
            if (!notificationListenerEnabled(instance.applicationContext)) return emptyList()
            val notifications = runCatching { instance.activeNotifications }.getOrNull()
                ?: return emptyList()
            val candidates = notifications.mapNotNull { sbn ->
                runCatching {
                    if (findReplyAction(sbn) == null) return@runCatching null
                    val extras = sbn.notification?.extras ?: return@runCatching null
                    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
                    val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
                    val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
                    val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString().orEmpty()
                    val summary = extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)?.toString().orEmpty()
                    val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                        ?.joinToString(" ") { it?.toString().orEmpty() }.orEmpty()
                    if (listOf(title, text, bigText, subText, summary, lines).none { it.contains(code) }) {
                        return@runCatching null
                    }
                    val preview = if (bigText.contains(code)) bigText else text
                    PairingCandidate(
                        packageName = sbn.packageName,
                        notificationId = sbn.id,
                        notificationTag = sbn.tag,
                        shortcutId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) sbn.notification?.shortcutId else null,
                        title = title.take(120),
                        textPreview = preview.take(120),
                    )
                }.getOrNull()
            }
            Log.i(TAG, "findNotificationMatchingCode: found ${candidates.size} candidate(s)")
            return candidates
        }

        private data class DmPairingRecord(
            val packageName: String,
            val notificationId: Int,
            val notificationTag: String?,
            val shortcutId: String?,
            val revoked: Boolean,
        )

        private fun readDmPairingRecord(context: Context, id: String): DmPairingRecord? {
            return try {
                if (id.isBlank()) return null
                val file = File(HomeInitializer.getHomeDir(context), ".shelly/agents/dm-pairings.json")
                if (!file.isFile) return null
                val array = JSONArray(file.readText())
                for (index in 0 until array.length()) {
                    val obj = array.optJSONObject(index) ?: continue
                    if (obj.optString("id") != id) continue
                    val packageName = obj.optString("packageName").takeIf { it.isNotBlank() } ?: return null
                    val notificationIdValue = obj.opt("notificationId") as? Number ?: return null
                    val notificationIdLong = notificationIdValue.toLong()
                    if (notificationIdValue.toDouble() != notificationIdLong.toDouble() ||
                        notificationIdLong !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()
                    ) return null
                    val revoked = obj.opt("revoked") as? Boolean ?: return null
                    val tagValue = obj.opt("notificationTag")
                    val shortcutValue = obj.opt("shortcutId")
                    if (tagValue != null && tagValue !== JSONObject.NULL && tagValue !is String) return null
                    if (shortcutValue != null && shortcutValue !== JSONObject.NULL && shortcutValue !is String) return null
                    return DmPairingRecord(
                        packageName,
                        notificationIdLong.toInt(),
                        (tagValue as? String)?.takeIf { it.isNotBlank() },
                        (shortcutValue as? String)?.takeIf { it.isNotBlank() },
                        revoked,
                    )
                }
                null
            } catch (_: Exception) {
                // org.json parse exceptions can embed the source text. This file
                // contains notification-derived titles, so never attach the
                // exception or record content to logcat.
                Log.w(TAG, "readDmPairingRecord: malformed or unavailable pairing mirror")
                null
            }
        }

        private fun findReplyableNotificationForFingerprint(record: DmPairingRecord): StatusBarNotification? {
            val notifications = runCatching { activeInstance?.activeNotifications }.getOrNull() ?: return null
            return notifications.firstOrNull { sbn ->
                if (sbn.packageName != record.packageName || findReplyAction(sbn) == null) return@firstOrNull false
                if (!record.shortcutId.isNullOrBlank()) {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && sbn.notification?.shortcutId == record.shortcutId
                } else {
                    sbn.id == record.notificationId && sbn.tag == record.notificationTag
                }
            }
        }

        /** Re-reads pairing and both gates at send time; never accepts caller-supplied fingerprint fields. */
        fun sendPairedDmReply(context: Context, dmPairingId: String, replyText: String): Boolean {
            val record = readDmPairingRecord(context, dmPairingId) ?: return false
            if (record.revoked || !notificationListenerEnabled(context) || !notificationReplyEnabled(context)) return false
            if (!shouldReplyNow(record.packageName)) return false
            val sbn = findReplyableNotificationForFingerprint(record) ?: return false
            val action = findReplyAction(sbn) ?: return false
            val sent = sendReply(context, sbn, action, replyText)
            Log.i(TAG, "sendPairedDmReply: pkg=${record.packageName} textLen=${replyText.length} result=$sent")
            return sent
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        activeInstance = this
        Log.i(TAG, "Notification listener connected")
    }

    override fun onListenerDisconnected() {
        if (activeInstance === this) activeInstance = null
        Log.i(TAG, "Notification listener disconnected")
        super.onListenerDisconnected()
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
