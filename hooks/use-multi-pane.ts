import { create } from 'zustand';

export type PaneTab =
  | 'index'
  | 'terminal'
  | 'projects'
  | 'snippets'
  | 'creator'
  | 'browser'
  | 'obsidian'
  | 'search'
  | 'settings';

type MultiPaneState = {
  /** Whether multi-pane mode is active */
  isMultiPane: boolean;
  /** Currently displayed tab names (max 3) */
  panes: PaneTab[];
  /** Max panes: 2 for portrait inner, 3 for landscape inner */
  maxPanes: number;
};

type MultiPaneActions = {
  /** Enable multi-pane with optional initial tabs (default: ['index', 'terminal']) */
  enableMultiPane: (initial?: PaneTab[]) => void;
  /** Disable multi-pane, return to normal tab view */
  disableMultiPane: () => void;
  /** Toggle multi-pane on/off */
  toggleMultiPane: () => void;
  /** Change the tab in a specific pane slot */
  setPane: (index: number, tab: PaneTab) => void;
  /** Add a new pane (up to maxPanes) */
  addPane: (tab: PaneTab) => void;
  /** Remove a pane by index; auto-disables if last pane removed */
  removePane: (index: number) => void;
  /** Update maxPanes (e.g. on rotation); trims excess panes from the right */
  setMaxPanes: (max: number) => void;
};

export const useMultiPaneStore = create<MultiPaneState & MultiPaneActions>(
  (set, get) => ({
    isMultiPane: false,
    panes: [],
    maxPanes: 2,

    enableMultiPane: (initial) => {
      const { maxPanes } = get();
      const tabs = initial ?? ['index', 'terminal'];
      set({
        isMultiPane: true,
        panes: tabs.slice(0, maxPanes),
      });
    },

    disableMultiPane: () => {
      set({ isMultiPane: false, panes: [] });
    },

    toggleMultiPane: () => {
      const { isMultiPane } = get();
      if (isMultiPane) {
        get().disableMultiPane();
      } else {
        get().enableMultiPane();
      }
    },

    setPane: (index, tab) => {
      const { panes } = get();
      if (index < 0 || index >= panes.length) return;
      const next = [...panes];
      next[index] = tab;
      set({ panes: next });
    },

    addPane: (tab) => {
      const { panes, maxPanes } = get();
      if (panes.length >= maxPanes) return;
      set({ panes: [...panes, tab] });
    },

    removePane: (index) => {
      const { panes } = get();
      if (index < 0 || index >= panes.length) return;
      const next = panes.filter((_, i) => i !== index);
      if (next.length <= 1) {
        // Auto-exit multi-pane when only 0-1 pane remains
        set({ isMultiPane: false, panes: [] });
      } else {
        set({ panes: next });
      }
    },

    setMaxPanes: (max) => {
      const { panes } = get();
      const clamped = Math.max(1, Math.min(3, max));
      if (panes.length > clamped) {
        set({ maxPanes: clamped, panes: panes.slice(0, clamped) });
      } else {
        set({ maxPanes: clamped });
      }
    },
  }),
);
