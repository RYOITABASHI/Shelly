package expo.modules.terminalemulator

/**
 * Pure decision logic of the Wi-Fi connectivity guardian
 * ("Wi-Fi連動オートパイロット"): the state machine, the ON / OFF step runner,
 * the audit line and the fixed ClosePaw queue line.
 *
 * ZERO android.* imports on purpose (the TriggerDebouncer convention): the
 * Android side (ConnectivityGuardian.kt) feeds it events and implements
 * [Ports]. lib/connectivity-guardian-core.ts is the line-for-line TypeScript
 * port that jest exercises; __tests__/connectivity-guardian-*.test.ts keep
 * the two in lockstep (constants, goals, closed value sets, step order).
 * Change both together.
 *
 * Owner decisions (Phase 2 addendum, 2026-11-17):
 *  - The guardian NEVER starts Shizuku. ON writes adb_wifi_enabled=1 and then
 *    waits (polls pingBinder) for Shizuku's own auto-start, bounded.
 *  - A write that does not take effect (e.g. "Allow wireless debugging on
 *    this network?" is pending) or a ping timeout ends ON with an assist
 *    notification. No dialog is ever accepted; no UI is driven for it.
 *  - Tailscale only through fixed ClosePaw goals while the ClosePaw shell
 *    pre-approval is ON (OFF = notify only). Connected-or-not is decided ONLY
 *    by Shelly's own TRANSPORT_VPN probe, never by ClosePaw's report.
 *  - OFF order: Tailscale first (Shizuku / the VD still up), then
 *    adb_wifi_enabled=0.
 */
object ConnectivityGuardianCore {
    // ── Constants (lockstep with lib/connectivity-guardian-core.ts) ──
    const val LOSS_DEBOUNCE_MS = 45_000L
    const val SHIZUKU_WAIT_MS = 90_000L
    const val SHIZUKU_POLL_MS = 3_000L
    const val SHIZUKU_RETRY_COOLDOWN_MS = 120_000L
    const val ADB_WIFI_VERIFY_MS = 6_000L
    const val ADB_WIFI_POLL_MS = 1_000L
    const val VPN_VERIFY_MS = 180_000L
    const val VPN_POLL_MS = 3_000L
    const val WATCHDOG_INTERVAL_MS = 15L * 60_000L
    /** A dispatched ClosePaw request must SETTLE (terminal run state) before
     *  the sequence that dispatched it may end, for any reason; bounded,
     *  counted from the dispatch. Sequencing only: never decides success. */
    const val CLOSEPAW_SETTLE_MS = 300_000L
    const val CLOSEPAW_SETTLE_POLL_MS = 2_000L
    const val AUDIT_FILE = "connectivity-guardian.jsonl"
    const val AUDIT_KIND = "wifi_guardian"
    const val GOAL_MAX_CODE_POINTS = 2000

    // ── Fixed ClosePaw goals (code constants, single line, never user input) ──
    const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    const val GOAL_TAILSCALE_CONNECT =
        "Shelly connectivity guardian, fixed task: connect Tailscale. Open the Tailscale app (package com.tailscale.ipn) with the open_app tool. If the screen already shows that Tailscale is connected, change nothing and stop. Otherwise tap the control that connects Tailscale (the main on/off switch or the Connect button) exactly once, then wait a few seconds. Never accept, allow or confirm any VPN-permission, connection-request, login, sign-in or account dialog: if one appears, stop at once and report it. Do not open any other app and do not change any other setting. Report the connection state shown before and after."
    const val GOAL_TAILSCALE_DISCONNECT =
        "Shelly connectivity guardian, fixed task: disconnect Tailscale. Open the Tailscale app (package com.tailscale.ipn) with the open_app tool. If the screen already shows that Tailscale is disconnected, change nothing and stop. Otherwise tap the control that disconnects Tailscale (the main on/off switch or the Disconnect button) exactly once, then wait a few seconds. Never accept, allow or confirm any VPN-permission, connection-request, login, sign-in or account dialog: if one appears, stop at once and report it. Do not open any other app and do not change any other setting. Report the connection state shown before and after."

    fun goalFor(connect: Boolean): String = if (connect) GOAL_TAILSCALE_CONNECT else GOAL_TAILSCALE_DISCONNECT

    // ── State machine ──
    enum class Mode { DISABLED, IDLE_OFFLINE, IDLE_ONLINE, ON_RUNNING, LOSS_PENDING, OFF_RUNNING }
    /** NONE; ON = Wi-Fi came back during OFF, or (in LOSS_PENDING) ON must
     *  run again when Wi-Fi returns (it was interrupted, or the device
     *  rebooted); LOSS = Wi-Fi lost during ON (debounce already armed);
     *  OFF = that debounce expired during ON. */
    enum class Pending { NONE, ON, LOSS, OFF }
    enum class SeqKind(val wire: String) { ON("on"), OFF("off") }

