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
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import { tFor, useI18n, type Locale } from '@/lib/i18n';
import { logInfo, logWarn } from '@/lib/debug-logger';
import { REVIEW_REQUIRED_ACTION_TYPES } from '@/lib/agent-action-types';
import {
  decideActionApprovalFromChat,
  type ActionApprovalReplyTarget,
  type ChatApprovalDecision,
  type ChatApprovalOutcome,
  type PendingActionApprovalMarker,
} from '@/lib/agent-action-chat-reply';

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

/** Where each pending run's ask line lives (for retiring it later). */
const asks = new Map<string, { agentId: string; messageId: string; requestSha256: string; hash8: string }>();

function retireAsk(runId: string, closingKey: string | null, l: Locale): void {
  const ask = asks.get(runId);
  if (!ask) return;
  asks.delete(runId);
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
    const sha = req.requestSha256 ?? '';
    if (!HEX_SHA256_RE.test(sha) || !req.runId || !req.agentId) return;
    const prev = asks.get(req.runId);
    if (prev && prev.requestSha256 === sha) return;
    const l = locale();
    if (prev) retireAsk(req.runId, 'agent_action_chat.superseded', l);
    const name =
      req.agentName?.trim() || useAgentStore.getState().agents.find((a) => a.id === req.agentId)?.name || req.agentId;
    const reviewRequired = isReviewRequiredActionType(req.actionType);
    const hash8 = sha.slice(0, 8);
    const { what, detail } = describe(req, l);
    const content = tFor(l, reviewRequired ? 'agent_action_chat.ask_review' : 'agent_action_chat.ask', {
      name,
      what,
      detail: detail ? `${detail}\n` : '',
      hash: hash8,
    });
    const marker: PendingActionApprovalMarker = {
      runId: req.runId,
      requestSha256: sha,
      hash8,
      reviewRequired,
      createdAt: Date.now(),
      expiresAt: typeof req.expiresAt === 'number' ? req.expiresAt : null,
    };
    const id = newId();
    useAIPaneStore.getState().addMessage(agentThreadKey(req.agentId), {
      id,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      pendingActionApproval: marker,
    });
    asks.set(req.runId, { agentId: req.agentId, messageId: id, requestSha256: sha, hash8 });
    logInfo('AgentActionChat', `ask posted run=${req.runId} type=${req.actionType} review=${reviewRequired}`);
  } catch (e) {
    logWarn('AgentActionChat', `ask post failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The request is no longer pending (answered from the notification / review
 *  screen, consumed by a chat answer, or expired): retire the chat line. */
export function noteActionApprovalGone(runId: string): void {
  try {
    retireAsk(runId, 'agent_action_chat.answered_elsewhere', locale());
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
  if (!TerminalEmulator.readAgentActionApprovalRequest || !TerminalEmulator.resolveAgentActionApproval) {
    return tFor(replyLocale, 'agent_action_chat.unavailable');
  }
  const outcome = await decideActionApprovalFromChat(marker, decision as ChatApprovalDecision, {
    read: async (runId) => {
      const r = await TerminalEmulator.readAgentActionApprovalRequest!(runId);
      return r && typeof r === 'object' ? { runId: r.runId, actionType: r.actionType, requestSha256: r.requestSha256, actionNonce: r.actionNonce, expiresAt: r.expiresAt } : null;
    },
    resolve: (runId, d, sha, nonce) => TerminalEmulator.resolveAgentActionApproval!(runId, d, sha, nonce),
    requestReview: requestActionReview,
    now: Date.now,
    reviewRequired: isReviewRequiredActionType,
  });
  logInfo('AgentActionChat', `chat ${decision} run=${marker.runId}: ${outcome}`);
  if (outcome !== 'failed') {
    const ask = asks.get(marker.runId);
    if (ask && ask.messageId === target.messageId) asks.delete(marker.runId);
    useAIPaneStore.getState().updateMessage(conversationKey, target.messageId, { pendingActionApproval: undefined });
  }
  return tFor(replyLocale, outcomeKey(outcome));
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
