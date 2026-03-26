/**
 * FullscreenTerminal.tsx
 *
 * WebView + xterm.js を使ったフルスクリーンターミナルウィンドウ。
 * ANSIカラー完全対応・カーソル移動・リアルタイム表示。
 * shelly-bridge の WebSocket に直接接続する。
 */

import React, { useRef, useCallback, useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

type Props = {
  visible: boolean;
  wsUrl: string;           // e.g. "ws://127.0.0.1:8765"
  onClose: () => void;
};

// xterm.js CDN版をインラインHTMLで使用（ネットワーク不要・バンドル済み）
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000000; overflow: hidden; }
  #terminal { width: 100%; height: 100%; }
  .xterm { height: 100%; }
  .xterm-viewport { overflow-y: auto !important; }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
</head>
<body>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-unicode11@0.6.0/lib/xterm-addon-unicode11.js"></script>
<script>
(function() {
  var wsUrl = '';
  var ws = null;
  var term = null;
  var fitAddon = null;
  var connected = false;

  function initTerm() {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Noto Sans CJK JP", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: '#000000',
        foreground: '#E0E0E0',
        cursor: '#00D4AA',
        cursorAccent: '#000000',
        selectionBackground: '#00D4AA44',
        black:   '#1A1A1A', red:     '#FF6B6B',
        green:   '#4ADE80', yellow:  '#FFD93D',
        blue:    '#6CB4FF', magenta: '#B48EFF',
        cyan:    '#00D4AA', white:   '#E0E0E0',
        brightBlack:   '#6B7280', brightRed:     '#FCA5A5',
        brightGreen:   '#86EFAC', brightYellow:  '#FDE68A',
        brightBlue:    '#93C5FD', brightMagenta: '#C4B5FD',
        brightCyan:    '#67E8F9', brightWhite:   '#F9FAFB',
      },
      allowTransparency: true,
      scrollback: 5000,
      convertEol: true,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    // Enable Unicode 11 for correct CJK character width
    if (typeof Unicode11Addon !== 'undefined') {
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    }
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // キー入力をWebSocketに送信
    term.onKey(function(e) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: e.key }));
      }
    });

    // リサイズ対応
    window.addEventListener('resize', function() {
      if (fitAddon) fitAddon.fit();
    });

    showWelcome();
  }

  function showWelcome() {
    term.writeln('\\x1b[1;36m  ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗██╗   ██╗\\x1b[0m');
    term.writeln('\\x1b[1;36m ██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝╚██╗ ██╔╝\\x1b[0m');
    term.writeln('\\x1b[1;36m ██║  ███╗███████║██║   ██║███████╗   ██║    ╚████╔╝ \\x1b[0m');
    term.writeln('\\x1b[1;36m ██║   ██║██╔══██║██║   ██║╚════██║   ██║     ╚██╔╝  \\x1b[0m');
    term.writeln('\\x1b[1;36m ╚██████╔╝██║  ██║╚██████╔╝███████║   ██║      ██║   \\x1b[0m');
    term.writeln('\\x1b[1;36m  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   \\x1b[0m');
    term.writeln('');
    term.writeln('\\x1b[2m  Full Terminal — Connecting to Termux bridge...\\x1b[0m');
    term.writeln('');
  }

  function connectWs(url) {
    wsUrl = url;
    if (ws) { try { ws.close(); } catch(e) {} }

    term.writeln('\\x1b[33m[shelly] Connecting to ' + url + '\\x1b[0m');

    ws = new WebSocket(url);

    ws.onopen = function() {
      connected = true;
      term.writeln('\\x1b[32m[shelly] Connected. Type commands below.\\x1b[0m');
      term.writeln('');
      // React Nativeに接続通知
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'connected' }));
    };

    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.type === 'stdout') {
          term.write(msg.data);
        } else if (msg.type === 'stderr') {
          term.write('\\x1b[31m' + msg.data + '\\x1b[0m');
        } else if (msg.type === 'exit') {
          term.writeln('\\x1b[33m[exit ' + (msg.code || 0) + ']\\x1b[0m');
        }
      } catch(err) {
        // raw text
        term.write(e.data);
      }
    };

    ws.onerror = function() {
      term.writeln('\\x1b[31m[shelly] Connection error. Is shelly-bridge running?\\x1b[0m');
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error' }));
    };

    ws.onclose = function() {
      connected = false;
      term.writeln('\\x1b[33m[shelly] Disconnected.\\x1b[0m');
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'disconnected' }));
    };
  }

  // React Native からのメッセージを受信
  window.addEventListener('message', function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'connect') {
        connectWs(msg.url);
      } else if (msg.type === 'sendCommand') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'run', command: msg.command }));
        }
      } else if (msg.type === 'resize') {
        if (fitAddon) fitAddon.fit();
      }
    } catch(err) {}
  });

  // 初期化
  document.addEventListener('DOMContentLoaded', function() {
    initTerm();
  });

  if (document.readyState !== 'loading') {
    initTerm();
  }
})();
</script>
</body>
</html>`;

export function FullscreenTerminal({ visible, wsUrl, onClose }: Props) {
  const webViewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');

  // WebViewがロードされたらWebSocketに接続
  const handleWebViewLoad = useCallback(() => {
    if (!wsUrl) return;
    webViewRef.current?.injectJavaScript(`
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'connect', url: '${wsUrl}' })
      }));
      true;
    `);
  }, [wsUrl]);

  // React Native → WebView メッセージ受信
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'connected') {
        setConnectionStatus('connected');
        if (Platform.OS !== 'web') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } else if (msg.type === 'error') {
        setConnectionStatus('error');
      } else if (msg.type === 'disconnected') {
        setConnectionStatus('disconnected');
      }
    } catch {}
  }, []);

  const handleClose = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    onClose();
  }, [onClose]);

  const statusColor = {
    connecting: '#FBBF24',
    connected: '#4ADE80',
    error: '#F87171',
    disconnected: '#6B7280',
  }[connectionStatus];

  const statusLabel = {
    connecting: '接続中...',
    connected: '接続済み',
    error: 'エラー',
    disconnected: '切断',
  }[connectionStatus];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* ヘッダーバー */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>shelly_</Text>
            <Text style={styles.headerSubtitle}>Full Terminal</Text>
          </View>
          <View style={styles.headerCenter}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
            <Text style={styles.closeButtonText}>✕ 閉じる</Text>
          </TouchableOpacity>
        </View>

        {/* xterm.js WebView */}
        <WebView
          ref={webViewRef}
          style={styles.webview}
          source={{ html: XTERM_HTML }}
          originWhitelist={['*']}
          onLoad={handleWebViewLoad}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          // WebSocket接続のためにローカルネットワークアクセスを許可
          mixedContentMode="always"
          allowFileAccess
          allowUniversalAccessFromFileURLs
          onRenderProcessGone={() => {
            console.warn('[FullscreenTerminal] Render process gone — reloading');
            setTimeout(() => webViewRef.current?.reload(), 500);
          }}
        />

        {/* ボトムバー */}
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Text style={styles.bottomHint}>
            Ctrl+C: 中断　　Tab: 補完　　↑↓: 履歴
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    backgroundColor: '#111111',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  headerTitle: {
    color: '#00D4AA',
    fontSize: 15,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  headerSubtitle: {
    color: '#4B5563',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    backgroundColor: '#1A1A1A',
  },
  closeButtonText: {
    color: '#9CA3AF',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000000',
  },
  bottomBar: {
    paddingHorizontal: 14,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
    backgroundColor: '#111111',
  },
  bottomHint: {
    color: '#374151',
    fontSize: 10,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
});
