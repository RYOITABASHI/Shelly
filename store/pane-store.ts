// store/pane-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Agent color mapping for pane top borders */
export const AGENT_COLORS: Record<string, string> = {
  claude: '#D4A574',
  gemini: '#4285F4',
  codex: '#10A37F',
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

  setFocusedPane: (id: string) => void;
  setMaximizedPane: (id: string | null) => void;
  bindAgent: (paneId: string, agentName: string) => void;
  unbindAgent: (paneId: string) => void;
}

// bug #50: persist focusedPaneId / maximizedPaneId across lmkd kills.
// paneAgents is excluded — it maps to native session bindings which must
// be reconstructed from TerminalEmulator on startup, not restored blindly.
export const usePaneStore = create<PaneState>()(
  persist(
    (set) => ({
      focusedPaneId: null,
      maximizedPaneId: null,
      paneAgents: {},

      setFocusedPane: (id) => set({ focusedPaneId: id }),
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
