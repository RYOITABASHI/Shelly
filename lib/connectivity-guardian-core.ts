/**
 * lib/connectivity-guardian-core.ts — the pure decision logic of the Wi-Fi
 * connectivity guardian ("Wi-Fi連動オートパイロット").
 *
 * The guardian itself is native (ConnectivityGuardian.kt + friends): it must
 * run with the app closed and after a reboot. Its decisions live in
 * ConnectivityGuardianCore.kt, which has ZERO android.* imports (the
 * TriggerDebouncer convention) so it stays a plain function of its inputs.
 * This file is the line-for-line TypeScript port of that core, so jest can
 * exercise the state machine and the step runner; __tests__/connectivity-
 * guardian-*.test.ts keep the two in lockstep (constants, goals, closed value
 * sets, step order) by reading the Kotlin source.
 *
 * Nothing here talks to Android. The runner gets everything through [Ports]:
 * production wires them to Settings.Global (WifiDebugControl), Shizuku's
 * pingBinder (ShizukuLiveness), ConnectivityManager's TRANSPORT_VPN probe and
 * the ClosePaw hand-off seam (TailscaleControl), IngressAuditWriter and an
 * assist notification.
 *
 * Owner decisions this encodes (Phase 2 addendum, 2026-11-17):
 *  - The guardian NEVER starts Shizuku. ON writes adb_wifi_enabled=1, then
 *    waits (polls pingBinder) for Shizuku's own auto-start, bounded.
 *  - A write that does not take effect (e.g. Android's "Allow wireless
 *    debugging on this network?" dialog is pending) or a ping timeout ends
 *    the ON sequence with an assist notification. No dialog is ever accepted.
 *  - Tailscale is driven only through fixed ClosePaw goals, only while the
 *    ClosePaw shell pre-approval switch is ON; OFF = notify only. Whether
 *    Tailscale is connected is decided ONLY by Shelly's own VPN probe.
 *  - Tailscale is connect-only (owner decision 2026-11-17): it stays
 *    connected after Wi-Fi is lost, mobile data included. OFF only writes
 *    adb_wifi_enabled=0; it never touches Tailscale or dispatches ClosePaw.
 *
 * Shizuku watchdog (owner direction 2026-11-20): while the guardian is settled
 * online, a 15-minute tick (and every reconcile / Wi-Fi-available point)
 * observes Shizuku (observeShizukuWatchdog: STOP-ALL first). Dead -> re-run
 * the ON sequence as a recovery (wireless debugging cycled OFF -> ON when it
 * is already on, so Shizuku's OWN auto-start sees a fresh trigger; Shizuku is
 * still never started). At most SHIZUKU_WATCHDOG_MAX_ATTEMPTS recovery starts
 * per Wi-Fi session, SHIZUKU_WATCHDOG_BACKOFF_MS apart (start to start); then
 * one give-up notification and silence until the session resets. The count is
 * monotonic within a session (gate round 1, 2026-11-20): a success does not
 * reset it and a healthy tick does not revive a given-up session; only a Wi-Fi
 * reconnect, a guardian re-enable, a boot, or 24 h of OBSERVED health (gate
 * round 2: alive ticks at most SHIZUKU_WATCHDOG_HEALTHY_GAP_MS apart on one
 * boot; STOP-ALL and unknown readings credit nothing,
 * SHIZUKU_WATCHDOG_HEALTHY_RESET_MS) opens a new one. A recovery cut short
 * (STOP-ALL, toggle off, superseded, gates failing at its completion, or its
 * checkpoint not written) is refunded, and never turns into a plain ON (gate
 * round 2). The recovery intent is durable: a process death between the
 * checkpoint and the run re-runs it as a recovery. Policy: reduceWithWatchdog.
 */

// ── Constants (lockstep with ConnectivityGuardianCore.kt) ─────────────────
export const LOSS_DEBOUNCE_MS = 45_000;
export const SHIZUKU_WAIT_MS = 90_000;
export const SHIZUKU_POLL_MS = 3_000;
/** After a Shizuku wait timed out, another trigger inside this window does
 *  not wait again (no retry storm); it ends the sequence quietly. */
export const SHIZUKU_RETRY_COOLDOWN_MS = 120_000;
export const ADB_WIFI_VERIFY_MS = 6_000;
export const ADB_WIFI_POLL_MS = 1_000;
export const VPN_VERIFY_MS = 180_000;
export const VPN_POLL_MS = 3_000;
export const WATCHDOG_INTERVAL_MS = 15 * 60_000;
/** A dispatched ClosePaw request must SETTLE (terminal run state) before the
 *  sequence that dispatched it may end, for any reason; bounded, counted from
 *  the dispatch. Sequencing only: never decides success. */
export const CLOSEPAW_SETTLE_MS = 300_000;
export const CLOSEPAW_SETTLE_POLL_MS = 2_000;
export const AUDIT_FILE = 'connectivity-guardian.jsonl';
export const AUDIT_KIND = 'wifi_guardian';
export const GOAL_MAX_CODE_POINTS = 2000;
/** Shizuku watchdog: tick cadence while settled online. */
export const SHIZUKU_WATCHDOG_TICK_MS = 15 * 60_000;
/** Shizuku watchdog: minimum time between two recovery starts (checked by the
 *  tick against the clock; no second timer). */
export const SHIZUKU_WATCHDOG_BACKOFF_MS = 30 * 60_000;
/** Shizuku watchdog: recoveries per Wi-Fi session before giving up. */
export const SHIZUKU_WATCHDOG_MAX_ATTEMPTS = 3;
/** Shizuku watchdog: this much OBSERVED health (the sum of gaps between
 *  consecutive alive ticks, see SHIZUKU_WATCHDOG_HEALTHY_GAP_MS) ends the
 *  session (attempts, backoff, give-up). */
export const SHIZUKU_WATCHDOG_HEALTHY_RESET_MS = 24 * 60 * 60_000;
/** Shizuku watchdog: the longest gap between two alive ticks (same boot) that
 *  counts as observed health (gate round 2). */
export const SHIZUKU_WATCHDOG_HEALTHY_GAP_MS = 30 * 60_000;
/** Recovery cycle: wireless debugging stays OFF this long (adbd stops) before
 *  it is written ON again. */
export const WIFI_DEBUG_CYCLE_PAUSE_MS = 2_000;

// ── Fixed ClosePaw goals (code constants, single line, never user input) ──
export const TAILSCALE_PACKAGE = 'com.tailscale.ipn';
export const GOAL_TAILSCALE_CONNECT =
  'Shelly connectivity guardian, fixed task: connect Tailscale. Open the Tailscale app (package com.tailscale.ipn) with the open_app tool. If the screen already shows that Tailscale is connected, change nothing and stop. Otherwise tap the control that connects Tailscale (the main on/off switch or the Connect button) exactly once, then wait a few seconds. Never accept, allow or confirm any VPN-permission, connection-request, login, sign-in or account dialog: if one appears, stop at once and report it. Do not open any other app and do not change any other setting. Report the connection state shown before and after.';

// ── State machine ──────────────────────────────────────────────────────────
export type Mode = 'DISABLED' | 'IDLE_OFFLINE' | 'IDLE_ONLINE' | 'ON_RUNNING' | 'LOSS_PENDING' | 'OFF_RUNNING';
/** NONE; ON = Wi-Fi came back during OFF, or (in LOSS_PENDING) ON must run
 *  again when Wi-Fi returns (it was interrupted, or the device rebooted);
 *  LOSS = Wi-Fi lost during ON (debounce already armed); OFF = that debounce
 *  expired during ON (run OFF next). */
export type Pending = 'NONE' | 'ON' | 'LOSS' | 'OFF';
export type SeqKind = 'on' | 'off';

