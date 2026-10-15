package expo.modules.terminalemulator

import android.app.ActivityManager
import android.app.BroadcastOptions
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.Settings
import android.util.Log
import expo.modules.terminalemulator.scouter.redactForScouter
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * ClosePaw hand-off, native owner (2026-10-13, fix/closepaw-background).
 *
 * `shelly closepaw "<goal>"` (SHELLY_HELPER_SHIM v11+, HomeInitializer.kt)
 * writes ONE request file per hand-off, `$HOME/.shelly-closepaw-req-<reqId>`
 * (written to `<name>.tmp`, then renamed into place, so the drain only ever
 * sees a complete record), containing exactly one newline-terminated line:
 *
 *   closepaw:<reqId>:<tsMs>:<encodeURIComponent(goal)>
 *
 * Shim v9/v10 appended that line to the shared `$HOME/.shelly-closepaw-queue`
 * instead; that legacy file is still drained (complete lines only) for
 * compatibility, but an append racing the claim-rename could be lost there,
 * which is why v11 moved to per-request files.
 *
 * Before this fix the line rode the shared `.shelly-command-queue`, which only
 * the RN JS thread drains (app/_layout.tsx, 250ms poll). With Shelly in the
 * background (e.g. the ChatGPT app drives Codex via `codex remote-control`
 * hosted in a Shelly tab) the JS poll does not run and the shim timed out
 * with "the Shelly app did not respond". This object is now the SINGLE owner
 * of ClosePaw queue lines: it is started from both TerminalSessionService
 * (alive whenever a terminal session exists) and the Expo Module, watches the
 * directory with a FileObserver plus a fallback poll (1s only if the observer
 * could not start, else 5s), claims each request file by reading and deleting
 * it (a request is processed at most once: per-reqId dedupe below), validates
 * exactly like lib/closepaw-queue.ts's
 * parseClosePawQueueLine, and writes `$HOME/.shelly-closepaw-result-<reqId>.json`
 * for the shim. A legacy line that still reaches RN's command queue is
 * forwarded here via TerminalEmulatorModule.handOffClosePawQueueLine, never
 * fired by RN itself.
 *
 * Background activity launch (BAL): a foreground service does NOT grant BAL
 * on Android 10+, and a blocked startActivity() fails SILENTLY (no exception),
 * so we cannot "try and detect". We start ClosePaw directly only when it is
 * provably allowed — Shelly is the foreground app (process importance
 * FOREGROUND; merely VISIBLE, e.g. behind a dialog or in a non-focused
 * window, is not treated as safe) or holds SYSTEM_ALERT_WINDOW — and otherwise post a
 * high-importance notification whose content PendingIntent launches ClosePaw
 * with the goal. That PendingIntent is sent by SystemUI on the user's tap,
 * and the notification-tap launch is allowed by the SENDER's privileges; we
 * deliberately do NOT opt the CREATOR (Shelly, backgrounded, has none to
 * give) into BAL via ActivityOptions.setPendingIntentCreatorBackgroundActivityStartMode,
 * which on targetSdk 34+ is off by default and is the least-privilege choice.
 *
 * Consent is unchanged: ClosePaw's own release-build "External Goal" Run
 * dialog is the gate; Shelly only hands over the sanitized goal.
 */
object ClosePawHandoff {
    private const val TAG = "ClosePawHandoff"

    // Mirrors lib/agent-intent-review.ts CLOSEPAW_* and lib/closepaw-queue.ts.
    const val PACKAGE = "ai.closepaw"
    const val ACTIVITY = "ai.closepaw.app.MainActivity"
    const val EXTRA_GOAL = "goal"
    const val NOT_INSTALLED_MARKER = "CLOSEPAW_NOT_INSTALLED"
    const val BACKGROUND_BLOCKED_MARKER = "CLOSEPAW_BACKGROUND_BLOCKED"

    /** Legacy (shim v9/v10) shared append queue; still drained. */
    const val QUEUE_FILE = ".shelly-closepaw-queue"
    private const val CLAIMED_SUFFIX = ".draining"
    /** Shim v11+: one complete request per file, `<prefix><reqId>`. */
    const val REQUEST_FILE_PREFIX = ".shelly-closepaw-req-"
    private const val TMP_SUFFIX = ".tmp"
    private val REQUEST_FILE_RE = Regex("^\\.shelly-closepaw-req-[0-9]{10,16}-[0-9a-f]{8}$")
    /** A shim that died between write and rename leaves `<name>.tmp`. */
    private const val STALE_TMP_MS = 60_000L
    const val QUEUE_PREFIX = "closepaw:"
    const val QUEUE_MAX_AGE_MS = 30_000L
    const val QUEUE_MAX_FUTURE_MS = 5_000L
    const val QUEUE_MIN_INTERVAL_MS = 5_000L
    const val QUEUE_MAX_ENCODED_CHARS = 24_000
    /** A queue file larger than this is junk (each line is < 24KB and lines
     *  are consumed within 1s); it is discarded unread. */
    private const val QUEUE_MAX_FILE_BYTES = 256L * 1024L

