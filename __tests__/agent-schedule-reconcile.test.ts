jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  CATCH_UP_WINDOW_CAP_MS,
  CATCH_UP_WINDOW_FLOOR_MS,
  CHAIN_LOCK_STALE_MS,
  CLAIM_ABANDON_MS,
  RECONCILE_GRACE_FOLLOW_UP_MS,
  RECONCILE_GRACE_MS,
  RECONCILE_WATCHDOG_PERIOD_MS,
  ReconcileInputs,
  catchUpWindowMs,
  decideReconcile,
  isChainLockLive,
  occurrenceClaimState,
  parseChainLockAcquiredAt,
} from '@/lib/agent-schedule-reconcile';
import {
  MISSED_RUN_GRACE_MS,
  cronToIntervalMs,
  isScheduleMissed,
  lastTriggerMs,
} from '@/lib/agent-scheduler';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const withTerminalService = require('../plugins/with-terminal-service.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/';

// ── catchUpWindowMs ─────────────────────────────────────────────────────────
describe('catchUpWindowMs', () => {
  it('daily (24h) -> 2h cap', () => expect(catchUpWindowMs(DAY)).toBe(2 * HOUR));
  it('hourly -> 1h', () => expect(catchUpWindowMs(HOUR)).toBe(HOUR));
  it('*/5 min -> 10 min floor', () => expect(catchUpWindowMs(5 * MIN)).toBe(10 * MIN));
  it('*/30 min -> 30 min', () => expect(catchUpWindowMs(30 * MIN)).toBe(30 * MIN));
  it('0 / null / undefined -> 2h', () => {
    expect(catchUpWindowMs(0)).toBe(2 * HOUR);
    expect(catchUpWindowMs(null)).toBe(2 * HOUR);
    expect(catchUpWindowMs(undefined)).toBe(2 * HOUR);
  });
});

// ── decideReconcile decision table ──────────────────────────────────────────
describe('decideReconcile', () => {
  const NOW = 1_800_000_000_000;
  const base = (over: Partial<ReconcileInputs> = {}): ReconcileInputs => ({
    nowMs: NOW,
    halted: false,
    enabled: 'enabled',
    running: false,
    occurrenceMs: NOW - HOUR, // daily, 1h late
    previousOccurrenceMs: NOW - HOUR - DAY,
    lastRunAt: NOW - DAY - HOUR, // ran the previous day
    createdAt: NOW - 30 * DAY,
    startNotBefore: null,
    intervalMs: DAY,
    claimedForMs: null,
    claimedAtMs: null,
    startedForMs: null,
    settledForMs: null,
    deferredForMs: null,
    ...over,
  });

  it('sanity: the base is a late-run', () => {
    expect(decideReconcile(base()).action).toBe('late-run');
  });

  // Codex review round 1 (blocking findings), each pinned here and in
  // AgentScheduleReconcileCoreTest.kt.
  it('an every-5-min schedule whose chain died is re-armed, not left waiting in the grace forever', () => {
    // */5: the latest occurrence is always inside the 5-min grace.
    const d = decideReconcile(base({
      occurrenceMs: NOW - 2 * MIN,
      previousOccurrenceMs: NOW - 7 * MIN,
      lastRunAt: NOW - 3 * HOUR,
      intervalMs: 5 * MIN,
    }));
    expect(d.action).toBe('rearm');
  });

  it('inside the grace with the previous occurrence accounted for: still wait-grace (a deferred alarm may be pending)', () => {
    const d = decideReconcile(base({
      occurrenceMs: NOW - 2 * MIN,
      previousOccurrenceMs: NOW - 2 * MIN - DAY,
      lastRunAt: NOW - 2 * MIN - DAY + 20 * MIN,
    }));
    expect(d.action).toBe('wait-grace');
  });

  it('an occurrence before startNotBefore is never run late (start already passed)', () => {
    // daily 07:00, startNotBefore 07:30, now 08:00.
    const d = decideReconcile(base({ occurrenceMs: NOW - HOUR, startNotBefore: NOW - 30 * MIN, lastRunAt: null, createdAt: NOW - DAY }));
    expect(d.action).toBe('rearm');
  });

  it('an occurrence at/after startNotBefore is still caught up', () => {
    const d = decideReconcile(base({ occurrenceMs: NOW - HOUR, startNotBefore: NOW - HOUR, lastRunAt: null, createdAt: NOW - DAY }));
    expect(d.action).toBe('late-run');
  });

  it('halted -> skip-halted even if otherwise due', () => {
    expect(decideReconcile(base({ halted: true })).action).toBe('skip-halted');
  });
  it('disabled -> skip-disabled', () => {
    expect(decideReconcile(base({ enabled: 'disabled' })).action).toBe('skip-disabled');
  });
  it('unknown -> skip-unknown', () => {
    expect(decideReconcile(base({ enabled: 'unknown' })).action).toBe('skip-unknown');
  });
  it('running -> skip-running', () => {
    expect(decideReconcile(base({ running: true })).action).toBe('skip-running');
  });
  it('no occurrence -> rearm with expectedAt null', () => {
    const d = decideReconcile(base({ occurrenceMs: null }));
    expect(d.action).toBe('rearm');
    expect(d.expectedAt).toBeNull();
  });
  it('startNotBefore in the future -> rearm', () => {
    expect(decideReconcile(base({ startNotBefore: NOW + DAY })).action).toBe('rearm');
  });
  it('no lastRunAt and no createdAt -> rearm (never fabricate a late run)', () => {
    expect(decideReconcile(base({ lastRunAt: null, createdAt: null })).action).toBe('rearm');
  });
  it('ran at/after the occurrence -> rearm', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: occ })).action).toBe('rearm');
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: occ + 1000 })).action).toBe('rearm');
  });
  it('ran within grace before the occurrence -> rearm', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: occ - 2 * MIN })).action).toBe('rearm');
    // exactly at the grace edge (at <= lastActual + grace) is still "ran"
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: occ - RECONCILE_GRACE_MS })).action).toBe('rearm');
    // 1ms beyond the edge is due
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: occ - RECONCILE_GRACE_MS - 1 })).action).toBe('late-run');
  });
  it('createdAt is the fallback when never run', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: null, createdAt: occ + 1 })).action).toBe('rearm');
    expect(decideReconcile(base({ occurrenceMs: occ, lastRunAt: null, createdAt: occ - DAY })).action).toBe('late-run');
  });
  it('occurrence inside grace with no run -> wait-grace', () => {
    const occ = NOW - 2 * MIN;
    const d = decideReconcile(base({ occurrenceMs: occ }));
    expect(d.action).toBe('wait-grace');
    expect(d.expectedAt).toBe(occ);
  });
  it('grace boundary: now-occ == grace is wait-grace, grace+1ms is late-run', () => {
    expect(decideReconcile(base({ occurrenceMs: NOW - RECONCILE_GRACE_MS })).action).toBe('wait-grace');
    expect(decideReconcile(base({ occurrenceMs: NOW - RECONCILE_GRACE_MS - 1 })).action).toBe('late-run');
  });
  it('daily, 1h late -> late-run with expectedAt = occurrence', () => {
    const occ = NOW - HOUR;
    const d = decideReconcile(base({ occurrenceMs: occ }));
    expect(d.action).toBe('late-run');
    expect(d.expectedAt).toBe(occ);
    expect(d.windowMs).toBe(2 * HOUR);
  });
  it('boundary exactly at the window -> late-run; window+1ms -> missed', () => {
    const w = 2 * HOUR;
    expect(decideReconcile(base({ occurrenceMs: NOW - w })).action).toBe('late-run');
    expect(decideReconcile(base({ occurrenceMs: NOW - w - 1 })).action).toBe('missed');
  });
  it('daily, 3h late -> missed', () => {
    expect(decideReconcile(base({ occurrenceMs: NOW - 3 * HOUR })).action).toBe('missed');
  });
  it('hourly cron 61 min late -> missed (window 1h)', () => {
    const d = decideReconcile(base({ intervalMs: HOUR, occurrenceMs: NOW - 61 * MIN, lastRunAt: NOW - 3 * HOUR }));
    expect(d.action).toBe('missed');
    expect(d.windowMs).toBe(HOUR);
  });
  // ── claim lifecycle (Codex gate F3) ──
  it('reserved then started -> rearm, never re-run (inside the window)', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - 50 * MIN, startedForMs: occ })).action).toBe('rearm');
  });
  it('started occurrence past the window -> rearm (it ran; not recorded as missed)', () => {
    const occ = NOW - 3 * HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - 170 * MIN, startedForMs: occ })).action).toBe('rearm');
  });
  it('started mark for an OLDER occurrence does not cover this one -> late-run', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ - DAY, claimedAtMs: NOW - DAY, startedForMs: occ - DAY })).action).toBe('late-run');
  });
  it('fresh reservation, not started, inside the window -> wait-claim (dispatch in flight)', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - MIN })).action).toBe('wait-claim');
  });
  it('reserved and abandoned inside the window -> late-run (re-dispatch)', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - CLAIM_ABANDON_MS })).action).toBe('late-run');
  });
  it('abandon boundary: CLAIM_ABANDON_MS - 1 is still reserved', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - CLAIM_ABANDON_MS + 1 })).action).toBe('wait-claim');
  });
  it('reserved and abandoned past the window -> missed', () => {
    const occ = NOW - 3 * HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - 2 * HOUR })).action).toBe('missed');
  });
  it('a fresh reservation past the window is missed too (never run that late)', () => {
    const occ = NOW - 3 * HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - MIN })).action).toBe('missed');
  });
  it('claim exists + run log exists -> rearm (done)', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: NOW - 50 * MIN, lastRunAt: occ + 2 * MIN })).action).toBe('rearm');
  });
  it('a pre-lifecycle claim (no timestamp) counts as started -> rearm', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ, claimedAtMs: null })).action).toBe('rearm');
  });
  it('a claim for an older occurrence does not block this one -> late-run', () => {
    const occ = NOW - HOUR;
    expect(decideReconcile(base({ occurrenceMs: occ, claimedForMs: occ - DAY, claimedAtMs: NOW - MIN })).action).toBe('late-run');
  });
  it('custom graceMs is honoured', () => {
    expect(decideReconcile(base({ occurrenceMs: NOW - 2 * MIN, graceMs: MIN })).action).toBe('late-run');
  });
});