export interface GuardianState {
  mode: Mode;
  /** Token of the armed loss-debounce alarm; a different token is stale. */
  lossToken: number;
  /** Latest intent noticed while a sequence runs (collapses; latest wins). */
  pending: Pending;
  /** Wall-clock instant (ms) of the loss the current token debounces.
   *  Persisted; informational, and the one-time fallback basis for a loss
   *  written by an older build (no monotonic anchor). Absent = unknown. */
  lossAtMs?: number;
  /** Monotonic anchor of the loss (elapsedRealtime at the loss, persisted):
   *  the deadline is lossElapsedMs + LOSS_DEBOUNCE_MS on the boot
   *  [lossBootId]. Recovery uses only this; the wall clock cannot move it
   *  (coordinator gate round 3). Absent = older build's state. */
  lossElapsedMs?: number;
  /** Boot identity at the loss (Settings.Global.BOOT_COUNT). Absent while
   *  [lossElapsedMs] is present = the boot could not be identified: recovery
   *  then treats the debounce as expired. */
  lossBootId?: number;
  /** In-process only, never persisted: this process armed the debounce alarm
   *  for [lossToken] and it has not fired yet. A fresh process starts without
   *  it, so recovery re-arms for the remaining budget. */
  lossArmed?: true;
  /** Shizuku watchdog, per Wi-Fi session (persisted): recoveries started.
   *  Monotonic within the session (a success does not lower it). Absent = 0. */
  wdAttempts?: number;
  /** elapsedRealtime at which the last finished recovery STARTED running, and
   *  its boot (backoff basis, start to start). Set from SequenceDone.start. */
  wdLastAttemptElapsedMs?: number;
  wdBootId?: number;
  /** The give-up notification was sent this session: sticky until the session resets. */
  wdGaveUp?: true;
  /** Observed-healthy time accumulated this session (persisted, gate round 2).
   *  SHIZUKU_WATCHDOG_HEALTHY_RESET_MS of it resets the session. Absent = 0. */
  wdHealthyAccumMs?: number;
  /** The last alive tick (elapsedRealtime) and its boot: the start of the next
   *  creditable gap. Absent = the chain is broken (first observation, STOP-ALL,
   *  an unknown reading): the next alive tick credits nothing. */
  wdHealthyLastElapsedMs?: number;
  wdHealthyBootId?: number;
  /** The running (or owed) ON is a watchdog recovery. Persisted (gate round 2)
   *  so a process death between the checkpoint and the run re-runs it as a
   *  recovery; restored only onto an owed ON. */
  wdRecovering?: true;
}

/** A recovery-grade reading of "now": wall clock (informational, legacy
 *  fallback), elapsedRealtime (monotonic, resets on reboot) and the boot
 *  identity (null = unknown). */
export interface LossClock {
  wallMs: number;
  elapsedMs: number;
  bootId: number | null;
}

export type GuardianEvent =
  | { type: 'enable'; wifiUp: boolean }
  | { type: 'disable' }
  /** now (here and on wifiLost / reconcile): the loss anchor's basis. */
  | { type: 'boot'; enabled: boolean; wifiUp: boolean; now: LossClock }
  | { type: 'wifiAvailable' }
  | { type: 'wifiLost'; now: LossClock }
  | { type: 'debounceExpired'; token: number; wifiUp: boolean }
  /** interrupted = the runner returned 'superseded' (stopped before its last step).
   *  shizukuUp = a fresh liveness read after an ON ended (the recovery's success
   *  test; false whenever the run was stopped or interrupted); stopped = it
   *  ended 'stopped' / 'disabled'; start = the clock just before the runner
   *  began (an ON's; the recovery backoff anchor). */
  | { type: 'sequenceDone'; kind: SeqKind; interrupted?: boolean; shizukuUp?: boolean; stopped?: boolean; start?: LossClock | null }
  /** A recovery entry point (app start, watchdog, service start) probed
   *  Wi-Fi: bring the state in line with it. */
  | { type: 'reconcile'; wifiUp: boolean; now: LossClock }
  /** Shizuku watchdog observation (tick alarm or an opportunistic check), built
   *  only by observeShizukuWatchdog: stopAll true = nothing else was read;
   *  wifiUp null = cannot tell; alive null = not read. */
  | { type: 'shizukuWatchdogTick'; stopAll: boolean; wifiUp: boolean | null; alive: boolean | null; now: LossClock };

export type Effect =
  | { type: 'runOn' }
  | { type: 'runOff' }
  | { type: 'armDebounce'; token: number; delayMs: number }
  | { type: 'cancelDebounce' }
  | { type: 'registerCallbacks' }
  | { type: 'unregisterCallbacks' }
  /** (Re)arm the watchdog tick alarm (same request code: replaces). */
  | { type: 'armShizukuWatchdog'; delayMs: number }
  /** Cancel the watchdog tick alarm (Wi-Fi loss / guardian off). */
  | { type: 'cancelShizukuWatchdog' }
  /** Run the ON sequence as a watchdog recovery (wireless debugging cycled). */
  | { type: 'runShizukuRecovery' }
  /** The one give-up notification of a Wi-Fi session. */
  | { type: 'notifyShizukuWatchdogGaveUp' }
  /** One watchdog audit line (SHIZUKU_WATCHDOG_EVENTS). */
  | { type: 'shizukuWatchdogAudit'; event: ShizukuWatchdogEvent; attempt: number };

export interface Transition {
  state: GuardianState;
  effects: Effect[];
}

export function initialState(enabled: boolean): GuardianState {
  return { mode: enabled ? 'IDLE_OFFLINE' : 'DISABLED', lossToken: 0, pending: 'NONE' };
}

/** What survives a process death (plain prefs; nothing sensitive). An ON that
 *  already saw the loss is stored as the pending loss (its debounce alarm is
 *  armed). Any other running sequence is stored as 'in_flight': its writes
 *  (adb_wifi_enabled=1, a Tailscale hand-off) may have landed, so cleanup or a
 *  rerun is owed and every recovery entry point reconciles it against Wi-Fi
 *  (reconcile / boot). */
export function persistableMode(
  state: GuardianState,
): 'idle_online' | 'idle_offline' | 'loss_pending' | 'loss_pending_on' | 'in_flight' | 'disabled' {
  if (state.mode === 'ON_RUNNING' && (state.pending === 'LOSS' || state.pending === 'OFF')) return 'loss_pending_on';
  if (state.mode === 'LOSS_PENDING' && state.pending === 'ON') return 'loss_pending_on';
  if (state.mode === 'ON_RUNNING' || state.mode === 'OFF_RUNNING' || (state.mode === 'IDLE_ONLINE' && state.pending === 'ON')) return 'in_flight';
  switch (state.mode) {
    case 'IDLE_ONLINE':
      return 'idle_online';
    case 'LOSS_PENDING':
      return 'loss_pending';
    case 'DISABLED':
      return 'disabled';
    default:
      return 'idle_offline';
  }
}

/** Fresh process: the toggle mirror decides first (unreadable = OFF). The
 *  restored state never has [GuardianState.lossArmed]: no alarm is assumed. */
export function restoreState(
  enabled: boolean,
  persisted: string | null,
  lossToken: number,
  lossAtMs: number | null = null,
  lossElapsedMs: number | null = null,
  lossBootId: number | null = null,
): GuardianState {
  if (!enabled) return initialState(false);
  if (persisted === 'idle_online') return { mode: 'IDLE_ONLINE', lossToken, pending: 'NONE' };
  const anchor = {
    ...(lossAtMs === null ? {} : { lossAtMs }),
    ...(lossElapsedMs === null ? {} : { lossElapsedMs }),
    ...(lossElapsedMs === null || lossBootId === null ? {} : { lossBootId }),
  };
  if (persisted === 'loss_pending') return { mode: 'LOSS_PENDING', lossToken, pending: 'NONE', ...anchor };
  if (persisted === 'loss_pending_on') return { mode: 'LOSS_PENDING', lossToken, pending: 'ON', ...anchor };
  // Unfinished work: online-with-ON-owed. Wi-Fi present -> ON reruns;
  // absent -> the loss is armed (OFF cleanup), ON again on regain.
  if (persisted === 'in_flight') return { mode: 'IDLE_ONLINE', lossToken, pending: 'ON' };
  return { mode: 'IDLE_OFFLINE', lossToken, pending: 'NONE' };
}

/** The foreground service stays resident exactly while an OFF obligation may
 *  exist (online after ON, the loss debounce, a running sequence), so the
 *  in-process loss callback is live and the debounce starts at the real loss.
 *  Not while idle offline or disabled. */
export function wantsResident(s: GuardianState): boolean {
  return s.mode === 'IDLE_ONLINE' || s.mode === 'LOSS_PENDING' || s.mode === 'ON_RUNNING' || s.mode === 'OFF_RUNNING';
}

/** The state write did not reach disk. ON must not mutate anything without a
 *  durable 'in_flight' record, so runOn is dropped and ON stays owed in memory
 *  (online, pending ON: the next Wi-Fi callback or reconcile retries, and
 *  checkpoints again). Every other effect stays: OFF is the cleanup itself.
 *  A dropped watchdog recovery is refunded (its attempt and its started line)
 *  and NOT turned into a plain ON: the state stays settled online and the tick
 *  is re-armed, so the next tick retries it as a recovery (gate round 1). The
 *  detected-dead line stays: that observation was real. */
