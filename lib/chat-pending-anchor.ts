/**
 * lib/chat-pending-anchor.ts — which message a pending-reply check should
 * look at (2026-10-06, hand-off narration review fix).
 *
 * Several flows ask a question and treat the user's NEXT message as the
 * answer (pendingApiKeyProvider — the raw key, masked and never sent to an
 * LLM; pendingGlobalMemory; pendingSlotFill). They used to inspect the
 * literal last message of the conversation. Out-of-band lines can now be
 * appended between the question and the answer at any moment — agent
 * hand-off narration (lib/agent-handoff.ts), background run completion /
 * start notices (lib/agent-companion-notice.ts), thread-switch system
 * notices — and that silently disarmed the pending state: a pasted API key
 * was then neither masked nor intercepted, and went out as a normal prompt.
 *
 * The anchor is the last message that is part of the actual turn-taking:
 * not a system line, not a hand-off line, not a background-run notice.
 * A user message is always an anchor, so a real reply still clears it.
 */

import type { ChatMessage } from '@/store/types';

/** True for app-injected informational lines that never answer or ask. */
export function isOutOfBandNotice(m: ChatMessage): boolean {
  if (m.role === 'system') return true;
  if (m.handoff) return true;
  if (m.role === 'assistant' && (m.agentRunLogId || m.id.startsWith('agent-run-started-'))) return true;
  return false;
}

/** Last conversational message (see module doc), or undefined. */
export function lastPromptAnchorMessage(messages: readonly ChatMessage[] | undefined): ChatMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isOutOfBandNotice(messages[i])) return messages[i];
  }
  return undefined;
}
