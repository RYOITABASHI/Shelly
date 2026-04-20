/**
 * WebPreviewModal — Renders generated HTML in a WebView.
 * The "correct reincarnation" of the deleted Browser tab.
 */
import React from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  html: string;
  onClose: () => void;
};

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;

function wrapHtmlWithCSP(raw: string): string {
  if (raw.includes('<head>')) {
    return raw.replace('<head>', `<head>${CSP_META}`);
  }
  if (raw.includes('<html>')) {
    return raw.replace('<html>', `<html><head>${CSP_META}</head>`);
  }
  return `<html><head>${CSP_META}</head><body>${raw}</body></html>`;
}

export function WebPreviewModal({ visible, html, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const safeHtml = wrapHtmlWithCSP(html);

  return (
    <ShellyModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: insets.top }]}>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('preview.title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={colors.inactive} />
            </Pressable>
          </View>
          <WebView
            source={{ html: safeHtml }}
            style={styles.webview}
            originWhitelist={['about:blank']}
            javaScriptEnabled={false}
            domStorageEnabled={false}
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            scrollEnabled
            onShouldStartLoadWithRequest={(req) => req.url === 'about:blank'}
          />
        </View>
      </View>
    </ShellyModal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#00000088',
  },
  container: {
    flex: 1,
    marginTop: 40,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  webview: {
    flex: 1,
  },
});
