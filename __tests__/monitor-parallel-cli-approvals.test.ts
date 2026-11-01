/**
 * Parallel CLI steps Inc3 — MONITOR / chat side of two CLI branches of one
 * attended run that both wait on the human at once:
 *  - monitor-live lists EVERY waiting step (approvalAgentIds), not just the first;
 *  - withPendingApprovals keeps a really-running sibling branch as it is when
 *    the progress log already accounts for every pending ask;
 *  - MONITOR shows two asks; a bare OK / NO only answers the oldest (after the
 *    1.5 s visibility guard), "ok <hash8>" answers the 2nd;
 *  - the chat ask text for a concurrent 2nd ask asks for "OK <hash8>";
 *  - cliBranchOverlap (the finish log's overlapMs) from progress.jsonl.
 */
import { cliBranchOverlap, parseProgressJsonl, type MonitorRun } from '@/lib/agent-progress';
import { createLiveSource } from '@/lib/monitor-live';
import type { PendingActionApprovalMarker } from '@/lib/agent-action-chat-reply';
import {
  MONITOR_ASK_MIN_SHOWN_MS,
  MONITOR_MAX_SHOWN_ASKS,
  chatAskTextKey,
  monitorAskIdentity,
  monitorShownAsks,
  pendingApprovalKey,
  pendingApprovalsForAgent,
  pickMonitorApprovalTarget,
  snapshotApprovalAgentIds,
  withPendingApprovals,
  type PendingApprovalAsk,
} from '@/lib/agent-pending-approvals';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