export function withoutUndurableOn(t: Transition): Transition {
  const recovery = t.effects.some((e) => e.type === 'runShizukuRecovery');
  const plain = t.effects.some((e) => e.type === 'runOn');
  if (!recovery && !plain) return t;
  const effects = t.effects.filter((e) => e.type !== 'runOn' && e.type !== 'runShizukuRecovery' && !isRecoveryStarted(e));
  const base = recovery ? refundedAttempt(t.state) : t.state;
  const { wdRecovering: _r, ...rest } = cleared(base);
  if (plain) return { state: { ...rest, mode: 'IDLE_ONLINE', pending: 'ON' }, effects };
  return {
    state: { ...rest, mode: 'IDLE_ONLINE', pending: 'NONE' },
    effects: [...effects, { type: 'armShizukuWatchdog', delayMs: SHIZUKU_WATCHDOG_TICK_MS }],
  };
}

/** A recovery that never really ran (dropped at the checkpoint, never
 *  dispatched): its attempt is given back (and, back at 0, the backoff anchor
 *  goes too; a lower count keeps the previous attempt's anchor, which is still
 *  the last real start). Not recovering any more. */
function refundedAttempt(s: GuardianState): GuardianState {
  const r = refundedCount(s);
  if ((r.wdAttempts ?? 0) > 0) return r;
  const { wdLastAttemptElapsedMs: _l, wdBootId: _b, ...bare } = r;
  return bare;
}

/** The attempt given back, the backoff anchor untouched. Not recovering any more. */
function refundedCount(s: GuardianState): GuardianState {
  const n = Math.max(0, (s.wdAttempts ?? 0) - 1);
  const { wdRecovering: _r, wdAttempts: _a, ...rest } = s;
  return n > 0 ? { ...rest, wdAttempts: n } : rest;
}

function isRecoveryStarted(e: Effect): boolean {
  return e.type === 'shizukuWatchdogAudit' && e.event === WD_RECOVERY_STARTED;
}

/** The alarm fired (or was given up): nothing is outstanding any more. The
 *  anchor stays (a restored pending OFF still knows its deadline passed). */
function disarmed(s: GuardianState): GuardianState {
  const { lossArmed: _a, ...rest } = s;
  return rest;
}

/** The loss was cancelled (Wi-Fi back, toggle off): no deadline remains. */
function cleared(s: GuardianState): GuardianState {
  const { lossArmed: _a, lossAtMs: _l, lossElapsedMs: _e, lossBootId: _b, ...rest } = s;
  return rest;
}

function startOn(s: GuardianState): Transition {
  return { state: { ...s, mode: 'ON_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOn' }] };
}

/** The anchor of a loss whose remaining budget at [now] is [remainingMs]:
 *  the monotonic instant that leaves exactly that budget, on this boot. */
function lossAnchor(now: LossClock, remainingMs: number): Pick<GuardianState, 'lossAtMs' | 'lossElapsedMs' | 'lossBootId'> {
  const spent = LOSS_DEBOUNCE_MS - remainingMs;
  return {
    lossAtMs: now.wallMs - spent,
    lossElapsedMs: now.elapsedMs - spent,
    ...(now.bootId === null ? {} : { lossBootId: now.bootId }),
  };
}

/** A NEW loss event: the only place (with ON_RUNNING's loss) the token
 *  increments; the deadline is anchored at [now]. */
function armLoss(s: GuardianState, now: LossClock, rerunOn = false): Transition {
  const token = s.lossToken + 1;
  return {
    state: { mode: 'LOSS_PENDING', lossToken: token, pending: rerunOn ? 'ON' : 'NONE', ...lossAnchor(now, LOSS_DEBOUNCE_MS), lossArmed: true },
    effects: [{ type: 'armDebounce', token, delayMs: LOSS_DEBOUNCE_MS }],
  };
}

/** Wall-clock remaining budget, clamped to [0, LOSS_DEBOUNCE_MS]. Only the
 *  one-time fallback for a loss without a monotonic anchor (older build). */
export function lossRemainingMs(lossAtMs: number, nowMs: number): number {
  return Math.min(LOSS_DEBOUNCE_MS, Math.max(0, lossAtMs + LOSS_DEBOUNCE_MS - nowMs));
}

/** Monotonic remaining budget: LOSS_DEBOUNCE_MS - (elapsedNow - elapsedAtLoss),
 *  clamped to [0, LOSS_DEBOUNCE_MS]. The wall clock is not consulted. 0
 *  (expire now) when the boot differs or either boot is unknown (elapsedRealtime
 *  restarted, so the time since the loss cannot be established), and when the
 *  monotonic clock reads earlier than the loss (inconsistent: same treatment). */
export function lossMonotonicRemainingMs(lossElapsedMs: number, lossBootId: number | null, now: LossClock): number {
  if (lossBootId === null || now.bootId === null || lossBootId !== now.bootId) return 0;
  const elapsed = now.elapsedMs - lossElapsedMs;
  if (elapsed < 0) return 0;
  return Math.min(LOSS_DEBOUNCE_MS, Math.max(0, LOSS_DEBOUNCE_MS - elapsed));
}

