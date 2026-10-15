package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.terminalemulator.scouter.redactForScouter
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * Shelly approval for `shelly closepaw "<goal>"` when the Shelly-trusted
 * ClosePaw variant is installed (2026-10-14).
 *
 * With the official ClosePaw, ClosePaw's own "External Goal" dialog is the
 * consent gate and nothing here is used. The variant skips that dialog for a
 * launch carrying Shelly's caller token (ClosePawHandoff.buildIntent), so a
 * shell command — which Codex driven from the ChatGPT app can also type —
 * must not fire it directly. ClosePawHandoff.handleLine instead registers the
 * request here and fires ONLY after one of:
 *   - the notification [Approve] (setAuthenticationRequired on API 31+, i.e.
 *     device unlock; opens shelly:///closepaw-decision, RN calls back with the
 *     single-use 128-bit nonce),
 *   - an in-app dedicated chat reply naming the request ("approve <hash8>";
 *     RN posts the request as plain text in the chat; hash8 = first 8 hex of
 *     sha256 of the goal — a binding, not a secret).
 * `shelly closepaw confirm` (ChatGPT / terminal text) is REFUSED for approve
 * (user decision 2026-10-14, option 3: with the variant there is no ClosePaw
 * dialog, so approval must happen on the phone). `shelly closepaw reject`
 * still works. One approval per request — never reused.
 * Pending requests live in process memory only (nothing a same-uid process
 * could forge), expire after [TTL_MS], and are single use. The goal itself is
 * never logged.
 */
object ClosePawShellApprovals {
    private const val TAG = "ClosePawShellApprovals"
    const val TTL_MS = 10L * 60L * 1000L
    const val MAX_ATTEMPTS = 5
    const val MIN_ATTEMPT_INTERVAL_MS = 2_000L
    private const val MAX_PENDING = 5
    const val NOTIFICATION_ID = 0x37C1A020
    private const val REQUEST_CODE_APPROVE = 0x37C1A021
    private const val REQUEST_CODE_REJECT = 0x37C1A022
    private const val REQUEST_CODE_REVIEW = 0x37C1A023
    private val HASH8_RE = Regex("^[0-9a-f]{8}$")
    private val NONCE_RE = Regex("^[0-9a-f]{32}$")

    class Pending(
        val reqId: String,
        val goal: String,
        val hash8: String,
        val createdAt: Long,
        val expiresAt: Long,
        val approveNonce: String,
        val rejectNonce: String,
    ) {
        @Volatile var attempts = 0
        @Volatile var lastAttemptAt = Long.MIN_VALUE / 2
        @Volatile var consumed = false
    }

    data class Outcome(val ok: Boolean, val code: String, val message: String) {
        fun toJson(): String = JSONObject().put("ok", ok).put("code", code).put("message", message).toString()
    }

    private val pending = ConcurrentHashMap<String, Pending>()
    private val random = SecureRandom()

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private fun randomHex(n: Int): String = ByteArray(n).also { random.nextBytes(it) }.let(::hex)

    /** First 8 hex of sha256("shelly-closepaw-shell-v1\n" + sanitized goal).
     *  Mirrored by lib/closepaw-shell-approval.ts closePawShellHash8. */
    fun hash8(goal: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        return hex(md.digest(("shelly-closepaw-shell-v1\n" + ClosePawHandoff.sanitizeGoal(goal)).toByteArray(Charsets.UTF_8))).substring(0, 8)
    }

    private fun sweep(now: Long) {
        pending.entries.removeIf { (_, p) -> p.consumed || now > p.expiresAt }
    }

    fun create(context: Context, reqId: String, goal: String, now: Long = System.currentTimeMillis()): Pending {
        sweep(now)
        while (pending.size >= MAX_PENDING) {
            val oldest = pending.values.minByOrNull { it.createdAt } ?: break
            pending.remove(oldest.reqId)
            ClosePawRunResults.writeState(
                context, oldest.reqId, ClosePawRunResults.STATUS_EXPIRED,
                "shelly closepaw: the request was dropped (too many pending requests); run shelly closepaw again",
            )
        }
        val clean = ClosePawHandoff.sanitizeGoal(goal)
        val p = Pending(reqId, clean, hash8(clean), now, now + TTL_MS, randomHex(16), randomHex(16))
        pending[reqId] = p
        // Lifecycle for `shelly closepaw wait` (ClosePawRunResults).
        ClosePawRunResults.writeState(
            context, reqId, ClosePawRunResults.STATUS_PENDING_APPROVAL,
            "Waiting for the user to approve on the phone", expiresAtMs = p.expiresAt,
        )
        postNotification(context, p)
        Log.i(TAG, "closepaw approval required: $reqId goalLen=${clean.length}")
        return p
    }

