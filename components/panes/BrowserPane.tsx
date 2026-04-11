import React, { useRef, useState, useCallback, useEffect } from 'react';
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
import WebView, { WebViewNavigation } from 'react-native-webview';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { useBrowserStore } from '@/store/browser-store';
import PaneInputBar from '@/components/panes/PaneInputBar';

const ACCENT = '#00D4AA';

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

export default function BrowserPane({ initialUrl = 'about:blank' }: BrowserPaneProps) {
  const theme = useTheme();
  const { background, surface, foreground, muted, accent, border } = theme.colors;

  const { bookmarks, addBookmark, loadBookmarks } = useBrowserStore();

  const webviewRef = useRef<WebView>(null);
  const [inputUrl, setInputUrl] = useState(initialUrl === 'about:blank' ? '' : initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [activeBookmarkIdx, setActiveBookmarkIdx] = useState(0);

  const navSignal = useBrowserStore((s) => s.navSignal);

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
      style={[styles.root, { backgroundColor: '#0A0A0A' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* URL bar */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          onPress={handleBack}
          disabled={!canGoBack}
          style={[styles.navBtn, !canGoBack && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-back" size={16} color={canGoBack ? '#E5E7EB' : '#333'} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleForward}
          disabled={!canGoForward}
          style={[styles.navBtn, !canGoForward && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-forward" size={16} color={canGoForward ? '#E5E7EB' : '#333'} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleRefresh} style={styles.navBtn}>
          <MaterialIcons name="refresh" size={16} color="#E5E7EB" />
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
        <TouchableOpacity onPress={handleRefresh} style={styles.navBtn}>
          <MaterialIcons name="close" size={14} color="#6B7280" />
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
                color={isActive ? ACCENT : '#6B7280'}
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
              {isActive && (
                <TouchableOpacity hitSlop={8} style={styles.bookmarkClose}>
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
          ref={webviewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          onNavigationStateChange={handleNavigationStateChange}
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
    borderBottomColor: '#1A1A1A',
    backgroundColor: '#111',
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
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 8,
    fontFamily: 'GeistPixel-Square',
    fontSize: 11,
    color: '#E5E7EB',
  },
  bookmarksBar: {
    height: 32,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    backgroundColor: '#0D0D0D',
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
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333',
  },
  bookmarkLabel: {
    fontFamily: 'GeistPixel-Square',
    fontSize: 9,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.5,
  },
  bookmarkLabelActive: {
    color: '#E5E7EB',
  },
  bookmarkClose: {
    marginLeft: 4,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  blankScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
  },
  blankText: {
    fontFamily: 'GeistPixel-Square',
    fontSize: 11,
    color: '#6B7280',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
  },
});
