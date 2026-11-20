package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import expo.modules.terminalemulator.ConnectivityGuardianCore.Effect
import expo.modules.terminalemulator.ConnectivityGuardianCore.Event
import expo.modules.terminalemulator.ConnectivityGuardianCore.SeqKind
import expo.modules.terminalemulator.ConnectivityGuardianCore.State

/**
 * Wi-Fi connectivity guardian ("Wi-Fi連動オートパイロット", default OFF).
 *
 * On Wi-Fi connect (and at boot): wireless debugging ON -> wait for Shizuku's
 * own auto-start -> Tailscale connected. On Wi-Fi loss, after a 45 s debounce
 * (cancelled if Wi-Fi comes back): wireless debugging OFF only; Tailscale is
 * left connected (mobile data too, owner decision 2026-11-17). Decisions are ConnectivityGuardianCore's (android-free,
 * mirrored in lib/connectivity-guardian-core.ts); this object owns the
 * Android plumbing:
 *
 *  - Toggle: ConnectivityGuardianStore (Keystore AES-GCM mirror written by RN,
 *    unreadable = OFF). Every step re-reads it.
 *  - Wi-Fi events:
 *     * ConnectivityManager.registerNetworkCallback(Wi-Fi request,
 *       PendingIntent) -> ConnectivityGuardianEventReceiver
 *       (ACTION_WIFI_AVAILABLE). It survives process death, but AOSP only
 *       sends the PendingIntent for "available", never "lost".
 *     * So loss comes from an in-process NetworkCallback (registered whenever
 *       the process is up: app start, any guardian broadcast, the service).
 *       ConnectivityGuardianService stays RESIDENT while an OFF obligation
 *       may exist (ConnectivityGuardianCore.wantsResident: online after ON,
 *       the loss debounce, a running sequence), so that callback is live and
 *       the 45 s debounce starts at the real loss. A 15-minute inexact
 *       watchdog alarm is the backstop if the process died anyway.
 *  - Recovery: every entry point (boot, app start, watchdog, service start)
 *    reconciles the persisted state against a fresh Wi-Fi probe
 *    (Event.Boot / Event.Reconcile), so an ON cut short by process death
 *    is cleaned up (Wi-Fi gone) or rerun (Wi-Fi there).
 *    The Wi-Fi request is TRANSPORT_WIFI + INTERNET (NOT_VPN by default), not
 *    the default network: once Tailscale is up the default network is the VPN.
 *  - Debounce: an exact alarm (setExactAndAllowWhileIdle when allowed,
 *    otherwise setAndAllowWhileIdle) carrying the loss token; a stale token
 *    is ignored by the core.
 *  - Running a sequence: ConnectivityGuardianService (specialUse FGS) keeps
 *    the process alive while the single worker thread runs it. The
 *    worker is the guardian lock: one sequence at a time, ON and OFF never
 *    overlap; triggers that arrive meanwhile collapse in the core's pending
 *    flag. If the FGS cannot start (background-start restriction) the run
 *    hops through an exact alarm (an FGS-start exemption), and failing that
 *    runs best effort without it.
 *  - Audit: IngressAuditWriter -> ~/.shelly/agents/audits/
 *    connectivity-guardian.jsonl, fixed fields only (no SSID / BSSID).
 *  - STOP-ALL (`.halted`) and the toggle are checked before every step.
 *  - Shizuku watchdog (2026-11-20): while settled online, an exact-when-
 *    allowed 15-minute tick alarm (ACTION_SHIZUKU_WATCHDOG, armed by the
 *    core's ArmShizukuWatchdog) and every reconcile / Wi-Fi-available point
 *    observe liveness through ConnectivityGuardianCore.observeShizukuWatchdog
 *    (STOP-ALL first). A recovery is the ON sequence re-run on the same
 *    worker with wireless debugging cycled OFF -> ON (after re-probing
 *    Wi-Fi: gone = superseded, no write); policy (start-to-start backoff, a
 *    monotonic per-session cap reset only by Wi-Fi reconnect / re-enable /
 *    boot / 24 h of observed health, the single give-up notification,
 *    refunds for interrupted runs, the durable recovery intent) is
 *    ConnectivityGuardianCore.reduceWithWatchdog's. A sequence's end is
 *    built by ConnectivityGuardianCore.sequenceDoneFor with the gates read
 *    again at completion (STOP-ALL, toggle, Wi-Fi for a recovery); the
 *    success ping is taken only for a recovery that passes them, and the
 *    tick alarm is cancelled on Wi-Fi loss / toggle off
 *    (CancelShizukuWatchdog). The watchdog never starts Shizuku either.
 *
 * Never: starts Shizuku, requests Shizuku permission, accepts any dialog,
 * calls ClosePawHandoff's launch entry directly, or asks for the main
 * display. ClosePaw is reached only through TailscaleControl's seam (the
 * unchanged handleLine decision point), only while ClosePawShellPreapproval
 * is ON.
 */
