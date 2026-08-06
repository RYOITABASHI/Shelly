/**
 * store/browser-store.ts's lastOpenedUrl persistence.
 *
 * 2026-08-06 on-device QA finding (docs/superpowers/DEFERRED.md): a
 * browser-pane agent action's approval flow declines with "Current WebView
 * URL is not allowlisted" whenever the Browser Pane's currentUrl (a plain
 * React component-local useState in components/panes/BrowserPane.tsx) has
 * been reset to 'about:blank' — reproduced 2 out of 3 times on-device,
 * consistent with the app cold-starting from a killed process when the
 * approval notification is tapped (a fresh mount re-initializes
 * currentUrl from scratch, with nothing to recover the page the user was
 * actually on). Persisting the last-visited URL and using it as
 * BrowserPane's fallback initial URL (in place of a bare 'about:blank')
 * closes this gap without touching the approval/allowlist logic itself.
 */
// This is a plain-node "unit" test (store/browser-store.ts has no RN/JSX
// dependency) — mirrors __tests__/dotfiles-sync-agent-data.test.ts's
// pattern of a hand-written in-memory AsyncStorage mock, since the real
// @react-native-async-storage/async-storage implementation requires a
// jsdom/`window` environment this project doesn't run here.
const mockAsyncStorageValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => Promise.resolve(mockAsyncStorageValues.get(key) ?? null),
    setItem: (key: string, value: string) => {
      mockAsyncStorageValues.set(key, value);
      return Promise.resolve();
    },
    clear: () => {
      mockAsyncStorageValues.clear();
      return Promise.resolve();
    },
  },
}));

import { useBrowserStore } from '@/store/browser-store';

describe('browser-store lastOpenedUrl', () => {
  beforeEach(() => {
    mockAsyncStorageValues.clear();
    useBrowserStore.setState({ lastOpenedUrl: null });
  });

  it('starts as null before anything is recorded or loaded', () => {
    expect(useBrowserStore.getState().lastOpenedUrl).toBeNull();
  });

  it('recordVisitedUrl persists an http(s) URL to AsyncStorage and updates state', async () => {
    useBrowserStore.getState().recordVisitedUrl('https://example.com/page');
    expect(useBrowserStore.getState().lastOpenedUrl).toBe('https://example.com/page');
    // The write is fire-and-forget (mirrors addBookmark/removeBookmark's
    // existing pattern in this same store) — await a tick for it to land.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockAsyncStorageValues.get('shelly_browser_last_url')).toBe('https://example.com/page');
  });

  it('recordVisitedUrl ignores about:blank — never overwrites a real last-visited URL with the empty state', () => {
    useBrowserStore.getState().recordVisitedUrl('https://example.com/first');
    useBrowserStore.getState().recordVisitedUrl('about:blank');
    expect(useBrowserStore.getState().lastOpenedUrl).toBe('https://example.com/first');
  });

  it('recordVisitedUrl ignores non-http(s) schemes (e.g. a stray file:// or javascript: URL)', () => {
    useBrowserStore.getState().recordVisitedUrl('javascript:alert(1)');
    expect(useBrowserStore.getState().lastOpenedUrl).toBeNull();
  });

  it('loadLastOpenedUrl restores a previously persisted URL into state (simulates a cold start after a prior session)', async () => {
    mockAsyncStorageValues.set('shelly_browser_last_url', 'https://example.com/restored');
    await useBrowserStore.getState().loadLastOpenedUrl();
    expect(useBrowserStore.getState().lastOpenedUrl).toBe('https://example.com/restored');
  });

  it('loadLastOpenedUrl leaves state null when nothing was ever persisted', async () => {
    await useBrowserStore.getState().loadLastOpenedUrl();
    expect(useBrowserStore.getState().lastOpenedUrl).toBeNull();
  });
});
