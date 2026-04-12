import React, { useRef, useState, useCallback, useEffect, useContext } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import WebView, { WebViewNavigation, WebViewMessageEvent } from 'react-native-webview';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { useBrowserStore, PRESET_BOOKMARKS } from '@/store/browser-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import { PaneIdContext } from '@/components/multi-pane/PaneSlot';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

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

  // 4: monkey-patch requestFullscreen so wrapper elements also fire
  var origRF = HTMLElement.prototype.requestFullscreen;
  if (origRF) {
    HTMLElement.prototype.requestFullscreen = function() {
      post('on');
      return origRF.apply(this, arguments);
    };
  }
  var origWF = HTMLElement.prototype.webkitRequestFullscreen;
  if (origWF) {
    HTMLElement.prototype.webkitRequestFullscreen = function() {
      post('on');
      return origWF.apply(this, arguments);
    };
  }
  var origExit = Document.prototype.exitFullscreen;
  if (origExit) {
    Document.prototype.exitFullscreen = function() {
      post('off');
      return origExit.apply(this, arguments);
    };
  }
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
}

// User-Agent strings. Mobile is the react-native-webview default, so when
// the user picks "Desktop" we send a current Chrome UA instead. Desktop UA
// is useful on sites like YouTube where the mobile layout has giant tiles
// and is painful to scroll through looking for a video.
const MOBILE_UA = undefined; // let the WebView pick its default
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default function BrowserPane({ initialUrl = 'about:blank' }: BrowserPaneProps) {
  const theme = useTheme();
  const { background, surface, foreground, muted, accent, border } = theme.colors;
  const paneId = useContext(PaneIdContext);
  const [desktopMode, setDesktopMode] = useState(false);

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

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const data = e.nativeEvent.data;
      if (!paneId) return;
      const store = useMultiPaneStore.getState();
      if (data === 'shelly:fs:on') {
        wasMaximizedBeforeFs.current = store.maximizedPaneId === paneId;
        if (!wasMaximizedBeforeFs.current) {
          store.toggleMaximize(paneId);
        }
        enterFullscreen();
      } else if (data === 'shelly:fs:off') {
        if (!wasMaximizedBeforeFs.current && useMultiPaneStore.getState().maximizedPaneId === paneId) {
          store.toggleMaximize(paneId);
        }
        exitFullscreen();
      }
    },
    [paneId, enterFullscreen, exitFullscreen],
  );

  const { bookmarks: userBookmarks, addBookmark, removeBookmark, loadBookmarks } = useBrowserStore();
  // Presets are always shown first, followed by user-added bookmarks
  const bookmarks = React.useMemo(
    () => [...PRESET_BOOKMARKS, ...userBookmarks],
    [userBookmarks],
  );

  const webviewRef = useRef<WebView>(null);
  const [inputUrl, setInputUrl] = useState(initialUrl === 'about:blank' ? '' : initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
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

  const handleNavigationStateChange = useCallback((state: WebViewNavigation) => {
    setCanGoBack(state.canGoBack);
    setCanGoForward(state.canGoForward);
    if (state.url && state.url !== 'about:blank') {
      setInputUrl(state.url);
    }
    setCurrentUrl(state.url ?? 'about:blank');
  }, []);

  const handleBack = useCallback(() => { webviewRef.current?.goBack(); }, []);
  const handleForward = useCallback(() => { webviewRef.current?.goForward(); }, []);
  const handleRefresh = useCallback(() => { webviewRef.current?.reload(); }, []);

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
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: C.bgDeep }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* URL bar */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          onPress={handleBack}
          disabled={!canGoBack}
          style={[styles.navBtn, !canGoBack && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-back" size={16} color={canGoBack ? C.text1 : C.border} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleForward}
          disabled={!canGoForward}
          style={[styles.navBtn, !canGoForward && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-forward" size={16} color={canGoForward ? C.text1 : C.border} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleRefresh} style={styles.navBtn}>
          <MaterialIcons name="refresh" size={16} color={C.text1} />
        </TouchableOpacity>
        <TextInput
          style={styles.urlInput}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={handleSubmit}
          placeholder="Enter a URL"
          placeholderTextColor="#6B7280"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
        />
        {inputUrl.length > 0 && (
          <TouchableOpacity
            onPress={() => setInputUrl('')}
            style={styles.navBtn}
          >
            <MaterialIcons name="close" size={14} color="#6B7280" />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => setDesktopMode((v) => !v)}
          style={[
            styles.navBtn,
            desktopMode && { backgroundColor: 'rgba(0,212,170,0.12)' },
          ]}
          accessibilityLabel={desktopMode ? 'Switch to mobile view' : 'Switch to desktop view'}
        >
          <MaterialIcons
            name={desktopMode ? 'desktop-windows' : 'smartphone'}
            size={14}
            color={desktopMode ? C.accent : C.text2}
          />
        </TouchableOpacity>
      </View>

      {/* Bookmark tabs — tab style matching mock */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.bookmarksBar}
        contentContainerStyle={styles.bookmarksContent}
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
                isActive && styles.bookmarkTabActive,
              ]}
              onPress={() => handleBookmarkTap(bm.url, idx)}
            >
              <MaterialIcons
                name={bm.icon as any}
                size={12}
                color={iconColor}
              />
              <Text
                style={[
                  styles.bookmarkLabel,
                  isActive && styles.bookmarkLabelActive,
                ]}
                numberOfLines={1}
              >
                {bm.label.toUpperCase()}
              </Text>
              {isActive && !isPreset && (
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
          userAgent={desktopMode ? DESKTOP_UA : MOBILE_UA}
          onNavigationStateChange={handleNavigationStateChange}
          onMessage={handleMessage}
          injectedJavaScriptBeforeContentLoaded={FULLSCREEN_BRIDGE_JS}
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <Text style={styles.blankText}>Loading...</Text>
            </View>
          )}
        />
      )}

      {/* Bottom bar */}
      <PaneInputBar
        placeholder="Search or enter URL..."
        onSubmit={handleBottomBarSubmit}
      />
    </KeyboardAvoidingView>
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
  navBtn: {
    width: 28,
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navBtnDisabled: {
    opacity: 0.35,
  },
  urlInput: {
    flex: 1,
    height: 28,
    borderRadius: 4,
    backgroundColor: C.border,
    paddingHorizontal: 8,
    fontFamily: F.family,
    fontSize: 11,
    color: C.text1,
  },
  bookmarksBar: {
    height: 32,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
    flexGrow: 0,
  },
  bookmarksContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 2,
    height: 32,
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
