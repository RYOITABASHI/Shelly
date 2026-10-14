/**
 * lib/closepaw-shell-reply.ts — pure helpers for the `shelly closepaw` Shelly
 * approval (Shelly-trusted ClosePaw variant): goal hash, pending-list parsing
 * and the dedicated in-app chat reply. No React Native / native imports, so
 * it is unit-testable; lib/closepaw-shell-approval.ts re-exports it.
 */
import { sanitizeClosePawGoal } from './agent-intent-review';
import { agentAddSha256Hex } from './agent-add-approval';

export type ClosePawShellPending = { reqId: string; goal: string; hash8: string; expiresAt: number };

const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;
const HASH8_RE = /^[0-9a-f]{8}$/;

/** Mirrors ClosePawShellApprovals.hash8 (native): first 8 hex of
 *  sha256("shelly-closepaw-shell-v1\n" + sanitized goal). */
export async function closePawShellHash8(goal: string): Promise<string> {
  return (await agentAddSha256Hex(`shelly-closepaw-shell-v1\n${sanitizeClosePawGoal(goal)}`)).slice(0, 8);
}

export function parseClosePawShellPendingList(raw: unknown): ClosePawShellPending[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (p): p is ClosePawShellPending =>
      !!p &&
      typeof p === 'object' &&
      REQ_ID_RE.test(String((p as ClosePawShellPending).reqId)) &&
      HASH8_RE.test(String((p as ClosePawShellPending).hash8)) &&
      typeof (p as ClosePawShellPending).goal === 'string',
  );
}

/** Minimum age of the chat line before a typed reply may resolve it, so a
 *  request that arrives asynchronously cannot catch an "OK" the user was
 *  typing for something else. */
export const CLOSEPAW_CHAT_REPLY_MIN_AGE_MS = 10_000;
export const CLOSEPAW_CHAT_REPLY_MAX_AGE_MS = 10 * 60_000;

/**
 * Security-review fix (2026-10-14): a bare confirm phrase ("OK", "はい") is
 * NEVER a ClosePaw approval — it could be the user's answer to an agent draft.
 * The reply must be dedicated AND name the request by its goal hash:
 *   approve: "ClosePaw OK <hash8>", "OK <hash8>", "承認 <hash8>", "approve <hash8>", "実行 <hash8>"
 *   reject:  "ClosePaw cancel <hash8>", "却下 <hash8>", "キャンセル <hash8>", "reject <hash8>", "cancel <hash8>"
 * Returns the decision and the hash it names, or null.
 */
export function parseClosePawChatReply(text: string): { decision: 'approve' | 'reject'; hash8: string } | null {
  const t = String(text ?? '').trim().replace(/[。.!！]+$/, '').replace(/\s+/g, ' ');
  const m = /^(?:closepaw\s*)?(ok|okay|承認|実行|approve|却下|キャンセル|reject|cancel)\s*[:：]?\s*([0-9a-f]{8})$/i.exec(t);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const decision = ['ok', 'okay', '承認', '実行', 'approve'].includes(word) ? 'approve' : 'reject';
  return { decision, hash8: m[2].toLowerCase() };
}

/** Which pending ClosePaw chat line (if any) a typed reply resolves. Pure. */
export function findClosePawChatReplyTarget(params: {
  text: string;
  messages: ReadonlyArray<{ id: string; role: string; pendingClosePawShell?: { reqId: string; hash8: string; createdAt: number } }>;
  now: number;
  /** An agent draft confirm / slot-fill question is open: never steal it. */
  otherPromptOpen: boolean;
}): { messageId: string; reqId: string; hash8: string; decision: 'approve' | 'reject' } | null {
  if (params.otherPromptOpen) return null;
  const reply = parseClosePawChatReply(params.text);
  if (!reply) return null;
  for (let i = params.messages.length - 1, seen = 0; i >= 0 && seen < 30; i--, seen++) {
    const m = params.messages[i];
    const p = m.role === 'assistant' ? m.pendingClosePawShell : undefined;
    if (!p || p.hash8 !== reply.hash8) continue;
    const age = params.now - p.createdAt;
    if (age < CLOSEPAW_CHAT_REPLY_MIN_AGE_MS || age > CLOSEPAW_CHAT_REPLY_MAX_AGE_MS) return null;
    return { messageId: m.id, reqId: p.reqId, hash8: p.hash8, decision: reply.decision };
  }
  return null;
}
