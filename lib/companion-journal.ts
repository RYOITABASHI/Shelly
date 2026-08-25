/**
 * lib/companion-journal.ts — "一人の相棒" Gap② (2026-08-25).
 *
 * Session digests for the companion journal: when a pane's bound provider
 * switches away from a conversation, distill what was established in that
 * conversation into a short note and save it to the `_companion` memory
 * scope (lib/agent-memory.ts), so it outlives the raw thread even though
 * the thread itself may not (a non-companion AIPaneConversation is dropped
 * on restart — see store/ai-pane-store.ts's load() / the ghost-thread-
 * revival fix). The raw transcript stays exactly where it already lives;
 * this module never touches conversation storage, only the memory-note
 * store.
 *
 * Deliberately auto-write, no confirm turn — unlike `_global` notes (which
 * fan out to every registered agent and therefore go through a mandatory
 * human confirm, see lib/agent-global-memory-intent.ts), a `_companion`
 * note's blast radius is one chat thread. The tradeoff accepted here:
 * occasional low-value or slightly-off notes, editable/deletable later,
 * in exchange for the companion actually feeling like it remembers without
 * the user having to explicitly say "remember that" every time.
 */
import {
  COMPANION_MEMORY_SCOPE,
  makeMemoryNote,
  writeMemoryNote,
} from '@/lib/agent-memory';
import { ollamaChat, type LocalLlmConfig, type OllamaMessage } from '@/lib/local-llm';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { ChatMessage } from '@/store/types';

/** Below this many eligible messages, a switch isn't worth an LLM round-trip. */
const MIN_MESSAGES_TO_DIGEST = 4;
/** Bounds the digest prompt's size/latency regardless of how long the thread got. */
const MAX_DIGEST_INPUT_MESSAGES = 20;
const DIGEST_TIMEOUT_MS = 30_000;
const DIGEST_MAX_TOKENS = 200;

// Module-level, in-memory only (never persisted): the id of the last
// message already folded into a digest, per source conversation key. A
// restart already drops every non-companion conversation (ghost-thread-
// revival fix), so there is nothing meaningful to resume from after a
// kill — the next switch just starts fresh, exactly like carry-forward's
// own no-persistence-carve-out decision.
const lastDigestedMessageId = new Map<string, string>();

/** Same exclusion list as ai-pane-store.ts's isCarryForwardEligible, kept
 *  as a local mirror rather than an import so this module stays
 *  store-agnostic (it only knows ChatMessage, never touches Zustand
 *  state) — the two lists must be kept in sync by hand if either changes. */
function isDigestEligible(m: ChatMessage): boolean {
  if (m.role !== 'user' && m.role !== 'assistant') return false;
  if (m.isStreaming) return false;
  if (m.agentDraft || m.agentCardState || m.agentChatConfirm || m.editingAgentId) return false;
  if (m.pendingSlotFill || m.pendingGlobalMemory || m.pendingAgentDelete) return false;
  if (m.scheduleReadinessCard || m.agentRollbackOffer) return false;
  if (m.approvalData || m.wizardType || m.autoCheckState) return false;
  if (m.agentRunLogId) return false;
  return true;
}

/**
 * Digest the tail of a conversation that's about to be left (a thread
 * switch) into a companion-journal note. Fire-and-forget by design — never
 * await this on a dispatch's critical path; it only feeds FUTURE
 * conversations, not the current turn.
 */
export async function digestConversationForJournal(
  sourceKey: string,
  messages: ChatMessage[],
  config: LocalLlmConfig,
  runCommand: (cmd: string) => Promise<string>,
): Promise<void> {
  if (!config.baseUrl) return;
  const eligible = messages.filter(isDigestEligible);
  if (eligible.length < MIN_MESSAGES_TO_DIGEST) return;

  const lastId = eligible[eligible.length - 1].id;
  if (lastDigestedMessageId.get(sourceKey) === lastId) return; // nothing new since the last digest

  const tail = eligible.slice(-MAX_DIGEST_INPUT_MESSAGES);
  const transcript = tail.map((m) => `${m.role}: ${m.content}`).join('\n');

  const digestMessages: OllamaMessage[] = [
    {
      role: 'system',
      content:
        'Summarize the durable facts, decisions, and preferences established in this ' +
        'conversation in 1-3 short sentences, written as a note for later. Skip ' +
        'pleasantries and anything already obvious from context. If nothing in this ' +
        'conversation is worth remembering later, reply with exactly: NOTHING',
    },
    { role: 'user', content: transcript },
  ];

  try {
    const result = await ollamaChat(config, digestMessages, DIGEST_TIMEOUT_MS, undefined, DIGEST_MAX_TOKENS);
    if (!result.success) return; // leave the marker unset so a transient failure retries next switch

    const text = result.content.trim();
    // Widened past an exact "NOTHING" match (2026-08-25 review finding): a
    // 2B-class local model won't reliably follow "reply with exactly X" to
    // the letter, and a stray "NOTHING worth remembering." matched by only
    // an exact-equality check would have been saved as a junk note.
    if (!text || /^nothing\b/i.test(text)) {
      lastDigestedMessageId.set(sourceKey, lastId); // successfully decided there's nothing to save -- don't re-ask
      return;
    }

    const note = makeMemoryNote({ agentId: COMPANION_MEMORY_SCOPE, type: 'fact', text });
    await writeMemoryNote(runCommand, note);
    // Only mark this tail as digested once the note is actually on disk —
    // 2026-08-25 review finding: setting this right after the LLM call
    // succeeded (before the write was attempted) meant a write failure
    // alone was never retried on a later switch, even though the LLM half
    // of the work had genuinely succeeded.
    lastDigestedMessageId.set(sourceKey, lastId);
    logInfo('CompanionJournal', `digested ${eligible.length} messages from ${sourceKey}`);
  } catch (e: any) {
    logWarn('CompanionJournal', 'digest failed', e?.message ?? e);
  }
}