object ConnectivityGuardian {
    private const val TAG = "ConnectivityGuardian"

    const val ACTION_WIFI_AVAILABLE = "expo.modules.terminalemulator.GUARDIAN_WIFI_AVAILABLE"
    const val ACTION_DEBOUNCE = "expo.modules.terminalemulator.GUARDIAN_DEBOUNCE"
    const val ACTION_RUN = "expo.modules.terminalemulator.GUARDIAN_RUN"
    const val ACTION_WATCHDOG = "expo.modules.terminalemulator.GUARDIAN_WATCHDOG"
    const val ACTION_SHIZUKU_WATCHDOG = "expo.modules.terminalemulator.GUARDIAN_SHIZUKU_WATCHDOG"
    const val EXTRA_TOKEN = "token"

    private const val RC_WIFI = 0x5747A001
    private const val RC_DEBOUNCE = 0x5747A002
    private const val RC_RUN = 0x5747A003
    private const val RC_WATCHDOG = 0x5747A004
    private const val RC_SHIZUKU_WATCHDOG = 0x5747A005

    private const val STATE_PREFS = "shelly_connectivity_guardian_state"
    private const val KEY_MODE = "mode"
    private const val KEY_LOSS_TOKEN = "lossToken"
    /** Wall-clock loss instant of LOSS_PENDING (informational; the one-time
     *  fallback basis for a loss written before the monotonic anchor). */
    private const val KEY_LOSS_AT = "lossAtMs"
    /** Monotonic loss anchor: elapsedRealtime at the loss and the boot it
     *  belongs to (Settings.Global.BOOT_COUNT). The debounce deadline's basis. */
    private const val KEY_LOSS_ELAPSED = "lossElapsedMs"
    private const val KEY_LOSS_BOOT = "lossBootId"
    private const val KEY_SEQ = "seq"
    /** Shizuku watchdog session (ConnectivityGuardianCore.State.wd*). */
    private const val KEY_WD_ATTEMPTS = "wdAttempts"
    private const val KEY_WD_LAST_ELAPSED = "wdLastAttemptElapsedMs"
    private const val KEY_WD_BOOT = "wdBootId"
    private const val KEY_WD_GAVE_UP = "wdGaveUp"
    private const val KEY_WD_HEALTHY_ACCUM = "wdHealthyAccumMs"
    private const val KEY_WD_HEALTHY_LAST = "wdHealthyLastElapsedMs"
    private const val KEY_WD_HEALTHY_BOOT = "wdHealthyBootId"
    /** The recovery intent (gate round 2): restored only onto an owed ON. */
    private const val KEY_WD_RECOVERING = "wdRecovering"

    const val ASSIST_CHANNEL_ID = "shelly_connectivity_guardian_assist"
    const val ASSIST_NOTIFICATION_ID = 7738