    const val MSG_HANDED_OFF = "Handed off to ClosePaw — confirm Run in ClosePaw"
    const val MSG_NOTIFIED = "Shelly is in the background — tap the ClosePaw notification to continue"
    const val MSG_NOT_INSTALLED = "ClosePaw is not installed"
    const val MSG_BACKGROUND_BLOCKED = "shelly closepaw: Shelly is in the background and its notifications are off — open Shelly and run the command again"

    private val REQ_ID_RE = Regex("^[0-9]{10,16}-[0-9a-f]{8}$")
    private val TS_RE = Regex("^[0-9]{10,16}$")

    private const val GOAL_MAX_CODE_POINTS = 2000
    private val CONTROL_RE = Regex("[\\u0000-\\u001F\\u007F-\\u009F]")
    private val SPACE_RUN_RE = Regex(" {2,}")
    private val EDGE_SPACE_RE = Regex("^ +| +$")
    private val TRAILING_SPACE_RE = Regex(" +$")

    const val CHANNEL_ID = "closepaw_handoff"
    // Outside every NotificationDispatcher range (9201-9950, 0x31/0x35xxxxxx)
    // and TerminalSessionService's 7734. One stable id: a newer hand-off
    // replaces an older, unanswered one instead of stacking.
    const val NOTIFICATION_ID = 0x37C1A000
    private const val REQUEST_CODE = 0x37C1A001
    private const val NOTIFICATION_TIMEOUT_MS = 10L * 60L * 1000L
    /** Fallback poll when the FileObserver could not be started. */
    private const val FALLBACK_POLL_MS = 1_000L
    /** Safety-net poll when the FileObserver is running (missed events only). */
    private const val OBSERVED_POLL_MS = 5_000L

    /** Byte-identical port of lib/agent-intent-review.ts sanitizeClosePawGoal. */
    fun sanitizeGoal(raw: String?): String {
        val collapsed = (raw ?: "")
            .replace(CONTROL_RE, " ")
            .replace(SPACE_RUN_RE, " ")
            .replace(EDGE_SPACE_RE, "")
        val count = collapsed.codePointCount(0, collapsed.length)
        if (count <= GOAL_MAX_CODE_POINTS) return collapsed
        val end = collapsed.offsetByCodePoints(0, GOAL_MAX_CODE_POINTS)
        return collapsed.substring(0, end).replace(TRAILING_SPACE_RE, "")
    }

    /**
     * Constant instruction prepended to every goal handed to ClosePaw
     * (mirrored by lib/agent-intent-review.ts CLOSEPAW_GOAL_PREFIX). In
     * ClosePaw's Virtual Display mode the VD "home" is Samsung DeX's
     * launcher, and its LLM tapped launcher icons instead of calling its
     * open_app tool, wandering into Samsung Finder / the Google app and
     * failing; with this prefix it used open_app (2/2 on-device). It is a
     * fixed string, never user-controlled; the user-reviewed/approved goal is
     * the text after "Task: ".
     */
    const val GOAL_PREFIX = "Use the open_app tool to open apps (do not tap launcher icons). Task: "

    /** The exact extra sent to ClosePaw: [GOAL_PREFIX] + the sanitized goal,
     *  the goal trimmed so the whole string stays within
     *  [GOAL_MAX_CODE_POINTS]. Applied AFTER sanitization. */
    fun wireGoal(goal: String?): String {
        val clean = sanitizeGoal(goal)
        val budget = GOAL_MAX_CODE_POINTS - GOAL_PREFIX.codePointCount(0, GOAL_PREFIX.length)
        val fitted = if (clean.codePointCount(0, clean.length) <= budget) {
            clean
        } else {
            clean.substring(0, clean.offsetByCodePoints(0, budget)).replace(TRAILING_SPACE_RE, "")
        }
        return GOAL_PREFIX + fitted
    }

    // ── Shelly-trusted ClosePaw variant (2026-10-14) ──────────────────────
    // The user's own ClosePaw build (fork RYOITABASHI/closepaw, branch
    // shelly-trusted-caller) skips ClosePaw's "External Goal" dialog when the
    // launch intent carries EXTRA_CALLER_TOKEN: a PendingIntent whose
    // creatorPackage is dev.shelly.terminal (Android vouches for the creator,
    // so the extra cannot be forged by another app). Shelly attaches it ONLY
    // when the installed ai.closepaw is signed by the variant's pinned
    // certificate — the official ClosePaw never receives the token and keeps
    // its own dialog. With the variant, Shelly's approval is the only gate,
    // so every path that fires it must have passed one: agent runs (Review or
    // a sealed registration pre-approval) and `shelly closepaw` (see
    // ClosePawShellApprovals — approval required before launch).
    const val EXTRA_CALLER_TOKEN = "shelly_caller_token"
    const val CALLER_TOKEN_ACTION = "dev.shelly.terminal.CLOSEPAW_TOKEN"
    /** SHA-256 of the variant's signing certificate (pinned). */
    const val VARIANT_CERT_SHA256 = "D5:F4:39:23:A8:F6:0E:D3:41:82:02:DB:8D:77:47:11:0B:F6:91:47:99:54:DB:9B:31:E1:AC:FC:F2:74:72:58"

    internal fun hexColonToBytes(hex: String): ByteArray =
        hex.split(':').map { it.toInt(16).toByte() }.toByteArray()

