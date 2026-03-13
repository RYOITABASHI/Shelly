/**
 * Bookmark Store
 * ブックマーク管理（AsyncStorage永続化）
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Bookmark = {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
};

type BookmarkStore = {
  bookmarks: Bookmark[];
  isLoaded: boolean;
  // Actions
  loadBookmarks: () => Promise<void>;
  addBookmark: (url: string, title: string, favicon?: string) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;
  isBookmarked: (url: string) => boolean;
  getBookmarkByUrl: (url: string) => Bookmark | undefined;
};

const STORAGE_KEY = 'shelly_bookmarks';

export const useBookmarkStore = create<BookmarkStore>((set, get) => ({
  bookmarks: [],
  isLoaded: false,

  loadBookmarks: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Bookmark[];
        set({ bookmarks: parsed, isLoaded: true });
      } else {
        set({ isLoaded: true });
      }
    } catch {
      set({ isLoaded: true });
    }
  },

  addBookmark: async (url: string, title: string, favicon?: string) => {
    const { bookmarks } = get();
    // 既存チェック（同URLは上書き）
    const existing = bookmarks.find((b) => b.url === url);
    let updated: Bookmark[];
    if (existing) {
      updated = bookmarks.map((b) =>
        b.url === url ? { ...b, title, favicon, createdAt: Date.now() } : b,
      );
    } else {
      const newBookmark: Bookmark = {
        id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        url,
        title,
        favicon,
        createdAt: Date.now(),
      };
      updated = [newBookmark, ...bookmarks];
    }
    set({ bookmarks: updated });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  },

  removeBookmark: async (id: string) => {
    const { bookmarks } = get();
    const updated = bookmarks.filter((b) => b.id !== id);
    set({ bookmarks: updated });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  },

  isBookmarked: (url: string) => {
    return get().bookmarks.some((b) => b.url === url);
  },

  getBookmarkByUrl: (url: string) => {
    return get().bookmarks.find((b) => b.url === url);
  },
}));