    /** [lossAtMs]: wall-clock instant of the loss the current token
     *  debounces; persisted, informational, and the one-time fallback basis
     *  for a loss written by an older build. [lossElapsedMs]: monotonic
     *  anchor (elapsedRealtime at the loss, persisted): the deadline is
     *  lossElapsedMs + LOSS_DEBOUNCE_MS on boot [lossBootId]; recovery uses
     *  only this, the wall clock cannot move it (coordinator gate round 3);
     *  null = older build's state. [lossBootId]: Settings.Global.BOOT_COUNT
     *  at the loss; null with an anchor = boot unknown (recovery expires).
     *  [lossArmed]: in-process only, never persisted: this process armed the
     *  alarm for [lossToken] and it has not fired; a fresh process starts
     *  without it. */
    data class State(
        val mode: Mode,
        val lossToken: Long,
        val pending: Pending,
        val lossAtMs: Long? = null,
        val lossArmed: Boolean = false,
        val lossElapsedMs: Long? = null,
        val lossBootId: Long? = null,
    )

    /** A recovery-grade reading of "now": wall clock (informational, legacy
     *  fallback), elapsedRealtime (monotonic, resets on reboot) and the boot
     *  identity (null = unknown). */
    data class LossClock(val wallMs: Long, val elapsedMs: Long, val bootId: Long?)

    sealed class Event {
        data class Enable(val wifiUp: Boolean) : Event()
        object Disable : Event()
        /** now (here and on WifiLost / Reconcile): the loss anchor's basis. */
        data class Boot(val enabled: Boolean, val wifiUp: Boolean, val now: LossClock) : Event()
        object WifiAvailable : Event()
        data class WifiLost(val now: LossClock) : Event()
        data class DebounceExpired(val token: Long, val wifiUp: Boolean) : Event()
        /** interrupted = the runner returned "superseded" (stopped before its last step). */
        data class SequenceDone(val kind: SeqKind, val interrupted: Boolean = false) : Event()
        /** A recovery entry point (app start, watchdog, service start) probed
         *  Wi-Fi: bring the state in line with it. */
        data class Reconcile(val wifiUp: Boolean, val now: LossClock) : Event()
    }

    sealed class Effect {
        object RunOn : Effect()
        object RunOff : Effect()
        data class ArmDebounce(val token: Long, val delayMs: Long) : Effect()
        object CancelDebounce : Effect()
        object RegisterCallbacks : Effect()
        object UnregisterCallbacks : Effect()
    }

    data class Transition(val state: State, val effects: List<Effect>)

    fun initialState(enabled: Boolean): State =
        State(if (enabled) Mode.IDLE_OFFLINE else Mode.DISABLED, 0L, Pending.NONE)

    /** What survives a process death (plain prefs, nothing sensitive). An
     *  ON that already saw the loss is stored as the pending loss (alarm
     *  armed). Any other running sequence is stored as "in_flight": its
     *  writes (adb_wifi_enabled=1, a Tailscale hand-off) may have landed, so
     *  cleanup or a rerun is owed and every recovery entry point reconciles
     *  it against Wi-Fi (Reconcile / Boot). */
    fun persistableMode(state: State): String = if (state.mode == Mode.ON_RUNNING && (state.pending == Pending.LOSS || state.pending == Pending.OFF)) {
        "loss_pending_on"
    } else if (state.mode == Mode.LOSS_PENDING && state.pending == Pending.ON) {
        "loss_pending_on"
    } else if (state.mode == Mode.ON_RUNNING || state.mode == Mode.OFF_RUNNING || (state.mode == Mode.IDLE_ONLINE && state.pending == Pending.ON)) {
        "in_flight"
    } else when (state.mode) {
        Mode.IDLE_ONLINE -> "idle_online"
        Mode.LOSS_PENDING -> "loss_pending"
        Mode.DISABLED -> "disabled"
        else -> "idle_offline"
    }

