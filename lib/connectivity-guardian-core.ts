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
  /** interrupted = the runner returned 'superseded' (stopped before its last step). */
  | { type: 'sequenceDone'; kind: SeqKind; interrupted?: boolean }
  /** A recovery entry point (app start, watchdog, service start) probed
   *  Wi-Fi: bring the state in line with it. */
  | { type: 'reconcile'; wifiUp: boolean; now: LossClock };

export type Effect =
  | { type: 'runOn' }
  | { type: 'runOff' }
  | { type: 'armDebounce'; token: number; delayMs: number }
  | { type: 'cancelDebounce' }
  | { type: 'registerCallbacks' }
  | { type: 'unregisterCallbacks' };

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
 *  checkpoints again). Every other effect stays: OFF is the cleanup itself. */
export function withoutUndurableOn(t: Transition): Transition {
  if (!t.effects.some((e) => e.type === 'runOn')) return t;
  return {
    state: { ...cleared(t.state), mode: 'IDLE_ONLINE', pending: 'ON' },
    effects: t.effects.filter((e) => e.type !== 'runOn'),
  };
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
  | 'tailscale_failed';
export const ASSIST_REASONS: readonly AssistReason[] = [
  'grant_missing', 'wifi_debug_not_applied', 'wifi_debug_off_failed', 'shizuku_timeout', 'tailscale_preapproval_off',
  'tailscale_failed',
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

class Run {
  notified = false;
  constructor(readonly p: Ports, readonly seq: string) {}
  audit(step: Step, action: Action, before: Level, after: Level, outcome: Outcome) {
    this.p.audit(this.seq, step, action, before, after, outcome);
  }
  assist(reason: AssistReason) {
    if (this.notified) return;
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

/** ON: wireless debugging → wait for Shizuku → Tailscale. */
export function runOnSequence(p: Ports, mem: RunnerMemory, seq: string): SequenceResult {
  const r = new Run(p, seq);

  // 1. Wireless debugging.
  let stop = r.gated('wifi_debug');
  if (stop) return r.end(stop);
  const adbBefore = p.readAdbWifi();
  if (adbBefore === 1) {
    r.audit('wifi_debug', 'check', 'on', 'on', 'already');
  } else {
    if (!p.hasWriteSecureSettings()) {
      r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(adbBefore), 'grant_missing');
      r.assist('grant_missing');
      return r.end('assist');
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
export function runSequence(kind: SeqKind, p: Ports, mem: RunnerMemory, seq: string): SequenceResult {
  return kind === 'on' ? runOnSequence(p, mem, seq) : runOffSequence(p, seq);
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
