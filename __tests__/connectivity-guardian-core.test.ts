/**
 * Wi-Fi connectivity guardian — the pure decision core
 * (lib/connectivity-guardian-core.ts, the TS port of
 * ConnectivityGuardianCore.kt; lockstep is checked in
 * connectivity-guardian-native.test.ts).
 *
 * Numbered describes map to the 12-item test plan in
 * wifi-guardian-design.md ("Jest tests").
 */
import {
  ADB_WIFI_VERIFY_MS,
  AUDIT_FILE,
  CLOSEPAW_SETTLE_MS,
  isClosePawSettled,
  wantsResident,
  withoutUndurableOn,
  type SeqKind,
  AUDIT_KEYS,
  GOAL_MAX_CODE_POINTS,
  GOAL_TAILSCALE_CONNECT,
  LOSS_DEBOUNCE_MS,
  VPN_VERIFY_MS,
  buildAuditLine,
  closePawLine,
  encodeUriComponent,
  goalFor,
  initialState,
  persistableMode,
  reduce,
  restoreState,
  lossRemainingMs,
  lossMonotonicRemainingMs,
  type LossClock,
  runOffSequence,
  runOnSequence,
  runSequence,
  type AssistReason,
  type Effect,
  type GuardianEvent,
  type GuardianState,
  type Ports,
} from '@/lib/connectivity-guardian-core';
import { encodeClosePawQueueLine, parseClosePawQueueLine } from '@/lib/closepaw-queue';

// ── Fake device ────────────────────────────────────────────────────────────
type World = {
  enabled: boolean;
  stopAll: boolean;
  superseded: boolean;
  grant: boolean;
  adb: number | null;
  /** What a write of 1 actually does: 'applies' | 'ignored' (trust dialog) | 'unreadable'. */
  adbWrite: 'applies' | 'ignored' | 'unreadable';
  vpn: boolean | null;
  preapproved: boolean;
  /** What ClosePaw does to the VPN when asked: 'works' | 'nothing'. */
  closePawEffect: 'works' | 'nothing';
  /** What the hand-off answers. */
  dispatchOk: boolean;
  /** ClosePaw acts on the VPN (and its run settles) this long after the hand-off. */
  closePawDelayMs: number;
  /** The run reaches a terminal state this long after ClosePaw acted (null = never). */
  settleAfterActMs: number | null;
};

function makeDevice(over: Partial<World> = {}) {
  const w: World = {
    enabled: true,
    stopAll: false,
    superseded: false,
    grant: true,
    adb: 0,
    adbWrite: 'applies',
    vpn: false,
    preapproved: true,
    closePawEffect: 'works',
    dispatchOk: true,
    closePawDelayMs: 0,
    settleAfterActMs: 0,
    ...over,
  };
  let now = 1_000_000;
  let unreadable = false;
  const calls: string[] = [];
  const audits: Array<{ seq: string; step: string; action: string; before: string; after: string; outcome: string }> = [];
  const notes: AssistReason[] = [];
  const hooks: { onSleep?: (now: number) => void } = {};
  let reqN = 0;
  const runs = new Map<string, { actAt: number; acted: boolean }>();
  /** Lands ClosePaw's (delayed) effect once its time has come. */
  const land = () => {
    for (const r of runs.values()) {
      if (!r.acted && now >= r.actAt) {
        r.acted = true;
        if (w.closePawEffect === 'works') w.vpn = true; // connect-only seam
      }
    }
  };

  const ports: Ports = {
    nowMs: () => now,
    sleep: (ms) => {
      now += ms;
      land();
      hooks.onSleep?.(now);
    },
    enabled: () => w.enabled,
    stopAll: () => w.stopAll,
    superseded: () => w.superseded,
    hasWriteSecureSettings: () => w.grant,
    readAdbWifi: () => (unreadable ? null : w.adb),
    writeAdbWifi: (v) => {
      calls.push(`writeAdbWifi:${v}`);
      if (w.adbWrite === 'unreadable') unreadable = true;
      if (v === 1 && w.adbWrite === 'ignored') return true;
      w.adb = v;
      return true;
    },
    vpnUp: () => {
      land();
      return w.vpn;
    },
    closePawPreapproved: () => w.preapproved,
    requestTailscale: () => {
      calls.push('requestTailscale:connect');
      if (!w.dispatchOk) return null;
      const reqId = `${1763000000000 + reqN++}-0123abcd`;
      runs.set(reqId, { actAt: now + w.closePawDelayMs, acted: false });
      land();
      return reqId;
    },
    closePawSettled: (reqId) => {
      land();
      const r = runs.get(reqId);
      if (!r || !r.acted || w.settleAfterActMs === null) return false;
      return now >= r.actAt + w.settleAfterActMs;
    },
    audit: (seq, step, action, before, after, outcome) => {
      audits.push({ seq, step, action, before, after, outcome });
    },
    notifyAssist: (r) => {
      notes.push(r);
    },
  };
  return { w, ports, calls, audits, notes, hooks, now: () => now };
}

function afterAdbReadback(ports: Ports, onVerified: () => void) {
  const read = ports.readAdbWifi;
  ports.readAdbWifi = () => {
    const value = read();
    if (value === 1) onVerified();
    return value;
  };
}

const effectTypes = (es: Effect[]) => es.map((e) => e.type);
/** A wall-clock instant for loss / recovery events (the persisted anchor's basis). */
const T0 = 1_800_000_000_000;
/** elapsedRealtime at wall T0, and the boot identity, in the clock tests. */
const E0 = 5_000_000;
const BOOT = 3;
/** "Now" with the wall clock and elapsedRealtime moving together (no clock change). */
/** The persisted loss anchor of a loss seen at wall [wallMs] by [clk]. */
const anchorAt = (wallMs: number) => ({ lossAtMs: wallMs, lossElapsedMs: wallMs - T0 + E0, lossBootId: BOOT });
const clk = (wallMs: number, bootId: number | null = BOOT): LossClock => ({ wallMs, elapsedMs: wallMs - T0 + E0, bootId });

function drive(s: GuardianState, events: GuardianEvent[]) {
  const all: Effect[] = [];
  for (const e of events) {
    const t = reduce(s, e);
    s = t.state;
    all.push(...t.effects);
  }
  return { state: s, effects: all };
}

// ── 1 ──────────────────────────────────────────────────────────────────────
describe('1. connect -> ON order: wifi-debug -> Tailscale, each skipped when already up', () => {
  it('Wi-Fi available from idle starts exactly one ON run', () => {
    const t = reduce(initialState(true), { type: 'wifiAvailable' });
    expect(t.state.mode).toBe('ON_RUNNING');
    expect(effectTypes(t.effects)).toEqual(['runOn']);
  });

  it('runs both steps in order and verifies each', () => {
    const d = makeDevice();
    const r = runOnSequence(d.ports, 'on-1');
    expect(r).toBe('done');
    expect(d.calls).toEqual(['writeAdbWifi:1', 'requestTailscale:connect']);
    expect(d.audits.map((a) => `${a.step}:${a.action}:${a.outcome}`)).toEqual([
      'wifi_debug:enable:ok',
      'tailscale:connect:ok',
      'tailscale:wait:settled',
      'sequence:end:done',
    ]);
    expect(d.w).toMatchObject({ adb: 1, vpn: true });
  });

  it('skips every step whose pre-check says already up (idempotent)', () => {
    const d = makeDevice({ adb: 1, vpn: true });
    expect(runOnSequence(d.ports, 'on-2')).toBe('done');
    expect(d.calls).toEqual([]);
    expect(d.audits.map((a) => a.outcome)).toEqual(['already', 'already', 'done']);
    expect(d.notes).toEqual([]);
  });

  it('only the missing step acts', () => {
    const d = makeDevice({ adb: 1, vpn: false });
    expect(runOnSequence(d.ports, 'on-3')).toBe('done');
    expect(d.calls).toEqual(['requestTailscale:connect']);
  });

  it('missing WRITE_SECURE_SETTINGS grant -> assist, nothing written, sequence ends', () => {
    const d = makeDevice({ grant: false });
    expect(runOnSequence(d.ports, 'on-4')).toBe('assist');
    expect(d.calls).toEqual([]);
    expect(d.notes).toEqual(['grant_missing']);
  });

  it('a write that does not take effect (trust dialog pending) aborts ON and notifies; nothing after it runs', () => {
    const d = makeDevice({ adbWrite: 'ignored' });
    expect(runOnSequence(d.ports, 'on-5')).toBe('assist');
    expect(d.calls).toEqual(['writeAdbWifi:1']);
    expect(d.notes).toEqual(['wifi_debug_not_applied']);
    expect(d.audits[0]).toMatchObject({ step: 'wifi_debug', after: 'off', outcome: 'not_applied' });
  });

  it('an unreadable key after the write records an unverified write and proceeds to Tailscale', () => {
    const d = makeDevice({ adbWrite: 'unreadable' });
    expect(runOnSequence(d.ports, 'on-6')).toBe('done');
    expect(d.audits[0]).toMatchObject({ step: 'wifi_debug', after: 'unknown', outcome: 'unverified' });
    expect(d.audits[1]).toMatchObject({ step: 'tailscale', outcome: 'ok' });
  });

});

