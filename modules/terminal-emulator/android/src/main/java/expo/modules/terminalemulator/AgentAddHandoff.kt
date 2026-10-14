package expo.modules.terminalemulator

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.FileObserver
import android.util.Log
import expo.modules.terminalemulator.scouter.redactForScouter
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * `shelly agent add "<natural language>"` — native BACKGROUND half
 * (2026-10-14). The reference spec is lib/agent-add-queue.ts; read that first.
 *
 * The shim (SHELLY_HELPER_SHIM v13, HomeInitializer.kt) writes ONE request
 * file per request, `$HOME/.shelly-agent-req-<reqId>` (tmp + rename), holding
 * `agentadd:<reqId>:<tsMs>:<encodeURIComponent(text)>\n`.
 *
 * The request text only ever enters the app through RN (app/_layout.tsx),
 * which claims request files while Shelly is ACTIVE and seeds the normal
 * in-app `@agent <NL>` flow (origin line + mandatory chat confirmation).
 * The RN JS timers do not run while Shelly is backgrounded, so this object —
 * started from TerminalSessionService (alive whenever a terminal session,
 * e.g. the Codex remote-control host, exists) and the Expo Module — covers
 * that case: when Shelly is not the foreground app, or RN has not claimed a
 * request within [RN_GRACE_MS], it renames the request to
 * `$HOME/.shelly-agent-pending-<reqId>` (the atomic rename decides the race
 * with RN's own claim-rename: exactly one wins), posts "Shelly: confirm new
 * agent" whose tap simply opens Shelly, and answers the shim with
 * `.shelly-agent-result-<reqId>.json` (code "notified"). RN picks pending
 * files up once foregrounded and does not answer the shim again.
 *
 * This object NEVER registers anything, never writes ~/.shelly/agents, and
 * never hands the text to any flow itself; it only moves the file, shows a
 * redacted preview in a VISIBILITY_PRIVATE notification and expires requests
 * older than [MAX_AGE_MS].
 */
object AgentAddHandoff {
    private const val TAG = "AgentAddHandoff"

    // Mirrors lib/agent-add-queue.ts.
    const val QUEUE_PREFIX = "agentadd:"
    const val REQUEST_FILE_PREFIX = ".shelly-agent-req-"
    const val PENDING_FILE_PREFIX = ".shelly-agent-pending-"
    private const val TMP_SUFFIX = ".tmp"
    const val MAX_AGE_MS = 10L * 60L * 1000L
    const val MAX_FUTURE_MS = 5_000L
    const val MAX_ENCODED_CHARS = 24_000
    private const val MAX_CODE_POINTS = 2000
    private const val MAX_FILE_BYTES = 64L * 1024L
    /** How long an ACTIVE RN gets to claim a request before the
     *  notification route takes over (RN polls every 1s). */
    const val RN_GRACE_MS = 3_000L
    private const val STALE_TMP_MS = 60_000L

    const val MSG_NOTIFIED = "Shelly is in the background — tap the notification to confirm"
    const val MSG_QUEUED_NO_NOTIFICATION =
        "Shelly is in the background and its notifications are off — open Shelly within 10 minutes to confirm the new agent"

    private val REQ_ID_RE = Regex("^[0-9]{10,16}-[0-9a-f]{8}$")
    private val TS_RE = Regex("^[0-9]{10,16}$")
    private val REQUEST_FILE_RE = Regex("^\\.shelly-agent-req-([0-9]{10,16}-[0-9a-f]{8})$")
    private val PENDING_FILE_RE = Regex("^\\.shelly-agent-pending-([0-9]{10,16}-[0-9a-f]{8})$")
    private val CTL_FILE_RE = Regex("^\\.shelly-agent-ctl-([0-9]{10,16}-[0-9a-f]{8})$")
    private val HEX_NONCE_RE = Regex("^[0-9a-f]{32}$")
    const val MSG_CTL_BACKGROUND =
        "Shelly is in the background — open Shelly, then run the command again"
    private const val REQUEST_CODE_APPROVE = 0x37C1A012
    private const val REQUEST_CODE_REJECT = 0x37C1A013
    private const val REQUEST_CODE_REVIEW = 0x37C1A014
    private const val REQUEST_CODE_DISABLE = 0x37C1A015
    /** Separate from NOTIFICATION_ID so a later request never replaces it. */
    const val AUDIT_NOTIFICATION_ID = 0x37C1A016
    private val UNSAFE_CHARS_RE =
        Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF]")
    private val SPACE_RUN_RE = Regex(" {2,}")
    private val EDGE_SPACE_RE = Regex("^ +| +$")
    private val TRAILING_SPACE_RE = Regex(" +$")
    private val RESERVED_FIRST_WORDS = setOf("list", "run", "stop", "delete", "history", "edit", "status")

    const val CHANNEL_ID = "agent_add_request"
    // Next to ClosePawHandoff's 0x37C1A000/1, outside NotificationDispatcher's
    // ranges and TerminalSessionService's 7734. One stable id: a newer request
    // replaces an older, unanswered notification instead of stacking.
    const val NOTIFICATION_ID = 0x37C1A010
    private const val REQUEST_CODE = 0x37C1A011
    private const val FALLBACK_POLL_MS = 1_000L
    private const val OBSERVED_POLL_MS = 5_000L

    /** Port of lib/agent-add-queue.ts sanitizeAgentAddText. */
    fun sanitizeText(raw: String?): String {
        val collapsed = (raw ?: "")
            .replace(UNSAFE_CHARS_RE, " ")
            .replace(SPACE_RUN_RE, " ")
            .replace(EDGE_SPACE_RE, "")
        val count = collapsed.codePointCount(0, collapsed.length)
        if (count <= MAX_CODE_POINTS) return collapsed
        val end = collapsed.offsetByCodePoints(0, MAX_CODE_POINTS)
        return collapsed.substring(0, end).replace(TRAILING_SPACE_RE, "")
    }

    /** Port of lib/agent-add-queue.ts validateAgentAddText (null = OK). */
    fun validateText(text: String): String? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return "empty"
        if (trimmed.startsWith("@") || trimmed.startsWith("/")) return "reserved"
        val first = trimmed.split(Regex("\\s+")).firstOrNull()?.lowercase() ?: ""
        if (first in RESERVED_FIRST_WORDS) return "reserved"
        return null
    }

    sealed class Parsed {
        data class Ok(val reqId: String, val text: String) : Parsed()
        data class Bad(val reqId: String?, val reason: String) : Parsed()
    }

    /** Port of lib/agent-add-queue.ts parseAgentAddLine. Never throws. */
    fun parseLine(line: String, nowMs: Long): Parsed {
        if (!line.startsWith(QUEUE_PREFIX)) return Parsed.Bad(null, "malformed")
        val parts = line.substring(QUEUE_PREFIX.length).split(':')
        if (parts.size != 3) return Parsed.Bad(null, "malformed")
        val (reqIdRaw, tsRaw, encoded) = parts
        val reqId = if (REQ_ID_RE.matches(reqIdRaw)) reqIdRaw else null
        if (reqId == null || !TS_RE.matches(tsRaw) || encoded.length > MAX_ENCODED_CHARS) {
            return Parsed.Bad(reqId, "malformed")
        }
        val ts = tsRaw.toLongOrNull() ?: return Parsed.Bad(reqId, "stale")
        if (nowMs - ts > MAX_AGE_MS || ts - nowMs > MAX_FUTURE_MS) return Parsed.Bad(reqId, "stale")
        val decoded = ClosePawHandoff.decodeUriComponent(encoded) ?: return Parsed.Bad(reqId, "malformed")
        val text = sanitizeText(decoded)
        validateText(text)?.let { return Parsed.Bad(reqId, it) }
        return Parsed.Ok(reqId, text)
    }

    private fun rejectMessage(reason: String): String = when (reason) {
        "stale" -> "shelly agent add: the request expired before Shelly could show it; nothing was registered"
        "empty" -> "shelly agent add: the request is empty"
        "reserved" -> "shelly agent add: only new-agent requests are accepted (run/stop/delete/edit existing agents in Shelly itself)"
        else -> "shelly agent add: malformed request"
    }

    /** Shelly is the top, focused app (RN timers are running). */
    internal fun isForeground(): Boolean {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun reqIdTimestamp(reqId: String): Long = reqId.substringBefore('-').toLongOrNull() ?: 0L

    private fun writeResult(home: File, reqId: String, ok: Boolean, code: String, message: String) {
        try {
            val target = File(home, ".shelly-agent-result-$reqId.json")
            val tmp = File(home, ".shelly-agent-result-$reqId.json.tmp")
            tmp.writeText(JSONObject().put("ok", ok).put("code", code).put("message", message).toString())
            if (!tmp.renameTo(target)) {
                target.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to write agent-add result type=${e.javaClass.simpleName}")
        }
    }

    private fun writeCtlResult(home: File, ctlId: String, ok: Boolean, code: String, message: String) {
        try {
            val target = File(home, ".shelly-agent-ctlresult-$ctlId.json")
            val tmp = File(home, ".shelly-agent-ctlresult-$ctlId.json.tmp")
            tmp.writeText(JSONObject().put("ok", ok).put("code", code).put("message", message).toString())
            if (!tmp.renameTo(target)) {
                target.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to write agent ctl result type=${e.javaClass.simpleName}")
        }
    }

    private fun readFirstRecord(file: File): String? = try {
        if (!file.exists() || file.length() > MAX_FILE_BYTES) {
            null
        } else {
            val content = file.readText()
            val end = content.lastIndexOf('\n')
            if (end < 0) null else content.substring(0, end).split('\n').filter { it.isNotBlank() }.singleOrNull()
        }
    } catch (e: Exception) {
        null
    }

    @Volatile private var notificationShown = false

    /** One scan of $HOME. Synchronized with itself only; RN races are decided
     *  by the atomic renames. */
    @Synchronized
    fun scan(context: Context) {
        val home = try { HomeInitializer.getHomeDir(context) } catch (e: Exception) { return }
        val now = System.currentTimeMillis()
        val names = home.list()?.sorted() ?: return
        var pendingLeft = 0
        var recheck = false
        for (name in names) {
            val req = REQUEST_FILE_RE.matchEntire(name)
            if (req != null) {
                val reqId = req.groupValues[1]
                val file = File(home, name)
                val ts = reqIdTimestamp(reqId)
                if (now - ts > MAX_AGE_MS) {
                    if (file.delete()) writeResult(home, reqId, false, "stale", rejectMessage("stale"))
                    continue
                }
                // RN is running and will claim it within its 1s poll; give it
                // RN_GRACE_MS before taking the notification route.
                if (isForeground() && now - file.lastModified() < RN_GRACE_MS) {
                    recheck = true
                    continue
                }
                val record = readFirstRecord(file)
                val parsed = if (record == null) Parsed.Bad(reqId, "malformed") else parseLine(record, now)
                if (parsed is Parsed.Bad || (parsed is Parsed.Ok && parsed.reqId != reqId)) {
                    val reason = (parsed as? Parsed.Bad)?.reason ?: "malformed"
                    if (file.delete()) {
                        writeResult(home, reqId, false, if (reason == "stale") "stale" else "invalid", rejectMessage(reason))
                    }
                    Log.w(TAG, "agent add: $reqId rejected ($reason)")
                    continue
                }
                val text = (parsed as Parsed.Ok).text
                val pending = File(home, PENDING_FILE_PREFIX + reqId)
                // Lost the race to RN's claim → RN answers the shim.
                if (!file.renameTo(pending)) continue
                pendingLeft++
                val posted = postNotification(context, text)
                if (posted) {
                    writeResult(home, reqId, true, "notified", MSG_NOTIFIED)
                } else {
                    writeResult(home, reqId, true, "queued", MSG_QUEUED_NO_NOTIFICATION)
                }
                // Never log the text itself (free text) — length only.
                Log.i(TAG, "agent add: $reqId pending (notification=$posted, textLen=${text.length})")
                continue
            }
            // `shelly agent confirm|reject` control requests need the RN app
            // (the bindings and the registration path live in JS memory).
            // When Shelly is in the background, answer at once instead of
            // letting the shim time out; the user opens Shelly and retries.
            val ctl = CTL_FILE_RE.matchEntire(name)
            if (ctl != null) {
                val file = File(home, name)
                if (isForeground() && now - file.lastModified() < RN_GRACE_MS) {
                    recheck = true
                    continue
                }
                if (file.delete()) {
                    writeCtlResult(home, ctl.groupValues[1], false, "background", MSG_CTL_BACKGROUND)
                }
                continue
            }
            val pend = PENDING_FILE_RE.matchEntire(name)
            if (pend != null) {
                if (now - reqIdTimestamp(pend.groupValues[1]) > MAX_AGE_MS) File(home, name).delete()
                else pendingLeft++
                continue
            }
            if (name.startsWith(REQUEST_FILE_PREFIX) && name.endsWith(TMP_SUFFIX)) {
                val tmp = File(home, name)
                if (now - tmp.lastModified() > STALE_TMP_MS) tmp.delete()
            }
        }
        // RN consumed (or everything expired): drop the stale notification.
        if (pendingLeft == 0 && notificationShown) {
            runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID) }
            notificationShown = false
        }
        if (recheck) executor?.schedule({ safeScan(context) }, RN_GRACE_MS + 500L, TimeUnit.MILLISECONDS)
    }

    private fun safeScan(context: Context) {
        try {
            scan(context)
        } catch (e: Exception) {
            Log.w(TAG, "agent-add scan failed type=${e.javaClass.simpleName}")
        }
    }

    private fun postNotification(context: Context, text: String): Boolean {
        return try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return false
            if (!nm.areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.agent_add_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.agent_add_channel_description) }
                nm.createNotificationChannel(channel)
                if (nm.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
                    return false
                }
            }
            // The tap only opens Shelly; RN then picks the pending request up.
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return false
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            val tap = PendingIntent.getActivity(
                context,
                REQUEST_CODE,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val shown = text.redactForScouter().let { if (it.length > 200) it.take(199) + "…" else it }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID).setTimeoutAfter(MAX_AGE_MS)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
            }
            // Lock screen: title only, never the request text.
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val publicVersion = publicBuilder
                .setContentTitle(context.getString(R.string.agent_add_notification_title))
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentTitle(context.getString(R.string.agent_add_notification_title))
                .setContentText(shown)
                .setStyle(Notification.BigTextStyle().bigText(context.getString(R.string.agent_add_notification_body, shown)))
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .setContentIntent(tap)
                .setAutoCancel(true)
            nm.notify(NOTIFICATION_ID, builder.build())
            notificationShown = true
            true
        } catch (e: Exception) {
            Log.w(TAG, "agent-add notification failed type=${e.javaClass.simpleName}")
            false
        }
    }

    // ── Parsed-draft approval notification (posted by RN) ────────────────

    /**
     * Replace the "tap to review" notification with the parsed summary and
     * [Approve] [Review in Shelly] [Reject]. Called by RN
     * (lib/agent-add-flow.ts) once the in-app NL flow has produced the draft.
     *
     * - Approve is offered only when RN marked the draft remotely approvable
     *   (low-risk tier, see lib/agent-add-approval.ts) AND the device is API
     *   31+, where Notification.Action.Builder.setAuthenticationRequired(true)
     *   makes SystemUI require a device unlock before the action fires. On
     *   older releases the user taps Review in Shelly instead.
     * - Approve / Reject open shelly:///agent-add-decision?reqId&decision&nonce
     *   in Shelly; the nonce (128-bit, one per decision, single use) is
     *   checked against RN's in-memory binding, which also re-hashes the
     *   still-pending draft before registering through the normal path.
     * - VISIBILITY_PRIVATE; the lock-screen public version is title-only (the
     *   body can contain the one-time code for ChatGPT).
     */
    fun postParsedNotification(
        context: Context,
        reqId: String,
        title: String,
        body: String,
        approvable: Boolean,
        approveNonce: String,
        rejectNonce: String,
    ): Boolean {
        if (!REQ_ID_RE.matches(reqId) || !HEX_NONCE_RE.matches(rejectNonce)) return false
        val canApprove = approvable && HEX_NONCE_RE.matches(approveNonce) && Build.VERSION.SDK_INT >= 31
        return try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return false
            if (!nm.areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        context.getString(R.string.agent_add_channel_name),
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply { description = context.getString(R.string.agent_add_channel_description) }
                )
            }
            fun viewIntent(uri: String, requestCode: Int): PendingIntent {
                val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(uri))
                    .setPackage(context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                return PendingIntent.getActivity(
                    context,
                    requestCode,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            val base = "shelly:///agent-add-decision?reqId=$reqId"
            val review = viewIntent("shelly:///ai", REQUEST_CODE_REVIEW)
            val reject = viewIntent("$base&decision=reject&nonce=$rejectNonce", REQUEST_CODE_REJECT)
            @Suppress("DEPRECATION")
            fun action(label: String, pi: PendingIntent, requireAuth: Boolean): Notification.Action {
                val b = Notification.Action.Builder(null as android.graphics.drawable.Icon?, label, pi)
                if (requireAuth && Build.VERSION.SDK_INT >= 31) b.setAuthenticationRequired(true)
                return b.build()
            }
            val shownBody = body.take(1200)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID).setTimeoutAfter(MAX_AGE_MS)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
            }
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val publicVersion = publicBuilder
                .setContentTitle(context.getString(R.string.agent_add_notification_title))
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentTitle(title.take(120))
                .setContentText(shownBody.lineSequence().firstOrNull().orEmpty())
                .setStyle(Notification.BigTextStyle().bigText(shownBody))
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .setContentIntent(review)
                .setAutoCancel(true)
            if (canApprove) {
                val approve = viewIntent("$base&decision=approve&nonce=$approveNonce", REQUEST_CODE_APPROVE)
                builder.addAction(action(context.getString(R.string.agent_add_action_approve), approve, requireAuth = true))
            }
            builder.addAction(action(context.getString(R.string.agent_add_action_review), review, requireAuth = false))
            builder.addAction(action(context.getString(R.string.agent_add_action_reject), reject, requireAuth = true))
            nm.notify(NOTIFICATION_ID, builder.build())
            // This replaces the pre-parse notification; the pending-file sweep
            // in scan() must not cancel it.
            notificationShown = false
            Log.i(TAG, "agent add: parsed notification posted for $reqId (approve=$canApprove)")
            true
        } catch (e: Exception) {
            Log.w(TAG, "parsed agent-add notification failed type=${e.javaClass.simpleName}")
            false
        }
    }

    /**
     * Audit notification after an agent was approved from the ChatGPT
     * conversation (`shelly agent confirm`, lib/agent-add-flow.ts): the AI on
     * the other side could have run that command itself, so the user always
     * learns about it and can [Disable] the agent with one tap (device unlock
     * required on API 31+). Disable opens
     * shelly:///agent-add-disable?agentId&nonce (single-use nonce, RN memory).
     */
    fun postAuditNotification(context: Context, agentId: String, title: String, body: String, disableNonce: String): Boolean {
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(agentId) || !HEX_NONCE_RE.matches(disableNonce)) return false
        return try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return false
            if (!nm.areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        context.getString(R.string.agent_add_channel_name),
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply { description = context.getString(R.string.agent_add_channel_description) }
                )
            }
            fun viewIntent(uri: String, requestCode: Int): PendingIntent = PendingIntent.getActivity(
                context,
                requestCode,
                Intent(Intent.ACTION_VIEW, android.net.Uri.parse(uri)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val disable = viewIntent("shelly:///agent-add-disable?agentId=$agentId&nonce=$disableNonce", REQUEST_CODE_DISABLE)
            val review = viewIntent("shelly:///ai", REQUEST_CODE_REVIEW)
            @Suppress("DEPRECATION")
            val disableAction = Notification.Action.Builder(null as android.graphics.drawable.Icon?, context.getString(R.string.agent_add_action_disable), disable)
                .also { if (Build.VERSION.SDK_INT >= 31) it.setAuthenticationRequired(true) }
                .build()
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
            }
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val publicVersion = publicBuilder
                .setContentTitle(context.getString(R.string.agent_add_audit_public_title))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentTitle(title.take(120))
                .setContentText(body.take(300))
                .setStyle(Notification.BigTextStyle().bigText(body.take(600)))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(review)
                .setAutoCancel(true)
                .addAction(disableAction)
            nm.notify(AUDIT_NOTIFICATION_ID, builder.build())
            Log.i(TAG, "agent add: ChatGPT-approval audit notification posted for $agentId")
            true
        } catch (e: Exception) {
            Log.w(TAG, "agent-add audit notification failed type=${e.javaClass.simpleName}")
            false
        }
    }

    fun cancelNotification(context: Context) {
        runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID) }
        notificationShown = false
    }

    // ── Watcher lifecycle (process-wide singleton) ──────────────────────

    private var executor: ScheduledExecutorService? = null
    private var observer: FileObserver? = null

    /** Idempotent. Called next to ClosePawHandoff.ensureWatching from
     *  TerminalSessionService.onCreate and the Expo Module's OnCreate. */
    @Synchronized
    fun ensureWatching(context: Context) {
        if (executor != null) return
        val app = context.applicationContext
        val exec = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "ShellyAgentAddQueue").apply { isDaemon = true }
        }
        executor = exec
        try {
            val home = HomeInitializer.getHomeDir(app).also { it.mkdirs() }
            fun relevant(path: String?) = path != null && (REQUEST_FILE_RE.matches(path) || CTL_FILE_RE.matches(path))
            val obs = if (Build.VERSION.SDK_INT >= 29) {
                object : FileObserver(home, FileObserver.MOVED_TO) {
                    override fun onEvent(event: Int, path: String?) {
                        if (relevant(path)) exec.execute { safeScan(app) }
                    }
                }
            } else {
                @Suppress("DEPRECATION")
                object : FileObserver(home.absolutePath, FileObserver.MOVED_TO) {
                    override fun onEvent(event: Int, path: String?) {
                        if (relevant(path)) exec.execute { safeScan(app) }
                    }
                }
            }
            obs.startWatching()
            observer = obs
        } catch (e: Exception) {
            Log.w(TAG, "agent-add FileObserver unavailable; relying on the fallback poll", e)
        }
        val pollMs = if (observer == null) FALLBACK_POLL_MS else OBSERVED_POLL_MS
        exec.scheduleWithFixedDelay({ safeScan(app) }, 0L, pollMs, TimeUnit.MILLISECONDS)
        Log.i(TAG, "agent-add queue watcher started")
    }
}
