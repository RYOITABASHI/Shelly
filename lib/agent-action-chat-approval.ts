/**
 * lib/agent-action-chat-approval.ts — RN side of answering a background
 * agent's per-run ACTION approval from the agent's own chat thread
 * (`agent:<id>`, the pane MONITOR's OPEN CHAT focuses). 2026-10-31 on-device
 * finding (DEFERRED.md MONITOR 2026-10-31 (1)): OPEN CHAT led to an empty
 * chat; the only place to answer was the Android notification.
 *
 * What this adds — and, more importantly, what it does NOT add:
 *   - postActionApprovalAsk(): the RN approval drain (app/_layout.tsx) calls
 *     it right where it posts the notification. It writes ONE plain-text
 *     line into the agent's thread ("<agent> is waiting for your OK: …
 *     Reply OK / NO [hash8]"). No card, no buttons (standing product rule).
 *     It does NOT read the request through the native bridge, so no nonce is
 *     minted and the notification's own Allow / Deny stay valid.
 *   - resolveActionApprovalFromChat(): a typed OK / NO (matched by
 *     hooks/use-ai-pane-dispatch.ts through lib/agent-action-chat-reply.ts)
 *     goes through decideActionApprovalFromChat: re-read natively (mints the
 *     single-use nonce now), require the same content hash the line showed,
 *     then resolveAgentActionApproval — the identical two calls the in-app
 *     review screen makes. Review-required types never accept from chat; an
 *     "OK" opens the review screen through requestActionReview() (the same
 *     handler as the notification's Review deep link).
 *   - noteActionApprovalGone(): the drain calls it when the request file is
 *     gone (answered anywhere, consumed, expired). The chat line loses its
 *     marker, so a later "OK" is just text, and one closing line says so.
 *
 * Single-use / consistency comes from native, not from here: one nonce per
 * run in AgentActionApprovalBridge, consumed by the first writeHumanReply,
 * which also deletes the request file. The chat path only ever presents a
 * nonce it minted milliseconds earlier in the same call.
 *
 * 2026-10-31 additions (MONITOR typed approval, on-device bug #3):
 *   - Boundary-op ESCALATIONS of a CLI worker (AgentEscalationBridge,
 *     notification "境界操作を許可しますか？") are mirrored too:
 *     postEscalationAsk() / noteEscalationGone(). A typed OK / NO resolves
 *     them through readAgentEscalationRequest (mints the nonce in
 *     AgentEscalationBridge's per-(run, req) ledger) +
 *     resolveAgentEscalationApproval (AgentEscalationBridge.writeHumanReply,
 *     the exact call the notification's Allow / Deny make).
 *   - Every posted ask is also listed in lib/agent-pending-approvals.ts so
 *     the MONITOR pane can show it and take a typed OK / NO
 *     (resolvePendingApprovalFromMonitor). That list carries no nonce.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import { tFor, useI18n, type Locale } from '@/lib/i18n';
import { logInfo, logWarn } from '@/lib/debug-logger';
import { REVIEW_REQUIRED_ACTION_TYPES } from '@/lib/agent-action-types';
import {
  decideActionApprovalFromChat,
  decideEscalationApprovalFromChat,
  type ActionApprovalReplyTarget,
  type ChatApprovalDecision,
  type ChatApprovalOutcome,
  type PendingActionApprovalMarker,
} from '@/lib/agent-action-chat-reply';
import {
  pendingApprovalKey,
  removePendingApproval,
  upsertPendingApproval,
  type PendingApprovalAsk,
} from '@/lib/agent-pending-approvals';

export * from '@/lib/agent-action-chat-reply';

/** The fields of an approval request the ask line describes (a structural
 *  subset of app/_layout.tsx's AgentActionApprovalRequest). */
export interface ActionApprovalAskRequest {
  runId: string;
  agentId: string;
  agentName?: string | null;
  actionType: string;
  preview?: string | null;
  destinationHost?: string | null;
  command?: string | null;
  safetyLevel?: string | null;
  expiresAt?: number | null;
  requestSha256?: string | null;
  intentMode?: string | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
  dmPairingLabel?: string | null;
  dmReplyText?: string | null;
  browserPaneActionKind?: string | null;
  browserPaneSelector?: string | null;
}

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const DETAIL_MAX = 300;

export function isReviewRequiredActionType(actionType: string): boolean {
  return (REVIEW_REQUIRED_ACTION_TYPES as readonly string[]).includes(actionType);
}

function clip(s: string): string {
  const cps = Array.from(s.replace(/\s+/g, ' ').trim());
  return cps.length > DETAIL_MAX ? `${cps.slice(0, DETAIL_MAX).join('')}…` : cps.join('');
}