// ── 2 ──────────────────────────────────────────────────────────────────────
describe('2. loss -> 45 s debounce -> OFF: wireless debugging only (Tailscale stays up)', () => {
  it('arms a 45 s debounce, and only its expiry (Wi-Fi still absent) runs OFF', () => {
    const lost = reduce({ mode: 'IDLE_ONLINE', lossToken: 4, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    expect(lost.state.mode).toBe('LOSS_PENDING');
    expect(lost.effects).toEqual([{ type: 'armDebounce', token: 5, delayMs: LOSS_DEBOUNCE_MS }]);
    expect(LOSS_DEBOUNCE_MS).toBe(45_000);
    const fired = reduce(lost.state, { type: 'debounceExpired', token: 5, wifiUp: false });
    expect(fired.state.mode).toBe('OFF_RUNNING');
    expect(effectTypes(fired.effects)).toEqual(['runOff']);
    const done = reduce(fired.state, { type: 'sequenceDone', kind: 'off' });
    expect(done.state.mode).toBe('IDLE_OFFLINE');
  });

  it('OFF turns wireless debugging off and verifies; Tailscale is left as it is', () => {
    const d = makeDevice({ adb: 1, vpn: true });
    expect(runOffSequence(d.ports, 'off-1')).toBe('done');
    expect(d.calls).toEqual(['writeAdbWifi:0']);
    expect(d.audits.map((a) => `${a.step}:${a.action}:${a.before}>${a.after}:${a.outcome}`)).toEqual([
      'wifi_debug:disable:on>off:ok',
      'sequence:end:none>none:done',
    ]);
    expect(d.w.vpn).toBe(true);
  });

  it('regression (2026-11-17): a Wi-Fi-loss OFF issues NO Tailscale request and no tailscale audit line', () => {
    const d = makeDevice({ adb: 1, vpn: true, preapproved: true });
    let vpnProbes = 0;
    const realVpn = d.ports.vpnUp;
    d.ports.vpnUp = () => {
      vpnProbes++;
      return realVpn();
    };
    // The full path: loss -> debounce expiry -> runOff effect -> runSequence('off').
    const lost = reduce({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const fired = reduce(lost.state, { type: 'debounceExpired', token: lost.state.lossToken, wifiUp: false });
    expect(effectTypes(fired.effects)).toEqual(['runOff']);
    expect(runSequence('off', d.ports, 'off-9')).toBe('done');
    expect(d.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual([]);
    expect(d.audits.filter((a) => a.step === 'tailscale')).toEqual([]);
    expect(vpnProbes).toBe(0);
    expect(d.w).toMatchObject({ adb: 0, vpn: true });
    expect(d.notes).toEqual([]);
  });

  it('regression (2026-11-17): OFF no longer depends on the ClosePaw pre-approval', () => {
    // Under the old spec this assisted out (tailscale_preapproval_off) before the wifi-debug step.
    const d = makeDevice({ adb: 1, vpn: true, preapproved: false });
    expect(runOffSequence(d.ports, 'off-2')).toBe('done');
    expect(d.calls).toEqual(['writeAdbWifi:0']);
    expect(d.w.adb).toBe(0);
    expect(d.notes).toEqual([]);
    expect(d.audits.map((a) => a.outcome)).toEqual(['ok', 'done']);
  });

  it('an already-off OFF does nothing', () => {
    const d = makeDevice({ adb: 0, vpn: false });
    expect(runOffSequence(d.ports, 'off-3')).toBe('done');
    expect(d.calls).toEqual([]);
  });
});

// ── 3 ──────────────────────────────────────────────────────────────────────
describe('3. Wi-Fi returns inside the debounce -> no OFF; a stale alarm token is ignored', () => {
  it('cancels the alarm and returns to online', () => {
    const lost = reduce({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(lost.state, { type: 'wifiAvailable' });
    expect(back.state.mode).toBe('IDLE_ONLINE');
    expect(back.effects).toEqual([{ type: 'cancelDebounce' }]);
    // The (cancelled) alarm firing anyway changes nothing.
    const late = reduce(back.state, { type: 'debounceExpired', token: lost.state.lossToken, wifiUp: false });
    expect(late).toEqual({ state: back.state, effects: [] });
  });

  it('an expiry with an older token is ignored even while a newer loss is pending', () => {
    const first = reduce({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(first.state, { type: 'wifiAvailable' });
    const second = reduce(back.state, { type: 'wifiLost', now: clk(T0) });
    expect(second.state.lossToken).toBe(first.state.lossToken + 1);
    const stale = reduce(second.state, { type: 'debounceExpired', token: first.state.lossToken, wifiUp: false });
    expect(stale.effects).toEqual([]);
    expect(stale.state.mode).toBe('LOSS_PENDING');
  });

  it('an expiry while Wi-Fi is actually up (a missed callback) does not run OFF', () => {
    const lost = reduce({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const t = reduce(lost.state, { type: 'debounceExpired', token: lost.state.lossToken, wifiUp: true });
    expect(t.state.mode).toBe('IDLE_ONLINE');
    expect(t.effects).toEqual([]);
  });
});

// ── 4 ──────────────────────────────────────────────────────────────────────
describe('4. AP switch (lost + available within 45 s) -> nothing runs', () => {
  it('produces no run effect', () => {
    const out = drive({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, [
      { type: 'wifiLost', now: clk(T0) },
      { type: 'wifiAvailable' },
      { type: 'wifiLost', now: clk(T0) },
      { type: 'wifiAvailable' },
    ]);
    expect(out.state.mode).toBe('IDLE_ONLINE');
    expect(effectTypes(out.effects).filter((t) => t === 'runOn' || t === 'runOff')).toEqual([]);
  });
});

// ── 5 ──────────────────────────────────────────────────────────────────────
describe('5. guardian lock: loss during ON finishes ON, then OFF; never interleaved', () => {
  it('a loss during ON arms the debounce at once (counted from the loss); ON finishes; OFF only after', () => {
    let s: GuardianState = initialState(true);
    let t = reduce(s, { type: 'wifiAvailable' });
    s = t.state;
    expect(s.mode).toBe('ON_RUNNING');
    t = reduce(s, { type: 'wifiLost', now: clk(T0) });
    expect(t.effects).toEqual([{ type: 'armDebounce', token: s.lossToken + 1, delayMs: LOSS_DEBOUNCE_MS }]);
    expect(t.state).toMatchObject({ mode: 'ON_RUNNING', pending: 'LOSS' });
    // The debounce expiring while ON still runs never starts OFF in parallel.
    const expired = reduce(t.state, { type: 'debounceExpired', token: t.state.lossToken, wifiUp: false });
    expect(expired.effects).toEqual([]);
    expect(expired.state).toMatchObject({ mode: 'ON_RUNNING', pending: 'OFF' });
    const done = reduce(expired.state, { type: 'sequenceDone', kind: 'on' });
    expect(done.state.mode).toBe('OFF_RUNNING');
    expect(effectTypes(done.effects)).toEqual(['runOff']);
  });

  it('ON finishing before the debounce leaves the armed loss pending (no second alarm)', () => {
    const lost = reduce({ mode: 'ON_RUNNING', lossToken: 2, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const done = reduce(lost.state, { type: 'sequenceDone', kind: 'on' });
    expect(done).toEqual({ state: { mode: 'LOSS_PENDING', lossToken: 3, pending: 'ON', ...anchorAt(T0), lossArmed: true }, effects: [] });
    // A recovery reconcile while that alarm is outstanding changes nothing.
    expect(reduce(done.state, { type: 'reconcile', wifiUp: false, now: clk(T0 + 30_000) })).toEqual({ state: done.state, effects: [] });
    const fired = reduce(done.state, { type: 'debounceExpired', token: 3, wifiUp: false });
    expect(effectTypes(fired.effects)).toEqual(['runOff']);
  });

  it('an ON interrupted by a brief loss runs again when Wi-Fi returns inside the debounce (Codex round 2)', () => {
    let t = reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    t = reduce(t.state, { type: 'sequenceDone', kind: 'on' }); // runner stopped early (superseded)
    expect(t.state).toMatchObject({ mode: 'LOSS_PENDING', pending: 'ON' });
    const back = reduce(t.state, { type: 'wifiAvailable' });
    expect(back.state.mode).toBe('ON_RUNNING');
    expect(effectTypes(back.effects)).toEqual(['cancelDebounce', 'runOn']);
    // Same when only the alarm notices Wi-Fi is back.
    const viaAlarm = reduce(t.state, { type: 'debounceExpired', token: t.state.lossToken, wifiUp: true });
    expect(effectTypes(viaAlarm.effects)).toEqual(['runOn']);
    // And it survives a process death in between.
    const restored = restoreState(true, persistableMode(t.state), t.state.lossToken);
    expect(effectTypes(reduce(restored, { type: 'wifiAvailable' }).effects)).toEqual(['cancelDebounce', 'runOn']);
  });

  it('Wi-Fi back BEFORE the interrupted ON reports done still reruns ON (Codex round 3)', () => {
    let t = reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    t = reduce(t.state, { type: 'wifiAvailable' }); // pending cleared while the runner is stopping
    t = reduce(t.state, { type: 'sequenceDone', kind: 'on', interrupted: true });
    expect(t.state.mode).toBe('ON_RUNNING');
    expect(effectTypes(t.effects)).toEqual(['runOn']);
    // Same via the alarm noticing Wi-Fi is back.
    let u = reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    u = reduce(u.state, { type: 'debounceExpired', token: u.state.lossToken, wifiUp: true });
    u = reduce(u.state, { type: 'sequenceDone', kind: 'on', interrupted: true });
    expect(effectTypes(u.effects)).toEqual(['runOn']);
    // A completed ON does not rerun.
    expect(reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'sequenceDone', kind: 'on' }).effects).toEqual([]);
  });

  it('an interrupted OFF with Wi-Fi gone again reruns OFF', () => {
    let t = reduce({ mode: 'OFF_RUNNING', lossToken: 1, pending: 'NONE' }, { type: 'wifiAvailable' });
    t = reduce(t.state, { type: 'wifiLost', now: clk(T0) });
    t = reduce(t.state, { type: 'sequenceDone', kind: 'off', interrupted: true });
    expect(t.state.mode).toBe('OFF_RUNNING');
    expect(effectTypes(t.effects)).toEqual(['runOff']);
  });

  it('a plain blip after a completed ON still runs nothing', () => {
    const lost = reduce({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    expect(reduce(lost.state, { type: 'wifiAvailable' }).effects).toEqual([{ type: 'cancelDebounce' }]);
  });

  it('Wi-Fi back during ON (after a loss) cancels the debounce', () => {
    const lost = reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(lost.state, { type: 'wifiAvailable' });
    expect(back.effects).toEqual([{ type: 'cancelDebounce' }]);
    expect(back.state.pending).toBe('NONE');
    expect(reduce(back.state, { type: 'sequenceDone', kind: 'on' }).state.mode).toBe('IDLE_ONLINE');
  });

  it('the runner stops after the current step once superseded (never interleaved)', () => {
    const d = makeDevice();
    afterAdbReadback(d.ports, () => { d.w.superseded = true; });
    expect(runOnSequence(d.ports, 'on-1')).toBe('superseded');
    expect(d.calls).toEqual(['writeAdbWifi:1']);
    expect(d.audits.at(-2)).toMatchObject({ step: 'tailscale', action: 'check', outcome: 'superseded' });
    // OFF has a single step (wireless debugging): Wi-Fi back before it starts -> nothing written.
    const e = makeDevice({ adb: 1, vpn: true, superseded: true });
    expect(runOffSequence(e.ports, 'off-1')).toBe('superseded');
    expect(e.calls).not.toContain('writeAdbWifi:0');
    expect(e.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual([]);
  });

  it('Wi-Fi back during OFF: OFF finishes, then ON', () => {
    let t = reduce({ mode: 'OFF_RUNNING', lossToken: 1, pending: 'NONE' }, { type: 'wifiAvailable' });
    expect(t.effects).toEqual([]);
    expect(t.state.pending).toBe('ON');
    t = reduce(t.state, { type: 'sequenceDone', kind: 'off' });
    expect(t.state.mode).toBe('ON_RUNNING');
    expect(effectTypes(t.effects)).toEqual(['runOn']);
  });

  it('pending flags collapse; only the latest intent wins', () => {
    const out = drive({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, [
      { type: 'wifiLost', now: clk(T0) },
      { type: 'wifiAvailable' },
      { type: 'sequenceDone', kind: 'on' },
    ]);
    expect(out.state.mode).toBe('IDLE_ONLINE');
    expect(effectTypes(out.effects)).toEqual(['armDebounce', 'cancelDebounce']);
  });

  it('a done for the other kind is ignored (never interleaves)', () => {
    const s: GuardianState = { mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' };
    expect(reduce(s, { type: 'sequenceDone', kind: 'off' })).toEqual({ state: s, effects: [] });
  });
});

// ── 6 ──────────────────────────────────────────────────────────────────────
describe('6. single-flight ON: concurrent triggers produce one run', () => {
  it('more connect / boot triggers while ON runs never start a second ON', () => {
    const out = drive(initialState(true), [
      { type: 'wifiAvailable' },
      { type: 'wifiAvailable' },
      { type: 'boot', enabled: true, wifiUp: true, now: clk(T0) },
      { type: 'wifiAvailable' },
    ]);
    expect(effectTypes(out.effects).filter((t) => t === 'runOn')).toEqual(['runOn']);
  });

});

// ── 7 ──────────────────────────────────────────────────────────────────────
describe('7. ClosePaw pre-approval OFF -> no dispatch, one notify; ON -> fixed goal, valid closepaw: line', () => {
  it('OFF: never asks ClosePaw, one assist notification', () => {
    const d = makeDevice({ preapproved: false });
    expect(runOnSequence(d.ports, 'on-1')).toBe('assist');
    expect(d.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual([]);
    expect(d.notes).toEqual(['tailscale_preapproval_off']);
    expect(d.audits.find((a) => a.step === 'tailscale')).toMatchObject({ action: 'connect', outcome: 'preapproval_off' });
  });

  it('pre-approval OFF has no bearing on the OFF sequence (it never touches Tailscale)', () => {
    const d = makeDevice({ preapproved: false, adb: 1, vpn: true });
    expect(runOffSequence(d.ports, 'off-1')).toBe('done');
    expect(d.calls).toEqual(['writeAdbWifi:0']);
    expect(d.notes).toEqual([]);
  });

  it('ON: asks ClosePaw exactly once', () => {
    const d = makeDevice({ adb: 1 });
    runOnSequence(d.ports, 'on-1');
    expect(d.calls).toEqual(['requestTailscale:connect']);
  });

  it('the line is exactly what `shelly closepaw` would queue and what the parser accepts', () => {
    const now = 1_763_000_000_000;
    for (const goal of [GOAL_TAILSCALE_CONNECT, goalFor()]) {
      const line = closePawLine(`${now}-0123abcd`, now, goal)!;
      expect(line).toBe(encodeClosePawQueueLine(`${now}-0123abcd`, now, goal));
      const parsed = parseClosePawQueueLine(line, now);
      expect(parsed).toEqual({ ok: true, reqId: `${now}-0123abcd`, goal });
    }
    expect(closePawLine('bad', now, GOAL_TAILSCALE_CONNECT)).toBeNull();
  });

  it('encodeUriComponent matches JS for ASCII, reserved and non-ASCII text', () => {
    for (const s of [GOAL_TAILSCALE_CONNECT, "a:b/c?d=e&f g'(x)*~!", 'ワイヤレスデバッグ 🛰', '%41+']) {
      expect(encodeUriComponent(s)).toBe(encodeURIComponent(s));
    }
  });

  it('goals are fixed, single-line, under the 2000-code-point wire cap with the hand-off prefix', () => {
    const prefix = 'Use the open_app tool to open apps (do not tap launcher icons). Task: ';
    expect(goalFor()).toBe(GOAL_TAILSCALE_CONNECT); // connect-only (2026-11-17)
    for (const goal of [GOAL_TAILSCALE_CONNECT]) {
      expect(goal).not.toMatch(/[\r\n\u0000-\u001f]/);
      expect([...(prefix + goal)].length).toBeLessThan(GOAL_MAX_CODE_POINTS);
      expect(goal).toContain('com.tailscale.ipn');
      expect(goal).toMatch(/If the screen already shows that Tailscale is connected, change nothing/);
      expect(goal).toContain('exactly once');
      expect(goal).toMatch(/Never accept, allow or confirm any VPN-permission, connection-request, login/);
      expect(goal).toContain('stop at once and report it');
      expect(goal).not.toMatch(/^\//); // no on-device skill
    }
  });
});

// ── 8 ──────────────────────────────────────────────────────────────────────
describe('8. toggle OFF / mirror unreadable -> nothing runs; STOP-ALL -> nothing dispatched', () => {
  it('an unreadable mirror restores as DISABLED and ignores every event', () => {
    const s = restoreState(false, 'idle_online', 7);
    expect(s.mode).toBe('DISABLED');
    const out = drive(s, [
      { type: 'wifiAvailable' },
      { type: 'wifiLost', now: clk(T0) },
      { type: 'debounceExpired', token: 7, wifiUp: false },
      { type: 'boot', enabled: false, wifiUp: true, now: clk(T0) },
    ]);
    expect(out.effects).toEqual([]);
  });

  it('toggle off cancels the debounce and unregisters, from any state', () => {
    for (const mode of ['IDLE_ONLINE', 'LOSS_PENDING', 'ON_RUNNING', 'OFF_RUNNING'] as const) {
      const t = reduce({ mode, lossToken: 3, pending: 'LOSS' }, { type: 'disable' });
      expect(t.state).toEqual({ mode: 'DISABLED', lossToken: 3, pending: 'NONE' });
      expect(effectTypes(t.effects)).toEqual(['cancelDebounce', 'unregisterCallbacks']);
    }
  });

  it('the runner does nothing when the toggle is off at start', () => {
    const d = makeDevice({ enabled: false, vpn: true, adb: 1 });
    expect(runOnSequence(d.ports, 'on-1')).toBe('disabled');
    expect(runOffSequence(d.ports, 'off-1')).toBe('disabled');
    expect(d.calls).toEqual([]);
    expect(d.notes).toEqual([]);
  });

  it('toggle off mid-sequence: the step in flight finishes, no new step starts', () => {
    const d = makeDevice();
    afterAdbReadback(d.ports, () => { d.w.enabled = false; });
    expect(runOnSequence(d.ports, 'on-1')).toBe('disabled');
    expect(d.calls).toEqual(['writeAdbWifi:1']);
    expect(d.audits.at(-2)).toMatchObject({ step: 'tailscale', outcome: 'disabled' });
  });

  it('STOP-ALL: nothing is written or dispatched', () => {
    const d = makeDevice({ stopAll: true });
    expect(runOnSequence(d.ports, 'on-1')).toBe('stopped');
    const e = makeDevice({ stopAll: true, adb: 1, vpn: true });
    expect(runOffSequence(e.ports, 'off-1')).toBe('stopped');
    expect(d.calls).toEqual([]);
    expect(e.calls).toEqual([]);
  });

  it('STOP-ALL raised before the Tailscale step: no dispatch', () => {
    const d = makeDevice();
    afterAdbReadback(d.ports, () => { d.w.stopAll = true; });
    expect(runOnSequence(d.ports, 'on-1')).toBe('stopped');
    expect(d.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual([]);
  });
});

// ── 9 ──────────────────────────────────────────────────────────────────────
describe("9. verify failure is recorded as failed; ClosePaw's 'success' alone never passes", () => {
  it('ClosePaw says handed off, VPN never comes up -> verify_failed after the bounded wait', () => {
    const d = makeDevice({ adb: 1, closePawEffect: 'nothing', dispatchOk: true });
    const start = d.now();
    expect(runOnSequence(d.ports, 'on-1')).toBe('failed');
    expect(d.now() - start).toBeGreaterThanOrEqual(VPN_VERIFY_MS);
    expect(d.audits.find((a) => a.step === 'tailscale')).toMatchObject({ before: 'off', after: 'off', outcome: 'verify_failed' });
    expect(d.notes).toEqual(['tailscale_failed']);
  });

  it('a refused hand-off is dispatch_failed, not ok', () => {
    const d = makeDevice({ adb: 1, dispatchOk: false, closePawEffect: 'nothing' });
    expect(runOnSequence(d.ports, 'on-1')).toBe('assist');
    expect(d.audits.find((a) => a.step === 'tailscale')!.outcome).toBe('dispatch_failed');
  });

  it('an unknown VPN probe never counts as connected (and never dispatches)', () => {
    const d = makeDevice({ adb: 1, vpn: null });
    expect(runOnSequence(d.ports, 'on-1')).toBe('failed');
    expect(d.calls).toEqual([]);
    expect(d.audits.find((a) => a.step === 'tailscale')!.outcome).toBe('probe_unknown');
  });

  it('wireless debugging that will not turn off is verify_failed, and the owner is told', () => {
    const d = makeDevice({ adb: 1, vpn: false });
    d.ports.writeAdbWifi = () => true; // claims success, value stays 1
    expect(runOffSequence(d.ports, 'off-1')).toBe('failed');
    expect(d.audits.at(-2)).toMatchObject({ step: 'wifi_debug', outcome: 'verify_failed' });
    expect(d.notes).toEqual(['wifi_debug_off_failed']);
  });

  it('a refused OFF write notifies', () => {
    const d = makeDevice({ adb: 1, vpn: false });
    d.ports.writeAdbWifi = () => false;
    expect(runOffSequence(d.ports, 'off-1')).toBe('failed');
    expect(d.notes).toEqual(['wifi_debug_off_failed']);
  });

  it('an OFF that cannot be read back is not reported done: assist + notify', () => {
    const d = makeDevice({ adb: 1, vpn: false, adbWrite: 'unreadable' });
    expect(runOffSequence(d.ports, 'off-1')).toBe('assist');
    expect(d.audits.at(-2)).toMatchObject({ step: 'wifi_debug', after: 'unknown', outcome: 'unverified' });
    expect(d.notes).toEqual(['wifi_debug_off_failed']);
  });
});

// ── 10 ─────────────────────────────────────────────────────────────────────
describe('10. audit line shape: fixed keys only, no SSID, filename accepted', () => {
  const FILE_NAME_RE = /^[a-z0-9-]{1,64}\.jsonl$/; // IngressAuditWriter (checked against the source in the native test)

  it('fixed keys and closed values', () => {
    const line = buildAuditLine('2026-11-17T08:00:00.000Z', 'on-12', 'tailscale', 'connect', 'off', 'on', 'ok')!;
    const obj = JSON.parse(line);
    expect(Object.keys(obj)).toEqual([...AUDIT_KEYS]);
    expect(obj).toEqual({
      ts: '2026-11-17T08:00:00.000Z',
      kind: 'wifi_guardian',
      seq: 'on-12',
      step: 'tailscale',
      action: 'connect',
      before: 'off',
      after: 'on',
      outcome: 'ok',
    });
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('rejects anything outside the closed sets (no free text, no SSID can get in)', () => {
    const ok = ['2026-11-17T08:00:00.000Z', 'on-1', 'wifi_debug', 'enable', 'off', 'on', 'ok'] as const;
    const bad: Array<[number, string]> = [
      [0, 'yesterday'],
      [1, '"HomeWiFi"'],
      [1, 'on-1","ssid":"HomeWiFi'],
      [2, 'ssid'],
      [3, 'tap'],
      [4, 'HomeWiFi'],
      [5, 'connected to HomeWiFi'],
      [6, 'BSSID 00:11:22:33:44:55'],
    ];
    for (const [i, v] of bad) {
      const args = [...ok] as string[];
      args[i] = v;
      expect(buildAuditLine(...(args as Parameters<typeof buildAuditLine>))).toBeNull();
    }
  });

  it('every runner audit is a valid line', () => {
    const d = makeDevice();
    runOnSequence(d.ports, 'on-1');
    const e = makeDevice({ adb: 1, vpn: true });
    runOffSequence(e.ports, 'off-1');
    for (const a of [...d.audits, ...e.audits]) {
      const line = buildAuditLine('2026-11-17T08:00:00.000Z', a.seq, a.step as any, a.action as any, a.before as any, a.after as any, a.outcome as any);
      expect(line).not.toBeNull();
      expect(line!.toLowerCase()).not.toMatch(/ssid/);
    }
  });

  it('file name passes FILE_NAME_RE', () => {
    expect(AUDIT_FILE).toBe('connectivity-guardian.jsonl');
    expect(FILE_NAME_RE.test(AUDIT_FILE)).toBe(true);
  });

  it('every sequence writes exactly one end line', () => {
    for (const over of [{}, { stopAll: true }, { enabled: false }, { grant: false }, { preapproved: false }]) {
      const d = makeDevice(over);
      runSequence('on', d.ports, 'on-1');
      expect(d.audits.filter((a) => a.step === 'sequence')).toHaveLength(1);
      const e = makeDevice({ adb: 1, vpn: true, ...over });
      runSequence('off', e.ports, 'off-1');
      expect(e.audits.filter((a) => a.step === 'sequence')).toHaveLength(1);
    }
  });
});

// ── 12 ─────────────────────────────────────────────────────────────────────
describe('12. boot with Wi-Fi up -> callbacks re-registered + ON enqueued; toggle OFF -> no-op', () => {
  it('boot + Wi-Fi up from a restored idle state registers and runs ON', () => {
    const t = reduce(restoreState(true, 'idle_online', 2), { type: 'boot', enabled: true, wifiUp: true, now: clk(T0) });
    expect(t.state.mode).toBe('ON_RUNNING');
    expect(effectTypes(t.effects)).toEqual(['registerCallbacks', 'cancelDebounce', 'runOn']);
  });

  it('boot without Wi-Fi only registers (ON comes with the callback)', () => {
    const t = reduce(restoreState(true, 'idle_offline', 0), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0) });
    expect(t.state.mode).toBe('IDLE_OFFLINE');
    expect(effectTypes(t.effects)).toEqual(['registerCallbacks']);
  });

  it('boot away from Wi-Fi after an ON is treated as a loss (debounced OFF)', () => {
    const t = reduce(restoreState(true, 'idle_online', 2), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0) });
    expect(t.state.mode).toBe('LOSS_PENDING');
    expect(t.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'armDebounce', token: 3, delayMs: LOSS_DEBOUNCE_MS }]);
    // Coming back to Wi-Fi after reboot runs ON.
    expect(effectTypes(reduce(t.state, { type: 'wifiAvailable' }).effects)).toEqual(['cancelDebounce', 'runOn']);
  });

  it('reboot / app update during the debounce (alarm lost) re-arms the SAME loss for its remaining budget', () => {
    const t = reduce(restoreState(true, 'loss_pending', 4, T0), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0 + 20_000) });
    expect(t.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 4, pending: 'ON', ...anchorAt(T0), lossArmed: true });
    expect(t.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'armDebounce', token: 4, delayMs: 25_000 }]);
    expect(effectTypes(reduce(t.state, { type: 'debounceExpired', token: 4, wifiUp: false }).effects)).toEqual(['runOff']);
    // A reboot that outlasted the deadline cleans up at once (no arm).
    const late = reduce(restoreState(true, 'loss_pending', 4, T0), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0 + 10 * 60_000) });
    expect(late.state.mode).toBe('OFF_RUNNING');
    expect(late.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'runOff' }]);
    // No anchor (state from an older build): anchored now, same token, one full debounce.
    const old = reduce(restoreState(true, 'loss_pending', 4), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0) });
    expect(old.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'armDebounce', token: 4, delayMs: LOSS_DEBOUNCE_MS }]);
    expect(old.state).toMatchObject({ lossToken: 4, lossAtMs: T0 });
  });

  it('boot with the toggle OFF is a no-op', () => {
    const t = reduce(restoreState(false, 'idle_online', 2), { type: 'boot', enabled: false, wifiUp: true, now: clk(T0) });
    expect(t.state.mode).toBe('DISABLED');
    expect(t.effects).toEqual([]);
  });

  it('toggle on registers and runs ON only when Wi-Fi is up', () => {
    expect(effectTypes(reduce(initialState(false), { type: 'enable', wifiUp: true }).effects)).toEqual(['registerCallbacks', 'runOn']);
    expect(effectTypes(reduce(initialState(false), { type: 'enable', wifiUp: false }).effects)).toEqual(['registerCallbacks']);
  });

  it('process death mid-sequence persists unfinished work explicitly (in_flight); a loss already seen as the loss', () => {
    const st = (mode: GuardianState['mode'], pending: GuardianState['pending'] = 'NONE'): GuardianState => ({ mode, lossToken: 9, pending });
    expect(persistableMode(st('ON_RUNNING'))).toBe('in_flight');
    expect(persistableMode(st('ON_RUNNING', 'ON'))).toBe('in_flight');
    expect(persistableMode(st('ON_RUNNING', 'LOSS'))).toBe('loss_pending_on');
    expect(persistableMode(st('ON_RUNNING', 'OFF'))).toBe('loss_pending_on');
    expect(persistableMode(st('LOSS_PENDING', 'ON'))).toBe('loss_pending_on');
    expect(persistableMode(st('OFF_RUNNING'))).toBe('in_flight');
    expect(persistableMode(st('OFF_RUNNING', 'ON'))).toBe('in_flight');
    expect(persistableMode(st('IDLE_ONLINE', 'ON'))).toBe('in_flight');
    expect(persistableMode(st('IDLE_ONLINE'))).toBe('idle_online');
    expect(persistableMode(st('IDLE_OFFLINE'))).toBe('idle_offline');
    expect(persistableMode(st('LOSS_PENDING'))).toBe('loss_pending');
    expect(restoreState(true, 'in_flight', 9)).toEqual({ mode: 'IDLE_ONLINE', lossToken: 9, pending: 'ON' });
    expect(restoreState(false, 'in_flight', 9).mode).toBe('DISABLED');
    const s = restoreState(true, persistableMode(st('LOSS_PENDING')), 9);
    const t = reduce(s, { type: 'debounceExpired', token: 9, wifiUp: false });
    expect(effectTypes(t.effects)).toEqual(['runOff']);
  });
});

// ── Coordinator gate round 1 ───────────────────────────────────────────────
/**
 * The reducer and the runner together, as ConnectivityGuardian wires them:
 * one worker runs queued sequences; events (Wi-Fi changes, the debounce
 * alarm) land while a sequence sleeps; superseded() reads the core's pending
 * flag for the running kind; the debounce alarm fires LOSS_DEBOUNCE_MS after
 * it was armed (a stale token is ignored by the core).
 */
function guardianHarness(start: GuardianState, over: Partial<World> = {}, wifiUp0 = true) {
  const d = makeDevice(over);
  let s = start;
  let wifiUp = wifiUp0;
  let running: SeqKind | null = null;
  const queue: SeqKind[] = [];
  const timers: Array<{ at: number; fire: () => void }> = [];
  const order: string[] = [];
  const apply = (e: GuardianEvent) => {
    const t = reduce(s, e);
    s = t.state;
    for (const eff of t.effects) {
      if (eff.type === 'runOn') queue.push('on');
      else if (eff.type === 'runOff') queue.push('off');
      else if (eff.type === 'armDebounce') {
        const token = eff.token;
        timers.push({ at: d.now() + eff.delayMs, fire: () => apply({ type: 'debounceExpired', token, wifiUp }) });
      }
    }
  };
  const script: Array<{ at: number; fire: () => void }> = [];
  const tick = () => {
    for (const list of [script, timers]) {
      for (const t of [...list]) {
        if (d.now() >= t.at) {
          list.splice(list.indexOf(t), 1);
          t.fire();
        }
      }
    }
  };
  d.hooks.onSleep = tick;
  d.ports.superseded = () =>
    running === 'on' ? s.pending === 'LOSS' || s.pending === 'OFF' : running === 'off' ? s.pending === 'ON' : false;
  let n = 0;
  const drain = () => {
    while (queue.length > 0) {
      const kind = queue.shift()!;
      running = kind;
      const seq = `${kind}-${++n}`;
      order.push(`start:${seq}`);
      const res = runSequence(kind, d.ports, seq);
      order.push(`end:${seq}:${res}`);
      running = null;
      apply({ type: 'sequenceDone', kind, interrupted: res === 'superseded' });
    }
  };
  /** Advance idle time (no sequence running), firing due events, draining runs. */
  const idle = (ms: number) => {
    const until = d.now() + ms;
    while (d.now() < until) {
      d.ports.sleep(1_000);
      drain();
    }
  };
  return {
    d,
    state: () => s,
    apply: (e: GuardianEvent) => {
      apply(e);
      drain();
    },
    /** Schedule a Wi-Fi change [inMs] from now (lands mid-sequence if one runs). */
    at: (inMs: number, up: boolean) =>
      script.push({
        at: d.now() + inMs,
        fire: () => {
          wifiUp = up;
          apply(up ? { type: 'wifiAvailable' } : { type: 'wifiLost', now: clk(d.now()) });
        },
      }),
    setWifi: (up: boolean) => {
      wifiUp = up;
    },
    idle,
    order,
  };
}

describe('13. coordinator gate round 1: a dispatched ClosePaw request settles before its sequence ends', () => {
  it('Wi-Fi lost and back (since 2026-11-17): OFF never dispatches, and the next ON finds Tailscale already up', () => {
    const h = guardianHarness({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' }, { adb: 1, vpn: true });
    h.apply({ type: 'wifiLost', now: clk(T0) });
    h.setWifi(false);
    h.idle(LOSS_DEBOUNCE_MS + 5_000);
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    expect(h.d.w).toMatchObject({ adb: 0, vpn: true });
    h.at(1_000, true);
    h.idle(5 * 60_000);
    expect(h.state().mode).toBe('IDLE_ONLINE');
    expect(h.order).toEqual(['start:off-1', 'end:off-1:done', 'start:on-2', 'end:on-2:done']);
    expect(h.d.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual([]);
    expect(h.d.audits.find((a) => a.seq === 'on-2' && a.step === 'tailscale')).toMatchObject({ action: 'check', outcome: 'already' });
  });

  it('connect in flight when Wi-Fi is lost -> ON waits for it to settle, then OFF turns only wireless debugging off', () => {
    // ClosePaw takes 60 s to act on the connect; the debounce (45 s from the loss) expires meanwhile.
    const h = guardianHarness(initialState(true), { adb: 1, vpn: false, closePawDelayMs: 60_000 });
    h.at(5_000, false); // Wi-Fi lost 5 s after the dispatch
    h.apply({ type: 'wifiAvailable' });
    h.idle(10 * 60_000);
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    expect(h.d.w.vpn).toBe(true); // Tailscale stays up off Wi-Fi (mobile data)
    expect(h.d.w.adb).toBe(0);
    const onSeq = h.d.audits.filter((a) => a.seq === 'on-1').map((a) => `${a.step}:${a.action}:${a.outcome}`);
    expect(onSeq).toEqual(['wifi_debug:check:already', 'tailscale:connect:superseded', 'tailscale:wait:settled', 'sequence:end:superseded']);
    expect(h.order).toEqual(['start:on-1', 'end:on-1:superseded', 'start:off-2', 'end:off-2:done']);
    expect(h.d.audits.filter((a) => a.seq === 'off-2' && a.step === 'tailscale')).toEqual([]);
    expect(h.d.calls.filter((c) => c.startsWith('requestTailscale'))).toEqual(['requestTailscale:connect']);
  });

  it.each([
    ['toggle off', { enabled: false } as Partial<World>, 'disabled'],
    ['STOP-ALL', { stopAll: true } as Partial<World>, 'stopped'],
  ])('%s after the dispatch still waits for the run to settle', (_n, flip, result) => {
    const d = makeDevice({ adb: 1, vpn: false, closePawDelayMs: 40_000 });
    const real = d.ports.requestTailscale;
    d.ports.requestTailscale = () => {
      const id = real();
      Object.assign(d.w, flip);
      return id;
    };
    const t0 = d.now();
    expect(runOnSequence(d.ports, 'on-1')).toBe(result);
    expect(d.now() - t0).toBeGreaterThanOrEqual(40_000);
    expect(d.w.vpn).toBe(true);
    expect(d.audits.map((a) => `${a.step}:${a.action}:${a.outcome}`)).toEqual([
      'wifi_debug:check:already',
      `tailscale:connect:${result}`,
      'tailscale:wait:settled',
      `sequence:end:${result}`,
    ]);
    expect(d.calls).toEqual(['requestTailscale:connect']);
  });

  it('a run that never settles is bounded by CLOSEPAW_SETTLE_MS (counted from the dispatch) and audited', () => {
    const d = makeDevice({ adb: 1, vpn: false, settleAfterActMs: null });
    const t0 = d.now();
    expect(runOnSequence(d.ports, 'on-1')).toBe('done');
    expect(d.now() - t0).toBeGreaterThanOrEqual(CLOSEPAW_SETTLE_MS);
    expect(d.now() - t0).toBeLessThan(CLOSEPAW_SETTLE_MS + 5_000);
    expect(d.audits.at(-2)).toMatchObject({ step: 'tailscale', action: 'wait', outcome: 'settle_timeout' });
    expect(CLOSEPAW_SETTLE_MS).toBeGreaterThan(VPN_VERIFY_MS);
  });

  it("settling is sequencing only: a settled run with the VPN unchanged is still verify_failed", () => {
    const d = makeDevice({ adb: 1, closePawEffect: 'nothing' });
    expect(runOnSequence(d.ports, 'on-1')).toBe('failed');
    expect(d.audits.map((a) => a.outcome)).toEqual(['already', 'verify_failed', 'settled', 'failed']);
  });

  it('no dispatch, no settle wait (already / preapproval off / refused hand-off)', () => {
    for (const over of [{ vpn: true }, { preapproved: false }, { dispatchOk: false }] as Array<Partial<World>>) {
      const d = makeDevice({ adb: 1, ...over });
      runOnSequence(d.ports, 'on-1');
      expect(d.audits.some((a) => a.action === 'wait' && a.step === 'tailscale')).toBe(false);
    }
  });

  it('an exception after the dispatch still waits for the run to settle (try / finally)', () => {
    const d = makeDevice({ adb: 1, vpn: false, closePawDelayMs: 20_000 });
    const realVpn = d.ports.vpnUp;
    let dispatched = false;
    const realReq = d.ports.requestTailscale;
    d.ports.requestTailscale = () => {
      dispatched = true;
      return realReq();
    };
    let thrown = false;
    d.ports.vpnUp = () => {
      if (dispatched && !thrown) {
        thrown = true;
        throw new Error('probe crashed');
      }
      return realVpn();
    };
    const t0 = d.now();
    expect(() => runOnSequence(d.ports, 'on-1')).toThrow('probe crashed');
    expect(d.now() - t0).toBeGreaterThanOrEqual(20_000);
    expect(d.audits.at(-1)).toMatchObject({ step: 'tailscale', action: 'wait', outcome: 'settled' });
  });

  it('isClosePawSettled accepts only terminal statuses', () => {
    for (const st of ['completed', 'failed', 'cancelled', 'timeout', 'uncertain', 'lost', 'rejected', 'expired']) expect(isClosePawSettled(st)).toBe(true);
    for (const st of ['running', 'approved', 'pending-approval', 'untracked', 'queued', '', null, undefined]) expect(isClosePawSettled(st)).toBe(false);
  });
});

describe('14. coordinator gate round 1: process death during ON never loses the cleanup', () => {
  const diedDuringOn = () => restoreState(true, persistableMode({ mode: 'ON_RUNNING', lossToken: 3, pending: 'NONE' }), 3);

  it('reproduced: adb_wifi on, process dies mid-ON, Wi-Fi then disappears -> the loss is armed and OFF runs', () => {
    const s = diedDuringOn();
    expect(s).toEqual({ mode: 'IDLE_ONLINE', lossToken: 3, pending: 'ON' });
    // In-process loss callback, or a recovery entry point's reconcile, both arm the loss.
    for (const e of [{ type: 'wifiLost', now: clk(T0) }, { type: 'reconcile', wifiUp: false, now: clk(T0) }] as GuardianEvent[]) {
      const lost = reduce(s, e);
      expect(lost.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 4, pending: 'ON', ...anchorAt(T0), lossArmed: true });
      expect(lost.effects).toEqual([{ type: 'armDebounce', token: 4, delayMs: LOSS_DEBOUNCE_MS }]);
      const fired = reduce(lost.state, { type: 'debounceExpired', token: 4, wifiUp: false });
      expect(effectTypes(fired.effects)).toEqual(['runOff']);
    }
    // End to end: the OFF cleanup actually turns wireless debugging off.
    const h = guardianHarness(s, { adb: 1, vpn: false }, false);
    h.apply({ type: 'reconcile', wifiUp: false, now: clk(T0) });
    h.idle(5 * 60_000);
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    expect(h.d.w.adb).toBe(0);
  });

  it('reproduced: boot without Wi-Fi after dying mid-ON schedules the cleanup', () => {
    const t = reduce(diedDuringOn(), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0) });
    expect(t.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 4, pending: 'ON', ...anchorAt(T0), lossArmed: true });
    expect(t.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'armDebounce', token: 4, delayMs: LOSS_DEBOUNCE_MS }]);
  });

  it('Wi-Fi present at recovery (reconcile / callback / boot) reruns ON (idempotent)', () => {
    expect(effectTypes(reduce(diedDuringOn(), { type: 'reconcile', wifiUp: true, now: clk(T0) }).effects)).toEqual(['runOn']);
    expect(effectTypes(reduce(diedDuringOn(), { type: 'wifiAvailable' }).effects)).toEqual(['runOn']);
    expect(effectTypes(reduce(diedDuringOn(), { type: 'boot', enabled: true, wifiUp: true, now: clk(T0) }).effects)).toEqual(['registerCallbacks', 'cancelDebounce', 'runOn']);
  });

  it('process death during OFF: Wi-Fi gone -> OFF finishes; Wi-Fi back -> ON restores', () => {
    const s = restoreState(true, persistableMode({ mode: 'OFF_RUNNING', lossToken: 5, pending: 'NONE' }), 5);
    const lost = reduce(s, { type: 'reconcile', wifiUp: false, now: clk(T0) });
    expect(lost.state.mode).toBe('LOSS_PENDING');
    expect(effectTypes(reduce(lost.state, { type: 'debounceExpired', token: 6, wifiUp: false }).effects)).toEqual(['runOff']);
    expect(effectTypes(reduce(s, { type: 'reconcile', wifiUp: true, now: clk(T0) }).effects)).toEqual(['runOn']);
  });

  it('Codex gate round 2 (remaining-budget semantics since coordinator round 2): the debounce fired during ON (pending OFF), then the process died -> recovery runs OFF', () => {
    // ON in flight, Wi-Fi lost at T0, the 45 s alarm fired (consumed) -> pending OFF; process dies.
    const dying: GuardianState = { mode: 'ON_RUNNING', lossToken: 7, pending: 'OFF', lossAtMs: T0 };
    const s = restoreState(true, persistableMode(dying), 7, T0);
    expect(s).toEqual({ mode: 'LOSS_PENDING', lossToken: 7, pending: 'ON', lossAtMs: T0 });
    // No alarm is left and its deadline has passed: every recovery entry point
    // (app start, service start, watchdog) runs the OFF cleanup at once.
    const rec = reduce(s, { type: 'reconcile', wifiUp: false, now: clk(T0 + 60_000) });
    expect(rec.state.mode).toBe('OFF_RUNNING');
    expect(rec.effects).toEqual([{ type: 'runOff' }]);
    // End to end with the harness: wireless debugging ends up off.
    const h = guardianHarness(s, { adb: 1, vpn: true }, false);
    h.apply({ type: 'reconcile', wifiUp: false, now: clk(T0 + 60_000) });
    h.idle(10 * 60_000);
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    expect(h.d.w).toMatchObject({ adb: 0, vpn: true }); // OFF leaves Tailscale up
    // Death between checkpointing a plain loss and arming its alarm: the SAME
    // token is armed for what is left of the budget (cleanup still scheduled).
    const plain = reduce(restoreState(true, 'loss_pending', 2, T0), { type: 'reconcile', wifiUp: false, now: clk(T0 + 1_000) });
    expect(plain.effects).toEqual([{ type: 'armDebounce', token: 2, delayMs: LOSS_DEBOUNCE_MS - 1_000 }]);
    expect(plain.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 2, pending: 'NONE', ...anchorAt(T0), lossArmed: true });
    // Wi-Fi back at recovery: no OFF (an interrupted ON reruns).
    expect(effectTypes(reduce(s, { type: 'reconcile', wifiUp: true, now: clk(T0) }).effects)).toEqual(['cancelDebounce', 'runOn']);
    // A live loss callback during the debounce does not re-arm (no extension).
    expect(reduce(plain.state, { type: 'wifiLost', now: clk(T0 + 2_000) }).effects).toEqual([]);
  });

  it('a checkpoint that did not reach disk holds ON back (no mutation without a durable in_flight) and keeps it owed', () => {
    const t = reduce(initialState(true), { type: 'wifiAvailable' });
    expect(effectTypes(t.effects)).toEqual(['runOn']);
    const held = withoutUndurableOn(t);
    expect(held.effects).toEqual([]);
    expect(held.state).toEqual({ mode: 'IDLE_ONLINE', lossToken: 0, pending: 'ON' });
    // The next Wi-Fi callback / reconcile retries ON; a loss arms the cleanup.
    expect(effectTypes(reduce(held.state, { type: 'reconcile', wifiUp: true, now: clk(T0) }).effects)).toEqual(['runOn']);
    expect(effectTypes(reduce(held.state, { type: 'wifiLost', now: clk(T0) }).effects)).toEqual(['armDebounce']);
    // Boot's other effects survive; OFF is never held back.
    const boot = withoutUndurableOn(reduce(restoreState(true, 'idle_online', 2), { type: 'boot', enabled: true, wifiUp: true, now: clk(T0) }));
    expect(effectTypes(boot.effects)).toEqual(['registerCallbacks', 'cancelDebounce']);
    const off = reduce({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE' }, { type: 'debounceExpired', token: 1, wifiUp: false });
    expect(withoutUndurableOn(off)).toBe(off);
  });

  it('reconcile is harmless when nothing is owed and ignored while disabled', () => {
    const online: GuardianState = { mode: 'IDLE_ONLINE', lossToken: 1, pending: 'NONE' };
    expect(reduce(online, { type: 'reconcile', wifiUp: true, now: clk(T0) })).toEqual({ state: online, effects: [] });
    const off = initialState(false);
    expect(reduce(off, { type: 'reconcile', wifiUp: true, now: clk(T0) })).toEqual({ state: off, effects: [] });
    // A missed available while idle offline runs ON; a missed loss after ON arms the debounce.
    expect(effectTypes(reduce(initialState(true), { type: 'reconcile', wifiUp: true, now: clk(T0) }).effects)).toEqual(['runOn']);
    expect(effectTypes(reduce(online, { type: 'reconcile', wifiUp: false, now: clk(T0) }).effects)).toEqual(['armDebounce']);
    // The plain online state still arms without a rerun.
    expect(reduce(online, { type: 'wifiLost', now: clk(T0) }).state.pending).toBe('NONE');
  });
});

describe('15. coordinator gate round 1: the service is resident exactly while an OFF obligation may exist', () => {
  const st = (mode: GuardianState['mode'], pending: GuardianState['pending'] = 'NONE'): GuardianState => ({ mode, lossToken: 0, pending });

  it('resident: online after ON, the loss debounce, running sequences; not idle offline / disabled', () => {
    expect(wantsResident(st('IDLE_ONLINE'))).toBe(true);
    expect(wantsResident(st('IDLE_ONLINE', 'ON'))).toBe(true);
    expect(wantsResident(st('LOSS_PENDING'))).toBe(true);
    expect(wantsResident(st('ON_RUNNING'))).toBe(true);
    expect(wantsResident(st('OFF_RUNNING'))).toBe(true);
    expect(wantsResident(st('IDLE_OFFLINE'))).toBe(false);
    expect(wantsResident(st('DISABLED'))).toBe(false);
  });

  it('a full cycle: resident from ON until OFF completes, then not; toggle off ends it', () => {
    const h = guardianHarness(initialState(true), { adb: 1, vpn: false });
    expect(wantsResident(h.state())).toBe(false);
    h.apply({ type: 'wifiAvailable' });
    expect(h.state().mode).toBe('IDLE_ONLINE');
    expect(wantsResident(h.state())).toBe(true);
    // Loss while resident: the in-process callback arms the debounce AT the loss.
    const lossAt = h.d.now();
    h.setWifi(false);
    h.apply({ type: 'wifiLost', now: clk(T0) });
    expect(h.state().mode).toBe('LOSS_PENDING');
    expect(wantsResident(h.state())).toBe(true);
    h.idle(LOSS_DEBOUNCE_MS - 2_000);
    expect(h.order.filter((o) => o.startsWith('start:off'))).toEqual([]);
    h.idle(4_000);
    const offStart = h.d.audits.find((a) => a.seq.startsWith('off-'));
    expect(offStart).toBeDefined();
    expect(h.d.now() - lossAt).toBeLessThan(LOSS_DEBOUNCE_MS + 5 * 60_000);
    h.idle(5 * 60_000);
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    expect(wantsResident(h.state())).toBe(false);
    expect(wantsResident(reduce(st('IDLE_ONLINE'), { type: 'disable' }).state)).toBe(false);
  });
});

describe('15. coordinator gate round 2: recovery never resets a live loss debounce', () => {
  const online: GuardianState = { mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' };

  it("reviewer's reproduction: loss arms token 1; reconcile keeps token 1 and its deadline; token-1 expiry runs OFF", () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    expect(lost.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: LOSS_DEBOUNCE_MS }]);
    // App start 40 s after the loss reconciles.
    const rec = reduce(lost.state, { type: 'reconcile', wifiUp: false, now: clk(T0 + 40_000) });
    expect(rec).toEqual({ state: lost.state, effects: [] });
    expect(rec.state).toMatchObject({ lossToken: 1, lossAtMs: T0 });
    const fired = reduce(rec.state, { type: 'debounceExpired', token: 1, wifiUp: false });
    expect(fired.state.mode).toBe('OFF_RUNNING');
    expect(effectTypes(fired.effects)).toEqual(['runOff']);
  });

  it('end to end: cleanup still lands 45 s after the loss although the app starts 40 s in', () => {
    const h = guardianHarness(online, { adb: 1, vpn: false }, true);
    const lossAt = h.d.now();
    h.setWifi(false);
    h.apply({ type: 'wifiLost', now: clk(lossAt) });
    h.idle(40_000);
    h.apply({ type: 'reconcile', wifiUp: false, now: clk(h.d.now()) });
    h.idle(4_000);
    expect(h.state().mode).toBe('LOSS_PENDING');
    h.idle(3_000);
    expect(h.d.calls).toContain('writeAdbWifi:0');
    const offStart = h.d.audits.find((a) => a.seq.startsWith('off-'));
    expect(offStart).toBeDefined();
    expect(h.state().mode).toBe('IDLE_OFFLINE');
    // Never 85 s: the OFF ran inside the original budget (+ the harness's 1 s tick).
    expect(h.order[0]).toBe('start:off-1');
  });

  it('after a process death with the alarm consumed, recovery re-arms the SAME token for the remaining budget', () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const restored = restoreState(true, persistableMode(lost.state), lost.state.lossToken, lost.state.lossAtMs ?? null);
    expect(restored).toEqual({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE', lossAtMs: T0 });
    const rec = reduce(restored, { type: 'reconcile', wifiUp: false, now: clk(T0 + 40_000) });
    expect(rec.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 5_000 }]);
    expect(rec.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE', ...anchorAt(T0), lossArmed: true });
    // The re-armed alarm is believed outstanding now: another reconcile does nothing.
    expect(reduce(rec.state, { type: 'reconcile', wifiUp: false, now: clk(T0 + 42_000) }).effects).toEqual([]);
    expect(effectTypes(reduce(rec.state, { type: 'debounceExpired', token: 1, wifiUp: false }).effects)).toEqual(['runOff']);
  });

  it('a reconcile after the deadline has passed takes the OFF path at once (no arm)', () => {
    const restored = restoreState(true, 'loss_pending', 1, T0);
    for (const late of [LOSS_DEBOUNCE_MS, LOSS_DEBOUNCE_MS + 1, 3_600_000]) {
      const rec = reduce(restored, { type: 'reconcile', wifiUp: false, now: clk(T0 + late) });
      expect(rec.state).toMatchObject({ mode: 'OFF_RUNNING', pending: 'NONE', lossToken: 1 });
      expect(rec.effects).toEqual([{ type: 'runOff' }]);
    }
    // With ON owed (loss_pending_on) the cleanup still runs first; ON comes with Wi-Fi.
    const owed = reduce(restoreState(true, 'loss_pending_on', 1, T0), { type: 'reconcile', wifiUp: false, now: clk(T0 + 50_000) });
    expect(owed.effects).toEqual([{ type: 'runOff' }]);
  });

  it('repeated reconciles (x3) never extend the deadline, in-process or across process deaths', () => {
    // In-process: the live alarm is left alone every time.
    let t = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const armed = t.state;
    for (const at of [10_000, 20_000, 30_000]) {
      t = reduce(t.state, { type: 'reconcile', wifiUp: false, now: clk(T0 + at) });
      expect(t).toEqual({ state: armed, effects: [] });
    }
    // Across deaths: each fresh process re-arms only what is left, same token.
    const delays: number[] = [];
    let token = armed.lossToken;
    for (const at of [10_000, 20_000, 30_000]) {
      const fresh = restoreState(true, 'loss_pending', token, T0);
      const r = reduce(fresh, { type: 'reconcile', wifiUp: false, now: clk(T0 + at) });
      const arm = r.effects.find((e) => e.type === 'armDebounce') as Extract<Effect, { type: 'armDebounce' }>;
      expect(arm.token).toBe(token);
      expect(at + arm.delayMs).toBe(LOSS_DEBOUNCE_MS);
      delays.push(arm.delayMs);
      token = r.state.lossToken;
    }
    expect(delays).toEqual([35_000, 25_000, 15_000]);
  });

  it('the token increments only on a new loss event', () => {
    const first = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(first.state, { type: 'wifiAvailable' });
    expect(back.state).toEqual({ mode: 'IDLE_ONLINE', lossToken: 1, pending: 'NONE' });
    const second = reduce(back.state, { type: 'wifiLost', now: clk(T0 + 60_000) });
    expect(second.state).toMatchObject({ lossToken: 2, lossAtMs: T0 + 60_000 });
    // A loss seen during ON is also a new event, anchored at its own instant.
    const during = reduce({ mode: 'ON_RUNNING', lossToken: 5, pending: 'NONE' }, { type: 'wifiLost', now: clk(T0 + 7) });
    expect(during.state).toMatchObject({ lossToken: 6, pending: 'LOSS', lossAtMs: T0 + 7, lossArmed: true });
    // Re-arms and boots of an existing loss never move it.
    const r = reduce(restoreState(true, 'loss_pending', 9, T0), { type: 'reconcile', wifiUp: false, now: clk(T0 + 1) });
    expect(r.state.lossToken).toBe(9);
    const b = reduce(restoreState(true, 'loss_pending', 9, T0), { type: 'boot', enabled: true, wifiUp: false, now: clk(T0 + 1) });
    expect(b.state.lossToken).toBe(9);
  });

  it('unchanged: Wi-Fi back during LOSS_PENDING cancels everything; a stale token is ignored', () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(lost.state, { type: 'wifiAvailable' });
    expect(back).toEqual({ state: { mode: 'IDLE_ONLINE', lossToken: 1, pending: 'NONE' }, effects: [{ type: 'cancelDebounce' }] });
    const restored = restoreState(true, 'loss_pending', 3, T0);
    const rearmed = reduce(restored, { type: 'reconcile', wifiUp: false, now: clk(T0 + 5_000) });
    expect(reduce(rearmed.state, { type: 'debounceExpired', token: 2, wifiUp: false })).toEqual({ state: rearmed.state, effects: [] });
    expect(reduce(rearmed.state, { type: 'wifiAvailable' }).effects).toEqual([{ type: 'cancelDebounce' }]);
  });

  it('a wall clock set backwards never stretches the re-arm past one full debounce', () => {
    const rec = reduce(restoreState(true, 'loss_pending', 1, T0), { type: 'reconcile', wifiUp: false, now: clk(T0 - 3_600_000) });
    expect(rec.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: LOSS_DEBOUNCE_MS }]);
    expect(lossRemainingMs(T0, T0 - 1)).toBe(LOSS_DEBOUNCE_MS);
    expect(lossRemainingMs(T0, T0 + 44_999)).toBe(1);
    expect(lossRemainingMs(T0, T0 + 45_000)).toBe(0);
  });

  it('the anchor is dropped when the loss is cancelled or cleaned up, so it never leaks into a later loss', () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const off = reduce(lost.state, { type: 'debounceExpired', token: 1, wifiUp: false });
    expect(off.state).toEqual({ mode: 'OFF_RUNNING', lossToken: 1, pending: 'NONE' });
    expect(persistableMode(off.state)).toBe('in_flight');
    expect(reduce(lost.state, { type: 'disable' }).state).toEqual({ mode: 'DISABLED', lossToken: 1, pending: 'NONE' });
  });
});

