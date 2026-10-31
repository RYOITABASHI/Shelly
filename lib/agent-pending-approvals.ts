/**
 * lib/agent-pending-approvals.ts — the human approvals an agent is waiting on
 * RIGHT NOW, as one in-memory list the MONITOR pane reads (2026-10-31).
 *
 * Two kinds, both already mirrored as plain-text ask lines into the agent's
 * own chat thread by lib/agent-action-chat-approval.ts:
 *   - 'action':     a per-run ACTION approval (AgentActionApprovalBridge,
 *                   notification "「…」を許可しますか？").
 *   - 'escalation': a CLI worker's boundary-op escalation
 *                   (AgentEscalationBridge, notification "境界操作を許可しますか？").
 *
 * Pure: no React Native / native / store imports, so it is unit-testable
 * under plain Node. The list only DESCRIBES what is pending — it holds no
 * nonce and cannot resolve anything. Answering goes through
 * lib/agent-action-chat-approval.ts (resolvePendingApprovalFromMonitor),
 * which re-reads natively and resolves through the same native call as the
 * notification. Entries are added when the RN drain posts the ask and
 * removed when the request is answered (anywhere), consumed or expires.
 */
import {
  ACTION_CHAT_REPLY_MIN_AGE_MS,
  isPendingMarkerAnswerable,
  parseActionApprovalChatReply,
  type ChatApprovalDecision,
  type PendingActionApprovalMarker,
} from './agent-action-chat-reply';
import type { MonitorSnapshot } from './monitor-source';

export type PendingApprovalKind = 'action' | 'escalation';

export interface PendingApprovalAsk {
  /** Stable identity: `action:<runId>` or `escalation:<runId>|<reqId>`. */
  key: string;
  kind: PendingApprovalKind;
  agentId: string;
  /** The ask line in the agent's thread that carries `marker`. */
  messageId: string;
  marker: PendingActionApprovalMarker;
  /** Plain-language "what it is about to do" (already localized). */
  what: string;
  /** The resolved detail (command, host, …), possibly multi-line. */
  detail: string;
}

export function pendingApprovalKey(kind: PendingApprovalKind, runId: string, reqId?: string): string {
  return kind === 'escalation' ? `escalation:${runId}|${reqId ?? ''}` : `action:${runId}`;
}

// ── Registry ────────────────────────────────────────────────────────────────

let entries: readonly PendingApprovalAsk[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // one listener's failure must not block the others
    }
  }
}

export function upsertPendingApproval(ask: PendingApprovalAsk): void {
  entries = [...entries.filter((e) => e.key !== ask.key), ask];
  emit();
}

export function removePendingApproval(key: string): void {
  if (!entries.some((e) => e.key === key)) return;
  entries = entries.filter((e) => e.key !== key);
  emit();
}

/** Immutable snapshot (identity changes only on a change — safe for
 *  useSyncExternalStore). */
export function getPendingApprovals(): readonly PendingApprovalAsk[] {
  return entries;
}

export function subscribePendingApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function __resetPendingApprovalsForTest(): void {
  entries = [];
  listeners.clear();
}

// ── Pure presentation / answering rules ─────────────────────────────────────

/** One agent's pending asks, OLDEST first (the order MONITOR answers them
 *  in, one at a time). Ties keep a stable order by key. */
export function pendingApprovalsForAgent(
  list: readonly PendingApprovalAsk[],
  agentId: string | null | undefined,
): PendingApprovalAsk[] {
  if (!agentId) return [];
  return list
    .filter((e) => e.agentId === agentId)
    .sort((a, b) => a.marker.createdAt - b.marker.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Minimum time the ask must have been ON SCREEN in MONITOR before a bare
 *  OK / NO answers it: when the oldest ask is answered the next one takes its
 *  place, and an "OK" typed for the previous one must not land on it. */
export const MONITOR_ASK_MIN_SHOWN_MS = 1_500;

export type MonitorApprovalPick =
  | { ok: true; ask: PendingApprovalAsk; decision: ChatApprovalDecision }
  | { ok: false; reason: 'not-a-reply' | 'nothing-pending' | 'unknown-hash' | 'too-soon' | 'expired' };

/**
 * Which pending ask a line typed into MONITOR's approval field answers.
 *  - Only a whole-message OK / NO (the chat's matcher,
 *    parseActionApprovalChatReply) — anything else is 'not-a-reply'.
 *  - A bare reply answers the DISPLAYED ask, which must be the oldest
 *    pending one and must have been on screen for MONITOR_ASK_MIN_SHOWN_MS.
 *  - "ok <hash8>" answers the pending ask with that binding (any position).
 *  - The ask itself must be answerable (same age / deadline window as chat).
 */
export function pickMonitorApprovalTarget(params: {
  text: string;
  asks: readonly PendingApprovalAsk[];
  displayedKey: string | null;
  displayedSince: number;
  now: number;
}): MonitorApprovalPick {
  const reply = parseActionApprovalChatReply(params.text);
  if (!reply) return { ok: false, reason: 'not-a-reply' };
  if (!params.asks.length) return { ok: false, reason: 'nothing-pending' };
  let ask: PendingApprovalAsk | undefined;
  if (reply.hash8) {
    ask = params.asks.find((a) => a.marker.hash8 === reply.hash8);
    if (!ask) return { ok: false, reason: 'unknown-hash' };
  } else {
    ask = params.asks[0];
    if (params.displayedKey !== ask.key || params.now - params.displayedSince < MONITOR_ASK_MIN_SHOWN_MS) {
      return { ok: false, reason: 'too-soon' };
    }
  }
  if (!isPendingMarkerAnswerable(ask.marker, params.now)) {
    return {
      ok: false,
      reason: params.now - ask.marker.createdAt < ACTION_CHAT_REPLY_MIN_AGE_MS ? 'too-soon' : 'expired',
    };
  }
  return { ok: true, ask, decision: reply.decision };
}

/**
 * LIVE snapshot with this agent's pending approvals applied:
 *  - a RUNNING step reads "waiting for your OK" (awaitingApproval) instead of
 *    "no update for Ns — stuck?" — it is blocked on the human, not stuck;
 *  - the run counts as waiting on the human (approvalPending), pointing at
 *    the step the progress log already marks, else the first running one.
 * No pending ask, or a run that is over → the snapshot is returned unchanged
 * (same object).
 */
export function withPendingApprovals(snap: MonitorSnapshot, pendingCount: number): MonitorSnapshot {
  if (pendingCount <= 0) return snap;
  // A finished run waits on nobody (a leftover ask is retired by the drain).
  if (snap.run && snap.run.outcome !== 'running') return snap;
  const agents: MonitorSnapshot['agents'] = {};
  let firstRunning: string | null = null;
  for (const [id, a] of Object.entries(snap.agents)) {
    if (a.state === 'RUNNING') {
      if (firstRunning === null) firstRunning = id;
      agents[id] = { ...a, stale: false, awaitingApproval: true };
    } else {
      agents[id] = a;
    }
  }
  return {
    ...snap,
    agents,
    approvalPending: true,
    approvalAgentId: snap.approvalAgentId ?? firstRunning,
  };
}
