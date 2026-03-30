import React, { memo, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;

function wrapHtmlWithCSP(raw: string): string {
  if (raw.includes('<head>')) return raw.replace('<head>', `<head>${CSP_META}`);
  if (raw.includes('<html>')) return raw.replace('<html>', `<html><head>${CSP_META}</head>`);
  return `<html><head>${CSP_META}</head><body>${raw}</body></html>`;
}

type Props = { html: string };

export const HtmlRenderer = memo(function HtmlRenderer({ html }: Props) {
  const safeHtml = useMemo(() => wrapHtmlWithCSP(html), [html]);
  return (
    <WebView
      source={{ html: safeHtml }}
      style={styles.webview}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      originWhitelist={['about:blank']}
    />
  );
});

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: 'transparent' },
});
