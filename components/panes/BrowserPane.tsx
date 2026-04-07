import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import WebView, { WebViewNavigation } from 'react-native-webview';
import { useTheme } from '@/lib/theme-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'about:blank';
  // Already has a scheme
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  // Looks like a bare domain (contains a dot, no spaces)
  if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`;
  // Fall back to a search
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// ---------------------------------------------------------------------------
// NavButton
// ---------------------------------------------------------------------------

interface NavButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accent: string;
  muted: string;
  surface: string;
  border: string;
}

function NavButton({ label, onPress, disabled, accent, muted, surface, border }: NavButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.navButton,
        { backgroundColor: surface, borderColor: border },
        disabled && styles.navButtonDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.navButtonText,
          { color: disabled ? muted : accent },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// BrowserPane
// ---------------------------------------------------------------------------

export interface BrowserPaneProps {
  initialUrl?: string;
}

export default function BrowserPane({ initialUrl = 'about:blank' }: BrowserPaneProps) {
  const theme = useTheme();
  const { background, surface, surfaceAlt, foreground, muted, accent, border } = theme.colors;

  const webviewRef = useRef<WebView>(null);
  const [inputUrl, setInputUrl] = useState(initialUrl === 'about:blank' ? '' : initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  // Called when the user commits the URL bar
  const handleSubmit = useCallback(() => {
    const url = normalizeUrl(inputUrl);
    setCurrentUrl(url);
  }, [inputUrl]);

  // Sync URL bar with page navigations (e.g. link clicks inside WebView)
  const handleNavigationStateChange = useCallback((state: WebViewNavigation) => {
    setCanGoBack(state.canGoBack);
    setCanGoForward(state.canGoForward);
    if (state.url && state.url !== 'about:blank') {
      setInputUrl(state.url);
    }
    setCurrentUrl(state.url ?? 'about:blank');
  }, []);

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ── URL bar ─────────────────────────────────────────────────── */}
      <View style={[styles.toolbar, { backgroundColor: surfaceAlt, borderBottomColor: border }]}>
        {/* Back */}
        <NavButton
          label="←"
          onPress={handleBack}
          disabled={!canGoBack}
          accent={accent}
          muted={muted}
          surface={surface}
          border={border}
        />

        {/* Forward */}
        <NavButton
          label="→"
          onPress={handleForward}
          disabled={!canGoForward}
          accent={accent}
          muted={muted}
          surface={surface}
          border={border}
        />

        {/* Refresh */}
        <NavButton
          label="↻"
          onPress={handleRefresh}
          accent={accent}
          muted={muted}
          surface={surface}
          border={border}
        />

        {/* URL TextInput */}
        <TextInput
          style={[
            styles.urlInput,
            {
              backgroundColor: surface,
              borderColor: border,
              color: foreground,
            },
          ]}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={handleSubmit}
          placeholder="Enter a URL"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
        />
      </View>

      {/* ── WebView ─────────────────────────────────────────────────── */}
      {currentUrl === 'about:blank' ? (
        <View style={[styles.blankScreen, { backgroundColor: background }]}>
          <Text style={[styles.blankText, { color: muted }]}>Enter a URL above to browse</Text>
        </View>
      ) : (
        <WebView
          ref={webviewRef}
          source={{ uri: currentUrl }}
          style={[styles.webview, { backgroundColor: background }]}
          onNavigationStateChange={handleNavigationStateChange}
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          startInLoadingState
          renderLoading={() => (
            <View style={[styles.loadingOverlay, { backgroundColor: background }]}>
              <Text style={[styles.blankText, { color: muted }]}>Loading…</Text>
            </View>
          )}
        />
      )}
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
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 6,
  },
  navButton: {
    width: 36,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navButtonDisabled: {
    opacity: 0.35,
  },
  navButtonText: {
    fontSize: 16,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  urlInput: {
    flex: 1,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  webview: {
    flex: 1,
  },
  blankScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  blankText: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    justifyContent: 'center',
    alignItems: 'center',
  } as any,
});