function newId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function locale(): Locale {
  return useI18n.getState().locale;
}

/** Plain-language "what it is about to do" + the resolved detail. */
function describe(req: ActionApprovalAskRequest, l: Locale): { what: string; detail: string } {
  const what = tFor(l, `agent_action_chat.what.${req.actionType}`);
  const parts: string[] = [];
  switch (req.actionType) {
    case 'cli':
      if (req.command) parts.push(req.command);
      if (req.safetyLevel) parts.push(`${tFor(l, 'agent_action_confirm_safety')}: ${req.safetyLevel}`);
      break;
    case 'intent':
      if (req.intentMode === 'closepaw') parts.push(req.intentShareText ?? '');
      else parts.push(`${req.intentMode ?? ''}: ${req.intentTarget ?? ''}`);
      break;
    case 'dm-reply':
      if (req.dmPairingLabel) parts.push(req.dmPairingLabel);
      if (req.dmReplyText) parts.push(req.dmReplyText);
      break;
    case 'browser-pane':
      parts.push(`${req.browserPaneActionKind ?? ''}: ${req.browserPaneSelector ?? ''}`);
      break;
    case 'webhook':
    case 'api-call':
    case 'social-post':
      if (req.destinationHost) parts.push(req.destinationHost);
      if (req.command) parts.push(req.command);
      if (req.preview) parts.push(req.preview);
      break;
    default:
      if (req.preview) parts.push(req.preview);
  }
  const detail = parts.map((p) => clip(p)).filter(Boolean).join('\n');
  return { what: what === `agent_action_chat.what.${req.actionType}` ? req.actionType : what, detail };
}

/** Where each pending ask line lives (for retiring it later), keyed by
 *  pendingApprovalKey(): `action:<runId>` / `escalation:<runId>|<reqId>`. */
const asks = new Map<string, { agentId: string; messageId: string; requestSha256: string; hash8: string }>();

function retireAsk(askKey: string, closingKey: string | null, l: Locale): void {
  removePendingApproval(askKey);
  const ask = asks.get(askKey);
  if (!ask) return;
  asks.delete(askKey);
  const key = agentThreadKey(ask.agentId);
  const store = useAIPaneStore.getState();
  const msg = store.conversations[key]?.messages.find((m) => m.id === ask.messageId);
  if (!msg?.pendingActionApproval) return;
  store.updateMessage(key, ask.messageId, { pendingActionApproval: undefined });
  if (closingKey) {
    store.addMessage(key, {
      id: newId(),
      role: 'assistant',
      content: tFor(l, closingKey, { hash: ask.hash8 }),
      timestamp: Date.now(),
    });
  }
}

/**
 * Mirror a pending human approval into the agent's thread, once per request
 * content (runId + requestSha256). A re-request of the same run with other
 * content retires the old line first. Never throws, never reads natively.
 */