    /** True only when the installed ai.closepaw is signed by the pinned
     *  variant certificate (API 28+; older releases never get the token). */
    fun isTrustedVariantInstalled(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        return runCatching {
            context.packageManager.hasSigningCertificate(
                PACKAGE,
                hexColonToBytes(VARIANT_CERT_SHA256),
                android.content.pm.PackageManager.CERT_INPUT_SHA256,
            )
        }.getOrDefault(false)
    }

    private fun callerToken(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            0,
            Intent(CALLER_TOKEN_ACTION).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE,
        )

    /** Explicit-component intent to ai.closepaw. With a [context] and the
     *  pinned variant installed, it also carries the caller token. */
    fun buildIntent(goal: String, context: Context? = null): Intent = Intent().apply {
        component = ComponentName(PACKAGE, ACTIVITY)
        putExtra(EXTRA_GOAL, wireGoal(goal))
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (context != null && isTrustedVariantInstalled(context)) {
            putExtra(EXTRA_CALLER_TOKEN, callerToken(context.applicationContext))
        }
    }

    // ── Background entry of the Shelly-trusted variant (v0.1.0-4+) ────────
    // The variant (fork RYOITABASHI/closepaw, release shelly-v0.1.0-4) exports
    // a non-UI receiver: an explicit ORDERED broadcast carrying the goal and
    // the caller token makes ClosePaw run the task on its Shizuku virtual
    // display WITHOUT bringing its activity to the front. A broadcast to an
    // explicit manifest component is allowed from the background, so no BAL
    // notification is needed on this path. ClosePaw answers with a result
    // code; 0 (the initial code, untouched) means no receiver answered (an
    // older ClosePaw / variant) and we fall back to the activity launch.
    const val VARIANT_GOAL_ACTION = "ai.closepaw.action.SHELLY_RUN_GOAL"
    const val VARIANT_GOAL_RECEIVER = "ai.closepaw.app.ShellyGoalReceiver"
    /** Contract extra (default false). Shelly NEVER sends it: a hand-off must
     *  not take over the user's screen unexpectedly (ClosePaw also ignores it
     *  unless a ClosePaw-side setting allows it). */
    const val EXTRA_ALLOW_MAIN_DISPLAY = "allow_main_display"
    const val VARIANT_BROADCAST_TIMEOUT_MS = 5_000L
    /** Result-callback correlation (feat/closepaw-result-wait): Shelly's request id and a
     *  per-run nonce ClosePaw echoes back to ClosePawResultReceiver. Only sent for a
     *  `shelly closepaw` request; see ClosePawRunResults. */
    const val EXTRA_SHELLY_REQ_ID = ClosePawRunResults.EXTRA_REQ_ID
    const val EXTRA_SHELLY_RESULT_NONCE = ClosePawRunResults.EXTRA_RESULT_NONCE
    const val REFUSED_MARKER_PREFIX = "CLOSEPAW_REFUSED:"

    /** Result codes ClosePaw's ShellyGoalReceiver sets. */
    const val RC_NO_RESPONSE = 0
    const val RC_STARTED_VIRTUAL_DISPLAY = 1
    const val RC_STARTED_MAIN_DISPLAY = 2

    /** Refusals (codes 10-16). Messages are the user-facing English text for
     *  the shim / agent run result; RN localizes by [wire]
     *  (lib/closepaw-background.ts, kept in lockstep). */
    enum class Refusal(val resultCode: Int, val wire: String, val message: String) {
        UNTRUSTED(10, "untrusted", "ClosePaw did not accept Shelly's request (untrusted or invalid) - update ClosePaw and Shelly, then retry"),
        ACCESSIBILITY_OFF(11, "accessibility-off", "ClosePaw's accessibility service is off - turn it on in Android Settings > Accessibility > ClosePaw, then retry"),
        ONBOARDING_INCOMPLETE(12, "onboarding-incomplete", "ClosePaw's setup is not finished - open ClosePaw once and complete it, then retry"),
        OVERLAY_MISSING(13, "overlay-missing", "ClosePaw needs the \"Display over other apps\" permission - grant it in ClosePaw, then retry"),
        NO_CREDENTIALS(14, "no-credentials", "ClosePaw has no AI credentials - sign in or add an API key in ClosePaw, then retry"),
        BUSY(15, "busy", "ClosePaw is busy with another task - wait for it to finish, then retry"),
        VD_UNAVAILABLE(16, "vd-unavailable", "ClosePaw's virtual display is unavailable - start Shizuku, then retry");

        companion object {
            fun fromCode(code: Int): Refusal? = values().firstOrNull { it.resultCode == code }
        }
    }

    class ClosePawRefusedException(val refusal: Refusal) : IllegalStateException(REFUSED_MARKER_PREFIX + refusal.wire)

    sealed class VariantResult {
        data class Started(val outcome: Outcome) : VariantResult()
        data class Refused(val refusal: Refusal) : VariantResult()
        /** 0 / unknown code / timeout: fall back to the activity launch. */
        object NoResponse : VariantResult()
    }