// Gate fix round 2 (re-gate R1): a dispatch that reached AgentRuntime and was
// refused before launch SETTLES its occurrence; "previous run still active"
// DEFERS it; a dispatch with no runtime outcome stays abandoned.
describe('pre-launch refusals (re-gate R1)', () => {
  const MIN_ = 60_000;
  const OCC = 1_800_000_000_000;
  // The re-gate's exact reproduction: reserved 07:00, refused pre-launch at
  // 07:00:01 (receiver log), reconciled at 07:06.
  const regate = (over: Partial<ReconcileInputs> = {}): ReconcileInputs => ({
    nowMs: OCC + 6 * MIN_, halted: false, enabled: 'enabled', running: false,
    occurrenceMs: OCC, previousOccurrenceMs: OCC - 86_400_000, lastRunAt: OCC + 1000,
    createdAt: OCC - 86_400_000, startNotBefore: null, intervalMs: 86_400_000,
    claimedForMs: OCC, claimedAtMs: OCC, startedForMs: null, settledForMs: null, deferredForMs: null,
    ...over,
  });

  it('re-gate repro: abandoned claim + a settled refusal (its log) ⇒ rearm, the occurrence is settled', () => {
    const i = regate({ settledForMs: OCC });
    expect(occurrenceClaimState(OCC, OCC, OCC, null, OCC, null, i.nowMs)).toBe('settled');
    expect(decideReconcile(i)).toEqual({ action: 'rearm', expectedAt: OCC, windowMs: 2 * 60 * MIN_ });
  });
  it('settled holds even when the refusal log is missing (log write failed) — never re-dispatched, inside or past the window', () => {
    expect(decideReconcile(regate({ settledForMs: OCC, lastRunAt: null })).action).toBe('rearm');
    expect(decideReconcile(regate({ settledForMs: OCC, lastRunAt: null, nowMs: OCC + 3 * 60 * MIN_ })).action).toBe('rearm');
  });
  it('abandoned claim + no runtime outcome (no log, no mark) ⇒ late-run (re-dispatched inside the window)', () => {
    const i = regate({ lastRunAt: null });
    expect(occurrenceClaimState(OCC, OCC, OCC, null, null, null, i.nowMs)).toBe('abandoned');
    expect(decideReconcile(i).action).toBe('late-run');
    expect(decideReconcile(regate({ lastRunAt: null, nowMs: OCC + 3 * 60 * MIN_ })).action).toBe('missed');
  });
  it('still-active refusal ⇒ the occurrence stays recoverable: its own refusal log does not count', () => {
    const i = regate({ deferredForMs: OCC });
    expect(occurrenceClaimState(OCC, OCC, OCC, null, null, OCC, i.nowMs)).toBe('deferred');
    expect(decideReconcile(i).action).toBe('late-run');
  });
  it('still-active refusal: while that run is live ⇒ skip-running; once it ends (its own end log after the occurrence) ⇒ late-run', () => {
    expect(decideReconcile(regate({ deferredForMs: OCC, running: true })).action).toBe('skip-running');
    expect(decideReconcile(regate({ deferredForMs: OCC, nowMs: OCC + 50 * MIN_, lastRunAt: OCC + 45 * MIN_ })).action).toBe('late-run');
  });
  it('still-active refusal is bounded by the window like any other occurrence', () => {
    expect(decideReconcile(regate({ deferredForMs: OCC, nowMs: OCC + 2 * 60 * MIN_ + 1, lastRunAt: OCC + 90 * MIN_ })).action).toBe('missed');
  });
  it('a deferred occurrence re-reserved by its late run waits for that dispatch (the mark stays; its refusal log is still not evidence)', () => {
    expect(decideReconcile(regate({ claimedAtMs: OCC + 5 * MIN_, deferredForMs: OCC, lastRunAt: OCC + 1000 })).action).toBe('wait-claim');
  });
  it('Codex round-1 repro: deferred at T (log T+1s), retry reserved at T+10min, process dies; at T+20min it is re-dispatched, not dropped', () => {
    const i = regate({ nowMs: OCC + 20 * MIN_, claimedAtMs: OCC + 10 * MIN_, deferredForMs: OCC, lastRunAt: OCC + 1000 });
    expect(occurrenceClaimState(OCC, OCC, OCC + 10 * MIN_, null, null, OCC, i.nowMs)).toBe('deferred');
    expect(decideReconcile(i).action).toBe('late-run');
  });
  it('a started occurrence never re-runs, whatever was logged (unchanged)', () => {
    expect(decideReconcile(regate({ startedForMs: OCC, lastRunAt: null })).action).toBe('rearm');
    expect(decideReconcile(regate({ startedForMs: OCC, deferredForMs: OCC })).action).toBe('rearm');
  });
});

describe('occurrenceClaimState', () => {
  const NOW = 1_800_000_000_000;
  const OCC = NOW - HOUR;
  it('none without a claim, or with a claim for another occurrence', () => {
    expect(occurrenceClaimState(OCC, null, null, null, null, null, NOW)).toBe('none');
    expect(occurrenceClaimState(OCC, OCC - DAY, NOW - MIN, null, null, null, NOW)).toBe('none');
  });
  it('started wins over everything (even an older claim record)', () => {
    expect(occurrenceClaimState(OCC, OCC, NOW - MIN, OCC, null, null, NOW)).toBe('started');
    expect(occurrenceClaimState(OCC, null, null, OCC, null, null, NOW)).toBe('started');
  });
  it('reserved below the abandonment bound, abandoned at it', () => {
    expect(occurrenceClaimState(OCC, OCC, NOW - CLAIM_ABANDON_MS + 1, null, null, null, NOW)).toBe('reserved');
    expect(occurrenceClaimState(OCC, OCC, NOW - CLAIM_ABANDON_MS, null, null, null, NOW)).toBe('abandoned');
  });
  it('a claim timestamp far in the future (clock moved back) is abandoned, not held forever', () => {
    expect(occurrenceClaimState(OCC, OCC, NOW + HOUR, null, null, null, NOW)).toBe('abandoned');
  });
  it('settled wins over a claim (it never runs again); a settled mark of another occurrence is irrelevant', () => {
    expect(occurrenceClaimState(OCC, OCC, NOW - MIN, null, OCC, null, NOW)).toBe('settled');
    expect(occurrenceClaimState(OCC, OCC, NOW - HOUR, null, OCC, null, NOW)).toBe('settled');
    expect(occurrenceClaimState(OCC, OCC, NOW - HOUR, null, OCC - DAY, null, NOW)).toBe('abandoned');
    expect(occurrenceClaimState(OCC, OCC, NOW - HOUR, OCC, OCC, null, NOW)).toBe('started');
  });
  it('deferred needs the claim of the same occurrence; a fresh (re-)reservation of it reads as reserved', () => {
    expect(occurrenceClaimState(OCC, OCC, NOW - CLAIM_ABANDON_MS, null, null, OCC, NOW)).toBe('deferred');
    expect(occurrenceClaimState(OCC, OCC, NOW - MIN, null, null, OCC, NOW)).toBe('reserved');
    expect(occurrenceClaimState(OCC, OCC, null, null, null, OCC, NOW)).toBe('deferred');
    expect(occurrenceClaimState(OCC, OCC - DAY, NOW - DAY, null, null, OCC - DAY, NOW)).toBe('none');
    expect(occurrenceClaimState(OCC, OCC, NOW - MIN, null, OCC, OCC, NOW)).toBe('settled');
  });
  it('the abandonment bound is recoverable inside the smallest window', () => {
    expect(CLAIM_ABANDON_MS).toBeLessThan(CATCH_UP_WINDOW_FLOOR_MS - RECONCILE_GRACE_MS);
  });
});

