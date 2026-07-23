/**
 * store/ai-pane-store.ts
 *
 * Per-pane AI conversation store for the Superset UI redesign.
 * Each terminal pane has its own independent AI conversation history.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, ChatAgent } from './chat-store';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { SlotField } from '@/lib/agent-slot-fill';
import { logInfo, logError } from '@/lib/debug-logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Session-scoped (per-pane) pending state for a chat-native agent draft
 * registration (Phase A, 2026-07-22). Unlike the pre-existing
 * `ChatMessage.pendingSlotFill` (store/chat-store.ts), which lives on the
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
  phase: 'slot-fill' | 'await-confirm';
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

  // Initialization
  load: () => Promise<void>;

  // Actions
  getOrCreate: (paneId: string) => AIPaneConversation;
  addMessage: (paneId: string, msg: ChatMessage) => void;
  updateMessage: (paneId: string, msgId: string, updates: Partial<ChatMessage>) => void;
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
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'shelly_ai_pane_conversations';
const MAX_MESSAGES_PER_PANE = 200;
const DEBOUNCE_MS = 2000;

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

    load: async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const data = JSON.parse(raw) as Record<string, AIPaneConversation>;
          const conversations: Record<string, AIPaneConversation> = {};
          for (const [paneId, conv] of Object.entries(data)) {
            conversations[paneId] = {
              ...conv,
              isStreaming: false,
              terminalContext: null,
            };
          }
          set({ conversations, isLoaded: true });
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
      set((state) => {
        const conv = state.conversations[paneId];
        if (!conv) return state;
        const msgIdx = conv.messages.findIndex((m) => m.id === msgId);
        if (msgIdx === -1) return state;

        const newMessages = [...conv.messages];
        newMessages[msgIdx] = { ...newMessages[msgIdx], ...updates };
        return {
          conversations: {
            ...state.conversations,
            [paneId]: { ...conv, messages: newMessages },
          },
        };
      });

      // Persist when streaming completes
      if (updates.isStreaming === false) {
        debouncedSave(persist);
      }
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

    clearConversation: (paneId) => {
      set((state) => ({
        conversations: {
          ...state.conversations,
          [paneId]: makeEmptyConversation(paneId),
        },
      }));
      debouncedSave(persist);
    },
  };
});
