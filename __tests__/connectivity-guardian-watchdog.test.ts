/**
 * Wi-Fi connectivity guardian — the Shizuku watchdog (2026-11-20).
 *
 * Policy lives in the pure core (reduceWithWatchdog / observeShizukuWatchdog
 * in lib/connectivity-guardian-core.ts, the TS port of
 * ConnectivityGuardianCore.kt); the native wiring and Kotlin/TS lockstep are
 * checked structurally at the end (local jest does not compile Kotlin).
 *
 * Invariants under test: the watchdog never starts Shizuku (its only lever is
 * the ON sequence re-run, wireless debugging cycled OFF -> ON); STOP-ALL is
 * read first and silences it completely; toggle OFF / Wi-Fi down = inert;
 * backoff >= 30 min between recovery STARTS; at most 3 per Wi-Fi session, the
 * count monotonic (gate round 1: a success does not reset it, a healthy tick
 * does not revive a given-up session; only Wi-Fi reconnect / re-enable / boot
 * / 24 h of continuous health reset it); one give-up notification, then
 * silence until the session resets.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@/lib/connectivity-guardian-core';
import {
  SHIZUKU_WATCHDOG_BACKOFF_MS,
  SHIZUKU_WATCHDOG_HEALTHY_GAP_MS,
  SHIZUKU_WATCHDOG_HEALTHY_RESET_MS,
  SHIZUKU_WATCHDOG_MAX_ATTEMPTS,
  SHIZUKU_WATCHDOG_TICK_MS,
  WD_DETECTED_DEAD,
  WD_GAVE_UP,
  WD_RECOVERY_FAILED,
  WD_RECOVERY_STARTED,
  WD_RECOVERY_SUCCEEDED,
  buildShizukuWatchdogAuditLine,
  freshWatchdog,
  newRunnerMemory,
  observeShizukuWatchdog,
  reduceWithWatchdog,
  restoreWatchdog,
  runOnSequence,
  runSequence,
  sequenceDoneFor,
  withoutUndurableOn,
  type CompletionProbes,
  type AssistReason,
  type Effect,
  type GuardianEvent,
  type GuardianState,
  type LossClock,
  type Ports,
  type WatchdogProbes,
} from '@/lib/connectivity-guardian-core';

const T0 = 1_800_000_000_000;
const E0 = 5_000_000;
const BOOT = 3;
const MIN = 60_000;
const clk = (elapsedMs: number, bootId: number | null = BOOT): LossClock => ({ wallMs: T0 + elapsedMs - E0, elapsedMs, bootId });

const ONLINE: GuardianState = { mode: 'IDLE_ONLINE', lossToken: 4, pending: 'NONE' };
const tick = (alive: boolean | null, at: number, over: Partial<{ stopAll: boolean; wifiUp: boolean | null }> = {}): GuardianEvent => ({
  type: 'shizukuWatchdogTick',
  stopAll: over.stopAll ?? false,
  wifiUp: over.wifiUp === undefined ? true : over.wifiUp,
  alive: over.stopAll === true ? null : alive,
  now: clk(at),
});
const REARM: Effect = { type: 'armShizukuWatchdog', delayMs: SHIZUKU_WATCHDOG_TICK_MS };
const CANCEL: Effect = { type: 'cancelShizukuWatchdog' };
const HOUR = 60 * MIN;
/** The observed-healthy chain after an alive tick at [at] ([accum]: credited so far). */
const healthy = (at: number, bootId: number = BOOT, accum = 0) => ({
  wdHealthyLastElapsedMs: at,
  wdHealthyBootId: bootId,
  ...(accum === 0 ? {} : { wdHealthyAccumMs: accum }),
});
const audit = (event: core.ShizukuWatchdogEvent, attempt: number): Effect => ({ type: 'shizukuWatchdogAudit', event, attempt });
const types = (es: Effect[]) => es.map((e) => e.type);
/** A recovery's end, as the executor reports it ([start]: when the run began). */
const done = (shizukuUp: boolean, extra: Partial<{ interrupted: boolean; stopped: boolean; start: LossClock }> = {}): GuardianEvent => ({
  type: 'sequenceDone',
  kind: 'on',
  shizukuUp,
  ...extra,
});

describe('W1. tick while Shizuku answers: no-op + re-arm', () => {
  it('only the next tick is armed, nothing audited; the healthy chain starts', () => {
    const t = reduceWithWatchdog(ONLINE, tick(true, E0));
    expect(t).toEqual({ state: { ...ONLINE, ...healthy(E0) }, effects: [REARM] });
    // A later healthy tick credits the observed gap, nothing else.
    expect(reduceWithWatchdog(t.state, tick(true, E0 + 15 * MIN))).toEqual({
      state: { ...ONLINE, ...healthy(E0 + 15 * MIN, BOOT, 15 * MIN) },
      effects: [REARM],
    });
  });

  it('the tick cadence is 15 minutes', () => {
    expect(SHIZUKU_WATCHDOG_TICK_MS).toBe(15 * MIN);
  });
});

describe('W2. tick while Shizuku is dead: one recovery (the ON sequence re-run)', () => {
  it('audits detected-dead + recovery-started and runs the recovery', () => {
    const t = reduceWithWatchdog(ONLINE, tick(false, E0));
    expect(t.effects).toEqual([audit(WD_DETECTED_DEAD, 0), audit(WD_RECOVERY_STARTED, 1), { type: 'runShizukuRecovery' }]);
    // The backoff anchor is not stamped at the observation (the run may start later).
    expect(t.state).toEqual({ ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 1, wdRecovering: true });
    // The recovery is an ON in flight: a process death reruns ON (it never loses cleanup).
    expect(core.persistableMode(t.state)).toBe('in_flight');
    // No plain runOn: the executor picks the recovery variant of the same runner.
    expect(types(t.effects)).not.toContain('runOn');
  });

  it('a successful recovery is audited and re-arms the tick; the attempt stays counted, anchored at the start', () => {
    const started = reduceWithWatchdog(ONLINE, tick(false, E0)).state;
    const t = reduceWithWatchdog(started, done(true, { start: clk(E0 + 2 * MIN) }));
    expect(t.effects).toEqual([audit(WD_RECOVERY_SUCCEEDED, 1), REARM]);
    expect(t.state).toEqual({ ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 + 2 * MIN, wdBootId: BOOT });
  });
});

describe('W3. STOP-ALL: total silence', () => {
  it('the observation reads nothing after STOP-ALL (no Wi-Fi probe, no ping)', () => {
    const reads: string[] = [];
    const probes: WatchdogProbes = {
      stopAll: () => (reads.push('stopAll'), true),
      wifiUp: () => (reads.push('wifi'), true),
      shizukuAlive: () => (reads.push('ping'), false),
    };
    expect(observeShizukuWatchdog(probes, clk(E0))).toEqual({ type: 'shizukuWatchdogTick', stopAll: true, wifiUp: null, alive: null, now: clk(E0) });
    expect(reads).toEqual(['stopAll']);
  });

  it('a STOP-ALL tick runs nothing, audits nothing, notifies nothing, burns no counter and does not re-arm', () => {
    for (const s of [
      ONLINE,
      { ...ONLINE, wdAttempts: 2, wdLastAttemptElapsedMs: E0 - 2 * SHIZUKU_WATCHDOG_BACKOFF_MS, wdBootId: BOOT },
    ]) {
      const t = reduceWithWatchdog(s as GuardianState, tick(false, E0, { stopAll: true }));
      expect(t).toEqual({ state: s, effects: [] });
    }
    // Gate round 2: the only state change is the healthy chain breaking (accumulation kept).
    const h: GuardianState = { ...ONLINE, ...healthy(E0 - HOUR, BOOT, 3 * HOUR) };
    expect(reduceWithWatchdog(h, tick(false, E0, { stopAll: true }))).toEqual({ state: { ...ONLINE, wdHealthyAccumMs: 3 * HOUR }, effects: [] });
  });

  it('after STOP-ALL clears, the next normal check re-arms the tick', () => {
    const silent = reduceWithWatchdog(ONLINE, tick(true, E0, { stopAll: true }));
    expect(types(silent.effects)).not.toContain('armShizukuWatchdog');
    expect(reduceWithWatchdog(silent.state, tick(true, E0 + MIN)).effects).toEqual([REARM]);
    expect(reduceWithWatchdog(silent.state, tick(false, E0 + MIN)).effects).toContainEqual({ type: 'runShizukuRecovery' });
  });

  it('STOP-ALL raised after the recovery started: the runner stops before the next step, the attempt is refunded', () => {
    const started = reduceWithWatchdog({ ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 - 40 * MIN }, tick(false, E0)).state;
    expect(started.wdAttempts).toBe(2);
    const t = reduceWithWatchdog(started, done(false, { stopped: true, start: clk(E0 + MIN) }));
    expect(t.state.wdAttempts).toBe(1);
    // Gate round 3: the refunded run still began, so its start is the anchor.
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0 + MIN);
    expect(t.state.wdBootId).toBe(BOOT);
    expect(t.state.wdRecovering).toBeUndefined();
    expect(types(t.effects)).not.toContain('shizukuWatchdogAudit');
    expect(types(t.effects)).not.toContain('notifyShizukuWatchdogGaveUp');
  });
});

describe('W4. guardian OFF / Wi-Fi down / not settled online: inert', () => {
  it('toggle OFF (DISABLED): nothing at all', () => {
    const off = core.initialState(false);
    expect(reduceWithWatchdog(off, tick(false, E0))).toEqual({ state: off, effects: [] });
  });

  it('Wi-Fi down: nothing, not even a re-arm (the loss flow owns that state); the ping is not taken', () => {
    expect(reduceWithWatchdog(ONLINE, tick(null, E0, { wifiUp: false }))).toEqual({ state: ONLINE, effects: [] });
    const reads: string[] = [];
    observeShizukuWatchdog(
      { stopAll: () => false, wifiUp: () => (reads.push('wifi'), false), shizukuAlive: () => (reads.push('ping'), false) },
      clk(E0),
    );
    expect(reads).toEqual(['wifi']);
  });

  it('Wi-Fi unknown (probe failed): fail closed, look again on the next tick', () => {
    expect(reduceWithWatchdog(ONLINE, tick(null, E0, { wifiUp: null }))).toEqual({ state: ONLINE, effects: [REARM] });
  });

  it.each<GuardianState>([
    { mode: 'IDLE_OFFLINE', lossToken: 1, pending: 'NONE' },
    { mode: 'LOSS_PENDING', lossToken: 1, pending: 'NONE' },
    { mode: 'ON_RUNNING', lossToken: 1, pending: 'NONE' },
    { mode: 'OFF_RUNNING', lossToken: 1, pending: 'NONE' },
    { mode: 'IDLE_ONLINE', lossToken: 1, pending: 'ON' },
  ])('%o: the guardian flow owns it, the tick does nothing', (s) => {
    expect(reduceWithWatchdog(s, tick(false, E0))).toEqual({ state: s, effects: [] });
  });
});

