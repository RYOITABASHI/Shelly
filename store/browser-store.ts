import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Bookmark = { label: string; url: string; icon: string };
export type BrowserNavAction = 'back' | 'forward' | 'reload';

interface BrowserState {
  bookmarks: Bookmark[];
  /** Incremented to signal a nav action to BrowserPane */
  navSignal: { action: BrowserNavAction; seq: number };
  addBookmark: (b: Bookmark) => void;
  removeBookmark: (url: string) => void;
  loadBookmarks: () => Promise<void>;
  triggerNav: (action: BrowserNavAction) => void;
}

const DEFAULT_BOOKMARKS: Bookmark[] = [
  { label: 'YouTube', url: 'https://youtube.com', icon: 'play-circle-outline' },
  { label: 'X', url: 'https://x.com', icon: 'alternate-email' },
  { label: 'GitHub', url: 'https://github.com', icon: 'code' },
  { label: 'localhost', url: 'http://localhost:3000', icon: 'computer' },
];

export const useBrowserStore = create<BrowserState>((set, get) => ({
  bookmarks: DEFAULT_BOOKMARKS,
  navSignal: { action: 'reload' as BrowserNavAction, seq: 0 },

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
}));