const T0 = Date.parse('2026-11-01T07:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
type Ev = Record<string, unknown>;

function textFrom(events: Ev[], runId = 'r1', agentId = 'agent-1'): string {
  return events
    .map((e, i) => JSON.stringify({ v: 1, runId, agentId, seq: i + 1, ts: at((e.sec as number) ?? i), ...e }))
    .join('\n');
}
function runFrom(events: Ev[]): MonitorRun {
  const run = parseProgressJsonl(textFrom(events));
  if (!run) throw new Error('no run');
  return run;
}
const start = (sec = 0): Ev => ({ kind: 'run_start', mode: 'PARALLEL', stepCount: 3, sec });
const state = (stepIndex: number, s: string, sec: number): Ev => ({ kind: 'branch_state', stepIndex, state: s, sec, groupId: stepIndex < 2 ? 'g' : undefined });
const cliTool = (stepIndex: number, engine: string, sec: number): Ev => ({ kind: 'tool', stepIndex, tool: engine, provider: { kind: 'CLI', name: `cli:${engine}` }, sec });
const apiTool = (stepIndex: number, sec: number): Ev => ({ kind: 'tool', stepIndex, tool: 'Local LLM', provider: { kind: 'LOCAL', name: 'local' }, sec });
const end = (sec: number): Ev => ({ kind: 'run_end', status: 'success', sec });

function ask(hex: string, createdAt: number, reqId = `req-${hex}`, runId = `run-${hex}`): PendingApprovalAsk {
  const marker: PendingActionApprovalMarker = {
    runId,
    requestSha256: hex + 'f'.repeat(56),
    hash8: hex,
    reviewRequired: false,
    createdAt,
    expiresAt: null,
    kind: 'escalation',
    reqId,
  };
  return {
    key: pendingApprovalKey('escalation', runId, reqId),
    kind: 'escalation',
    agentId: 'agent-1',
    messageId: `m-${hex}`,
    marker,
    what: 'it wants to run a command outside its allowed boundary',
    detail: 'git push',
  };
}

describe('monitor-live: two branches waiting at once', () => {
  it('approvalAgentIds lists every APPROVAL step in step order; approvalAgentId stays the first', () => {
    const run = runFrom([
      start(),
      state(0, 'RUNNING', 1), cliTool(0, 'codex', 1),
      state(1, 'RUNNING', 1), cliTool(1, 'claude', 1),
      state(1, 'WAITING_APPROVAL', 3),
      state(0, 'WAITING_APPROVAL', 4),
    ]);
    const snap = createLiveSource(run).snapshot(T0 + 5000, []);
    expect(snap.approvalPending).toBe(true);
    expect(snap.approvalAgentIds).toEqual(['s0', 's1']);
    expect(snap.approvalAgentId).toBe('s0');
  });

  it('no waiting step: empty list, not pending', () => {
    const run = runFrom([start(), state(0, 'RUNNING', 1), state(1, 'RUNNING', 1)]);
    const snap = createLiveSource(run).snapshot(T0 + 5000, []);
    expect(snap.approvalAgentIds).toEqual([]);
    expect(snap.approvalPending).toBe(false);
  });
});

describe('withPendingApprovals with a parallel sibling', () => {
  const run = runFrom([
    start(),
    state(0, 'RUNNING', 1), cliTool(0, 'codex', 1),
    state(1, 'RUNNING', 1), cliTool(1, 'claude', 1),
    state(0, 'WAITING_APPROVAL', 3),
  ]);
  // 200 s later: s1 has had no event for a while (stale).
  const base = createLiveSource(run).snapshot(T0 + 200_000, []);

  it('one ask, the log marks s0 as waiting: s1 really runs and keeps its own state', () => {
    expect(base.agents.s1.stale).toBe(true);
    const out = withPendingApprovals(base, 1);
    expect(out.agents.s1.awaitingApproval).toBeUndefined();
    expect(out.agents.s1.stale).toBe(true);
    expect(out.approvalAgentIds).toEqual(['s0']);
  });

  it('two asks but only one marked yet: every running step reads as waiting (as before)', () => {
    const out = withPendingApprovals(base, 2);
    expect(out.agents.s1).toMatchObject({ awaitingApproval: true, stale: false });
    expect(out.approvalAgentIds).toEqual(['s0']);
  });

  it('snapshotApprovalAgentIds falls back to the single id of older sources', () => {
    expect(snapshotApprovalAgentIds({ approvalAgentId: 'ch4' })).toEqual(['ch4']);
    expect(snapshotApprovalAgentIds({ approvalAgentId: null })).toEqual([]);
    expect(snapshotApprovalAgentIds({ approvalAgentId: 's0', approvalAgentIds: ['s0', 's1'] })).toEqual(['s0', 's1']);
  });
});

describe('MONITOR: two asks shown, hash8 targets the 2nd', () => {
  const first = ask('aaaaaaaa', T0);
  const second = ask('bbbbbbbb', T0 + 400);
  const third = ask('cccccccc', T0 + 900);
  const asks = pendingApprovalsForAgent([second, third, first], 'agent-1');

  it('shows the two oldest; a 3rd+ is only counted', () => {
    expect(MONITOR_MAX_SHOWN_ASKS).toBe(2);
    expect(monitorShownAsks(asks).map((a) => a.marker.hash8)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  const now = T0 + 10_000;
  it('a bare OK answers the oldest (displayed for >= 1.5 s), never the 2nd', () => {
    const pick = pickMonitorApprovalTarget({
      text: 'ok', asks, displayedKey: monitorAskIdentity(first), displayedSince: now - MONITOR_ASK_MIN_SHOWN_MS, now,
    });
    expect(pick).toMatchObject({ ok: true, decision: 'accept' });
    expect(pick.ok && pick.ask.key).toBe(first.key);
  });

  it('a bare OK right after the oldest appeared is refused (visibility guard kept)', () => {
    const pick = pickMonitorApprovalTarget({
      text: 'OK', asks, displayedKey: monitorAskIdentity(first), displayedSince: now - 100, now,
    });
    expect(pick).toEqual({ ok: false, reason: 'too-soon' });
  });

  it('"ok <hash8>" / "no <hash8>" answer the 2nd ask directly', () => {
    for (const [text, decision] of [['ok bbbbbbbb', 'accept'], ['NO bbbbbbbb', 'decline'], ['拒否 bbbbbbbb', 'decline']] as const) {
      const pick = pickMonitorApprovalTarget({
        text, asks, displayedKey: monitorAskIdentity(first), displayedSince: now - 100, now,
      });
      expect(pick).toMatchObject({ ok: true, decision });
      expect(pick.ok && pick.ask.key).toBe(second.key);
    }
  });

  it('a 2nd ask younger than the chat min age is still too soon even by hash', () => {
    const fresh = ask('dddddddd', now - 500);
    const pick = pickMonitorApprovalTarget({
      text: 'ok dddddddd', asks: [first, fresh], displayedKey: monitorAskIdentity(first), displayedSince: now - 5000, now,
    });
    expect(pick).toEqual({ ok: false, reason: 'too-soon' });
  });
});

describe('chat ask text for a concurrent 2nd ask', () => {
  it('picks the "answer by its code" variant only while another ask of the agent is pending', () => {
    expect(chatAskTextKey(false, 0)).toBe('agent_action_chat.ask');
    expect(chatAskTextKey(true, 0)).toBe('agent_action_chat.ask_review');
    expect(chatAskTextKey(false, 1)).toBe('agent_action_chat.ask_concurrent');
    expect(chatAskTextKey(true, 2)).toBe('agent_action_chat.ask_review_concurrent');
  });

  it('both locales tell the user to reply OK / NO followed by the code', () => {
    for (const dict of [en, ja] as Array<Record<string, string>>) {
      for (const key of ['agent_action_chat.ask_concurrent', 'agent_action_chat.ask_review_concurrent', 'monitor.live.approval_ask_other']) {
        const text = dict[key];
        expect(typeof text).toBe('string');
        expect(text).toMatch(/(OK|ok) \{\{hash\}\}/);
        expect(text).toMatch(/(NO|no) \{\{hash\}\}/);
      }
    }
  });
});

describe('cliBranchOverlap (finish log overlapMs)', () => {
  it('two CLI branches RUNNING 1–12 s and 2–15 s overlap for 10 s', () => {
    const text = textFrom([
      start(),
      state(0, 'RUNNING', 1), cliTool(0, 'codex', 1),
      state(1, 'RUNNING', 2), cliTool(1, 'claude', 2),
      state(0, 'DONE', 12),
      state(1, 'DONE', 15),
      state(2, 'RUNNING', 16), apiTool(2, 16),
      state(2, 'DONE', 18),
      end(19),
    ]);
    expect(cliBranchOverlap(text, 'r1')).toEqual({ cliBranches: 2, overlapMs: 10_000 });
  });

  it('a WAITING_APPROVAL gap is not RUNNING time', () => {
    const text = textFrom([
      start(),
      state(0, 'RUNNING', 0), cliTool(0, 'codex', 0),
      state(1, 'RUNNING', 0), cliTool(1, 'claude', 0),
      state(0, 'WAITING_APPROVAL', 2),
      state(0, 'RUNNING', 6),
      state(0, 'DONE', 10),
      state(1, 'DONE', 10),
      end(11),
    ]);
    // overlap 0–2 s and 6–10 s.
    expect(cliBranchOverlap(text, 'r1').overlapMs).toBe(6_000);
  });

  it('serialized CLI branches (slot wait) touch but do not overlap; a non-CLI sibling is not counted', () => {
    const text = textFrom([
      start(),
      state(0, 'RUNNING', 0), cliTool(0, 'codex', 0),
      state(1, 'RUNNING', 0), apiTool(1, 0),
      state(0, 'DONE', 5),
      state(2, 'RUNNING', 5), cliTool(2, 'claude', 5),
      state(1, 'DONE', 7),
      state(2, 'DONE', 9),
      end(9),
    ]);
    expect(cliBranchOverlap(text, 'r1')).toEqual({ cliBranches: 2, overlapMs: 0 });
  });

  it('a branch still RUNNING at run_end is closed there; other runs / bad lines are ignored', () => {
    const ours = textFrom([
      start(),
      state(0, 'RUNNING', 0), cliTool(0, 'codex', 0),
      state(1, 'RUNNING', 1), cliTool(1, 'claude', 1),
      end(4),
    ]);
    const other = textFrom([start(), state(0, 'RUNNING', 0), cliTool(0, 'codex', 0), state(1, 'RUNNING', 0), cliTool(1, 'claude', 0), end(100)], 'r0');
    expect(cliBranchOverlap(`${other}\nnot json\n${ours}`, 'r1')).toEqual({ cliBranches: 2, overlapMs: 3_000 });
    expect(cliBranchOverlap('', 'r1')).toEqual({ cliBranches: 0, overlapMs: 0 });
  });
});
