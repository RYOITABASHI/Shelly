import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Bookmark = {
  label: string;
  url: string;
  icon: string;
  /** Icon tint color. Defaults to theme accent if omitted. */
  color?: string;
};
export type BrowserNavAction = 'back' | 'forward' | 'reload';

interface BrowserState {
  /** User-added bookmarks (persisted) */
  bookmarks: Bookmark[];
  /** Incremented to signal a nav action to BrowserPane */
  navSignal: { action: BrowserNavAction; seq: number };
  /** Incremented to tell BrowserPane to load a specific URL */
  openSignal: { url: string; seq: number };
  addBookmark: (b: Bookmark) => void;
  removeBookmark: (url: string) => void;
  loadBookmarks: () => Promise<void>;
  triggerNav: (action: BrowserNavAction) => void;
  openUrl: (url: string) => void;
}

/** Built-in preset bookmarks. Always shown, not editable, not persisted. */
export const PRESET_BOOKMARKS: readonly Bookmark[] = [
  { label: 'YouTube', url: 'https://youtube.com', icon: 'play-circle-filled', color: '#FF0000' },
  { label: 'X',       url: 'https://x.com',       icon: 'close',              color: '#000000' },
  { label: 'GitHub',  url: 'https://github.com',  icon: 'code',               color: '#FFFFFF' },
  { label: 'localhost', url: 'http://localhost:3000', icon: 'computer',       color: '#22C55E' },
] as const;

export const useBrowserStore = create<BrowserState>((set, get) => ({
  bookmarks: [],
  navSignal: { action: 'reload' as BrowserNavAction, seq: 0 },
  openSignal: { url: '', seq: 0 },

  addBookmark: (b) => {
    set((s) => {
      const next = [...s.bookmarks, b];
      AsyncStorage.setItem('shelly_bookmarks', JSON.stringify(next)).catch(() => {});
      return { bookmarks: next };
    });
  },

  removeBookmark: (url) => {
    set((s) => {
      const next = s.bookmarks.filter((b) => b.url !== url);
      AsyncStorage.setItem('shelly_bookmarks', JSON.stringify(next)).catch(() => {});
      return { bookmarks: next };
    });
  },

  loadBookmarks: async () => {
    try {
      const raw = await AsyncStorage.getItem('shelly_bookmarks');
      if (raw) set({ bookmarks: JSON.parse(raw) });
    } catch {}
  },

  triggerNav: (action) => {
    set((s) => ({ navSignal: { action, seq: s.navSignal.seq + 1 } }));
  },

  openUrl: (url) => {
    set((s) => ({ openSignal: { url, seq: s.openSignal.seq + 1 } }));
  },
}));
