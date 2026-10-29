package expo.modules.terminalemulator

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.util.Log
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * `shelly device <command>` — native half (2026-10-29). Read the shim first:
 * modules/terminal-emulator/android/src/main/assets/shelly-device.js.
 *
 * Same file bridge as ClosePawHandoff / AgentAddHandoff (Knox denies
 * `am start` from the app uid, CLAUDE.md): the shim writes ONE request file
 * per call, `$HOME/.shelly-device-req-<reqId>` (tmp + rename) holding a
 * single JSON line {"v":1,"reqId","ts","op","args"}; this object claims it
 * (delete first: a request is executed at most once, and never after the
 * shim gave up and removed it), re-validates every field, applies the rate
 * limits and answers with `$HOME/.shelly-device-result-<reqId>.json`
 * {"ok","code","message","data"}. Started from TerminalSessionService and the
 * Expo Module, so it works while Shelly is in the background (RN is not
 * involved at all).
 *
 * Scope (v1): battery, info, clipboard get/set, notify, toast, vibrate, tts,
 * share. No location / camera / microphone / SMS / contacts / call log — see
 * docs/superpowers/DEFERRED.md. `info` never returns identifiers (IMEI,
 * serial, Android ID, IP/MAC addresses).
 *
 * Security notes:
 * - Only the app uid can write $HOME; whoever can write a request file can
 *   already run any command as Shelly. The bridge adds phone features, not
 *   privilege across uids.
 * - `clipboard.get` hands the clipboard to the caller. Android itself only
 *   allows it while Shelly is the focused app (and shows its own "pasted from
 *   your clipboard" notice); lib/agent-boundary-policy.ts gates the command
 *   like a secret read for agents. Every read also shows "A script read your
 *   clipboard" (toast + notification, never rate limited away); the result
 *   file is deleted after 15s and a read that finishes after the shim may
 *   have given up returns no text. The text is never logged.
 * - Side effects (notify / toast / vibrate / tts / share) are rate limited
 *   here, process-wide, so a looping script or agent cannot spam the user.
 *   Toasts are prefixed "Script: " so they cannot pose as system messages.
 * - `share` of a file is an allow-list (home or shared storage, no dot
 *   component) and only ever grants a per-request snapshot copy in
 *   cacheDir/share/<reqId>/ (deleted after 30 min), never the original path;
 *   the user always picks the target app.
 */
object DeviceApi {
    private const val TAG = "ShellyDeviceApi"

    const val PROTOCOL_VERSION = 1
    const val REQUEST_FILE_PREFIX = ".shelly-device-req-"
    const val RESULT_FILE_PREFIX = ".shelly-device-result-"
    private val REQUEST_FILE_RE = Regex("^\\.shelly-device-req-([0-9]{10,16}-[0-9a-f]{8})$")
    private val RESULT_FILE_RE = Regex("^\\.shelly-device-result-[0-9]{10,16}-[0-9a-f]{8}\\.json(\\.tmp)?$")
    private val LANG_RE = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
    private val UNSAFE_INLINE_RE = Regex("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF]")

    private const val MAX_REQUEST_BYTES = 512L * 1024L
    private const val MAX_AGE_MS = 30_000L
    private const val MAX_FUTURE_MS = 5_000L
    private const val STALE_FILE_MS = 120_000L
    private const val FALLBACK_POLL_MS = 1_000L
    private const val OBSERVED_POLL_MS = 5_000L
    private const val MAIN_THREAD_TIMEOUT_MS = 3_000L
    private const val TTS_INIT_TIMEOUT_MS = 10_000L
    private const val TTS_IDLE_SHUTDOWN_MS = 120_000L
    private const val EPHEMERAL_RESULT_MS = 15_000L
    /** Below the shim's 10s wait: a clipboard read that finishes later than
     *  this is answered without the text (the shim may have given up). */
    private const val CLIPBOARD_ANSWER_WINDOW_MS = 8_000L
    private const val SHARE_SNAPSHOT_TTL_MS = 30L * 60L * 1000L
    private const val MAX_SHARE_FILE_BYTES = 256L * 1024L * 1024L

    const val MAX_CLIPBOARD_SET_CHARS = 100_000
    const val MAX_CLIPBOARD_GET_CHARS = 1_000_000
    const val MAX_NOTIFY_TITLE_CHARS = 100
    const val MAX_NOTIFY_TEXT_CHARS = 2_000
    const val MAX_TOAST_CHARS = 500
    const val MAX_TTS_CHARS = 3_900
    const val MAX_SHARE_TEXT_CHARS = 20_000
    const val MAX_NOTIFY_ID = 9_999
    const val MAX_VIBRATE_MS = 2_000L

    const val CHANNEL_ID = "shelly_scripts"
    // Own range, away from ClosePawHandoff/AgentAddHandoff (0x37C1A0xx),
    // NotificationDispatcher and TerminalSessionService's 7734.
    private const val NOTIFY_ID_BASE = 0x37C30000
    private const val SHARE_NOTIFICATION_BASE = 0x37C3F100
    private const val CLIPBOARD_NOTICE_ID = 0x37C3F000
    private const val SHARE_SLOTS = 16
    private const val REQUEST_CODE_OPEN = 0x37C3F001
    private const val REQUEST_CODE_SHARE_BASE = 0x37C3F100

    // Rate limits (per minute, process-wide). Mirrored in the shim's help text
    // and README; __tests__/shelly-device.test.ts pins them.
    private const val WINDOW_MS = 60_000L
    private val limiters: Map<String, Pair<Int, DeviceApiRateLimiter>> = mapOf(
        "notify" to (30 to DeviceApiRateLimiter(30, WINDOW_MS)),
        "toast" to (10 to DeviceApiRateLimiter(10, WINDOW_MS)),
        "vibrate" to (10 to DeviceApiRateLimiter(10, WINDOW_MS)),
        "tts" to (10 to DeviceApiRateLimiter(10, WINDOW_MS)),
        "share" to (5 to DeviceApiRateLimiter(5, WINDOW_MS)),
    )
    private val globalLimiter = DeviceApiRateLimiter(120, WINDOW_MS)

    class DeviceApiError(val code: String, message: String) : Exception(message)

    /** [ephemeral]: the result file is deleted ~15s after it is written even if
     *  the shim never collects it (clipboard text must not linger in HOME). */
    private data class Outcome(
        val code: String,
        val message: String = "",
        val data: JSONObject? = null,
        val ephemeral: Boolean = false,
    )

    // ── Request scan ─────────────────────────────────────────────────────

    /**
     * Runs ONLY on the single "ShellyDeviceApi" executor thread (FileObserver
     * events and the poll both hop onto it), which serialises requests. It is
     * deliberately NOT @Synchronized on this object: it waits for the main
     * thread (clipboard / toast / TTS start), and ensureWatching() — which the
     * main thread can call — holds the object monitor, so sharing that lock
     * could stall the UI thread.
     */
    private fun scan(context: Context) {
        val home = try { HomeInitializer.getHomeDir(context) } catch (e: Exception) { return }
        val names = home.list()?.sorted() ?: return
        val now = System.currentTimeMillis()
        for (name in names) {
            val m = REQUEST_FILE_RE.matchEntire(name)
            if (m != null) {
                handleRequestFile(context, home, File(home, name), m.groupValues[1], now)
                continue
            }
            // A result the shim never collected (it timed out or was killed),
            // or a temp file a crashed writer left behind.
            val stale = RESULT_FILE_RE.matches(name) ||
                (name.startsWith(REQUEST_FILE_PREFIX) && name.endsWith(".tmp"))
            if (stale) {
                val f = File(home, name)
                if (now - f.lastModified() > STALE_FILE_MS) f.delete()
            }
        }
        // Also after a process restart (the scheduled per-request delete is lost).
        runCatching { sweepShareSnapshots(context) }
    }

    private fun handleRequestFile(context: Context, home: File, file: File, reqId: String, now: Long) {
        val content = try {
            if (file.length() > MAX_REQUEST_BYTES) null else file.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
        // Claim: whoever deletes the file owns the request. If the shim already
        // removed it (timed out), it must not run.
        if (!file.delete()) return
        val outcome: Outcome = try {
            if (content == null) throw DeviceApiError("error", "request too large or unreadable")
            val req = try {
                JSONObject(content.trim())
            } catch (e: Exception) {
                throw DeviceApiError("error", "malformed request")
            }
            if (req.optInt("v", -1) != PROTOCOL_VERSION) {
                throw DeviceApiError("error", "protocol version mismatch: restart Shelly so the shell helper and the app match")
            }
            if (req.optString("reqId") != reqId) throw DeviceApiError("error", "malformed request")
            val ts = req.optLong("ts", 0L)
            if (now - ts > MAX_AGE_MS || ts - now > MAX_FUTURE_MS) throw DeviceApiError("error", "the request expired before Shelly could handle it")
            val op = req.optString("op")
            val args = req.optJSONObject("args") ?: JSONObject()
            dispatch(context, reqId, ts, op, args)
        } catch (e: DeviceApiError) {
            Outcome(e.code, e.message ?: "failed")
        } catch (e: Throwable) {
            Log.w(TAG, "request $reqId failed type=${e.javaClass.simpleName}")
            Outcome("error", "internal error (${e.javaClass.simpleName})")
        }
        // Never log arguments (clipboard / notification text) — op + code only.
        Log.i(TAG, "device request $reqId code=${outcome.code}")
        writeResult(home, reqId, outcome)
    }

    private fun writeResult(home: File, reqId: String, outcome: Outcome) {
        try {
            val json = JSONObject()
                .put("ok", outcome.code == "ok")
                .put("code", outcome.code)
                .put("message", outcome.message)
            if (outcome.data != null) json.put("data", outcome.data)
            val target = File(home, "$RESULT_FILE_PREFIX$reqId.json")
            val tmp = File(home, "$RESULT_FILE_PREFIX$reqId.json.tmp")
            tmp.writeText(json.toString(), Charsets.UTF_8)
            if (!tmp.renameTo(target)) {
                tmp.delete()
                Log.w(TAG, "could not publish result for $reqId")
            } else if (outcome.ephemeral) {
                executor?.schedule({ target.delete() }, EPHEMERAL_RESULT_MS, TimeUnit.MILLISECONDS)
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to write device result type=${e.javaClass.simpleName}")
        }
    }

    private fun dispatch(context: Context, reqId: String, ts: Long, op: String, args: JSONObject): Outcome {
        val opKey = op.substringBefore('.')
        val sideEffect = op in setOf("notify", "toast", "vibrate", "tts", "share")
        if (op !in setOf("battery", "info", "clipboard.get", "clipboard.set", "notify", "notify.remove", "toast", "vibrate", "tts", "share")) {
            throw DeviceApiError("usage", "unknown command '$op'")
        }
        val nowMono = SystemClock.elapsedRealtime()
        if (!globalLimiter.tryAcquire(nowMono)) {
            throw DeviceApiError("rate_limited", "too many shelly device calls (at most 120 per minute); retry in ${(globalLimiter.retryAfterMs(nowMono) + 999) / 1000}s")
        }
        if (sideEffect) {
            val (max, limiter) = limiters.getValue(opKey)
            if (!limiter.tryAcquire(nowMono)) {
                val wait = (limiter.retryAfterMs(nowMono) + 999) / 1000
                throw DeviceApiError("rate_limited", "rate limited: at most $max $opKey calls per minute; retry in ${wait}s")
            }
        }
        return when (op) {
            "battery" -> Outcome("ok", data = battery(context))
            "info" -> Outcome("ok", data = info(context))
            "clipboard.get" -> clipboardGet(context, ts)
            "clipboard.set" -> clipboardSet(context, args)
            "notify" -> notify(context, args)
            "notify.remove" -> notifyRemove(context, args)
            "toast" -> toast(context, args)
            "vibrate" -> vibrate(context, args)
            "tts" -> tts(context, args)
            else -> share(context, reqId, args)
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    /** Runs [block] on the main thread and waits for it. */
    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val latch = CountDownLatch(1)
        val value = AtomicReference<Any?>(null)
        val failure = AtomicReference<Throwable?>(null)
        mainHandler.post {
            try {
                value.set(block())
            } catch (t: Throwable) {
                failure.set(t)
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(MAIN_THREAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw DeviceApiError("error", "Shelly's UI thread did not respond")
        }
        failure.get()?.let { throw it }
        @Suppress("UNCHECKED_CAST")
        return value.get() as T
    }

    private fun isForeground(): Boolean {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun requireString(args: JSONObject, key: String, maxChars: Int, allowEmpty: Boolean = false): String {
        val raw = args.opt(key)
        if (raw !is String) throw DeviceApiError("usage", "missing $key")
        if (!allowEmpty && raw.isBlank()) throw DeviceApiError("usage", "missing $key")
        if (raw.codePointCount(0, raw.length) > maxChars) throw DeviceApiError("usage", "$key is longer than $maxChars characters")
        return raw
    }

    /** One-line text for notification titles and toasts. */
    private fun oneLine(s: String): String = s.replace("\r\n", " ").replace('\n', ' ').replace(UNSAFE_INLINE_RE, " ").trim()

    /** Multi-line text (keeps \n) for notification bodies and speech. */
    private fun multiline(s: String): String = s.replace("\r\n", "\n").replace(UNSAFE_INLINE_RE, " ").trim()

    private fun requireId(args: JSONObject): Int {
        val raw = args.opt("id")
        val id = when (raw) {
            is Int -> raw
            is Long -> if (raw in 0L..MAX_NOTIFY_ID.toLong()) raw.toInt() else -1
            else -> -1
        }
        if (id < 0 || id > MAX_NOTIFY_ID) throw DeviceApiError("usage", "notification id must be 0-$MAX_NOTIFY_ID")
        return id
    }

    // ── battery / info ───────────────────────────────────────────────────

    private fun battery(context: Context): JSONObject {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: throw DeviceApiError("unavailable", "battery status is not available")
        val rawLevel = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        var level = if (rawLevel >= 0 && scale > 0) Math.round(rawLevel * 100f / scale) else -1
        if (level !in 0..100) {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        }
        if (level !in 0..100) throw DeviceApiError("unavailable", "battery level is not available")
        val status = when (intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
            else -> "unknown"
        }
        val pluggedRaw = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val plugged = when {
            pluggedRaw and BatteryManager.BATTERY_PLUGGED_AC != 0 -> "ac"
            pluggedRaw and BatteryManager.BATTERY_PLUGGED_USB != 0 -> "usb"
            pluggedRaw and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0 -> "wireless"
            pluggedRaw and 8 != 0 -> "dock" // BATTERY_PLUGGED_DOCK (API 33)
            else -> "none"
        }
        val health = when (intent.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "good"
            BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
            BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
            BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
            BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"
            BatteryManager.BATTERY_HEALTH_COLD -> "cold"
            else -> "unknown"
        }
        val tenthsC = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        val voltage = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
        return JSONObject()
            .put("level", level)
            .put("charging", status == "charging" || (status == "full" && plugged != "none"))
            .put("plugged", plugged)
            .put("status", status)
            .put("health", health)
            .put("temperatureC", if (tenthsC == Int.MIN_VALUE) JSONObject.NULL else tenthsC / 10.0)
            .put("voltageMv", if (voltage > 0) voltage else JSONObject.NULL)
    }

    private fun info(context: Context): JSONObject {
        val res = context.resources
        val dm = res.displayMetrics
        val cfg = res.configuration
        val locale = if (Build.VERSION.SDK_INT >= 24) cfg.locales.get(0) ?: Locale.getDefault() else Locale.getDefault()
        val versionName = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        } catch (e: Exception) {
            ""
        }
        return JSONObject()
            .put("manufacturer", Build.MANUFACTURER ?: "")
            .put("model", Build.MODEL ?: "")
            .put("android", JSONObject().put("release", Build.VERSION.RELEASE ?: "").put("sdk", Build.VERSION.SDK_INT))
            .put(
                "screen",
                JSONObject()
                    .put("widthPx", dm.widthPixels)
                    .put("heightPx", dm.heightPixels)
                    .put("widthDp", cfg.screenWidthDp)
                    .put("heightDp", cfg.screenHeightDp)
                    .put("densityDpi", dm.densityDpi)
                    .put("density", dm.density.toDouble())
                    .put("orientation", if (cfg.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait"),
            )
            .put("locale", locale.toLanguageTag())
            .put("timeZone", TimeZone.getDefault().id)
            .put("network", network(context))
            .put("shelly", JSONObject().put("version", versionName))
    }

    /** Connectivity type only — never SSID, IP or any identifier. */
    private fun network(context: Context): JSONObject {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return JSONObject().put("connected", JSONObject.NULL).put("type", "unknown")
        val active = cm.activeNetwork ?: return JSONObject().put("connected", false).put("type", "none")
        val caps = cm.getNetworkCapabilities(active)
            ?: return JSONObject().put("connected", JSONObject.NULL).put("type", "unknown")
        val connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val type = when {
            !connected -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        return JSONObject().put("connected", connected).put("type", type)
    }

    // ── clipboard ────────────────────────────────────────────────────────

    private fun clipboardGet(context: Context, requestTs: Long): Outcome {
        val foreground = isForeground()
        val text: String? = onMain {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: throw DeviceApiError("unavailable", "the clipboard service is not available")
            val clip = cm.primaryClip
            if (clip == null || clip.itemCount == 0) null else clip.getItemAt(0).coerceToText(context)?.toString()
        }
        if (text == null) {
            // Android 10+ returns no clip to an app that is not focused.
            if (!foreground && Build.VERSION.SDK_INT >= 29) {
                throw DeviceApiError("background", "Android lets only the focused app read the clipboard: bring Shelly to the screen and run it again")
            }
            return Outcome("ok", data = JSONObject().put("text", "").put("empty", true), ephemeral = true)
        }
        // Defence in depth: the user always sees that a script read the
        // clipboard. Not rate limited (only side effects the caller asked for
        // are), so a loop cannot hide reads behind a full quota.
        announceClipboardRead(context)
        // The shim waits 10s. If it may already have given up, never leave the
        // text in a result file nobody collects.
        if (System.currentTimeMillis() - requestTs > CLIPBOARD_ANSWER_WINDOW_MS) {
            throw DeviceApiError("error", "the clipboard read took too long; nothing was returned, run it again")
        }
        val truncated = text.length > MAX_CLIPBOARD_GET_CHARS
        val shown = if (truncated) text.substring(0, MAX_CLIPBOARD_GET_CHARS) else text
        // Length only — never the content.
        Log.i(TAG, "clipboard read (chars=${shown.length}, truncated=$truncated)")
        return Outcome(
            "ok",
            data = JSONObject().put("text", shown).put("empty", shown.isEmpty()).put("truncated", truncated),
            ephemeral = true,
        )
    }

    /** Toast + (best effort) a notification: "A script read your clipboard". */
    private fun announceClipboardRead(context: Context) {
        val msg = context.getString(R.string.device_api_clipboard_read_notice)
        runCatching { onMain { Toast.makeText(context.applicationContext, msg, Toast.LENGTH_SHORT).show() } }
        runCatching {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return@runCatching
            if (!nm.areNotificationsEnabled()) return@runCatching
            ensureChannel(context, nm)
            val b = builder(context)
                .setContentTitle(msg)
                .setContentText(context.getString(R.string.device_api_clipboard_read_body))
                .setSubText(context.getString(R.string.device_api_subtext))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setAutoCancel(true)
            openShellyIntent(context)?.let { b.setContentIntent(it) }
            nm.notify(CLIPBOARD_NOTICE_ID, b.build())
        }
    }

    private fun clipboardSet(context: Context, args: JSONObject): Outcome {
        val text = requireString(args, "text", MAX_CLIPBOARD_SET_CHARS, allowEmpty = true)
        val sensitive = args.optBoolean("sensitive", false)
        onMain {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: throw DeviceApiError("unavailable", "the clipboard service is not available")
            val clip = ClipData.newPlainText("shelly", text)
            if (sensitive) {
                // ClipDescription.EXTRA_IS_SENSITIVE (API 33); older releases ignore it.
                clip.description.extras = PersistableBundle().apply {
                    putBoolean("android.content.extra.IS_SENSITIVE", true)
                }
            }
            cm.setPrimaryClip(clip)
        }
        return Outcome("ok")
    }

    // ── notify ───────────────────────────────────────────────────────────

    private fun notificationManagerOrThrow(context: Context): NotificationManager {
        val nm = context.getSystemService(NotificationManager::class.java)
            ?: throw DeviceApiError("unavailable", "the notification service is not available")
        if (!nm.areNotificationsEnabled()) {
            throw DeviceApiError("permission", "notifications are off for Shelly: allow them in Android Settings > Apps > Shelly > Notifications")
        }
        ensureChannel(context, nm)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            nm.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE
        ) {
            throw DeviceApiError("permission", "Shelly's \"Scripts\" notification channel is turned off in Android Settings")
        }
        return nm
    }

    private fun ensureChannel(context: Context, nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.device_api_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.device_api_channel_description) },
        )
    }

    private fun builder(context: Context): Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }

    private fun openShellyIntent(context: Context): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return PendingIntent.getActivity(
            context,
            REQUEST_CODE_OPEN,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun notify(context: Context, args: JSONObject): Outcome {
        val text = multiline(requireString(args, "text", MAX_NOTIFY_TEXT_CHARS))
        val titleRaw = args.opt("title")
        val title = oneLine(
            if (titleRaw is String) {
                if (titleRaw.codePointCount(0, titleRaw.length) > MAX_NOTIFY_TITLE_CHARS) {
                    throw DeviceApiError("usage", "title is longer than $MAX_NOTIFY_TITLE_CHARS characters")
                }
                titleRaw
            } else {
                ""
            },
        ).ifEmpty { context.getString(R.string.device_api_default_title) }
        if (text.isEmpty()) throw DeviceApiError("usage", "missing text")
        val id = requireId(args)
        val nm = notificationManagerOrThrow(context)
        // Lock screen: a generic title only (scripts may print anything).
        val publicVersion = builder(context)
            .setContentTitle(context.getString(R.string.device_api_public_title))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build()
        val b = builder(context)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setContentTitle(title)
            .setContentText(text.lineSequence().firstOrNull().orEmpty())
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSubText(context.getString(R.string.device_api_subtext))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
        openShellyIntent(context)?.let { b.setContentIntent(it) }
        nm.notify(NOTIFY_ID_BASE + id, b.build())
        return Outcome("ok", data = JSONObject().put("id", id))
    }

    private fun notifyRemove(context: Context, args: JSONObject): Outcome {
        val id = requireId(args)
        val nm = context.getSystemService(NotificationManager::class.java)
            ?: throw DeviceApiError("unavailable", "the notification service is not available")
        nm.cancel(NOTIFY_ID_BASE + id)
        return Outcome("ok")
    }

    // ── toast / vibrate ──────────────────────────────────────────────────

    private fun toast(context: Context, args: JSONObject): Outcome {
        val text = oneLine(requireString(args, "text", MAX_TOAST_CHARS))
        if (text.isEmpty()) throw DeviceApiError("usage", "missing text")
        // "Script: …" so a toast can never pass for a system / app message.
        val shown = context.getString(R.string.device_api_toast_format, text)
        onMain { Toast.makeText(context.applicationContext, shown, Toast.LENGTH_SHORT).show() }
        return Outcome("ok")
    }

    @Suppress("DEPRECATION")
    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    @Suppress("DEPRECATION")
    private fun vibrate(context: Context, args: JSONObject): Outcome {
        val raw = args.opt("ms")
        val ms = when (raw) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> throw DeviceApiError("usage", "missing duration")
        }
        if (ms < 1L) throw DeviceApiError("usage", "duration must be at least 1 ms")
        val capped = ms.coerceAtMost(MAX_VIBRATE_MS)
        val vib = vibrator(context)
        if (vib == null || !vib.hasVibrator()) throw DeviceApiError("unavailable", "this device has no vibrator")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vib.vibrate(VibrationEffect.createOneShot(capped, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            vib.vibrate(capped)
        }
        return Outcome("ok", data = JSONObject().put("ms", capped))
    }

    // ── tts ──────────────────────────────────────────────────────────────

    private var tts: TextToSpeech? = null
    private var ttsLastUseMs = 0L
    private val ttsUtterance = AtomicInteger(0)

    /** Called only from the single scan executor thread. */
    private fun ensureTts(context: Context): TextToSpeech {
        tts?.let { return it }
        val latch = CountDownLatch(1)
        val status = AtomicInteger(TextToSpeech.ERROR)
        val engine = onMain {
            TextToSpeech(context.applicationContext) { s ->
                status.set(s)
                latch.countDown()
            }
        }
        if (!latch.await(TTS_INIT_TIMEOUT_MS, TimeUnit.MILLISECONDS) || status.get() != TextToSpeech.SUCCESS) {
            runCatching { engine.shutdown() }
            throw DeviceApiError("unavailable", "no text-to-speech engine is available (install or enable one in Android Settings)")
        }
        tts = engine
        return engine
    }

    private fun tts(context: Context, args: JSONObject): Outcome {
        val text = multiline(requireString(args, "text", MAX_TTS_CHARS))
        if (text.isEmpty()) throw DeviceApiError("usage", "missing text")
        val langRaw = args.opt("lang")
        val locale = when {
            langRaw == null || langRaw == JSONObject.NULL -> {
                val cfg = context.resources.configuration
                if (Build.VERSION.SDK_INT >= 24) cfg.locales.get(0) ?: Locale.getDefault() else Locale.getDefault()
            }
            langRaw is String && langRaw.length <= 35 && LANG_RE.matches(langRaw) -> Locale.forLanguageTag(langRaw)
            else -> throw DeviceApiError("usage", "--lang takes a language tag such as en-US or ja-JP")
        }
        val engine = ensureTts(context)
        ttsLastUseMs = SystemClock.elapsedRealtime()
        val langResult = engine.setLanguage(locale)
        if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            throw DeviceApiError("unavailable", "no text-to-speech voice is installed for ${locale.toLanguageTag()}")
        }
        val utteranceId = "shelly-device-" + ttsUtterance.incrementAndGet()
        if (engine.speak(text, TextToSpeech.QUEUE_ADD, null, utteranceId) != TextToSpeech.SUCCESS) {
            throw DeviceApiError("error", "text-to-speech refused the text")
        }
        executor?.schedule({ shutdownIdleTts() }, TTS_IDLE_SHUTDOWN_MS + 1_000L, TimeUnit.MILLISECONDS)
        return Outcome("ok", data = JSONObject().put("lang", locale.toLanguageTag()))
    }

    private fun shutdownIdleTts() {
        val engine = tts ?: return
        if (SystemClock.elapsedRealtime() - ttsLastUseMs < TTS_IDLE_SHUTDOWN_MS) return
        if (runCatching { engine.isSpeaking }.getOrDefault(false)) {
            executor?.schedule({ shutdownIdleTts() }, 30_000L, TimeUnit.MILLISECONDS)
            return
        }
        tts = null
        runCatching { engine.shutdown() }
        Log.i(TAG, "tts engine released after idle")
    }

    // ── share ────────────────────────────────────────────────────────────

    /**
     * Allow-list: a regular file under Shelly's home or shared storage
     * (/storage/emulated/0 = /sdcard) whose canonical path has NO component
     * starting with "." (that excludes ~/.ssh, ~/.codex, ~/.shelly, the
     * $HOME/.shelly-* bridge files, .env and any other dotfile). Everything
     * else — including the rest of filesDir, cacheDir and app-private dirs —
     * is refused.
     */
    private val EMULATED_USER_RE = Regex("^/storage/emulated/([0-9]+)$")

    /** Root spellings, including the ones /proc/self/fd can report for the
     *  same directory (/data/user/0 vs /data/data; the FUSE pass-through and
     *  lower-filesystem paths of shared storage). */
    private fun allowedShareRoots(context: Context): List<String> {
        val roots = mutableListOf<String>()
        runCatching { HomeInitializer.getHomeDir(context).canonicalPath }.getOrNull()?.let { home ->
            roots += home
            when {
                home.startsWith("/data/user/0/") -> roots += "/data/data/" + home.removePrefix("/data/user/0/")
                home.startsWith("/data/data/") -> roots += "/data/user/0/" + home.removePrefix("/data/data/")
            }
        }
        @Suppress("DEPRECATION")
        val storage = runCatching { android.os.Environment.getExternalStorageDirectory().canonicalPath }.getOrNull()
        if (storage != null) {
            roots += storage
            EMULATED_USER_RE.matchEntire(storage)?.groupValues?.get(1)?.let { u ->
                roots += "/mnt/pass_through/$u/emulated/$u"
                roots += "/mnt/user/$u/emulated/$u"
                roots += "/data/media/$u"
            }
        }
        return roots.map { it.trimEnd('/') }.filter { it.isNotEmpty() }
    }

    private fun isShareAllowed(context: Context, path: String): Boolean {
        if (!path.startsWith("/")) return false
        if (path.split('/').any { it.startsWith(".") }) return false
        return allowedShareRoots(context).any { root -> path.startsWith("$root/") }
    }

    private const val SHARE_REFUSED =
        "only files in Shelly's home or shared storage (/sdcard) can be shared, and not hidden files or anything inside a hidden (dot) folder"

    private fun shareDir(context: Context): File = File(context.cacheDir, "share")

    /** Removes snapshots older than [SHARE_SNAPSHOT_TTL_MS]. */
    private fun sweepShareSnapshots(context: Context) {
        val dirs = shareDir(context).listFiles() ?: return
        val now = System.currentTimeMillis()
        for (d in dirs) {
            if (now - d.lastModified() > SHARE_SNAPSHOT_TTL_MS) d.deleteRecursively()
        }
    }

    /**
     * TOCTOU-safe: the file is opened ONCE, the opened descriptor's real path
     * (/proc/self/fd) and type are checked against the allow-list, and its
     * bytes are copied to cacheDir/share/<reqId>/. Only that snapshot is
     * granted (FileProvider <cache-path name="device_share" path="share/">,
     * plugins/with-apk-installer.js) — never the original path, so swapping
     * a symlink after the check cannot redirect the receiving app.
     */
    private fun shareFile(context: Context, reqId: String, rawPath: String): Pair<Intent, String> {
        if (!rawPath.startsWith("/")) throw DeviceApiError("usage", "file path must be absolute")
        val pre = try { File(rawPath).canonicalFile } catch (e: Exception) { throw DeviceApiError("usage", "invalid file path") }
        if (!isShareAllowed(context, pre.path)) throw DeviceApiError("permission", SHARE_REFUSED)
        val pfd = try {
            android.os.ParcelFileDescriptor.open(pre, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
        } catch (e: Exception) {
            throw DeviceApiError("usage", "cannot open $rawPath")
        }
        val snapshot: File = try {
            val opened = try {
                android.system.Os.readlink("/proc/self/fd/${pfd.fd}")
            } catch (e: Exception) {
                throw DeviceApiError("error", "cannot verify the opened file")
            }
            val st = android.system.Os.fstat(pfd.fileDescriptor)
            if (!android.system.OsConstants.S_ISREG(st.st_mode)) throw DeviceApiError("usage", "not a regular file: $rawPath")
            if (!isShareAllowed(context, opened)) throw DeviceApiError("permission", SHARE_REFUSED)
            if (st.st_size > MAX_SHARE_FILE_BYTES) {
                throw DeviceApiError("usage", "file is larger than ${MAX_SHARE_FILE_BYTES / (1024 * 1024)} MB")
            }
            val name = File(opened).name.replace(Regex("[\\u0000-\\u001F/\\\\]"), "_").ifEmpty { "file" }
            sweepShareSnapshots(context)
            val dir = File(shareDir(context), reqId)
            if (!dir.mkdirs() && !dir.isDirectory) throw DeviceApiError("error", "cannot create the share snapshot")
            val copy = File(dir, name)
            android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).use { input ->
                copy.outputStream().use { output -> input.copyTo(output) }
            }
            copy
        } catch (e: Throwable) {
            runCatching { pfd.close() }
            File(shareDir(context), reqId).deleteRecursively()
            throw e
        }
        executor?.schedule(
            { File(shareDir(context), reqId).deleteRecursively() },
            SHARE_SNAPSHOT_TTL_MS,
            TimeUnit.MILLISECONDS,
        )
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.shelly.fileprovider", snapshot)
        val ext = snapshot.extension.lowercase(Locale.ROOT)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri(snapshot.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return intent to snapshot.name
    }

    private val shareSlot = AtomicInteger(0)

    private fun share(context: Context, reqId: String, args: JSONObject): Outcome {
        val (send, label) = when (args.optString("kind")) {
            "file" -> shareFile(context, reqId, requireString(args, "path", 4096))
            "text" -> {
                val text = requireString(args, "text", MAX_SHARE_TEXT_CHARS)
                Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                } to context.getString(R.string.device_api_share_label_text)
            }
            else -> throw DeviceApiError("usage", "share needs a file or text")
        }
        val chooser = Intent.createChooser(send, context.getString(R.string.device_api_share_title)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (send.clipData != null) addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // Shelly on screen: open the share sheet directly from the app process
        // (allowed for the foreground app; the shell's `am start` is what Knox
        // blocks). Background: Android blocks activity starts, so post a
        // tap-to-share notification instead (same fallback as ClosePawHandoff).
        if (isForeground()) {
            val started = runCatching { onMain { context.startActivity(chooser) } }.isSuccess
            if (started) return Outcome("ok", message = "Opened the share sheet on the phone ($label)")
        }
        val nm = notificationManagerOrThrow(context)
        // One notification + PendingIntent per request (16 rotating slots), so
        // a later share never silently replaces an earlier one's content.
        val slot = Math.floorMod(shareSlot.getAndIncrement(), SHARE_SLOTS)
        val pi = PendingIntent.getActivity(
            context,
            REQUEST_CODE_SHARE_BASE + slot,
            chooser,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val shownLabel = oneLine(label).let { if (it.length > 80) it.take(79) + "…" else it }
        val publicVersion = builder(context)
            .setContentTitle(context.getString(R.string.device_api_share_notification_title))
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .build()
        val b = builder(context)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setContentTitle(context.getString(R.string.device_api_share_notification_title))
            .setContentText(context.getString(R.string.device_api_share_notification_body, shownLabel))
            .setSubText(context.getString(R.string.device_api_subtext))
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentIntent(pi)
            .setAutoCancel(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) b.setTimeoutAfter(SHARE_SNAPSHOT_TTL_MS)
        nm.notify(SHARE_NOTIFICATION_BASE + slot, b.build())
        return Outcome("ok", message = "Shelly is in the background: tap the \"Tap to share\" notification on the phone ($label)")
    }

    // ── Watcher lifecycle (process-wide singleton) ───────────────────────

    private var executor: ScheduledExecutorService? = null
    private var observer: FileObserver? = null

    private fun safeScan(context: Context) {
        try {
            scan(context)
        } catch (e: Throwable) {
            // Throwable, not Exception: anything escaping here would cancel
            // the scheduleWithFixedDelay poll for the rest of the process.
            Log.w(TAG, "device request scan failed type=${e.javaClass.simpleName}")
        }
    }

    /** Idempotent. Called next to AgentAddHandoff.ensureWatching from
     *  TerminalSessionService.onCreate and the Expo Module's OnCreate. */
    @Synchronized
    fun ensureWatching(context: Context) {
        if (executor != null) return
        val app = context.applicationContext
        val exec = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "ShellyDeviceApi").apply { isDaemon = true }
        }
        executor = exec
        try {
            val home = HomeInitializer.getHomeDir(app).also { it.mkdirs() }
            fun relevant(path: String?) = path != null && REQUEST_FILE_RE.matches(path)
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
            Log.w(TAG, "device-api FileObserver unavailable; relying on the fallback poll", e)
        }
        val pollMs = if (observer == null) FALLBACK_POLL_MS else OBSERVED_POLL_MS
        exec.scheduleWithFixedDelay({ safeScan(app) }, 0L, pollMs, TimeUnit.MILLISECONDS)
        Log.i(TAG, "device-api request watcher started")
    }
}