/** Recovery of an EXISTING loss (LOSS_PENDING, Wi-Fi still absent). Never a
 *  new token, never a fresh budget:
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
function recoverLoss(s: GuardianState, now: LossClock): Transition {
  if (s.lossArmed === true) return { state: s, effects: [] };
  let remaining: number;
  let base = s;
  if (s.lossElapsedMs !== undefined) {
    remaining = lossMonotonicRemainingMs(s.lossElapsedMs, s.lossBootId ?? null, now);
  } else {
    remaining = s.lossAtMs === undefined ? LOSS_DEBOUNCE_MS : lossRemainingMs(s.lossAtMs, now.wallMs);
    base = { ...cleared(s), ...lossAnchor(now, remaining) };
  }
  if (remaining <= 0) return reduce(base, { type: 'debounceExpired', token: s.lossToken, wifiUp: false });
  return { state: { ...base, lossArmed: true }, effects: [{ type: 'armDebounce', token: s.lossToken, delayMs: remaining }] };
}

/** The design's state machine (wifi-guardian-design.md "State machine"). */
export function reduce(s: GuardianState, e: GuardianEvent): Transition {
  const same: Transition = { state: s, effects: [] };
  if (e.type === 'disable') {
    return {
      state: { mode: 'DISABLED', lossToken: s.lossToken, pending: 'NONE' },
      effects: [{ type: 'cancelDebounce' }, { type: 'unregisterCallbacks' }],
    };
  }
  if (e.type === 'enable') {
    if (s.mode !== 'DISABLED') return same;
    const base = { ...s, mode: 'IDLE_OFFLINE' as Mode, pending: 'NONE' as Pending };
    const reg: Effect = { type: 'registerCallbacks' };
    if (!e.wifiUp) return { state: base, effects: [reg] };
    const t = startOn(base);
    return { state: t.state, effects: [reg, ...t.effects] };
  }
  if (e.type === 'boot') {
    if (!e.enabled) return { state: initialState(false), effects: [] };
    const reg: Effect = { type: 'registerCallbacks' };
    if (!e.wifiUp) {
      // Rebooted / updated away from Wi-Fi after an ON, or during the
      // debounce (the alarm did not survive): (re)arm the loss.
      // A reboot / update also took Shizuku down: ON must run again on regain.
      if (s.mode === 'IDLE_ONLINE') {
        const t = armLoss(s, e.now, true);
        return { state: t.state, effects: [reg, ...t.effects] };
      }
      if (s.mode === 'LOSS_PENDING') {
        // The loss predates this start (no alarm survived): keep its deadline
        // on the same boot; after a real reboot it is expired (OFF now).
        const t = recoverLoss({ ...disarmed(s), pending: 'ON' }, e.now);
        return { state: t.state, effects: [reg, ...t.effects] };
      }
      return { state: s, effects: [reg] };
    }
    if (s.mode === 'ON_RUNNING' || s.mode === 'OFF_RUNNING') {
      return { state: { ...s, pending: 'ON' }, effects: [reg] };
    }
    const t = startOn(cleared(s));
    return { state: t.state, effects: [reg, { type: 'cancelDebounce' }, ...t.effects] };
  }
  if (s.mode === 'DISABLED') return same;
  if (e.type === 'reconcile') {
    // Recovery cannot assume the debounce alarm still exists (it fired before
    // a process death, or the process died between the checkpoint and arming
    // it), but it must not restart the budget either: the loss keeps its
    // deadline and token (coordinator gate round 2).
    if (!e.wifiUp && s.mode === 'LOSS_PENDING') return recoverLoss(s, e.now);
    return reduce(s, e.wifiUp ? { type: 'wifiAvailable' } : { type: 'wifiLost', now: e.now });
  }

  switch (e.type) {
    case 'wifiAvailable':
      switch (s.mode) {
        case 'IDLE_OFFLINE':
          return startOn(s);
        // Unfinished work restored after a process death: finish ON.
        case 'IDLE_ONLINE':
          return s.pending === 'ON' ? startOn(s) : same;
        case 'LOSS_PENDING': {
          // AP switch / momentary drop: cancel; nothing runs unless ON was
          // left unfinished (then it runs again; every step is idempotent).
          if (s.pending === 'ON') {
            const t = startOn(cleared(s));
            return { state: t.state, effects: [{ type: 'cancelDebounce' }, ...t.effects] };
          }
          return { state: { ...cleared(s), mode: 'IDLE_ONLINE', pending: 'NONE' }, effects: [{ type: 'cancelDebounce' }] };
        }
        case 'ON_RUNNING':
          if (s.pending === 'LOSS' || s.pending === 'OFF') {
            return { state: { ...cleared(s), pending: 'NONE' }, effects: [{ type: 'cancelDebounce' }] };
          }
          return same;
        case 'OFF_RUNNING':
          return { state: { ...s, pending: 'ON' }, effects: [] };
        default:
          return same;
      }
    case 'wifiLost':
      switch (s.mode) {
        case 'IDLE_ONLINE':
          return armLoss(s, e.now, s.pending === 'ON');
        case 'ON_RUNNING': {
          // The debounce counts from the loss itself; ON stops after its
          // current step (superseded) and never interleaves with OFF.
          if (s.pending === 'LOSS' || s.pending === 'OFF') return same;
          const token = s.lossToken + 1;
          return {
            state: { ...cleared(s), lossToken: token, pending: 'LOSS', ...lossAnchor(e.now, LOSS_DEBOUNCE_MS), lossArmed: true },
            effects: [{ type: 'armDebounce', token, delayMs: LOSS_DEBOUNCE_MS }],
          };
        }
        case 'OFF_RUNNING':
          return { state: { ...s, pending: 'NONE' }, effects: [] };
        default:
          return same;
      }
    case 'debounceExpired': {
      if (e.token !== s.lossToken) return same;
      if (s.mode === 'ON_RUNNING' && s.pending === 'LOSS') {
        if (e.wifiUp) return { state: { ...cleared(s), pending: 'NONE' }, effects: [] };
        return { state: { ...disarmed(s), pending: 'OFF' }, effects: [] };
      }
      if (s.mode !== 'LOSS_PENDING') return same;
      if (e.wifiUp) {
        if (s.pending === 'ON') return startOn(cleared(s));
        return { state: { ...cleared(s), mode: 'IDLE_ONLINE', pending: 'NONE' }, effects: [] };
      }
      return { state: { ...cleared(s), mode: 'OFF_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOff' }] };
    }
    case 'sequenceDone':
      if (e.kind === 'on' && s.mode === 'ON_RUNNING') {
        // ON may have stopped early (superseded): remember to run it again.
        if (s.pending === 'LOSS') return { state: { ...s, mode: 'LOSS_PENDING', pending: 'ON' }, effects: [] };
        if (s.pending === 'OFF') return { state: { ...cleared(s), mode: 'OFF_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOff' }] };
        // Stopped early, but Wi-Fi is already back: finish it.
        if (e.interrupted === true) return startOn(s);
        return { state: { ...s, mode: 'IDLE_ONLINE', pending: 'NONE' }, effects: [] };
      }
      if (e.kind === 'off' && s.mode === 'OFF_RUNNING') {
        if (s.pending === 'ON') return startOn(s);
        // Stopped early, but Wi-Fi is gone again: finish it.
        if (e.interrupted === true) return { state: { ...s, mode: 'OFF_RUNNING', pending: 'NONE' }, effects: [{ type: 'runOff' }] };
        return { state: { ...s, mode: 'IDLE_OFFLINE', pending: 'NONE' }, effects: [] };
      }
      return same;
    default:
      return same;
  }
}

// ── Shizuku watchdog ───────────────────────────────────────────────────────
export const WD_DETECTED_DEAD = 'shizuku_watchdog_detected_dead';
export const WD_RECOVERY_STARTED = 'shizuku_watchdog_recovery_started';
export const WD_RECOVERY_SUCCEEDED = 'shizuku_watchdog_recovery_succeeded';
export const WD_RECOVERY_FAILED = 'shizuku_watchdog_recovery_failed';
export const WD_GAVE_UP = 'shizuku_watchdog_gave_up';
export type ShizukuWatchdogEvent =
  | 'shizuku_watchdog_detected_dead'
  | 'shizuku_watchdog_recovery_started'
  | 'shizuku_watchdog_recovery_succeeded'
  | 'shizuku_watchdog_recovery_failed'
  | 'shizuku_watchdog_gave_up';
export const SHIZUKU_WATCHDOG_EVENTS: readonly ShizukuWatchdogEvent[] = [
  'shizuku_watchdog_detected_dead', 'shizuku_watchdog_recovery_started', 'shizuku_watchdog_recovery_succeeded',
  'shizuku_watchdog_recovery_failed', 'shizuku_watchdog_gave_up',
];

/** The probes one watchdog observation reads, in observeShizukuWatchdog's order. */
export interface WatchdogProbes {
  /** STOP-ALL (`.halted`); unreadable = true. */
  stopAll(): boolean;
  /** Wi-Fi with INTERNET up; null = cannot tell. */
  wifiUp(): boolean | null;
  /** Shizuku.pingBinder(); any error = false. */
  shizukuAlive(): boolean;
}

type WatchdogTick = Extract<GuardianEvent, { type: 'shizukuWatchdogTick' }>;

/** STOP-ALL first: while it is on nothing else is read. Shizuku is pinged only
 *  with Wi-Fi known to be up. */
export function observeShizukuWatchdog(p: WatchdogProbes, now: LossClock): WatchdogTick {
  if (p.stopAll()) return { type: 'shizukuWatchdogTick', stopAll: true, wifiUp: null, alive: null, now };
  const wifi = p.wifiUp();
  if (wifi !== true) return { type: 'shizukuWatchdogTick', stopAll: false, wifiUp: wifi, alive: null, now };
  return { type: 'shizukuWatchdogTick', stopAll: false, wifiUp: true, alive: p.shizukuAlive(), now };
}

/** The probes read when a sequence ends, in sequenceDoneFor's order. */
export interface CompletionProbes extends WatchdogProbes {
  /** The guardian toggle mirror; unreadable = false. */
  enabled(): boolean;
}

type SequenceDone = Extract<GuardianEvent, { type: 'sequenceDone' }>;

/** The sequenceDone event for a sequence that returned [result] (gate round 2:
 *  the gates are read again AT COMPLETION, not taken from the runner's return
 *  code). [start]: the clock just before the runner began (kept for an ON
 *  only).
 *   - stopped / disabled / superseded: no ping; stopped unless superseded,
 *     interrupted when superseded.
 *   - otherwise, STOP-ALL first, then the toggle, then (recovery only) Wi-Fi:
 *     any of them failing now = stopped (a recovery is refunded; a plain ON
 *     ignores it). STOP-ALL raised, the guardian turned off or Wi-Fi lost
 *     during the last step / end audit can never count.
 *   - all gates pass: only a recovery pings Shizuku (its success test). A
 *     plain ON is never pinged: nothing reads shizukuUp for it. */
export function sequenceDoneFor(
  kind: SeqKind,
  result: SequenceResult,
  recovery: boolean,
  start: LossClock,
  p: CompletionProbes,
): SequenceDone {
  const st = kind === 'on' ? start : null;
  if (isAbort(result)) {
    return { type: 'sequenceDone', kind, interrupted: result === 'superseded', shizukuUp: false, stopped: result !== 'superseded', start: st };
  }
  if (kind !== 'on') return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: false, stopped: false, start: null };
  if (p.stopAll() || !p.enabled() || (recovery && p.wifiUp() !== true)) {
    return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: false, stopped: true, start: st };
  }
  if (!recovery) return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: false, stopped: false, start: st };
  return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: p.shizukuAlive(), stopped: false, start: st };
}

/** Online, nothing running, nothing owed: the only state the watchdog acts in. */
export function settledOnline(s: GuardianState): boolean {
  return s.mode === 'IDLE_ONLINE' && s.pending === 'NONE';
}

/** A new Wi-Fi session for the watchdog: counters, backoff, give-up, recovery
 *  intent and the observed-healthy accumulation cleared. */