    const val MSG_DEVICE_APPROVAL_REQUIRED =
        "shelly closepaw: this needs approval on the phone - approve in the Shelly notification (device unlock required) or reply in Shelly's chat; it cannot be approved from ChatGPT or the terminal"

    fun approvalRequiredMessage(p: Pending): String =
        "Shelly approval required: the Shelly-trusted ClosePaw build is installed, so ClosePaw will not ask again. " +
            "Request ${p.reqId}, goal hash ${p.hash8}. Ask the user to approve it in the Shelly notification (device unlock required) " +
            "or by replying \"approve ${p.hash8}\" in Shelly's chat. It cannot be approved from ChatGPT or the terminal " +
            "(reject: shelly closepaw reject ${p.reqId}). Expires in 10 minutes."

    /** Pending requests for RN (chat posting). No nonces. */
    fun listJson(now: Long = System.currentTimeMillis()): String {
        sweep(now)
        val arr = JSONArray()
        for (p in pending.values.sortedBy { it.createdAt }) {
            arr.put(JSONObject().put("reqId", p.reqId).put("goal", p.goal).put("hash8", p.hash8).put("expiresAt", p.expiresAt))
        }
        return arr.toString()
    }

    private fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    /**
     * Resolve a pending request. [via]: "notification" (secret = the decision's
     * nonce), "chatgpt" (secret = hash8, attempt-capped), "chat" (secret =
     * hash8 of the request shown in the chat). Approve launches ClosePaw
     * (with the caller token for the pinned variant). Single use.
     */
    @Synchronized
    fun resolve(context: Context, reqId: String, decision: String, via: String, secret: String, now: Long = System.currentTimeMillis()): Outcome {
        val p = pending[reqId] ?: return Outcome(false, "unknown", "shelly closepaw: no pending request with that id (or Shelly was restarted)")
        if (p.consumed) return Outcome(false, "used", "shelly closepaw: this request was already decided")
        if (now > p.expiresAt) {
            pending.remove(reqId)
            val msg = "shelly closepaw: the request expired (10 minutes); run shelly closepaw again"
            ClosePawRunResults.writeState(context, reqId, ClosePawRunResults.STATUS_EXPIRED, msg)
            return Outcome(false, "expired", msg)
        }
        if (decision != "approve" && decision != "reject") return Outcome(false, "invalid", "shelly closepaw: invalid decision")
        val ok = when (via) {
            "notification" -> NONCE_RE.matches(secret) &&
                constantTimeEquals(secret, if (decision == "approve") p.approveNonce else p.rejectNonce)
            "chatgpt" -> {
                // User decision (2026-10-14, option 3): with the trusted
                // variant (no ClosePaw dialog), text approval from the
                // terminal / ChatGPT is never enough — only the notification
                // Approve (device unlock) or the in-app dedicated reply.
                // Rejecting stays allowed.
                if (decision == "approve") return Outcome(false, "device-approval-required", MSG_DEVICE_APPROVAL_REQUIRED)
                true
            }
            "chat" -> HASH8_RE.matches(secret) && constantTimeEquals(secret, p.hash8)
            else -> false
        }
        if (!ok) {
            return if (via == "chatgpt") {
                Outcome(false, "hash-mismatch", "shelly closepaw confirm: the goal hash does not match the request (${MAX_ATTEMPTS - p.attempts} attempt(s) left)")
            } else {
                Outcome(false, "invalid", "shelly closepaw: approval refused")
            }
        }
        p.consumed = true
        pending.remove(reqId)
        runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID) }
        if (decision == "reject") {
            Log.i(TAG, "closepaw request $reqId rejected via $via")
            ClosePawRunResults.writeState(
                context, reqId, ClosePawRunResults.STATUS_REJECTED, "The user rejected the request; nothing was sent to ClosePaw",
            )
            return Outcome(true, "rejected", "Rejected — nothing was sent to ClosePaw.")
        }
        val outcome = try {
            // reqId: the variant's background entry reports the run's final
            // state back (ClosePawRunResults / ClosePawResultReceiver).
            when (ClosePawHandoff.launch(context.applicationContext, p.goal, p.reqId)) {
                ClosePawHandoff.Outcome.LAUNCHED -> Outcome(true, "handed-off", "Approved ($via) — handed off to ClosePaw")
                ClosePawHandoff.Outcome.NOTIFIED -> Outcome(true, "notified", "Approved ($via) — tap the ClosePaw notification to continue")
                // Variant v0.1.0-4+ background entry (ClosePawHandoff.sendVariantBroadcast).
                ClosePawHandoff.Outcome.BACKGROUND -> Outcome(true, "background", "Approved ($via) — " + ClosePawHandoff.MSG_BACKGROUND)
                ClosePawHandoff.Outcome.MAIN_DISPLAY -> Outcome(true, "main-display", "Approved ($via) — " + ClosePawHandoff.MSG_MAIN_DISPLAY)
            }.also { Log.i(TAG, "closepaw request $reqId approved via $via -> ${it.code}") }
        } catch (e: ClosePawHandoff.ClosePawRefusedException) {
            // The approval is consumed (single use); ClosePaw refused for a
            // fixable reason — tell the user what to fix, then they re-run.
            Outcome(false, e.refusal.wire, "shelly closepaw: approved, but " + e.refusal.message)
        } catch (e: Exception) {
            Outcome(false, "failed", "shelly closepaw: approved, but launching ClosePaw failed")
        }
        // Lifecycle: background / main-display runs report back; an activity
        // launch / notification hand-off has no result callback.
        val runStatus = when {
            !outcome.ok -> ClosePawRunResults.STATUS_FAILED
            outcome.code == "background" || outcome.code == "main-display" -> ClosePawRunResults.STATUS_RUNNING
            else -> ClosePawRunResults.STATUS_UNTRACKED
        }
        ClosePawRunResults.writeAfterLaunch(context, reqId, runStatus, outcome.message)
        return outcome
    }

    private fun postNotification(context: Context, p: Pending) {
        try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            if (!nm.areNotificationsEnabled()) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        ClosePawHandoff.CHANNEL_ID,
                        context.getString(R.string.closepaw_channel_name),
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply { description = context.getString(R.string.closepaw_channel_description) }
                )
            }
            fun viewIntent(uri: String, requestCode: Int): PendingIntent = PendingIntent.getActivity(
                context,
                requestCode,
                Intent(Intent.ACTION_VIEW, android.net.Uri.parse(uri)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val base = "shelly:///closepaw-decision?reqId=${p.reqId}"
            val review = viewIntent("shelly:///ai", REQUEST_CODE_REVIEW)
            @Suppress("DEPRECATION")
            fun action(label: String, pi: PendingIntent, requireAuth: Boolean): Notification.Action {
                val b = Notification.Action.Builder(null as android.graphics.drawable.Icon?, label, pi)
                if (requireAuth && Build.VERSION.SDK_INT >= 31) b.setAuthenticationRequired(true)
                return b.build()
            }
            val shown = p.goal.redactForScouter().let { if (it.length > 300) it.take(299) + "…" else it }
            val body = context.getString(R.string.closepaw_approval_body, shown, p.hash8)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, ClosePawHandoff.CHANNEL_ID).setTimeoutAfter(TTL_MS)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
            }
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, ClosePawHandoff.CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val publicVersion = publicBuilder
                .setContentTitle(context.getString(R.string.closepaw_approval_title))
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentTitle(context.getString(R.string.closepaw_approval_title))
                .setContentText(shown)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setContentIntent(review)
                .setAutoCancel(true)
            // Approve only where SystemUI can demand a device unlock (API 31+);
            // older releases approve in the app (chat OK) instead.
            if (Build.VERSION.SDK_INT >= 31) {
                builder.addAction(
                    action(context.getString(R.string.agent_add_action_approve), viewIntent("$base&decision=approve&nonce=${p.approveNonce}", REQUEST_CODE_APPROVE), true)
                )
            }
            builder.addAction(action(context.getString(R.string.agent_add_action_review), review, false))
            builder.addAction(
                action(context.getString(R.string.agent_add_action_reject), viewIntent("$base&decision=reject&nonce=${p.rejectNonce}", REQUEST_CODE_REJECT), true)
            )
            nm.notify(NOTIFICATION_ID, builder.build())
        } catch (e: Exception) {
            Log.w(TAG, "closepaw approval notification failed type=${e.javaClass.simpleName}")
        }
    }
}
