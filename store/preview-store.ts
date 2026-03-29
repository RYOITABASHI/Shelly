import { create } from 'zustand';

export type PreviewTabId = 'web' | 'code' | 'files';

export type RecentFile = {
  path: string;
  detectedAt: number;
  source: 'git' | 'pty';
};

interface PreviewState {
  // Existing
  previewUrl: string | null;
  previewType: 'localhost' | 'file' | null;
  isOpen: boolean;
  splitRatio: number;
  detectedUrls: string[];
  bannerVisible: boolean;
  bannerUrl: string | null;

  // New: tabs
  activeTab: PreviewTabId;
  setActiveTab: (tab: PreviewTabId) => void;

  // New: code tab
  recentFiles: RecentFile[];
  activeCodeFile: string | null;
  notifyFileChange: (path: string) => void;
  setActiveCodeFile: (path: string) => void;

  // New: files tab
  currentDir: string;
  setCurrentDir: (dir: string) => void;

  // New: badge
  hasNewContent: boolean;
  clearNewContent: () => void;

  // Existing actions (modified)
  offerPreview: (url: string, type: 'localhost' | 'file') => void;
  openPreview: (url?: string) => void;
  closePreview: () => void;
  dismissBanner: () => void;
  setSplitRatio: (ratio: number) => void;
  clearDetectedUrls: () => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  previewUrl: null,
  previewType: null,
  isOpen: false,
  splitRatio: 0.5,
  detectedUrls: [],
  bannerVisible: false,
  bannerUrl: null,
  activeTab: 'files',
  recentFiles: [],
  activeCodeFile: null,
  currentDir: '',
  hasNewContent: false,

  setActiveTab: (tab) => set({ activeTab: tab }),

  notifyFileChange: (path) => {
    const { isOpen, recentFiles } = get();
    const entry: RecentFile = { path, detectedAt: Date.now(), source: 'pty' };
    const updated = [entry, ...recentFiles.filter((f) => f.path !== path)].slice(0, 20);
    set({
      recentFiles: updated,
      activeCodeFile: path,
      hasNewContent: isOpen ? get().hasNewContent : true,
    });
  },

  setActiveCodeFile: (path) => set({ activeCodeFile: path }),

  setCurrentDir: (dir) => set({ currentDir: dir }),

  clearNewContent: () => set({ hasNewContent: false }),

  offerPreview: (url, type) => {
    const { detectedUrls, isOpen } = get();
    const normalized = url.replace(/https?:\/\/(127\.0\.0\.1|0\.0\.0\.0|\[::\])/, 'http://localhost');
    if (detectedUrls.includes(normalized)) return;
    const updated = [normalized, ...detectedUrls].slice(0, 10);
    set({
      detectedUrls: updated,
      previewType: type,
      hasNewContent: isOpen ? get().hasNewContent : true,
    });
    if (isOpen) {
      set({ previewUrl: normalized, activeTab: 'web' });
    } else {
      set({ bannerVisible: true, bannerUrl: normalized });
    }
  },

  // CHANGED: always opens, even without URL
  openPreview: (url) => {
    const { bannerUrl, detectedUrls } = get();
    const targetUrl = url ?? bannerUrl ?? detectedUrls[0] ?? null;
    const tab: PreviewTabId = targetUrl ? 'web' : (get().recentFiles.length > 0 ? 'code' : 'files');
    set({
      isOpen: true,
      previewUrl: targetUrl,
      bannerVisible: false,
      activeTab: tab,
      hasNewContent: false,
    });
  },

  // CHANGED: preserves previewUrl on close
  closePreview: () => set({ isOpen: false }),

  dismissBanner: () => set({ bannerVisible: false, bannerUrl: null }),

  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.3, Math.min(0.7, ratio)) }),

  clearDetectedUrls: () => set({ detectedUrls: [], bannerVisible: false, bannerUrl: null }),
}));