describe('W5. backoff: >= 30 minutes between recovery starts, checked by the tick', () => {
  it('a failed recovery is audited with its attempt number; the next start waits out the backoff', () => {
    let t = reduceWithWatchdog(ONLINE, tick(false, E0));
    t = reduceWithWatchdog(t.state, done(false, { start: clk(E0) }));
    expect(t.effects).toEqual([audit(WD_RECOVERY_FAILED, 1), REARM]);
    // 15 min later: still dead, inside the backoff -> audited, not acted on.
    t = reduceWithWatchdog(t.state, tick(false, E0 + 15 * MIN));
    expect(t.effects).toEqual([audit(WD_DETECTED_DEAD, 1), REARM]);
    expect(t.state.mode).toBe('IDLE_ONLINE');
    t = reduceWithWatchdog(t.state, tick(false, E0 + 30 * MIN - 1));
    expect(types(t.effects)).not.toContain('runShizukuRecovery');
    // 30 min after the last start: the second recovery.
    t = reduceWithWatchdog(t.state, tick(false, E0 + 30 * MIN));
    expect(t.effects).toEqual([audit(WD_DETECTED_DEAD, 1), audit(WD_RECOVERY_STARTED, 2), { type: 'runShizukuRecovery' }]);
    expect(SHIZUKU_WATCHDOG_BACKOFF_MS).toBe(30 * MIN);
  });

  it('a new boot or a clock that reads earlier counts as the backoff passed (the cap still bounds it)', () => {
    const s: GuardianState = { ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0, wdBootId: BOOT };
    expect(core.watchdogBackoffPassed(s, clk(E0 + MIN))).toBe(false);
    expect(core.watchdogBackoffPassed(s, clk(E0 + MIN, BOOT + 1))).toBe(true);
    expect(core.watchdogBackoffPassed(s, clk(E0 - 1))).toBe(true);
    expect(core.watchdogBackoffPassed(s, clk(E0 + MIN, null))).toBe(false);
  });
});

describe('W6. cap: 3 recoveries per Wi-Fi session, one give-up, then silence', () => {
  function failThrice() {
    let s = ONLINE;
    const all: Effect[] = [];
    let at = E0;
    for (let i = 0; i < SHIZUKU_WATCHDOG_MAX_ATTEMPTS; i++) {
      let t = reduceWithWatchdog(s, tick(false, at));
      expect(types(t.effects)).toContain('runShizukuRecovery');
      all.push(...t.effects);
      t = reduceWithWatchdog(t.state, done(false, { start: clk(at) }));
      all.push(...t.effects);
      s = t.state;
      at += SHIZUKU_WATCHDOG_BACKOFF_MS;
    }
    return { s, all, at };
  }

  it('the third failure gives up exactly once, with one notification', () => {
    const { s, all } = failThrice();
    expect(SHIZUKU_WATCHDOG_MAX_ATTEMPTS).toBe(3);
    expect(all.filter((e) => e.type === 'runShizukuRecovery')).toHaveLength(3);
    expect(all.filter((e) => e.type === 'notifyShizukuWatchdogGaveUp')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'shizukuWatchdogAudit' && e.event === WD_RECOVERY_FAILED)).toEqual([
      audit(WD_RECOVERY_FAILED, 1),
      audit(WD_RECOVERY_FAILED, 2),
      audit(WD_RECOVERY_FAILED, 3),
    ]);
    expect(all.filter((e) => e.type === 'shizukuWatchdogAudit' && e.event === WD_GAVE_UP)).toEqual([audit(WD_GAVE_UP, 3)]);
    expect(s.wdGaveUp).toBe(true);
    expect(s.mode).toBe('IDLE_ONLINE');
  });

  it('after giving up, dead ticks are silent (re-arm only) for as long as the session lasts', () => {
    let { s, at } = failThrice();
    for (let i = 0; i < 10; i++) {
      const t = reduceWithWatchdog(s, tick(false, at));
      expect(t.effects).toEqual([REARM]);
      s = t.state;
      at += SHIZUKU_WATCHDOG_TICK_MS;
    }
  });

  it('a restored session already at the cap but never notified gives up once on its next dead tick', () => {
    const s: GuardianState = { ...ONLINE, wdAttempts: 3, wdLastAttemptElapsedMs: E0, wdBootId: BOOT };
    const t = reduceWithWatchdog(s, tick(false, E0 + 2 * SHIZUKU_WATCHDOG_BACKOFF_MS));
    expect(t.effects).toEqual([audit(WD_GAVE_UP, 3), { type: 'notifyShizukuWatchdogGaveUp' }, REARM]);
    expect(reduceWithWatchdog(t.state, tick(false, E0 + 3 * SHIZUKU_WATCHDOG_BACKOFF_MS)).effects).toEqual([REARM]);
  });
});

describe('W7. the session count is monotonic (gate round 1): success and health do not reset it', () => {
  it('a recovery that brings Shizuku back keeps its attempt and its start as the backoff anchor', () => {
    let t = reduceWithWatchdog(ONLINE, tick(false, E0));
    t = reduceWithWatchdog(t.state, done(false, { start: clk(E0) }));
    t = reduceWithWatchdog(t.state, tick(false, E0 + 30 * MIN));
    t = reduceWithWatchdog(t.state, done(true, { start: clk(E0 + 30 * MIN) }));
    expect(t.effects).toEqual([audit(WD_RECOVERY_SUCCEEDED, 2), REARM]);
    expect(t.state).toEqual({ ...ONLINE, wdAttempts: 2, wdLastAttemptElapsedMs: E0 + 30 * MIN, wdBootId: BOOT });
    // The next death waits out the backoff from that start, and is attempt 3.
    expect(reduceWithWatchdog(t.state, tick(false, E0 + 31 * MIN)).effects).toEqual([audit(WD_DETECTED_DEAD, 2), REARM]);
    expect(reduceWithWatchdog(t.state, tick(false, E0 + 60 * MIN)).effects).toContainEqual(audit(WD_RECOVERY_STARTED, 3));
  });

  it('flapping Shizuku: at most 3 recoveries per session even with successes in between; one give-up; then silence', () => {
    let s: GuardianState = ONLINE;
    const all: Effect[] = [];
    // Shizuku comes back after every recovery, then dies again on the very next tick.
    for (let at = E0; at <= E0 + 12 * HOUR; at += SHIZUKU_WATCHDOG_TICK_MS) {
      let t = reduceWithWatchdog(s, tick(false, at));
      all.push(...t.effects);
      if (types(t.effects).includes('runShizukuRecovery')) {
        // The 3rd recovery fails; the first two succeed.
        const n = t.state.wdAttempts!;
        t = reduceWithWatchdog(t.state, done(n < 3, { start: clk(at) }));
        all.push(...t.effects);
      }
      s = t.state;
    }
    const starts = all.filter((e) => e.type === 'runShizukuRecovery');
    expect(starts).toHaveLength(SHIZUKU_WATCHDOG_MAX_ATTEMPTS);
    expect(all.filter((e) => e.type === 'shizukuWatchdogAudit' && e.event === WD_RECOVERY_SUCCEEDED)).toEqual([
      audit(WD_RECOVERY_SUCCEEDED, 1),
      audit(WD_RECOVERY_SUCCEEDED, 2),
    ]);
    expect(all.filter((e) => e.type === 'notifyShizukuWatchdogGaveUp')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'shizukuWatchdogAudit' && e.event === WD_GAVE_UP)).toEqual([audit(WD_GAVE_UP, 3)]);
    expect(s.wdGaveUp).toBe(true);
    // Further dead ticks stay silent.
    expect(reduceWithWatchdog(s, tick(false, E0 + 13 * HOUR)).effects).toEqual([REARM]);
  });

  it('flapping inside the backoff: death right after a success starts nothing until 30 min after the last start', () => {
    let t = reduceWithWatchdog(ONLINE, tick(false, E0));
    t = reduceWithWatchdog(t.state, done(true, { start: clk(E0) }));
    t = reduceWithWatchdog(t.state, tick(true, E0 + 5 * MIN));
    t = reduceWithWatchdog(t.state, tick(false, E0 + 20 * MIN));
    expect(types(t.effects)).not.toContain('runShizukuRecovery');
    t = reduceWithWatchdog(t.state, tick(false, E0 + 30 * MIN));
    expect(t.effects).toContainEqual(audit(WD_RECOVERY_STARTED, 2));
  });

  it('given up is sticky: a healthy tick neither revives it nor lowers the count; a later dead tick stays silent', () => {
    const gaveUp: GuardianState = { ...ONLINE, wdAttempts: 3, wdLastAttemptElapsedMs: E0, wdBootId: BOOT, wdGaveUp: true };
    const alive = reduceWithWatchdog(gaveUp, tick(true, E0 + MIN));
    expect(alive).toEqual({ state: { ...gaveUp, ...healthy(E0 + MIN) }, effects: [REARM] });
    const dead = reduceWithWatchdog(alive.state, tick(false, E0 + 2 * HOUR));
    expect(dead).toEqual({ state: gaveUp, effects: [REARM] });
  });

  it('a plain ON that ends with Shizuku up changes no watchdog state (and audits nothing)', () => {
    const session = { wdAttempts: 2, wdLastAttemptElapsedMs: E0, wdBootId: BOOT, wdGaveUp: true as const };
    const s: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', ...session };
    expect(reduceWithWatchdog(s, done(true, { start: clk(E0 + HOUR) }))).toEqual({ state: { ...ONLINE, ...session }, effects: [REARM] });
  });
});