export function freshWatchdog(s: GuardianState): GuardianState {
  const { wdAttempts: _a, wdLastAttemptElapsedMs: _l, wdBootId: _b, wdGaveUp: _g, wdRecovering: _r, ...rest } = s;
  return withoutHealthyWindow(rest);
}

/** A dead tick: no health observed; the accumulation starts over. */
function withoutHealthyWindow(s: GuardianState): GuardianState {
  const { wdHealthyAccumMs: _h, ...rest } = withHealthyChainBroken(s);
  return rest;
}

/** STOP-ALL or an unknown reading: the time since the last alive tick was not
 *  observed, so the chain breaks (the next alive tick is a first observation
 *  and credits nothing); what was already observed is kept. */
function withHealthyChainBroken(s: GuardianState): GuardianState {
  const { wdHealthyLastElapsedMs: _l, wdHealthyBootId: _hb, ...rest } = s;
  return rest;
}

/** An alive tick (gate round 2: observed health, not a start timestamp). The
 *  gap since the previous alive tick is credited only when that tick exists
 *  (chain not broken), both boots are known and equal, and
 *  0 <= gap <= SHIZUKU_WATCHDOG_HEALTHY_GAP_MS. Credited up to
 *  SHIZUKU_WATCHDOG_HEALTHY_RESET_MS: the session resets. A chain that exists
 *  but cannot be proven continuous (boot unknown / changed, gap out of range)
 *  zeroes the accumulation; a broken chain (STOP-ALL, unknown reading) keeps
 *  it and credits nothing. This tick always becomes the next gap's start. */
function healthyTick(s: GuardianState, now: LossClock): GuardianState {
  const last = s.wdHealthyLastElapsedMs;
  const boot = s.wdHealthyBootId ?? null;
  const accum = s.wdHealthyAccumMs ?? 0;
  const delta = now.elapsedMs - (last ?? now.elapsedMs);
  const credited =
    last !== undefined && boot !== null && now.bootId !== null && boot === now.bootId &&
    delta >= 0 && delta <= SHIZUKU_WATCHDOG_HEALTHY_GAP_MS;
  let base: GuardianState;
  if (last === undefined) base = s;
  else if (!credited) base = withoutHealthyWindow(s);
  else if (accum + delta >= SHIZUKU_WATCHDOG_HEALTHY_RESET_MS) base = freshWatchdog(s);
  else base = { ...s, wdHealthyAccumMs: accum + delta };
  const { wdHealthyBootId: _hb, ...rest } = base;
  return { ...rest, wdHealthyLastElapsedMs: now.elapsedMs, ...(now.bootId === null ? {} : { wdHealthyBootId: now.bootId }) };
}

/** Restores the persisted watchdog session onto a restored state. The recovery
 *  intent survives only onto an owed ON (the 'in_flight' restore: online,
 *  pending ON) with an attempt counted for it (gate round 2). */
export function restoreWatchdog(
  s: GuardianState,
  attempts: number,
  lastAttemptElapsedMs: number | null,
  bootId: number | null,
  gaveUp: boolean,
  healthyAccumMs = 0,
  healthyLastElapsedMs: number | null = null,
  healthyBootId: number | null = null,
  recovering = false,
): GuardianState {
  if (s.mode === 'DISABLED') return s;
  const n = Math.min(SHIZUKU_WATCHDOG_MAX_ATTEMPTS, Math.max(0, Math.trunc(attempts)));
  const accum = Math.min(SHIZUKU_WATCHDOG_HEALTHY_RESET_MS, Math.max(0, healthyAccumMs));
  const owed = s.mode === 'IDLE_ONLINE' && s.pending === 'ON';
  return {
    ...freshWatchdog(s),
    ...(n === 0 ? {} : { wdAttempts: n }),
    ...(lastAttemptElapsedMs === null ? {} : { wdLastAttemptElapsedMs: lastAttemptElapsedMs }),
    ...(lastAttemptElapsedMs === null || bootId === null ? {} : { wdBootId: bootId }),
    ...(gaveUp ? { wdGaveUp: true as const } : {}),
    ...(recovering && n > 0 && owed ? { wdRecovering: true as const } : {}),
    ...(accum === 0 ? {} : { wdHealthyAccumMs: accum }),
    ...(healthyLastElapsedMs === null ? {} : { wdHealthyLastElapsedMs: healthyLastElapsedMs }),
    ...(healthyLastElapsedMs === null || healthyBootId === null ? {} : { wdHealthyBootId: healthyBootId }),
  };
}

/** Wi-Fi was absent (or being given up) before this event. */
function wasOffline(s: GuardianState): boolean {
  return (
    s.mode === 'IDLE_OFFLINE' ||
    s.mode === 'LOSS_PENDING' ||
    s.mode === 'OFF_RUNNING' ||
    (s.mode === 'ON_RUNNING' && (s.pending === 'LOSS' || s.pending === 'OFF'))
  );
}

/** Events that open a new watchdog session: Wi-Fi reconnect, guardian re-enable
 *  (from DISABLED only: RN rewrites the mirror at every app start), boot / app
 *  update. (The fourth reset, 24 h of continuous health, is the tick's.) */
function opensSession(s: GuardianState, e: GuardianEvent): boolean {
  switch (e.type) {
    case 'enable':
      return s.mode === 'DISABLED';
    case 'boot':
      return true;
    case 'wifiAvailable':
      return wasOffline(s);
    case 'reconcile':
    case 'debounceExpired':
      return e.wifiUp && wasOffline(s);
    default:
      return false;
  }
}

/** Backoff since the last recovery start passed. A different (known) boot or a
 *  monotonic clock that reads earlier = the clock restarted: passed (the
 *  per-session cap still bounds the attempts). */
export function watchdogBackoffPassed(s: GuardianState, now: LossClock): boolean {
  if (s.wdLastAttemptElapsedMs === undefined) return true;
  const boot = s.wdBootId ?? null;
  if (boot !== null && now.bootId !== null && boot !== now.bootId) return true;
  const dt = now.elapsedMs - s.wdLastAttemptElapsedMs;
  return dt < 0 || dt >= SHIZUKU_WATCHDOG_BACKOFF_MS;
}

/** The event takes Wi-Fi away or turns the guardian off: the watchdog tick
 *  must not outlive settled-online (gate round 1). Rule: WifiLost, Disable,
 *  Reconcile that probed Wi-Fi down, or a DebounceExpired that starts the OFF
 *  path. Cancelling is idempotent, so it is emitted for these events whatever
 *  the state was. */
function disarmsWatchdog(e: GuardianEvent, fx: Effect[]): boolean {
  switch (e.type) {
    case 'wifiLost':
    case 'disable':
      return true;
    case 'reconcile':
      return !e.wifiUp;
    case 'debounceExpired':
      return fx.some((x) => x.type === 'runOff');
    default:
      return false;
  }
}

/** The guardian's transition function: reduce plus the Shizuku watchdog layer
 *  (session resets, recovery outcome, tick arming / disarming). Pure.
 *
 *  Recovery outcome (gate round 1): an interrupted recovery (STOP-ALL, toggle
 *  off, superseded) is refunded and checked FIRST, so a lucky ping cannot
 *  count it as a success. Gate round 3: the refund gives the attempt back but
 *  keeps the cooldown: e.start (when known) stamps the backoff anchor, else
 *  the anchor is left as it was; a late STOP-ALL cannot shorten the 30-minute
 *  spacing between recovery starts. A recovery that ran to its end is audited succeeded
 *  or failed and stamps the backoff anchor with its start (start to start);
 *  the attempt count is never lowered by a success. A plain ON changes no
 *  watchdog state.
 *
 *  Gate round 2: a refunded recovery with no ON owed (pending NONE) never
 *  becomes a plain ON. reduce reads an interrupted ON as "Wi-Fi came back:
 *  finish it", but a recovery is superseded by its own Wi-Fi re-probe too, and
 *  a plain ON has no such probe (it could write adb_wifi_enabled=1 with Wi-Fi
 *  down). Its runOn is dropped and the state settles online (the tick re-arms;
 *  the loss flow / next tick re-derive anything genuinely owed). A pending ON
 *  is a real obligation and keeps its runOn. And the recovery intent is
 *  durable: an ON owed with wdRecovering still set (only the restored owed ON
 *  after a death between checkpoint and dispatch) runs as runShizukuRecovery,
 *  so the attempt already counted is resolved by its own outcome. */
