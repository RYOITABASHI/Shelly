/**
 * Terminal Screen — Raw terminal via ttyd + WebView
 * Japanese input proxy + auto-retry + setup guide
 */
import React, { useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTtydConnection } from '@/hooks/use-ttyd-connection';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASHRC_SCRIPT = `# Shelly auto-start
if ! pgrep -x ttyd > /dev/null; then
  ttyd -W -p 7681 bash &>/dev/null &
fi`;

type ConnectionState = 'connecting' | 'connected' | 'error';

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const inputRef = useRef<TextInput>(null);
  const {
    status,
    retryCount,
    retry,
    onWebViewLoad,
    onWebViewError,
    ttyUrl,
  } = useTtydConnection();

  // Japanese input proxy state
  const [jpInput, setJpInput] = useState('');
  const [showJpInput, setShowJpInput] = useState(false);

  const handleReload = () => {
    retry();
    webViewRef.current?.reload();
  };

  // Send text to terminal via ttyd WebSocket (Bracketed Paste Mode)
  const sendToTerminal = useCallback((text: string) => {
    if (!webViewRef.current || !text) return;
    // Use JSON.stringify for safe JS string escaping (prevents XSS injection)
    const safeText = JSON.stringify(text);
    // Use ttyd's terminal write API via injected JS
    const js = `
      (function() {
        var text = ${safeText};
        var term = window.term || document.querySelector('.xterm')?.xterm;
        if (term && term._core && term._core._coreService) {
          var data = '\\x1b[200~' + text + '\\x1b[201~';
          term._core._coreService.triggerDataEvent(data, true);
        } else if (window.socket && window.socket.send) {
          window.socket.send('0' + text);
        }
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(js);
  }, []);

  const handleJpSend = useCallback(() => {
    const text = jpInput.trim();
    if (!text) return;
    sendToTerminal(text);
    setJpInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [jpInput, sendToTerminal]);

  const handleJpSendNewline = useCallback(() => {
    const text = jpInput;
    if (!text) {
      // Just send Enter
      sendToTerminal('\r');
      return;
    }
    sendToTerminal(text + '\r');
    setJpInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [jpInput, sendToTerminal]);

  const toggleJpInput = useCallback(() => {
    setShowJpInput((v) => !v);
    if (!showJpInput) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [showJpInput]);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: c.background }]}>
      {/* Status Bar */}
      <View style={[styles.statusBar, { backgroundColor: c.surfaceHigh, borderBottomColor: c.border }]}>
        <View style={styles.statusLeft}>
          <MaterialIcons name="terminal" size={18} color={c.accent} />
          <Text style={[styles.statusTitle, { color: c.foreground }]}>Terminal</Text>
          <StatusBadge state={status} retryCount={retryCount} colors={c} />
        </View>
        <View style={styles.statusRight}>
          <TouchableOpacity
            onPress={toggleJpInput}
            style={[
              styles.jpToggle,
              { backgroundColor: showJpInput ? withAlpha(c.accent, 0.15) : 'transparent', borderColor: showJpInput ? c.accent : c.border },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Japanese input toggle"
          >
            <Text style={[styles.jpToggleText, { color: showJpInput ? c.accent : c.muted }]}>あ</Text>
          </TouchableOpacity>
          <Pressable onPress={handleReload} style={styles.reloadBtn} accessibilityRole="button" accessibilityLabel="Reload terminal">
            <MaterialIcons name="refresh" size={20} color={c.foreground} />
          </Pressable>
        </View>
      </View>

      {/* Connecting Spinner */}
      {status === 'connecting' && (
        <View style={styles.connectingContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={[styles.connectingText, { color: c.foreground }]}>ttyd に接続中...</Text>
          {retryCount > 0 && (
            <Text style={[styles.connectingRetry, { color: c.muted }]}>
              リトライ {retryCount} / 5
            </Text>
          )}
        </View>
      )}

      {/* WebView (ttyd) */}
      {status === 'connected' && (
        <WebView
          ref={webViewRef}
          source={{ uri: ttyUrl }}
          style={styles.webView}
          javaScriptEnabled
          domStorageEnabled
          onLoadEnd={onWebViewLoad}
          onError={onWebViewError}
          onHttpError={onWebViewError}
        />
      )}

      {/* Japanese Input Proxy */}
      {status === 'connected' && showJpInput && (
        <View style={[styles.jpInputBar, { backgroundColor: c.surfaceHigh, borderTopColor: c.border }]}>
          <TextInput
            ref={inputRef}
            style={[styles.jpInputField, { backgroundColor: c.backgroundDeep, color: c.foreground, borderColor: c.borderLight }]}
            value={jpInput}
            onChangeText={setJpInput}
            placeholder="日本語入力..."
            placeholderTextColor={c.inactive}
            autoCapitalize="none"
            autoCorrect={false}
            multiline={false}
            returnKeyType="send"
            onSubmitEditing={handleJpSendNewline}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            onPress={handleJpSend}
            style={[styles.jpSendBtn, { backgroundColor: withAlpha(c.accent, 0.15) }]}
            activeOpacity={0.7}
          >
            <Text style={[styles.jpSendText, { color: c.accent }]}>Paste</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleJpSendNewline}
            style={[styles.jpSendBtn, { backgroundColor: c.accent }]}
            activeOpacity={0.7}
          >
            <MaterialIcons name="send" size={16} color={c.background} />
          </TouchableOpacity>
        </View>
      )}

      {/* Error: Setup Guide */}
      {status === 'error' && <SetupGuide url={ttyUrl} onRetry={retry} colors={c} />}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state, retryCount, colors: c }: { state: ConnectionState; retryCount: number; colors: any }) {
  const label =
    state === 'connected' ? 'Connected' :
    state === 'connecting' ? `Connecting${retryCount > 0 ? ` (${retryCount})` : '...'}` :
    'Disconnected';

  const color =
    state === 'connected' ? '#4ADE80' :
    state === 'connecting' ? '#FBBF24' :
    '#FF7878';

  return (
    <View style={[styles.badge, { borderColor: color }]}>
      {state === 'connecting' ? (
        <ActivityIndicator size={8} color={color} style={{ marginRight: 2 }} />
      ) : (
        <View style={[styles.badgeDot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function SetupGuide({ url, onRetry, colors: c }: { url: string; onRetry: () => void; colors: any }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(BASHRC_SCRIPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenTermux = () => {
    Linking.openURL('com.termux://').catch(() => {
      Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
    });
  };

  return (
    <ScrollView style={styles.guideContainer} contentContainerStyle={styles.guideContent}>
      <MaterialIcons name="terminal" size={48} color={c.accent} />
      <Text style={[styles.guideTitle, { color: c.accent }]}>ttyd に接続できません</Text>
      <Text style={[styles.guideSubtitle, { color: c.muted }]}>
        {url} に接続できませんでした。{'\n'}
        以下の手順でセットアップしてください。
      </Text>

      <View style={[styles.stepsCard, { backgroundColor: c.surfaceHigh, borderColor: c.border }]}>
        <Text style={[styles.stepHeader, { color: c.accent }]}>Setup</Text>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>1</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>ttyd をインストール</Text>
            <View style={[styles.codeBlock, { borderColor: c.border }]}>
              <Text style={[styles.codeText, { color: c.accent }]}>pkg install ttyd</Text>
            </View>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>2</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>.bashrc に自動起動を追加</Text>
            <View style={[styles.codeBlock, { borderColor: c.border }]}>
              <Text style={[styles.codeText, { color: c.accent }]}>{BASHRC_SCRIPT}</Text>
            </View>
            <Pressable onPress={handleCopy} style={[styles.copyBtn, { borderColor: c.border }]}>
              <MaterialIcons name={copied ? 'check' : 'content-copy'} size={16} color={copied ? '#4ADE80' : c.accent} />
              <Text style={[styles.copyBtnText, { color: copied ? '#4ADE80' : c.accent }]}>
                {copied ? 'コピーしました' : 'コピー'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>3</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>Termux を開く</Text>
            <Pressable onPress={handleOpenTermux} style={styles.termuxBtn}>
              <MaterialIcons name="open-in-new" size={16} color="#0A0A0A" />
              <Text style={styles.termuxBtnText}>Termux を開く</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.step}>
          <Text style={[styles.stepNumber, { color: c.accent }]}>4</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepLabel, { color: c.foreground }]}>このタブをリロード</Text>
          </View>
        </View>
      </View>

      <Pressable style={[styles.retryBtn, { backgroundColor: c.accent }]} onPress={onRetry}>
        <MaterialIcons name="refresh" size={20} color="#0A0A0A" />
        <Text style={styles.retryBtnText}>リロード</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Status bar
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusTitle: { fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  statusRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reloadBtn: { padding: 4, borderRadius: 6 },

  // JP toggle
  jpToggle: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  jpToggleText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },

  // Badge
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 10, fontFamily: 'monospace', fontWeight: '600' },

  // Connecting
  connectingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  connectingText: { fontSize: 15, fontFamily: 'monospace', fontWeight: '600' },
  connectingRetry: { fontSize: 12, fontFamily: 'monospace' },

  // WebView
  webView: { flex: 1, backgroundColor: '#000' },

  // Japanese input bar
  jpInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    gap: 6,
  },
  jpInputField: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 14,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 38,
  },
  jpSendBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 38,
  },
  jpSendText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },

  // Setup guide
  guideContainer: { flex: 1 },
  guideContent: { alignItems: 'center', padding: 24, gap: 16 },
  guideTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  guideSubtitle: { fontSize: 13, fontFamily: 'monospace', textAlign: 'center', lineHeight: 20 },
  stepsCard: { width: '100%', borderRadius: 12, borderWidth: 1, padding: 16, gap: 16 },
  stepHeader: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1 },
  step: { flexDirection: 'row', gap: 12 },
  stepNumber: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace', width: 20, textAlign: 'center' },
  stepBody: { flex: 1, gap: 6 },
  stepLabel: { fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  codeBlock: { backgroundColor: '#1A1A2E', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1 },
  codeText: { fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  copyBtnText: { fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
  termuxBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, backgroundColor: '#4ADE80' },
  termuxBtnText: { color: '#0A0A0A', fontSize: 13, fontFamily: 'monospace', fontWeight: '700' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
});
