import React, { useRef, useState, useCallback, useEffect, useContext } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  ScrollView,
  Keyboard,
  Platform,
} from 'react-native';
import WebView, { WebViewNavigation, WebViewMessageEvent } from 'react-native-webview';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { useBrowserStore, PRESET_BOOKMARKS } from '@/store/browser-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import { MultiPaneContext, PaneIdContext } from '@/components/multi-pane/PaneSlot';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

// JS injected before the page loads so our fullscreen hooks are in place
// before YouTube or any other video app tries to go fullscreen.
//
// react-native-webview does not wire WebChromeClient.onShowCustomView on
// Android, so the native HTML5 fullscreen exit path is missing. We cover
// every fullscreen entry point a mobile video player might use:
//
//   1. Standard Fullscreen API: document.fullscreenchange
//   2. WebKit-prefixed API used by Safari / WebView: webkitfullscreenchange
//   3. iOS/Android-native video element fullscreen:
//      <video>.webkitbeginfullscreen / webkitendfullscreen
//   4. Pointer capture via requestFullscreen on ANY element — we
//      monkey-patch HTMLElement.prototype.requestFullscreen so we see
//      entries that never fire a document-level event first.
const FULLSCREEN_BRIDGE_JS = `
(function() {
  if (window.__shellyFullscreenInstalled) return;
  window.__shellyFullscreenInstalled = true;
  var post = function(kind) {
    try {
      window.ReactNativeWebView.postMessage('shelly:fs:' + kind);
    } catch (e) {}
  };

  // 1 + 2: document-level fullscreen events (W3C + WebKit)
  var onFs = function() {
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    post(el ? 'on' : 'off');
  };
  document.addEventListener('fullscreenchange', onFs, true);
  document.addEventListener('webkitfullscreenchange', onFs, true);

  // 3: native <video> element fullscreen (iOS / Android WebView)
  var wireVideo = function(v) {
    if (!v || v.__shellyFsWired) return;
    v.__shellyFsWired = true;
    v.addEventListener('webkitbeginfullscreen', function() { post('on'); }, true);
    v.addEventListener('webkitendfullscreen', function() { post('off'); }, true);
  };
  var scan = function() {
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length; i++) wireVideo(vids[i]);
  };
  // Rescan on any DOM mutation since YouTube lazy-loads its player
  var mo = new MutationObserver(scan);
  var attach = function() {
    if (!document.body) return setTimeout(attach, 100);
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  };
  attach();

  // 4: PANE-CONTAINED FULLSCREEN — YouTube / HTML5 video usually call
  // element.requestFullscreen(), and Android's WebChromeClient answers
  // by escalating to an Activity-level Dialog. That breaks the multi
  // pane split entirely: the video covers the whole app. Replace the
  // fullscreen API with a CSS-only fake that pins the element to the
  // WebView viewport (== pane rectangle) and lies about
  // document.fullscreenElement so page code that reads the state
  // still behaves correctly.
  var paneFsEl = null;
  var paneFsStyle = null;
  var PANE_FS_CSS = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;margin:0!important;max-width:none!important;max-height:none!important;background:#000!important;';
  var firePaneFs = function(kind) {
    post(kind);
    try {
      var ev = new Event(kind === 'on' ? 'fullscreenchange' : 'fullscreenchange', { bubbles: true });
      document.dispatchEvent(ev);
      var wkev = new Event('webkitfullscreenchange', { bubbles: true });
      document.dispatchEvent(wkev);
    } catch (e) {}
  };
  var enterPaneFs = function(el) {
    if (paneFsEl) return Promise.resolve();
    paneFsEl = el;
    paneFsStyle = el.getAttribute('style') || '';
    el.setAttribute('style', paneFsStyle + ';' + PANE_FS_CSS);
    firePaneFs('on');
    return Promise.resolve();
  };
  var exitPaneFs = function() {
    if (!paneFsEl) return Promise.resolve();
    if (paneFsStyle === '') paneFsEl.removeAttribute('style');
    else paneFsEl.setAttribute('style', paneFsStyle);
    paneFsEl = null;
    paneFsStyle = null;
    firePaneFs('off');
    return Promise.resolve();
  };
  HTMLElement.prototype.requestFullscreen = function() { return enterPaneFs(this); };
  HTMLElement.prototype.webkitRequestFullscreen = function() { return enterPaneFs(this); };
  Document.prototype.exitFullscreen = function() { return exitPaneFs(); };
  Document.prototype.webkitExitFullscreen = function() { return exitPaneFs(); };
  Object.defineProperty(Document.prototype, 'fullscreenElement', {
    get: function() { return paneFsEl; },
    configurable: true,
  });
  Object.defineProperty(Document.prototype, 'webkitFullscreenElement', {
    get: function() { return paneFsEl; },
    configurable: true,
  });
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', {
    get: function() { return true; },
    configurable: true,
  });
})();
true;
`;

