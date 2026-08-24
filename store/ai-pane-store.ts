/**
 * store/ai-pane-store.ts
 *
 * AI conversation store for the Superset UI redesign. The local Shelly
 * persona shares one conversation; explicit-provider panes remain independent.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, ChatAgent } from './types';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { SlotField } from '@/lib/agent-slot-fill';
import { logInfo, logWarn, logError } from '@/lib/debug-logger';
import { usePaneStore } from '@/store/pane-store';

export const COMPANION_CONVERSATION_KEY = '__companion__';

/**
 * Resolve the conversation key for a multi-pane slot. The default Shelly
 * persona shares one persistent thread; explicitly routed providers retain
 * the pane-local histories they have always used.
 */
export function resolveAiPaneStoreKey(paneId: string): string {
  const bound = usePaneStore.getState().paneAgents[paneId];
  return bound == null || bound === 'local' ? COMPANION_CONVERSATION_KEY : paneId;
}

export function addAiPaneThreadSwitchNotice(
  previousKey: string,
  nextKey: string,
  translate: (key: string) => string,
): void {
  if (previousKey === nextKey) return;
  useAIPaneStore.getState().addMessage(nextKey, {
    id: `system-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'system',
    content: translate(nextKey === COMPANION_CONVERSATION_KEY
      ? 'chat.switched_to_companion_thread'
      : 'chat.switched_to_pane_thread'),
    timestamp: Date.now(),
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Session-scoped (per-pane) pending state for a chat-native agent draft
 * registration (Phase A, 2026-07-22). Unlike the pre-existing
 * `ChatMessage.pendingSlotFill` (store/types.ts), which lives on the
 * MOST RECENT message and breaks if a single unrelated message lands in
 * between question and answer, this lives on the CONVERSATION itself — a
 * reply to a chat-native draft's await-confirm step is routed correctly
 * regardless of what else appeared in the pane meanwhile.
 *
 * Scope note: this is currently wired up ONLY for `phase: 'await-confirm'`
 * (see hooks/use-ai-pane-dispatch.ts's presentDraftForConfirmation, which
 * sets it right after posting a chat-native draft message, and dispatch()'s
 * new routing block, which reads it before falling through to the existing
 * message-attached slot-fill routing). The pre-existing schedule/
 * notificationTrigger/outputPath/socialConnector slot-fill conversation
 * (lib/agent-slot-fill.ts) deliberately keeps using the message-attached
 * `pendingSlotFill` mechanism unchanged — migrating that flow to this
 * session-scoped shape too is future work, not required for this phase, and
 * risked regressing the extensively-tested existing slot-fill behavior for
 * no in-scope benefit. `phase: 'slot-fill'` / `awaitingField` are part of
 * this type's shape for that future migration but are not currently set by
 * any caller.
 */
export interface PendingAgentSession {
  draft: ParsedAgentDraft;
  /** Present when this chat confirmation edits an already-registered agent. */
  editingAgentId?: string;
  /** 'llm-conversation' (2026-08-02): Tier 3 of the agent-registration flow
   *  — the LLM is driving a multi-turn clarification dialogue (see
   *  docs/superpowers/specs/2026-08-02-agent-conversational-registration-plan.md).
   *  Routed the same way slot-fill/await-confirm already are: keyed off this
   *  session's phase, reusing the SAME staleness/cancel/attemptCounts
   *  machinery rather than a parallel state shape. */
  phase: 'slot-fill' | 'await-confirm' | 'llm-conversation';
  /** Reserved for a future slot-fill migration onto this session-scoped
   *  state (see doc comment above) — not populated today. */
  awaitingField?: SlotField;
  /** Per-field retry counter, mirroring pendingSlotFill's attemptCount.
   *  Keyed loosely (e.g. 'confirm' for the await-confirm phase's own
   *  neither-confirm-nor-cancel re-ask loop) rather than by SlotField only,
   *  since this type also covers the non-slot-fill await-confirm phase. */
  attemptCounts: Record<string, number>;
  /** True when `draft` carries an assumed (not explicitly stated) value —
   *  see lib/agent-plan-summary.ts's hasDraftAssumptions. Snapshotted here
   *  at session-creation time for reference/telemetry; the actual
   *  never-auto-register enforcement lives in shouldAutoRegisterDraft
   *  itself, not this flag. */
  hasAssumptions: boolean;
  /** Session creation/last-refresh time — stale sessions (mirrors
   *  hooks/use-ai-pane-dispatch.ts's existing SLOT_FILL_STALE_MS, 15 min)
   *  are never routed into, so an abandoned draft can't hijack an unrelated
   *  later message indefinitely. */
  createdAt: number;
  /** The chat message id this session is tied to (the draft/summary
   *  bubble) — confirming/cancelling via a typed chat reply updates THIS
   *  message, exactly like tapping AgentChatConfirm's buttons already does. */
  messageId: string;
  /** Chat bubble agent label, carried through so a typed confirm/cancel
   *  reply (or a re-ask) keeps the same pane icon/color as the original
   *  draft message — mirrors pendingSlotFill's own agentLabel carry-through. */
  agentLabel?: ChatAgent;
  /** 'llm-conversation' phase only (2026-08-02): the verbatim text of the
   *  question the LLM asked on the PREVIOUS turn. Used solely by
   *  hooks/use-ai-pane-dispatch.ts to notice that a small local model has
   *  re-asked the identical question instead of consuming the user's answer
   *  (see lib/agent-conversational-registration.ts's
   *  isRepeatedRegistrationQuestion for the on-device repro), which
   *  short-circuits Tier 3 straight to Tier 2 rather than making the user
   *  answer the same thing up to five times. Never read by any other phase,
   *  and absent on a session's first question. */
  lastLlmQuestion?: string;
}

/**
 * Session-scoped (per-pane) short-lived reference to the agent this pane's
 * conversation MOST RECENTLY registered via a chat-native path — either the
 * no-approval-default auto-register fast path (presentDraftForConfirmation
 * in hooks/use-ai-pane-dispatch.ts, when shouldAutoRegisterDraft is true) or
 * a chat-native typed/tapped confirm (AgentChatConfirm / the typed
 * "register"/"OK" reply). Set right after confirmAgentDraft's registration
 * actually succeeds; NEVER set for the classic AgentConfirmCard (card-UI)
 * path — see confirmAgentDraft's own `agentChatConfirm` message-flag check.
 *
 * Purpose (2026-07-23 product-owner request): the auto-register fast path
 * has no confirmation step at all, so a slip of the tongue ("9時のはずが20時
 * と言ってしまった") previously had no quick fix short of `@agent list` +
 * manually editing the agent. While this reference is alive, dispatch()'s
 * new routing block reuses lib/agent-draft-patch.ts's applyDraftPatch
 * against `draftSnapshot` on the VERY NEXT message and, on a hit, updates
 * the ALREADY-REGISTERED agent in place (lib/agent-manager.ts's
 * updateAgent) instead of just re-editing an unregistered draft the way
 * PendingAgentSession's own patch branch (Phase C, await-confirm) does.
 *
 * Deliberately short-lived — see JUST_REGISTERED_STALE_MS in
 * hooks/use-ai-pane-dispatch.ts, a narrower window than
 * PendingAgentSession's 15-minute SLOT_FILL_STALE_MS: this is a "catch a
 * typo I just made" affordance, not a general "edit an old agent via chat"
 * feature (that's explicitly out of scope — see the task's own exclusion
 * list). A stale/expired reference is never routed into, exactly like
 * PendingAgentSession's own staleness guard.
 */
export interface JustRegisteredAgentRef {
  agentId: string;
  agentName: string;
  /** The pre-confirm draft shape lib/agent-draft-patch.ts's applyDraftPatch
   *  expects — i.e. the SAME ParsedAgentDraft the original chat-native draft
   *  bubble carried (message.agentDraft), not the ConfirmedAgentDraft shape
   *  confirmAgentDraft itself receives. Refreshed (see below) after each
   *  successful correction, so a second correction in the same window
   *  patches from the ALREADY-corrected state, not the original typo. */
  draftSnapshot: ParsedAgentDraft;
  /** The "✅ … registered" chat bubble — kept for parity with
   *  PendingAgentSession's own messageId field, though (unlike that type)
   *  nothing currently re-targets this specific message on a correction; a
   *  correction posts a NEW assistant bubble instead of editing this one. */
  messageId: string;
  /** Carried through so a correction-applied reply keeps the same pane
   *  icon/color as the original registration message — same convention as
   *  PendingAgentSession.agentLabel. */
  agentLabel?: ChatAgent;
  /** Set/refreshed on each successful correction — mirrors
   *  PendingAgentSession's createdAt-based staleness guard, and extends the
   *  window so a second, immediate follow-up correction ("あ、名前も直し
   *  て") is not left with almost no time to land. */
  createdAt: number;
}

/**
 * Runtime-only handoff slot for a prompt that originates OUTSIDE any AI Pane
 * (2026-07-29: the Scouter widget's ASK dialog handing an `@agent …` command
 * to the real AI-Pane parse + confirm-card flow, via the native pending
 * record + `shelly:///ai?widgetAgentCommand=1` deep link — see
 * app/_layout.tsx's `target === 'ai'` branch). The deep-link handler sets it;
 * the first mounted AIPane to observe it claims it atomically with
 * takePendingExternalPrompt() and feeds it through the SAME dispatch() a
 * typed submission uses — so `@agent` text lands in the identical
 * NL-parse/slot-fill/confirm flow, never a parallel registration path.
 *
 * Deliberately NOT persisted (top-level field; persist()/load() only touch
 * `conversations`): an app kill in the handoff window just drops the seed,
 * mirroring the native record's own 2-minute expiry — the user retypes, and
 * nothing half-registered survives.
 */
export interface PendingExternalPrompt {
  text: string;
  createdAt: number;
  /** Physical origin of the prompt. 'widget-ask' marks the Scouter widget's
   *  ASK-dialog handoff so dispatch() can apply the widget-scoped
   *  registration-confirm policy (AppSettings.widgetAgentRegistrationNoConfirm
   *  — see lib/widget-agent-registration.ts). Absent = treated exactly like a
   *  typed AI-Pane submission; the widget opt-in is never applied. */
  source?: 'widget-ask';
}

export type AIPaneConversation = {
  paneId: string;
  messages: ChatMessage[];
  activeAgent: ChatAgent | null;
  isStreaming: boolean;
  terminalContext: string | null;
  pendingAgentSession?: PendingAgentSession | null;
  justRegisteredAgent?: JustRegisteredAgentRef | null;
};

type AIPaneState = {
  conversations: Record<string, AIPaneConversation>;
  isLoaded: boolean;
  /** See PendingExternalPrompt — runtime-only, never persisted. */
  pendingExternalPrompt: PendingExternalPrompt | null;

  // Initialization
  load: () => Promise<void>;

  // Actions
  getOrCreate: (paneId: string) => AIPaneConversation;
  addMessage: (paneId: string, msg: ChatMessage) => void;
  /** Returns true when the message was found and updated, false on a silent
   *  no-op (stale/wrong messageId, or the message was deleted/cleared out
   *  from under the caller) — 2026-08-24, so a caller relying on this
   *  update to be the user's only visible confirmation (e.g.
   *  cancelAgentDraft) can fall back to posting a new message instead of
   *  leaving the conversation looking unresponsive. Existing callers that
   *  don't need this may ignore the return value. */
  updateMessage: (paneId: string, msgId: string, updates: Partial<ChatMessage>) => boolean;
  deleteMessage: (paneId: string, messageId: string) => void;
  setStreaming: (paneId: string, streaming: boolean) => void;
  setTerminalContext: (paneId: string, context: string | null) => void;
  setActiveAgent: (paneId: string, agent: ChatAgent | null) => void;
  clearConversation: (paneId: string) => void;
  /** Set or clear (pass null) the pane's session-scoped pending agent-draft
   *  session — see PendingAgentSession's doc comment above. */
  setPendingAgentSession: (paneId: string, session: PendingAgentSession | null) => void;
  /** Set or clear (pass null) the pane's short-lived "agent I just
   *  registered" reference — see JustRegisteredAgentRef's doc comment above. */
  setJustRegisteredAgent: (paneId: string, ref: JustRegisteredAgentRef | null) => void;
  /** Queue a prompt originating outside any AI Pane (widget ASK handoff).
   *  `source` tags the origin — see PendingExternalPrompt.source. */
  setPendingExternalPrompt: (text: string, source?: 'widget-ask') => void;
  /** Atomically claim-and-clear the pending external prompt. Returns null when
   *  nothing is pending or the entry is stale (EXTERNAL_PROMPT_STALE_MS —
   *  mirrors the native widget record's 2-minute expiry window). Synchronous,
   *  so with multiple mounted AI Panes exactly one claims it. */
  takePendingExternalPrompt: () => PendingExternalPrompt | null;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'shelly_ai_pane_conversations';
const MAX_MESSAGES_PER_PANE = 200;
const DEBOUNCE_MS = 2000;
// Mirrors ScouterStateStore.kt's WIDGET_PROMPT_EXPIRE_AFTER_MS (2 minutes):
// a widget-originated prompt that somehow sat unclaimed this long (no AI Pane
// ever mounted) should expire, not fire surprisingly later.
export const EXTERNAL_PROMPT_STALE_MS = 2 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmptyConversation(paneId: string): AIPaneConversation {
  return {
    paneId,
    messages: [],
    activeAgent: null,
    isStreaming: false,
    terminalContext: null,
  };
}

// Debounced save timer
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(saveFn: () => Promise<void>) {
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
  }
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveFn();
  }, DEBOUNCE_MS);
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAIPaneStore = create<AIPaneState>((set, get) => {
  /** Persist conversations to AsyncStorage (trimmed, no streaming state). */
  const persist = async () => {
    try {
      const { conversations } = get();
      // Strip runtime-only fields before persisting
      const serializable: Record<string, AIPaneConversation> = {};
      for (const [paneId, conv] of Object.entries(conversations)) {
        serializable[paneId] = {
          ...conv,
          isStreaming: false,
          terminalContext: null,
          messages: conv.messages.slice(-MAX_MESSAGES_PER_PANE).map((m) => ({
            ...m,
            isStreaming: false,
            streamingText: undefined,
          })),
        };
      }
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    } catch (e) {
      console.warn('[AIPaneStore] persist failed:', e);
    }
  };

  return {
    conversations: {},
    isLoaded: false,
    pendingExternalPrompt: null,

    load: async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const data = JSON.parse(raw) as Record<string, AIPaneConversation>;
          const conversations: Record<string, AIPaneConversation> = {};
          let droppedStale = false;
          for (const [paneId, conv] of Object.entries(data)) {
            // 2026-08-24 ghost-thread-revival fix: a non-companion
            // conversation is keyed by paneId only because pane-store's
            // paneAgents bound that pane to an explicit provider — and
            // paneAgents is deliberately NOT persisted across restarts
            // (see pane-store.ts: "must be reconstructed ... not restored
            // blindly"). Restoring the conversation anyway meant re-binding
            // the same pane to the same provider after a restart silently
            // resurrected old context the user had no reason to expect
            // still existed. Only the companion thread has no such binding
            // dependency, so only it survives a restart.
            if (paneId !== COMPANION_CONVERSATION_KEY) {
              droppedStale = true;
              continue;
            }
            conversations[paneId] = {
              ...conv,
              isStreaming: false,
              terminalContext: null,
            };
          }
          set({ conversations, isLoaded: true });
          // Purge the dropped entries from disk too, so a later unrelated
          // persist() (which writes the full in-memory map) isn't the only
          // thing that eventually cleans them up.
          if (droppedStale) {
            await persist();
          }
        } else {
          set({ isLoaded: true });
        }
      } catch (e) {
        logError('AIPaneStore', 'load failed', e);
        set({ isLoaded: true });
      }
    },

    getOrCreate: (paneId) => {
      const { conversations } = get();
      if (conversations[paneId]) {
        return conversations[paneId];
      }
      logInfo('AIPaneStore', 'getOrCreate: ' + paneId);
      const newConv = makeEmptyConversation(paneId);
      set((state) => ({
        conversations: { ...state.conversations, [paneId]: newConv },
      }));
      return newConv;
    },

    addMessage: (paneId, msg) => {
      logInfo('AIPaneStore', 'Message added to ' + paneId + ': ' + msg.role);
      // Ensure conversation exists
      get().getOrCreate(paneId);

      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        const messages = [...conv.messages, msg];
        // Enforce 200-message cap
        const trimmed = messages.length > MAX_MESSAGES_PER_PANE
          ? messages.slice(messages.length - MAX_MESSAGES_PER_PANE)
          : messages;
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, messages: trimmed },
          },
        };
      });

      // Debounce persistence; skip during active streaming to avoid thrashing
      if (!msg.isStreaming) {
        debouncedSave(persist);
      }
    },

    updateMessage: (paneId, msgId, updates) => {
      let found = false;
      set((state) => {
        const conv = state.conversations[paneId];
        if (!conv) return state;
        const msgIdx = conv.messages.findIndex((m) => m.id === msgId);
        if (msgIdx === -1) return state;
        found = true;

        const newMessages = [...conv.messages];
        newMessages[msgIdx] = { ...newMessages[msgIdx], ...updates };
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, messages: newMessages },
          },
        };
      });

      // bug #164 diagnostics (2026-07-28): a silent no-op here (stale/wrong
      // messageId, or the pane's conversation not yet materialized) would
      // look identical, from the caller's side, to a successful update that
      // simply never rendered — log it explicitly so a repro can rule this
      // in or out instead of guessing from a blank chat bubble.
      if (!found) {
        logWarn('AIPaneStore', `updateMessage: no-op — message ${msgId} not found in pane ${paneId}`);
        return false;
      }

      // bug #164 fix (2026-07-28): this used to persist ONLY on the exact
      // `isStreaming === false` transition (the streaming-completion case),
      // which silently skipped persistence for every OTHER kind of update —
      // including agentCardState transitions and their paired content (e.g.
      // "✅ Agent ... registered ..." in hooks/use-ai-pane-dispatch.ts's
      // confirmAgentDraft), since those updates never set `isStreaming` at
      // all. In-memory the change is still applied immediately (the `set()`
      // above is unconditional), so a live session renders correctly, but
      // the write to AsyncStorage was silently dropped — an app kill/restart
      // before the next unrelated persist-triggering update on the SAME pane
      // would revert a "registered"/"confirmed"/"cancelled" bubble back to
      // its pre-update (often empty/placeholder) seed content. Persist on
      // every update except an in-progress streaming chunk itself
      // (isStreaming: true / a streamingText delta), mirroring addMessage's
      // own `!msg.isStreaming` gate just above.
      if (updates.isStreaming !== true) {
        debouncedSave(persist);
      }
      return true;
    },

    deleteMessage: (paneId, messageId) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: {
              ...conv,
              messages: conv.messages.filter((message) => message.id !== messageId),
              // Same dangling-reference class as clearConversation's fix
              // above: long-press-deleting the specific draft-confirm or
              // just-registered bubble these fields point at must drop the
              // reference along with it, or a later "cancel"/correction
              // reply tries to updateMessage() a message that's gone —
              // silent no-op, app looks unresponsive.
              pendingAgentSession: conv.pendingAgentSession?.messageId === messageId ? null : conv.pendingAgentSession,
              justRegisteredAgent: conv.justRegisteredAgent?.messageId === messageId ? null : conv.justRegisteredAgent,
            },
          },
        };
      });
      debouncedSave(persist);
    },

    setStreaming: (paneId, streaming) => {
      logInfo('AIPaneStore', 'Streaming ' + paneId + ': ' + streaming);
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, isStreaming: streaming },
          },
        };
      });
    },

    setTerminalContext: (paneId, context) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, terminalContext: context },
          },
        };
      });
    },

    setActiveAgent: (paneId, agent) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, activeAgent: agent },
          },
        };
      });
      debouncedSave(persist);
    },

    setPendingAgentSession: (paneId, session) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, pendingAgentSession: session },
          },
        };
      });
      // Not debounced through the shared persist() timer: a pending session
      // is short-lived interaction state (created moments before the user's
      // next reply is expected) — an app kill in that narrow window losing
      // it just means the typed-confirm affordance is lost for that one
      // draft (the tap-to-confirm buttons on the draft message itself, which
      // ARE part of the debounced-persisted message list, still work).
    },

    setJustRegisteredAgent: (paneId, ref) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, justRegisteredAgent: ref },
          },
        };
      });
      // Same "not debounce-persisted" reasoning as setPendingAgentSession
      // above — this is a few-minutes-wide correction window, not something
      // worth surviving an app kill for. Losing it just means a correction
      // typed right after a restart falls through to normal chat instead of
      // patching the agent, same as if the window had simply expired.
    },

    setPendingExternalPrompt: (text, source) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      logInfo('AIPaneStore', `pendingExternalPrompt set (${trimmed.length} chars${source ? `, source=${source}` : ''})`);
      set({ pendingExternalPrompt: { text: trimmed, createdAt: Date.now(), source } });
    },

    takePendingExternalPrompt: () => {
      const pending = get().pendingExternalPrompt;
      if (!pending) return null;
      // Claim first (synchronous, single-threaded JS) so a second mounted
      // AIPane observing the same store change gets null instead of a
      // duplicate dispatch.
      set({ pendingExternalPrompt: null });
      if (Date.now() - pending.createdAt > EXTERNAL_PROMPT_STALE_MS) {
        logWarn('AIPaneStore', 'pendingExternalPrompt expired unclaimed — dropped');
        return null;
      }
      return pending;
    },

    clearConversation: (paneId) => {
      get().getOrCreate(paneId);
      set((state) => {
        const conv = state.conversations[paneId] ?? makeEmptyConversation(paneId);
        return {
          conversations: {
            ...state.conversations,
            // 2026-08-24 on-device finding: clearConversation used to spread
            // ...conv and only reset `messages`, leaving pendingAgentSession
            // (and justRegisteredAgent) pointing at a messageId that no
            // longer exists. The next message the user sent got silently
            // absorbed into the stale pending-draft reply handler instead of
            // reaching the LLM, and typing "cancel" tried to updateMessage()
            // the deleted bubble — a no-op, so the "Registration cancelled."
            // confirmation never appeared and the app looked completely
            // unresponsive. terminalContext deliberately stays (it's a
            // snapshot of what's visible right now, not tied to any specific
            // message) — only the two fields that reference a specific
            // messageId need to go with the messages they point at.
            [paneId]: { ...conv, messages: [], pendingAgentSession: null, justRegisteredAgent: null },
          },
        };
      });
      debouncedSave(persist);
    },
  };
});