export function reduceWithWatchdog(s: GuardianState, e: GuardianEvent): Transition {
  if (e.type === 'shizukuWatchdogTick') return watchdogTick(s, e);
  const base = opensSession(s, e) ? freshWatchdog(s) : s;
  const t = reduce(base, e);
  let st = t.state;
  let fx = [...t.effects];
  if (e.type === 'sequenceDone' && e.kind === 'on' && s.mode === 'ON_RUNNING' && s.wdRecovering === true) {
    const n = s.wdAttempts ?? 0;
    if (e.stopped === true || e.interrupted === true) {
      // Cut short before it could finish: no attempt burned, nothing audited.
      // But it was dispatched and began (it may have cycled wireless
      // debugging), so its start still governs the cooldown (gate round 3):
      // the anchor is set from e.start even at count 0, and never cleared.
      st = refundedCount(st);
      if (e.start != null) st = withAttemptAnchor(st, e.start);
      if (s.pending === 'NONE' && fx.some((x) => x.type === 'runOn')) {
        // Nothing owed: never a plain ON (it has no Wi-Fi probe).
        fx = fx.filter((x) => x.type !== 'runOn');
        st = { ...st, mode: 'IDLE_ONLINE', pending: 'NONE' };
      }
    } else {
      const { wdRecovering: _r, ...rest } = st;
      st = e.start == null ? rest : withAttemptAnchor(rest, e.start);
      if (e.shizukuUp === true) {
        fx.push({ type: 'shizukuWatchdogAudit', event: WD_RECOVERY_SUCCEEDED, attempt: n });
      } else {
        fx.push({ type: 'shizukuWatchdogAudit', event: WD_RECOVERY_FAILED, attempt: n });
        if (n >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS && s.wdGaveUp !== true) {
          fx.push({ type: 'shizukuWatchdogAudit', event: WD_GAVE_UP, attempt: n });
          fx.push({ type: 'notifyShizukuWatchdogGaveUp' });
          st = { ...st, wdGaveUp: true };
        }
      }
    }
  }
  // An ON started here: a recovery whose intent survived (restored owed ON)
  // runs as one; any other ON is plain, not a recovery.
  if (fx.some((x) => x.type === 'runOn')) {
    if (st.wdRecovering === true) {
      fx = fx.map((x): Effect => (x.type === 'runOn' ? { type: 'runShizukuRecovery' } : x));
    } else {
      const { wdRecovering: _r, ...rest } = st;
      st = rest;
    }
  }
  // Entering the settled-online state starts the tick.
  if (settledOnline(st) && !settledOnline(s)) fx.push({ type: 'armShizukuWatchdog', delayMs: SHIZUKU_WATCHDOG_TICK_MS });
  // Leaving it through a loss / toggle off stops it.
  if (disarmsWatchdog(e, fx)) fx.push({ type: 'cancelShizukuWatchdog' });
  return { state: st, effects: fx };
}

/** The backoff anchor: the clock at which the recovery started running. */
function withAttemptAnchor(s: GuardianState, start: LossClock): GuardianState {
  const { wdBootId: _b, ...rest } = s;
  return { ...rest, wdLastAttemptElapsedMs: start.elapsedMs, ...(start.bootId === null ? {} : { wdBootId: start.bootId }) };
}

/** One watchdog observation. Acts only while settled online. */
function watchdogTick(s: GuardianState, e: WatchdogTick): Transition {
  const same: Transition = { state: s, effects: [] };
  // Toggle off, offline, a sequence running or owed: the guardian's own flow
  // owns the state (and re-arms the tick when it settles online).
  if (!settledOnline(s)) return same;
  // STOP-ALL first: nothing run, counted, audited or re-armed. A later check
  // (reconcile, Wi-Fi available) or settling online again re-arms the tick.
  // The healthy chain breaks: STOP-ALL time is not observed.
  if (e.stopAll) return { state: withHealthyChainBroken(s), effects: [] };
  const rearm: Effect = { type: 'armShizukuWatchdog', delayMs: SHIZUKU_WATCHDOG_TICK_MS };
  // Wi-Fi down: inert (the loss flow owns it). Unknown: look again later.
  // Either way nothing was observed: the healthy chain breaks.
  if (e.wifiUp === false) return { state: withHealthyChainBroken(s), effects: [] };
  if (e.wifiUp === null || e.alive === null) return { state: withHealthyChainBroken(s), effects: [rearm] };
  // Alive: the session is NOT reset (monotonic); only 24 h of observed health
  // resets it (healthyTick).
  if (e.alive) return { state: healthyTick(s, e.now), effects: [rearm] };
  const sd = withoutHealthyWindow(s);
  const attempts = sd.wdAttempts ?? 0;
  if (sd.wdGaveUp === true) return { state: sd, effects: [rearm] };
  if (attempts >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS) {
    return {
      state: { ...sd, wdGaveUp: true },
      effects: [{ type: 'shizukuWatchdogAudit', event: WD_GAVE_UP, attempt: attempts }, { type: 'notifyShizukuWatchdogGaveUp' }, rearm],
    };
  }
  const dead: Effect = { type: 'shizukuWatchdogAudit', event: WD_DETECTED_DEAD, attempt: attempts };
  if (!watchdogBackoffPassed(sd, e.now)) return { state: sd, effects: [dead, rearm] };
  const n = attempts + 1;
  // The backoff anchor is NOT stamped here: the run may start much later
  // (service start, alarm hop). SequenceDone.start stamps it.
  return {
    state: { ...sd, mode: 'ON_RUNNING', pending: 'NONE', wdAttempts: n, wdRecovering: true },
    effects: [dead, { type: 'shizukuWatchdogAudit', event: WD_RECOVERY_STARTED, attempt: n }, { type: 'runShizukuRecovery' }],
  };
}

// ── Step runner ────────────────────────────────────────────────────────────
export type Step = 'wifi_debug' | 'shizuku' | 'tailscale' | 'sequence';
export type Action = 'check' | 'enable' | 'disable' | 'wait' | 'connect' | 'end';
export type Level = 'on' | 'off' | 'unknown' | 'none';
export type Outcome =
  | 'already'
  | 'ok'
  | 'unverified'
  | 'not_applied'
  | 'grant_missing'
  | 'write_failed'
  | 'timeout'
  | 'cooldown'
  | 'probe_unknown'
  | 'preapproval_off'
  | 'dispatch_failed'
  | 'verify_failed'
  | 'stopped'
  | 'disabled'
  | 'superseded'
  | 'done'
  | 'assist'
  | 'failed'
  | 'settled'
  | 'settle_timeout';

export const STEPS: readonly Step[] = ['wifi_debug', 'shizuku', 'tailscale', 'sequence'];
export const ACTIONS: readonly Action[] = ['check', 'enable', 'disable', 'wait', 'connect', 'end'];
export const LEVELS: readonly Level[] = ['on', 'off', 'unknown', 'none'];
export const OUTCOMES: readonly Outcome[] = [
  'already', 'ok', 'unverified', 'not_applied', 'grant_missing', 'write_failed', 'timeout', 'cooldown',
  'probe_unknown', 'preapproval_off', 'dispatch_failed', 'verify_failed', 'stopped', 'disabled', 'superseded',
  'done', 'assist', 'failed', 'settled', 'settle_timeout',
];
/** ClosePaw run states (ClosePawRunResults) that end a run: completion
 *  tracking for sequencing only, never success. */
export const CLOSEPAW_SETTLED_STATUSES: readonly string[] = [
  'completed', 'failed', 'cancelled', 'timeout', 'uncertain', 'lost', 'rejected', 'expired',
];

export function isClosePawSettled(status: string | null | undefined): boolean {
  return status != null && CLOSEPAW_SETTLED_STATUSES.includes(status);
}

/** Assist notification reasons (one notification per sequence at most). */
export type AssistReason =
  | 'grant_missing'
  | 'wifi_debug_not_applied'
  | 'wifi_debug_off_failed'
  | 'shizuku_timeout'
  | 'tailscale_preapproval_off'
  | 'tailscale_failed'
  | 'shizuku_watchdog_gave_up';
export const ASSIST_REASONS: readonly AssistReason[] = [
  'grant_missing', 'wifi_debug_not_applied', 'wifi_debug_off_failed', 'shizuku_timeout', 'tailscale_preapproval_off',
  'tailscale_failed', 'shizuku_watchdog_gave_up',
];