    private var state: State? = null
    private val memory = ConnectivityGuardianCore.RunnerMemory()
    private var queued: SeqKind? = null
    /** The queued ON is a Shizuku watchdog recovery. */
    private var queuedRecovery = false
    /** drain() calls not finished yet (the service never stops under one). */
    private val activeDrains = AtomicInteger(0)
    private var inProcessCallback: ConnectivityManager.NetworkCallback? = null
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ShellyConnectivityGuardian").apply { isDaemon = true }
    }

    // ── Entry points ─────────────────────────────────────────────────────

    /** RN `setConnectivityGuardianMirror`. Returns whether the mirror now matches. */
    fun setFromRn(context: Context, enabled: Boolean): Boolean {
        val app = context.applicationContext
        return if (!enabled) {
            val cleared = ConnectivityGuardianStore.clear(app, "settings off")
            onEvent(app, Event.Disable)
            cleared
        } else {
            val ok = ConnectivityGuardianStore.writeOn(app)
            if (ok) {
                onEvent(app, Event.Enable(isWifiUp(app) == true))
                ensureRegistered(app)
            } else {
                onEvent(app, Event.Disable)
            }
            ok
        }
    }

    /** Module OnCreate: re-register while the process lives (PendingIntent
     *  registrations do not survive an app update). No-op while OFF. */
    fun onAppStart(context: Context) {
        val app = context.applicationContext
        if (!ConnectivityGuardianStore.isOn(app)) return
        ensureRegistered(app)
        reconcile(app)
        // The app is starting in the foreground: an FGS-start-exempt context.
        ensureResident(app, exemptNow = true)
    }

    /** Recovery entry points: bring the (possibly restored) state in line
     *  with a fresh Wi-Fi probe. Unknown Wi-Fi = leave it. */
    fun reconcile(context: Context) {
        val app = context.applicationContext
        if (!ConnectivityGuardianStore.isOn(app)) return
        when (isWifiUp(app)) {
            true -> onEvent(app, Event.Reconcile(true, lossClock(app)))
            false -> onEvent(app, Event.Reconcile(false, lossClock(app)))
            null -> Unit
        }
        // Every reconcile point is also an opportunistic Shizuku watchdog check.
        shizukuWatchdogCheck(app)
    }

    /** One Shizuku watchdog observation (tick alarm, reconcile, Wi-Fi
     *  available). The core reads STOP-ALL first and acts only while settled
     *  online; toggle OFF = nothing read. */
    fun shizukuWatchdogCheck(context: Context) {
        val app = context.applicationContext
        if (!ConnectivityGuardianStore.isOn(app)) return
        onEvent(app, ConnectivityGuardianCore.observeShizukuWatchdog(AndroidWatchdogProbes(app), lossClock(app)))
    }

    /** Service start (ConnectivityGuardianService.onStartCommand): a cold
     *  process may get here first (e.g. the exact-alarm run hop), so the
     *  in-process loss callback is registered BEFORE reconciling: a resident
     *  service always has a live loss callback. */
    fun onServiceStart(context: Context) {
        val app = context.applicationContext
        if (!ConnectivityGuardianStore.isOn(app)) return
        ensureRegistered(app)
        reconcile(app)
    }

    /** BOOT_COMPLETED / MY_PACKAGE_REPLACED. Toggle OFF = no-op. */
    fun onBoot(context: Context, reason: String) {
        val app = context.applicationContext
        val enabled = ConnectivityGuardianStore.isOn(app)
        Log.i(TAG, "boot ($reason) enabled=$enabled")
        if (!enabled) return
        onEvent(app, Event.Boot(true, isWifiUp(app) == true, lossClock(app)))
        // BOOT_COMPLETED / MY_PACKAGE_REPLACED: FGS-start-exempt.
        ensureResident(app, exemptNow = true)
    }

    /** ConnectivityGuardianEventReceiver (explicit, non-exported). */
    fun onInternalBroadcast(context: Context, intent: Intent) {
        val app = context.applicationContext
        if (!ConnectivityGuardianStore.isOn(app)) {
            // Stale registration / alarm from before OFF: clean up, run nothing.
            unregisterAll(app)
            cancelDebounce(app)
            return
        }
        when (intent.action) {
            ACTION_WIFI_AVAILABLE -> {
                ensureInProcessCallback(app)
                if (isWifiUp(app) == true) onEvent(app, Event.WifiAvailable)
                shizukuWatchdogCheck(app)
            }
            ACTION_DEBOUNCE -> {
                ensureInProcessCallback(app)
                val token = intent.getLongExtra(EXTRA_TOKEN, -1L)
                // Unknown Wi-Fi state: do not run OFF on a guess.
                onEvent(app, Event.DebounceExpired(token, isWifiUp(app) ?: true))
            }
            ACTION_RUN -> {
                ensureInProcessCallback(app)
                startRunner(app, allowAlarmHop = false)
            }
            ACTION_WATCHDOG -> {
                ensureInProcessCallback(app)
                armWatchdog(app)
                reconcile(app)
                // An inexact alarm is not an FGS-start exemption: only the
                // exact-alarm run hop may bring residency back.
                ensureResident(app, exemptNow = false)
            }
            ACTION_SHIZUKU_WATCHDOG -> {
                ensureInProcessCallback(app)
                shizukuWatchdogCheck(app)
                ensureResident(app, exemptNow = false)
            }
        }
    }

    // ── Core plumbing ────────────────────────────────────────────────────

    /** Now, for the loss anchor: wall clock, elapsedRealtime (monotonic,
     *  restarts at boot) and the boot identity. BOOT_COUNT (API 24 = minSdk)
     *  unreadable = null: recovery then cannot tell the boot and expires the
     *  debounce instead of trusting elapsedRealtime. */
    private fun lossClock(context: Context): ConnectivityGuardianCore.LossClock {
        val boot = runCatching {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        }.getOrDefault(-1)
        return ConnectivityGuardianCore.LossClock(
            System.currentTimeMillis(),
            SystemClock.elapsedRealtime(),
            if (boot >= 0) boot.toLong() else null,
        )
    }

    private fun currentState(context: Context): State {
        state?.let { return it }
        val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
        val restored = ConnectivityGuardianCore.restoreWatchdog(
            ConnectivityGuardianCore.restoreState(
                ConnectivityGuardianStore.isOn(context),
                prefs.getString(KEY_MODE, null),
                prefs.getLong(KEY_LOSS_TOKEN, 0L),
                if (prefs.contains(KEY_LOSS_AT)) prefs.getLong(KEY_LOSS_AT, 0L) else null,
                if (prefs.contains(KEY_LOSS_ELAPSED)) prefs.getLong(KEY_LOSS_ELAPSED, 0L) else null,
                if (prefs.contains(KEY_LOSS_BOOT)) prefs.getLong(KEY_LOSS_BOOT, 0L) else null,
            ),
            prefs.getInt(KEY_WD_ATTEMPTS, 0),
            if (prefs.contains(KEY_WD_LAST_ELAPSED)) prefs.getLong(KEY_WD_LAST_ELAPSED, 0L) else null,
            if (prefs.contains(KEY_WD_BOOT)) prefs.getLong(KEY_WD_BOOT, 0L) else null,
            prefs.getBoolean(KEY_WD_GAVE_UP, false),
            prefs.getLong(KEY_WD_HEALTHY_ACCUM, 0L),
            if (prefs.contains(KEY_WD_HEALTHY_LAST)) prefs.getLong(KEY_WD_HEALTHY_LAST, 0L) else null,
            if (prefs.contains(KEY_WD_HEALTHY_BOOT)) prefs.getLong(KEY_WD_HEALTHY_BOOT, 0L) else null,
            prefs.getBoolean(KEY_WD_RECOVERING, false),
        )
        state = restored
        return restored
    }

    @Synchronized
    fun onEvent(context: Context, event: Event) {
        val before = currentState(context)
        val reduced = ConnectivityGuardianCore.reduceWithWatchdog(before, event)
        // Durable checkpoint BEFORE any effect: an ON may write
        // adb_wifi_enabled=1 only once "in_flight" is on disk, so a process
        // death mid-ON always leaves the cleanup owed (commit, not apply).
        // The loss anchor is part of the checkpoint: a recovery in a fresh
        // process re-arms for the REMAINING monotonic budget on the same boot
        // (never a fresh 45 s, never moved by the wall clock), and expires it
        // after a reboot.
        val durable = runCatching {
            val edit = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_MODE, ConnectivityGuardianCore.persistableMode(reduced.state))
                .putLong(KEY_LOSS_TOKEN, reduced.state.lossToken)
            val lossAt = reduced.state.lossAtMs
            if (lossAt != null) edit.putLong(KEY_LOSS_AT, lossAt) else edit.remove(KEY_LOSS_AT)
            val lossElapsed = reduced.state.lossElapsedMs
            if (lossElapsed != null) edit.putLong(KEY_LOSS_ELAPSED, lossElapsed) else edit.remove(KEY_LOSS_ELAPSED)
            val lossBoot = reduced.state.lossBootId
            if (lossBoot != null) edit.putLong(KEY_LOSS_BOOT, lossBoot) else edit.remove(KEY_LOSS_BOOT)
            // The watchdog session (attempts, backoff anchor, give-up, observed
            // health, recovery intent) rides the same commit.
            edit.putInt(KEY_WD_ATTEMPTS, reduced.state.wdAttempts).putBoolean(KEY_WD_GAVE_UP, reduced.state.wdGaveUp)
                .putBoolean(KEY_WD_RECOVERING, reduced.state.wdRecovering)
                .putLong(KEY_WD_HEALTHY_ACCUM, reduced.state.wdHealthyAccumMs)
            val wdLast = reduced.state.wdLastAttemptElapsedMs
            if (wdLast != null) edit.putLong(KEY_WD_LAST_ELAPSED, wdLast) else edit.remove(KEY_WD_LAST_ELAPSED)
            val wdBoot = reduced.state.wdBootId
            if (wdBoot != null) edit.putLong(KEY_WD_BOOT, wdBoot) else edit.remove(KEY_WD_BOOT)
            val wdHealthyLast = reduced.state.wdHealthyLastElapsedMs
            if (wdHealthyLast != null) edit.putLong(KEY_WD_HEALTHY_LAST, wdHealthyLast) else edit.remove(KEY_WD_HEALTHY_LAST)
            val wdHealthyBoot = reduced.state.wdHealthyBootId
            if (wdHealthyBoot != null) edit.putLong(KEY_WD_HEALTHY_BOOT, wdHealthyBoot) else edit.remove(KEY_WD_HEALTHY_BOOT)
            edit.commit()
        }.getOrDefault(false)
        val t = if (durable) reduced else ConnectivityGuardianCore.withoutUndurableOn(reduced)
        if (!durable) Log.w(TAG, "state checkpoint not written; ON held back until it is")
        state = t.state
        if (before.mode != t.state.mode) Log.i(TAG, "${before.mode} -> ${t.state.mode} (${event.javaClass.simpleName})")
        for (effect in t.effects) {
            when (effect) {
                is Effect.RunOn -> { queued = SeqKind.ON; queuedRecovery = false; startRunner(context, allowAlarmHop = true) }
                is Effect.RunOff -> { queued = SeqKind.OFF; queuedRecovery = false; startRunner(context, allowAlarmHop = true) }
                is Effect.RunShizukuRecovery -> { queued = SeqKind.ON; queuedRecovery = true; startRunner(context, allowAlarmHop = true) }
                is Effect.ArmDebounce -> if (!armDebounce(context, effect.token, effect.delayMs)) {
                    // No alarm is outstanding: the next reconcile (watchdog,
                    // app / service start) re-arms for the remaining budget.
                    state = state?.copy(lossArmed = false)
                }
                is Effect.CancelDebounce -> cancelDebounce(context)
                is Effect.RegisterCallbacks -> ensureRegistered(context)
                is Effect.UnregisterCallbacks -> unregisterAll(context)
                is Effect.ArmShizukuWatchdog -> armShizukuWatchdog(context, effect.delayMs)
                is Effect.CancelShizukuWatchdog -> cancelShizukuWatchdog(context)
                is Effect.NotifyShizukuWatchdogGaveUp -> notifyAssist(context, "shizuku_watchdog_gave_up")
                is Effect.ShizukuWatchdogAudit -> auditShizukuWatchdog(context, effect.event, effect.attempt)
            }
        }
        // Left the resident window (OFF done, toggle off): let the service go.
        if (!ConnectivityGuardianCore.wantsResident(t.state)) ConnectivityGuardianService.stopIfIdle()
    }

    /** The service may stop only when nothing runs or is queued and no OFF
     *  obligation may exist. Called on the main thread by the service. */
    @Synchronized
    fun keepResident(context: Context): Boolean {
        if (activeDrains.get() > 0 || queued != null) return true
        if (!ConnectivityGuardianStore.isOn(context)) return false
        return ConnectivityGuardianCore.wantsResident(currentState(context))
    }

    /** Start residency if it is wanted and the service is not up. Only from
     *  FGS-start-exempt contexts ([exemptNow]: boot, app start), otherwise
     *  through the existing exact-alarm run hop; never a new background start. */
    private fun ensureResident(context: Context, exemptNow: Boolean) {
        if (ConnectivityGuardianService.isRunning()) return
        if (!keepResident(context)) return
        if (exemptNow && ConnectivityGuardianService.start(context)) return
        scheduleRunHop(context)
    }

    /** The queued kind and whether it is a Shizuku watchdog recovery. */
    @Synchronized
    private fun takeQueued(): Pair<SeqKind, Boolean>? {
        val kind = queued ?: return null
        val recovery = queuedRecovery && kind == SeqKind.ON
        queued = null
        queuedRecovery = false
        return Pair(kind, recovery)
    }

    /** The opposite intent arrived while [kind] runs (the core's pending flag). */
    @Synchronized
    fun isSuperseded(kind: SeqKind): Boolean {
        val s = state ?: return false
        return if (kind == SeqKind.ON) {
            s.pending == ConnectivityGuardianCore.Pending.LOSS || s.pending == ConnectivityGuardianCore.Pending.OFF
        } else {
            s.pending == ConnectivityGuardianCore.Pending.ON
        }
    }

    @Synchronized
    private fun nextSeq(context: Context, kind: SeqKind): String {
        val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
        val n = (prefs.getLong(KEY_SEQ, 0L) + 1L) % 1_000_000_000_000L
        prefs.edit().putLong(KEY_SEQ, n).apply()
        return "${kind.wire}-$n"
    }

    /** Runs every queued sequence on the single worker (the guardian lock),
     *  then calls [onIdle]. Safe to call any number of times. [prelude] runs
     *  first on the worker (off the main thread: it may checkpoint state). */
    fun drain(context: Context, prelude: (() -> Unit)? = null, onIdle: () -> Unit) {
        val app = context.applicationContext
        activeDrains.incrementAndGet()
        worker.execute {
            try {
                prelude?.let { p -> runCatching(p) }
                while (true) {
                    val (kind, recovery) = takeQueued() ?: break
                    val seq = nextSeq(app, kind)
                    // The recovery backoff anchor: when the run really started.
                    val start = lossClock(app)
                    val result = runCatching {
                        ConnectivityGuardianCore.runSequence(kind, AndroidPorts(app, kind), memory, seq, recovery)
                    }.getOrElse {
                        Log.w(TAG, "sequence $seq crashed type=${it.javaClass.simpleName}")
                        "failed"
                    }
                    Log.i(TAG, "sequence $seq${if (recovery) " (shizuku watchdog recovery)" else ""} -> $result")
                    // Gate round 2: the gates are read again NOW (STOP-ALL first,
                    // the toggle, Wi-Fi for a recovery), not taken from the
                    // return code; only a recovery that passes them all is
                    // pinged (its success test). A run cut short, or whose gates
                    // fail at completion, is reported stopped / interrupted.
                    val done = ConnectivityGuardianCore.sequenceDoneFor(kind, result, recovery, start, AndroidWatchdogProbes(app))
                    onEvent(app, done)
                }
            } finally {
                activeDrains.decrementAndGet()
                runCatching(onIdle)
            }
        }
    }

    private fun startRunner(context: Context, allowAlarmHop: Boolean) {
        // Resident: run inside the service already in the foreground (no new
        // start). Same monitor as the service's stop decision, so it cannot
        // stop between this check and the drain being counted.
        synchronized(this) {
            if (ConnectivityGuardianService.isRunning()) {
                drain(context) { ConnectivityGuardianService.stopIfIdle() }
                return
            }
        }
        if (ConnectivityGuardianService.start(context)) return
        if (allowAlarmHop && scheduleRunHop(context)) return
        Log.w(TAG, "foreground service unavailable; running the sequence without it")
        drain(context) {}
    }

    // ── Wi-Fi probes and callbacks ───────────────────────────────────────

    /** An underlying Wi-Fi network with INTERNET (not the VPN). Null = cannot tell. */
    @Suppress("DEPRECATION")
    fun isWifiUp(context: Context): Boolean? = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (cm == null) {
            null
        } else {
            cm.allNetworks.any { n ->
                val caps = cm.getNetworkCapabilities(n)
                caps != null &&
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                    !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
        }
    } catch (e: Exception) {
        null
    }

    private fun wifiRequest(): NetworkRequest = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()

    private fun internalIntent(context: Context, action: String): Intent =
        Intent(context, ConnectivityGuardianEventReceiver::class.java).setAction(action).setPackage(context.packageName)

    private fun wifiPendingIntent(context: Context, flags: Int = 0): PendingIntent? = PendingIntent.getBroadcast(
        context, RC_WIFI, internalIntent(context, ACTION_WIFI_AVAILABLE),
        flags or PendingIntent.FLAG_IMMUTABLE,
    )

    /** PendingIntent callback (re-registering the same PendingIntent replaces
     *  the old request), the in-process callback, and the watchdog. */
    fun ensureRegistered(context: Context) {
        val app = context.applicationContext
        try {
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val pi = wifiPendingIntent(app, PendingIntent.FLAG_UPDATE_CURRENT)
            if (pi != null) cm.registerNetworkCallback(wifiRequest(), pi)
        } catch (e: Exception) {
            Log.w(TAG, "wifi PendingIntent callback not registered type=${e.javaClass.simpleName}")
        }
        ensureInProcessCallback(app)
        armWatchdog(app)
    }

    @Synchronized
    private fun ensureInProcessCallback(context: Context) {
        if (inProcessCallback != null) return
        val app = context.applicationContext
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (ConnectivityGuardianStore.isOn(app)) onEvent(app, Event.WifiAvailable)
            }

            override fun onLost(network: Network) {
                // Another Wi-Fi network may still be up (AP switch).
                if (ConnectivityGuardianStore.isOn(app) && isWifiUp(app) == false) onEvent(app, Event.WifiLost(lossClock(app)))
            }
        }
        try {
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.registerNetworkCallback(wifiRequest(), cb)
            inProcessCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "in-process wifi callback not registered type=${e.javaClass.simpleName}")
        }
    }

    @Synchronized
    private fun unregisterAll(context: Context) {
        val app = context.applicationContext
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        inProcessCallback?.let { cb -> runCatching { cm?.unregisterNetworkCallback(cb) } }
        inProcessCallback = null
        val pi = wifiPendingIntent(app, PendingIntent.FLAG_NO_CREATE)
        if (pi != null) {
            runCatching { cm?.unregisterNetworkCallback(pi) }
            pi.cancel()
        }
        alarmPendingIntent(app, ACTION_WATCHDOG, RC_WATCHDOG, 0L, PendingIntent.FLAG_NO_CREATE)?.let { p ->
            runCatching { (app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(p) }
            p.cancel()
        }
        cancelShizukuWatchdog(app)
    }

    // ── Alarms ───────────────────────────────────────────────────────────

    private fun alarmPendingIntent(context: Context, action: String, rc: Int, token: Long, flags: Int): PendingIntent? =
        PendingIntent.getBroadcast(
            context, rc, internalIntent(context, action).putExtra(EXTRA_TOKEN, token),
            flags or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun canExact(am: AlarmManager): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()

    /** Arms (or, same request code, replaces) the debounce alarm on the
     *  monotonic clock. False = not armed. */
    private fun armDebounce(context: Context, token: Long, delayMs: Long): Boolean = try {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = alarmPendingIntent(context, ACTION_DEBOUNCE, RC_DEBOUNCE, token, PendingIntent.FLAG_UPDATE_CURRENT)
        if (pi == null) {
            false
        } else {
            val at = SystemClock.elapsedRealtime() + delayMs
            if (canExact(am)) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "debounce alarm not armed type=${e.javaClass.simpleName}")
        false
    }

    private fun cancelDebounce(context: Context) {
        val pi = alarmPendingIntent(context, ACTION_DEBOUNCE, RC_DEBOUNCE, 0L, PendingIntent.FLAG_NO_CREATE) ?: return
        runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi) }
        pi.cancel()
    }

    /** now+0 exact alarm: receiving it is an FGS-start exemption. */
    private fun scheduleRunHop(context: Context): Boolean = try {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = alarmPendingIntent(context, ACTION_RUN, RC_RUN, 0L, PendingIntent.FLAG_UPDATE_CURRENT)
        if (pi == null || !canExact(am)) {
            false
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime(), pi)
            true
        }
    } catch (e: Exception) {
        false
    }

    private fun armWatchdog(context: Context) {
        try {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = alarmPendingIntent(context, ACTION_WATCHDOG, RC_WATCHDOG, 0L, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + ConnectivityGuardianCore.WATCHDOG_INTERVAL_MS,
                pi,
            )
        } catch (e: Exception) {
            Log.w(TAG, "watchdog alarm not armed type=${e.javaClass.simpleName}")
        }
    }

    /** The Shizuku watchdog tick: same mechanism as the debounce (exact when
     *  allowed, monotonic clock, same request code replaces). False = not armed
     *  (the next reconcile point re-arms it). */
    private fun armShizukuWatchdog(context: Context, delayMs: Long): Boolean = try {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = alarmPendingIntent(context, ACTION_SHIZUKU_WATCHDOG, RC_SHIZUKU_WATCHDOG, 0L, PendingIntent.FLAG_UPDATE_CURRENT)
        if (pi == null) {
            false
        } else {
            val at = SystemClock.elapsedRealtime() + delayMs
            if (canExact(am)) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "shizuku watchdog alarm not armed type=${e.javaClass.simpleName}")
        false
    }

    private fun cancelShizukuWatchdog(context: Context) {
        val pi = alarmPendingIntent(context, ACTION_SHIZUKU_WATCHDOG, RC_SHIZUKU_WATCHDOG, 0L, PendingIntent.FLAG_NO_CREATE) ?: return
        runCatching { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi) }
        pi.cancel()
    }

    private fun auditShizukuWatchdog(context: Context, event: String, attempt: Int) {
        Log.i(TAG, "$event attempt=$attempt")
        val line = ConnectivityGuardianCore.buildShizukuWatchdogAuditLine(isoUtc(System.currentTimeMillis()), event, attempt)
        if (line != null) IngressAuditWriter.append(context, null, ConnectivityGuardianCore.AUDIT_FILE, line)
    }

    // ── Assist notification ──────────────────────────────────────────────

    fun assistText(reason: String): String = when (reason) {
        "grant_missing" -> "Wireless debugging could not be switched: Shelly is missing the WRITE_SECURE_SETTINGS grant. Nothing else was changed."
        "wifi_debug_off_failed" -> "Wireless debugging could not be turned off (or Shelly could not confirm it). Turn it off yourself in Developer options if you need it off."
        "wifi_debug_not_applied" -> "Wireless debugging did not turn on. If Android asks \"Allow wireless debugging on this network?\", decide it yourself in Settings; Shelly never answers it."
        "shizuku_timeout" -> "Shizuku did not start within 90 seconds after wireless debugging came on. Open Shizuku and start it if you need it."
        "tailscale_preapproval_off" -> "Tailscale is not connected, but \"Run ClosePaw without approval\" is off, so Shelly did not connect it. Connect Tailscale yourself if you need it."
        "tailscale_failed" -> "Tailscale could not be connected (or Shelly could not confirm it). Check Tailscale yourself."
        "shizuku_watchdog_gave_up" -> "Shizuku stopped while Wi-Fi stayed connected, and 3 tries to bring it back (switching wireless debugging off and on so Shizuku restarts itself) did not work. Open Shizuku and start it yourself; Shelly tries again after the next Wi-Fi reconnect."
        else -> "Wi-Fi autopilot needs your attention."
    }

    private fun notifyAssist(context: Context, reason: String) {
        try {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(ASSIST_CHANNEL_ID, "Wi-Fi autopilot", NotificationManager.IMPORTANCE_DEFAULT).apply {
                        description = "When the Wi-Fi autopilot could not finish on its own"
                    }
                )
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val tap = launch?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val text = assistText(reason)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, ASSIST_CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            builder
                .setContentTitle("Shelly - Wi-Fi autopilot")
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setAutoCancel(true)
            if (tap != null) builder.setContentIntent(tap)
            nm.notify(ASSIST_NOTIFICATION_ID, builder.build())
        } catch (e: Exception) {
            Log.w(TAG, "assist notification failed type=${e.javaClass.simpleName}")
        }
    }

    // ── Ports ────────────────────────────────────────────────────────────

    private fun isoUtc(ts: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return fmt.format(Date(ts))
    }

    /** The watchdog's observation probes, and (with [enabled]) the
     *  completion-time gates of [ConnectivityGuardianCore.sequenceDoneFor]. */
    private class AndroidWatchdogProbes(private val app: Context) : ConnectivityGuardianCore.CompletionProbes {
        override fun stopAll(): Boolean = ClosePawHandoff.isStopAllOn(app)
        override fun enabled(): Boolean = ConnectivityGuardianStore.isOn(app)
        override fun wifiUp(): Boolean? = ConnectivityGuardian.isWifiUp(app)
        override fun shizukuAlive(): Boolean = ShizukuLiveness.isAlive()
    }

    private class AndroidPorts(private val app: Context, private val kind: SeqKind) : ConnectivityGuardianCore.Ports {
        // Monotonic (TriggerDebouncer contract): budgets survive wall-clock jumps.
        override fun nowMs(): Long = SystemClock.elapsedRealtime()
        override fun sleep(ms: Long) = Thread.sleep(ms)
        override fun enabled(): Boolean = ConnectivityGuardianStore.isOn(app)
        override fun stopAll(): Boolean = ClosePawHandoff.isStopAllOn(app)
        override fun superseded(): Boolean = ConnectivityGuardian.isSuperseded(kind)
        override fun hasWriteSecureSettings(): Boolean = WifiDebugControl.hasGrant(app)
        override fun readAdbWifi(): Int? = WifiDebugControl.read(app)
        override fun writeAdbWifi(value: Int): Boolean = WifiDebugControl.write(app, value)
        override fun shizukuAlive(): Boolean = ShizukuLiveness.isAlive()
        override fun wifiUp(): Boolean? = ConnectivityGuardian.isWifiUp(app)
        override fun vpnUp(): Boolean? = TailscaleControl.isVpnUp(app)
        override fun closePawPreapproved(): Boolean = ClosePawShellPreapproval.isOn(app)
        override fun requestTailscale(): String? = TailscaleControl.requestTailscale(app)
        override fun closePawSettled(reqId: String): Boolean = TailscaleControl.closePawRunSettled(app, reqId)
        override fun audit(seq: String, step: String, action: String, before: String, after: String, outcome: String) {
            val line = ConnectivityGuardianCore.buildAuditLine(ConnectivityGuardian.isoUtc(System.currentTimeMillis()), seq, step, action, before, after, outcome)
            if (line != null) IngressAuditWriter.append(app, null, ConnectivityGuardianCore.AUDIT_FILE, line)
        }
        override fun notifyAssist(reason: String) = ConnectivityGuardian.notifyAssist(app, reason)
    }
}
