/**
 * store/launcher-inbox-store.ts — visibility and last snapshot of the launcher
 * approval inbox (components/LauncherInboxModal.tsx, launcher ingress Phase 2
 * P2-B3/B4). Presentation only: it holds no decision and decides nothing —
 * decisions go through store/mcp-approval-store.ts (D8). Not persisted (the
 * records live natively; this is re-read every time the inbox opens).
 */
import { create } from 'zustand';
import { fetchLauncherInbox, type LauncherInbox } from '@/lib/launcher-approval';

interface LauncherInboxState {
  visible: boolean;
  loading: boolean;
  inbox: LauncherInbox | null;
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
}

export const useLauncherInboxStore = create<LauncherInboxState>((set, get) => ({
  visible: false,
  loading: false,
  inbox: null,
  open: () => {
    set({ visible: true });
    void get().refresh();
  },
  close: () => set({ visible: false }),
  refresh: async () => {
    set({ loading: true });
    try {
      set({ inbox: await fetchLauncherInbox() });
    } finally {
      set({ loading: false });
    }
  },
}));