    /** Fresh process: the toggle mirror decides first (unreadable = OFF). The
     *  restored state never has [State.lossArmed]: no alarm is assumed. */
    fun restoreState(
        enabled: Boolean,
        persisted: String?,
        lossToken: Long,
        lossAtMs: Long? = null,
        lossElapsedMs: Long? = null,
        lossBootId: Long? = null,
    ): State = when {
        !enabled -> initialState(false)
        persisted == "idle_online" -> State(Mode.IDLE_ONLINE, lossToken, Pending.NONE)
        persisted == "loss_pending" ->
            State(Mode.LOSS_PENDING, lossToken, Pending.NONE, lossAtMs, lossElapsedMs = lossElapsedMs, lossBootId = lossBootId?.takeIf { lossElapsedMs != null })
        persisted == "loss_pending_on" ->
            State(Mode.LOSS_PENDING, lossToken, Pending.ON, lossAtMs, lossElapsedMs = lossElapsedMs, lossBootId = lossBootId?.takeIf { lossElapsedMs != null })
        // Unfinished work: online-with-ON-owed. Wi-Fi present -> ON reruns;
        // absent -> the loss is armed (OFF cleanup), ON again on regain.
        persisted == "in_flight" -> State(Mode.IDLE_ONLINE, lossToken, Pending.ON)
        else -> State(Mode.IDLE_OFFLINE, lossToken, Pending.NONE)
    }

    /** The foreground service stays resident exactly while an OFF obligation
     *  may exist (online after ON, the loss debounce, a running sequence), so
     *  the in-process loss callback is live and the debounce starts at the
     *  real loss. Not while idle offline or disabled. */
    fun wantsResident(s: State): Boolean =
        s.mode == Mode.IDLE_ONLINE || s.mode == Mode.LOSS_PENDING || s.mode == Mode.ON_RUNNING || s.mode == Mode.OFF_RUNNING

    /** The state write did not reach disk. ON must not mutate anything
     *  without a durable "in_flight" record, so RunOn is dropped and ON stays
     *  owed in memory (online, pending ON: the next Wi-Fi callback or
     *  reconcile retries, and checkpoints again). Every other effect stays:
     *  OFF is the cleanup itself. */
    fun withoutUndurableOn(t: Transition): Transition =
        if (t.effects.none { it is Effect.RunOn }) t
        else Transition(cleared(t.state).copy(mode = Mode.IDLE_ONLINE, pending = Pending.ON), t.effects.filter { it !is Effect.RunOn })

    /** The alarm fired (or was given up): nothing is outstanding any more.
     *  The anchor stays (a restored pending OFF still knows its deadline passed). */
    private fun disarmed(s: State): State = s.copy(lossArmed = false)

    /** The loss was cancelled (Wi-Fi back, toggle off): no deadline remains. */
    private fun cleared(s: State): State = s.copy(lossAtMs = null, lossArmed = false, lossElapsedMs = null, lossBootId = null)

    private fun startOn(s: State): Transition =
        Transition(s.copy(mode = Mode.ON_RUNNING, pending = Pending.NONE), listOf(Effect.RunOn))

    /** [s] anchored to a loss whose remaining budget at [now] is
     *  [remainingMs]: the monotonic instant that leaves exactly that budget,
     *  on this boot. */
    private fun withLossAnchor(s: State, now: LossClock, remainingMs: Long): State {
        val spent = LOSS_DEBOUNCE_MS - remainingMs
        return s.copy(lossAtMs = now.wallMs - spent, lossElapsedMs = now.elapsedMs - spent, lossBootId = now.bootId)
    }

    /** A NEW loss event: the only place (with ON_RUNNING's loss) the token
     *  increments; the deadline is anchored at [now]. */
    private fun armLoss(s: State, now: LossClock, rerunOn: Boolean = false): Transition {
        val token = s.lossToken + 1
        return Transition(
            withLossAnchor(State(Mode.LOSS_PENDING, token, if (rerunOn) Pending.ON else Pending.NONE, lossArmed = true), now, LOSS_DEBOUNCE_MS),
            listOf(Effect.ArmDebounce(token, LOSS_DEBOUNCE_MS)),
        )
    }

    /** Wall-clock remaining budget, clamped to [0, LOSS_DEBOUNCE_MS]. Only the
     *  one-time fallback for a loss without a monotonic anchor (older build). */
    fun lossRemainingMs(lossAtMs: Long, nowMs: Long): Long =
        minOf(LOSS_DEBOUNCE_MS, maxOf(0L, lossAtMs + LOSS_DEBOUNCE_MS - nowMs))

    /** Monotonic remaining budget: LOSS_DEBOUNCE_MS - (elapsedNow -
     *  elapsedAtLoss), clamped to [0, LOSS_DEBOUNCE_MS]. The wall clock is not
     *  consulted. 0 (expire now) when the boot differs or either boot is
     *  unknown (elapsedRealtime restarted, so the time since the loss cannot
     *  be established), and when the monotonic clock reads earlier than the
     *  loss (inconsistent: same treatment). */
    fun lossMonotonicRemainingMs(lossElapsedMs: Long, lossBootId: Long?, now: LossClock): Long {
        if (lossBootId == null || now.bootId == null || lossBootId != now.bootId) return 0L
        val elapsed = now.elapsedMs - lossElapsedMs
        if (elapsed < 0L) return 0L
        return minOf(LOSS_DEBOUNCE_MS, maxOf(0L, LOSS_DEBOUNCE_MS - elapsed))
    }