// JS injected BEFORE the page document loads — handles WebView
// fingerprint masking and responsiveness setup before the page first
// queries them.
//
//   1. navigator.userAgentData (Client Hints) is populated by Chromium
//      independently of the `userAgent` prop and on Android WebView
//      still reports the embedded build, which sites doing modern
//      UA-CH detection (increasingly common) use to detect WebView
//      regardless of the UA string. Define `userAgentData` as
//      undefined so detection falls back to the (cleaned) UA string.
//
//   2. Inject a default `<meta name=viewport>` for pages that don't
//      set one. Done in *before-content* so the WebView's first layout
//      pass sees it. Post-load injection on Android is a no-op — the
//      viewport is read once at initial layout and Chromium doesn't
//      re-read it from a mutated tag.
//
//      Heuristic: skip injection if a viewport meta tag exists at all
//      (regardless of its content). Pages that ship a viewport meta —
//      including OAuth providers and most mainstream sites — already
//      have intentional values, e.g. `user-scalable=no`. Overwriting
//      drops those.
//
//   3. Define `window.__shellyResize` so the RN side can hand-fire a
//      `resize` event on pane dimension changes (the WebView's bounds
//      change but Chromium doesn't always dispatch the event on a
//      same-document layout shift, leaving frameworks with
//      ResizeObserver / window.onresize listeners stale).
//
// `true;` at the end is the react-native-webview convention so the
// injection result is JSON-serialisable; we don't use the value.
const RESPONSIVE_BRIDGE_JS = `
(function() {
  if (window.__shellyResponsiveInstalled) return;
  window.__shellyResponsiveInstalled = true;
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined, configurable: true,
    });
  } catch (e) {}
  try {
    var existing = document.querySelector('meta[name="viewport"]');
    if (!existing) {
      var meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      meta.setAttribute('content', 'width=device-width, initial-scale=1');
      if (document.head) document.head.appendChild(meta);
      else document.addEventListener('DOMContentLoaded', function() {
        if (document.head) document.head.appendChild(meta);
      });
    }
  } catch (e) {}
  window.__shellyResize = function() {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  };
})();
true;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'about:blank';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// ---------------------------------------------------------------------------
// BrowserPane
// ---------------------------------------------------------------------------

export interface BrowserPaneProps {
  initialUrl?: string;
  /** When false the pane is hidden but kept mounted to preserve page state. */
  visible?: boolean;
}

// Module-scoped guard against stale `openSignal.url` poisoning fresh
// Browser Panes. The store never clears openSignal.url, so once any
// xdg-open / deep link has dispatched a URL, the value sticks
// forever. Without this guard, opening a fresh Browser Pane manually
// (Sidebar "+ browser" / split) hours later would silently reload
// the last URL — confusing, since the user expected about:blank.
//
// We track the last seq the BrowserPane mount-initializer has
// consumed. A new mount only honours `openSignal.url` if its seq is
// strictly greater than the last consumed one. The existing pane-
// instance navigation `useEffect` (which has its own per-instance
// `lastOpenSeqRef`) is unchanged — it still fires on every seq bump
// to navigate the already-mounted Browser Pane.
let lastConsumedOpenSignalSeq = 0;

// User-Agent strings. The Android system WebView default UA includes a
// `wv` token (Build/...; wv) AppleWebKit) which providers like Google,
// Anthropic, and many other OAuth flows treat as an "embedded WebView"
// signal and refuse to show their sign-in UI for. Google's
// "disable_webview_sign_in" policy is the canonical example: it returns
// a "this browser or app may not be secure" error page in Chrome WebView.
//
// Phase 1 OAuth on Shelly fundamentally needs WebView to look like a
// real Chrome instance to providers, otherwise Browser Pane navigation
// reaches the auth URL but the consent / sign-in UI is gated. Strip
// the `wv` token by setting a custom mobile UA matching real Chrome on
// Android. Same UA Chrome on Android sends today (Chrome 131 stable).
//
// When the user picks "Desktop" we send a Mac Chrome UA instead — same
// rationale as before (YouTube etc. show a more usable layout on
// desktop).
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 ' +
  'Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default function BrowserPane({ initialUrl = 'about:blank' }: BrowserPaneProps) {
  const theme = useTheme();
  const { background, surface, foreground, muted, accent, border } = theme.colors;
  const paneId = useContext(PaneIdContext);
  const paneMetrics = useContext(MultiPaneContext);
  const webviewRef = useRef<WebView>(null);
  const [desktopMode, setDesktopMode] = useState(false);
  const paneWidth = paneMetrics?.paneWidth ?? 0;
  const paneHeight = paneMetrics?.paneHeight ?? 0;
  const compactChrome = (paneWidth > 0 && paneWidth < 430) || (paneHeight > 0 && paneHeight < 380);
  const tinyChrome = (paneWidth > 0 && paneWidth < 320) || (paneHeight > 0 && paneHeight < 300);

  // NOTE (2026-05-08): keyboard avoidance was previously done locally here
  // with a Keyboard.addListener + paddingBottom: keyboardHeight on the root
  // View. This duplicated MultiPaneContainer's own keyboard handling
  // (gridHeight = size.H - keyboardHeight + paddingBottom: keyboardHeight on
  // its root) — the BrowserPane root was being shrunk a SECOND time on top
  // of the container shrink, which forced the WebView to resize 2-3 times
  // per keyboard toggle. YouTube and other heavy SPAs (custom compositors,
  // IntersectionObservers, layered scrollers) couldn't re-rasterize their
  // tiles fast enough and ended up with corrupted paint (search bar
  // duplicated, video grid disappearing, sections going black) until the
  // keyboard was dismissed. Plain HTML pages were unaffected because their
  // compositor has nothing to invalidate.
  //
  // Removed the local listener + padding entirely. The container already
  // moves the whole pane grid up by keyboardHeight, so PaneInputBar (which
  // renders inside this BrowserPane) rides above the keyboard automatically
  // without WebView needing to resize.
  //
  // Codex independent review confirmed the diagnosis (2026-05-08):
  //   "BrowserPane の paddingBottom は消すべき。MultiPaneContainer の
  //    設計コメントと矛盾している。これは明確に二重管理"

  // Fullscreen bridge: when the WebView posts 'shelly:fs:on' we maximize
  // this pane, force landscape orientation, and hide the system chrome so
  // the video takes over the whole screen like a native player. 'off'
  // reverses everything. The "was already" flags let the unmount path
  // restore only what we actually changed.
  const wasMaximizedBeforeFs = useRef(false);
  const isFullscreen = useRef(false);

  const enterFullscreen = useCallback(async () => {
    if (isFullscreen.current) return;
    isFullscreen.current = true;
    // Android 15 / target SDK 36 ignores setRequestedOrientation from
    // non-default apps ("Ignoring requested fixed orientation" in
    // ActivityTaskManager). Skip the lockAsync call entirely — the user
    // can rotate the device manually if auto-rotate is on, and the pane
    // maximize + hidden nav bar already gives a near-full-screen feel.
    try {
      const navBar = await import('expo-navigation-bar');
      await navBar.setVisibilityAsync('hidden');
      await navBar.setBehaviorAsync('overlay-swipe');
    } catch {}
  }, []);

  const exitFullscreen = useCallback(async () => {
    if (!isFullscreen.current) return;
    isFullscreen.current = false;
    try {
      const navBar = await import('expo-navigation-bar');
      await navBar.setVisibilityAsync('visible');
    } catch {}
  }, []);

  // Ensure we exit cleanly when the pane unmounts (user closes the
  // browser pane in the middle of a fullscreen video).
  useEffect(() => {
    return () => {
      exitFullscreen();
    };
  }, [exitFullscreen]);

  // Fullscreen policy: default is PANE-CONTAINED — the video expands to
  // fill the current pane rectangle but the multi-pane grid (sidebar,
  // other panes, top/bottom bars) stays visible. This matches user
  // intent when they split browser next to a terminal + tap YT's
  // fullscreen button: they still want to see the other pane. Users
  // who want immersive app-wide fullscreen can long-press the pane
  // header → Maximize pane (separate affordance) before entering FS.
  const fullscreenPolicy = 'pane' as 'pane' | 'app';

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const data = e.nativeEvent.data;
      if (!paneId) return;
      const store = useMultiPaneStore.getState();
      if (data === 'shelly:fs:on') {
        if (fullscreenPolicy === 'app') {
          wasMaximizedBeforeFs.current = store.maximizedPaneId === paneId;
          if (!wasMaximizedBeforeFs.current) {
            store.toggleMaximize(paneId);
          }
          enterFullscreen();
        }
        // In 'pane' mode we leave the layout untouched. The WebView's
        // own fullscreen handling already expands the <video> element
        // to fill the WebView's current bounds, which IS the pane, so
        // nothing else needs to happen on the RN side.
      } else if (data === 'shelly:fs:off') {
        if (fullscreenPolicy === 'app') {
          if (!wasMaximizedBeforeFs.current && useMultiPaneStore.getState().maximizedPaneId === paneId) {
            store.toggleMaximize(paneId);
          }
          exitFullscreen();
        }
      }
    },
    [paneId, enterFullscreen, exitFullscreen],
  );

  // Selector-based reads. Whole-store destructure (`useBrowserStore()`)
  // re-renders on every store update including `openSignal` / `navSignal`
  // bumps. Combined with the new pane-resize injectJavaScript effect and
  // YouTube's heavy SPA traffic (onMessage / onNavigationStateChange
  // burst), this contributed to the 40 fps render storm observed on
  // Z Fold6 hardware. Per-key selectors only re-fire on the slice
  // actually changing.
  const userBookmarks = useBrowserStore((s) => s.bookmarks);
  const addBookmark = useBrowserStore((s) => s.addBookmark);
  const removeBookmark = useBrowserStore((s) => s.removeBookmark);
  const loadBookmarks = useBrowserStore((s) => s.loadBookmarks);
  // Presets are always shown first, followed by user-added bookmarks
  const bookmarks = React.useMemo(
    () => [...PRESET_BOOKMARKS, ...userBookmarks],
    [userBookmarks],
  );

  // Resolve the URL to show on first mount. The drainQueue path in
  // app/_layout.tsx and the deep-link handler both call
  // `addPane('browser')` THEN `openUrl(url)` — addPane creates a fresh
  // Browser Pane in a new slot and openUrl bumps the openSignal seq.
  // If we naively initialised currentUrl to `initialUrl` ('about:blank'),
  // the new Browser Pane would mount with about:blank, then its
  // useEffect would compare openSignal.seq to lastOpenSeqRef (set to
  // CURRENT seq on mount, which is post-openUrl), see they're equal,
  // and skip the navigation — the user gets an empty Browser Pane
  // even though a URL was queued. Instead, peek at the latest
  // openSignal.url at mount time and use it as the initial URL when
  // present. This is the fix for "xdg-open https://example.com opens
  // a Browser Pane but the URL doesn't load" reported on Z Fold6.
  //
  // The `lastConsumedOpenSignalSeq > seq` guard prevents stale URLs
  // from poisoning fresh manual Browser Pane opens long after the
  // last queued URL. Without it, a Sidebar "+ browser" hours later
  // would silently reload the last xdg-open'd URL.
  const initialResolvedUrl = (() => {
    const s = useBrowserStore.getState();
    if (
      s.openSignal.url &&
      s.openSignal.seq > lastConsumedOpenSignalSeq &&
      /^https?:\/\//i.test(s.openSignal.url)
    ) {
      lastConsumedOpenSignalSeq = s.openSignal.seq;
      return s.openSignal.url;
    }
    return initialUrl;
  })();
  const [inputUrl, setInputUrl] = useState(
    initialResolvedUrl === 'about:blank' ? '' : initialResolvedUrl,
  );
  const [currentUrl, setCurrentUrl] = useState(initialResolvedUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [activeBookmarkIdx, setActiveBookmarkIdx] = useState(0);

  const navSignal = useBrowserStore((s) => s.navSignal);
  const openSignal = useBrowserStore((s) => s.openSignal);

  useEffect(() => {
    loadBookmarks();
  }, []);

  // Listen for nav actions from PaneSlot header
  const lastSeqRef = useRef(navSignal.seq);
  useEffect(() => {
    if (navSignal.seq === lastSeqRef.current) return;
    lastSeqRef.current = navSignal.seq;
    switch (navSignal.action) {
      case 'back': webviewRef.current?.goBack(); break;
      case 'forward': webviewRef.current?.goForward(); break;
      case 'reload': webviewRef.current?.reload(); break;
    }
  }, [navSignal.seq]);

  // Listen for external openUrl requests (Sidebar cloud buttons, etc.)
  const lastOpenSeqRef = useRef(openSignal.seq);
  useEffect(() => {
    if (openSignal.seq === lastOpenSeqRef.current) return;
    lastOpenSeqRef.current = openSignal.seq;
    if (openSignal.url) {
      setInputUrl(openSignal.url);
      setCurrentUrl(openSignal.url);
    }
  }, [openSignal.seq]);

  const handleSubmit = useCallback(() => {
    const url = normalizeUrl(inputUrl);
    setCurrentUrl(url);
  }, [inputUrl]);

  // Track URL bar focus so background navigation events (redirects, OAuth
  // bounces, YouTube prefetch frames, etc.) don't trample the URL the user
  // is in the middle of typing. Without this guard, typing
  // `youtube.com<enter>` while WebView still has a previous page mounted
  // results in setInputUrl(currentPageUrl) firing mid-keystroke and the
  // user sees their input apparently deleted.
  const [urlFocused, setUrlFocused] = useState(false);
  const urlFocusedRef = useRef(false);
  useEffect(() => { urlFocusedRef.current = urlFocused; }, [urlFocused]);

  // Android: TextInput.onBlur does NOT fire when the soft keyboard is
  // dismissed via the system back button (RN issue facebook/react-native#29571,
  // open since 2020). If the user focuses the URL bar, types nothing, then
  // back-presses to close the keyboard, `urlFocused` stays true forever and
  // `handleNavigationStateChange` permanently stops syncing the URL bar with
  // the live WebView URL — every subsequent page navigation looks broken.
  // Wire keyboardDidHide as a forced-blur fallback. Safe because if the bar
  // really is focused with keyboard up via a different IME path, hide-then-
  // show cycles will re-focus and re-set urlFocused via onFocus.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setUrlFocused(false);
    });
    return () => sub.remove();
  }, []);

  const handleNavigationStateChange = useCallback((state: WebViewNavigation) => {
    setCanGoBack(state.canGoBack);
    setCanGoForward(state.canGoForward);
    if (state.url && state.url !== 'about:blank' && !urlFocusedRef.current) {
      setInputUrl(state.url);
    }
    setCurrentUrl(state.url ?? 'about:blank');
  }, []);

  const handleBack = useCallback(() => { webviewRef.current?.goBack(); }, []);
  const handleForward = useCallback(() => { webviewRef.current?.goForward(); }, []);
  const handleRefresh = useCallback(() => { webviewRef.current?.reload(); }, []);

  // Force a JS-level resize event whenever the pane changes size. The
  // Android WebView container resizes its viewport, but pages that use
  // ResizeObserver / window.onresize listeners often miss the change
  // because no `resize` is dispatched on a same-document layout shift.
  // Result: page stays laid out for the previous pane width — content
  // gets cut off / scaled wrong. Hand-firing keeps the page in sync.
  useEffect(() => {
    if (paneWidth <= 0 || paneHeight <= 0) return;
    webviewRef.current?.injectJavaScript(`
      try { window.__shellyResize && window.__shellyResize(); } catch (e) {}
      true;
    `);
  }, [paneWidth, paneHeight]);

  const handleBookmarkTap = useCallback((url: string, index: number) => {
    setActiveBookmarkIdx(index);
    setInputUrl(url);
    setCurrentUrl(url);
  }, []);

  const handleBottomBarSubmit = useCallback((text: string) => {
    const url = normalizeUrl(text);
    setInputUrl(url);
    setCurrentUrl(url);
  }, []);

  return (
    <View
      style={[styles.root, { backgroundColor: C.bgDeep }]}
    >
      {/* URL bar */}
      <View style={[styles.toolbar, compactChrome && styles.toolbarCompact]}>
        <TouchableOpacity
          onPress={handleBack}
          disabled={!canGoBack}
          style={[styles.navBtn, compactChrome && styles.navBtnCompact, !canGoBack && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-back" size={compactChrome ? 13 : 16} color={canGoBack ? C.text1 : C.border} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleForward}
          disabled={!canGoForward}
          style={[styles.navBtn, compactChrome && styles.navBtnCompact, !canGoForward && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-forward" size={compactChrome ? 13 : 16} color={canGoForward ? C.text1 : C.border} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleRefresh} style={[styles.navBtn, compactChrome && styles.navBtnCompact]}>
          <MaterialIcons name="refresh" size={compactChrome ? 13 : 16} color={C.text1} />
        </TouchableOpacity>
        <TextInput
          style={[styles.urlInput, compactChrome && styles.urlInputCompact]}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={handleSubmit}
          onFocus={() => setUrlFocused(true)}
          onBlur={() => setUrlFocused(false)}
          placeholder="Enter a URL"
          placeholderTextColor={C.text2}
          // Explicit selectionColor / cursorColor so the caret + text-
          // selection highlight remain visible against the dark URL bar
          // background regardless of the active theme preset. Some Android
          // themes default to a near-invisible cursor on dark inputs,
          // which user-facing logged as "address bar text isn't visible"
          // (the text was there, the caret wasn't, and the user couldn't
          // see where they were typing).
          selectionColor={C.accent}
          cursorColor={C.accent}
          autoCapitalize="none"
          autoCorrect={false}
          // autoComplete + importantForAutofill kill the Android autofill
          // overlay that competes with IME composition on URL fields. Without
          // these, Samsung IME on Galaxy Z Fold6 shows suggestion chips for
          // "youtube" but never commits the composing text into the field
          // because autofill thinks it owns the input — user sees their typed
          // text disappear into the suggestion bar.
          autoComplete="off"
          importantForAutofill="no"
          keyboardType="url"
          returnKeyType="go"
        />
        {inputUrl.length > 0 && (
          <TouchableOpacity
            onPress={() => setInputUrl('')}
            style={[styles.navBtn, compactChrome && styles.navBtnCompact]}
          >
            <MaterialIcons name="close" size={compactChrome ? 12 : 14} color={C.text2} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => setDesktopMode((v) => !v)}
          style={[
            styles.navBtn,
            compactChrome && styles.navBtnCompact,
            desktopMode && { backgroundColor: withAlpha(C.accent, 0.12) },
          ]}
          accessibilityLabel={desktopMode ? 'Switch to mobile view' : 'Switch to desktop view'}
        >
          <MaterialIcons
            name={desktopMode ? 'desktop-windows' : 'smartphone'}
            size={compactChrome ? 12 : 14}
            color={desktopMode ? C.accent : C.text2}
          />
        </TouchableOpacity>
      </View>

      {/* Bookmark tabs — tab style matching mock */}
      {!tinyChrome && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.bookmarksBar, compactChrome && styles.bookmarksBarCompact]}
          contentContainerStyle={[styles.bookmarksContent, compactChrome && styles.bookmarksContentCompact]}
        >
          {bookmarks.map((bm, idx) => {
            const isActive = idx === activeBookmarkIdx;
            const isPreset = idx < PRESET_BOOKMARKS.length;
            // Preset icons use their brand color; user bookmarks follow theme
            const iconColor = bm.color ?? (isActive ? C.accent : C.text2);
            return (
              <TouchableOpacity
                key={bm.url}
                style={[
                  styles.bookmarkTab,
                  compactChrome && styles.bookmarkTabCompact,
                  isActive && styles.bookmarkTabActive,
                ]}
                onPress={() => handleBookmarkTap(bm.url, idx)}
              >
                <MaterialIcons
                  name={bm.icon as any}
                  size={compactChrome ? 11 : 12}
                  color={iconColor}
                />
                {!compactChrome && (
                  <Text
                    style={[
                      styles.bookmarkLabel,
                      isActive && styles.bookmarkLabelActive,
                    ]}
                    numberOfLines={1}
                  >
                    {bm.label.toUpperCase()}
                  </Text>
                )}
                {isActive && !isPreset && !compactChrome && (
                  <TouchableOpacity
                    hitSlop={8}
                    style={styles.bookmarkClose}
                    onPress={(e) => {
                      e.stopPropagation();
                      removeBookmark(bm.url);
                      setActiveBookmarkIdx(0);
                    }}
                  >
                    <MaterialIcons name="close" size={10} color="#6B7280" />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* WebView */}
      {currentUrl === 'about:blank' ? (
        <View style={styles.blankScreen}>
          <Text style={styles.blankText}>Enter a URL above to browse</Text>
        </View>
      ) : (
        <WebView
          // `key` forces a remount when desktopMode flips so the new UA
          // takes effect immediately — react-native-webview otherwise
          // caches the UA per instance.
          key={desktopMode ? 'desktop' : 'mobile'}
          ref={webviewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          // textZoom kept at 90% in compact panes as a legibility safety
          // net. The viewport-meta injection handles pages that lack a
          // viewport tag, but mainstream pages already ship their own
          // viewport — for those, only a textZoom nudge actually
          // affects perceived text size in a narrow pane. 90% is
          // gentler than the previous 85% which produced inconsistent
          // UX between text and surrounding chrome.
          textZoom={compactChrome ? 90 : 100}
          userAgent={desktopMode ? DESKTOP_UA : MOBILE_UA}
          // androidLayerType intentionally left at default ('none').
          // Phase 1.1 (PR #37) tried 'hardware' for GPU-accelerated
          // scroll / video / CSS transforms, but on-device test on
          // Galaxy Z Fold6 (Android 14) revealed partial-paint
          // regressions on YouTube: the WebView allocated tile
          // textures that were either too small or never composited,
          // leaving the player area mostly blank. The default lets
          // the system pick, and on Android 14 that's already
          // accelerated for video. Revisit only if profiling shows
          // the default path is genuinely too slow.
          onNavigationStateChange={handleNavigationStateChange}
          onMessage={handleMessage}
          // RESPONSIVE_BRIDGE_JS must run BEFORE first paint so the
          // injected viewport meta and userAgentData mask are in
          // place before Chromium's initial layout / fingerprinting.
          // FULLSCREEN_BRIDGE_JS is appended to the same string so we
          // only invoke one before-content-loaded payload.
          injectedJavaScriptBeforeContentLoaded={
            RESPONSIVE_BRIDGE_JS + FULLSCREEN_BRIDGE_JS
          }
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          allowsInlineMediaPlayback
          // Allow https pages to load http subresources where modern
          // browsers would. `compatibility` matches Chrome stable's
          // mixed-content policy — opt out of `never` (the WebView
          // default) which silently breaks legacy intranet/SAML setups.
          // Note: this is not what fixes Google / Anthropic OAuth (those
          // are HTTPS end-to-end); it's just bringing WebView in line
          // with system browser behaviour.
          mixedContentMode="compatibility"
          onError={() => {
            // Reload on render-process crash so YouTube recovers instead
            // of showing a blank white screen until manual refresh.
            setTimeout(() => webviewRef.current?.reload(), 500);
          }}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <Text style={styles.blankText}>Loading...</Text>
            </View>
          )}
        />
      )}

      {/* Bottom bar */}
      {!compactChrome && (
        <PaneInputBar
          placeholder="Search or enter URL..."
          onSubmit={handleBottomBarSubmit}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bgSurface,
    gap: 4,
  },
  toolbarCompact: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    gap: 2,
  },
  navBtn: {
    width: 28,
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navBtnCompact: {
    width: 22,
    height: 22,
    borderRadius: 3,
  },
  navBtnDisabled: {
    opacity: 0.35,
  },
  urlInput: {
    flex: 1,
    height: 32,
    borderRadius: 4,
    backgroundColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 0,
    fontFamily: F.family,
    fontSize: 13,
    color: C.text1,
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  urlInputCompact: {
    height: 26,
    borderRadius: 3,
    paddingHorizontal: 6,
    fontSize: 12,
  },
  bookmarksBar: {
    height: 32,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
    flexGrow: 0,
  },
  bookmarksBarCompact: {
    height: 24,
  },
  bookmarksContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 2,
    height: 32,
  },
  bookmarksContentCompact: {
    height: 24,
    paddingHorizontal: 4,
    gap: 1,
  },
  bookmarkTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: 'transparent',
  },
  bookmarkTabCompact: {
    width: 24,
    height: 20,
    justifyContent: 'center',
    paddingHorizontal: 0,
    gap: 0,
  },
  bookmarkTabActive: {
    backgroundColor: C.border,
    borderWidth: 1,
    borderColor: C.border,
  },
  bookmarkLabel: {
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '700',
    color: C.text2,
    letterSpacing: 0.5,
  },
  bookmarkLabelActive: {
    color: C.text1,
  },
  bookmarkClose: {
    marginLeft: 4,
  },
  webview: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  blankScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: C.bgDeep,
  },
  blankText: {
    fontFamily: F.family,
    fontSize: 11,
    color: C.text2,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: C.bgDeep,
  },
});
