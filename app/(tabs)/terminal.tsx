/**
 * Terminal Screen — Raw terminal via ttyd + WebView
 * 自動リトライ + 初心者向けセットアップガイド付き
 */
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTtydConnection } from '@/hooks/use-ttyd-connection';

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = {
  bg: '#0A0A0A',
  surface: '#141414',
  border: '#2A2A2A',
  text: '#E8E8E8',
  muted: '#6B7280',
  accent: '#00D4AA',
  error: '#FF7878',
  errorDim: '#FF787833',
  warning: '#FBBF24',
  green: '#4ADE80',
};

const BASHRC_SCRIPT = `# Shelly auto-start
if ! pgrep -x ttyd > /dev/null; then
  ttyd -W -p 7681 bash &>/dev/null &
fi`;

type ConnectionState = 'connecting' | 'connected' | 'error';

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const {
    status,
    retryCount,
    retry,
    onWebViewLoad,
    onWebViewError,
    ttyUrl,
  } = useTtydConnection();

  const handleReload = () => {
    retry();
    webViewRef.current?.reload();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* ── Status Bar ──────────────────────────────────────────────────────── */}
      <View style={styles.statusBar}>
        <View style={styles.statusLeft}>
          <MaterialIcons name="code" size={18} color={COLORS.accent} />
          <Text style={styles.statusTitle}>TTY</Text>
          <StatusBadge state={status} retryCount={retryCount} />
        </View>
        <View style={styles.statusRight}>
          <Text style={styles.urlText} numberOfLines={1}>{ttyUrl}</Text>
          <Pressable onPress={handleReload} style={styles.reloadBtn}>
            <MaterialIcons name="refresh" size={20} color={COLORS.text} />
          </Pressable>
        </View>
      </View>

      {/* ── Connecting: Spinner ────────────────────────────────────────────── */}
      {status === 'connecting' && (
        <ConnectingView retryCount={retryCount} />
      )}

      {/* ── WebView (ttyd) ──────────────────────────────────────────────────── */}
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

      {/* ── Error: Setup Guide ──────────────────────────────────────────────── */}
      {status === 'error' && <SetupGuide url={ttyUrl} onRetry={retry} />}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state, retryCount }: { state: ConnectionState; retryCount: number }) {
  const label =
    state === 'connected' ? 'Connected' :
    state === 'connecting' ? `Connecting${retryCount > 0 ? ` (${retryCount})` : '...'}` :
    'Disconnected';

  const color =
    state === 'connected' ? COLORS.accent :
    state === 'connecting' ? COLORS.warning :
    COLORS.error;

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

function ConnectingView({ retryCount }: { retryCount: number }) {
  return (
    <View style={styles.connectingContainer}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      <Text style={styles.connectingText}>ttyd に接続中...</Text>
      {retryCount > 0 && (
        <Text style={styles.connectingRetry}>
          リトライ {retryCount} / 5
        </Text>
      )}
    </View>
  );
}

function SetupGuide({ url, onRetry }: { url: string; onRetry: () => void }) {
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
      <MaterialIcons name="terminal" size={48} color={COLORS.accent} />
      <Text style={styles.guideTitle}>ttyd に接続できません</Text>
      <Text style={styles.guideSubtitle}>
        {url} に接続できませんでした。{'\n'}
        以下の手順でセットアップしてください。
      </Text>

      <View style={styles.stepsCard}>
        <Text style={styles.stepHeader}>Setup</Text>

        {/* Step 1: Install ttyd */}
        <View style={styles.step}>
          <Text style={styles.stepNumber}>1</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepLabel}>ttyd をインストール</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>pkg install ttyd</Text>
            </View>
          </View>
        </View>

        {/* Step 2: Add to .bashrc (with copy button) */}
        <View style={styles.step}>
          <Text style={styles.stepNumber}>2</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepLabel}>.bashrc に自動起動を追加</Text>
            <Text style={styles.stepDesc}>
              以下を ~/.bashrc に追記すると、Termux起動時に自動でttydが起動します
            </Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{BASHRC_SCRIPT}</Text>
            </View>
            <Pressable onPress={handleCopy} style={styles.copyBtn}>
              <MaterialIcons
                name={copied ? 'check' : 'content-copy'}
                size={16}
                color={copied ? COLORS.green : COLORS.accent}
              />
              <Text style={[styles.copyBtnText, copied && { color: COLORS.green }]}>
                {copied ? 'コピーしました' : 'コピー'}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Step 3: Open Termux */}
        <View style={styles.step}>
          <Text style={styles.stepNumber}>3</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepLabel}>Termux を開く</Text>
            <Text style={styles.stepDesc}>
              Termuxを開いて .bashrc を反映させます
            </Text>
            <Pressable onPress={handleOpenTermux} style={styles.termuxBtn}>
              <MaterialIcons name="open-in-new" size={16} color="#0A0A0A" />
              <Text style={styles.termuxBtnText}>Termux を開く</Text>
            </Pressable>
          </View>
        </View>

        {/* Step 4: Reload this tab */}
        <View style={styles.step}>
          <Text style={styles.stepNumber}>4</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepLabel}>このタブをリロード</Text>
            <Text style={styles.stepDesc}>
              ttydが起動したら下のボタンでリロード
            </Text>
          </View>
        </View>
      </View>

      <Pressable style={styles.retryBtn} onPress={onRetry}>
        <MaterialIcons name="refresh" size={20} color="#0A0A0A" />
        <Text style={styles.retryBtnText}>リロード</Text>
      </Pressable>

      <View style={styles.tipsCard}>
        <Text style={styles.tipsHeader}>Tips</Text>
        <Text style={styles.tipsText}>
          {'\u2022'} tmux を使う場合: ttyd -W -p 7681 tmux new -As main &{'\n'}
          {'\u2022'} カスタムポートは Settings {'>'} Termux {'>'} TTY URL で変更{'\n'}
          {'\u2022'} vim, nano, htop 等のフルスクリーンアプリも動作します
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },

  // Status bar
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'flex-end',
  },
  urlText: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: 'monospace',
    maxWidth: 160,
  },
  reloadBtn: {
    padding: 4,
    borderRadius: 6,
  },

  // Badge
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // Connecting spinner
  connectingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  connectingText: {
    color: COLORS.text,
    fontSize: 15,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  connectingRetry: {
    color: COLORS.muted,
    fontSize: 12,
    fontFamily: 'monospace',
  },

  // WebView
  webView: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Setup guide
  guideContainer: {
    flex: 1,
  },
  guideContent: {
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  guideTitle: {
    color: COLORS.accent,
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  guideSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 20,
  },

  // Steps card
  stepsCard: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 16,
  },
  stepHeader: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
    width: 20,
    textAlign: 'center',
  },
  stepBody: {
    flex: 1,
    gap: 6,
  },
  stepLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  stepDesc: {
    color: COLORS.muted,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  codeBlock: {
    backgroundColor: '#1A1A2E',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  codeText: {
    color: COLORS.accent,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },

  // Copy button
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: '#1A1A2E',
  },
  copyBtnText: {
    color: COLORS.accent,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // Termux open button
  termuxBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: COLORS.green,
  },
  termuxBtnText: {
    color: '#0A0A0A',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },

  // Retry button
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#0A0A0A',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },

  // Tips card
  tipsCard: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 8,
  },
  tipsHeader: {
    color: COLORS.warning,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  tipsText: {
    color: COLORS.muted,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
});