describe('W7b. 24 h of OBSERVED health resets the session (gate round 2)', () => {
  const used: GuardianState = { ...ONLINE, wdAttempts: 2, wdLastAttemptElapsedMs: E0 - HOUR, wdBootId: BOOT };
  const gaveUp: GuardianState = { ...ONLINE, wdAttempts: 3, wdLastAttemptElapsedMs: E0 - HOUR, wdBootId: BOOT, wdGaveUp: true };
  /** Alive ticks every 15 min over [from, to]. */
  const run = (s: GuardianState, from: number, to: number) => {
    for (let at = from; at <= to; at += SHIZUKU_WATCHDOG_TICK_MS) s = reduceWithWatchdog(s, tick(true, at)).state;
    return s;
  };
  const reset = (s: GuardianState) => s.wdAttempts === undefined && s.wdGaveUp === undefined && s.wdLastAttemptElapsedMs === undefined;

  it('the constants: 24 h of credit, gaps of at most 30 min', () => {
    expect(SHIZUKU_WATCHDOG_HEALTHY_RESET_MS).toBe(24 * HOUR);
    expect(SHIZUKU_WATCHDOG_HEALTHY_GAP_MS).toBe(30 * MIN);
  });

  it.each([['attempts > 0', used], ['given up', gaveUp]] as const)('%s: alive ticks every 15 min for 24 h reset it; less does not', (_n, s0) => {
    // E0 is the first observation (credits 0); E0 + 24 h - 15 min has 23.75 h credited.
    const short = run(s0, E0, E0 + 24 * HOUR - SHIZUKU_WATCHDOG_TICK_MS);
    expect(short.wdAttempts).toBe(s0.wdAttempts);
    expect(short.wdGaveUp).toBe(s0.wdGaveUp);
    expect(short.wdHealthyAccumMs).toBe(24 * HOUR - SHIZUKU_WATCHDOG_TICK_MS);
    const t = reduceWithWatchdog(short, tick(true, E0 + 24 * HOUR));
    expect(t).toEqual({ state: { ...ONLINE, ...healthy(E0 + 24 * HOUR) }, effects: [REARM] });
    // The next death is a fresh session's first attempt, with no backoff.
    expect(reduceWithWatchdog(t.state, tick(false, E0 + 24 * HOUR + MIN)).effects).toContainEqual(audit(WD_RECOVERY_STARTED, 1));
  });

  it('a > 30 min observation gap mid-way restarts the accumulation: no reset at wall-clock 24 h', () => {
    let s = run(gaveUp, E0, E0 + 10 * HOUR);
    // The next alive tick comes 45 min later (a missed tick): not provably continuous.
    s = reduceWithWatchdog(s, tick(true, E0 + 10 * HOUR + 45 * MIN)).state;
    expect(s.wdHealthyAccumMs).toBeUndefined();
    s = run(s, E0 + 11 * HOUR, E0 + 24 * HOUR + 15 * MIN);
    expect(s.wdGaveUp).toBe(true);
    // Reset only once 24 h have been observed after the gap (from E0 + 10 h 45 min).
    s = run(s, E0 + 24 * HOUR + 30 * MIN, E0 + 34 * HOUR + 30 * MIN);
    expect(s.wdGaveUp).toBe(true);
    s = reduceWithWatchdog(s, tick(true, E0 + 34 * HOUR + 45 * MIN)).state;
    expect(reset(s)).toBe(true);
  });

  it('24 h of STOP-ALL between two alive ticks credits nothing', () => {
    let s = reduceWithWatchdog(gaveUp, tick(true, E0)).state;
    for (let at = E0 + 15 * MIN; at < E0 + 24 * HOUR; at += SHIZUKU_WATCHDOG_TICK_MS) s = reduceWithWatchdog(s, tick(null, at, { stopAll: true })).state;
    s = reduceWithWatchdog(s, tick(true, E0 + 24 * HOUR)).state;
    expect(s.wdGaveUp).toBe(true);
    expect(s.wdHealthyAccumMs).toBeUndefined();
    // Even a single STOP-ALL tick inside a 25-min gap breaks the chain: that gap credits 0.
    let c = run(used, E0, E0 + HOUR);
    const before = c.wdHealthyAccumMs;
    c = reduceWithWatchdog(c, tick(null, E0 + HOUR + 10 * MIN, { stopAll: true })).state;
    c = reduceWithWatchdog(c, tick(true, E0 + HOUR + 25 * MIN)).state;
    expect(c.wdHealthyAccumMs).toBe(before);
    expect(c.wdHealthyLastElapsedMs).toBe(E0 + HOUR + 25 * MIN);
  });

  it('unknown Wi-Fi / unread liveness / Wi-Fi down also break the chain (accumulation kept)', () => {
    const s: GuardianState = { ...used, ...healthy(E0, BOOT, 5 * HOUR) };
    for (const e of [tick(null, E0 + 15 * MIN, { wifiUp: null }), tick(null, E0 + 15 * MIN), tick(null, E0 + 15 * MIN, { wifiUp: false })]) {
      const t = reduceWithWatchdog(s, e).state;
      expect(t.wdHealthyLastElapsedMs).toBeUndefined();
      expect(t.wdHealthyBootId).toBeUndefined();
      expect(t.wdHealthyAccumMs).toBe(5 * HOUR);
      // The next alive tick is a first observation: nothing credited.
      expect(reduceWithWatchdog(t, tick(true, E0 + 30 * MIN)).state.wdHealthyAccumMs).toBe(5 * HOUR);
    }
  });

  it('unknown or changed boot ids: no credit (the accumulation restarts)', () => {
    const s: GuardianState = { ...used, ...healthy(E0, BOOT, 5 * HOUR) };
    const tickOn = (bootId: number | null) => ({ ...tick(true, E0 + 15 * MIN), now: clk(E0 + 15 * MIN, bootId) }) as GuardianEvent;
    expect(reduceWithWatchdog(s, tickOn(null)).state.wdHealthyAccumMs).toBeUndefined();
    expect(reduceWithWatchdog(s, tickOn(BOOT + 1)).state).toEqual({ ...used, ...healthy(E0 + 15 * MIN, BOOT + 1) });
    // Stored boot unknown: no credit either.
    const unknown: GuardianState = { ...used, wdHealthyLastElapsedMs: E0, wdHealthyAccumMs: 5 * HOUR };
    expect(reduceWithWatchdog(unknown, tick(true, E0 + 15 * MIN)).state.wdHealthyAccumMs).toBeUndefined();
    // A clock that reads earlier than the last observation: no credit.
    expect(reduceWithWatchdog(s, tick(true, E0 - MIN)).state.wdHealthyAccumMs).toBeUndefined();
  });

  it('a dead tick zeroes the accumulation: the 24 h must be observed again', () => {
    let s = run(gaveUp, E0, E0 + 20 * HOUR);
    expect(s.wdHealthyAccumMs).toBe(20 * HOUR);
    s = reduceWithWatchdog(s, tick(false, E0 + 20 * HOUR + 15 * MIN)).state;
    expect(s.wdHealthyAccumMs).toBeUndefined();
    expect(s.wdHealthyLastElapsedMs).toBeUndefined();
    s = run(s, E0 + 20 * HOUR + 30 * MIN, E0 + 44 * HOUR + 15 * MIN);
    expect(s.wdGaveUp).toBe(true);
    s = reduceWithWatchdog(s, tick(true, E0 + 44 * HOUR + 30 * MIN)).state;
    expect(reset(s)).toBe(true);
  });

  it('a given-up session revives only through the full observed 24 h (or reconnect / re-enable / boot, W8)', () => {
    let s = reduceWithWatchdog(gaveUp, tick(true, E0)).state;
    // Alternating short STOP-ALLs: the wall clock passes 48 h, little is observed.
    for (let at = E0 + 15 * MIN; at <= E0 + 48 * HOUR; at += 30 * MIN) {
      s = reduceWithWatchdog(s, tick(null, at, { stopAll: true })).state;
      s = reduceWithWatchdog(s, tick(true, at + 15 * MIN)).state;
    }
    expect(s.wdGaveUp).toBe(true);
    expect(s.wdHealthyAccumMs).toBeUndefined();
  });
});

describe('W8. the session resets on Wi-Fi reconnect / guardian re-enable / boot — and only then', () => {
  const gaveUp: GuardianState = { ...ONLINE, wdAttempts: 3, wdLastAttemptElapsedMs: E0, wdBootId: BOOT, wdGaveUp: true };

  it('loss then reconnect: a fresh session (attempts 0, no give-up, no backoff)', () => {
    let t = reduceWithWatchdog(gaveUp, { type: 'wifiLost', now: clk(E0 + MIN) });
    expect(t.state.mode).toBe('LOSS_PENDING');
    t = reduceWithWatchdog(t.state, { type: 'debounceExpired', token: t.state.lossToken, wifiUp: false });
    t = reduceWithWatchdog(t.state, { type: 'sequenceDone', kind: 'off' });
    expect(t.state.mode).toBe('IDLE_OFFLINE');
    t = reduceWithWatchdog(t.state, { type: 'wifiAvailable' });
    expect(t.state.mode).toBe('ON_RUNNING');
    expect(t.state.wdAttempts).toBeUndefined();
    expect(t.state.wdGaveUp).toBeUndefined();
    expect(t.state.wdLastAttemptElapsedMs).toBeUndefined();
  });

  it('a momentary drop inside the debounce (AP switch) is a reconnect too', () => {
    const lost = reduceWithWatchdog(gaveUp, { type: 'wifiLost', now: clk(E0 + MIN) }).state;
    const back = reduceWithWatchdog({ ...lost, wdGaveUp: true, wdAttempts: 3 }, { type: 'wifiAvailable' });
    expect(back.state.mode).toBe('IDLE_ONLINE');
    expect(back.state.wdGaveUp).toBeUndefined();
    // Settling online again starts the tick.
    expect(back.effects).toContainEqual(REARM);
  });

  it('a duplicate Wi-Fi-available / reconcile while already online does NOT reset (no cap bypass)', () => {
    expect(reduceWithWatchdog(gaveUp, { type: 'wifiAvailable' })).toEqual({ state: gaveUp, effects: [] });
    expect(reduceWithWatchdog(gaveUp, { type: 'reconcile', wifiUp: true, now: clk(E0) })).toEqual({ state: gaveUp, effects: [] });
  });

  it('the RN mirror rewrite at every app start (enable while enabled) does NOT reset; re-enable from OFF does', () => {
    expect(reduceWithWatchdog(gaveUp, { type: 'enable', wifiUp: true })).toEqual({ state: gaveUp, effects: [] });
    const off = reduceWithWatchdog(gaveUp, { type: 'disable' });
    expect(off.state).toEqual({ mode: 'DISABLED', lossToken: gaveUp.lossToken, pending: 'NONE' });
    const on = reduceWithWatchdog(off.state, { type: 'enable', wifiUp: true });
    expect(on.state.wdAttempts).toBeUndefined();
    expect(types(on.effects)).toEqual(['registerCallbacks', 'runOn']);
  });

  it('boot / app update opens a new session', () => {
    const t = reduceWithWatchdog(gaveUp, { type: 'boot', enabled: true, wifiUp: true, now: clk(1_000, BOOT + 1) });
    expect(t.state.wdGaveUp).toBeUndefined();
    expect(t.state.wdAttempts).toBeUndefined();
  });
});

