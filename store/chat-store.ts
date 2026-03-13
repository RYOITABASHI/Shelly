/**
 * store/chat-store.ts
 *
 * Chat-first UIのためのストア。
 * チャットセッション管理、メッセージ永続化、プロジェクト紐づけ。
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChatAgent = 'claude' | 'gemini' | 'local' | 'perplexity' | 'team' | 'git' | 'codex';

export type CommandExecution = {
  command: string;
  output: string;
  exitCode: number | null;
  isCollapsed: boolean;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** コマンド実行結果の埋め込み */
  executions?: CommandExecution[];
  /** AI agent that handled this message */
  agent?: ChatAgent;
  /** Streaming state */
  isStreaming?: boolean;
  streamingText?: string;
  tokenCount?: number;
  streamingStartTime?: number;
  /** Perplexity citations */
  citations?: Array<{ url: string; title?: string }>;
  /** Error */
  error?: string;
  /** Safety warning level */
  dangerLevel?: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  /** ローカルLLM応答時のモデル名+ポート (例: "gemma-3-4b-it (:8080)") */
  llmModelLabel?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  /** Linked project folder (null = casual chat) */
  projectPath?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

// ─── Store ───────────────────────────────────────────────────────────────────

type ChatStore = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoaded: boolean;

  // Actions
  load: () => Promise<void>;
  save: () => Promise<void>;
  createSession: (title?: string, projectPath?: string) => string;
  deleteSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  /** Delete a message and all messages after it (for edit+resend) */
  deleteMessagesFrom: (sessionId: string, messageId: string) => void;
  getActiveSession: () => ChatSession | null;
  searchSessions: (query: string) => ChatSession[];
};

import { generateId } from '@/lib/id';

const STORAGE_KEY = 'shelly_chats';

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoaded: false,

  load: async () => {
    try {
      let raw = await AsyncStorage.getItem(STORAGE_KEY);
      // Strip legacy encryption prefix if present (XOR encryption removed)
      if (raw?.startsWith('ENC:')) raw = null;
      if (raw) {
        const data = JSON.parse(raw);
        set({
          sessions: data.sessions ?? [],
          activeSessionId: data.activeSessionId ?? null,
          isLoaded: true,
        });
      } else {
        // First launch: create default session
        const id = generateId();
        const session: ChatSession = {
          id,
          title: 'New Chat',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set({ sessions: [session], activeSessionId: id, isLoaded: true });
      }
    } catch {
      set({ isLoaded: true });
    }
  },

  save: async () => {
    try {
      const { sessions, activeSessionId } = get();
      // Limit persisted messages to avoid AsyncStorage bloat
      const trimmed = sessions.map((s) => ({
        ...s,
        messages: s.messages.slice(-500).map((m) => ({
          ...m,
          isStreaming: false,
          streamingText: undefined,
        })),
      }));
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessions: trimmed,
        activeSessionId,
      }));
    } catch {
      // Silently fail
    }
  },

  createSession: (title, projectPath) => {
    const id = generateId();
    const folderName = projectPath?.split('/').pop();
    const session: ChatSession = {
      id,
      title: title ?? folderName ?? 'New Chat',
      projectPath,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSessionId: id,
    }));
    get().save();
    return id;
  },

  deleteSession: (id) => {
    set((state) => {
      const filtered = state.sessions.filter((s) => s.id !== id);
      const newActive = state.activeSessionId === id
        ? (filtered[0]?.id ?? null)
        : state.activeSessionId;
      return { sessions: filtered, activeSessionId: newActive };
    });
    get().save();
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id });
    get().save();
  },

  addMessage: (sessionId, message) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, message], updatedAt: Date.now() }
          : s
      ),
    }));
    // Debounced save (don't save on every streaming chunk)
    if (!message.isStreaming) {
      get().save();
    }
  },

  updateMessage: (sessionId, messageId, updates) => {
    set((state) => {
      const sessionIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessionIdx === -1) return state;
      const session = state.sessions[sessionIdx];
      const msgIdx = session.messages.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return state;

      // Direct index update — O(1) lookup instead of full array map
      const updatedMsg = { ...session.messages[msgIdx], ...updates };
      const newMessages = [...session.messages];
      newMessages[msgIdx] = updatedMsg;

      const newSessions = [...state.sessions];
      newSessions[sessionIdx] = { ...session, messages: newMessages, updatedAt: Date.now() };
      return { sessions: newSessions };
    });
    // Save when streaming completes
    if (updates.isStreaming === false) {
      get().save();
    }
  },

  deleteMessage: (sessionId, messageId) => {
    set((state) => {
      const sessionIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessionIdx === -1) return state;
      const session = state.sessions[sessionIdx];
      const newMessages = session.messages.filter((m) => m.id !== messageId);
      const newSessions = [...state.sessions];
      newSessions[sessionIdx] = { ...session, messages: newMessages, updatedAt: Date.now() };
      return { sessions: newSessions };
    });
    get().save();
  },

  deleteMessagesFrom: (sessionId, messageId) => {
    set((state) => {
      const sessionIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessionIdx === -1) return state;
      const session = state.sessions[sessionIdx];
      const msgIdx = session.messages.findIndex((m) => m.id === messageId);
      if (msgIdx === -1) return state;
      const newMessages = session.messages.slice(0, msgIdx);
      const newSessions = [...state.sessions];
      newSessions[sessionIdx] = { ...session, messages: newMessages, updatedAt: Date.now() };
      return { sessions: newSessions };
    });
    get().save();
  },

  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((s) => s.id === activeSessionId) ?? null;
  },

  searchSessions: (query) => {
    const lower = query.toLowerCase();
    return get().sessions.filter((s) =>
      s.title.toLowerCase().includes(lower) ||
      s.projectPath?.toLowerCase().includes(lower) ||
      s.messages.some((m) => m.content.toLowerCase().includes(lower))
    );
  },
}));
