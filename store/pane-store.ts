// store/pane-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Agent color mapping for pane top borders */
export const AGENT_COLORS: Record<string, string> = {
  codex: '#10A37F',
  gemini: '#60A5FA',
  cerebras: '#FF6B35',
  groq: '#F97316',
  local: '#FFD700',
  perplexity: '#20808D',
  unbound: '#333333',
};

/** Get agent color for a pane (standalone — use outside React or in selectors) */
export function getAgentColor(paneAgents: Record<string, string>, paneId: string): string {
  const agent = paneAgents[paneId];
  return AGENT_COLORS[agent ?? 'unbound'] ?? AGENT_COLORS.unbound;
}

interface PaneState {
  /** Currently focused pane leaf ID */
  focusedPaneId: string | null;
  /** Currently maximized pane leaf ID (duplicated from multi-pane for recovery) */
  maximizedPaneId: string | null;
  /** Agent bound to each pane: leafId → agentName */
  paneAgents: Record<string, string>;
  /** Most-recently-focused pane ids, newest first (runtime-only). Used by
   *  "Quote to AI" to find the composer pane the user was last in. */
  focusHistory: string[];
  /** "Quote to AI": a quote waiting for a specific composer pane to claim it
   *  into its draft (never auto-sent). Runtime-only, never persisted. */
  pendingComposerInsert: PendingComposerInsert | null;

  setFocusedPane: (id: string) => void;
  setMaximizedPane: (id: string | null) => void;
  bindAgent: (paneId: string, agentName: string) => void;
  unbindAgent: (paneId: string) => void;
  queueComposerInsert: (insert: Omit<PendingComposerInsert, 'createdAt'>) => void;
  /** Claim-and-clear: returns the pending insert only when it targets this
   *  pane+tab and hasn't expired; otherwise null and the entry stays put. */
  takeComposerInsert: (paneId: string, tab: PendingComposerInsert['tab']) => PendingComposerInsert | null;
}

export interface PendingComposerInsert {
  paneId: string;
  tab: 'ai' | 'agent-chat';
  text: string;
  createdAt: number;
}

const FOCUS_HISTORY_MAX = 8;
/** A quote nobody claimed (pane closed mid-flight) shouldn't surface later. */
export const COMPOSER_INSERT_TTL_MS = 60_000;

// bug #50: persist focusedPaneId / maximizedPaneId across lmkd kills.
// paneAgents is excluded — it maps to native session bindings which must
// be reconstructed from TerminalEmulator on startup, not restored blindly.
export const usePaneStore = create<PaneState>()(
  persist(
    (set, get) => ({
      focusedPaneId: null,
      maximizedPaneId: null,
      paneAgents: {},
      focusHistory: [],
      pendingComposerInsert: null,

      setFocusedPane: (id) =>
        set((s) => ({
          focusedPaneId: id,
          focusHistory: [id, ...s.focusHistory.filter((x) => x !== id)].slice(0, FOCUS_HISTORY_MAX),
        })),

      queueComposerInsert: (insert) => set({ pendingComposerInsert: { ...insert, createdAt: Date.now() } }),

      takeComposerInsert: (paneId, tab) => {
        const pending = get().pendingComposerInsert;
        if (!pending) return null;
        if (Date.now() - pending.createdAt > COMPOSER_INSERT_TTL_MS) {
          set({ pendingComposerInsert: null });
          return null;
        }
        if (pending.paneId !== paneId || pending.tab !== tab) return null;
        set({ pendingComposerInsert: null });
        return pending;
      },
      setMaximizedPane: (id) => set({ maximizedPaneId: id }),

      bindAgent: (paneId, agentName) =>
        set((s) => ({ paneAgents: { ...s.paneAgents, [paneId]: agentName } })),

      unbindAgent: (paneId) =>
        set((s) => {
          const next = { ...s.paneAgents };
          delete next[paneId];
          return { paneAgents: next };
        }),
    }),
    {
      name: 'pane-store-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        focusedPaneId: s.focusedPaneId,
        maximizedPaneId: s.maximizedPaneId,
      }),
      version: 1,
    }
  )
);