describe('W9. tick arming follows the settled-online state', () => {
  it('an ON that settles online arms the tick; an OFF that settles offline does not', () => {
    const on = reduceWithWatchdog({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'sequenceDone', kind: 'on' });
    expect(on.effects).toEqual([REARM]);
    const off = reduceWithWatchdog({ mode: 'OFF_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'sequenceDone', kind: 'off' });
    expect(off.effects).toEqual([]);
  });

  it('the plain reducer is unchanged (no watchdog effects leak into reduce)', () => {
    expect(core.reduce({ mode: 'ON_RUNNING', lossToken: 0, pending: 'NONE' }, { type: 'sequenceDone', kind: 'on' }).effects).toEqual([]);
    expect(core.reduce(ONLINE, tick(false, E0))).toEqual({ state: ONLINE, effects: [] });
  });

  it('a recovery cut short by Wi-Fi loss is refunded (nothing audited), then the loss flow takes over', () => {
    const started = reduceWithWatchdog(ONLINE, tick(false, E0)).state;
    const lost = reduceWithWatchdog(started, { type: 'wifiLost', now: clk(E0 + 10_000) });
    expect(lost.state.pending).toBe('LOSS');
    const t = reduceWithWatchdog(lost.state, done(false, { interrupted: true, start: clk(E0) }));
    expect(t.state.mode).toBe('LOSS_PENDING');
    expect(t.state.wdRecovering).toBeUndefined();
    expect(t.state.wdAttempts).toBeUndefined();
    // Gate round 3: the run began, so its start anchors the cooldown.
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0);
    expect(t.effects).toEqual([]);
  });
});

describe('W10. persistence', () => {
  it('restoreWatchdog clamps attempts, drops a boot without its anchor, leaves DISABLED alone', () => {
    expect(restoreWatchdog(ONLINE, 7, E0, BOOT, true)).toEqual({ ...ONLINE, wdAttempts: 3, wdLastAttemptElapsedMs: E0, wdBootId: BOOT, wdGaveUp: true });
    expect(restoreWatchdog(ONLINE, -2, null, BOOT, false)).toEqual(ONLINE);
    expect(restoreWatchdog(ONLINE, 0, null, null, false, 2 * HOUR, E0, BOOT)).toEqual({ ...ONLINE, ...healthy(E0, BOOT, 2 * HOUR) });
    expect(restoreWatchdog(ONLINE, 0, null, null, false, 0, null, BOOT)).toEqual(ONLINE);
    // The accumulation is clamped to [0, 24 h].
    expect(restoreWatchdog(ONLINE, 0, null, null, false, -5).wdHealthyAccumMs).toBeUndefined();
    expect(restoreWatchdog(ONLINE, 0, null, null, false, 99 * HOUR).wdHealthyAccumMs).toBe(24 * HOUR);
    const off = core.initialState(false);
    expect(restoreWatchdog(off, 2, E0, BOOT, true, HOUR, E0, BOOT, true)).toBe(off);
  });

  it('freshWatchdog strips every watchdog field (the observed-healthy fields too)', () => {
    expect(
      freshWatchdog({ ...ONLINE, wdAttempts: 2, wdLastAttemptElapsedMs: 1, wdBootId: 1, wdGaveUp: true, wdRecovering: true, ...healthy(1, BOOT, HOUR) }),
    ).toEqual(ONLINE);
  });
});

describe('W11. audit line', () => {
  it('fixed keys, closed events, attempt 0..3', () => {
    const line = buildShizukuWatchdogAuditLine('2026-11-20T00:00:00.000Z', WD_RECOVERY_FAILED, 2)!;
    expect(JSON.parse(line)).toEqual({
      ts: '2026-11-20T00:00:00.000Z',
      kind: 'wifi_guardian',
      step: 'shizuku_watchdog',
      event: 'shizuku_watchdog_recovery_failed',
      attempt: 2,
    });
    expect(Object.keys(JSON.parse(line))).toEqual([...core.SHIZUKU_WATCHDOG_AUDIT_KEYS]);
    expect(buildShizukuWatchdogAuditLine('2026-11-20T00:00:00.000Z', 'shizuku_started', 1)).toBeNull();
    expect(buildShizukuWatchdogAuditLine('2026-11-20T00:00:00.000Z', WD_GAVE_UP, 4)).toBeNull();
    expect(buildShizukuWatchdogAuditLine('2026-11-20T00:00:00.000Z', WD_GAVE_UP, 1.5)).toBeNull();
    expect(buildShizukuWatchdogAuditLine('yesterday', WD_GAVE_UP, 1)).toBeNull();
    // Every event is greppable by one prefix.
    for (const e of core.SHIZUKU_WATCHDOG_EVENTS) expect(e.startsWith('shizuku_watchdog_')).toBe(true);
  });

  it('the give-up reason is an assist reason (the guardian notification path)', () => {
    expect(core.ASSIST_REASONS).toContain('shizuku_watchdog_gave_up');
  });
});

// ── Runner: the recovery is the ON sequence with wireless debugging cycled ──
/**
 * A device where Shizuku's own auto-start fires only when wireless debugging
 * goes OFF -> ON (that is the hypothesis the watchdog leans on), and where the
 * server can be killed while wireless debugging stays on (One UI battery
 * management, 2026-11-20).
 */
function device(
  over: Partial<{ adb: number | null; autoStart: boolean; stopAllAfterOff: boolean; adbOffSticks: boolean; wifi: boolean | null }> = {},
) {
  const w = { adb: 1 as number | null, shizuku: false, autoStart: true, stopAllAfterOff: false, adbOffSticks: true, stop: false, wifi: true as boolean | null, ...over };
  let now = 1_000_000;
  let startAt: number | null = null;
  const calls: string[] = [];
  const audits: string[] = [];
  const notes: AssistReason[] = [];
  const ports: Ports = {
    nowMs: () => now,
    sleep: (ms) => {
      now += ms;
    },
    enabled: () => true,
    stopAll: () => w.stop,
    superseded: () => false,
    hasWriteSecureSettings: () => true,
    readAdbWifi: () => w.adb,
    writeAdbWifi: (v) => {
      calls.push(`adb:${v}`);
      if (v === 0 && !w.adbOffSticks) return true;
      const was = w.adb;
      w.adb = v;
      if (v === 0) {
        w.shizuku = false;
        if (w.stopAllAfterOff) w.stop = true;
      }
      if (v === 1 && was === 0 && w.autoStart) startAt = now + 8_000;
      return true;
    },
    shizukuAlive: () => {
      if (startAt !== null && now >= startAt) {
        w.shizuku = true;
        startAt = null;
      }
      return w.shizuku;
    },
    wifiUp: () => w.wifi,
    vpnUp: () => true,
    closePawPreapproved: () => true,
    requestTailscale: () => {
      calls.push('tailscale');
      return null;
    },
    closePawSettled: () => true,
    audit: (_seq, step, action, _b, _a, outcome) => {
      audits.push(`${step}:${action}:${outcome}`);
    },
    notifyAssist: (r) => {
      notes.push(r);
    },
  };
  return { w, ports, calls, audits, notes };
}

describe('W12. recovery runner: wireless debugging cycled OFF -> ON, Shizuku only waited for', () => {
  it('Shizuku killed with wireless debugging on: the cycle gives its auto-start a fresh trigger', () => {
    const d = device();
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('done');
    expect(d.calls).toEqual(['adb:0', 'adb:1']);
    expect(d.audits).toEqual([
      'wifi_debug:disable:ok',
      'wifi_debug:enable:ok',
      'shizuku:wait:ok',
      'tailscale:check:already',
      'sequence:end:done',
    ]);
    expect(d.w.shizuku).toBe(true);
  });

  it('a plain ON never cycles (and so, on this device, cannot revive a killed server)', () => {
    const d = device();
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1')).toBe('assist');
    expect(d.calls).toEqual([]);
    expect(d.notes).toEqual(['shizuku_timeout']);
  });

  it('wireless debugging already off: the recovery just enables it (no extra OFF write)', () => {
    const d = device({ adb: 0 });
    expect(runSequence('on', d.ports, newRunnerMemory(), 'on-1', true)).toBe('done');
    expect(d.calls).toEqual(['adb:1']);
  });

  it('a recovery that times out is audited but not notified (the watchdog speaks once, at give-up)', () => {
    const d = device({ autoStart: false });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('assist');
    expect(d.audits).toContain('shizuku:wait:timeout');
    expect(d.notes).toEqual([]);
  });

  it('STOP-ALL raised after the OFF write: wireless debugging is NOT written on again', () => {
    const d = device({ stopAllAfterOff: true });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('stopped');
    expect(d.calls).toEqual(['adb:0']);
    expect(d.audits).toEqual(['wifi_debug:disable:ok', 'wifi_debug:check:stopped', 'sequence:end:stopped']);
  });

  it('STOP-ALL already on: nothing written at all', () => {
    const d = device();
    d.w.stop = true;
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('stopped');
    expect(d.calls).toEqual([]);
  });

  it('the OFF write does not take: the recovery fails without writing ON or waiting', () => {
    const d = device({ adbOffSticks: false });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('failed');
    expect(d.calls).toEqual(['adb:0']);
    expect(d.audits).toEqual(['wifi_debug:disable:verify_failed', 'sequence:end:failed']);
    expect(d.notes).toEqual([]);
  });
});

describe('W15. gate round 1: interrupted recoveries are refunded, never counted as a success', () => {
  const inFlight: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 1, wdRecovering: true };

  it.each([
    ['stopped (STOP-ALL / toggle off)', { stopped: true }],
    ['interrupted (superseded)', { interrupted: true }],
  ] as const)('%s with a lucky shizukuUp: refund, anchor = its start (gate round 3), no audit, no session clear', (_n, how) => {
    const s: GuardianState = { ...inFlight, wdLastAttemptElapsedMs: E0 - HOUR, wdBootId: BOOT };
    const t = reduceWithWatchdog(s, done(true, { ...how, start: clk(E0, 9) }));
    expect(t.state.wdAttempts).toBeUndefined();
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0);
    expect(t.state.wdBootId).toBe(9);
    expect(t.state.wdRecovering).toBeUndefined();
    expect(types(t.effects)).not.toContain('shizukuWatchdogAudit');
    expect(types(t.effects)).not.toContain('notifyShizukuWatchdogGaveUp');
  });

  it('a genuine success: audited, attempts stay 1, anchor = the start clock', () => {
    const t = reduceWithWatchdog(inFlight, done(true, { stopped: false, interrupted: false, start: clk(E0 + 7 * MIN) }));
    expect(t.effects).toEqual([audit(WD_RECOVERY_SUCCEEDED, 1), REARM]);
    expect(t.state).toEqual({ ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 + 7 * MIN, wdBootId: BOOT });
  });

  it('a finished recovery without a start clock leaves the previous anchor', () => {
    const s: GuardianState = { ...inFlight, wdAttempts: 2, wdLastAttemptElapsedMs: E0 - HOUR, wdBootId: BOOT };
    const t = reduceWithWatchdog(s, done(false));
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0 - HOUR);
    expect(t.effects).toEqual([audit(WD_RECOVERY_FAILED, 2), REARM]);
  });
});

describe('W16. gate round 1: backoff is measured start to start', () => {
  it('death observed at T0, the run starts at T0+10min and fails: T0+39min waits, T0+41min starts', () => {
    let t = reduceWithWatchdog(ONLINE, tick(false, E0));
    expect(t.state.wdLastAttemptElapsedMs).toBeUndefined();
    t = reduceWithWatchdog(t.state, done(false, { start: clk(E0 + 10 * MIN) }));
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0 + 10 * MIN);
    const early = reduceWithWatchdog(t.state, tick(false, E0 + 39 * MIN));
    expect(early.effects).toEqual([audit(WD_DETECTED_DEAD, 1), REARM]);
    const late = reduceWithWatchdog(t.state, tick(false, E0 + 41 * MIN));
    expect(late.effects).toEqual([audit(WD_DETECTED_DEAD, 1), audit(WD_RECOVERY_STARTED, 2), { type: 'runShizukuRecovery' }]);
  });
});

