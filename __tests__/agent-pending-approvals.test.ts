/**
 * __tests__/agent-pending-approvals.test.ts — MONITOR's typed approval
 * (lib/agent-pending-approvals.ts): the oldest-first order of several pending
 * asks, which ask a typed OK / NO answers (the chat's matcher, the [hash8]
 * binding, the "just replaced" guard), the stuck-vs-awaiting camera label,
 * and the registry the RN drain fills.
 *
 * Pure (relative imports, no RN) so it also runs under plain Node with a
 * strip-types shim when Jest cannot start.
 */
import { ACTION_CHAT_REPLY_MIN_AGE_MS, type PendingActionApprovalMarker } from '../lib/agent-action-chat-reply';
import {
  MONITOR_ASK_MIN_SHOWN_MS,
  __resetPendingApprovalsForTest,
  getPendingApprovals,
  monitorAskIdentity,
  pendingApprovalKey,
  pendingApprovalsForAgent,
  pickMonitorApprovalTarget,
  removePendingApproval,
  subscribePendingApprovals,
  upsertPendingApproval,
  withPendingApprovals,
  type PendingApprovalAsk,
} from '../lib/agent-pending-approvals';
import type { MonitorAgentSnapshot, MonitorSnapshot } from '../lib/monitor-source';

const T0 = 1_000_000;

function ask(over: { agentId?: string; createdAt?: number; hex?: string; kind?: 'action' | 'escalation'; reqId?: string; runId?: string; reviewRequired?: boolean; expiresAt?: number | null } = {}): PendingApprovalAsk {
  const hex = over.hex ?? '1a2b3c4d';
  const sha = hex + 'f'.repeat(56);
  const kind = over.kind ?? 'escalation';
  const runId = over.runId ?? 'run-1';
  const reqId = over.reqId ?? `req-${hex}`;
  const marker: PendingActionApprovalMarker = {
    runId,
    requestSha256: sha,
    hash8: hex,
    reviewRequired: over.reviewRequired ?? false,
    createdAt: over.createdAt ?? T0,
    expiresAt: over.expiresAt ?? null,
    ...(kind === 'escalation' ? { kind, reqId } : {}),
  };
  return {
    key: pendingApprovalKey(kind, runId, reqId),
    kind,
    agentId: over.agentId ?? 'agent-a',
    messageId: `m-${hex}`,
    marker,
    what: 'it wants to run a command outside its allowed boundary',
    detail: 'cd ~/demo && git log',
  };
}

