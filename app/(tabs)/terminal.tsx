/**
 * Terminal Screen — Native terminal view via PTY + tmux
 * Japanese input proxy + session monitor + setup guide
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { NativeTerminalView } from '@/modules/terminal-view/src';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useTerminalOutput } from '@/hooks/use-terminal-output';
import { startSessionMonitor, stopSessionMonitor } from '@/lib/terminal-session-monitor';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation, t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useActiveSession, useTerminalStore, getSocatPort } from '@/store/terminal-store';
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
import { sendKeysToSession, buildRecoveryCommand } from '@/lib/tmux-manager';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import * as FileSystem from 'expo-file-system/legacy';
import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';
import { TerminalActionBar } from '@/components/terminal/TerminalActionBar';
import { startSmartWakelock, stopSmartWakelock } from '@/lib/smart-wakelock';
import TermuxBridge from '@/modules/termux-bridge';
import { loadSessionsFromProject, startAutoSave, stopAutoSave } from '@/lib/session-persistence';
import { VoiceChat } from '@/components/VoiceChat';
import { PreviewBanner } from '@/components/terminal/PreviewBanner';
import { PreviewPanel } from '@/components/terminal/PreviewPanel';
import { usePreviewStore } from '@/store/preview-store';
import type { TabSession, SessionStatus } from '@/store/types';

// ─── Status type for StatusBadge ─────────────────────────────────────────────

type ConnectionState = 'connecting' | 'connected' | 'error';

function sessionStatusToConnectionState(status: SessionStatus | undefined): ConnectionState {
  switch (status) {
    case 'alive': return 'connected';
    case 'starting':
    case 'recovering': return 'connecting';
    case 'exited':
    default: return 'error';
  }
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { t } = useTranslation();
  const layout = useDeviceLayout();
  const inputRef = useRef<TextInput>(null);
  const activeSession = useActiveSession();
  const { removeSession, sessions, settings } = useTerminalStore();
  const { runRawCommand } = useTermuxBridge();

  // Bridge terminal output events to execution-log-store
  useTerminalOutput();

  // Voice dialog mode state
  const [voiceChatVisible, setVoiceChatVisible] = useState(false);

  // Recovery state — shown while session re-creates
  const [isRecovering, setIsRecovering] = useState(false);

  // Derive connection state from native session status
  const connectionState = sessionStatusToConnectionState(activeSession?.sessionStatus);
  const isConnected = connectionState === 'connected';

  // Preview state
  const previewIsOpen = usePreviewStore((s) => s.isOpen);
  const previewUrl = usePreviewStore((s) => s.previewUrl);
  const bannerVisible = usePreviewStore((s) => s.bannerVisible);
  const bannerUrl = usePreviewStore((s) => s.bannerUrl);
  const splitRatio = usePreviewStore((s) => s.splitRatio);
  const { openPreview, closePreview, dismissBanner } = usePreviewStore.getState();
  const showSplitPreview = previewIsOpen && previewUrl && layout.isWide;

  // Create a native session connected to socat TCP bridge
  const createNativeSession = useCallback(async (session: TabSession) => {
    try {
      const port = getSocatPort(session.tmuxSession);

      // 1. Launch socat bridge in Termux (creates tmux session + TCP relay)
      await runRawCommand(
        `nohup ~/shelly-bridge/socat-session.sh ${port} "${session.tmuxSession}" > /dev/null 2>&1 &`,
        { timeoutMs: 5000, reason: 'socat-start' }
      );

      // 2. Wait for socat to be ready
      await new Promise(resolve => setTimeout(resolve, 1500));

      // 3. Create native session connected to socat TCP port (with retry)
      try {
        await TerminalEmulator.createSession({
          sessionId: session.nativeSessionId,
          port,
          rows: 24,
          cols: 80,
        });
      } catch (firstErr) {
        console.warn('[Terminal] createSession failed, retrying in 1s:', firstErr);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await TerminalEmulator.createSession({
          sessionId: session.nativeSessionId,
          port,
          rows: 24,
          cols: 80,
        });
      }

      // 4. Update session status to alive
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
        ),
      }));
    } catch (err) {
      console.error('[Terminal] Failed to create native session:', err);
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id ? { ...s, sessionStatus: 'exited' as const, isAlive: false } : s
        ),
      }));
    }
  }, [runRawCommand]);

  // Recover a session after tmux/socat dies: kill old socat, re-create
  const recoverSession = useCallback(async (session: TabSession) => {
    setIsRecovering(true);

    // Mark as recovering
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, sessionStatus: 'recovering' as const } : s
      ),
    }));

    // Destroy old native session
    try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

    // Kill old socat for this session
    const port = getSocatPort(session.tmuxSession);
    await runRawCommand(
      `pkill -f "socat.*TCP-LISTEN:${port}" 2>/dev/null; true`,
      { timeoutMs: 3000, reason: 'socat-kill' }
    );

    // Re-create (socat-session.sh will reattach to existing tmux session)
    await createNativeSession(session);

    // Resume CLI if it was active
    if (session.activeCli) {
      const resumeCmd = buildRecoveryCommand(session.currentDir, session.activeCli);
      if (resumeCmd) {
        setTimeout(async () => {
          await sendKeysToSession(session.tmuxSession, resumeCmd, runRawCommand);
        }, 3000);
      }
    }

    setIsRecovering(false);
  }, [createNativeSession, runRawCommand]);

  // Initialize native sessions on mount
  useEffect(() => {
    for (const session of sessions) {
      if (session.sessionStatus === 'starting') {
        createNativeSession(session);
      }
    }
  }, []); // Only on mount

  // Start smart wakelock + foreground service + session monitor on mount
  useEffect(() => {
    startSmartWakelock(runRawCommand);
    TermuxBridge.startForeground().catch(() => {});
    const tmuxNames = sessions.map((s) => s.tmuxSession);
    startSessionMonitor(tmuxNames, runRawCommand, (deadTmuxName) => {
      const deadSession = sessions.find((s) => s.tmuxSession === deadTmuxName);
      if (deadSession) {
        recoverSession(deadSession);
      }
    });
    return () => {
      stopSmartWakelock();
      TermuxBridge.stopForeground().catch(() => {});
      stopSessionMonitor();
    };
  }, []);

  // Keep session monitor in sync with session changes
  useEffect(() => {
    const tmuxNames = sessions.map((s) => s.tmuxSession);
    startSessionMonitor(tmuxNames, runRawCommand, (deadTmuxName) => {
      const deadSession = sessions.find((s) => s.tmuxSession === deadTmuxName);
      if (deadSession) recoverSession(deadSession);
    });
    return () => stopSessionMonitor();
  }, [sessions.length]);

  // Auto-save sessions to project directory (if chat has a projectPath)
  useEffect(() => {
    const cwd = activeSession?.currentDir;
    if (cwd && cwd !== '/home/user' && cwd !== '') {
      startAutoSave(cwd, runRawCommand);
      return () => stopAutoSave();
    }
  }, [activeSession?.currentDir, runRawCommand]);

  // Japanese input proxy state
  const [jpInput, setJpInput] = useState('');
  const [showJpInput, setShowJpInput] = useState(false);

  // Adaptive terminal font size for small screens (Z Fold6 cover ~ 373dp)
  const termFontSize = layout.isCompact ? 20 : layout.width < 500 ? 18 : layout.isWide ? 14 : 16;

  // Send text to terminal via native PTY
  const sendToTerminal = useCallback((text: string) => {
    if (!activeSession || !text) return;
    TerminalEmulator.writeToSession(activeSession.nativeSessionId, text).catch((err) => {
      console.warn('[Terminal] writeToSession failed:', err);
    });
  }, [activeSession?.nativeSessionId]);

  // Send raw key code to terminal
  const sendKey = useCallback((keyCode: string) => {
    if (!activeSession) return;
    TerminalEmulator.writeToSession(activeSession.nativeSessionId, keyCode).catch((err) => {
      console.warn('[Terminal] sendKey failed:', err);
    });
  }, [activeSession?.nativeSessionId]);

  // Copy file from device to terminal cwd via bridge
  const copyFileToCwd = useCallback(async (sourceUri: string, fileName: string) => {
    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tempPath = `${FileSystem.cacheDirectory}${safeName}`;
      await FileSystem.copyAsync({ from: sourceUri, to: tempPath });
      await runRawCommand(
        `cp '${tempPath}' './${safeName}' 2>/dev/null && echo "Copied ${safeName} to $(pwd)"`,
        { timeoutMs: 10000, reason: 'file-attach' },
      );
    } catch (e) {
      console.warn('[Terminal] file copy failed:', e);
    }
  }, [runRawCommand]);

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

  const handleReload = useCallback(() => {
    if (activeSession) {
      recoverSession(activeSession);
    }
  }, [activeSession, recoverSession]);

  // Handle session removal with native session cleanup
  const handleRemoveSession = useCallback(async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}
    }
    removeSession(sessionId);
  }, [sessions, removeSession]);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: c.background }]}>
      {/* Session Tab Header */}
      <TerminalHeader />

      {/* Quick Actions Bar (JP input + reload) */}
      <View style={[styles.quickBar, { backgroundColor: c.surfaceHigh, borderBottomColor: c.border }]}>
        <StatusBadge state={connectionState} retryCount={0} colors={c} />
        <View style={{ flex: 1 }} />
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
          <MaterialIcons name="refresh" size={18} color={c.foreground} />
        </Pressable>
      </View>

      {/* Preview Banner — slides in when localhost URL detected */}
      {bannerVisible && bannerUrl && isConnected && (
        <PreviewBanner url={bannerUrl} onOpen={() => openPreview()} onDismiss={dismissBanner} />
      )}

      {/* Connecting Spinner */}
      {connectionState === 'connecting' && (
        <View style={styles.connectingContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={[styles.connectingText, { color: c.foreground }]}>
            {activeSession?.sessionStatus === 'recovering' ? 'Restoring session...' : t('terminal.connecting_ttyd')}
          </Text>
        </View>
      )}

      {/* Terminal + Preview Split View */}
      {activeSession && isConnected && (
        <View style={{ flex: 1, flexDirection: showSplitPreview ? 'row' : 'column' }}>
          {/* Native Terminal View */}
          <NativeTerminalView
            sessionId={activeSession.nativeSessionId}
            fontFamily={'jetbrains-mono'}
            fontSize={termFontSize}
            cursorShape={settings.cursorShape || 'block'}
            cursorBlink={true}
            style={[styles.terminalView, { flex: showSplitPreview ? splitRatio : 1 }]}
            onOutput={() => {}}
            onBlockCompleted={(e) => {
              const { command, output, exitCode } = e.nativeEvent;
            }}
            onUrlDetected={(e) => {
              const { url, type } = e.nativeEvent;
              if (type === 'url') {
                import('expo-web-browser').then(m => m.openBrowserAsync(url)).catch(() => {});
              }
            }}
            onResize={(e) => {
              const { cols, rows } = e.nativeEvent;
              if (activeSession) {
                runRawCommand(
                  `tmux resize-window -t "${activeSession.tmuxSession}" -x ${cols} -y ${rows} 2>/dev/null; true`,
                  { timeoutMs: 3000, reason: 'tmux-resize' }
                );
              }
            }}
          />

          {/* Preview Panel (side-by-side on wide screens) */}
          {showSplitPreview && previewUrl && (
            <View style={{ flex: 1 - splitRatio }}>
              <PreviewPanel url={previewUrl} onClose={closePreview} />
            </View>
          )}
        </View>
      )}

      {/* Preview Panel (full screen on compact, when no split) */}
      {previewIsOpen && previewUrl && !showSplitPreview && isConnected && (
        <PreviewPanel url={previewUrl} onClose={closePreview} />
      )}

      {/* Recovery splash — shown while session re-creates */}
      {isRecovering && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center', zIndex: 10 }]}>
          <ActivityIndicator size="small" color="#00D4AA" />
          <Text style={{ color: '#4B5563', fontFamily: 'monospace', fontSize: 11, marginTop: 8 }}>
            Restoring session...
          </Text>
        </View>
      )}

      {/* Japanese Input Proxy */}
      {isConnected && showJpInput && (
        <View style={[styles.jpInputBar, { backgroundColor: c.surfaceHigh, borderTopColor: c.border }]}>
          <TextInput
            ref={inputRef}
            style={[styles.jpInputField, { backgroundColor: c.backgroundDeep, color: c.foreground, borderColor: c.borderLight }]}
            value={jpInput}
            onChangeText={setJpInput}
            placeholder={t('terminal.jp_placeholder')}
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
            <Text style={[styles.jpSendText, { color: c.accent }]}>{t('terminal.paste')}</Text>
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

      {/* Command Key Bar (Ctrl+C, Tab, up, down, Paste) */}
      {isConnected && (
        <CommandKeyBar
          sendKey={sendKey}
          sendText={sendToTerminal}
          isCompact={layout.isCompact || layout.width < 400}
        />
      )}

      {/* Scroll to bottom FAB — native view handles scrolling internally */}

      {/* Action Bar (Attach + Voice) */}
      {isConnected && (
        <TerminalActionBar
          copyFileToCwd={copyFileToCwd}
          sendText={sendToTerminal}
          onVoiceDialog={() => setVoiceChatVisible(true)}
        />
      )}

      {/* Voice Dialog Mode */}
      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
      />

      {/* Error: show status when session is not alive and not connecting */}
      {connectionState === 'error' && activeSession && (
        <View style={styles.errorContainer}>
          <MaterialIcons name="terminal" size={48} color={c.accent} />
          <Text style={[styles.errorTitle, { color: c.accent }]}>Session not available</Text>
          <Text style={[styles.errorSubtitle, { color: c.muted }]}>
            The terminal session has exited or failed to start.
          </Text>
          <Pressable style={[styles.retryBtn, { backgroundColor: c.accent }]} onPress={handleReload}>
            <MaterialIcons name="refresh" size={20} color="#0A0A0A" />
            <Text style={styles.retryBtnText}>{t('terminal.reload')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state, retryCount, colors: c }: { state: ConnectionState; retryCount: number; colors: any }) {
  const label =
    state === 'connected' ? t('terminal.connected') :
    state === 'connecting' ? (retryCount > 0 ? t('terminal.connecting_retry', { count: retryCount }) : t('terminal.connecting')) :
    t('terminal.disconnected');

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Quick actions bar (below TerminalHeader)
  quickBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
  },
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

  // Native terminal view
  terminalView: { backgroundColor: '#000' },

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

  // Error state
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  errorSubtitle: { fontSize: 13, fontFamily: 'monospace', textAlign: 'center', lineHeight: 20 },

  // Retry button
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },

  // Scroll FAB (kept for potential future use)
  scrollToBottomFab: {
    position: 'absolute',
    right: 12,
    bottom: 120,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 1,
    borderColor: '#00D4AA44',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
});