describe('W17. gate round 1: Wi-Fi loss / toggle off disarm the tick', () => {
  it('settled online + WifiLost cancels the tick alarm', () => {
    const t = reduceWithWatchdog(ONLINE, { type: 'wifiLost', now: clk(E0) });
    expect(t.state.mode).toBe('LOSS_PENDING');
    expect(t.effects).toContainEqual(CANCEL);
    expect(types(t.effects)).not.toContain('armShizukuWatchdog');
  });

  it('Disable cancels it too', () => {
    expect(reduceWithWatchdog(ONLINE, { type: 'disable' }).effects).toContainEqual(CANCEL);
  });

  it('a reconcile that probes Wi-Fi down, and a debounce that starts OFF, cancel it', () => {
    expect(reduceWithWatchdog(ONLINE, { type: 'reconcile', wifiUp: false, now: clk(E0) }).effects).toContainEqual(CANCEL);
    const lost = reduceWithWatchdog(ONLINE, { type: 'wifiLost', now: clk(E0) }).state;
    const off = reduceWithWatchdog(lost, { type: 'debounceExpired', token: lost.lossToken, wifiUp: false });
    expect(types(off.effects)).toEqual(['runOff', 'cancelShizukuWatchdog']);
  });

  it('events that keep or regain Wi-Fi do not cancel it', () => {
    expect(types(reduceWithWatchdog(ONLINE, { type: 'reconcile', wifiUp: true, now: clk(E0) }).effects)).not.toContain('cancelShizukuWatchdog');
    const lost = reduceWithWatchdog(ONLINE, { type: 'wifiLost', now: clk(E0) }).state;
    expect(types(reduceWithWatchdog(lost, { type: 'wifiAvailable' }).effects)).toEqual(['cancelDebounce', 'armShizukuWatchdog']);
    expect(types(reduceWithWatchdog(lost, { type: 'debounceExpired', token: lost.lossToken, wifiUp: true }).effects)).toEqual(['armShizukuWatchdog']);
  });
});

describe('W18. gate round 1: a failed checkpoint refunds the recovery, never degrades it into a plain ON', () => {
  it('attempts 0 -> 1 refunded to 0: settled online, tick re-armed, detected-dead kept, nothing run', () => {
    const t = withoutUndurableOn(reduceWithWatchdog(ONLINE, tick(false, E0)));
    expect(t.state).toEqual(ONLINE);
    expect(t.effects).toEqual([audit(WD_DETECTED_DEAD, 0), REARM]);
    expect(types(t.effects)).not.toContain('runShizukuRecovery');
    expect(types(t.effects)).not.toContain('runOn');
    expect(t.effects).not.toContainEqual(audit(WD_RECOVERY_STARTED, 1));
    // The next dead tick retries it as a recovery.
    expect(reduceWithWatchdog(t.state, tick(false, E0 + 15 * MIN)).effects).toEqual([
      audit(WD_DETECTED_DEAD, 0),
      audit(WD_RECOVERY_STARTED, 1),
      { type: 'runShizukuRecovery' },
    ]);
  });

  it('attempts 1 -> 2 refunded to 1: the previous anchor is preserved', () => {
    const s: GuardianState = { ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 - HOUR, wdBootId: BOOT };
    const t = withoutUndurableOn(reduceWithWatchdog(s, tick(false, E0)));
    expect(t.state).toEqual(s);
    expect(t.effects).toEqual([audit(WD_DETECTED_DEAD, 1), REARM]);
  });

  it('a plain RunOn keeps its old handling: ON stays owed', () => {
    const t = withoutUndurableOn(reduceWithWatchdog({ mode: 'IDLE_OFFLINE', lossToken: 0, pending: 'NONE' }, { type: 'wifiAvailable' }));
    expect(t).toEqual({ state: { mode: 'IDLE_ONLINE', lossToken: 0, pending: 'ON' }, effects: [] });
  });
});

describe('W19. gate round 1: a queued recovery re-probes Wi-Fi before its first write', () => {
  it.each([false, null])('Wi-Fi %p: superseded, nothing written (fail closed)', (wifi) => {
    const d = device({ wifi });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('superseded');
    expect(runSequence('on', device({ wifi }).ports, newRunnerMemory(), 'on-2', true)).toBe('superseded');
    expect(d.calls).toEqual([]);
    expect(d.audits).toEqual(['wifi_debug:check:superseded', 'sequence:end:superseded']);
  });

  it('a plain ON does not consult the probe', () => {
    const d = device({ wifi: false, adb: 0 });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1')).toBe('done');
    expect(d.calls).toEqual(['adb:1']);
  });
});

describe('W24. gate round 4: Wi-Fi is re-probed right before the recovery enable write', () => {
  /** Wi-Fi answers `first` at the pre-cycle probe and `later` afterwards. */
  function dropAfterFirstProbe(later: boolean | null, over: Parameters<typeof device>[0] = {}) {
    const d = device(over);
    let probes = 0;
    d.ports.wifiUp = () => (probes++ === 0 ? true : later);
    return d;
  }

  it.each([false, null])('Wi-Fi %p after the cycle pause: superseded, OFF written, ON never written', (later) => {
    const d = dropAfterFirstProbe(later);
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('superseded');
    expect(d.calls).toEqual(['adb:0']);
    expect(d.calls).not.toContain('adb:1');
    expect(d.w.adb).toBe(0);
    expect(d.audits).toEqual(['wifi_debug:disable:ok', 'wifi_debug:enable:superseded', 'sequence:end:superseded']);
    expect(d.notes).toEqual([]);
  });

  it('through runSequence too', () => {
    const d = dropAfterFirstProbe(false);
    expect(runSequence('on', d.ports, newRunnerMemory(), 'on-1', true)).toBe('superseded');
    expect(d.calls).toEqual(['adb:0']);
  });

  it('wireless debugging already off (no cycle): the re-probe still guards the enable write', () => {
    const d = dropAfterFirstProbe(false, { adb: 0 });
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('superseded');
    expect(d.calls).toEqual([]);
    expect(d.audits).toEqual(['wifi_debug:enable:superseded', 'sequence:end:superseded']);
  });

  it('Wi-Fi stays up: the cycle completes and the enable write happens', () => {
    const d = dropAfterFirstProbe(true);
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1', true)).toBe('done');
    expect(d.calls).toEqual(['adb:0', 'adb:1']);
  });

  it('a plain ON never consults the probe, even with Wi-Fi down', () => {
    const d = device({ adb: 0, wifi: false });
    let probes = 0;
    const orig = d.ports.wifiUp;
    d.ports.wifiUp = () => {
      probes++;
      return orig();
    };
    expect(runOnSequence(d.ports, newRunnerMemory(), 'on-1')).toBe('done');
    expect(d.calls).toEqual(['adb:1']);
    expect(probes).toBe(0);
  });
});

describe('W20. gate round 2: a superseded recovery never becomes a plain ON', () => {
  const inFlight: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 1, wdRecovering: true };

  it('superseded by its own Wi-Fi re-probe, nothing pending: refund, NO runOn, settled online, tick re-armed', () => {
    // The plain reducer would read this as "Wi-Fi came back: finish it".
    expect(types(core.reduce(inFlight, done(false, { interrupted: true })).effects)).toEqual(['runOn']);
    const t = reduceWithWatchdog(inFlight, done(false, { interrupted: true, start: clk(E0) }));
    expect(types(t.effects)).not.toContain('runOn');
    expect(types(t.effects)).not.toContain('runShizukuRecovery');
    expect(t.effects).toEqual([REARM]);
    expect(t.state).toEqual({ ...ONLINE, wdLastAttemptElapsedMs: E0, wdBootId: BOOT });
  });

  it('end to end: queued recovery, Wi-Fi gone when it runs -> nothing written, refunded, no plain ON', () => {
    const d = device({ wifi: false });
    const started = reduceWithWatchdog(ONLINE, tick(false, E0));
    const res = runSequence('on', d.ports, newRunnerMemory(), 'on-1', true);
    expect(res).toBe('superseded');
    const ev = sequenceDoneFor('on', res, true, clk(E0), { stopAll: () => false, enabled: () => true, wifiUp: () => false, shizukuAlive: () => true });
    const t = reduceWithWatchdog(started.state, ev);
    expect(types(t.effects)).not.toContain('runOn');
    expect(t.state.wdAttempts).toBeUndefined();
    expect(d.calls).toEqual([]);
  });

  it('superseded with an ON pending (a real obligation): refund, runOn kept (plain, not a recovery)', () => {
    const s: GuardianState = { ...inFlight, pending: 'ON' };
    const t = reduceWithWatchdog(s, done(false, { interrupted: true, start: clk(E0) }));
    expect(t.effects).toEqual([{ type: 'runOn' }]);
    expect(t.state).toEqual({ ...ONLINE, mode: 'ON_RUNNING', pending: 'NONE', wdLastAttemptElapsedMs: E0, wdBootId: BOOT });
    expect(t.state.wdAttempts).toBeUndefined();
    expect(t.state.wdRecovering).toBeUndefined();
  });

  it('a plain ON superseded with nothing pending keeps its old behavior (runs again)', () => {
    const t = reduceWithWatchdog({ ...ONLINE, mode: 'ON_RUNNING' }, done(false, { interrupted: true }));
    expect(t.effects).toEqual([{ type: 'runOn' }]);
  });
});

describe('W21. gate round 2: the SequenceDone is built from completion-time gates', () => {
  function probes(over: Partial<{ stop: boolean; on: boolean; wifi: boolean | null; alive: boolean }> = {}) {
    const w = { stop: false, on: true, wifi: true as boolean | null, alive: true, ...over };
    const reads: string[] = [];
    const p: CompletionProbes = {
      stopAll: () => (reads.push('stopAll'), w.stop),
      enabled: () => (reads.push('enabled'), w.on),
      wifiUp: () => (reads.push('wifi'), w.wifi),
      shizukuAlive: () => (reads.push('ping'), w.alive),
    };
    return { p, reads };
  }
  const S = clk(E0);
  const ev = (o: Partial<{ interrupted: boolean; shizukuUp: boolean; stopped: boolean; start: LossClock | null }>) => ({
    type: 'sequenceDone',
    kind: 'on',
    interrupted: false,
    shizukuUp: false,
    stopped: false,
    start: S,
    ...o,
  });

  it.each(['stopped', 'disabled', 'superseded'] as const)('%s: nothing read, no ping', (res) => {
    const { p, reads } = probes();
    expect(sequenceDoneFor('on', res, true, S, p)).toEqual(ev({ stopped: res !== 'superseded', interrupted: res === 'superseded' }));
    expect(reads).toEqual([]);
  });

  it.each(['done', 'assist', 'failed'] as const)('a recovery that %s with every gate passing: gates in order, then the ping', (res) => {
    const { p, reads } = probes({ alive: res === 'done' });
    expect(sequenceDoneFor('on', res, true, S, p)).toEqual(ev({ shizukuUp: res === 'done' }));
    expect(reads).toEqual(['stopAll', 'enabled', 'wifi', 'ping']);
  });

  it.each([
    ['STOP-ALL raised during the last step', { stop: true }, ['stopAll']],
    ['guardian turned off', { on: false }, ['stopAll', 'enabled']],
    ['Wi-Fi dropped', { wifi: false }, ['stopAll', 'enabled', 'wifi']],
    ['Wi-Fi unknown (fail closed)', { wifi: null }, ['stopAll', 'enabled', 'wifi']],
  ] as const)('a recovery whose runner said done but %s: stopped, never pinged', (_n, over, order) => {
    const { p, reads } = probes(over);
    expect(sequenceDoneFor('on', 'done', true, S, p)).toEqual(ev({ stopped: true }));
    expect(reads).toEqual(order);
  });

  it('...and the reducer refunds it (no success); its start still anchors the cooldown (gate round 3)', () => {
    const inFlight: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 1, wdRecovering: true };
    const t = reduceWithWatchdog(inFlight, sequenceDoneFor('on', 'done', true, S, probes({ stop: true }).p));
    expect(t.state).toEqual({ ...ONLINE, wdLastAttemptElapsedMs: S.elapsedMs, wdBootId: BOOT });
    expect(types(t.effects)).not.toContain('shizukuWatchdogAudit');
  });

  it('a plain ON is never pinged (nothing reads shizukuUp for it); Wi-Fi is not read', () => {
    const { p, reads } = probes();
    expect(sequenceDoneFor('on', 'done', false, S, p)).toEqual(ev({}));
    expect(reads).toEqual(['stopAll', 'enabled']);
    const off = probes({ stop: true });
    expect(sequenceDoneFor('on', 'assist', false, S, off.p)).toEqual(ev({ stopped: true }));
    // A plain ON's outcome is the same whatever is reported.
    const running: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 2 };
    expect(reduceWithWatchdog(running, ev({ stopped: true }) as GuardianEvent)).toEqual(reduceWithWatchdog(running, ev({ shizukuUp: true }) as GuardianEvent));
  });

  it('an OFF: no gate read, no ping, no start; an aborted OFF keeps its flags', () => {
    const { p, reads } = probes();
    expect(sequenceDoneFor('off', 'done', false, S, p)).toEqual({ type: 'sequenceDone', kind: 'off', interrupted: false, shizukuUp: false, stopped: false, start: null });
    expect(sequenceDoneFor('off', 'superseded', false, S, p)).toEqual({ type: 'sequenceDone', kind: 'off', interrupted: true, shizukuUp: false, stopped: false, start: null });
    expect(reads).toEqual([]);
  });
});

