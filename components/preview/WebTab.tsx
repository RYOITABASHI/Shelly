import React, { useRef, useState, useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { getClickToEditScript, buildSetEditModeMessage, type SelectedElement } from '@/lib/click-to-edit';
import { EditSheet } from '@/components/chat/EditSheet';

interface WebTabProps {
  url: string | null;
  onClose: () => void;
  onEditSubmit?: (prompt: string) => void;
}

export function WebTab({ url, onClose, onEditSubmit }: WebTabProps) {
  const { colors: c } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);

  // Empty state when no URL
  if (!url) {
    return (
      <View style={[styles.container, { backgroundColor: c.background }]}>
        <View style={styles.placeholder}>
          <MaterialIcons name="language" size={32} color={c.muted} />
          <Text style={[styles.placeholderText, { color: c.muted }]}>
            Start a dev server or open an HTML file
          </Text>
        </View>
      </View>
    );
  }

  const shortUrl = url.replace(/^https?:\/\//, '');

  const handleReload = useCallback(() => {
    setError(false);
    setLoading(true);
    webViewRef.current?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    Linking.openURL(url);
  }, [url]);

  const toggleEditMode = useCallback(() => {
    const next = !editMode;
    setEditMode(next);
    if (!next) setSelectedElement(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    webViewRef.current?.postMessage(buildSetEditModeMessage(next));
  }, [editMode]);

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ELEMENT_SELECTED') {
        setSelectedElement({
          selector: data.selector,
          tagName: data.tagName,
          text: data.text,
          currentStyles: data.currentStyles,
          rect: data.rect,
        });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {}
  }, []);

  const handleEditSubmit = useCallback((prompt: string) => {
    onEditSubmit?.(prompt);
    setSelectedElement(null);
  }, [onEditSubmit]);

  const handleEditClose = useCallback(() => {
    setSelectedElement(null);
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: c.surfaceHigh, borderBottomColor: c.border }]}>
        <MaterialIcons name="language" size={14} color={c.accent} />
        <Text style={[styles.headerUrl, { color: c.foreground }]} numberOfLines={1}>
          {shortUrl}
        </Text>
        <View style={styles.headerActions}>
          {/* Click-to-Edit toggle */}
          <Pressable
            onPress={toggleEditMode}
            hitSlop={8}
            style={[styles.headerBtn, editMode && { backgroundColor: withAlpha(c.accent, 0.2), borderRadius: 4 }]}
          >
            <MaterialIcons name="touch-app" size={16} color={editMode ? c.accent : c.muted} />
          </Pressable>
          <Pressable onPress={handleReload} hitSlop={8} style={styles.headerBtn}>
            <MaterialIcons name="refresh" size={16} color={c.muted} />
          </Pressable>
          <Pressable onPress={handleOpenExternal} hitSlop={8} style={styles.headerBtn}>
            <MaterialIcons name="open-in-new" size={16} color={c.muted} />
          </Pressable>
        </View>
      </View>

      {/* Edit mode banner */}
      {editMode && (
        <View style={[styles.editBanner, { backgroundColor: withAlpha(c.accent, 0.1) }]}>
          <Text style={[styles.editBannerText, { color: c.accent }]}>
            Edit Mode: tap an element to modify
          </Text>
        </View>
      )}

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
          onMessage={handleWebViewMessage}
          injectedJavaScript={getClickToEditScript()}
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

      {/* EditSheet */}
      <EditSheet
        visible={editMode && selectedElement !== null}
        element={selectedElement}
        onSubmit={handleEditSubmit}
        onClose={handleEditClose}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  editBanner: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  editBannerText: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
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
    top: 38,
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
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  placeholderText: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
});