export function postActionApprovalAsk(req: ActionApprovalAskRequest): void {
  try {
    if (!req.runId || !req.agentId) return;
    const l = locale();
    const reviewRequired = isReviewRequiredActionType(req.actionType);
    const { what, detail } = describe(req, l);
    postAsk({
      kind: 'action',
      agentId: req.agentId,
      agentName: req.agentName,
      runId: req.runId,
      requestSha256: req.requestSha256,
      reviewRequired,
      expiresAt: typeof req.expiresAt === 'number' ? req.expiresAt : null,
      what,
      detail,
      locale: l,
    });
    logInfo('AgentActionChat', `ask posted run=${req.runId} type=${req.actionType} review=${reviewRequired}`);
  } catch (e) {
    logWarn('AgentActionChat', `ask post failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The fields of a boundary-op escalation request the ask line describes (a
 *  structural subset of app/_layout.tsx's AgentEscalationRequest). */
export interface EscalationAskRequest {
  runId: string;
  reqId: string;
  agentId: string;
  command: string;
  cwd?: string | null;
  reason?: string | null;
  /** sha256 of the request file, as native computed it when it posted the
   *  notification (notifyAgentEscalationApprovalNeeded's result). */
  requestSha256?: string | null;
}

/**
 * Mirror a pending boundary-op escalation into the agent's thread (bug #3:
 * OPEN CHAT showed no question for these). Once per request content. Never
 * throws, never mints a nonce — the notification's Allow / Deny stay valid.
 */
export function postEscalationAsk(req: EscalationAskRequest): void {
  try {
    if (!req.runId || !req.reqId || !req.agentId || !req.command) return;
    const l = locale();
    const parts = [clip(req.command)];
    if (req.reason) parts.push(tFor(l, 'agent_action_chat.escalation_reason', { reason: clip(req.reason) }));
    if (req.cwd) parts.push(tFor(l, 'agent_action_chat.escalation_cwd', { cwd: clip(req.cwd) }));
    postAsk({
      kind: 'escalation',
      agentId: req.agentId,
      runId: req.runId,
      reqId: req.reqId,
      requestSha256: req.requestSha256,
      reviewRequired: false,
      expiresAt: null,
      what: tFor(l, 'agent_action_chat.what.escalation'),
      detail: parts.join('\n'),
      locale: l,
    });
    logInfo('AgentActionChat', `escalation ask posted run=${req.runId} req=${req.reqId}`);
  } catch (e) {
    logWarn('AgentActionChat', `escalation ask post failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function postAsk(p: {
  kind: 'action' | 'escalation';
  agentId: string;
  agentName?: string | null;
  runId: string;
  reqId?: string;
  requestSha256?: string | null;
  reviewRequired: boolean;
  expiresAt: number | null;
  what: string;
  detail: string;
  locale: Locale;
}): void {
  const sha = p.requestSha256 ?? '';
  if (!HEX_SHA256_RE.test(sha)) return;
  const askKey = pendingApprovalKey(p.kind, p.runId, p.reqId);
  const prev = asks.get(askKey);
  if (prev && prev.requestSha256 === sha) return;
  const l = p.locale;
  if (prev) retireAsk(askKey, 'agent_action_chat.superseded', l);
  const name =
    p.agentName?.trim() || useAgentStore.getState().agents.find((a) => a.id === p.agentId)?.name || p.agentId;
  const hash8 = sha.slice(0, 8);
  const content = tFor(l, p.reviewRequired ? 'agent_action_chat.ask_review' : 'agent_action_chat.ask', {
    name,
    what: p.what,
    detail: p.detail ? `${p.detail}\n` : '',
    hash: hash8,
  });
  const marker: PendingActionApprovalMarker = {
    runId: p.runId,
    requestSha256: sha,
    hash8,
    reviewRequired: p.reviewRequired,
    createdAt: Date.now(),
    expiresAt: p.expiresAt,
    ...(p.kind === 'escalation' ? { kind: 'escalation' as const, reqId: p.reqId } : {}),
  };
  const id = newId();
  useAIPaneStore.getState().addMessage(agentThreadKey(p.agentId), {
    id,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    pendingActionApproval: marker,
  });
  asks.set(askKey, { agentId: p.agentId, messageId: id, requestSha256: sha, hash8 });
  upsertPendingApproval({ key: askKey, kind: p.kind, agentId: p.agentId, messageId: id, marker, what: p.what, detail: p.detail });
}

/** The request is no longer pending (answered from the notification / review
 *  screen, consumed by a chat answer, or expired): retire the chat line. */
export function noteActionApprovalGone(runId: string): void {
  try {
    retireAsk(pendingApprovalKey('action', runId), 'agent_action_chat.answered_elsewhere', locale());
  } catch {
    // best-effort
  }
}

/** The escalation is no longer pending for the live run (answered from the
 *  notification, consumed, cleaned up by the driver, or queued after the
 *  live wait timed out): retire the chat line and the MONITOR entry. */
export function noteEscalationGone(runId: string, reqId: string, reason: 'answered' | 'expired' = 'answered'): void {
  try {
    retireAsk(
      pendingApprovalKey('escalation', runId, reqId),
      reason === 'expired' ? 'agent_action_chat.escalation_expired' : 'agent_action_chat.answered_elsewhere',
      locale(),
    );
  } catch {
    // best-effort
  }
}

// ── Review screen hand-off (review-required types) ──────────────────────────
// app/_layout.tsx subscribes and runs the same handleAgentActionConfirm the
// notification's Review deep link runs.
type ReviewListener = (runId: string) => void;
const reviewListeners = new Set<ReviewListener>();

export function subscribeActionReviewRequests(listener: ReviewListener): () => void {
  reviewListeners.add(listener);
  return () => {
    reviewListeners.delete(listener);
  };
}

export function requestActionReview(runId: string): void {
  for (const l of [...reviewListeners]) {
    try {
      l(runId);
    } catch {
      // a listener's failure must not block the others
    }
  }
}

/**
 * Apply a typed OK / NO. Returns the assistant line to post in reply. The
 * marker is removed from the ask line for every outcome except 'failed'
 * (so the user can retry) — for 'review' the review screen owns it now.
 */
export async function resolveActionApprovalFromChat(
  target: ActionApprovalReplyTarget,
  /** The thread (conversation key) the ask line lives in. */
  conversationKey: string,
  replyLocale: Locale = locale(),
): Promise<string> {
  const { marker, decision } = target;
  const isEscalation = marker.kind === 'escalation';
  let outcome: ChatApprovalOutcome;
  if (isEscalation) {
    if (!TerminalEmulator.readAgentEscalationRequest || !TerminalEmulator.resolveAgentEscalationApproval) {
      return tFor(replyLocale, 'agent_action_chat.unavailable');
    }
    outcome = await decideEscalationApprovalFromChat(marker, decision as ChatApprovalDecision, {
      read: async (runId, reqId) => {
        const r = await TerminalEmulator.readAgentEscalationRequest!(runId, reqId);
        return r && typeof r === 'object'
          ? { runId: r.runId, reqId: r.reqId, state: r.state, requestSha256: r.requestSha256, actionNonce: r.actionNonce }
          : null;
      },
      resolve: (runId, reqId, d, sha, nonce) => TerminalEmulator.resolveAgentEscalationApproval!(runId, reqId, d, sha, nonce),
    });
  } else {
    if (!TerminalEmulator.readAgentActionApprovalRequest || !TerminalEmulator.resolveAgentActionApproval) {
      return tFor(replyLocale, 'agent_action_chat.unavailable');
    }
    outcome = await decideActionApprovalFromChat(marker, decision as ChatApprovalDecision, {
      read: async (runId) => {
        const r = await TerminalEmulator.readAgentActionApprovalRequest!(runId);
        return r && typeof r === 'object' ? { runId: r.runId, actionType: r.actionType, requestSha256: r.requestSha256, actionNonce: r.actionNonce, expiresAt: r.expiresAt } : null;
      },
      resolve: (runId, d, sha, nonce) => TerminalEmulator.resolveAgentActionApproval!(runId, d, sha, nonce),
      requestReview: requestActionReview,
      now: Date.now,
      reviewRequired: isReviewRequiredActionType,
    });
  }
  logInfo(
    'AgentActionChat',
    `chat ${decision} ${isEscalation ? `escalation run=${marker.runId} req=${marker.reqId}` : `run=${marker.runId}`}: ${outcome}`,
  );
  if (outcome !== 'failed') {
    const askKey = isEscalation
      ? pendingApprovalKey('escalation', marker.runId, marker.reqId)
      : pendingApprovalKey('action', marker.runId);
    const ask = asks.get(askKey);
    if (ask && ask.messageId === target.messageId) {
      asks.delete(askKey);
      // 'review': still pending (the review screen answers it) — MONITOR
      // keeps listing it until the drain sees the request gone.
      if (outcome !== 'review') removePendingApproval(askKey);
    }
    useAIPaneStore.getState().updateMessage(conversationKey, target.messageId, { pendingActionApproval: undefined });
  }
  return tFor(replyLocale, outcomeKey(outcome));
}

/**
 * MONITOR's typed OK / NO (components/panes/MonitorPane.tsx — called ONLY
 * from its approval TextInput's submit handler, i.e. the user's own
 * keystrokes, the MONITOR equivalent of the chat's `typedByUser`). Records
 * the exchange in the agent's thread (so OPEN CHAT shows what was answered)
 * and resolves through resolveActionApprovalFromChat — the very same native
 * read-then-resolve as a chat reply. Returns the reply line.
 */
export async function resolvePendingApprovalFromMonitor(
  ask: PendingApprovalAsk,
  decision: ChatApprovalDecision,
  typedText: string,
): Promise<string> {
  const key = agentThreadKey(ask.agentId);
  const store = useAIPaneStore.getState();
  store.addMessage(key, { id: newId(), role: 'user', content: typedText.trim(), timestamp: Date.now() });
  const reply = await resolveActionApprovalFromChat({ messageId: ask.messageId, marker: ask.marker, decision }, key);
  useAIPaneStore.getState().addMessage(key, { id: newId(), role: 'assistant', content: reply, timestamp: Date.now() });
  return reply;
}

function outcomeKey(outcome: ChatApprovalOutcome): string {
  switch (outcome) {
    case 'accepted':
      return 'agent_action_chat.accepted';
    case 'declined':
      return 'agent_action_chat.declined';
    case 'review':
      return 'agent_action_chat.review';
    case 'gone':
      return 'agent_action_chat.gone';
    case 'changed':
      return 'agent_action_chat.changed';
    case 'expired':
      return 'agent_action_chat.expired';
    default:
      return 'agent_action_chat.failed';
  }
}
