import { create } from 'zustand';

interface PreviewState {
  previewUrl: string | null;
  previewType: 'localhost' | 'file' | null;
  isOpen: boolean;
  splitRatio: number;
  detectedUrls: string[];
  bannerVisible: boolean;
  bannerUrl: string | null;

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

  offerPreview: (url, type) => {
    const { detectedUrls, isOpen, previewUrl } = get();
    // Don't re-offer the same URL
    if (detectedUrls.includes(url)) return;

    const updated = [url, ...detectedUrls].slice(0, 10);
    set({
      detectedUrls: updated,
      bannerVisible: !isOpen, // Don't show banner if preview already open
      bannerUrl: url,
      previewType: type,
    });

    // If preview is open, auto-navigate to new URL
    if (isOpen) {
      set({ previewUrl: url });
    }
  },

  openPreview: (url) => {
    const { bannerUrl, detectedUrls } = get();
    const targetUrl = url || bannerUrl || detectedUrls[0];
    if (!targetUrl) return;
    set({
      isOpen: true,
      previewUrl: targetUrl,
      bannerVisible: false,
    });
  },

  closePreview: () => {
    set({
      isOpen: false,
      previewUrl: null,
    });
  },

  dismissBanner: () => {
    set({ bannerVisible: false, bannerUrl: null });
  },

  setSplitRatio: (ratio) => {
    set({ splitRatio: Math.max(0.3, Math.min(0.7, ratio)) });
  },

  clearDetectedUrls: () => {
    set({ detectedUrls: [], bannerVisible: false, bannerUrl: null });
  },
}));
