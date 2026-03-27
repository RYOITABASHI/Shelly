import React, { useRef, useState, useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Linking from 'expo-linking';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

interface PreviewPanelProps {
  url: string;
  onClose: () => void;
}

export function PreviewPanel({ url, onClose }: PreviewPanelProps) {
  const { colors: c } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const shortUrl = url.replace(/^https?:\/\//, '');

  const handleReload = useCallback(() => {
    setError(false);
    setLoading(true);
    webViewRef.current?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    Linking.openURL(url);
  }, [url]);

  return (
    <View style={[styles.container, { backgroundColor: c.background, borderLeftColor: c.border }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: c.surfaceHigh, borderBottomColor: c.border }]}>
        <MaterialIcons name="language" size={14} color={c.accent} />
        <Text style={[styles.headerUrl, { color: c.foreground }]} numberOfLines={1}>
          {shortUrl}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={handleReload} hitSlop={8} style={styles.headerBtn}>
            <MaterialIcons name="refresh" size={16} color={c.muted} />
          </Pressable>
          <Pressable onPress={handleOpenExternal} hitSlop={8} style={styles.headerBtn}>
            <MaterialIcons name="open-in-new" size={16} color={c.muted} />
          </Pressable>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerBtn}>
            <MaterialIcons name="close" size={16} color={c.muted} />
          </Pressable>
        </View>
      </View>

      {/* WebView */}
      {error ? (
        <View style={styles.errorContainer}>
          <MaterialIcons name="wifi-off" size={32} color={c.muted} />
          <Text style={[styles.errorText, { color: c.muted }]}>
            Cannot connect to {shortUrl}
          </Text>
          <Pressable
            onPress={handleReload}
            style={[styles.retryBtn, { backgroundColor: c.accent }]}
          >
            <Text style={[styles.retryText, { color: c.background }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ uri: url }}
          style={styles.webview}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => { setError(true); setLoading(false); }}
          onHttpError={() => { setError(true); setLoading(false); }}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          renderLoading={() => (
            <View style={[StyleSheet.absoluteFill, styles.loadingContainer, { backgroundColor: c.background }]}>
              <ActivityIndicator size="small" color={c.accent} />
            </View>
          )}
        />
      )}

      {/* Loading indicator overlay */}
      {loading && !error && (
        <View style={[styles.loadingBar, { backgroundColor: c.accent }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    borderLeftWidth: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 6,
  },
  headerUrl: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 4,
  },
  headerBtn: {
    padding: 4,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingBar: {
    position: 'absolute',
    top: 38, // below header
    left: 0,
    right: 0,
    height: 2,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 6,
    marginTop: 8,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '600',
  },
});
