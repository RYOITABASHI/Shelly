package expo.modules.terminalemulator

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.FileObserver
import android.provider.Settings
import android.util.Log
import expo.modules.terminalemulator.scouter.redactForScouter
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
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

    fun buildIntent(goal: String): Intent = Intent().apply {
        component = ComponentName(PACKAGE, ACTIVITY)
        putExtra(EXTRA_GOAL, wireGoal(goal))
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    enum class Outcome(val wire: String) { LAUNCHED("launched"), NOTIFIED("notified") }

    /**
     * Hand [goal] to ClosePaw: direct start when BAL is provably allowed,
     * else the tap-to-continue notification. Throws ActivityNotFoundException
     * (message [NOT_INSTALLED_MARKER]) when ClosePaw is missing and
     * IllegalStateException ([BACKGROUND_BLOCKED_MARKER]) when neither route
     * is available. Shared by the shell queue and fireAgentIntent('closepaw').
     */
    fun launch(context: Context, goal: String): Outcome {
        val clean = sanitizeGoal(goal)
        require(clean.isNotEmpty()) { "closepaw goal is empty" }
        val intent = buildIntent(clean)
        if (intent.resolveActivity(context.packageManager) == null) {
            throw ActivityNotFoundException(NOT_INSTALLED_MARKER)
        }
        if (canStartActivityNow(context)) {
            try {
                context.startActivity(intent)
                // Never log the goal itself (free text) — length only.
                Log.i(TAG, "launched ClosePaw directly goalLen=${clean.length}")
                return Outcome.LAUNCHED
            } catch (e: Exception) {
                Log.w(TAG, "direct start failed type=${e.javaClass.simpleName}; falling back to notification")
            }
        }
        if (!postHandoffNotification(context, clean, intent)) {
            throw IllegalStateException(BACKGROUND_BLOCKED_MARKER)
        }
        Log.i(TAG, "posted ClosePaw hand-off notification goalLen=${clean.length}")
        return Outcome.NOTIFIED
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
            } else {
                lastFireAtMs = nowMs
                try {
                    when (launch(context.applicationContext, parsed.goal)) {
                        Outcome.LAUNCHED -> Result(true, "handed-off", MSG_HANDED_OFF)
                        Outcome.NOTIFIED -> Result(true, "notified", MSG_NOTIFIED)
                    }
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
                if (hasPending(HomeInitializer.getHomeDir(app))) drain(app)
            } catch (e: Exception) {
                Log.w(TAG, "closepaw fallback poll failed type=${e.javaClass.simpleName}")
            }
        }, 0L, pollMs, TimeUnit.MILLISECONDS)
        Log.i(TAG, "closepaw queue watcher started")
    }
}