describe('W22. gate round 2: the recovery intent survives a death between checkpoint and dispatch', () => {
  /** The prefs a death right after the tick's checkpoint leaves behind. */
  const restoreDead = (recovering: boolean, persisted = 'in_flight') =>
    restoreWatchdog(core.restoreState(true, persisted, 4), 1, null, null, false, 0, null, null, recovering);

  it('the checkpointed tick persists in_flight with the intent', () => {
    const t = reduceWithWatchdog(ONLINE, tick(false, E0));
    expect(core.persistableMode(t.state)).toBe('in_flight');
    expect(t.state.wdRecovering).toBe(true);
    expect(t.state.wdAttempts).toBe(1);
  });

  it('restore -> reconcile(Wi-Fi up) runs a RECOVERY, not a plain ON; its success keeps attempt 1, anchored at its start', () => {
    const s = restoreDead(true);
    expect(s).toEqual({ mode: 'IDLE_ONLINE', lossToken: 4, pending: 'ON', wdAttempts: 1, wdRecovering: true });
    const r = reduceWithWatchdog(s, { type: 'reconcile', wifiUp: true, now: clk(E0 + MIN) });
    expect(types(r.effects)).toContain('runShizukuRecovery');
    expect(types(r.effects)).not.toContain('runOn');
    expect(r.state).toEqual({ ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 1, wdRecovering: true });
    const d = reduceWithWatchdog(r.state, done(true, { start: clk(E0 + 2 * MIN) }));
    expect(d.effects).toEqual([audit(WD_RECOVERY_SUCCEEDED, 1), REARM]);
    expect(d.state).toEqual({ ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 + 2 * MIN, wdBootId: BOOT });
  });

  it('the restored recovery stopped by STOP-ALL: refunded to 0, anchored at its start', () => {
    const r = reduceWithWatchdog(restoreDead(true), { type: 'reconcile', wifiUp: true, now: clk(E0) });
    const d = reduceWithWatchdog(r.state, done(false, { stopped: true, start: clk(E0) }));
    expect(d.state).toEqual({ ...ONLINE, wdLastAttemptElapsedMs: E0, wdBootId: BOOT });
    expect(types(d.effects)).not.toContain('shizukuWatchdogAudit');
  });

  it('the substituted recovery whose checkpoint fails is refunded like any other (no plain ON)', () => {
    const r = withoutUndurableOn(reduceWithWatchdog(restoreDead(true), { type: 'reconcile', wifiUp: true, now: clk(E0) }));
    expect(r.state).toEqual(ONLINE);
    expect(types(r.effects)).toEqual(['armShizukuWatchdog']);
  });

  it('a plain owed ON (no intent) stays plain', () => {
    const r = reduceWithWatchdog(restoreDead(false), { type: 'reconcile', wifiUp: true, now: clk(E0) });
    expect(types(r.effects)).toEqual(['runOn']);
    expect(r.state.wdRecovering).toBeUndefined();
  });

  it.each(['idle_online', 'loss_pending', 'loss_pending_on', 'idle_offline'])('the intent persisted but restored mode %s (no ON owed): dropped', (m) => {
    expect(restoreDead(true, m).wdRecovering).toBeUndefined();
  });

  it('no attempt counted, or the guardian off: the intent is dropped', () => {
    expect(restoreWatchdog(core.restoreState(true, 'in_flight', 4), 0, null, null, false, 0, null, null, true).wdRecovering).toBeUndefined();
    const off = core.restoreState(false, 'in_flight', 4);
    expect(restoreWatchdog(off, 1, null, null, false, 0, null, null, true)).toBe(off);
  });

  it('a boot (new session) drops the intent with the rest of the session', () => {
    const b = reduceWithWatchdog(restoreDead(true), { type: 'boot', enabled: true, wifiUp: true, now: clk(1_000, BOOT + 1) });
    expect(types(b.effects)).toContain('runOn');
    expect(b.state.wdRecovering).toBeUndefined();
    expect(b.state.wdAttempts).toBeUndefined();
  });
});

// ── End to end: core + runner, as the executor wires them ──
describe('W23. gate round 3: a refunded recovery keeps its cooldown anchor', () => {
  it('late STOP-ALL at T: refunded to 0, anchor = T; dead at T+15min -> no recovery; dead at T+31min -> recovery', () => {
    const T = E0;
    const started = reduceWithWatchdog(ONLINE, tick(false, T));
    expect(types(started.effects)).toContain('runShizukuRecovery');
    expect(started.state.wdAttempts).toBe(1);
    // The run finished its steps; STOP-ALL rose before the completion check.
    const p: CompletionProbes = { stopAll: () => true, enabled: () => true, wifiUp: () => true, shizukuAlive: () => true };
    const ev = sequenceDoneFor('on', 'done', true, clk(T), p);
    expect(ev).toMatchObject({ stopped: true, start: clk(T) });
    const d = reduceWithWatchdog(started.state, ev);
    expect(d.state.wdAttempts).toBeUndefined();
    expect(d.state.wdRecovering).toBeUndefined();
    expect(d.state.wdLastAttemptElapsedMs).toBe(T);
    expect(d.state.wdBootId).toBe(BOOT);
    expect(types(d.effects)).not.toContain('shizukuWatchdogAudit');
    // STOP-ALL clears; the next tick (15 min later) sees Shizuku dead.
    const t15 = reduceWithWatchdog(d.state, tick(false, T + 15 * MIN));
    expect(types(t15.effects)).not.toContain('runShizukuRecovery');
    expect(t15.effects).toEqual([audit(WD_DETECTED_DEAD, 0), REARM]);
    const t31 = reduceWithWatchdog(t15.state, tick(false, T + 31 * MIN));
    expect(types(t31.effects)).toContain('runShizukuRecovery');
    expect(t31.state.wdAttempts).toBe(1);
  });

  it.each([
    ['stopped', { stopped: true }],
    ['interrupted', { interrupted: true }],
  ] as const)('%s with no start clock: the anchor is left unchanged (not cleared, not stamped)', (_n, how) => {
    const inFlight: GuardianState = { ...ONLINE, mode: 'ON_RUNNING', wdAttempts: 2, wdRecovering: true, wdLastAttemptElapsedMs: E0 - 40 * MIN, wdBootId: BOOT };
    const t = reduceWithWatchdog(inFlight, done(false, { ...how }));
    expect(t.state.wdAttempts).toBe(1);
    expect(t.state.wdLastAttemptElapsedMs).toBe(E0 - 40 * MIN);
    expect(t.state.wdBootId).toBe(BOOT);
    // ...also when the count reaches 0.
    const z = reduceWithWatchdog({ ...inFlight, wdAttempts: 1 }, done(false, { ...how }));
    expect(z.state.wdAttempts).toBeUndefined();
    expect(z.state.wdLastAttemptElapsedMs).toBe(E0 - 40 * MIN);
    expect(z.state.wdBootId).toBe(BOOT);
  });

  it('the checkpoint refund (never dispatched) keeps its old rule: back at 0, the anchor goes', () => {
    const t = withoutUndurableOn(reduceWithWatchdog({ ...ONLINE, wdLastAttemptElapsedMs: E0 - 40 * MIN, wdBootId: BOOT }, tick(false, E0)));
    expect(t.state.wdAttempts).toBeUndefined();
    expect(t.state.wdLastAttemptElapsedMs).toBeUndefined();
    expect(t.state.wdBootId).toBeUndefined();
  });
});

describe('W13. end to end: tick -> recovery -> outcome, with the executor wiring', () => {
  function harness(autoStart: boolean) {
    const d = device({ autoStart });
    d.w.shizuku = true;
    let s: GuardianState = ONLINE;
    const mem = newRunnerMemory();
    const out: Effect[] = [];
    let n = 0;
    let at = E0;
    const apply = (e: GuardianEvent) => {
      const t = reduceWithWatchdog(s, e);
      s = t.state;
      out.push(...t.effects);
      for (const eff of t.effects) {
        if (eff.type === 'runShizukuRecovery' || eff.type === 'runOn') {
          const recovery = eff.type === 'runShizukuRecovery';
          const start = clk(at);
          const res = runSequence('on', d.ports, mem, `on-${++n}`, recovery);
          // As the executor: the gates read again at completion, the ping only for a recovery.
          apply(
            sequenceDoneFor('on', res, recovery, start, {
              stopAll: () => d.w.stop,
              enabled: () => true,
              wifiUp: () => d.w.wifi,
              shizukuAlive: () => d.ports.shizukuAlive(),
            }),
          );
        }
      }
    };
    const observe = (when: number) => {
      at = when;
      apply(observeShizukuWatchdog({ stopAll: () => d.w.stop, wifiUp: () => true, shizukuAlive: () => d.ports.shizukuAlive() }, clk(when)));
    };
    return { d, apply, observe, out, state: () => s };
  }

  it('battery management kills Shizuku with Wi-Fi up: the next tick revives it through the cycle', () => {
    const h = harness(true);
    h.observe(E0);
    expect(h.out).toEqual([REARM]);
    h.d.w.shizuku = false; // killed, adb_wifi_enabled stays 1, no connectivity event
    h.observe(E0 + 15 * MIN);
    expect(h.d.w.shizuku).toBe(true);
    expect(h.out.filter((e) => e.type === 'shizukuWatchdogAudit')).toEqual([
      audit(WD_DETECTED_DEAD, 0),
      audit(WD_RECOVERY_STARTED, 1),
      audit(WD_RECOVERY_SUCCEEDED, 1),
    ]);
    // The attempt stays counted for the session (monotonic), anchored at the run's start.
    expect(h.state()).toEqual({ ...ONLINE, wdAttempts: 1, wdLastAttemptElapsedMs: E0 + 15 * MIN, wdBootId: BOOT });
  });

  it('auto-start never comes: three recoveries >= 30 min apart, one notification, then silence', () => {
    const h = harness(false);
    h.d.w.shizuku = false;
    const starts: number[] = [];
    for (let at = E0; at <= E0 + 6 * 60 * MIN; at += SHIZUKU_WATCHDOG_TICK_MS) {
      const before = h.out.length;
      h.observe(at);
      if (h.out.slice(before).some((e) => e.type === 'runShizukuRecovery')) starts.push(at);
    }
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(SHIZUKU_WATCHDOG_BACKOFF_MS);
    expect(h.out.filter((e) => e.type === 'notifyShizukuWatchdogGaveUp')).toHaveLength(1);
    expect(h.d.notes).toEqual([]); // the recovery runs themselves never notified
    // Only adb_wifi_enabled writes: the watchdog has no other lever.
    expect(new Set(h.d.calls)).toEqual(new Set(['adb:0', 'adb:1']));
  });

  it('STOP-ALL on for the whole time: nothing written, nothing counted, nothing audited', () => {
    const h = harness(true);
    h.d.w.shizuku = false;
    h.d.w.stop = true;
    for (let at = E0; at <= E0 + 3 * 60 * MIN; at += SHIZUKU_WATCHDOG_TICK_MS) h.observe(at);
    expect(h.d.calls).toEqual([]);
    // Not even a re-arm while STOP-ALL is on.
    expect(h.out).toEqual([]);
    expect(h.state()).toEqual(ONLINE);
  });
});

