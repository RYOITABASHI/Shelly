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
  /** Composer panes that must NOT receive a quote right now (AI pane in
   *  masked API-key entry, Agent Chat without an active session). */
  composerQuoteBlocked: Record<string, true>;
  /** id of the last insert a composer actually claimed (drives the toast). */
  lastClaimedInsertId: number | null;

  setFocusedPane: (id: string) => void;
  setMaximizedPane: (id: string | null) => void;
  bindAgent: (paneId: string, agentName: string) => void;
  unbindAgent: (paneId: string) => void;
  /** Queues (replacing any previous entry, expired or not) and returns its id. */
  queueComposerInsert: (insert: Omit<PendingComposerInsert, 'createdAt' | 'id'>) => number;
  /** Claim-and-clear: returns the pending insert only when it targets this
   *  pane+tab, hasn't expired and the pane isn't blocked; otherwise null and
   *  the entry stays put (expired entries are dropped). */
  takeComposerInsert: (paneId: string, tab: PendingComposerInsert['tab']) => PendingComposerInsert | null;
  /** Drop the pending insert if it is still `id` (claim timed out). */
  cancelComposerInsert: (id: number) => void;
  setComposerQuoteBlocked: (paneId: string, blocked: boolean) => void;
  /** Composer pane unmounted (closed / tab switched): forget its block flag
   *  and drop a quote still waiting for it. */
  releaseComposerPane: (paneId: string) => void;
}

export interface PendingComposerInsert {
  id: number;
  paneId: string;
  tab: 'ai' | 'agent-chat';
  text: string;
  createdAt: number;
}

const FOCUS_HISTORY_MAX = 8;
/** A quote nobody claimed (pane closed mid-flight) shouldn't surface later. */
export const COMPOSER_INSERT_TTL_MS = 60_000;
let nextComposerInsertId = 1;

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
      composerQuoteBlocked: {},
      lastClaimedInsertId: null,

      setFocusedPane: (id) =>
        set((s) => ({
          focusedPaneId: id,
          focusHistory: [id, ...s.focusHistory.filter((x) => x !== id)].slice(0, FOCUS_HISTORY_MAX),
        })),

      queueComposerInsert: (insert) => {
        const id = nextComposerInsertId++;
        set({ pendingComposerInsert: { ...insert, id, createdAt: Date.now() } });
        return id;
      },

      cancelComposerInsert: (id) => {
        if (get().pendingComposerInsert?.id === id) set({ pendingComposerInsert: null });
      },

      setComposerQuoteBlocked: (paneId, blocked) =>
        set((s) => {
          if (Boolean(s.composerQuoteBlocked[paneId]) === blocked) return s;
          const next = { ...s.composerQuoteBlocked };
          if (blocked) next[paneId] = true;
          else delete next[paneId];
          return { composerQuoteBlocked: next };
        }),

      releaseComposerPane: (paneId) =>
        set((s) => {
          const next = { ...s.composerQuoteBlocked };
          delete next[paneId];
          return {
            composerQuoteBlocked: next,
            pendingComposerInsert: s.pendingComposerInsert?.paneId === paneId ? null : s.pendingComposerInsert,
          };
        }),

      takeComposerInsert: (paneId, tab) => {
        const pending = get().pendingComposerInsert;
        if (!pending) return null;
        if (Date.now() - pending.createdAt > COMPOSER_INSERT_TTL_MS) {
          set({ pendingComposerInsert: null });
          return null;
        }
        if (pending.paneId !== paneId || pending.tab !== tab) return null;
        if (get().composerQuoteBlocked[paneId]) return null;
        set({ pendingComposerInsert: null, lastClaimedInsertId: pending.id });
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
