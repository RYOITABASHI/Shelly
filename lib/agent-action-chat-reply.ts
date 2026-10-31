/**
 * lib/agent-action-chat-reply.ts — pure helpers for answering an agent's
 * per-run ACTION approval from its own chat thread (2026-10-31, MONITOR
 * OPEN CHAT follow-up). No React Native / native / store imports, so it is
 * unit-testable under plain Node; lib/agent-action-chat-approval.ts wires it
 * to the chat store and the native bridge.
 *
 * Authority model (unchanged by this file — read before touching it):
 *   The ONLY thing that resolves an action approval is
 *   AgentActionApprovalBridge.writeHumanReply (native, Keystore-signed
 *   reply, single-use nonce, request-hash binding). The notification's
 *   Allow / Deny buttons and the in-app review screen both end there. The
 *   chat reply implemented here ends there too, through the same two native
 *   calls the review screen uses — readAgentActionApprovalRequest (mints the
 *   nonce at the moment of the decision) followed immediately by
 *   resolveAgentActionApproval — so there is no third place that can say
 *   "accept". The chat line itself never carries a nonce: it is posted
 *   WITHOUT minting one, so the notification's own buttons stay valid until
 *   the user actually answers somewhere.
 *
 *   One answer wins, everywhere: the native nonce ledger holds one nonce per
 *   run, and writeHumanReply removes the request file. Whichever side answers
 *   first consumes the request; the other side's next attempt fails natively
 *   ("no longer pending" / "stale"), the RN drain cancels the notification,
 *   and noteActionApprovalGone() retires the chat line.
 *
 *   Review-required types (cli / intent / dm-reply / browser-pane /
 *   social-post — lib/agent-action-types.ts REVIEW_REQUIRED_ACTION_TYPES) are
 *   NEVER accepted by a chat "OK": the chat "OK" opens the same review screen
 *   the notification's Review button opens (decideActionApprovalFromChat →
 *   'review'), exactly as the notification has no one-tap Allow for them.
 *   A chat "NO" declines them directly, as the notification's Deny does.
 */

export type ChatApprovalDecision = 'accept' | 'decline';

/** Marker carried by the plain-text ask line in the agent's chat thread. */
export interface PendingActionApprovalMarker {
  runId: string;
  /** sha256 of the request file shown in the line (hex, 64 chars). */
  requestSha256: string;
  /** First 8 hex chars of requestSha256, shown in the line as the binding. */
  hash8: string;
  reviewRequired: boolean;
  createdAt: number;
  expiresAt?: number | null;
}

/** Minimum age of the chat line before a typed reply may resolve it, so a
 *  request that lands asynchronously cannot catch an "OK" the user was
 *  typing for something else (same rationale as lib/closepaw-shell-reply.ts). */
export const ACTION_CHAT_REPLY_MIN_AGE_MS = 3_000;
/** Fallback window when the request carries no expiresAt. */
export const ACTION_CHAT_REPLY_MAX_AGE_MS = 30 * 60_000;

const ACCEPT_WORDS = ['ok', 'okay', 'yes', 'allow', 'approve', 'go ahead', 'はい', '許可', '承認', '実行', 'いいよ', 'おっけー', 'オッケー'];
const DECLINE_WORDS = ['no', 'nope', 'deny', 'decline', 'reject', 'cancel', 'stop', 'いいえ', '拒否', '却下', 'だめ', 'ダメ', 'やめて', 'キャンセル', '中止'];

/**
 * Parse a typed reply. Whole-message match only (after trimming trailing
 * punctuation), optionally followed by the 8-hex binding shown in the ask
 * line: "ok", "NO", "ok 1a2b3c4d", "拒否 1a2b3c4d". Never a substring match,
 * so "make it snappier, ok?" is not an approval.
 */