describe('chain lock staleness (Codex gate F2)', () => {
  const NOW = 1_800_000_000_000;
  const nowSec = Math.floor(NOW / 1000);
  it('is the acquireChainLock steal age (2 h)', () => {
    expect(CHAIN_LOCK_STALE_MS).toBe(2 * HOUR);
    const mgr = read('lib/agent-manager.ts');
    // acquireChainLock and the executor-route check derive staleSec from the
    // same import; no second definition.
    expect(mgr).not.toMatch(/const CHAIN_LOCK_STALE_MS\s*=/);
    expect(mgr).toMatch(/import \{[^}]*CHAIN_LOCK_STALE_MS[^}]*\} from '\.\/agent-schedule-reconcile'/);
    const acquire = mgr.slice(mgr.indexOf('export async function acquireChainLock'));
    expect(acquire.slice(0, 600)).toContain('Math.floor(CHAIN_LOCK_STALE_MS / 1000)');
  });
  it('live below the steal age, stale at it (same >= as the acquire side)', () => {
    const staleSec = CHAIN_LOCK_STALE_MS / 1000;
    expect(isChainLockLive(nowSec - staleSec + 1, NOW)).toBe(true);
    expect(isChainLockLive(nowSec - staleSec, NOW)).toBe(false);
    expect(isChainLockLive(nowSec, NOW)).toBe(true);
  });
  it('acquired-at parsing mirrors the shell (digits only, else 0 = stale)', () => {
    expect(parseChainLockAcquiredAt(`${nowSec}\n`)).toBe(nowSec);
    for (const bad of [null, undefined, '', '  ', '-5', '12a', 'abc']) {
      expect(parseChainLockAcquiredAt(bad as string | null | undefined)).toBe(0);
      expect(isChainLockLive(parseChainLockAcquiredAt(bad as string | null | undefined), NOW)).toBe(false);
    }
  });
});