describe('16. coordinator gate round 3: the loss budget is monotonic (wall-clock rollback, reboots)', () => {
  const online: GuardianState = { mode: 'IDLE_ONLINE', lossToken: 0, pending: 'NONE' };
  const HOUR = 3_600_000;
  /** Real time [realMs] after the loss, with the wall clock set back one hour. */
  const rolledBack = (realMs: number): LossClock => ({ wallMs: T0 - HOUR + realMs, elapsedMs: E0 + realMs, bootId: BOOT });
  /** What a fresh process reads back from the checkpoint. */
  const persistAndRestore = (s: GuardianState) =>
    restoreState(true, persistableMode(s), s.lossToken, s.lossAtMs ?? null, s.lossElapsedMs ?? null, s.lossBootId ?? null);
  const armOf = (t: { effects: Effect[] }) =>
    t.effects.find((e) => e.type === 'armDebounce') as Extract<Effect, { type: 'armDebounce' }> | undefined;

  it("reviewer's reproduction: loss at 0, wall clock -1 h, restarts at +40 / +80 / +120 -> cleanup by +45, same token", () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    expect(lost.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE', ...anchorAt(T0), lossArmed: true });
    // +40: the alarm is gone (fresh process); only the 5 s left are armed, not 45.
    const r40 = reduce(persistAndRestore(lost.state), { type: 'reconcile', wifiUp: false, now: rolledBack(40_000) });
    expect(r40.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 5_000 }]);
    expect(40_000 + armOf(r40)!.delayMs).toBe(LOSS_DEBOUNCE_MS);
    // The persisted anchor is unchanged by the recovery (no restart of the budget).
    expect(r40.state).toMatchObject({ lossToken: 1, lossElapsedMs: E0, lossBootId: BOOT, lossAtMs: T0 });
    // +80 and +120 (that alarm was lost too): the deadline has passed -> OFF at once, never another arm.
    for (const real of [80_000, 120_000]) {
      const r = reduce(persistAndRestore(r40.state), { type: 'reconcile', wifiUp: false, now: rolledBack(real) });
      expect(r.effects).toEqual([{ type: 'runOff' }]);
      expect(r.state).toMatchObject({ mode: 'OFF_RUNNING', lossToken: 1 });
    }
  });

  it('repeated restarts under a rolled-back wall clock: each armed delay shrinks, total stays 45 s', () => {
    let s = reduce(online, { type: 'wifiLost', now: clk(T0) }).state;
    const delays: number[] = [];
    for (const real of [10_000, 20_000, 30_000, 40_000, 44_000]) {
      const r = reduce(persistAndRestore(s), { type: 'reconcile', wifiUp: false, now: rolledBack(real) });
      const arm = armOf(r)!;
      expect(arm.token).toBe(1);
      expect(real + arm.delayMs).toBe(LOSS_DEBOUNCE_MS);
      delays.push(arm.delayMs);
      s = r.state;
    }
    expect(delays).toEqual([35_000, 25_000, 15_000, 5_000, 1_000]);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeLessThan(delays[i - 1]);
    // A wall clock set FORWARD does not shorten it either (monotonic only).
    const fwd = reduce(persistAndRestore(s), { type: 'reconcile', wifiUp: false, now: { wallMs: T0 + 10 * HOUR, elapsedMs: E0 + 30_000, bootId: BOOT } });
    expect(fwd.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 15_000 }]);
    // Boot from LOSS_PENDING on the same boot (app update) follows the same rule.
    const upd = reduce(persistAndRestore(s), { type: 'boot', enabled: true, wifiUp: false, now: rolledBack(30_000) });
    expect(upd.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'armDebounce', token: 1, delayMs: 15_000 }]);
  });

  it('same boot, no process death: a wall-clock rollback leaves the armed deadline alone', () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    for (const real of [1_000, 30_000, 44_999]) {
      expect(reduce(lost.state, { type: 'reconcile', wifiUp: false, now: rolledBack(real) })).toEqual({ state: lost.state, effects: [] });
    }
    const fired = reduce(lost.state, { type: 'debounceExpired', token: 1, wifiUp: false });
    expect(effectTypes(fired.effects)).toEqual(['runOff']);
  });

  it('cross-boot recovery (boot id differs): OFF path immediately, no arm', () => {
    const s = persistAndRestore(reduce(online, { type: 'wifiLost', now: clk(T0) }).state);
    const afterReboot: LossClock = { wallMs: T0 + 20_000, elapsedMs: 15_000, bootId: BOOT + 1 };
    const boot = reduce(s, { type: 'boot', enabled: true, wifiUp: false, now: afterReboot });
    expect(boot.effects).toEqual([{ type: 'registerCallbacks' }, { type: 'runOff' }]);
    expect(boot.state).toMatchObject({ mode: 'OFF_RUNNING', lossToken: 1 });
    expect(reduce(s, { type: 'reconcile', wifiUp: false, now: afterReboot }).effects).toEqual([{ type: 'runOff' }]);
    // Even a wall clock that says "only 1 s passed" cannot buy a fresh delay across the boot.
    const early = reduce(s, { type: 'boot', enabled: true, wifiUp: false, now: { wallMs: T0 + 1_000, elapsedMs: 1_000, bootId: BOOT + 1 } });
    expect(armOf(early)).toBeUndefined();
  });

  it('boot identity unknown (now or at the loss) or elapsedRealtime behind the loss: conservative OFF', () => {
    const s = persistAndRestore(reduce(online, { type: 'wifiLost', now: clk(T0) }).state);
    expect(reduce(s, { type: 'reconcile', wifiUp: false, now: clk(T0 + 1_000, null) }).effects).toEqual([{ type: 'runOff' }]);
    const unknownAtLoss = persistAndRestore(reduce(online, { type: 'wifiLost', now: clk(T0, null) }).state);
    expect(unknownAtLoss.lossBootId).toBeUndefined();
    expect(unknownAtLoss.lossElapsedMs).toBe(E0);
    expect(reduce(unknownAtLoss, { type: 'reconcile', wifiUp: false, now: clk(T0 + 1_000) }).effects).toEqual([{ type: 'runOff' }]);
    expect(reduce(s, { type: 'reconcile', wifiUp: false, now: { wallMs: T0, elapsedMs: E0 - 1, bootId: BOOT } }).effects).toEqual([{ type: 'runOff' }]);
    // In-process, an unknown boot changes nothing: the live alarm still decides.
    const live = reduce(online, { type: 'wifiLost', now: clk(T0, null) });
    expect(reduce(live.state, { type: 'reconcile', wifiUp: false, now: clk(T0 + 1_000, null) }).effects).toEqual([]);
  });

  it('legacy state (no monotonic anchor): one wall-clock fallback that stamps the anchor; later recoveries are monotonic', () => {
    const legacy = restoreState(true, 'loss_pending', 1, T0);
    expect(legacy).toEqual({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE', lossAtMs: T0 });
    const first = reduce(legacy, { type: 'reconcile', wifiUp: false, now: clk(T0 + 10_000) });
    expect(first.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 35_000 }]);
    // Stamped: elapsedRealtime of the same deadline, on this boot.
    expect(first.state).toEqual({ mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE', ...anchorAt(T0), lossArmed: true });
    // Second recovery after the wall clock went back an hour: monotonic, not +45 s again.
    const second = reduce(persistAndRestore(first.state), { type: 'reconcile', wifiUp: false, now: rolledBack(20_000) });
    expect(second.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 25_000 }]);
    // Legacy + rollback: the single fallback is clamped to one debounce, then stamped.
    const clamped = reduce(legacy, { type: 'reconcile', wifiUp: false, now: rolledBack(10_000) });
    expect(clamped.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: LOSS_DEBOUNCE_MS }]);
    expect(clamped.state).toMatchObject({ lossElapsedMs: E0 + 10_000, lossBootId: BOOT });
    const next = reduce(persistAndRestore(clamped.state), { type: 'reconcile', wifiUp: false, now: rolledBack(40_000) });
    expect(next.effects).toEqual([{ type: 'armDebounce', token: 1, delayMs: 15_000 }]);
    // Legacy whose wall deadline already passed: OFF, no stamp needed.
    expect(reduce(legacy, { type: 'reconcile', wifiUp: false, now: clk(T0 + 60_000) }).effects).toEqual([{ type: 'runOff' }]);
  });

  it('lossMonotonicRemainingMs: clamped to [0, budget], wall clock not consulted', () => {
    const now = (elapsedMs: number, bootId: number | null = BOOT, wallMs = 0): LossClock => ({ wallMs, elapsedMs, bootId });
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0))).toBe(LOSS_DEBOUNCE_MS);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0 + 44_999))).toBe(1);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0 + 45_000))).toBe(0);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0 + 10_000, BOOT, -HOUR))).toBe(35_000);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0 + 10_000, BOOT, 99 * HOUR))).toBe(35_000);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0 - 1))).toBe(0);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0, BOOT + 1))).toBe(0);
    expect(lossMonotonicRemainingMs(E0, null, now(E0))).toBe(0);
    expect(lossMonotonicRemainingMs(E0, BOOT, now(E0, null))).toBe(0);
  });

  it('the token still increments only on a new loss; cancel drops the whole anchor', () => {
    const lost = reduce(online, { type: 'wifiLost', now: clk(T0) });
    const back = reduce(lost.state, { type: 'wifiAvailable' });
    expect(back.state).toEqual({ mode: 'IDLE_ONLINE', lossToken: 1, pending: 'NONE' });
    const again = reduce(back.state, { type: 'wifiLost', now: rolledBack(60_000) });
    expect(again.state).toMatchObject({ lossToken: 2, lossElapsedMs: E0 + 60_000, lossBootId: BOOT });
    const during = reduce({ mode: 'ON_RUNNING', lossToken: 5, pending: 'NONE', lossBootId: 99 }, { type: 'wifiLost', now: clk(T0 + 7, null) });
    expect(during.state).toEqual({ mode: 'ON_RUNNING', lossToken: 6, pending: 'LOSS', lossAtMs: T0 + 7, lossElapsedMs: E0 + 7, lossArmed: true });
    expect(reduce(during.state, { type: 'disable' }).state).toEqual({ mode: 'DISABLED', lossToken: 6, pending: 'NONE' });
  });
});
