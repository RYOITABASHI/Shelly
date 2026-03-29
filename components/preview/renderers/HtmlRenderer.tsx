import React, { memo } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

type Props = { html: string };

export const HtmlRenderer = memo(function HtmlRenderer({ html }: Props) {
  return (
    <WebView
      source={{ html }}
      style={styles.webview}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
    />
  );
});

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: 'transparent' },
});
