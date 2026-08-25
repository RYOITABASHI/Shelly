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
 *
 * Fable5 product-review gaps (2026-08-25), both addressed here:
 *  - Gap A (silent dormancy): a cloud-only user with no local LLM configured
 *    used to get a totally silent no-op on every switch — the journal exists
 *    but never indicates it's inactive. `digestConversationForJournal` now
 *    takes an optional `onDormant` callback, fired only when there was
 *    genuinely enough eligible content to be worth journaling (same
 *    MIN_MESSAGES_TO_DIGEST floor a real digest uses) but no baseUrl to
 *    write it with. The caller (components/panes/AIPane.tsx) uses this to
 *    surface a ONE-TIME plain-chat notice (lib/agent-companion-notice.ts's
 *    postCompanionJournalDormancyNotice) gated by
 *    AppSettings.companionJournalDormancyNoticeShown, plus a persistent
 *    banner in the Companion Memory view — this module itself stays
 *    settings-store-agnostic (matching the rest of its design), it only
 *    signals the condition.
 *  - Gap B (legacy-only storage): a successful digest now writes through the
 *    MEMORY-001 engine first (lib/memory/shadow.ts's activateMemoryWrite,
 *    gated by MEMORY_ENABLED — see lib/memory/wiring.ts), falling back to
 *    G2's own writeMemoryNote only when MEMORY_ENABLED is false or the v2
 *    write reports an internal failure. Exactly the same v2-primary /
 *    G2-fallback contract lib/agent-manager.ts's persistRememberFact already
 *    uses for per-agent "remember that" facts — see that function's comment
 *    for the precedent this mirrors.
 */
import {
  COMPANION_MEMORY_SCOPE,
  makeMemoryNote,
  writeMemoryNote,
} from '@/lib/agent-memory';
import { ollamaChat, type LocalLlmConfig, type OllamaMessage } from '@/lib/local-llm';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { ChatMessage } from '@/store/types';
// MEMORY-001 shadow/activation seam (live: MEMORY_ENABLED=true since
// 2026-08-05, see lib/memory/wiring.ts): imported from their own modules
// (not the '@/lib/memory' index), same reasoning as agent-manager.ts's own
// import comment — keeps any test that merely imports this file from
// transitively loading expo-file-system via fs-expo.ts.
import { MEMORY_ENABLED } from '@/lib/memory/wiring';
import { activateMemoryWrite } from '@/lib/memory/shadow';

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
  onDormant?: () => void,
): Promise<void> {
  const eligible = messages.filter(isDigestEligible);
  if (eligible.length < MIN_MESSAGES_TO_DIGEST) return;

  if (!config.baseUrl) {
    // Gap A: only signal dormancy when there was actually something worth
    // journaling (the same floor a real digest requires) — a pane switch on
    // an empty/short conversation must not spam the caller's one-time-nudge
    // check every time.
    onDormant?.();
    return;
  }

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
    // Gap B: MEMORY-001 v2-primary / G2-fallback write, mirroring
    // lib/agent-manager.ts's persistRememberFact exactly. activateMemoryWrite
    // reuses makeMemoryNote's own normalization internally and never throws
    // (false = any internal failure), so a `false` result here — or
    // MEMORY_ENABLED itself being false — falls back to G2's writeMemoryNote
    // rather than silently losing the note. On v2 success the G2 write below
    // is skipped entirely, same as persistRememberFact's `if (ok) return`.
    const wroteViaV2 = MEMORY_ENABLED
      ? await activateMemoryWrite({ agentId: COMPANION_MEMORY_SCOPE, type: 'fact', text })
      : false;
    if (!wroteViaV2) {
      await writeMemoryNote(runCommand, note);
    }
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
