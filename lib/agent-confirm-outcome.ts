/**
 * lib/agent-confirm-outcome.ts — where a confirmed agent draft's outcome
 * ("registered" / "running…" / result / failure) is written in the chat.
 *
 * 2026-10-31 on-device finding (agent-mvvx3o28): confirmAgentDraft used to
 * rewrite the ORIGINAL draft bubble in place. For a typed confirm the user's
 * "OK" is appended BELOW that bubble first, so the transcript read
 *
 *   assistant: 了解しました。「…」を登録しました。   ← the draft bubble, rewritten
 *   user:      OK
 *
 * i.e. "registered" appeared BEFORE the OK that actually triggered it. Nothing
 * was persisted before the OK (createAgent only runs inside confirmAgentDraft,
 * which the typed OK / a button tap calls), but on a security-relevant confirm
 * gate the transcript must never suggest otherwise.
 *
 * Rule: when anything was posted after the draft bubble (the typed OK, or any
 * other turn), the outcome goes into a NEW assistant message at the bottom;
 * the draft bubble only gets its card state flipped (so its buttons go away).
 * When the draft bubble is still the last message (a tap on its own buttons),
 * the in-place update is kept — there is nothing to be out of order with.
 */
import type { ChatMessage } from '@/store/types';

export type ConfirmOutcomeTarget = 'in-place' | 'new-message';

export function resolveConfirmOutcomeTarget(
  messages: ReadonlyArray<Pick<ChatMessage, 'id'>>,
  draftMessageId: string,
): ConfirmOutcomeTarget {
  const idx = messages.findIndex((m) => m.id === draftMessageId);
  // A vanished draft bubble keeps the old behavior (the caller's own
  // update-or-fallback already posts a new message for that case).
  if (idx === -1) return 'in-place';
  return idx < messages.length - 1 ? 'new-message' : 'in-place';
}

/** Split one outcome update into the part that belongs on the draft bubble
 *  (its card state only) and the part that belongs on the outcome message. */
export function splitConfirmOutcomeUpdate(updates: Partial<ChatMessage>): {
  draftBubble: Partial<ChatMessage> | null;
  outcome: Partial<ChatMessage>;
} {
  const { agentCardState, ...outcome } = updates;
  return {
    draftBubble: agentCardState !== undefined ? { agentCardState } : null,
    outcome,
  };
}