export interface Ports {
  nowMs(): number;
  sleep(ms: number): void;
  /** Toggle mirror readable and ON (unreadable = false). */
  enabled(): boolean;
  /** STOP-ALL (`.halted`); unreadable = true. */
  stopAll(): boolean;
  /** The opposite intent arrived (Wi-Fi lost during ON / back during OFF):
   *  finish the current step, start no new one. */
  superseded(): boolean;
  hasWriteSecureSettings(): boolean;
  /** adb_wifi_enabled: 1 / 0, or null when it cannot be read. */
  readAdbWifi(): number | null;
  writeAdbWifi(value: number): boolean;
  /** Shizuku.pingBinder(); any error = false. */
  shizukuAlive(): boolean;
  /** Wi-Fi with INTERNET up; null = cannot tell. Read by a watchdog recovery
   *  before its first write (a queued recovery may start after Wi-Fi left). */
  wifiUp(): boolean | null;
  /** TRANSPORT_VPN present: true / false, or null when it cannot be told. */
  vpnUp(): boolean | null;
  /** ClosePawShellPreapproval.isOn(). */
  closePawPreapproved(): boolean;
  /** The single seam (TailscaleControl.requestTailscale), connect-only. The
   *  request id when handed off, else null. Its answer never passes a step:
   *  only [vpnUp] does. */
  requestTailscale(): string | null;
  /** The ClosePaw run for [reqId] reached a terminal state
   *  ([isClosePawSettled]); unreadable = false. Sequencing only. */
  closePawSettled(reqId: string): boolean;
  audit(seq: string, step: Step, action: Action, before: Level, after: Level, outcome: Outcome): void;
  notifyAssist(reason: AssistReason): void;
}

/** Cross-run memory of the runner (in-process only). */
export interface RunnerMemory {
  lastShizukuTimeoutAt: number | null;
}

export function newRunnerMemory(): RunnerMemory {
  return { lastShizukuTimeoutAt: null };
}

type Abort = 'stopped' | 'disabled' | 'superseded';
type Gate = 'go' | Abort;

function gate(p: Ports): Gate {
  if (!p.enabled()) return 'disabled';
  if (p.stopAll()) return 'stopped';
  if (p.superseded()) return 'superseded';
  return 'go';
}

function isAbort(g: string): g is Abort {
  return g === 'stopped' || g === 'disabled' || g === 'superseded';
}

function adbLevel(v: number | null): Level {
  return v === null ? 'unknown' : v === 1 ? 'on' : 'off';
}

function vpnLevel(v: boolean | null): Level {
  return v === null ? 'unknown' : v ? 'on' : 'off';
}

/** Polls [probe] every [pollMs] until it returns true or [budgetMs] passed;
 *  stops early (returning the gate) when the toggle goes off / STOP-ALL. */
function pollUntil(p: Ports, budgetMs: number, pollMs: number, probe: () => boolean): 'ok' | 'timeout' | Gate {
  const start = p.nowMs();
  for (;;) {
    if (probe()) return 'ok';
    if (p.nowMs() - start >= budgetMs) return 'timeout';
    const g = gate(p);
    if (g !== 'go') return g;
    p.sleep(pollMs);
  }
}

export type SequenceResult = 'done' | 'assist' | 'failed' | 'stopped' | 'disabled' | 'superseded';

/** [quiet]: a watchdog recovery; its step failures are audited but not
 *  notified (the watchdog's single give-up notification speaks for it). */
class Run {
  notified = false;
  constructor(readonly p: Ports, readonly seq: string, readonly quiet = false) {}
  audit(step: Step, action: Action, before: Level, after: Level, outcome: Outcome) {
    this.p.audit(this.seq, step, action, before, after, outcome);
  }
  assist(reason: AssistReason) {
    if (this.notified || this.quiet) return;
    this.notified = true;
    this.p.notifyAssist(reason);
  }
  end(result: SequenceResult): SequenceResult {
    this.audit('sequence', 'end', 'none', 'none', result);
    return result;
  }
  /** Checked before every step: null = go, else the reason (audited). */
  gated(step: Step): Abort | null {
    const g = gate(this.p);
    if (g === 'go') return null;
    this.audit(step, 'check', 'none', 'none', g);
    return g;
  }
}

/** ON: wireless debugging → wait for Shizuku → Tailscale. [recovery] (Shizuku
 *  watchdog): Wi-Fi is probed again before any write and once more right
 *  before the enable write (not known up = superseded, fail closed); wireless debugging that is already on is cycled OFF → ON
 *  first, so Shizuku's own auto-start sees a fresh trigger; step failures are
 *  not notified. */
export function runOnSequence(p: Ports, mem: RunnerMemory, seq: string, recovery = false): SequenceResult {
  const r = new Run(p, seq, recovery);

  // 1. Wireless debugging.
  let stop = r.gated('wifi_debug');
  if (stop) return r.end(stop);
  if (recovery && p.wifiUp() !== true) {
    // Queued while settled online, but Wi-Fi left before it ran: no write.
    r.audit('wifi_debug', 'check', 'none', 'none', 'superseded');
    return r.end('superseded');
  }
  let adbBefore = p.readAdbWifi();
  if (recovery && adbBefore === 1) {
    const cycled = cycleWifiDebugOff(r);
    if (cycled !== null) return r.end(cycled);
    stop = r.gated('wifi_debug');
    if (stop) return r.end(stop);
    adbBefore = p.readAdbWifi();
  }
  if (adbBefore === 1) {
    r.audit('wifi_debug', 'check', 'on', 'on', 'already');
  } else {
    if (!p.hasWriteSecureSettings()) {
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(adbBefore), 'grant_missing');
      r.assist('grant_missing');
      return r.end('assist');
    }
    if (recovery && p.wifiUp() !== true) {
      // Gate round 4: Wi-Fi left during the cycle pause (or since the first
      // probe). Never write wireless debugging on without Wi-Fi; the loss flow
      // owns the OFF state.
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(adbBefore), 'superseded');
      return r.end('superseded');
    }
    if (!p.writeAdbWifi(1)) {
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(p.readAdbWifi()), 'write_failed');
      r.assist('wifi_debug_not_applied');
      return r.end('assist');
    }
    let last: number | null = null;
    const verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS, () => {
      last = p.readAdbWifi();
      return last === 1;
    });
    if (isAbort(verified)) {
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(last), verified);
      return r.end(verified);
    }
    if (verified === 'ok') {
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), 'on', 'ok');
    } else if (last === null) {
      // The hidden key cannot be read back: the Shizuku wait is the check.
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), 'unknown', 'unverified');
    } else {
      // Did not take effect (e.g. the network-trust dialog is pending).
      // Never accept it: stop and tell the owner.
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(last), 'not_applied');
      r.assist('wifi_debug_not_applied');
      return r.end('assist');
    }
  }

  // 2. Shizuku: never started by the guardian; wait for its own auto-start.
  stop = r.gated('shizuku');
  if (stop) return r.end(stop);
  if (p.shizukuAlive()) {
    mem.lastShizukuTimeoutAt = null;
    r.audit('shizuku', 'check', 'on', 'on', 'already');
  } else {
    const last = mem.lastShizukuTimeoutAt;
    if (last !== null && p.nowMs() - last < SHIZUKU_RETRY_COOLDOWN_MS) {
      r.audit('shizuku', 'wait', 'off', 'off', 'cooldown');
      return r.end('assist');
    }
    const waited = pollUntil(p, SHIZUKU_WAIT_MS, SHIZUKU_POLL_MS, () => p.shizukuAlive());
    if (isAbort(waited)) {
      r.audit('shizuku', 'wait', 'off', 'off', waited);
      return r.end(waited);
    }
    if (waited === 'timeout') {
      mem.lastShizukuTimeoutAt = p.nowMs();
      r.audit('shizuku', 'wait', 'off', 'off', 'timeout');
      r.assist('shizuku_timeout');
      return r.end('assist');
    }
    mem.lastShizukuTimeoutAt = null;
    r.audit('shizuku', 'wait', 'off', 'on', 'ok');
  }

  // 3. Tailscale.
  const t = tailscaleStep(r);
  return r.end(t ?? 'done');
}

/** Recovery only: wireless debugging on → off (verified), then a short pause.
 *  null = off (or unreadable: the Shizuku wait is the check), go on to the
 *  normal enable step; else the sequence result. */
function cycleWifiDebugOff(r: Run): SequenceResult | null {
  const p = r.p;
  if (!p.hasWriteSecureSettings()) {
    r.audit('wifi_debug', 'disable', 'on', 'on', 'grant_missing');
    r.assist('grant_missing');
    return 'assist';
  }
  if (!p.writeAdbWifi(0)) {
    r.audit('wifi_debug', 'disable', 'on', adbLevel(p.readAdbWifi()), 'write_failed');
    r.assist('wifi_debug_off_failed');
    return 'assist';
  }
  let last: number | null = null;
  const verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS, () => {
    last = p.readAdbWifi();
    return last === 0;
  });
  if (isAbort(verified)) {
    r.audit('wifi_debug', 'disable', 'on', adbLevel(last), verified);
    return verified;
  }
  if (verified === 'ok') {
    r.audit('wifi_debug', 'disable', 'on', 'off', 'ok');
  } else if (last === null) {
    r.audit('wifi_debug', 'disable', 'on', 'unknown', 'unverified');
  } else {
    r.audit('wifi_debug', 'disable', 'on', adbLevel(last), 'verify_failed');
    r.assist('wifi_debug_off_failed');
    return 'failed';
  }
  p.sleep(WIFI_DEBUG_CYCLE_PAUSE_MS);
  return null;
}

