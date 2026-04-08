/**
 * store/ai-pane-store.ts
 *
 * Per-pane AI conversation store for the Superset UI redesign.
 * Each terminal pane has its own independent AI conversation history.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, ChatAgent } from './chat-store';
import { logInfo, logError } from '@/lib/debug-logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AIPaneConversation = {
  paneId: string;
  messages: ChatMessage[];
  activeAgent: ChatAgent | null;
  isStreaming: boolean;
  terminalContext: string | null;
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
          set({ conversations: data, isLoaded: true });
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