    /** Recovery of an EXISTING loss (LOSS_PENDING, Wi-Fi still absent). Never
     *  a new token, never a fresh budget:
     *   - alarm armed by this process and not fired: change nothing (the
     *     in-process alarm runs on the monotonic clock; wall time is not used);
     *   - alarm missing (fresh process, consumed, never armed): re-arm the SAME
     *     token for the monotonic remaining budget (same boot only), or expire
     *     now if it is spent, the device rebooted since the loss, or the boot
     *     cannot be identified (coordinator gate round 3);
     *   - no monotonic anchor (state from an older build): one wall-clock
     *     fallback, clamped to [0, LOSS_DEBOUNCE_MS], and the monotonic anchor
     *     for that deadline is stamped now, so every later recovery is monotonic;
     *   - no anchor at all: anchor it now, once. */
    private fun recoverLoss(s: State, now: LossClock): Transition {
        if (s.lossArmed) return Transition(s, emptyList())
        val remaining: Long
        val base: State
        val monotonic = s.lossElapsedMs
        if (monotonic != null) {
            remaining = lossMonotonicRemainingMs(monotonic, s.lossBootId, now)
            base = s
        } else {
            remaining = s.lossAtMs?.let { lossRemainingMs(it, now.wallMs) } ?: LOSS_DEBOUNCE_MS
            base = withLossAnchor(s, now, remaining)
        }
        if (remaining <= 0L) return reduce(base, Event.DebounceExpired(s.lossToken, false))
        return Transition(base.copy(lossArmed = true), listOf(Effect.ArmDebounce(s.lossToken, remaining)))
    }