/** OFF: wireless debugging only. Tailscale is never touched here (it stays
 *  connected on mobile data), so OFF never dispatches ClosePaw and does not
 *  depend on the ClosePaw pre-approval. */
export function runOffSequence(p: Ports, seq: string): SequenceResult {
  const r = new Run(p, seq);
  const stop = r.gated('wifi_debug');
  if (stop) return r.end(stop);
  const adbBefore = p.readAdbWifi();
  if (adbBefore === 0) {
    r.audit('wifi_debug', 'check', 'off', 'off', 'already');
    return r.end('done');
  }
  if (!p.hasWriteSecureSettings()) {
    r.audit('wifi_debug', 'disable', adbLevel(adbBefore), adbLevel(adbBefore), 'grant_missing');
    r.assist('grant_missing');
    return r.end('assist');
  }
  if (!p.writeAdbWifi(0)) {
    r.audit('wifi_debug', 'disable', adbLevel(adbBefore), adbLevel(p.readAdbWifi()), 'write_failed');
    r.assist('wifi_debug_off_failed');
    return r.end('failed');
  }
  let last: number | null = null;
  const verified = pollUntil(p, ADB_WIFI_VERIFY_MS, ADB_WIFI_POLL_MS, () => {
    last = p.readAdbWifi();
    return last === 0;
  });
  if (isAbort(verified)) {
    r.audit('wifi_debug', 'disable', adbLevel(adbBefore), adbLevel(last), verified);
    return r.end(verified);
  }
  if (verified === 'ok') {
    r.audit('wifi_debug', 'disable', adbLevel(adbBefore), 'off', 'ok');
    return r.end('done');
  }
  if (last === null) {
    // Cannot confirm it is off: tell the owner (no Shizuku check stands in here).
    r.audit('wifi_debug', 'disable', adbLevel(adbBefore), 'unknown', 'unverified');
    r.assist('wifi_debug_off_failed');
    return r.end('assist');
  }
  r.audit('wifi_debug', 'disable', adbLevel(adbBefore), adbLevel(last), 'verify_failed');
  r.assist('wifi_debug_off_failed');
  return r.end('failed');
}

/** Connect-only (ON). Returns null when the step passed (or Tailscale was
 *  already connected). */
function tailscaleStep(r: Run): SequenceResult | null {
  const p = r.p;
  const stop = r.gated('tailscale');
  if (stop) return stop;
  const action: Action = 'connect';
  const before = p.vpnUp();
  if (before === true) {
    r.audit('tailscale', 'check', vpnLevel(before), vpnLevel(before), 'already');
    return null;
  }
  if (before === null) {
    r.audit('tailscale', 'check', 'unknown', 'unknown', 'probe_unknown');
    return 'failed';
  }
  if (!p.closePawPreapproved()) {
    // OFF -> never dispatch; tell the owner what is down.
    r.audit('tailscale', action, vpnLevel(before), vpnLevel(before), 'preapproval_off');
    r.assist('tailscale_preapproval_off');
    return 'assist';
  }
  const reqId = p.requestTailscale();
  if (reqId === null) {
    r.audit('tailscale', action, vpnLevel(before), vpnLevel(p.vpnUp()), 'dispatch_failed');
    r.assist('tailscale_failed');
    return 'assist';
  }
  const dispatchedAt = p.nowMs();
  // Whatever ends the step (ok, superseded, toggle off, STOP-ALL, verify
  // failure, even an exception), the hand-off must settle first: the next
  // sequence must never act against a ClosePaw run still in flight.
  try {
    return verifyTailscale(r, action, before);
  } finally {
    awaitSettle(r, reqId, dispatchedAt);
  }
}

function verifyTailscale(r: Run, action: Action, before: boolean | null): SequenceResult | null {
  const p = r.p;
  let last: boolean | null = before;
  const verified = pollUntil(p, VPN_VERIFY_MS, VPN_POLL_MS, () => {
    last = p.vpnUp();
    return last === true;
  });
  if (isAbort(verified)) {
    r.audit('tailscale', action, vpnLevel(before), vpnLevel(last), verified);
    return verified;
  }
  if (verified === 'ok') {
    r.audit('tailscale', action, vpnLevel(before), 'on', 'ok');
    return null;
  }
  r.audit('tailscale', action, vpnLevel(before), vpnLevel(last), 'verify_failed');
  r.assist('tailscale_failed');
  return 'failed';
}

/** Waits (no gate: toggle off / STOP-ALL / superseded do not cut it short)
 *  until the ClosePaw run settled or [CLOSEPAW_SETTLE_MS] passed since the
 *  dispatch. */
function awaitSettle(r: Run, reqId: string, dispatchedAt: number): void {
  const p = r.p;
  for (;;) {
    if (p.closePawSettled(reqId)) {
      const v = vpnLevel(p.vpnUp());
      r.audit('tailscale', 'wait', v, v, 'settled');
      return;
    }
    if (p.nowMs() - dispatchedAt >= CLOSEPAW_SETTLE_MS) {
      const v = vpnLevel(p.vpnUp());
      r.audit('tailscale', 'wait', v, v, 'settle_timeout');
      return;
    }
    p.sleep(CLOSEPAW_SETTLE_POLL_MS);
  }
}

/** Runs one whole sequence (exactly one `end` audit line). */
export function runSequence(kind: SeqKind, p: Ports, mem: RunnerMemory, seq: string, recovery = false): SequenceResult {
  return kind === 'on' ? runOnSequence(p, mem, seq, recovery) : runOffSequence(p, seq);
}

// ── Audit line ─────────────────────────────────────────────────────────────
export const AUDIT_KEYS = ['ts', 'kind', 'seq', 'step', 'action', 'before', 'after', 'outcome'] as const;
export const SEQ_RE = /^(on|off)-[0-9]{1,12}$/;

/** One JSON line, fixed keys, closed values only (no SSID / BSSID / free text). */
export function buildAuditLine(
  tsIso: string,
  seq: string,
  step: Step,
  action: Action,
  before: Level,
  after: Level,
  outcome: Outcome,
): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(tsIso)) return null;
  if (!SEQ_RE.test(seq)) return null;
  if (!STEPS.includes(step) || !ACTIONS.includes(action)) return null;
  if (!LEVELS.includes(before) || !LEVELS.includes(after) || !OUTCOMES.includes(outcome)) return null;
  return (
    `{"ts":"${tsIso}","kind":"${AUDIT_KIND}","seq":"${seq}","step":"${step}",` +
    `"action":"${action}","before":"${before}","after":"${after}","outcome":"${outcome}"}`
  );
}

/** Shizuku watchdog line: same file and kind, its own fixed keys. */
export const SHIZUKU_WATCHDOG_AUDIT_KEYS = ['ts', 'kind', 'step', 'event', 'attempt'] as const;

export function buildShizukuWatchdogAuditLine(tsIso: string, event: string, attempt: number): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(tsIso)) return null;
  if (!(SHIZUKU_WATCHDOG_EVENTS as readonly string[]).includes(event)) return null;
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > SHIZUKU_WATCHDOG_MAX_ATTEMPTS) return null;
  return (
    `{"ts":"${tsIso}","kind":"${AUDIT_KIND}","step":"shizuku_watchdog",` + `"event":"${event}","attempt":${attempt}}`
  );
}

// ── ClosePaw queue line ────────────────────────────────────────────────────
/** Strict JS encodeURIComponent (the Kotlin port must match byte for byte). */
export function encodeUriComponent(s: string): string {
  const keep = /[A-Za-z0-9\-_.!~*'()]/;
  let out = '';
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (b < 0x80 && keep.test(c)) out += c;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;

/** `closepaw:<reqId>:<nowMs>:<encodeURIComponent(goal)>`, the format
 *  ClosePawHandoff.parseLine accepts. */
export function closePawLine(reqId: string, nowMs: number, goal: string): string | null {
  if (!REQ_ID_RE.test(reqId)) return null;
  return `closepaw:${reqId}:${nowMs}:${encodeUriComponent(goal)}`;
}

export function goalFor(): string {
  return GOAL_TAILSCALE_CONNECT;
}