// ── Native wiring and Kotlin/TS lockstep (structural) ──
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const coreKt = read(`${KT}/ConnectivityGuardianCore.kt`);
const coreTs = read('lib/connectivity-guardian-core.ts');
const guardian = read(`${KT}/ConnectivityGuardian.kt`);
const receiver = read(`${KT}/ConnectivityGuardianReceiver.kt`);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

function fn(src: string, signature: string): string {
  const i = src.indexOf(signature);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

function ktConst(name: string): number {
  const m = coreKt.match(new RegExp(`const val ${name} =\\s*([^\\n]+)`));
  expect(m).not.toBeNull();
  const expr = m![1].trim().replace(/_/g, '').replace(/(\d)L\b/g, '$1');
  expect(expr).toMatch(/^[\d\s*]+$/);
  return expr.split('*').reduce((a, b) => a * Number(b.trim()), 1);
}

function ktList(name: string): string[] {
  const m = coreKt.match(new RegExp(`val ${name}: List<String> = listOf\\(([\\s\\S]*?)\\)`));
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

describe('W14 (native). lockstep and wiring', () => {
  it.each([
    'SHIZUKU_WATCHDOG_TICK_MS',
    'SHIZUKU_WATCHDOG_BACKOFF_MS',
    'SHIZUKU_WATCHDOG_MAX_ATTEMPTS',
    'SHIZUKU_WATCHDOG_HEALTHY_RESET_MS',
    'SHIZUKU_WATCHDOG_HEALTHY_GAP_MS',
    'WIFI_DEBUG_CYCLE_PAUSE_MS',
  ])(
    '%s is identical',
    (name) => {
      expect(ktConst(name)).toEqual((core as any)[name]);
    },
  );

  it.each(['SHIZUKU_WATCHDOG_EVENTS', 'SHIZUKU_WATCHDOG_AUDIT_KEYS'])('%s is identical', (name) => {
    expect(ktList(name)).toEqual([...(core as any)[name]]);
  });

  it('the event constants match the closed list in both cores', () => {
    for (const k of ['WD_DETECTED_DEAD', 'WD_RECOVERY_STARTED', 'WD_RECOVERY_SUCCEEDED', 'WD_RECOVERY_FAILED', 'WD_GAVE_UP']) {
      const m = coreKt.match(new RegExp(`const val ${k} = "([a-z_]+)"`));
      expect(m![1]).toBe((core as any)[k]);
    }
  });

  it('the watchdog policy reads the same in both cores', () => {
    for (const [kt, ts] of [
      ['if (p.stopAll()) return Event.ShizukuWatchdogTick(true, null, null, now)', "if (p.stopAll()) return { type: 'shizukuWatchdogTick', stopAll: true, wifiUp: null, alive: null, now };"],
      ['if (!settledOnline(s)) return same', 'if (!settledOnline(s)) return same;'],
      ['if (e.stopAll) return Transition(withHealthyChainBroken(s), emptyList())', 'if (e.stopAll) return { state: withHealthyChainBroken(s), effects: [] };'],
      ['if (e.wifiUp == false) return Transition(withHealthyChainBroken(s), emptyList())', 'if (e.wifiUp === false) return { state: withHealthyChainBroken(s), effects: [] };'],
      [
        'if (e.wifiUp == null || alive == null) return Transition(withHealthyChainBroken(s), listOf(rearm))',
        'if (e.wifiUp === null || e.alive === null) return { state: withHealthyChainBroken(s), effects: [rearm] };',
      ],
      ['if (alive) return Transition(healthyTick(s, e.now), listOf(rearm))', 'if (e.alive) return { state: healthyTick(s, e.now), effects: [rearm] };'],
      ['val sd = withoutHealthyWindow(s)', 'const sd = withoutHealthyWindow(s);'],
      ['if (sd.wdGaveUp) return Transition(sd, listOf(rearm))', 'if (sd.wdGaveUp === true) return { state: sd, effects: [rearm] };'],
      ['if (sd.wdAttempts >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS) {', 'if (attempts >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS) {'],
      ['if (!watchdogBackoffPassed(sd, e.now)) return Transition(sd, listOf(dead, rearm))', 'if (!watchdogBackoffPassed(sd, e.now)) return { state: sd, effects: [dead, rearm] };'],
      ['delta >= 0L && delta <= SHIZUKU_WATCHDOG_HEALTHY_GAP_MS', 'delta >= 0 && delta <= SHIZUKU_WATCHDOG_HEALTHY_GAP_MS;'],
      ['last == null -> s', 'if (last === undefined) base = s;'],
      ['s.wdHealthyAccumMs + delta >= SHIZUKU_WATCHDOG_HEALTHY_RESET_MS -> freshWatchdog(s)', 'else if (accum + delta >= SHIZUKU_WATCHDOG_HEALTHY_RESET_MS) base = freshWatchdog(s);'],
      ['wdRecovering = recovering && n > 0 && s.mode == Mode.IDLE_ONLINE && s.pending == Pending.ON,', "const owed = s.mode === 'IDLE_ONLINE' && s.pending === 'ON';"],
      ['if (s.pending == Pending.NONE && fx.any { it is Effect.RunOn }) {', "if (s.pending === 'NONE' && fx.some((x) => x.type === 'runOn')) {"],
      ['st = st.copy(mode = Mode.IDLE_ONLINE, pending = Pending.NONE)', "st = { ...st, mode: 'IDLE_ONLINE', pending: 'NONE' };"],
      ['if (st.wdRecovering) fx[fx.indexOfFirst { it is Effect.RunOn }] = Effect.RunShizukuRecovery', "if (st.wdRecovering === true) {\n      fx = fx.map((x): Effect => (x.type === 'runOn' ? { type: 'runShizukuRecovery' } : x));"],
      ['if (isAbort(result)) {', 'if (isAbort(result)) {'],
      ['if (p.stopAll() || !p.enabled() || (recovery && p.wifiUp() != true)) {', 'if (p.stopAll() || !p.enabled() || (recovery && p.wifiUp() !== true)) {'],
      ['if (!recovery) return Event.SequenceDone(kind, start = st)', "if (!recovery) return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: false, stopped: false, start: st };"],
      ['return Event.SequenceDone(kind, shizukuUp = p.shizukuAlive(), start = st)', "return { type: 'sequenceDone', kind, interrupted: false, shizukuUp: p.shizukuAlive(), stopped: false, start: st };"],
      ['e is Event.SequenceDone && e.kind == SeqKind.ON && s.mode == Mode.ON_RUNNING && s.wdRecovering', "e.type === 'sequenceDone' && e.kind === 'on' && s.mode === 'ON_RUNNING' && s.wdRecovering === true"],
      ['if (e.stopped || e.interrupted) {\n                // Cut short before it could finish: no attempt burned, nothing audited.', "if (e.stopped === true || e.interrupted === true) {\n      // Cut short before it could finish: no attempt burned, nothing audited."],
      ['st = refundedCount(st)\n                val start = e.start\n                if (start != null) st = st.copy(wdLastAttemptElapsedMs = start.elapsedMs, wdBootId = start.bootId)', 'st = refundedCount(st);\n      if (e.start != null) st = withAttemptAnchor(st, e.start);'],
      ['return if (r.wdAttempts > 0) r else r.copy(wdLastAttemptElapsedMs = null, wdBootId = null)', 'if ((r.wdAttempts ?? 0) > 0) return r;'],
      ['if (disarmsWatchdog(e, fx)) fx += Effect.CancelShizukuWatchdog', "if (disarmsWatchdog(e, fx)) fx.push({ type: 'cancelShizukuWatchdog' });"],
      ['is Event.Reconcile -> !e.wifiUp', "case 'reconcile':\n      return !e.wifiUp;"],
      ['is Event.DebounceExpired -> fx.any { it is Effect.RunOff }', "case 'debounceExpired':\n      return fx.some((x) => x.type === 'runOff');"],
      ['if (recovery && p.wifiUp() != true) {', 'if (recovery && p.wifiUp() !== true) {'],
      ['s.copy(wdAttempts = maxOf(0, s.wdAttempts - 1), wdRecovering = false)', 'const n = Math.max(0, (s.wdAttempts ?? 0) - 1);'],
      ['return dt < 0L || dt >= SHIZUKU_WATCHDOG_BACKOFF_MS', 'return dt < 0 || dt >= SHIZUKU_WATCHDOG_BACKOFF_MS;'],
      ['is Event.Enable -> s.mode == Mode.DISABLED', "case 'enable':\n      return s.mode === 'DISABLED';"],
      ['if (n >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS && !s.wdGaveUp) {', 'if (n >= SHIZUKU_WATCHDOG_MAX_ATTEMPTS && s.wdGaveUp !== true) {'],
      ['if (settledOnline(st) && !settledOnline(s)) fx += Effect.ArmShizukuWatchdog(SHIZUKU_WATCHDOG_TICK_MS)', "if (settledOnline(st) && !settledOnline(s)) fx.push({ type: 'armShizukuWatchdog', delayMs: SHIZUKU_WATCHDOG_TICK_MS });"],
      ['if (recovery && adbBefore == 1) {', 'if (recovery && adbBefore === 1) {'],
      ['p.sleep(WIFI_DEBUG_CYCLE_PAUSE_MS)', 'p.sleep(WIFI_DEBUG_CYCLE_PAUSE_MS);'],
      ['if (notified || quiet) return', 'if (this.notified || this.quiet) return;'],
    ]) {
      expect(coreKt).toContain(kt);
      expect(coreTs).toContain(ts);
    }
  });

  it('the recovery cycle is gated again before wireless debugging is written back on', () => {
    for (const [src, q] of [
      [fn(coreKt, 'fun runOnSequence('), '"'],
      [fn(coreTs, 'export function runOnSequence('), "'"],
    ] as const) {
      const cycle = src.indexOf('cycleWifiDebugOff(r)');
      const regate = src.indexOf(`r.gated(${q}wifi_debug${q})`, cycle);
      const enable = src.indexOf('p.writeAdbWifi(1)');
      expect(cycle).toBeGreaterThan(-1);
      expect(regate).toBeGreaterThan(cycle);
      expect(enable).toBeGreaterThan(regate);
    }
  });

  it('gate round 4: both cores re-probe Wi-Fi after the cycle and immediately before the enable write', () => {
    for (const [src, reprobe, audit] of [
      [fn(coreKt, 'fun runOnSequence('), 'if (recovery && p.wifiUp() != true) {', 'r.audit("wifi_debug", "enable", adbLevel(adbBefore), adbLevel(adbBefore), "superseded")'],
      [fn(coreTs, 'export function runOnSequence('), 'if (recovery && p.wifiUp() !== true) {', "r.audit('wifi_debug', 'enable', adbLevel(adbBefore), adbLevel(adbBefore), 'superseded');"],
    ] as const) {
      const first = src.indexOf(reprobe);
      const cycle = src.indexOf('cycleWifiDebugOff(r)');
      const second = src.indexOf(reprobe, first + 1);
      const enable = src.indexOf('p.writeAdbWifi(1)');
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(cycle);
      expect(second).toBeGreaterThan(cycle);
      expect(second).toBeGreaterThan(src.indexOf('p.hasWriteSecureSettings()'));
      expect(enable).toBeGreaterThan(second);
      // Nothing but the superseded exit sits between the re-probe and the write.
      const between = src.slice(second, enable);
      expect(between).toContain(audit);
      expect(between).not.toMatch(/sleep\(|pollUntil\(|readAdbWifi\(/);
    }
  });

  it('the executor runs the core layer, persists the session in the same commit, and reports the liveness read', () => {
    const ev = fn(guardian, 'fun onEvent(');
    expect(ev).toContain('ConnectivityGuardianCore.reduceWithWatchdog(before, event)');
    for (const k of ['KEY_WD_ATTEMPTS', 'KEY_WD_GAVE_UP', 'KEY_WD_LAST_ELAPSED', 'KEY_WD_BOOT', 'KEY_WD_RECOVERING', 'KEY_WD_HEALTHY_ACCUM']) {
      expect(ev.indexOf(k)).toBeGreaterThan(-1);
      expect(ev.indexOf(k)).toBeLessThan(ev.indexOf('edit.commit()'));
    }
    expect(ev).toContain('is Effect.RunShizukuRecovery -> { queued = SeqKind.ON; queuedRecovery = true; startRunner(context, allowAlarmHop = true) }');
    expect(ev).toContain('is Effect.ArmShizukuWatchdog -> armShizukuWatchdog(context, effect.delayMs)');
    expect(ev).toContain('is Effect.NotifyShizukuWatchdogGaveUp -> notifyAssist(context, "shizuku_watchdog_gave_up")');
    expect(ev).toContain('is Effect.ShizukuWatchdogAudit -> auditShizukuWatchdog(context, effect.event, effect.attempt)');
    const restoreSrc = () => fn(guardian, 'private fun currentState(');
    const restore = restoreSrc();
    expect(restore).toContain('ConnectivityGuardianCore.restoreWatchdog(');
    for (const k of ['KEY_WD_HEALTHY_LAST', 'KEY_WD_HEALTHY_BOOT']) {
      expect(ev.indexOf(k)).toBeGreaterThan(-1);
      expect(ev.indexOf(k)).toBeLessThan(ev.indexOf('edit.commit()'));
      expect(restoreSrc()).toContain(`prefs.contains(${k})`);
    }
    // Gate round 2: observed-healthy accumulation and the durable recovery intent.
    expect(guardian).toContain('private const val KEY_WD_HEALTHY_ACCUM = "wdHealthyAccumMs"');
    expect(guardian).toContain('private const val KEY_WD_HEALTHY_LAST = "wdHealthyLastElapsedMs"');
    expect(guardian).toContain('private const val KEY_WD_HEALTHY_BOOT = "wdHealthyBootId"');
    expect(guardian).toContain('private const val KEY_WD_RECOVERING = "wdRecovering"');
    expect(guardian).not.toContain('wdHealthySinceElapsedMs');
    expect(ev).toContain('.putBoolean(KEY_WD_RECOVERING, reduced.state.wdRecovering)');
    expect(ev).toContain('.putLong(KEY_WD_HEALTHY_ACCUM, reduced.state.wdHealthyAccumMs)');
    expect(restore).toContain('prefs.getLong(KEY_WD_HEALTHY_ACCUM, 0L),');
    expect(restore).toContain('prefs.getBoolean(KEY_WD_RECOVERING, false),');
    expect(ev).toContain('is Effect.CancelShizukuWatchdog -> cancelShizukuWatchdog(context)');
    const drain = fn(guardian, 'fun drain(');
    // Gate round 2: the SequenceDone is built by the core from completion-time
    // gates (fresh reads through the guardian's own probes), not from the
    // return code; the drain itself never pings. The start clock is taken before the runner.
    expect(drain).toContain('val done = ConnectivityGuardianCore.sequenceDoneFor(kind, result, recovery, start, AndroidWatchdogProbes(app))');
    expect(drain).toContain('onEvent(app, done)');
    expect(drain.indexOf('sequenceDoneFor(')).toBeGreaterThan(drain.indexOf('ConnectivityGuardianCore.runSequence('));
    expect(code(drain)).not.toMatch(/ShizukuLiveness|Event\.SequenceDone\(/);
    expect(drain.indexOf('val start = lossClock(app)')).toBeGreaterThan(-1);
    expect(drain.indexOf('val start = lossClock(app)')).toBeLessThan(drain.indexOf('ConnectivityGuardianCore.runSequence('));
    const probes = fn(guardian, 'private class AndroidWatchdogProbes(');
    expect(probes).toContain(': ConnectivityGuardianCore.CompletionProbes {');
    expect(probes).toContain('override fun enabled(): Boolean = ConnectivityGuardianStore.isOn(app)');
    expect(probes).toContain('override fun shizukuAlive(): Boolean = ShizukuLiveness.isAlive()');
    // Read order in the core: STOP-ALL, toggle, Wi-Fi (recovery only), then the ping (recovery only).
    const sd = fn(coreKt, 'fun sequenceDoneFor(');
    expect(sd.indexOf('p.stopAll()')).toBeLessThan(sd.indexOf('p.enabled()'));
    expect(sd.indexOf('p.enabled()')).toBeLessThan(sd.indexOf('p.wifiUp()'));
    expect(sd.indexOf('p.wifiUp()')).toBeLessThan(sd.indexOf('p.shizukuAlive()'));
    expect(sd.indexOf('if (!recovery) return')).toBeLessThan(sd.indexOf('p.shizukuAlive()'));
    // The recovery's Wi-Fi re-probe is the guardian's own probe.
    expect(guardian).toContain('override fun wifiUp(): Boolean? = ConnectivityGuardian.isWifiUp(app)');
    expect(code(guardian).match(/override fun wifiUp\(\): Boolean\? = ConnectivityGuardian\.isWifiUp\(app\)/g)).toHaveLength(2);
    const audit = fn(guardian, 'private fun auditShizukuWatchdog(');
    expect(audit).toContain('ConnectivityGuardianCore.buildShizukuWatchdogAuditLine(');
    expect(audit).toContain('IngressAuditWriter.append(context, null, ConnectivityGuardianCore.AUDIT_FILE, line)');
  });

  it('observations: STOP-ALL is the guardian\'s own probe; checks run at the tick, every reconcile and Wi-Fi available', () => {
    expect(guardian).toContain('override fun stopAll(): Boolean = ClosePawHandoff.isStopAllOn(app)');
    expect(code(guardian).match(/override fun stopAll\(\): Boolean = ClosePawHandoff\.isStopAllOn\(app\)/g)).toHaveLength(2);
    const check = fn(guardian, 'fun shizukuWatchdogCheck(');
    expect(check.indexOf('if (!ConnectivityGuardianStore.isOn(app)) return')).toBeLessThan(check.indexOf('observeShizukuWatchdog'));
    expect(fn(guardian, 'fun reconcile(')).toContain('shizukuWatchdogCheck(app)');
    const internal = fn(guardian, 'fun onInternalBroadcast(');
    expect(internal.slice(internal.indexOf('ACTION_WIFI_AVAILABLE ->'), internal.indexOf('ACTION_DEBOUNCE ->'))).toContain('shizukuWatchdogCheck(app)');
    const tickBranch = internal.slice(internal.indexOf('ACTION_SHIZUKU_WATCHDOG ->'));
    expect(tickBranch).toContain('shizukuWatchdogCheck(app)');
    expect(tickBranch).toContain('ensureResident(app, exemptNow = false)');
    // Toggle OFF before the when(): a stale tick cleans up and does nothing.
    expect(internal.indexOf('if (!ConnectivityGuardianStore.isOn(app))')).toBeLessThan(internal.indexOf('ACTION_SHIZUKU_WATCHDOG ->'));
  });

  it('the tick alarm uses the debounce mechanism (exact when allowed, monotonic) and is cancelled with the rest', () => {
    const arm = fn(guardian, 'private fun armShizukuWatchdog(');
    expect(arm).toContain('if (canExact(am)) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)');
    expect(arm).toContain('else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)');
    expect(arm).toContain('SystemClock.elapsedRealtime() + delayMs');
    expect(fn(guardian, 'private fun unregisterAll(')).toContain('cancelShizukuWatchdog(app)');
    expect(guardian).toContain('private const val RC_SHIZUKU_WATCHDOG = 0x5747A005');
    const ev = fn(receiver, 'class ConnectivityGuardianEventReceiver');
    expect(ev).toContain('ConnectivityGuardian.ACTION_SHIZUKU_WATCHDOG -> Unit');
  });

  it('the give-up message is in the notification mapping', () => {
    expect(fn(guardian, 'fun assistText(')).toMatch(/"shizuku_watchdog_gave_up" -> "Shizuku stopped while Wi-Fi stayed connected/);
  });

  it('the watchdog never starts Shizuku: no intent, activity, package launch or shell command for it', () => {
    for (const src of [guardian, coreKt]) {
      const c = code(src);
      expect(c).not.toMatch(/moe\.shizuku|startActivity|startService\(.*[Ss]hizuku|Runtime\.getRuntime|ProcessBuilder|getLaunchIntentForPackage\("moe/);
    }
    // The only Shizuku API anywhere in the guardian remains pingBinder (through ShizukuLiveness).
    expect((code(guardian).match(/\bShizuku\.[a-zA-Z]+/g) ?? [])).toEqual([]);
    expect(code(guardian)).toContain('ShizukuLiveness.isAlive()');
  });
});
