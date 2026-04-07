// store/pane-store.ts
import { create } from 'zustand';

/** Agent color mapping for pane top borders */
export const AGENT_COLORS: Record<string, string> = {
  claude: '#D4A574',
  gemini: '#4285F4',
  codex: '#10A37F',
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
  /** Agent bound to each pane: leafId → agentName */
  paneAgents: Record<string, string>;

  setFocusedPane: (id: string) => void;
  bindAgent: (paneId: string, agentName: string) => void;
  unbindAgent: (paneId: string) => void;
}

export const usePaneStore = create<PaneState>((set) => ({
  focusedPaneId: null,
  paneAgents: {},

  setFocusedPane: (id) => set({ focusedPaneId: id }),

  bindAgent: (paneId, agentName) =>
    set((s) => ({ paneAgents: { ...s.paneAgents, [paneId]: agentName } })),

  unbindAgent: (paneId) =>
    set((s) => {
      const next = { ...s.paneAgents };
      delete next[paneId];
      return { paneAgents: next };
    }),
}));
