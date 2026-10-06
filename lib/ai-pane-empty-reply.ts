/**
 * Empty-assistant-bubble guard for the AI pane (2026-10-06 on-device bug:
 * the companion thread showed a column of EMPTY assistant bubbles).
 *
 * A plain assistant message is "just text": nothing but the text fields
 * below. Anything carrying another payload (agent draft card, schedule
 * readiness card, wizard, approval data, executions, citations, hand-off
 * marker, ...) renders something other than its `content`, so an empty
 * `content` there is legitimate and must never be dropped or rewritten.
 */
import type { ChatMessage } from '@/store/types';

const PLAIN_ASSISTANT_KEYS = new Set<string>([
  'id',
  'role',
  'content',
  'timestamp',
  'agent',
  'isStreaming',
  'streamingText',
  'tokenCount',
  'streamingStartTime',
  'llmModelLabel',
  'error',
  'carriedFromId',
  'flowTurn',
]);

/** True for a text-only assistant message whose visible text is empty —
 *  i.e. one that would render as an empty bubble. `streamingText` counts as
 *  visible text (AIPane renders `streamingText ?? content`). */
export function isEmptyPlainAssistantMessage(m: ChatMessage | undefined | null): boolean {
  if (!m || m.role !== 'assistant') return false;
  if ((m.content ?? '').trim()) return false;
  if ((m.streamingText ?? '').trim()) return false;
  for (const [key, value] of Object.entries(m)) {
    if (value === undefined || value === null || value === false) continue;
    if (!PLAIN_ASSISTANT_KEYS.has(key)) return false;
  }
  return true;
}