describe('pendingApprovalsForAgent', () => {
  it('only the given agent, oldest first (three escalations issued within one second)', () => {
    const list = [
      ask({ hex: 'cccccccc', createdAt: T0 + 900 }),
      ask({ hex: 'aaaaaaaa', createdAt: T0 + 100 }),
      ask({ hex: 'dddddddd', agentId: 'agent-b', createdAt: T0 }),
      ask({ hex: 'bbbbbbbb', createdAt: T0 + 500 }),
    ];
    expect(pendingApprovalsForAgent(list, 'agent-a').map((a) => a.marker.hash8)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(pendingApprovalsForAgent(list, 'agent-b').map((a) => a.marker.hash8)).toEqual(['dddddddd']);
    expect(pendingApprovalsForAgent(list, null)).toEqual([]);
  });

  it('same timestamp: stable order by key', () => {
    const list = [ask({ hex: 'bbbbbbbb' }), ask({ hex: 'aaaaaaaa' })];
    expect(pendingApprovalsForAgent(list, 'agent-a').map((a) => a.marker.hash8)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });
});

describe('pickMonitorApprovalTarget', () => {
  const asks = [ask({ hex: 'aaaaaaaa', createdAt: T0 }), ask({ hex: 'bbbbbbbb', createdAt: T0 + 10 })];
  const shown = { displayedKey: monitorAskIdentity(asks[0]), displayedSince: T0 };
  const now = T0 + Math.max(ACTION_CHAT_REPLY_MIN_AGE_MS, MONITOR_ASK_MIN_SHOWN_MS) + 100;

  it('a bare OK / NO (English or Japanese) answers the displayed, oldest ask', () => {
    for (const [text, decision] of [
      ['OK', 'accept'],
      ['yes.', 'accept'],
      ['許可', 'accept'],
      ['はい', 'accept'],
      ['NO', 'decline'],
      ['拒否', 'decline'],
      ['だめ', 'decline'],
    ] as const) {
      const pick = pickMonitorApprovalTarget({ text, asks, ...shown, now });
      expect(pick).toMatchObject({ ok: true, decision });
      if ('ask' in pick) expect(pick.ask.marker.hash8).toBe('aaaaaaaa');
    }
  });

  it('"ok <hash8>" answers the named ask even if it is not the displayed one', () => {
    const pick = pickMonitorApprovalTarget({ text: 'ok bbbbbbbb', asks, ...shown, now });
    expect(pick).toMatchObject({ ok: true, decision: 'accept' });
    if ('ask' in pick) expect(pick.ask.marker.hash8).toBe('bbbbbbbb');
  });

  it('anything but a whole-message OK / NO is not an answer', () => {
    expect(pickMonitorApprovalTarget({ text: 'make it faster, ok?', asks, ...shown, now })).toEqual({ ok: false, reason: 'not-a-reply' });
    expect(pickMonitorApprovalTarget({ text: 'ok then no', asks, ...shown, now })).toEqual({ ok: false, reason: 'not-a-reply' });
  });

  it('an unknown binding never falls back to the displayed ask', () => {
    expect(pickMonitorApprovalTarget({ text: 'ok 12345678', asks, ...shown, now })).toEqual({ ok: false, reason: 'unknown-hash' });
  });

  it('nothing pending', () => {
    expect(pickMonitorApprovalTarget({ text: 'ok', asks: [], ...shown, now })).toEqual({ ok: false, reason: 'nothing-pending' });
  });

  it('a bare reply does not land on an ask that just replaced the answered one', () => {
    const replaced = { displayedKey: monitorAskIdentity(asks[0]), displayedSince: now - MONITOR_ASK_MIN_SHOWN_MS + 1 };
    expect(pickMonitorApprovalTarget({ text: 'ok', asks, ...replaced, now })).toEqual({ ok: false, reason: 'too-soon' });
    // The screen still shows a different ask than the list's oldest.
    const stale = { displayedKey: monitorAskIdentity(asks[1]), displayedSince: T0 };
    expect(pickMonitorApprovalTarget({ text: 'ok', asks, ...stale, now })).toEqual({ ok: false, reason: 'too-soon' });
  });

  it('review L2: a superseding request under the same key restarts the visibility timer', () => {
    // Same run + request id (same key), new content (new hash): the screen
    // was showing the OLD content since T0.
    const before = ask({ hex: 'aaaaaaaa', reqId: 'req-1', createdAt: T0 });
    const after = { ...before, marker: { ...before.marker, requestSha256: 'b'.repeat(64), hash8: 'bbbbbbbb' } };
    expect(after.key).toBe(before.key);
    expect(monitorAskIdentity(after)).not.toBe(monitorAskIdentity(before));
    const oldScreen = { displayedKey: monitorAskIdentity(before), displayedSince: T0 };
    expect(pickMonitorApprovalTarget({ text: 'ok', asks: [after], ...oldScreen, now })).toEqual({ ok: false, reason: 'too-soon' });
    // Once MONITOR has shown the new content long enough, it is answerable.
    const newScreen = { displayedKey: monitorAskIdentity(after), displayedSince: T0 };
    expect(pickMonitorApprovalTarget({ text: 'ok', asks: [after], ...newScreen, now })).toMatchObject({ ok: true });
  });

  it('MonitorPane keys its visibility timer on key + hash', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'panes', 'MonitorPane.tsx'), 'utf8');
    expect(src).toContain('const shownIdentity = shownAsk ? monitorAskIdentity(shownAsk) : null;');
    expect(src).toContain('}, [shownIdentity]);');
  });

  it('same age window as the chat: too fresh, or past its deadline', () => {
    const fresh = [ask({ createdAt: now - 10 })];
    expect(
      pickMonitorApprovalTarget({ text: 'ok', asks: fresh, displayedKey: monitorAskIdentity(fresh[0]), displayedSince: T0, now }),
    ).toEqual({ ok: false, reason: 'too-soon' });
    const expired = [ask({ createdAt: T0, expiresAt: now - 1 })];
    expect(
      pickMonitorApprovalTarget({ text: 'ok', asks: expired, displayedKey: monitorAskIdentity(expired[0]), displayedSince: T0, now }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('withPendingApprovals (stuck vs awaiting your OK)', () => {
  const agent = (over: Partial<MonitorAgentSnapshot>): MonitorAgentSnapshot => ({
    state: 'RUNNING',
    lines: [],
    note: null,
    logs: 1,
    totalLogs: 2,
    tokens: 0,
    usd: null,
    updatedAgoSec: 101,
    stale: true,
    ...over,
  });
  const snap = (over: Partial<MonitorSnapshot> = {}): MonitorSnapshot => ({
    t: T0,
    agents: { s0: agent({ state: 'DONE', stale: false }), s1: agent({}) },
    approvalPending: false,
    approvalAgentId: null,
    complete: false,
    chat: [],
    run: { outcome: 'running', elapsedSec: 120 },
    ...over,
  });

  it('no pending approval: unchanged — a silent RUNNING step still reads stale', () => {
    const s = snap();
    expect(withPendingApprovals(s, 0)).toBe(s);
    expect(s.agents.s1.stale).toBe(true);
  });

  it('pending approval: the RUNNING step awaits your OK instead of looking stuck', () => {
    const out = withPendingApprovals(snap(), 3);
    expect(out.agents.s1).toMatchObject({ stale: false, awaitingApproval: true });
    expect(out.agents.s0.awaitingApproval).toBeUndefined();
    expect(out.approvalPending).toBe(true);
    expect(out.approvalAgentId).toBe('s1');
  });

  it('keeps the step the progress log already marks as waiting', () => {
    const out = withPendingApprovals(snap({ approvalPending: true, approvalAgentId: 's0' }), 1);
    expect(out.approvalAgentId).toBe('s0');
  });

  it('a finished run waits on nobody', () => {
    const s = snap({ run: { outcome: 'failed', elapsedSec: 300 } });
    expect(withPendingApprovals(s, 2)).toBe(s);
  });
});

describe('registry', () => {
  beforeEach(() => __resetPendingApprovalsForTest());

  it('upsert / remove notify subscribers; identity only changes on a change', () => {
    let calls = 0;
    const unsub = subscribePendingApprovals(() => {
      calls++;
    });
    const a = ask({ hex: 'aaaaaaaa' });
    upsertPendingApproval(a);
    const first = getPendingApprovals();
    expect(first).toHaveLength(1);
    expect(getPendingApprovals()).toBe(first);
    // Same key replaces, never duplicates.
    upsertPendingApproval({ ...a, detail: 'changed' });
    expect(getPendingApprovals()).toHaveLength(1);
    expect(getPendingApprovals()[0].detail).toBe('changed');
    removePendingApproval('escalation:nope|nope');
    expect(calls).toBe(2);
    removePendingApproval(a.key);
    expect(getPendingApprovals()).toHaveLength(0);
    expect(calls).toBe(3);
    unsub();
    upsertPendingApproval(a);
    expect(calls).toBe(3);
  });

  it('keys separate action approvals (per run) from escalations (per run + request)', () => {
    expect(pendingApprovalKey('action', 'run-1')).toBe('action:run-1');
    expect(pendingApprovalKey('escalation', 'run-1', 'req-1')).toBe('escalation:run-1|req-1');
    expect(pendingApprovalKey('escalation', 'run-1', 'req-2')).not.toBe(pendingApprovalKey('escalation', 'run-1', 'req-1'));
  });
});