// ── parity with isScheduleMissed ────────────────────────────────────────────
describe('decideReconcile parity with isScheduleMissed', () => {
  it('RECONCILE_GRACE_MS === MISSED_RUN_GRACE_MS', () => {
    expect(RECONCILE_GRACE_MS).toBe(MISSED_RUN_GRACE_MS);
  });

  const crons = ['0 7 * * *', '0 */2 * * *', '30 8,21 * * *', '0 9 * * 1,5', '*/15 * * * *'];
  const nows = [
    new Date(2026, 10, 16, 7, 0, 0).getTime(),
    new Date(2026, 10, 16, 7, 3, 0).getTime(),
    new Date(2026, 10, 16, 7, 6, 0).getTime(),
    new Date(2026, 10, 16, 8, 30, 0).getTime(),
    new Date(2026, 10, 16, 9, 10, 0).getTime(),
    new Date(2026, 10, 16, 12, 0, 0).getTime(),
    new Date(2026, 10, 17, 3, 17, 0).getTime(),
    new Date(2026, 10, 18, 22, 45, 30).getTime(),
  ];
  const createdAt = new Date(2026, 10, 1, 0, 0, 0).getTime();

  it('late-run|missed iff isScheduleMissed.missed, over a grid', () => {
    let checked = 0;
    for (const cron of crons) {
      const intervalMs = cronToIntervalMs(cron);
      for (const now of nows) {
        const occ = lastTriggerMs(cron, now);
        const lastRuns: Array<number | null> = [
          null,
          occ != null ? occ - 3 * DAY : now - 3 * DAY,
          occ != null ? occ - 2 * MIN : now - 2 * MIN,
          occ != null ? occ : now,
          occ != null ? occ + 10 * MIN : now,
          now,
          createdAt - 1,
        ];
        for (const lastRunAt of lastRuns) {
          const missed = isScheduleMissed(cron, lastRunAt, createdAt, now).missed;
          const action = decideReconcile({
            nowMs: now,
            halted: false,
            enabled: 'enabled',
            running: false,
            claimedForMs: null,
            claimedAtMs: null,
            startedForMs: null,
            occurrenceMs: occ,
            previousOccurrenceMs: occ == null ? null : lastTriggerMs(cron, occ - 1),
            intervalMs,
            lastRunAt,
            createdAt,
            startNotBefore: null,
            settledForMs: null,
            deferredForMs: null,
          }).action;
          const due = action === 'late-run' || action === 'missed';
          if (due !== missed) {
            throw new Error(`parity break cron=${cron} now=${new Date(now).toString()} lastRunAt=${lastRunAt} action=${action} missed=${missed}`);
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(crons.length * nows.length * 7);
  });
});

// ── lastTriggerMs contract vectors ──────────────────────────────────────────
describe('lastTriggerMs vectors (local time)', () => {
  const L = (y: number, m1: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
    new Date(y, m1 - 1, d, h, mi, s, ms).getTime();

  describe('daily "0 7 * * *"', () => {
    const c = '0 7 * * *';
    it('06:59 -> yesterday 07:00', () => expect(lastTriggerMs(c, L(2026, 11, 17, 6, 59))).toBe(L(2026, 11, 16, 7)));
    it('exactly 07:00:00.000 -> today 07:00 (boundary counts)', () =>
      expect(lastTriggerMs(c, L(2026, 11, 17, 7, 0, 0, 0))).toBe(L(2026, 11, 17, 7)));
    it('07:00:01 -> today 07:00', () => expect(lastTriggerMs(c, L(2026, 11, 17, 7, 0, 1))).toBe(L(2026, 11, 17, 7)));
    it('month edge: 2026-03-01 06:00 -> 2026-02-28 07:00', () =>
      expect(lastTriggerMs(c, L(2026, 3, 1, 6))).toBe(L(2026, 2, 28, 7)));
    it('year edge: 2027-01-01 06:00 -> 2026-12-31 07:00', () =>
      expect(lastTriggerMs(c, L(2027, 1, 1, 6))).toBe(L(2026, 12, 31, 7)));
    it('leap year: 2028-03-01 06:00 -> 2028-02-29 07:00', () =>
      expect(lastTriggerMs(c, L(2028, 3, 1, 6))).toBe(L(2028, 2, 29, 7)));
  });

  describe('weekly', () => {
    // 2026-11-16 is a Monday; 2026-11-15 Sunday; 2027-01-01 Friday.
    it('Mon cron on Monday 08:00 -> previous Monday 09:00', () =>
      expect(lastTriggerMs('0 9 * * 1', L(2026, 11, 16, 8))).toBe(L(2026, 11, 9, 9)));
    it('Mon cron on Monday 09:00 exactly -> that Monday', () =>
      expect(lastTriggerMs('0 9 * * 1', L(2026, 11, 16, 9))).toBe(L(2026, 11, 16, 9)));
    it('Mon cron on Wednesday -> that week Monday', () =>
      expect(lastTriggerMs('0 9 * * 1', L(2026, 11, 18, 12))).toBe(L(2026, 11, 16, 9)));
    it('CSV 1,5 on Wednesday -> Monday', () =>
      expect(lastTriggerMs('0 9 * * 1,5', L(2026, 11, 18, 12))).toBe(L(2026, 11, 16, 9)));
    it('CSV 1,5 on Saturday -> Friday', () =>
      expect(lastTriggerMs('0 9 * * 1,5', L(2026, 11, 14, 12))).toBe(L(2026, 11, 13, 9)));
    it('CSV 1,5 on Monday 08:00 -> previous Friday', () =>
      expect(lastTriggerMs('0 9 * * 1,5', L(2026, 11, 16, 8))).toBe(L(2026, 11, 13, 9)));
    it('dow 0 and dow 7 both mean Sunday', () => {
      const now = L(2026, 11, 17, 12); // Tuesday
      expect(lastTriggerMs('0 9 * * 0', now)).toBe(L(2026, 11, 15, 9));
      expect(lastTriggerMs('0 9 * * 7', now)).toBe(L(2026, 11, 15, 9));
    });
    it('year crossing: Monday cron on Fri 2027-01-01 -> 2026-12-28', () =>
      expect(lastTriggerMs('0 9 * * 1', L(2027, 1, 1, 12))).toBe(L(2026, 12, 28, 9)));
  });

  describe('every-N-hour "0 */N * * *"', () => {
    it('*/3 at 10:30 -> 09:00', () => expect(lastTriggerMs('0 */3 * * *', L(2026, 11, 17, 10, 30))).toBe(L(2026, 11, 17, 9)));
    it('*/3 at 00:10 -> 00:00', () => expect(lastTriggerMs('0 */3 * * *', L(2026, 11, 17, 0, 10))).toBe(L(2026, 11, 17, 0)));
    it('*/3 at 02:59 -> 00:00', () => expect(lastTriggerMs('0 */3 * * *', L(2026, 11, 17, 2, 59))).toBe(L(2026, 11, 17, 0)));
    it('*/5 at 23:30 -> 20:00', () => expect(lastTriggerMs('0 */5 * * *', L(2026, 11, 17, 23, 30))).toBe(L(2026, 11, 17, 20)));
  });

  describe('every-N-min', () => {
    it('*/15 at 10:44:59 -> 10:30', () =>
      expect(lastTriggerMs('*/15 * * * *', L(2026, 11, 17, 10, 44, 59))).toBe(L(2026, 11, 17, 10, 30)));
    it('*/15 at 10:45:00 -> 10:45', () =>
      expect(lastTriggerMs('*/15 * * * *', L(2026, 11, 17, 10, 45, 0))).toBe(L(2026, 11, 17, 10, 45)));
  });

  describe('daily-multi "30 8,21 * * *"', () => {
    const c = '30 8,21 * * *';
    it('08:29 -> yesterday 21:30', () => expect(lastTriggerMs(c, L(2026, 11, 17, 8, 29))).toBe(L(2026, 11, 16, 21, 30)));
    it('12:00 -> today 08:30', () => expect(lastTriggerMs(c, L(2026, 11, 17, 12))).toBe(L(2026, 11, 17, 8, 30)));
    it('22:00 -> today 21:30', () => expect(lastTriggerMs(c, L(2026, 11, 17, 22))).toBe(L(2026, 11, 17, 21, 30)));
  });

  describe('unsupported / garbage', () => {
    it('@once far in the future -> null (nothing due yet)', () => {
      expect(lastTriggerMs(`@once ${L(2099, 1, 1)}`, L(2026, 11, 17, 12))).toBeNull();
    });
    it('@once in the past -> its instant', () => {
      const at = L(2026, 11, 17, 6);
      expect(lastTriggerMs(`@once ${at}`, L(2026, 11, 17, 12))).toBe(at);
    });
    it('"bad" -> null', () => expect(lastTriggerMs('bad', L(2026, 11, 17, 12))).toBeNull());
    it('wrong field count -> null', () => expect(lastTriggerMs('0 7 * *', L(2026, 11, 17, 12))).toBeNull());
    it('dow list with an out-of-range value (1,9): TS quirk documented, Kotlin returns null', () => {
      // parseDowList rejects 9, but TS lastTriggerMs then falls through to the
      // plain daily branch (today 09:00) instead of returning null; the Kotlin
      // mirror returns null. cronToIntervalMs is null for this shape, so a real
      // agent never reaches reconcile with it. Do NOT assert parity here.
      expect(cronToIntervalMs('0 9 * * 1,9')).toBeNull();
      expect(lastTriggerMs('0 9 * * 1,9', L(2026, 11, 17, 12))).toBe(L(2026, 11, 17, 9));
    });
    it('day-of-month shape "0 7 1 * *": documented only (JS ignores dom, Kotlin rejects)', () => {
      const r = lastTriggerMs('0 7 1 * *', L(2026, 11, 17, 12));
      expect(r === null || typeof r === 'number').toBe(true);
    });
  });
});

// ── Kotlin lockstep (structural) ────────────────────────────────────────────
describe('Kotlin lockstep: AgentScheduleReconcileCore', () => {
  const core = read(KT + 'AgentScheduleReconcileCore.kt');

  const evalProduct = (expr: string): number =>
    expr
      .replace(/L/g, '')
      .split('*')
      .map((t) => parseInt(t.trim().replace(/_/g, ''), 10))
      .reduce((a, b) => a * b, 1);
  const kotlinConst = (name: string): number => {
    const m = core.match(new RegExp(`const val ${name}\\s*=\\s*([0-9_L\\s*]+)`));
    if (!m) throw new Error(`const ${name} not found in AgentScheduleReconcileCore.kt`);
    return evalProduct(m[1].split('\n')[0]);
  };

  it.each([
    ['RECONCILE_GRACE_MS', RECONCILE_GRACE_MS],
    ['CATCH_UP_WINDOW_CAP_MS', CATCH_UP_WINDOW_CAP_MS],
    ['CATCH_UP_WINDOW_FLOOR_MS', CATCH_UP_WINDOW_FLOOR_MS],
    ['RECONCILE_WATCHDOG_PERIOD_MS', RECONCILE_WATCHDOG_PERIOD_MS],
    ['RECONCILE_GRACE_FOLLOW_UP_MS', RECONCILE_GRACE_FOLLOW_UP_MS],
    ['CLAIM_ABANDON_MS', CLAIM_ABANDON_MS],
    ['CHAIN_LOCK_STALE_MS', CHAIN_LOCK_STALE_MS],
  ])('const %s equals the TS export', (name, tsValue) => {
    expect(kotlinConst(name as string)).toBe(tsValue);
  });

  it('every const val in the Kotlin core is covered above', () => {
    const names = [...core.matchAll(/const val (\w+)/g)].map((m) => m[1]).sort();
    expect(names).toEqual(
      [
        'RECONCILE_GRACE_MS',
        'CATCH_UP_WINDOW_CAP_MS',
        'CATCH_UP_WINDOW_FLOOR_MS',
        'RECONCILE_WATCHDOG_PERIOD_MS',
        'RECONCILE_GRACE_FOLLOW_UP_MS',
        'CLAIM_ABANDON_MS',
        'CHAIN_LOCK_STALE_MS',
      ].sort(),
    );
  });

  const tsSrc = read('lib/agent-schedule-reconcile.ts');
  const tsUnionBlock = tsSrc.slice(tsSrc.indexOf('export type ReconcileAction'), tsSrc.indexOf('export interface ReconcileInputs'));
  const tsUnion = [...tsUnionBlock.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const kotlinEnum = [...core.matchAll(/^\s*([A-Z_]+)\("([a-z-]+)"\),/gm)].map((m) => ({ name: m[1], code: m[2] }));

  it('Kotlin Action codes equal the TS ReconcileAction union (same members, same order)', () => {
    expect(tsUnion.length).toBe(9);
    expect(kotlinEnum.map((e) => e.code)).toEqual(tsUnion);
  });

  it('enum names are the upper-snake form of the codes', () => {
    for (const e of kotlinEnum) expect(e.name).toBe(e.code.toUpperCase().replace(/-/g, '_'));
  });

  it('decide() and decideReconcile() return branches in the same order', () => {
    const tsBody = tsSrc.slice(tsSrc.indexOf('export function decideReconcile'));
    const tsOrder = [...tsBody.matchAll(/action: '([a-z-]+)'/g)].map((m) => m[1]);
    const ktBody = core.slice(core.indexOf('fun decide('));
    const ktOrder = [...ktBody.matchAll(/Decision\(Action\.([A-Z_]+),/g)].map((m) => m[1]);
    const codeByName = new Map(kotlinEnum.map((e) => [e.name, e.code]));
    expect(ktOrder.map((n) => codeByName.get(n))).toEqual(tsOrder);
    expect(tsOrder).toEqual([
      'skip-halted', 'skip-disabled', 'skip-unknown', 'skip-running',
      'rearm', 'rearm', 'rearm', 'rearm',
      'rearm', 'wait-grace', 'rearm', 'wait-claim', 'late-run', 'missed',
    ]);
  });

  it('ClaimState mirrors OccurrenceClaimState and occurrenceClaimState has the same branch order', () => {
    const tsStates = [...tsSrc.slice(tsSrc.indexOf('export type OccurrenceClaimState'), tsSrc.indexOf('export function occurrenceClaimState'))
      .matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const ktEnum = core.match(/enum class ClaimState \{([^}]+)\}/)![1].split(',').map((x) => x.trim().toLowerCase());
    expect([...ktEnum].sort()).toEqual([...tsStates].sort());
    const tsBody = tsSrc.slice(tsSrc.indexOf('export function occurrenceClaimState'), tsSrc.indexOf('export type ReconcileAction'));
    const tsOrder = [...tsBody.matchAll(/return '([a-z]+)'/g)].map((m) => m[1]);
    const ktBody = core.slice(core.indexOf('fun occurrenceClaimState('));
    const ktOrder = [...ktBody.slice(0, ktBody.indexOf('\n    }\n')).matchAll(/return ClaimState\.([A-Z]+)/g)].map((m) => m[1].toLowerCase());
    expect(ktOrder).toEqual(tsOrder);
    expect(tsOrder).toEqual(['started', 'settled', 'none', 'reserved', 'deferred', 'started', 'abandoned']);
    expect(ktBody).toContain('Math.abs(nowMs - claimedAtMs) < CLAIM_ABANDON_MS');
  });

  it('isChainLockLive / parseChainLockAcquiredAt exist in Kotlin with the same comparison', () => {
    expect(core).toContain('fun isChainLockLive(acquiredAtSec: Long, nowMs: Long): Boolean');
    expect(core).toContain('nowSec - acquiredAtSec < staleSec');
    expect(core).toContain("t.all { it in '0'..'9' }");
  });
});

describe('Kotlin lockstep: AgentAlarmScheduler', () => {
  const sched = read(KT + 'AgentAlarmScheduler.kt');
  const fnBody = (name: string): string => {
    const start = sched.indexOf(name);
    if (start < 0) throw new Error(`${name} not found`);
    const next = sched.indexOf('\n    fun ', start + name.length);
    return sched.slice(start, next < 0 ? undefined : next);
  };

  it('declares lastTriggerAt(cron, nowMs) and rejects dow > 7', () => {
    expect(sched).toContain('fun lastTriggerAt(cron: String?, nowMs: Long): Long?');
    expect(fnBody('fun lastTriggerAt(')).toContain('days.any { it > 7 }');
  });

  it('reconcile() uses the shared core, live-run check, run-log evidence and late-run extras', () => {
    const body = fnBody('fun reconcile(');
    expect(body).toContain('AgentScheduleReconcileCore.decide');
    expect(body).toContain('isAgentRunLive');
    expect(body).toContain('latestRunLogAt');
    expect(body).toContain('TerminalSessionService.ACTION_RUN_AGENT');
    expect(body).toContain('EXTRA_LATE');
    expect(body).toContain('EXTRA_EXPECTED_AT');
  });

  it('setExactWhileIdle logs EXACT_ALARM_FALLBACK', () => {
    expect(fnBody('private fun setExactWhileIdle(')).toContain('EXACT_ALARM_FALLBACK');
    expect(sched).toContain('EXACT_ALARM_FALLBACK');
  });

  it('scheduleNextIfAgentEnabled cancels only on DISABLED (UNKNOWN keeps the schedule)', () => {
    const body = fnBody('fun scheduleNextIfAgentEnabled(');
    const disabled = body.indexOf('Enabled.DISABLED ->');
    const unknown = body.indexOf('Enabled.UNKNOWN ->');
    const enabled = body.indexOf('Enabled.ENABLED ->');
    expect(disabled).toBeGreaterThan(-1);
    expect(unknown).toBeGreaterThan(disabled);
    expect(enabled).toBeGreaterThan(unknown);
    expect(body.slice(disabled, unknown)).toContain('cancel(context, agentId)');
    expect(body.slice(unknown, enabled)).not.toContain('cancel(');
    expect(body.match(/cancel\(context, agentId\)/g)).toHaveLength(1);
  });
});

describe('Kotlin lockstep: TerminalSessionService', () => {
  const svc = read(KT + 'TerminalSessionService.kt');

  it('ACTION_SCHEDULE_RECONCILE enters the foreground before reconcile and dispatches late runs via onStartCommand', () => {
    const start = svc.indexOf('ACTION_SCHEDULE_RECONCILE ->');
    expect(start).toBeGreaterThan(-1);
    const end = svc.indexOf('ACTION_RUN_AGENT ->', start);
    const branch = svc.slice(start, end);
    const fg = branch.indexOf('startForegroundWithNotification');
    const rec = branch.indexOf('AgentAlarmScheduler.reconcile');
    expect(fg).toBeGreaterThan(-1);
    expect(rec).toBeGreaterThan(fg);
    expect(branch).toMatch(/lateRuns\?\.forEach[\s\S]*onStartCommand\(late/);
  });

  it('arm-before-run sits in ACTION_RUN_AGENT after the halted gate and before runAgentInBackground', () => {
    const start = svc.indexOf('ACTION_RUN_AGENT ->');
    const branch = svc.slice(start);
    const halted = branch.indexOf('if (isGloballyHalted())');
    const arm = branch.indexOf('AgentAlarmScheduler.scheduleNextIfAgentEnabled(');
    const run = branch.indexOf('runAgentInBackground(');
    expect(halted).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(halted);
    expect(run).toBeGreaterThan(arm);
    // guard excludes manual, one-shot, blank cron and continuous loops
    const guardLine = branch.slice(branch.lastIndexOf('if (', arm), arm);
    expect(guardLine).toContain('!manual');
    expect(guardLine).toContain('!cron.isNullOrBlank()');
    expect(guardLine).toContain('!AgentAlarmScheduler.isOneShotCron(cron)');
    expect(guardLine).toContain('continuousConfig == null');
  });
});

describe('Kotlin lockstep: receivers, module and bridge', () => {
  it('BootCompletedReceiver handles BOOT_COMPLETED and MY_PACKAGE_REPLACED and starts the reconcile service', () => {
    const r = read(KT + 'BootCompletedReceiver.kt');
    expect(r).toContain('Intent.ACTION_BOOT_COMPLETED');
    expect(r).toContain('Intent.ACTION_MY_PACKAGE_REPLACED');
    expect(r).toContain('startReconcileService');
  });

  it('ExactAlarmPermissionReceiver checks the permission-state-changed action', () => {
    const r = read(KT + 'ExactAlarmPermissionReceiver.kt');
    expect(r).toContain('ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED');
    expect(r).toContain('startReconcileService');
  });

  it('TerminalEmulatorModule.kt exposes reconcileAgentSchedules and the TS module declares it', () => {
    expect(read(KT + 'TerminalEmulatorModule.kt')).toContain('AsyncFunction("reconcileAgentSchedules")');
    expect(read('modules/terminal-emulator/src/TerminalEmulatorModule.ts')).toMatch(/reconcileAgentSchedules\??\(/);
  });
});

describe('Manifest + plugin registration', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const pluginSrc = read('plugins/with-terminal-service.js');
  const BOOT = 'expo.modules.terminalemulator.BootCompletedReceiver';
  const EXACT = 'expo.modules.terminalemulator.ExactAlarmPermissionReceiver';
  const EXACT_ACTION = 'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED';

  const receiverBlock = (xml: string, name: string): string => {
    const i = xml.indexOf(`android:name="${name}"`);
    expect(i).toBeGreaterThan(-1);
    return xml.slice(i, xml.indexOf('</receiver>', i));
  };

  it('checked-in manifest: BootCompletedReceiver has BOOT_COMPLETED and MY_PACKAGE_REPLACED', () => {
    const b = receiverBlock(manifest, BOOT);
    expect(b).toContain('android.intent.action.BOOT_COMPLETED');
    expect(b).toContain('android.intent.action.MY_PACKAGE_REPLACED');
  });

  it('checked-in manifest: ExactAlarmPermissionReceiver, exported=false, permission-state action', () => {
    const b = receiverBlock(manifest, EXACT);
    expect(b).toContain(EXACT_ACTION);
    expect(manifest).toMatch(new RegExp(`android:name="${EXACT}"\\s+android:exported="false"`));
  });

  it('plugin source mentions both receivers and actions', () => {
    expect(pluginSrc).toContain('android.intent.action.MY_PACKAGE_REPLACED');
    expect(pluginSrc).toContain(EXACT);
    expect(pluginSrc).toContain(EXACT_ACTION);
  });

  it('plugin manifest mod registers both receivers (idempotent, upgrades an old BootCompletedReceiver)', async () => {
    const run = async (manifestObj: any) =>
      (await withTerminalService({}).mods.android.manifest({ modResults: manifestObj })).modResults;

    const fresh = await run({ manifest: { application: [{ receiver: [] }] } });
    const recv = fresh.manifest.application[0].receiver as Array<any>;
    const byName = (n: string) => recv.filter((r) => r.$['android:name'] === n);

    const boot = byName(BOOT);
    expect(boot).toHaveLength(1);
    const bootActions = boot[0]['intent-filter'][0].action.map((a: any) => a.$['android:name']);
    expect(bootActions).toEqual(
      expect.arrayContaining(['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED']),
    );

    const exact = byName(EXACT);
    expect(exact).toHaveLength(1);
    expect(exact[0].$['android:exported']).toBe('false');
    expect(exact[0]['intent-filter'][0].action[0].$['android:name']).toBe(EXACT_ACTION);

    // idempotent
    const again = await run(fresh);
    const recv2 = again.manifest.application[0].receiver as Array<any>;
    expect(recv2.filter((r) => r.$['android:name'] === BOOT)).toHaveLength(1);
    expect(recv2.filter((r) => r.$['android:name'] === EXACT)).toHaveLength(1);
    expect(recv2.find((r) => r.$['android:name'] === BOOT)['intent-filter'][0].action).toHaveLength(2);

    // a pre-existing BOOT_COMPLETED-only declaration gains MY_PACKAGE_REPLACED
    const old = await run({
      manifest: {
        application: [
          {
            receiver: [
              {
                $: { 'android:name': BOOT, 'android:exported': 'true' },
                'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }] }],
              },
            ],
          },
        ],
      },
    });
    const oldBoot = (old.manifest.application[0].receiver as Array<any>).find((r) => r.$['android:name'] === BOOT);
    expect(oldBoot['intent-filter'][0].action.map((a: any) => a.$['android:name'])).toEqual(
      expect.arrayContaining(['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED']),
    );
  });
});

describe('one run per occurrence (Codex review round 1)', () => {
  const fsx = require('fs') as typeof import('fs');
  const pathx = require('path') as typeof import('path');
  const KTDIR = pathx.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const sched = fsx.readFileSync(pathx.join(KTDIR, 'AgentAlarmScheduler.kt'), 'utf8');
  const svc = fsx.readFileSync(pathx.join(KTDIR, 'TerminalSessionService.kt'), 'utf8');

  it('claimOccurrence is a synchronized check-and-RESERVE committed to prefs (claim + timestamp, one commit)', () => {
    const i = sched.indexOf('fun claimOccurrence(');
    expect(i).toBeGreaterThan(-1);
    expect(sched.slice(i - 40, i)).toContain('@Synchronized');
    const body = sched.slice(i, sched.indexOf('\n    }\n', i));
    // The shared lifecycle decides what blocks: STARTED, SETTLED and a fresh
    // RESERVED reservation do; NONE, ABANDONED and DEFERRED may be (re)taken.
    expect(body).toContain('AgentScheduleReconcileCore.occurrenceClaimState(');
    expect(body).toMatch(/ClaimState\.STARTED,\s*AgentScheduleReconcileCore\.ClaimState\.SETTLED,\s*AgentScheduleReconcileCore\.ClaimState\.RESERVED -> return Claim\.ALREADY_CLAIMED/);
    expect(body).toContain('.putLong(key, occurrenceMs).putLong(atKey, nowMs).commit()) return Claim.CLAIMED');
    // Re-gate R1 (Codex round 1): a re-reservation keeps the deferred mark.
    expect(body).not.toContain('remove(deferredKey)');
    expect(body).toContain('return Claim.NOT_DURABLE');
    // A failed commit must not leave the claim in memory (F5): both keys roll back.
    const committed = body.indexOf('.commit()) return Claim.CLAIMED');
    expect(body.indexOf('undo.remove(key) else undo.putLong(key, previous)')).toBeGreaterThan(committed);
    expect(body.indexOf('undo.remove(atKey) else undo.putLong(atKey, previousAt)')).toBeGreaterThan(committed);
  });

  it('F1: every alarm that is armed carries the occurrence it was armed for', () => {
    expect(sched).toContain('runServicePendingIntent(context, agentId, intervalMs, cron, triggerAtMs)');
    expect(sched).toContain('putExtra(TerminalSessionService.EXTRA_SCHEDULED_AT, scheduledAtMs)');
    // Every call site other than the declaration: schedule() (armed with its
    // trigger time) or cancel() (PendingIntent identity ignores extras).
    const calls = [...sched.matchAll(/runServicePendingIntent\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !a.includes(':'));
    expect(calls.sort()).toEqual(['context, agentId, 0L, null', 'context, agentId, intervalMs, cron, triggerAtMs'].sort());
    // Every arming path funnels into schedule(): scheduleNext computes the
    // occurrence and passes it as triggerAtMs.
    const next = sched.slice(sched.indexOf('fun scheduleNext('));
    expect(next.slice(0, next.indexOf('\n    }\n'))).toContain('schedule(context, agentId, intervalMs, triggerAt, cron)');
  });

  it('F1: a regular fire uses the ARMED occurrence; an old-build alarm without it runs unclaimed', () => {
    const run = svc.slice(svc.indexOf('ACTION_RUN_AGENT -> {'));
    expect(run).toContain('intent.getLongExtra(EXTRA_SCHEDULED_AT, 0L).takeIf { it > 0 }');
    // No identity (old build) -> no claim at all: the fire runs unclaimed.
    expect(run).toContain('val claim = occurrence?.let { AgentAlarmScheduler.claimOccurrence(applicationContext, agentId, it) }');
    expect(run).not.toContain('System.currentTimeMillis() + 30_000L');
  });

  it('F5: a late run is queued only on a durable claim; a regular fire is suppressed only on ALREADY_CLAIMED (NOT_DURABLE still runs)', () => {
    const late = sched.slice(sched.indexOf('AgentScheduleReconcileCore.Action.LATE_RUN ->'));
    expect(late.indexOf('claimOccurrence(')).toBeLessThan(late.indexOf('lateRuns +='));
    expect(late).toContain('claimOccurrence(context, agentId, expectedAt) != Claim.CLAIMED');
    const run = svc.slice(svc.indexOf('ACTION_RUN_AGENT -> {'));
    const claim = run.indexOf('AgentAlarmScheduler.claimOccurrence(');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(run.indexOf('runAgentInBackground('));
    expect(run).toContain('SCHEDULE_DUPLICATE_SUPPRESSED');
    expect(run).toContain('== AgentAlarmScheduler.Claim.ALREADY_CLAIMED');
    expect(run).not.toContain('Claim.NOT_DURABLE');
  });

  it('F3: the occurrence is marked STARTED inside AgentRuntime, after its gates and extraction, right before an executor launches', () => {
    const run = svc.slice(svc.indexOf('ACTION_RUN_AGENT -> {'), svc.indexOf('private fun runAgentInBackground('));
    // Late run and regular fire feed the same value (same identity) into the run.
    expect(run).toContain('occurrenceToStart = expectedAt.takeIf { it > 0 }');
    expect(run).toContain('occurrenceToStart = occurrence');
    const dispatch = run.indexOf('runAgentInBackground(');
    expect(run.slice(dispatch, run.indexOf('\n', dispatch))).toContain('mcpPrincipal, occurrenceToStart)');
    expect(dispatch).toBeGreaterThan(run.indexOf('SCHEDULE_DUPLICATE_SUPPRESSED'));
    // Not in the dispatch branch nor on the worker before AgentRuntime: a
    // death before execution must leave only a recoverable reservation.
    expect(run).not.toContain('AgentAlarmScheduler.markOccurrenceStarted(');
    const worker = svc.slice(svc.indexOf('private fun runAgentInBackground('));
    const call = worker.slice(worker.indexOf('runResult = AgentRuntime.runAgent('), worker.indexOf('runEndMs = System.currentTimeMillis()'));
    expect(call).toContain('onExecutionStart = scheduledOccurrence?.let { occ ->');
    expect(call).toContain('AgentAlarmScheduler.markOccurrenceStarted(applicationContext, agentId, occ)');
    expect(worker.slice(0, worker.indexOf('runResult = AgentRuntime.runAgent('))).not.toContain('AgentAlarmScheduler.markOccurrenceStarted(');
    const rt = fsx.readFileSync(pathx.join(KTDIR, 'AgentRuntime.kt'), 'utf8');
    expect(rt).toContain('runAgentInner(context, agentId, tainted, unattended, notificationText, notificationPackage, origin, ingressRunReason, mcpActionsPreapproved, startHook, scheduledAtMs, refireOf, recoveryLaunchId)');
    // The start hook marks `launched` before calling the caller's hook.
    expect(rt).toMatch(/val startHook: \(\(\) -> Unit\)\? = if \(onExecutionStart == null && onRefusedBeforeLaunch == null\) null else \{\s*\{\s*launched = true\s*onExecutionStart\?\.invoke\(\)/);
    // Fired by each executor path immediately before its execSubprocess
    // launch: after the final enabled check, extraction, stale-lock cleanup
    // and (PlanSpec) the local-LLM preflight.
    expect(rt).toContain('return runPlanAgent(appContext, homeDir, libDir, bashPath, agentId, tainted, unattended, notificationText, notificationPackage, runOrigin, ingressReason, mcpActionsPreapproved, onExecutionStart, scheduledAtMs, refireOf, recoveryLaunchId)');
    // The helper must exist exactly once (Codex round 6 caught it deleted).
    expect(rt.match(/private fun fireExecutionStart\(agentId: String, onExecutionStart: \(\(\) -> Unit\)\?\)/g)).toHaveLength(1);
    const fires = [...rt.matchAll(/fireExecutionStart\(agentId, onExecutionStart\)/g)].map((m) => m.index!);
    expect(fires).toHaveLength(2);
    for (const at of fires) {
      const after = rt.slice(at, at + 260);
      expect(after).toMatch(/fireExecutionStart\(agentId, onExecutionStart\)\n\s*val runStartedAtMs = System\.currentTimeMillis\(\)\n\s*val result = try \{\n\s*ShellyJNI\.execSubprocess\(/);
      expect(rt.slice(at - 700, at)).toContain('agent disabled immediately before launch');
    }
    const inner = rt.slice(rt.indexOf('private fun runAgentInner('), rt.indexOf('private fun runPlanAgent('));
    expect(fires[0]).toBeGreaterThan(rt.indexOf('LibExtractor.extractAll(appContext)'));
    expect(inner.indexOf('fireExecutionStart(')).toBeGreaterThan(inner.indexOf('clearStaleChainLock(appContext, homeDir, agentId)'));
    const preflightCall = rt.indexOf('ensureLocalLlmServerBeforePlanExecutor(homeDir, libPath, bashPath, agentId,');
    expect(preflightCall).toBeGreaterThan(rt.indexOf('private fun runPlanAgent('));
    expect(fires[1]).toBeGreaterThan(preflightCall);
    const m = sched.slice(sched.indexOf('fun markOccurrenceStarted('));
    expect(sched.slice(sched.indexOf('fun markOccurrenceStarted(') - 40, sched.indexOf('fun markOccurrenceStarted('))).toContain('@Synchronized');
    expect(m.slice(0, m.indexOf('\n    }\n'))).toContain('.putLong(STARTED_PREFIX + agentId, occurrenceMs)');
  });

  it('F3: a run this process is still preparing counts as live, and its old reservation is not taken over', () => {
    const live = sched.slice(sched.indexOf('fun isAgentRunLive('));
    expect(live.slice(0, 200)).toContain('NativeAgentRunRegistry.activeRunStartedAt(agentId) != null');
    const claim = sched.slice(sched.indexOf('fun claimOccurrence('));
    expect(claim).toMatch(/ClaimState\.ABANDONED,\s*AgentScheduleReconcileCore\.ClaimState\.DEFERRED ->\s*if \(NativeAgentRunRegistry\.activeRunStartedAt\(agentId\) != null\) return Claim\.ALREADY_CLAIMED/);
  });

  it('F3: a new late-run reservation arms its recovery tick before the run is queued', () => {
    const body = sched.slice(sched.indexOf('fun reconcile('));
    const late = body.slice(body.indexOf('Action.LATE_RUN ->'), body.indexOf('Action.MISSED ->'));
    const claimed = late.indexOf('!= Claim.CLAIMED');
    const arm = late.indexOf('armReservationRecovery(context, agentId, now)');
    expect(arm).toBeGreaterThan(claimed);
    expect(arm).toBeLessThan(late.indexOf('lateRuns +='));
    expect(late).toContain('followUpAt = minOf(followUpAt ?: recoveryAt, recoveryAt)');
  });

  it('F3 (round 7): a regular fire that reserves its occurrence arms the same recovery tick', () => {
    const run = svc.slice(svc.indexOf('ACTION_RUN_AGENT -> {'), svc.indexOf('private fun runAgentInBackground('));
    const claim = run.indexOf('val claim = occurrence?.let { AgentAlarmScheduler.claimOccurrence(applicationContext, agentId, it) }');
    const recovery = run.indexOf('AgentAlarmScheduler.armReservationRecovery(applicationContext, agentId)');
    expect(claim).toBeGreaterThan(-1);
    expect(recovery).toBeGreaterThan(claim);
    expect(run.slice(claim, recovery)).toContain('if (claim == AgentAlarmScheduler.Claim.CLAIMED)');
    expect(recovery).toBeLessThan(run.indexOf('if (claim == AgentAlarmScheduler.Claim.ALREADY_CLAIMED)'));
  });

  it('F3 (round 7): the recovery tick only pulls the watchdog in, and is relaxed once the run starts', () => {
    const fn = (name: string) => {
      const i = sched.indexOf(name);
      return sched.slice(i, sched.indexOf('\n    }\n', i));
    };
    const arm = fn('fun armReservationRecovery(');
    expect(sched.slice(sched.indexOf('fun armReservationRecovery(') - 40, sched.indexOf('fun armReservationRecovery('))).toContain('@Synchronized');
    expect(arm).toContain('AgentScheduleReconcileCore.CLAIM_ABANDON_MS + AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS');
    expect(arm).toContain('putLong(RECOVERY_PREFIX + agentId, at)');
    expect(arm).toContain('if (!(piAlive && armed > nowMs && armed <= at)) armReconcileWatchdog(context, at)');
    const relax = fn('private fun relaxReservationRecovery(');
    expect(relax).toContain('remove(RECOVERY_PREFIX + agentId)');
    expect(relax).toContain('RECONCILE_TICK_KEY');
    expect(relax).toContain('now + AgentScheduleReconcileCore.RECONCILE_WATCHDOG_PERIOD_MS');
    // Only ever pushes an earlier tick later, up to the earliest remaining need.
    expect(relax).toContain('if (armed < target) armReconcileWatchdog(context, target)');
    // Round 10: another agent's overdue recovery blocks relaxation entirely.
    expect(relax).toContain('val pending = earliestRecoveryNeed(prefs)');
    expect(relax.indexOf('if (pending != null && pending <= now) return')).toBeLessThan(relax.indexOf('if (armed < target)'));
    const need = sched.slice(sched.indexOf('private fun earliestRecoveryNeed('), sched.indexOf('private fun earliestRecoveryNeed(') + 300);
    expect(need).toContain('if (k.startsWith(RECOVERY_PREFIX)) v as? Long else null }.minOrNull()');
    expect(relax).toContain('isGloballyHalted(context)');
    const mark = fn('fun markOccurrenceStarted(');
    expect(mark.indexOf('relaxReservationRecovery(context, agentId)')).toBeGreaterThan(mark.indexOf('} else {'));
    const body = fn('fun reconcile(');
    expect(body).toContain('prefs.edit().putLong(RECONCILE_TICK_KEY, tick).apply()');
    // Round 8: a pass never drops a pending recovery tick — the end-of-pass
    // watchdog includes every persisted deadline, and a due one is cleared
    // only for an agent this pass actually decided (else retried).
    expect(body).toContain('val tick = listOfNotNull(next, followUpAt, recoveryTick).minOrNull() ?: next');
    expect(body).toContain('pendingRecoveryTick(context, now, decided, scheduledIds)');
    const markDecided = body.indexOf('if (decision.action != AgentScheduleReconcileCore.Action.SKIP_UNKNOWN) decided += agentId');
    expect(markDecided).toBeGreaterThan(body.indexOf('AgentScheduleReconcileCore.Action.REARM ->'));
    expect(markDecided).toBeLessThan(body.indexOf('Reconcile ($reason) failed for $agentId'));
    // Round 9: the ensure path (incl. force after a refused service start
    // or a reboot) never arms later than a pending recovery deadline.
    const ensure = fn('fun ensureReconcileWatchdog(');
    // Round 11: floor applied per deadline, then the minimum (an overdue
    // deadline cannot hide another agent's earlier future one).
    expect(ensure).toMatch(/if \(k\.startsWith\(RECOVERY_PREFIX\)\) \(v as\? Long\)\?\.let \{\s*if \(it <= now\)[^}]*else it\s*\} else null\s*\}\.minOrNull\(\)/);
    // Round 10: the 1-min floor applies only to an overdue deadline.
    expect(ensure).toContain('if (it <= now) now + AgentScheduleReconcileCore.RECONCILE_GRACE_FOLLOW_UP_MS else it');
    expect(ensure).toContain('val target = minOf(now + period, recovery ?: (now + period))');
    expect(ensure).toContain('if (piAlive && armedAt > now && armedAt <= target) return');
    expect(ensure).toContain('armReconcileWatchdog(context, target)');
    expect(ensure).not.toContain('armReconcileWatchdog(context, now + period)');
    const pend = fn('private fun pendingRecoveryTick(');
    expect(pend).toMatch(/at > now -> at\s*\n\s*agentId in decided -> null/);
    expect(pend).toContain('now - claimedAt <= AgentScheduleReconcileCore.CATCH_UP_WINDOW_CAP_MS');
    expect(pend).toContain('agentId !in scheduledIds -> null');
    const running = body.slice(body.indexOf('Action.SKIP_RUNNING ->'), body.indexOf('Action.WAIT_GRACE ->'));
    expect(running).toContain('claimedFor == occurrence && startedFor != occurrence && settledFor != occurrence && claimedAt != null');
    expect(running).toContain('now - occurrence <= decision.windowMs');
    expect(running).toContain('armReservationRecovery(context, agentId, now)');
  });

  it('F2 / re-gate R2: AgentRuntime removes a stale chain lock through the shared protocol before either executor checks it', () => {
    const rt = fsx.readFileSync(pathx.join(KTDIR, 'AgentRuntime.kt'), 'utf8');
    const inner = rt.slice(rt.indexOf('private fun runAgentInner('));
    const clear = inner.indexOf('clearStaleChainLock(appContext, homeDir, agentId)');
    expect(clear).toBeGreaterThan(inner.indexOf('readNativeFailureCount(homeDir, agentId) >= NATIVE_FAILURE_BACKOFF_THRESHOLD'));
    expect(clear).toBeLessThan(inner.indexOf('if (shouldRunPlanExecutor(homeDir, agentId))'));
    const fn = rt.slice(rt.indexOf('private fun clearStaleChainLock('));
    const body = fn.slice(0, fn.indexOf('\n    }\n'));
    // The protocol itself (instance binding, marker, inode-verified move,
    // newborn guard) is exercised for real in agent-chain-lock-protocol.test.ts.
    expect(body).toContain('if (!dir.isDirectory) return');
    expect(body).toContain('ChainLockProtocol.reap(context, dir)');
    expect(body).not.toContain('renameTo');
    expect(body).not.toContain('deleteRecursively');
  });

  it('re-gate R3: every agent fire re-books a watchdog whose stored time is past (a dropped watchdog delivery does not end the chain while agents fire)', () => {
    const fnOf = (name: string) => {
      const i = sched.indexOf(name);
      return sched.slice(i, sched.indexOf('\n    }\n', i));
    };
    // The fire's arm-before-run goes through schedule(), which ensures the watchdog …
    const sch = sched.slice(sched.indexOf('    fun schedule('));
    const schBody = sch.slice(0, sch.indexOf('\n    }\n'));
    expect(schBody).toMatch(/if \(isReconcilableCron\(cron\)\) \{\s*runCatching \{ ensureReconcileWatchdog\(context\) \}/);
    // … and ensure re-arms unless a FUTURE tick is still pending.
    expect(fnOf('fun ensureReconcileWatchdog(')).toContain('if (piAlive && armedAt > now && armedAt <= target) return');
    const run = svc.slice(svc.indexOf('ACTION_RUN_AGENT -> {'), svc.indexOf('private fun runAgentInBackground('));
    expect(run).toContain('AgentAlarmScheduler.scheduleNextIfAgentEnabled(');
  });

  it('re-gate R1: a scheduled occurrence refused before launch is settled — or deferred when a previous run is still active', () => {
    const rt = fsx.readFileSync(pathx.join(KTDIR, 'AgentRuntime.kt'), 'utf8');
    expect(rt).toContain('const val PREVIOUS_RUN_ACTIVE_MESSAGE = "previous run still active"');
    // runAgent: a normal return without a launch reports the refusal.
    const outer = rt.slice(rt.indexOf('    fun runAgent('), rt.indexOf('private fun fireExecutionStart('));
    expect(outer).toContain('if (!launched && onRefusedBeforeLaunch != null) {');
    expect(outer).toContain('val previousRunActive = result.stderr == PREVIOUS_RUN_ACTIVE_MESSAGE');
    expect(outer).toContain('onRefusedBeforeLaunch(previousRunActive, result.stderr)');
    // The scheduled-run active-run refusal sits after the stale cleanup and
    // before either executor route; both "still active" refusals use the constant.
    const inner = rt.slice(rt.indexOf('private fun runAgentInner('), rt.indexOf('private fun runPlanAgent('));
    const pre = inner.indexOf('if (onExecutionStart != null && isAnotherRunActive(homeDir, agentId)) {');
    expect(pre).toBeGreaterThan(inner.indexOf('clearStaleChainLock(appContext, homeDir, agentId)'));
    expect(pre).toBeLessThan(inner.indexOf('if (shouldRunPlanExecutor(homeDir, agentId))'));
    expect(inner.slice(pre, pre + 400)).toContain('val message = PREVIOUS_RUN_ACTIVE_MESSAGE');
    const plan = rt.slice(rt.indexOf('private fun runPlanAgent('));
    expect(plan).toMatch(/if \(chainLockDir\.isDirectory\) \{\s*val message = PREVIOUS_RUN_ACTIVE_MESSAGE/);
    const active = rt.slice(rt.indexOf('private fun isAnotherRunActive('));
    const activeBody = active.slice(0, active.indexOf('\n    }\n'));
    expect(activeBody).toContain('File(locks, "$agentId.chain.lock").isDirectory');
    expect(activeBody).toContain('pid != null && pid > 0 && File("/proc/$pid").exists()');
    // The service passes the hook only for a scheduled occurrence.
    const worker = svc.slice(svc.indexOf('private fun runAgentInBackground('));
    const call = worker.slice(worker.indexOf('runResult = AgentRuntime.runAgent('), worker.indexOf('runEndMs = System.currentTimeMillis()'));
    expect(call).toContain('onRefusedBeforeLaunch = scheduledOccurrence?.let { occ ->');
    expect(call).toMatch(/if \(previousRunActive\) \{\s*AgentAlarmScheduler\.markOccurrenceDeferred\(applicationContext, agentId, occ\)\s*\} else \{\s*AgentAlarmScheduler\.markOccurrenceSettled\(applicationContext, agentId, occ, reason\)/);
    // The marks: settled never re-dispatches; deferred arms a recovery tick.
    const fnOf = (name: string) => {
      const i = sched.indexOf(name);
      return sched.slice(i, sched.indexOf('\n    }\n', i));
    };
    const settled = fnOf('fun markOccurrenceSettled(');
    expect(settled).toContain('.putLong(SETTLED_PREFIX + agentId, occurrenceMs)');
    expect(settled).toContain('.putLong(CLAIMED_PREFIX + agentId, occurrenceMs)');
    expect(settled).toContain('.remove(DEFERRED_PREFIX + agentId)');
    expect(settled).toContain('relaxReservationRecovery(context, agentId)');
    const deferred = fnOf('fun markOccurrenceDeferred(');
    expect(deferred).toContain('.putLong(DEFERRED_PREFIX + agentId, occurrenceMs)');
    expect(deferred).toContain('.putLong(CLAIMED_PREFIX + agentId, occurrenceMs)');
    expect(deferred).toContain('armReservationRecovery(context, agentId, now)');
    for (const name of ['fun markOccurrenceSettled(', 'fun markOccurrenceDeferred(']) {
      expect(sched.slice(sched.indexOf(name) - 40, sched.indexOf(name))).toContain('@Synchronized');
    }
    // Reconcile feeds both marks to the core.
    const body = sched.slice(sched.indexOf('fun reconcile('));
    expect(body).toContain('settledForMs = settledFor');
    expect(body).toContain('deferredForMs = deferredFor');
  });

  it('F3: reconcile feeds the whole claim record to the core; WAIT_CLAIM follows up; re-arm comes after the late run is queued', () => {
    const body = sched.slice(sched.indexOf('fun reconcile('));
    expect(body).toContain('claimedForMs = claimedFor');
    expect(body).toContain('claimedAtMs = claimedAt');
    expect(body).toContain('startedForMs = startedFor');
    const wait = body.slice(body.indexOf('Action.WAIT_CLAIM ->'), body.indexOf('Action.LATE_RUN ->'));
    expect(wait).toContain('scheduleNext(');
    expect(wait).toContain('AgentScheduleReconcileCore.CLAIM_ABANDON_MS');
    expect(wait).toContain('followUpAt = minOf(');
    const late = body.slice(body.indexOf('Action.LATE_RUN ->'), body.indexOf('Action.MISSED ->'));
    expect(late.lastIndexOf('scheduleNext(')).toBeGreaterThan(late.indexOf('lateRuns +='));
  });

  it('F2: native isAgentRunLive applies the shared stale-lock policy to the chain lock', () => {
    const i = sched.indexOf('fun isAgentRunLive(');
    const body = sched.slice(i, sched.indexOf('\n    }\n', i));
    expect(body).toContain('File(chain, "acquired-at")');
    expect(body).toContain('AgentScheduleReconcileCore.parseChainLockAcquiredAt(');
    expect(body).toContain('AgentScheduleReconcileCore.isChainLockLive(acquiredAt, System.currentTimeMillis())');
    expect(body).not.toMatch(/chain\.lock"\)\.isDirectory\) \{\s*true/);
  });

  it('reconcile passes the previous occurrence to the core', () => {
    expect(sched).toContain('previousOccurrenceMs = occurrence?.let { lastTriggerAt(cron, it - 1) }');
  });
});
