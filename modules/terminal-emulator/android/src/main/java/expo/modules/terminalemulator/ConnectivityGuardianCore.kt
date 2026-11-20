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
 *  - Tailscale is connect-only (owner decision 2026-11-17): it stays
 *    connected after Wi-Fi is lost, mobile data included. OFF only writes
 *    adb_wifi_enabled=0; it never touches Tailscale or dispatches ClosePaw.
 *
 * Shizuku watchdog (owner direction 2026-11-20, after One UI's battery
 * management killed the Shizuku server while Wi-Fi stayed up and no
 * connectivity event fired): while the guardian is settled online, a
 * 15-minute tick (and every reconcile / Wi-Fi-available point) observes
 * Shizuku's liveness ([observeShizukuWatchdog]: STOP-ALL first). Dead ->
 * re-run the ON sequence as a recovery ([Effect.RunShizukuRecovery]: the
 * same runner, wireless debugging cycled OFF -> ON when it is already on, so
 * Shizuku's OWN auto-start sees a fresh trigger). Still never starts Shizuku.
 * At most [SHIZUKU_WATCHDOG_MAX_ATTEMPTS] recovery starts per Wi-Fi session,
 * [SHIZUKU_WATCHDOG_BACKOFF_MS] apart (start to start); then one give-up
 * notification and silence until the session resets. The count is monotonic
 * within a session (gate round 1, 2026-11-20): a success does not reset it and
 * a healthy tick does not revive a given-up session; only a Wi-Fi reconnect, a
 * guardian re-enable, a boot, or 24 h of OBSERVED health (gate round 2:
 * alive ticks at most [SHIZUKU_WATCHDOG_HEALTHY_GAP_MS] apart on one boot;
 * STOP-ALL and unknown readings credit nothing,
 * [SHIZUKU_WATCHDOG_HEALTHY_RESET_MS]) opens a new one. A recovery cut short
 * (STOP-ALL, toggle off, superseded, gates failing at its completion, or its
 * checkpoint not written) is refunded, and never turns into a plain ON (gate
 * round 2). The recovery intent is durable: a process death between the
 * checkpoint and the run re-runs it as a recovery. Policy: [reduceWithWatchdog].
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
    /** Shizuku watchdog: tick cadence while settled online. */
    const val SHIZUKU_WATCHDOG_TICK_MS = 15L * 60_000L
    /** Shizuku watchdog: minimum time between two recovery starts (checked
     *  by the tick against the clock; no second timer). */
    const val SHIZUKU_WATCHDOG_BACKOFF_MS = 30L * 60_000L
    /** Shizuku watchdog: recoveries per Wi-Fi session before giving up. */
    const val SHIZUKU_WATCHDOG_MAX_ATTEMPTS = 3
    /** Shizuku watchdog: this much OBSERVED health (the sum of gaps between
     *  consecutive alive ticks, see [SHIZUKU_WATCHDOG_HEALTHY_GAP_MS]) ends the
     *  session (attempts, backoff, give-up). */
    const val SHIZUKU_WATCHDOG_HEALTHY_RESET_MS = 24L * 60L * 60_000L
    /** Shizuku watchdog: the longest gap between two alive ticks (same boot)
     *  that counts as observed health (gate round 2). */
    const val SHIZUKU_WATCHDOG_HEALTHY_GAP_MS = 30L * 60_000L
    /** Recovery cycle: wireless debugging stays OFF this long (adbd stops)
     *  before it is written ON again. */
    const val WIFI_DEBUG_CYCLE_PAUSE_MS = 2_000L

    // ── Fixed ClosePaw goals (code constants, single line, never user input) ──
    const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    const val GOAL_TAILSCALE_CONNECT =
        "Shelly connectivity guardian, fixed task: connect Tailscale. Open the Tailscale app (package com.tailscale.ipn) with the open_app tool. If the screen already shows that Tailscale is connected, change nothing and stop. Otherwise tap the control that connects Tailscale (the main on/off switch or the Connect button) exactly once, then wait a few seconds. Never accept, allow or confirm any VPN-permission, connection-request, login, sign-in or account dialog: if one appears, stop at once and report it. Do not open any other app and do not change any other setting. Report the connection state shown before and after."
    fun goalFor(): String = GOAL_TAILSCALE_CONNECT

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
        /** Shizuku watchdog, per Wi-Fi session (persisted): recoveries started.
         *  Monotonic within the session (a success does not lower it). */
        val wdAttempts: Int = 0,
        /** elapsedRealtime at which the last finished recovery STARTED running,
         *  and its boot (backoff basis, start to start). Set from SequenceDone.start. */
        val wdLastAttemptElapsedMs: Long? = null,
        val wdBootId: Long? = null,
        /** The give-up notification was sent this session: sticky until the session resets. */
        val wdGaveUp: Boolean = false,
        /** The running (or owed) ON is a watchdog recovery. Persisted (gate
         *  round 2) so a process death between the checkpoint and the run
         *  re-runs it as a recovery; restored only onto an owed ON. */
        val wdRecovering: Boolean = false,
        /** Observed-healthy time accumulated this session (persisted, gate
         *  round 2). [SHIZUKU_WATCHDOG_HEALTHY_RESET_MS] of it resets the session. */
        val wdHealthyAccumMs: Long = 0L,
        /** The last alive tick (elapsedRealtime) and its boot: the start of the
         *  next creditable gap. null = the chain is broken (first observation,
         *  STOP-ALL, an unknown reading): the next alive tick credits nothing. */
        val wdHealthyLastElapsedMs: Long? = null,
        val wdHealthyBootId: Long? = null,
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
        /** interrupted = the runner returned "superseded" (stopped before its last step).
         *  shizukuUp = a fresh liveness read after an ON ended (the recovery's
         *  success test; false whenever the run was stopped or interrupted);
         *  stopped = it ended "stopped" / "disabled"; start = the clock just
         *  before the runner began (an ON's; the recovery backoff anchor). */
        data class SequenceDone(
            val kind: SeqKind,
            val interrupted: Boolean = false,
            val shizukuUp: Boolean = false,
            val stopped: Boolean = false,
            val start: LossClock? = null,
        ) : Event()
        /** A recovery entry point (app start, watchdog, service start) probed
         *  Wi-Fi: bring the state in line with it. */
        data class Reconcile(val wifiUp: Boolean, val now: LossClock) : Event()
        /** Shizuku watchdog observation (tick alarm or an opportunistic check),
         *  built only by [observeShizukuWatchdog]: stopAll true = nothing else
         *  was read; wifiUp null = cannot tell; alive null = not read. */
        data class ShizukuWatchdogTick(val stopAll: Boolean, val wifiUp: Boolean?, val alive: Boolean?, val now: LossClock) : Event()
    }

    sealed class Effect {
        object RunOn : Effect()
        object RunOff : Effect()
        data class ArmDebounce(val token: Long, val delayMs: Long) : Effect()
        object CancelDebounce : Effect()
        object RegisterCallbacks : Effect()
        object UnregisterCallbacks : Effect()
        /** (Re)arm the watchdog tick alarm (same request code: replaces). */
        data class ArmShizukuWatchdog(val delayMs: Long) : Effect()
        /** Cancel the watchdog tick alarm (Wi-Fi loss / guardian off). */
        object CancelShizukuWatchdog : Effect()
        /** Run the ON sequence as a watchdog recovery (wireless debugging cycled). */
        object RunShizukuRecovery : Effect()
        /** The one give-up notification of a Wi-Fi session. */
        object NotifyShizukuWatchdogGaveUp : Effect()
        /** One watchdog audit line ([SHIZUKU_WATCHDOG_EVENTS]). */
        data class ShizukuWatchdogAudit(val event: String, val attempt: Int) : Effect()
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
     *  OFF is the cleanup itself. A dropped watchdog recovery is refunded
     *  (its attempt and its started line) and NOT turned into a plain ON: the
     *  state stays settled online and the tick is re-armed, so the next tick
     *  retries it as a recovery (gate round 1). The detected-dead line stays:
     *  that observation was real. */
    fun withoutUndurableOn(t: Transition): Transition {
        val recovery = t.effects.any { it is Effect.RunShizukuRecovery }
        val plain = t.effects.any { it is Effect.RunOn }
        if (!recovery && !plain) return t
        val effects = t.effects.filter { it !is Effect.RunOn && it !is Effect.RunShizukuRecovery && !isRecoveryStarted(it) }
        val base = if (recovery) refundedAttempt(t.state) else t.state
        if (plain) return Transition(cleared(base).copy(mode = Mode.IDLE_ONLINE, pending = Pending.ON, wdRecovering = false), effects)
        return Transition(
            cleared(base).copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE, wdRecovering = false),
            effects + Effect.ArmShizukuWatchdog(SHIZUKU_WATCHDOG_TICK_MS),
        )
    }

    /** A recovery that never really ran (dropped at the checkpoint, never
     *  dispatched): its attempt is given back (and, back at 0, the backoff
     *  anchor goes too; a lower count keeps the previous attempt's anchor,
     *  which is still the last real start). Not recovering any more. */
    private fun refundedAttempt(s: State): State {
        val r = refundedCount(s)
        return if (r.wdAttempts > 0) r else r.copy(wdLastAttemptElapsedMs = null, wdBootId = null)
    }

    /** The attempt given back, the backoff anchor untouched. Not recovering any more. */
    private fun refundedCount(s: State): State =
        s.copy(wdAttempts = maxOf(0, s.wdAttempts - 1), wdRecovering = false)

    private fun isRecoveryStarted(e: Effect): Boolean =
        e is Effect.ShizukuWatchdogAudit && e.event == WD_RECOVERY_STARTED

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

    // ── Shizuku watchdog ──
    const val WD_DETECTED_DEAD = "shizuku_watchdog_detected_dead"
    const val WD_RECOVERY_STARTED = "shizuku_watchdog_recovery_started"
    const val WD_RECOVERY_SUCCEEDED = "shizuku_watchdog_recovery_succeeded"
    const val WD_RECOVERY_FAILED = "shizuku_watchdog_recovery_failed"
    const val WD_GAVE_UP = "shizuku_watchdog_gave_up"
    val SHIZUKU_WATCHDOG_EVENTS: List<String> = listOf(
        "shizuku_watchdog_detected_dead", "shizuku_watchdog_recovery_started", "shizuku_watchdog_recovery_succeeded",
        "shizuku_watchdog_recovery_failed", "shizuku_watchdog_gave_up",
    )

    /** The probes one watchdog observation reads, in [observeShizukuWatchdog]'s order. */
    interface WatchdogProbes {
        /** STOP-ALL (`.halted`); unreadable = true. */
        fun stopAll(): Boolean
        /** Wi-Fi with INTERNET up; null = cannot tell. */
        fun wifiUp(): Boolean?
        /** Shizuku.pingBinder(); any error = false. */
        fun shizukuAlive(): Boolean
    }

    /** STOP-ALL first: while it is on nothing else is read. Shizuku is pinged
     *  only with Wi-Fi known to be up. */
    fun observeShizukuWatchdog(p: WatchdogProbes, now: LossClock): Event.ShizukuWatchdogTick {
        if (p.stopAll()) return Event.ShizukuWatchdogTick(true, null, null, now)
        val wifi = p.wifiUp()
        if (wifi != true) return Event.ShizukuWatchdogTick(false, wifi, null, now)
        return Event.ShizukuWatchdogTick(false, true, p.shizukuAlive(), now)
    }

    /** The probes read when a sequence ends, in [sequenceDoneFor]'s order. */
    interface CompletionProbes : WatchdogProbes {
        /** The guardian toggle mirror; unreadable = false. */
        fun enabled(): Boolean
    }

    /** The [Event.SequenceDone] for a sequence that returned [result]
     *  (gate round 2: the gates are read again AT COMPLETION, not taken from
     *  the runner's return code). [start]: the clock just before the runner
     *  began (kept for an ON only).
     *   - stopped / disabled / superseded: no ping; stopped unless superseded,
     *     interrupted when superseded.
     *   - otherwise, STOP-ALL first, then the toggle, then (recovery only)
     *     Wi-Fi: any of them failing now = stopped (a recovery is refunded; a
     *     plain ON ignores it). STOP-ALL raised, the guardian turned off or
     *     Wi-Fi lost during the last step / end audit can never count.
     *   - all gates pass: only a recovery pings Shizuku (its success test). A
     *     plain ON is never pinged: nothing reads shizukuUp for it. */
    fun sequenceDoneFor(kind: SeqKind, result: String, recovery: Boolean, start: LossClock, p: CompletionProbes): Event.SequenceDone {
        val st = if (kind == SeqKind.ON) start else null
        if (isAbort(result)) {
            return Event.SequenceDone(kind, interrupted = result == "superseded", shizukuUp = false, stopped = result != "superseded", start = st)
        }
        if (kind != SeqKind.ON) return Event.SequenceDone(kind)
        if (p.stopAll() || !p.enabled() || (recovery && p.wifiUp() != true)) {
            return Event.SequenceDone(kind, stopped = true, start = st)
        }
        if (!recovery) return Event.SequenceDone(kind, start = st)
        return Event.SequenceDone(kind, shizukuUp = p.shizukuAlive(), start = st)
    }

    /** Online, nothing running, nothing owed: the only state the watchdog acts in. */
    fun settledOnline(s: State): Boolean = s.mode == Mode.IDLE_ONLINE && s.pending == Pending.NONE

    /** A new Wi-Fi session for the watchdog: counters, backoff, give-up,
     *  recovery intent and the observed-healthy accumulation cleared. */
    fun freshWatchdog(s: State): State =
        s.copy(
            wdAttempts = 0, wdLastAttemptElapsedMs = null, wdBootId = null, wdGaveUp = false, wdRecovering = false,
            wdHealthyAccumMs = 0L, wdHealthyLastElapsedMs = null, wdHealthyBootId = null,
        )

    /** A dead tick: no health observed; the accumulation starts over. */
    private fun withoutHealthyWindow(s: State): State =
        s.copy(wdHealthyAccumMs = 0L, wdHealthyLastElapsedMs = null, wdHealthyBootId = null)

    /** STOP-ALL or an unknown reading: the time since the last alive tick was
     *  not observed, so the chain breaks (the next alive tick is a first
     *  observation and credits nothing); what was already observed is kept. */
    private fun withHealthyChainBroken(s: State): State =
        s.copy(wdHealthyLastElapsedMs = null, wdHealthyBootId = null)

    /** An alive tick (gate round 2: observed health, not a start timestamp).
     *  The gap since the previous alive tick is credited only when that tick
     *  exists (chain not broken), both boots are known and equal, and
     *  0 <= gap <= [SHIZUKU_WATCHDOG_HEALTHY_GAP_MS]. Credited up to
     *  [SHIZUKU_WATCHDOG_HEALTHY_RESET_MS]: the session resets. A chain that
     *  exists but cannot be proven continuous (boot unknown / changed, gap out
     *  of range) zeroes the accumulation; a broken chain (STOP-ALL, unknown
     *  reading) keeps it and credits nothing. This tick always becomes the
     *  next gap's start. */
    private fun healthyTick(s: State, now: LossClock): State {
        val last = s.wdHealthyLastElapsedMs
        val boot = s.wdHealthyBootId
        val delta = now.elapsedMs - (last ?: now.elapsedMs)
        val credited = last != null && boot != null && now.bootId != null && boot == now.bootId &&
            delta >= 0L && delta <= SHIZUKU_WATCHDOG_HEALTHY_GAP_MS
        val base = when {
            last == null -> s
            !credited -> s.copy(wdHealthyAccumMs = 0L)
            s.wdHealthyAccumMs + delta >= SHIZUKU_WATCHDOG_HEALTHY_RESET_MS -> freshWatchdog(s)
            else -> s.copy(wdHealthyAccumMs = s.wdHealthyAccumMs + delta)
        }
        return base.copy(wdHealthyLastElapsedMs = now.elapsedMs, wdHealthyBootId = now.bootId)
    }

    /** Restores the persisted watchdog session onto a restored state. The
     *  recovery intent survives only onto an owed ON (the "in_flight" restore:
     *  online, pending ON) with an attempt counted for it (gate round 2). */
    fun restoreWatchdog(
        s: State,
        attempts: Int,
        lastAttemptElapsedMs: Long?,
        bootId: Long?,
        gaveUp: Boolean,
        healthyAccumMs: Long = 0L,
        healthyLastElapsedMs: Long? = null,
        healthyBootId: Long? = null,
        recovering: Boolean = false,
    ): State {
        if (s.mode == Mode.DISABLED) return s
        val n = attempts.coerceIn(0, SHIZUKU_WATCHDOG_MAX_ATTEMPTS)
        return s.copy(
            wdAttempts = n,
            wdLastAttemptElapsedMs = lastAttemptElapsedMs,
            wdBootId = bootId?.takeIf { lastAttemptElapsedMs != null },
            wdGaveUp = gaveUp,
            wdRecovering = recovering && n > 0 && s.mode == Mode.IDLE_ONLINE && s.pending == Pending.ON,
            wdHealthyAccumMs = healthyAccumMs.coerceIn(0L, SHIZUKU_WATCHDOG_HEALTHY_RESET_MS),
            wdHealthyLastElapsedMs = healthyLastElapsedMs,
            wdHealthyBootId = healthyBootId?.takeIf { healthyLastElapsedMs != null },
        )
    }

    /** Wi-Fi was absent (or being given up) before this event. */
    private fun wasOffline(s: State): Boolean =
        s.mode == Mode.IDLE_OFFLINE || s.mode == Mode.LOSS_PENDING || s.mode == Mode.OFF_RUNNING ||
            (s.mode == Mode.ON_RUNNING && (s.pending == Pending.LOSS || s.pending == Pending.OFF))

    /** Events that open a new watchdog session: Wi-Fi reconnect, guardian
     *  re-enable (from DISABLED only: RN rewrites the mirror at every app
     *  start), boot / app update. (The fourth reset, 24 h of continuous
     *  health, is the tick's.) */
    private fun opensSession(s: State, e: Event): Boolean = when (e) {
        is Event.Enable -> s.mode == Mode.DISABLED
        is Event.Boot -> true
        is Event.WifiAvailable -> wasOffline(s)
        is Event.Reconcile -> e.wifiUp && wasOffline(s)
        is Event.DebounceExpired -> e.wifiUp && wasOffline(s)
        else -> false
    }

    /** Backoff since the last recovery start passed. A different (known) boot
     *  or a monotonic clock that reads earlier = the clock restarted: passed
     *  (the per-session cap still bounds the attempts). */
    fun watchdogBackoffPassed(s: State, now: LossClock): Boolean {
        val last = s.wdLastAttemptElapsedMs ?: return true
        val boot = s.wdBootId
        if (boot != null && now.bootId != null && boot != now.bootId) return true
        val dt = now.elapsedMs - last
        return dt < 0L || dt >= SHIZUKU_WATCHDOG_BACKOFF_MS
    }

    /** The event takes Wi-Fi away or turns the guardian off: the watchdog
     *  tick must not outlive settled-online (gate round 1). Rule: WifiLost,
     *  Disable, Reconcile that probed Wi-Fi down, or a DebounceExpired that
     *  starts the OFF path. Cancelling is idempotent, so it is emitted for
     *  these events whatever the state was. */
    private fun disarmsWatchdog(e: Event, fx: List<Effect>): Boolean = when (e) {
        is Event.WifiLost, is Event.Disable -> true
        is Event.Reconcile -> !e.wifiUp
        is Event.DebounceExpired -> fx.any { it is Effect.RunOff }
        else -> false
    }

    /** The guardian's transition function: [reduce] plus the Shizuku watchdog
     *  layer (session resets, recovery outcome, tick arming / disarming). Pure.
     *
     *  Recovery outcome (gate round 1): an interrupted recovery (STOP-ALL,
     *  toggle off, superseded) is refunded and checked FIRST, so a lucky ping
     *  cannot count it as a success. Gate round 3: the refund gives the
     *  attempt back but keeps the cooldown: e.start (when known) stamps the
     *  backoff anchor, else the anchor is left as it was; a late STOP-ALL
     *  cannot shorten the 30-minute spacing between recovery starts. A recovery that ran to its end is audited
     *  succeeded or failed and stamps the backoff anchor with its start
     *  (start to start); the attempt count is never lowered by a success. A
     *  plain ON changes no watchdog state.
     *
     *  Gate round 2: a refunded recovery with no ON owed ([Pending.NONE]) never
     *  becomes a plain ON. [reduce] reads an interrupted ON as "Wi-Fi came
     *  back: finish it", but a recovery is superseded by its own Wi-Fi
     *  re-probe too, and a plain ON has no such probe (it could write
     *  adb_wifi_enabled=1 with Wi-Fi down). Its RunOn is dropped and the
     *  state settles online (the tick re-arms; the loss flow / next tick
     *  re-derive anything genuinely owed). A pending ON is a real obligation
     *  and keeps its RunOn. And the recovery intent is durable: an ON owed
     *  with [State.wdRecovering] still set (only the restored owed ON after a
     *  death between checkpoint and dispatch) runs as [Effect.RunShizukuRecovery],
     *  so the attempt already counted is resolved by its own outcome. */
    fun reduceWithWatchdog(s: State, e: Event): Transition {
        if (e is Event.ShizukuWatchdogTick) return watchdogTick(s, e)
        val base = if (opensSession(s, e)) freshWatchdog(s) else s
        val t = reduce(base, e)
        var st = t.state
        val fx = t.effects.toMutableList()
        if (e is Event.SequenceDone && e.kind == SeqKind.ON && s.mode == Mode.ON_RUNNING && s.wdRecovering) {
            val n = s.wdAttempts
            if (e.stopped || e.interrupted) {
                // Cut short before it could finish: no attempt burned, nothing audited.
                // But it was dispatched and began (it may have cycled wireless
                // debugging), so its start still governs the cooldown (gate
                // round 3): the anchor is set from e.start even at count 0, and
                // never cleared.
                st = refundedCount(st)
                val start = e.start
                if (start != null) st = st.copy(wdLastAttemptElapsedMs = start.elapsedMs, wdBootId = start.bootId)
                if (s.pending == Pending.NONE && fx.any { it is Effect.RunOn }) {
                    // Nothing owed: never a plain ON (it has no Wi-Fi probe).
                    fx.removeAll { it is Effect.RunOn }
                    st = st.copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE)
                }
            } else {
                st = st.copy(wdRecovering = false)
                val start = e.start
                if (start != null) st = st.copy(wdLastAttemptElapsedMs = start.elapsedMs, wdBootId = start.bootId)
                if (e.shizukuUp) {
                    fx += Effect.ShizukuWatchdogAudit(WD_RECOVERY_SUCCEEDED, n)
                } else {
                    fx += Effect.ShizukuWatchdogAudit(WD_RECOVERY_FAILED, n)
                    if (n >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS && !s.wdGaveUp) {
                        fx += Effect.ShizukuWatchdogAudit(WD_GAVE_UP, n)
                        fx += Effect.NotifyShizukuWatchdogGaveUp
                        st = st.copy(wdGaveUp = true)
                    }
                }
            }
        }
        // An ON started here: a recovery whose intent survived (restored owed
        // ON) runs as one; any other ON is plain, not a recovery.
        if (fx.any { it is Effect.RunOn }) {
            if (st.wdRecovering) fx[fx.indexOfFirst { it is Effect.RunOn }] = Effect.RunShizukuRecovery
            else st = st.copy(wdRecovering = false)
        }
        // Entering the settled-online state starts the tick.
        if (settledOnline(st) && !settledOnline(s)) fx += Effect.ArmShizukuWatchdog(SHIZUKU_WATCHDOG_TICK_MS)
        // Leaving it through a loss / toggle off stops it.
        if (disarmsWatchdog(e, fx)) fx += Effect.CancelShizukuWatchdog
        return Transition(st, fx)
    }

    /** One watchdog observation. Acts only while settled online. */
    private fun watchdogTick(s: State, e: Event.ShizukuWatchdogTick): Transition {
        val same = Transition(s, emptyList())
        // Toggle off, offline, a sequence running or owed: the guardian's own
        // flow owns the state (and re-arms the tick when it settles online).
        if (!settledOnline(s)) return same
        // STOP-ALL first: nothing run, counted, audited or re-armed. A later
        // check (reconcile, Wi-Fi available) or settling online again re-arms
        // the tick. The healthy chain breaks: STOP-ALL time is not observed.
        if (e.stopAll) return Transition(withHealthyChainBroken(s), emptyList())
        val rearm = Effect.ArmShizukuWatchdog(SHIZUKU_WATCHDOG_TICK_MS)
        // Wi-Fi down: inert (the loss flow owns it). Unknown: look again later.
        // Either way nothing was observed: the healthy chain breaks.
        if (e.wifiUp == false) return Transition(withHealthyChainBroken(s), emptyList())
        val alive = e.alive
        if (e.wifiUp == null || alive == null) return Transition(withHealthyChainBroken(s), listOf(rearm))
        // Alive: the session is NOT reset (monotonic); only 24 h of observed
        // health resets it ([healthyTick]).
        if (alive) return Transition(healthyTick(s, e.now), listOf(rearm))
        val sd = withoutHealthyWindow(s)
        if (sd.wdGaveUp) return Transition(sd, listOf(rearm))
        if (sd.wdAttempts >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS) {
            return Transition(
                sd.copy(wdGaveUp = true),
                listOf(Effect.ShizukuWatchdogAudit(WD_GAVE_UP, sd.wdAttempts), Effect.NotifyShizukuWatchdogGaveUp, rearm),
            )
        }
        val dead = Effect.ShizukuWatchdogAudit(WD_DETECTED_DEAD, sd.wdAttempts)
        if (!watchdogBackoffPassed(sd, e.now)) return Transition(sd, listOf(dead, rearm))
        val n = sd.wdAttempts + 1
        // The backoff anchor is NOT stamped here: the run may start much later
        // (service start, alarm hop). SequenceDone.start stamps it.
        return Transition(
            sd.copy(mode = Mode.ON_RUNNING, pending = Pending.NONE, wdAttempts = n, wdRecovering = true),
            listOf(dead, Effect.ShizukuWatchdogAudit(WD_RECOVERY_STARTED, n), Effect.RunShizukuRecovery),
        )
    }

    // ── Step runner ──
    // Closed value sets (lockstep with the TS STEPS / ACTIONS / LEVELS / OUTCOMES / ASSIST_REASONS).
    val STEPS: List<String> = listOf("wifi_debug", "shizuku", "tailscale", "sequence")
    val ACTIONS: List<String> = listOf("check", "enable", "disable", "wait", "connect", "end")
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
        "tailscale_failed", "shizuku_watchdog_gave_up",
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
        /** Wi-Fi with INTERNET up; null = cannot tell. Read by a watchdog
         *  recovery before its first write (a queued recovery may start after
         *  Wi-Fi left). */
        fun wifiUp(): Boolean?
        /** TRANSPORT_VPN present: true / false, or null when it cannot be told. */
        fun vpnUp(): Boolean?
        /** ClosePawShellPreapproval.isOn(). */
        fun closePawPreapproved(): Boolean
        /** The single seam (TailscaleControl.requestTailscale), connect-only.
         *  The request id when handed off, else null. Its answer never passes
         *  a step: only [vpnUp] does. */
        fun requestTailscale(): String?
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

    /** [quiet]: a watchdog recovery; its step failures are audited but not
     *  notified (the watchdog's single give-up notification speaks for it). */
    private class Run(val p: Ports, val seq: String, val quiet: Boolean = false) {
        var notified = false
        fun audit(step: String, action: String, before: String, after: String, outcome: String) =
            p.audit(seq, step, action, before, after, outcome)
        fun assist(reason: String) {
            if (notified || quiet) return
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
     *  of done / assist / failed / stopped / disabled / superseded.
     *  [recovery] (Shizuku watchdog): Wi-Fi is probed again before any write
     *  and once more right before the enable write (not known up =
     *  superseded, fail closed); wireless debugging that is
     *  already on is cycled OFF -> ON first, so Shizuku's own auto-start sees
     *  a fresh trigger; step failures are not notified. */
    fun runOnSequence(p: Ports, mem: RunnerMemory, seq: String, recovery: Boolean = false): String {
        val r = Run(p, seq, recovery)

        // 1. Wireless debugging.
        r.gated("wifi_debug")?.let { return r.end(it) }
        if (recovery && p.wifiUp() != true) {
            // Queued while settled online, but Wi-Fi left before it ran: no write.
            r.audit("wifi_debug", "check", "none", "none", "superseded")
            return r.end("superseded")
        }
        var adbBefore = p.readAdbWifi()
        if (recovery && adbBefore == 1) {
            val cycled = cycleWifiDebugOff(r)
            if (cycled != null) return r.end(cycled)
            r.gated("wifi_debug")?.let { return r.end(it) }
            adbBefore = p.readAdbWifi()
        }
        if (adbBefore == 1) {
            r.audit("wifi_debug", "check", "on", "on", "already")
        } else {
            if (!p.hasWriteSecureSettings()) {
                r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(adbBefore), "grant_missing")
                r.assist("grant_missing")
                return r.end("assist")
            }
            if (recovery && p.wifiUp() != true) {
                // Gate round 4: Wi-Fi left during the cycle pause (or since the
                // first probe). Never write wireless debugging on without Wi-Fi;
                // the loss flow owns the OFF state.
                r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(adbBefore), "superseded")
                return r.end("superseded")
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
        val t = tailscaleStep(r)
        return r.end(t ?: "done")
    }

    /** Recovery only: wireless debugging on -> off (verified), then a short
     *  pause. Null = off (or unreadable: the Shizuku wait is the check), go on
     *  to the normal enable step; else the sequence result. */
    private fun cycleWifiDebugOff(r: Run): String? {
        val p = r.p
        if (!p.hasWriteSecureSettings()) {
            r.audit("wifi_debug", "disable", "on", "on", "grant_missing")
            r.assist("grant_missing")
            return "assist"
        }
        if (!p.writeAdbWifi(0)) {
            r.audit("wifi_debug", "disable", "on", adbLevel(p.readAdbWifi()), "write_failed")
            r.assist("wifi_debug_off_failed")
            return "assist"
        }
        var last: Int? = null
        val verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS) {
            last = p.readAdbWifi()
            last == 0
        }
        if (isAbort(verified)) {
            r.audit("wifi_debug", "disable", "on", adbLevel(last), verified)
            return verified
        }
        if (verified == "ok") {
            r.audit("wifi_debug", "disable", "on", "off", "ok")
        } else if (last == null) {
            r.audit("wifi_debug", "disable", "on", "unknown", "unverified")
        } else {
            r.audit("wifi_debug", "disable", "on", adbLevel(last), "verify_failed")
            r.assist("wifi_debug_off_failed")
            return "failed"
        }
        p.sleep(WIFI_DEBUG_CYCLE_PAUSE_MS)
        return null
    }

    /** OFF: wireless debugging only. Tailscale is never touched here (it
     *  stays connected on mobile data), so OFF never dispatches ClosePaw and
     *  does not depend on the ClosePaw pre-approval. */
    fun runOffSequence(p: Ports, seq: String): String {
        val r = Run(p, seq)
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

    /** Connect-only (ON). Returns null when the step passed (or Tailscale was
     *  already connected). */
    private fun tailscaleStep(r: Run): String? {
        val p = r.p
        r.gated("tailscale")?.let { return it }
        val action = "connect"
        val before = p.vpnUp()
        if (before == true) {
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
        val reqId = p.requestTailscale()
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
            return verifyTailscale(r, action, before)
        } finally {
            awaitSettle(r, reqId, dispatchedAt)
        }
    }

    private fun verifyTailscale(r: Run, action: String, before: Boolean?): String? {
        val p = r.p
        var last: Boolean? = before
        val verified = pollUntil(p, VPN_VERIFY_MS, VPN_POLL_MS) {
            last = p.vpnUp()
            last == true
        }
        if (isAbort(verified)) {
            r.audit("tailscale", action, vpnLevel(before), vpnLevel(last), verified)
            return verified
        }
        if (verified == "ok") {
            r.audit("tailscale", action, vpnLevel(before), "on", "ok")
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
    fun runSequence(kind: SeqKind, p: Ports, mem: RunnerMemory, seq: String, recovery: Boolean = false): String =
        if (kind == SeqKind.ON) runOnSequence(p, mem, seq, recovery) else runOffSequence(p, seq)

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

    /** Shizuku watchdog line: same file and kind, its own fixed keys. */
    val SHIZUKU_WATCHDOG_AUDIT_KEYS: List<String> = listOf("ts", "kind", "step", "event", "attempt")

    fun buildShizukuWatchdogAuditLine(tsIso: String, event: String, attempt: Int): String? {
        if (!TS_RE.matches(tsIso) || event !in SHIZUKU_WATCHDOG_EVENTS) return null
        if (attempt < 0 || attempt > SHIZUKU_WATCHDOG_MAX_ATTEMPTS) return null
        return "{\"ts\":\"$tsIso\",\"kind\":\"$AUDIT_KIND\",\"step\":\"shizuku_watchdog\"," +
            "\"event\":\"$event\",\"attempt\":$attempt}"
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