export function parseActionApprovalChatReply(text: string): { decision: ChatApprovalDecision; hash8: string | null } | null {
  const t = String(text ?? '')
    .trim()
    .replace(/[。.!！]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const m = /^(.+?)(?:\s*[:：]?\s*([0-9a-f]{8}))?$/.exec(t);
  if (!m) return null;
  const word = m[1].trim();
  const hash8 = m[2] ? m[2].toLowerCase() : null;
  if (ACCEPT_WORDS.includes(word)) return { decision: 'accept', hash8 };
  if (DECLINE_WORDS.includes(word)) return { decision: 'decline', hash8 };
  return null;
}

export interface ActionApprovalReplyTarget {
  messageId: string;
  marker: PendingActionApprovalMarker;
  decision: ChatApprovalDecision;
}

type MarkerMessage = { id: string; role: string; pendingActionApproval?: PendingActionApprovalMarker };

/**
 * Which pending action-approval line (if any) a typed reply resolves. Pure.
 *
 * A bare "OK"/"NO" only answers the LATEST assistant line of the thread, and
 * only when that line is a pending ask — a reply always resolves the most
 * recently asked question, and never an older one scrolled out of view. A
 * reply that names the binding ("ok 1a2b3c4d") may answer an older pending
 * line (within the last 30 messages). While some other question is open
 * (agent draft confirm, slot-fill, …) nothing is stolen.
 */
export function findActionApprovalReplyTarget(params: {
  text: string;
  messages: ReadonlyArray<MarkerMessage>;
  now: number;
  otherPromptOpen: boolean;
}): ActionApprovalReplyTarget | null {
  if (params.otherPromptOpen) return null;
  const reply = parseActionApprovalChatReply(params.text);
  if (!reply) return null;
  const { messages, now } = params;
  const inWindow = (p: PendingActionApprovalMarker) => {
    const age = now - p.createdAt;
    if (age < ACTION_CHAT_REPLY_MIN_AGE_MS) return false;
    const deadline = typeof p.expiresAt === 'number' && p.expiresAt > 0 ? p.expiresAt : p.createdAt + ACTION_CHAT_REPLY_MAX_AGE_MS;
    return now <= deadline;
  };
  if (reply.hash8) {
    for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 30; i--, seen++) {
      const m = messages[i];
      const p = m.role === 'assistant' ? m.pendingActionApproval : undefined;
      if (!p || p.hash8 !== reply.hash8) continue;
      return inWindow(p) ? { messageId: m.id, marker: p, decision: reply.decision } : null;
    }
    return null;
  }
  // Bare reply: the latest assistant line must be the ask.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const p = m.pendingActionApproval;
    if (!p) return null;
    return inWindow(p) ? { messageId: m.id, marker: p, decision: reply.decision } : null;
  }
  return null;
}

/** What the request looks like when re-read natively at decision time. */
export interface MintedActionRequest {
  runId: string;
  actionType: string;
  requestSha256?: string | null;
  actionNonce?: string | null;
  expiresAt?: number | null;
}

export interface ChatApprovalDeps {
  /** readAgentActionApprovalRequest: re-reads the request and mints the
   *  single-use nonce. Rejects / returns null when nothing is pending. */
  read: (runId: string) => Promise<MintedActionRequest | null>;
  /** resolveAgentActionApproval: the native writeHumanReply. */
  resolve: (runId: string, decision: ChatApprovalDecision, requestSha256: string, actionNonce: string) => Promise<void>;
  /** Opens the in-app review screen for a review-required accept (the same
   *  path as the notification's Review button). */
  requestReview: (runId: string) => void;
  now: () => number;
  reviewRequired: (actionType: string) => boolean;
}

export type ChatApprovalOutcome =
  | 'accepted'
  | 'declined'
  /** Review-required type + "OK": the review screen was opened instead. */
  | 'review'
  /** Nothing pending any more (answered elsewhere / consumed / expired). */
  | 'gone'
  /** The pending request's content differs from the line the user read. */
  | 'changed'
  | 'expired'
  | 'failed';

/**
 * Apply a chat decision through the native approval path. Order matters:
 *  1. review-required + accept → hand to the review screen WITHOUT touching
 *     the nonce ledger here (the review screen mints its own when it reads).
 *  2. otherwise re-read (mints the nonce now), require the content hash to
 *     equal the one the chat line showed, require not expired, then resolve
 *     with that fresh nonce. A failure after minting leaves a dangling nonce
 *     that the next notification / review read simply replaces.
 */
export async function decideActionApprovalFromChat(
  marker: PendingActionApprovalMarker,
  decision: ChatApprovalDecision,
  deps: ChatApprovalDeps,
): Promise<ChatApprovalOutcome> {
  if (decision === 'accept' && marker.reviewRequired) {
    deps.requestReview(marker.runId);
    return 'review';
  }
  let minted: MintedActionRequest | null;
  try {
    minted = await deps.read(marker.runId);
  } catch {
    return 'gone';
  }
  if (!minted || minted.runId !== marker.runId) return 'gone';
  const sha = minted.requestSha256 ?? '';
  const nonce = minted.actionNonce ?? '';
  if (!sha || !nonce) return 'failed';
  if (sha !== marker.requestSha256) return 'changed';
  if (typeof minted.expiresAt === 'number' && minted.expiresAt > 0 && minted.expiresAt < deps.now()) return 'expired';
  // The type is re-checked on the minted copy: a chat "OK" never accepts a
  // review-required action even if the marker was built from a stale read.
  if (decision === 'accept' && deps.reviewRequired(minted.actionType)) {
    deps.requestReview(marker.runId);
    return 'review';
  }
  try {
    await deps.resolve(marker.runId, decision, sha, nonce);
  } catch {
    return 'failed';
  }
  return decision === 'accept' ? 'accepted' : 'declined';
}