    /** Pure mapping of ClosePaw's result code (unit-tested by source). */
    fun mapVariantResultCode(code: Int): VariantResult = when (code) {
        RC_STARTED_VIRTUAL_DISPLAY -> VariantResult.Started(Outcome.BACKGROUND)
        RC_STARTED_MAIN_DISPLAY -> VariantResult.Started(Outcome.MAIN_DISPLAY)
        else -> Refusal.fromCode(code)?.let { VariantResult.Refused(it) } ?: VariantResult.NoResponse
    }

    /** The goal broadcast. Never carries [EXTRA_ALLOW_MAIN_DISPLAY]. With a
     *  [reqId] + [resultNonce] the variant reports the run's final state back. */
    internal fun buildVariantBroadcast(
        context: Context,
        goal: String,
        reqId: String? = null,
        resultNonce: String? = null,
    ): Intent =
        Intent(VARIANT_GOAL_ACTION).apply {
            component = ComponentName(PACKAGE, VARIANT_GOAL_RECEIVER)
            putExtra(EXTRA_GOAL, wireGoal(goal))
            putExtra(EXTRA_CALLER_TOKEN, callerToken(context.applicationContext))
            if (reqId != null && resultNonce != null) {
                putExtra(EXTRA_SHELLY_REQ_ID, reqId)
                putExtra(EXTRA_SHELLY_RESULT_NONCE, resultNonce)
            }
            // Deliver promptly (foreground broadcast queue) and even if
            // ClosePaw has not been launched since install / force-stop.
            addFlags(Intent.FLAG_RECEIVER_FOREGROUND or Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
        }

    private val resultThread: HandlerThread by lazy {
        HandlerThread("ShellyClosePawResult").apply { start() }
    }

    /**
     * Send the goal broadcast to the variant and wait (≤ [VARIANT_BROADCAST_TIMEOUT_MS])
     * for its result. The result receiver runs on a dedicated HandlerThread,
     * so this blocks only the caller (never called on the main thread — see
     * launch()). On API 34+ the broadcast shares Shelly's identity
     * (BroadcastOptions.setShareIdentityEnabled) — the variant's receiver
     * requires the sender identity there.
     */
    private fun sendVariantBroadcast(
        context: Context,
        goal: String,
        reqId: String? = null,
        resultNonce: String? = null,
    ): VariantResult {
        val intent = buildVariantBroadcast(context, goal, reqId, resultNonce)
        val latch = CountDownLatch(1)
        val timedOut = AtomicBoolean(false)
        var code = RC_NO_RESPONSE
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val rc = resultCode
                if (timedOut.get()) {
                    // Arrived after we already fell back to the activity
                    // launch; ClosePaw's own single-task guard (code 15)
                    // is what prevents a second run.
                    Log.w(TAG, "late ClosePaw broadcast result rc=$rc (after timeout)")
                    return
                }
                code = rc
                latch.countDown()
            }
        }
        val scheduler = Handler(resultThread.looper)
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                val opts = BroadcastOptions.makeBasic().apply { setShareIdentityEnabled(true) }.toBundle()
                context.sendOrderedBroadcast(intent, null, opts, receiver, scheduler, RC_NO_RESPONSE, null, null)
            } else {
                context.sendOrderedBroadcast(intent, null, receiver, scheduler, RC_NO_RESPONSE, null, null)
            }
        } catch (e: Exception) {
            Log.w(TAG, "ClosePaw goal broadcast failed type=${e.javaClass.simpleName}; falling back to activity launch")
            return VariantResult.NoResponse
        }
        val answered = latch.await(VARIANT_BROADCAST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        if (!answered) {
            timedOut.set(true)
            Log.w(TAG, "ClosePaw goal broadcast: no result within ${VARIANT_BROADCAST_TIMEOUT_MS}ms; falling back to activity launch")
            return VariantResult.NoResponse
        }
        Log.i(TAG, "ClosePaw goal broadcast rc=$code goalLen=${goal.length}")
        return mapVariantResultCode(code)
    }

    enum class Outcome(val wire: String) {
        LAUNCHED("launched"),
        NOTIFIED("notified"),
        /** Variant broadcast rc=1: running on ClosePaw's virtual display. */
        BACKGROUND("background"),
        /** Variant broadcast rc=2: ClosePaw is driving the main display. */
        MAIN_DISPLAY("main-display"),
    }

    const val MSG_BACKGROUND = "Handed off - ClosePaw is working in the background; you can keep using your phone (avoid the app it's using)"
    const val MSG_MAIN_DISPLAY = "Handed off - ClosePaw is controlling the screen"

    /**
     * Hand [goal] to ClosePaw: direct start when BAL is provably allowed,
     * else the tap-to-continue notification. Throws ActivityNotFoundException
     * (message [NOT_INSTALLED_MARKER]) when ClosePaw is missing and
     * IllegalStateException ([BACKGROUND_BLOCKED_MARKER]) when neither route
     * is available. Shared by the shell queue and fireAgentIntent('closepaw').
     *
     * [shellyReqId] (a `shelly closepaw` request id, approved by the user)
     * asks the variant for a result callback: a nonce is registered with
     * ClosePawRunResults and sent along with the id. Only the background
     * entry carries it; an activity launch never reports a result.
     */
    fun launch(context: Context, goal: String, shellyReqId: String? = null): Outcome {
        val clean = sanitizeGoal(goal)
        require(clean.isNotEmpty()) { "closepaw goal is empty" }
        // Shelly-trusted variant v0.1.0-4+: background entry first (no
        // activity start, so no BAL rules / notification fallback). Waiting
        // for the ordered result blocks, so never on the main thread (every
        // current caller is off it: Expo AsyncFunction queue, queue executor).
        if (isTrustedVariantInstalled(context) && Looper.myLooper() != Looper.getMainLooper()) {
            val reqId = shellyReqId?.takeIf { ClosePawRunResults.isReqId(it) }
            // Registered BEFORE sending, so even a very fast result is matched.
            val nonce = reqId?.let { ClosePawRunResults.register(it) }
            when (val r = sendVariantBroadcast(context, clean, reqId, nonce)) {
                is VariantResult.Started -> {
                    recordOutcome(context, r.outcome.wire, if (r.outcome == Outcome.MAIN_DISPLAY) MSG_MAIN_DISPLAY else MSG_BACKGROUND)
                    return r.outcome
                }
                is VariantResult.Refused -> {
                    ClosePawRunResults.forget(reqId)
                    recordOutcome(context, r.refusal.wire, r.refusal.message)
                    throw ClosePawRefusedException(r.refusal)
                }
                // Older ClosePaw: activity path below. The nonce stays
                // registered (it expires on its own): a variant whose ordered
                // result merely arrived late may still report the run.
                VariantResult.NoResponse -> Unit
            }
        }
        // Every caller of launch() has passed a Shelly approval (agent run
        // Review / sealed pre-approval, or ClosePawShellApprovals for the
        // shell command), so the caller token may ride along for the variant.
        val intent = buildIntent(clean, context)
        if (intent.resolveActivity(context.packageManager) == null) {
            throw ActivityNotFoundException(NOT_INSTALLED_MARKER)
        }
        if (canStartActivityNow(context)) {
            try {
                context.startActivity(intent)
                // Never log the goal itself (free text) — length only.
                Log.i(TAG, "launched ClosePaw directly goalLen=${clean.length}")
                recordOutcome(context, Outcome.LAUNCHED.wire, MSG_HANDED_OFF)
                return Outcome.LAUNCHED
            } catch (e: Exception) {
                Log.w(TAG, "direct start failed type=${e.javaClass.simpleName}; falling back to notification")
            }
        }
        // Security-review fix: never park the caller token inside a
        // notification for a later tap — the package behind ai.closepaw could
        // change between post and tap. For the trusted variant the tap opens
        // Shelly (shelly:///closepaw-launch?nonce=…), which re-runs launch()
        // and therefore re-checks the certificate at tap time.
        val tapIntent = if (intent.hasExtra(EXTRA_CALLER_TOKEN)) {
            val nonce = registerDeferredLaunch(clean)
            Intent(Intent.ACTION_VIEW, android.net.Uri.parse("shelly:///closepaw-launch?nonce=$nonce"))
                .setPackage(context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
            intent
        }
        if (!postHandoffNotification(context, clean, tapIntent)) {
            throw IllegalStateException(BACKGROUND_BLOCKED_MARKER)
        }
        Log.i(TAG, "posted ClosePaw hand-off notification goalLen=${clean.length}")
        recordOutcome(context, Outcome.NOTIFIED.wire, MSG_NOTIFIED)
        return Outcome.NOTIFIED
    }

    /** Last hand-off outcome, `$HOME/.shelly-closepaw-outcome.json`
     *  ({code, message, tsSec}). The agent run script / PlanSpec executor read
     *  it (if fresh) right after RN's Review accept so the run result says
     *  what actually happened (background / main display / refusal) instead
     *  of a generic "handed off". Contains no goal text. */
    const val OUTCOME_FILE = ".shelly-closepaw-outcome.json"

    internal fun recordOutcome(context: Context, code: String, message: String) {
        try {
            val home = HomeInitializer.getHomeDir(context)
            val tmp = File(home, "$OUTCOME_FILE.tmp")
            tmp.writeText(
                JSONObject()
                    .put("code", code)
                    .put("message", message)
                    // String: the run script's json_field_file reads strings only.
                    .put("tsSec", (System.currentTimeMillis() / 1000L).toString())
                    .toString()
            )
            val target = File(home, OUTCOME_FILE)
            if (!tmp.renameTo(target)) {
                target.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to record closepaw outcome type=${e.javaClass.simpleName}")
        }
    }

    // ── Deferred (tap-to-continue) launches for the trusted variant ──────
    private class DeferredLaunch(val goal: String, val expiresAt: Long)
    private val deferredLaunches = java.util.concurrent.ConcurrentHashMap<String, DeferredLaunch>()
    private val nonceRandom = java.security.SecureRandom()

    private fun registerDeferredLaunch(goal: String): String {
        val now = System.currentTimeMillis()
        deferredLaunches.entries.removeIf { it.value.expiresAt < now }
        val nonce = ByteArray(16).also { nonceRandom.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        deferredLaunches[nonce] = DeferredLaunch(goal, now + NOTIFICATION_TIMEOUT_MS)
        return nonce
    }

    /** Tap on a deferred hand-off notification (RN deep link). Single use;
     *  re-runs launch(), which re-checks the variant certificate NOW. */
    fun launchDeferred(context: Context, nonce: String): String {
        if (!Regex("^[0-9a-f]{32}$").matches(nonce)) return "invalid"
        val d = deferredLaunches.remove(nonce) ?: return "unknown"
        if (d.expiresAt < System.currentTimeMillis()) return "expired"
        return try {
            launch(context.applicationContext, d.goal).wire
        } catch (e: Exception) {
            "failed"
        }
    }

    /** True only when Android provably lets this process start an activity
     *  right now: Shelly is the foreground (top, focused) app, or holds the
     *  overlay (SYSTEM_ALERT_WINDOW) grant. IMPORTANCE_VISIBLE alone (a
     *  window shown but not on top, e.g. split screen / behind another
     *  activity) is NOT trusted — such a start can be silently blocked, and
     *  the shim would then falsely print "Handed off"; it takes the
     *  notification route instead. A foreground service alone (importance
     *  125) is NOT enough either. */
    internal fun canStartActivityNow(context: Context): Boolean {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        if (state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return true
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            runCatching { Settings.canDrawOverlays(context) }.getOrDefault(false)
    }

    private fun postHandoffNotification(context: Context, goal: String, intent: Intent): Boolean {
        return try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return false
            if (!nm.areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.closepaw_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.closepaw_channel_description) }
                nm.createNotificationChannel(channel)
                if (nm.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
                    return false
                }
            }
            // Immutable + one-shot: the tap fires exactly this goal once.
            // Sent by SystemUI on the user's tap (sender-side BAL); no creator
            // BAL opt-in (see the object doc).
            val tap = PendingIntent.getActivity(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
            )
            val shown = goal.redactForScouter().let { if (it.length > 200) it.take(199) + "…" else it }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID).setTimeoutAfter(NOTIFICATION_TIMEOUT_MS)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
            }
            // Lock screen: only the title, never the goal text (free text may
            // be sensitive). The full version stays VISIBILITY_PRIVATE.
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val publicVersion = publicBuilder
                .setContentTitle(context.getString(R.string.closepaw_notification_title))
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentTitle(context.getString(R.string.closepaw_notification_title))
                .setContentText(shown)
                .setStyle(
                    Notification.BigTextStyle().bigText(
                        context.getString(R.string.closepaw_notification_body, shown)
                    )
                )
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setContentIntent(tap)
                .setAutoCancel(true)
            nm.notify(NOTIFICATION_ID, builder.build())
            true
        } catch (e: Exception) {
            Log.w(TAG, "hand-off notification failed type=${e.javaClass.simpleName}")
            false
        }
    }

    // ── Queue (shell → native) ───────────────────────────────────────────

    sealed class Parsed {
        data class Ok(val reqId: String, val goal: String) : Parsed()
        data class Bad(val reqId: String?, val reason: String) : Parsed()
    }

    /** Port of lib/closepaw-queue.ts parseClosePawQueueLine. Never throws. */
    fun parseLine(line: String, nowMs: Long): Parsed {
        if (!line.startsWith(QUEUE_PREFIX)) return Parsed.Bad(null, "malformed")
        val parts = line.substring(QUEUE_PREFIX.length).split(':')
        if (parts.size != 3) return Parsed.Bad(null, "malformed")
        val (reqIdRaw, tsRaw, encoded) = parts
        val reqId = if (REQ_ID_RE.matches(reqIdRaw)) reqIdRaw else null
        if (reqId == null || !TS_RE.matches(tsRaw) || encoded.length > QUEUE_MAX_ENCODED_CHARS) {
            return Parsed.Bad(reqId, "malformed")
        }
        val ts = tsRaw.toLongOrNull() ?: return Parsed.Bad(reqId, "stale")
        if (nowMs - ts > QUEUE_MAX_AGE_MS || ts - nowMs > QUEUE_MAX_FUTURE_MS) return Parsed.Bad(reqId, "stale")
        val decoded = decodeUriComponent(encoded) ?: return Parsed.Bad(reqId, "malformed")
        val goal = sanitizeGoal(decoded)
        if (goal.isEmpty()) return Parsed.Bad(reqId, "empty-goal")
        return Parsed.Ok(reqId, goal)
    }

    /** Strict JS decodeURIComponent: '+' stays '+', malformed escapes or
     *  invalid UTF-8 → null (JS throws URIError). */
    internal fun decodeUriComponent(s: String): String? {
        val out = StringBuilder(s.length)
        val bytes = ByteArrayOutputStream()
        fun flush(): Boolean {
            if (bytes.size() == 0) return true
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            return try {
                out.append(decoder.decode(ByteBuffer.wrap(bytes.toByteArray())))
                bytes.reset()
                true
            } catch (e: CharacterCodingException) {
                false
            }
        }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                bytes.write((hi shl 4) or lo)
                i += 3
            } else {
                if (!flush()) return null
                out.append(c)
                i++
            }
        }
        return if (flush()) out.toString() else null
    }

    data class Result(val ok: Boolean, val code: String, val message: String)

    /** Shim / CLI answer for a successful [launch]. */
    fun resultFor(outcome: Outcome): Result = when (outcome) {
        Outcome.LAUNCHED -> Result(true, "handed-off", MSG_HANDED_OFF)
        Outcome.NOTIFIED -> Result(true, "notified", MSG_NOTIFIED)
        Outcome.BACKGROUND -> Result(true, "background", MSG_BACKGROUND)
        Outcome.MAIN_DISPLAY -> Result(true, "main-display", MSG_MAIN_DISPLAY)
    }

    @Volatile private var lastFireAtMs = Long.MIN_VALUE / 2
    private val recentReqIds = LinkedHashSet<String>()

    /** Validate + rate-limit + launch one line, then answer the shim.
     *  Returns null for a line too malformed to answer, or a duplicate. */
    @Synchronized
    fun handleLine(context: Context, line: String, nowMs: Long = System.currentTimeMillis()): Result? {
        val parsed = parseLine(line.trim(), nowMs)
        val reqId = when (parsed) {
            is Parsed.Ok -> parsed.reqId
            is Parsed.Bad -> parsed.reqId
        }
        if (reqId == null) {
            Log.w(TAG, "rejected malformed queue line")
            return null
        }
        // At most once per request id (within the last 64), even if a record
        // were ever delivered twice. Delivery itself is not guaranteed: a
        // legacy shared-queue line can be lost (see drain), and the shim then
        // times out and reports that Shelly did not respond.
        if (!recentReqIds.add(reqId)) return null
        while (recentReqIds.size > 64) recentReqIds.remove(recentReqIds.first())
        val result = when (parsed) {
            is Parsed.Bad -> when (parsed.reason) {
                "stale" -> Result(false, "stale", "ClosePaw hand-off request expired (older than 30s); nothing was sent")
                "empty-goal" -> Result(false, "invalid", "shelly closepaw: the goal is empty")
                else -> Result(false, "invalid", "shelly closepaw: malformed request")
            }
            is Parsed.Ok -> if (nowMs - lastFireAtMs < QUEUE_MIN_INTERVAL_MS) {
                Result(false, "rate-limited", "shelly closepaw: rate-limited (at most one hand-off every 5 seconds); try again shortly")
            } else if (isTrustedVariantInstalled(context.applicationContext)) {
                // The Shelly-trusted variant skips ClosePaw's own dialog, so
                // the shell command (typed by the user OR by Codex driven from
                // ChatGPT) must get a Shelly approval first — nothing fires
                // here. See ClosePawShellApprovals.
                lastFireAtMs = nowMs
                val pending = ClosePawShellApprovals.create(context.applicationContext, parsed.reqId, parsed.goal, nowMs)
                Result(true, "approval-required", ClosePawShellApprovals.approvalRequiredMessage(pending))
            } else {
                lastFireAtMs = nowMs
                try {
                    resultFor(launch(context.applicationContext, parsed.goal))
                } catch (e: ClosePawRefusedException) {
                    Result(false, e.refusal.wire, "shelly closepaw: " + e.refusal.message)
                } catch (e: ActivityNotFoundException) {
                    if (e.message == NOT_INSTALLED_MARKER) Result(false, "not-installed", MSG_NOT_INSTALLED)
                    else Result(false, "failed", "shelly closepaw: failed to launch ClosePaw")
                } catch (e: IllegalStateException) {
                    if (e.message == BACKGROUND_BLOCKED_MARKER) Result(false, "background-blocked", MSG_BACKGROUND_BLOCKED)
                    else Result(false, "failed", "shelly closepaw: failed to launch ClosePaw")
                } catch (e: Exception) {
                    Result(false, "failed", "shelly closepaw: failed to launch ClosePaw")
                }
            }
        }
        Log.i(TAG, "closepaw: $reqId -> ${result.code}")
        // Lifecycle for `shelly closepaw wait` (ClosePawRunResults). The
        // approval path wrote pending-approval in ClosePawShellApprovals.create;
        // every other answer is final here: a direct hand-off (official
        // ClosePaw / no variant) has no result callback.
        if (result.code != "approval-required") {
            ClosePawRunResults.writeState(
                context,
                reqId,
                if (result.ok) ClosePawRunResults.STATUS_UNTRACKED else ClosePawRunResults.STATUS_FAILED,
                result.message,
            )
        }
        writeResult(context, reqId, result)
        return result
    }

    private fun writeResult(context: Context, reqId: String, result: Result) {
        try {
            val home = HomeInitializer.getHomeDir(context)
            val target = File(home, ".shelly-closepaw-result-$reqId.json")
            val tmp = File(home, ".shelly-closepaw-result-$reqId.json.tmp")
            tmp.writeText(
                JSONObject()
                    .put("ok", result.ok)
                    .put("code", result.code)
                    .put("message", result.message)
                    .toString()
            )
            if (!tmp.renameTo(target)) {
                target.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to write closepaw result type=${e.javaClass.simpleName}")
        }
    }

    /** Newline-terminated records only: a trailing fragment without '\n' is
     *  an incomplete write and is dropped, never handled. */
    internal fun completeLines(content: String): List<String> {
        val end = content.lastIndexOf('\n')
        if (end < 0) return emptyList()
        return content.substring(0, end).split('\n').filter { it.isNotBlank() }
    }

    private fun handleAll(context: Context, lines: List<String>) {
        for (line in lines) {
            try {
                handleLine(context, line)
            } catch (e: Exception) {
                Log.w(TAG, "closepaw line handler failed type=${e.javaClass.simpleName}")
            }
        }
    }

    private fun readAndDelete(file: File): String = try {
        if (file.length() > QUEUE_MAX_FILE_BYTES) "" else file.readText()
    } catch (e: Exception) {
        ""
    } finally {
        file.delete()
    }

    internal fun isRequestFileName(name: String?): Boolean = name != null && REQUEST_FILE_RE.matches(name)

    private fun hasPending(home: File): Boolean =
        File(home, QUEUE_FILE).exists() ||
            File(home, QUEUE_FILE + CLAIMED_SUFFIX).exists() ||
            (home.list()?.any { isRequestFileName(it) } ?: false)

    /** Process every complete per-request file (shim v11+), then the legacy
     *  shared queue (shim v9/v10). Each request file is complete by
     *  construction (tmp + rename) and holds exactly one record; it is read
     *  and deleted before handling, and handleLine dedupes by reqId, so a
     *  request fires at most once. */
    @Synchronized
    fun drain(context: Context) {
        val home = try { HomeInitializer.getHomeDir(context) } catch (e: Exception) { return }
        val now = System.currentTimeMillis()
        val names = home.list()?.sorted() ?: emptyList()
        for (name in names) {
            if (isRequestFileName(name)) {
                val lines = completeLines(readAndDelete(File(home, name)))
                // One record per file; anything else is malformed.
                if (lines.size == 1) handleAll(context, lines)
                else Log.w(TAG, "rejected closepaw request file with ${lines.size} records")
            } else if (name.startsWith(REQUEST_FILE_PREFIX) && name.endsWith(TMP_SUFFIX)) {
                val tmp = File(home, name)
                if (now - tmp.lastModified() > STALE_TMP_MS) tmp.delete()
            }
        }

        // Legacy shared queue. Claim it with an atomic rename. NOTE: an
        // append whose open() preceded the rename but whose write() follows
        // it lands in the claimed (then deleted) file and is lost -- the
        // reason shim v11 moved to per-request files. Only complete lines
        // are handled.
        val queue = File(home, QUEUE_FILE)
        val claimed = File(home, QUEUE_FILE + CLAIMED_SUFFIX)
        // A claim left by a crash mid-drain is processed first (the 30s
        // staleness check keeps an old replay from firing).
        if (!claimed.exists()) {
            if (!queue.exists()) return
            if (!queue.renameTo(claimed)) return
        }
        handleAll(context, completeLines(readAndDelete(claimed)))
    }

    // ── Watcher lifecycle (process-wide singleton) ──────────────────────

    private var executor: ScheduledExecutorService? = null
    private var observer: FileObserver? = null

    /** Idempotent. Called from TerminalSessionService.onCreate and the Expo
     *  Module's OnCreate so the queue is drained whenever the process lives,
     *  with or without the RN JS thread running. */
    @Synchronized
    fun ensureWatching(context: Context) {
        if (executor != null) return
        val app = context.applicationContext
        val exec = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "ShellyClosePawQueue").apply { isDaemon = true }
        }
        executor = exec
        try {
            val home = HomeInitializer.getHomeDir(app).also { it.mkdirs() }
            val mask = FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO
            // MOVED_TO = a v11 request file renamed into place; CLOSE_WRITE =
            // a legacy v9/v10 append.
            fun relevant(path: String?) = path == QUEUE_FILE || isRequestFileName(path)
            val obs = if (Build.VERSION.SDK_INT >= 29) {
                object : FileObserver(home, mask) {
                    override fun onEvent(event: Int, path: String?) {
                        if (relevant(path)) exec.execute { drain(app) }
                    }
                }
            } else {
                @Suppress("DEPRECATION")
                object : FileObserver(home.absolutePath, mask) {
                    override fun onEvent(event: Int, path: String?) {
                        if (relevant(path)) exec.execute { drain(app) }
                    }
                }
            }
            obs.startWatching()
            observer = obs
        } catch (e: Exception) {
            Log.w(TAG, "closepaw FileObserver unavailable; relying on the fallback poll", e)
        }
        // Fallback: a cheap pending check in case an inotify event is missed
        // (e.g. $HOME recreated). 1s only when the observer failed to start;
        // otherwise a 5s safety net. Not a wakelock — it only runs while the
        // CPU is awake anyway.
        val pollMs = if (observer == null) FALLBACK_POLL_MS else OBSERVED_POLL_MS
        exec.scheduleWithFixedDelay({
            try {
                val home = HomeInitializer.getHomeDir(app)
                ClosePawRunResults.sweepOldFiles(home)
                if (hasPending(home)) drain(app)
            } catch (e: Exception) {
                Log.w(TAG, "closepaw fallback poll failed type=${e.javaClass.simpleName}")
            }
        }, 0L, pollMs, TimeUnit.MILLISECONDS)
        Log.i(TAG, "closepaw queue watcher started")
    }
}