    /** The design's state machine (wifi-guardian-design.md "State machine"). */
    fun reduce(s: State, e: Event): Transition {
        val same = Transition(s, emptyList())
        if (e is Event.Disable) {
            return Transition(State(Mode.DISABLED, s.lossToken, Pending.NONE), listOf(Effect.CancelDebounce, Effect.UnregisterCallbacks))
        }
        if (e is Event.Enable) {
            if (s.mode != Mode.DISABLED) return same
            val base = s.copy(mode = Mode.IDLE_OFFLINE, pending = Pending.NONE)
            if (!e.wifiUp) return Transition(base, listOf(Effect.RegisterCallbacks))
            val t = startOn(base)
            return Transition(t.state, listOf<Effect>(Effect.RegisterCallbacks) + t.effects)
        }
        if (e is Event.Boot) {
            if (!e.enabled) return Transition(initialState(false), emptyList())
            if (!e.wifiUp) {
                // Rebooted / updated away from Wi-Fi after an ON, or during the
                // debounce (the alarm did not survive): (re)arm the loss.
                // A reboot / update also took Shizuku down: ON must run again on regain.
                if (s.mode == Mode.IDLE_ONLINE) {
                    val t = armLoss(s, e.now, true)
                    return Transition(t.state, listOf<Effect>(Effect.RegisterCallbacks) + t.effects)
                }
                if (s.mode == Mode.LOSS_PENDING) {
                    // The loss predates this start (no alarm survived): keep its deadline
                    // on the same boot; after a real reboot it is expired (OFF now).
                    val t = recoverLoss(disarmed(s).copy(pending = Pending.ON), e.now)
                    return Transition(t.state, listOf<Effect>(Effect.RegisterCallbacks) + t.effects)
                }
                return Transition(s, listOf(Effect.RegisterCallbacks))
            }
            if (s.mode == Mode.ON_RUNNING || s.mode == Mode.OFF_RUNNING) {
                return Transition(s.copy(pending = Pending.ON), listOf(Effect.RegisterCallbacks))
            }
            val t = startOn(cleared(s))
            return Transition(t.state, listOf<Effect>(Effect.RegisterCallbacks, Effect.CancelDebounce) + t.effects)
        }
        if (s.mode == Mode.DISABLED) return same
        if (e is Event.Reconcile) {
            // Recovery cannot assume the debounce alarm still exists (it fired
            // before a process death, or the process died between the
            // checkpoint and arming it), but it must not restart the budget
            // either: the loss keeps its deadline and token (coordinator gate
            // round 2).
            if (!e.wifiUp && s.mode == Mode.LOSS_PENDING) return recoverLoss(s, e.now)
            return reduce(s, if (e.wifiUp) Event.WifiAvailable else Event.WifiLost(e.now))
        }

        return when (e) {
            is Event.WifiAvailable -> when (s.mode) {
                Mode.IDLE_OFFLINE -> startOn(s)
                // Unfinished work restored after a process death: finish ON.
                Mode.IDLE_ONLINE -> if (s.pending == Pending.ON) startOn(s) else same
                // AP switch / momentary drop: cancel; nothing runs unless ON was
                // left unfinished (then it runs again; every step is idempotent).
                Mode.LOSS_PENDING ->
                    if (s.pending == Pending.ON) startOn(cleared(s)).let { t -> Transition(t.state, listOf<Effect>(Effect.CancelDebounce) + t.effects) }
                    else Transition(cleared(s).copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE), listOf(Effect.CancelDebounce))
                Mode.ON_RUNNING ->
                    if (s.pending == Pending.LOSS || s.pending == Pending.OFF) Transition(cleared(s).copy(pending = Pending.NONE), listOf(Effect.CancelDebounce))
                    else same
                Mode.OFF_RUNNING -> Transition(s.copy(pending = Pending.ON), emptyList())
                else -> same
            }
            is Event.WifiLost -> when (s.mode) {
                Mode.IDLE_ONLINE -> armLoss(s, e.now, s.pending == Pending.ON)
                // The debounce counts from the loss itself; ON stops after its
                // current step (superseded) and never interleaves with OFF.
                Mode.ON_RUNNING ->
                    if (s.pending == Pending.LOSS || s.pending == Pending.OFF) same
                    else (s.lossToken + 1).let { token ->
                        Transition(
                            withLossAnchor(s.copy(lossToken = token, pending = Pending.LOSS, lossArmed = true), e.now, LOSS_DEBOUNCE_MS),
                            listOf(Effect.ArmDebounce(token, LOSS_DEBOUNCE_MS)),
                        )
                    }
                Mode.OFF_RUNNING -> Transition(s.copy(pending = Pending.NONE), emptyList())
                else -> same
            }
            is Event.DebounceExpired -> when {
                e.token != s.lossToken -> same
                s.mode == Mode.ON_RUNNING && s.pending == Pending.LOSS ->
                    if (e.wifiUp) Transition(cleared(s).copy(pending = Pending.NONE), emptyList())
                    else Transition(disarmed(s).copy(pending = Pending.OFF), emptyList())
                s.mode != Mode.LOSS_PENDING -> same
                e.wifiUp ->
                    if (s.pending == Pending.ON) startOn(cleared(s))
                    else Transition(cleared(s).copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE), emptyList())
                else -> Transition(cleared(s).copy(mode = Mode.OFF_RUNNING, pending = Pending.NONE), listOf(Effect.RunOff))
            }
            is Event.SequenceDone -> when {
                e.kind == SeqKind.ON && s.mode == Mode.ON_RUNNING ->
                    when (s.pending) {
                        // ON may have stopped early (superseded): remember to run it again.
                        Pending.LOSS -> Transition(s.copy(mode = Mode.LOSS_PENDING, pending = Pending.ON), emptyList())
                        Pending.OFF -> Transition(cleared(s).copy(mode = Mode.OFF_RUNNING, pending = Pending.NONE), listOf(Effect.RunOff))
                        // Stopped early, but Wi-Fi is already back: finish it.
                        else -> if (e.interrupted) startOn(s)
                        else Transition(s.copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE), emptyList())
                    }
                e.kind == SeqKind.OFF && s.mode == Mode.OFF_RUNNING ->
                    if (s.pending == Pending.ON) startOn(s)
                    // Stopped early, but Wi-Fi is gone again: finish it.
                    else if (e.interrupted) Transition(s.copy(mode = Mode.OFF_RUNNING, pending = Pending.NONE), listOf(Effect.RunOff))
                    else Transition(s.copy(mode = Mode.IDLE_OFFLINE, pending = Pending.NONE), emptyList())
                else -> same
            }
            else -> same
        }
    }

    // ── Step runner ──
    // Closed value sets (lockstep with the TS STEPS / ACTIONS / LEVELS / OUTCOMES / ASSIST_REASONS).
    val STEPS: List<String> = listOf("wifi_debug", "shizuku", "tailscale", "sequence")
    val ACTIONS: List<String> = listOf("check", "enable", "disable", "wait", "connect", "disconnect", "end")
    val LEVELS: List<String> = listOf("on", "off", "unknown", "none")
    val OUTCOMES: List<String> = listOf(
        "already", "ok", "unverified", "not_applied", "grant_missing", "write_failed", "timeout", "cooldown",
        "probe_unknown", "preapproval_off", "dispatch_failed", "verify_failed", "stopped", "disabled", "superseded",
        "done", "assist", "failed", "settled", "settle_timeout",
    )
    /** ClosePaw run states (ClosePawRunResults) that end a run: completion
     *  tracking for sequencing only, never success. */
    val CLOSEPAW_SETTLED_STATUSES: List<String> = listOf(
        "completed", "failed", "cancelled", "timeout", "uncertain", "lost", "rejected", "expired",
    )

    fun isClosePawSettled(status: String?): Boolean = status != null && status in CLOSEPAW_SETTLED_STATUSES
    val ASSIST_REASONS: List<String> = listOf(
        "grant_missing", "wifi_debug_not_applied", "wifi_debug_off_failed", "shizuku_timeout", "tailscale_preapproval_off",
        "tailscale_failed",
    )

    interface Ports {
        fun nowMs(): Long
        fun sleep(ms: Long)
        /** Toggle mirror readable and ON (unreadable = false). */
        fun enabled(): Boolean
        /** STOP-ALL (`.halted`); unreadable = true. */
        fun stopAll(): Boolean
        /** The opposite intent arrived (Wi-Fi lost during ON / back during
         *  OFF): finish the current step, start no new one. */
        fun superseded(): Boolean
        fun hasWriteSecureSettings(): Boolean
        /** adb_wifi_enabled: 1 / 0, or null when it cannot be read. */
        fun readAdbWifi(): Int?
        fun writeAdbWifi(value: Int): Boolean
        /** Shizuku.pingBinder(); any error = false. */
        fun shizukuAlive(): Boolean
        /** TRANSPORT_VPN present: true / false, or null when it cannot be told. */
        fun vpnUp(): Boolean?
        /** ClosePawShellPreapproval.isOn(). */
        fun closePawPreapproved(): Boolean
        /** The single seam (TailscaleControl.requestTailscale). The request id
         *  when handed off, else null. Its answer never passes a step: only
         *  [vpnUp] does. */
        fun requestTailscale(connect: Boolean): String?
        /** The ClosePaw run for [reqId] reached a terminal state
         *  ([isClosePawSettled]); unreadable = false. Sequencing only. */
        fun closePawSettled(reqId: String): Boolean
        fun audit(seq: String, step: String, action: String, before: String, after: String, outcome: String)
        fun notifyAssist(reason: String)
    }

    /** Cross-run memory of the runner (in-process only). */
    class RunnerMemory {
        @Volatile var lastShizukuTimeoutAt: Long? = null
    }

    private fun gate(p: Ports): String = when {
        !p.enabled() -> "disabled"
        p.stopAll() -> "stopped"
        p.superseded() -> "superseded"
        else -> "go"
    }

    private fun isAbort(g: String): Boolean = g == "stopped" || g == "disabled" || g == "superseded"

    private fun adbLevel(v: Int?): String = when (v) {
        null -> "unknown"
        1 -> "on"
        else -> "off"
    }

    private fun vpnLevel(v: Boolean?): String = when (v) {
        null -> "unknown"
        true -> "on"
        false -> "off"
    }

    /** Polls [probe] every [pollMs] until true or [budgetMs] passed; stops
     *  early (returning the gate) when the toggle goes off / STOP-ALL. */
    private fun pollUntil(p: Ports, budgetMs: Long, pollMs: Long, probe: () -> Boolean): String {
        val start = p.nowMs()
        while (true) {
            if (probe()) return "ok"
            if (p.nowMs() - start >= budgetMs) return "timeout"
            val g = gate(p)
            if (g != "go") return g
            p.sleep(pollMs)
        }
    }

    private class Run(val p: Ports, val seq: String) {
        var notified = false
        fun audit(step: String, action: String, before: String, after: String, outcome: String) =
            p.audit(seq, step, action, before, after, outcome)
        fun assist(reason: String) {
            if (notified) return
            notified = true
            p.notifyAssist(reason)
        }
        fun end(result: String): String {
            audit("sequence", "end", "none", "none", result)
            return result
        }
        /** Checked before every step: null = go, else the reason (audited). */
        fun gated(step: String): String? {
            val g = gate(p)
            if (g == "go") return null
            audit(step, "check", "none", "none", g)
            return g
        }
    }

    /** ON: wireless debugging -> wait for Shizuku -> Tailscale. Result is one
     *  of done / assist / failed / stopped / disabled / superseded. */
    fun runOnSequence(p: Ports, mem: RunnerMemory, seq: String): String {
        val r = Run(p, seq)

        // 1. Wireless debugging.
        r.gated("wifi_debug")?.let { return r.end(it) }
        val adbBefore = p.readAdbWifi()
        if (adbBefore == 1) {
            r.audit("wifi_debug", "check", "on", "on", "already")
        } else {
            if (!p.hasWriteSecureSettings()) {
                r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(adbBefore), "grant_missing")
                r.assist("grant_missing")
                return r.end("assist")
            }
            if (!p.writeAdbWifi(1)) {
                r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(p.readAdbWifi()), "write_failed")
                r.assist("wifi_debug_not_applied")
                return r.end("assist")
            }
            var last: Int? = null
            val verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS) {
                last = p.readAdbWifi()
                last == 1
            }
            when {
                isAbort(verified) -> {
                    r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(last), verified)
                    return r.end(verified)
                }
                verified == "ok" -> r.audit("wifi_debug", "enable", adbLevel(adbBefore), "on", "ok")
                // The hidden key cannot be read back: the Shizuku wait is the check.
                last == null -> r.audit("wifi_debug", "enable", adbLevel(adbBefore), "unknown", "unverified")
                else -> {
                    // Did not take effect (e.g. the network-trust dialog is
                    // pending). Never accept it: stop and tell the owner.
                    r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(last), "not_applied")
                    r.assist("wifi_debug_not_applied")
                    return r.end("assist")
                }
            }
        }

        // 2. Shizuku: never started by the guardian; wait for its own auto-start.
        r.gated("shizuku")?.let { return r.end(it) }
        if (p.shizukuAlive()) {
            mem.lastShizukuTimeoutAt = null
            r.audit("shizuku", "check", "on", "on", "already")
        } else {
            val lastTimeout = mem.lastShizukuTimeoutAt
            if (lastTimeout != null && p.nowMs() - lastTimeout < SHIZUKU_RETRY_COOLDOWN_MS) {
                r.audit("shizuku", "wait", "off", "off", "cooldown")
                return r.end("assist")
            }
            val waited = pollUntil(p, SHIZUKU_WAIT_MS, SHIZUKU_POLL_MS) { p.shizukuAlive() }
            if (isAbort(waited)) {
                r.audit("shizuku", "wait", "off", "off", waited)
                return r.end(waited)
            }
            if (waited == "timeout") {
                mem.lastShizukuTimeoutAt = p.nowMs()
                r.audit("shizuku", "wait", "off", "off", "timeout")
                r.assist("shizuku_timeout")
                return r.end("assist")
            }
            mem.lastShizukuTimeoutAt = null
            r.audit("shizuku", "wait", "off", "on", "ok")
        }

        // 3. Tailscale.
        val t = tailscaleStep(r, true)
        return r.end(t ?: "done")
    }

    /** OFF: Tailscale disconnect first (VD still up), then wireless debugging. */
    fun runOffSequence(p: Ports, seq: String): String {
        val r = Run(p, seq)
        tailscaleStep(r, false)?.let { return r.end(it) }

        r.gated("wifi_debug")?.let { return r.end(it) }
        val adbBefore = p.readAdbWifi()
        if (adbBefore == 0) {
            r.audit("wifi_debug", "check", "off", "off", "already")
            return r.end("done")
        }
        if (!p.hasWriteSecureSettings()) {
            r.audit("wifi_debug", "disable", adbLevel(adbBefore), adbLevel(adbBefore), "grant_missing")
            r.assist("grant_missing")
            return r.end("assist")
        }
        if (!p.writeAdbWifi(0)) {
            r.audit("wifi_debug", "disable", adbLevel(adbBefore), adbLevel(p.readAdbWifi()), "write_failed")
            r.assist("wifi_debug_off_failed")
            return r.end("failed")
        }
        var last: Int? = null
        val verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS) {
            last = p.readAdbWifi()
            last == 0
        }
        if (isAbort(verified)) {
            r.audit("wifi_debug", "disable", adbLevel(adbBefore), adbLevel(last), verified)
            return r.end(verified)
        }
        if (verified == "ok") {
            r.audit("wifi_debug", "disable", adbLevel(adbBefore), "off", "ok")
            return r.end("done")
        }
        if (last == null) {
            // Cannot confirm it is off: tell the owner (no Shizuku check stands in here).
            r.audit("wifi_debug", "disable", adbLevel(adbBefore), "unknown", "unverified")
            r.assist("wifi_debug_off_failed")
            return r.end("assist")
        }
        r.audit("wifi_debug", "disable", adbLevel(adbBefore), adbLevel(last), "verify_failed")
        r.assist("wifi_debug_off_failed")
        return r.end("failed")
    }

    /** Returns null when the step passed (or was already in place). */
    private fun tailscaleStep(r: Run, connect: Boolean): String? {
        val p = r.p
        r.gated("tailscale")?.let { return it }
        val action = if (connect) "connect" else "disconnect"
        val before = p.vpnUp()
        if (before == connect) {
            r.audit("tailscale", "check", vpnLevel(before), vpnLevel(before), "already")
            return null
        }
        if (before == null) {
            r.audit("tailscale", "check", "unknown", "unknown", "probe_unknown")
            return "failed"
        }
        if (!p.closePawPreapproved()) {
            // OFF -> never dispatch; tell the owner what is down.
            r.audit("tailscale", action, vpnLevel(before), vpnLevel(before), "preapproval_off")
            r.assist("tailscale_preapproval_off")
            return "assist"
        }
        val reqId = p.requestTailscale(connect)
        if (reqId == null) {
            r.audit("tailscale", action, vpnLevel(before), vpnLevel(p.vpnUp()), "dispatch_failed")
            r.assist("tailscale_failed")
            return "assist"
        }
        val dispatchedAt = p.nowMs()
        // Whatever ends the step (ok, superseded, toggle off, STOP-ALL,
        // verify failure, even an exception), the hand-off must settle first:
        // the next sequence must never act against a ClosePaw run in flight.
        try {
            return verifyTailscale(r, connect, action, before)
        } finally {
            awaitSettle(r, reqId, dispatchedAt)
        }
    }

    private fun verifyTailscale(r: Run, connect: Boolean, action: String, before: Boolean?): String? {
        val p = r.p
        var last: Boolean? = before
        val verified = pollUntil(p, VPN_VERIFY_MS, VPN_POLL_MS) {
            last = p.vpnUp()
            last == connect
        }
        if (isAbort(verified)) {
            r.audit("tailscale", action, vpnLevel(before), vpnLevel(last), verified)
            return verified
        }
        if (verified == "ok") {
            r.audit("tailscale", action, vpnLevel(before), vpnLevel(connect), "ok")
            return null
        }
        r.audit("tailscale", action, vpnLevel(before), vpnLevel(last), "verify_failed")
        r.assist("tailscale_failed")
        return "failed"
    }

    /** Waits (no gate: toggle off / STOP-ALL / superseded do not cut it
     *  short) until the ClosePaw run settled or [CLOSEPAW_SETTLE_MS] passed
     *  since the dispatch. */
    private fun awaitSettle(r: Run, reqId: String, dispatchedAt: Long) {
        val p = r.p
        while (true) {
            if (p.closePawSettled(reqId)) {
                val v = vpnLevel(p.vpnUp())
                r.audit("tailscale", "wait", v, v, "settled")
                return
            }
            if (p.nowMs() - dispatchedAt >= CLOSEPAW_SETTLE_MS) {
                val v = vpnLevel(p.vpnUp())
                r.audit("tailscale", "wait", v, v, "settle_timeout")
                return
            }
            p.sleep(CLOSEPAW_SETTLE_POLL_MS)
        }
    }

    /** Runs one whole sequence (exactly one `end` audit line). */
    fun runSequence(kind: SeqKind, p: Ports, mem: RunnerMemory, seq: String): String =
        if (kind == SeqKind.ON) runOnSequence(p, mem, seq) else runOffSequence(p, seq)

    // ── Audit line ──
    val AUDIT_KEYS: List<String> = listOf("ts", "kind", "seq", "step", "action", "before", "after", "outcome")
    private val TS_RE = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")
    val SEQ_RE = Regex("^(on|off)-[0-9]{1,12}$")

    /** One JSON line, fixed keys, closed values only (no SSID / BSSID / free
     *  text). Every value matches [a-z0-9_:.TZ-], so no escaping is needed. */
    fun buildAuditLine(tsIso: String, seq: String, step: String, action: String, before: String, after: String, outcome: String): String? {
        if (!TS_RE.matches(tsIso) || !SEQ_RE.matches(seq)) return null
        if (step !in STEPS || action !in ACTIONS) return null
        if (before !in LEVELS || after !in LEVELS || outcome !in OUTCOMES) return null
        return "{\"ts\":\"$tsIso\",\"kind\":\"$AUDIT_KIND\",\"seq\":\"$seq\",\"step\":\"$step\"," +
            "\"action\":\"$action\",\"before\":\"$before\",\"after\":\"$after\",\"outcome\":\"$outcome\"}"
    }

    // ── ClosePaw queue line ──
    private const val KEEP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

    /** Strict JS encodeURIComponent (byte-for-byte with the TS port). */
    fun encodeUriComponent(s: String): String {
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val v = b.toInt() and 0xff
            if (v < 0x80 && KEEP.indexOf(v.toChar()) >= 0) out.append(v.toChar())
            else out.append('%').append("%02X".format(v))
        }
        return out.toString()
    }

    val REQ_ID_RE = Regex("^[0-9]{10,16}-[0-9a-f]{8}$")

    /** `closepaw:<reqId>:<nowMs>:<encodeURIComponent(goal)>`, the format
     *  ClosePawHandoff.parseLine accepts. */
    fun closePawLine(reqId: String, nowMs: Long, goal: String): String? {
        if (!REQ_ID_RE.matches(reqId)) return null
        return "closepaw:$reqId:$nowMs:${encodeUriComponent(goal)}"
    }
}
