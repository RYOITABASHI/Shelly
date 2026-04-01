/**
 * Terminal Screen — Native terminal view via direct PTY (pty-helper)
 * Unix Domain Socket connection + session monitor.
 */
import React, { useRef, useState, useCallback, useEffect, useMemo, useContext } from 'react';
import {
  ActivityIndicator,
  AppState,
  findNodeHandle,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { NativeTerminalView } from '@/modules/terminal-view/src';
import TerminalViewModule from '@/modules/terminal-view/src/TerminalViewModule';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useTerminalOutput } from '@/hooks/use-terminal-output';
import { startSessionMonitor, stopSessionMonitor } from '@/lib/terminal-session-monitor';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation, t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useActiveSession, useTerminalStore, getPtyPort } from '@/store/terminal-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
// tmux-manager kept for user-facing tmux commands (optional use)
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import * as FileSystem from 'expo-file-system/legacy';
import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';
// TerminalActionBar removed — attach/voice integrated into CommandKeyBar
import { startSmartWakelock, stopSmartWakelock } from '@/lib/smart-wakelock';
import TermuxBridge from '@/modules/termux-bridge';
import { loadSessionsFromProject, startAutoSave, stopAutoSave } from '@/lib/session-persistence';
import { VoiceChat } from '@/components/VoiceChat';
import { PreviewBanner } from '@/components/terminal/PreviewBanner';
import { PreviewTabs } from '@/components/preview/PreviewTabs';
import { usePreviewStore } from '@/store/preview-store';
import { ProcessGuardModal } from '@/components/terminal/ProcessGuardModal';
import { FirstMateOverlay, shouldShowFirstMate } from '@/components/terminal/FirstMateOverlay';
import { isProcessKill } from '@/lib/process-guard';
import { getTerminalTheme, type TerminalTheme } from '@/lib/terminal-theme';
import type { TabSession, SessionStatus } from '@/store/types';
import { useChatStore } from '@/store/chat-store';
import { generateId } from '@/lib/id';

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
  const activeSession = useActiveSession();
  const { removeSession, sessions, settings } = useTerminalStore();
  const bridgeStatus = useTerminalStore((s) => s.bridgeStatus);
  const { runRawCommand } = useTermuxBridge();
  const isMultiPane = useMultiPaneStore((s) => s.isMultiPane);
  // Detect if this instance is rendered inside MultiPaneContainer (via PaneSlot context)
  // vs. rendered by the Tabs navigator (hidden underneath the overlay)
  const multiPaneCtx = useContext(MultiPaneContext);
  const isRenderedInMultiPane = multiPaneCtx !== null;
  const isHiddenBehindMultiPane = !isRenderedInMultiPane && isMultiPane && layout.isWide;

  // Bridge terminal output events to execution-log-store
  useTerminalOutput();

  // Voice dialog mode state
  const [voiceChatVisible, setVoiceChatVisible] = useState(false);

  // ProcessGuard: detect repeated SIGKILL (signal 9)
  const [showProcessGuard, setShowProcessGuard] = useState(false);
  const killCountRef = useRef(0);

  // FirstMate: first-time onboarding overlay
  const [showFirstMate, setShowFirstMate] = useState(false);
  const firstMateChecked = useRef(false);

  // Scroll state — show FAB when user scrolls up
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const terminalViewRef = useRef<any>(null);

  // Keyboard height tracking for terminal resize (same pattern as Chat screen)
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      // Subtract navigation bar inset to avoid double-padding
      const raw = e.endCoordinates.height;
      const adjusted = Math.max(0, raw - insets.bottom);
      setKeyboardHeight(adjusted);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, [insets.bottom]);

  // Recovery state — shown while session re-creates
  const [isRecovering, setIsRecovering] = useState(false);

  // Derive connection state from native session status
  const connectionState = sessionStatusToConnectionState(activeSession?.sessionStatus);
  const isConnected = connectionState === 'connected';

  // Preview state
  const previewIsOpen = usePreviewStore((s) => s.isOpen);
  const bannerVisible = usePreviewStore((s) => s.bannerVisible);
  const bannerUrl = usePreviewStore((s) => s.bannerUrl);
  const splitRatio = usePreviewStore((s) => s.splitRatio);
  const { openPreview, closePreview, dismissBanner } = usePreviewStore.getState();
  const showSplitPreview = previewIsOpen && layout.isWide;

  // Click-to-Edit: send edit prompt to Chat as a user message for AI dispatch
  const handleEditSubmit = useCallback((prompt: string) => {
    const chatStore = useChatStore.getState();
    const session = chatStore.getActiveSession();
    if (!session) return;
    chatStore.addMessage(session.id, {
      id: generateId(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });
  }, []);

  // Create or reconnect a native session to pty-helper
  const createNativeSession = useCallback(async (session: TabSession) => {
    const port = getPtyPort(session.tmuxSession);
    try {
      // 0. Destroy any stale Kotlin session before re-creating
      try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

      // 1. Check if pty-helper is already running on this port
      let ptyAlive = false;
      try {
        const check = await runRawCommand(
          `(echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo ALIVE || echo DEAD`,
          { timeoutMs: 1000, reason: 'pty-check' }
        );
        ptyAlive = check?.stdout?.includes('ALIVE') ?? false;
      } catch {}

      if (!ptyAlive) {
        // pty-helper not running — start a new one
        console.log('[Terminal] pty-helper not running, starting on port', port);

        // Kill any stale process on this port
        await runRawCommand(
          `pkill -f "pty-helper.*${port}" 2>/dev/null; true`,
          { timeoutMs: 3000, reason: 'pty-cleanup' }
        ).catch(() => {});

        // Launch pty-helper
        await runRawCommand(
          `nohup ~/shelly-bridge/pty-helper ${port} 80 24 > /dev/null 2>&1 &`,
          { timeoutMs: 5000, reason: 'pty-start' }
        );

        // Wait for pty-helper to be ready (poll TCP port, max 1.5s)
        let ready = false;
        for (let i = 0; i < 6; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            const result = await runRawCommand(
              `(echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo READY || echo WAIT`,
              { timeoutMs: 2000, reason: 'pty-wait' }
            );
            if (result?.stdout?.includes('READY')) {
              ready = true;
              break;
            }
          } catch {}
        }
        if (!ready) {
          throw new Error(`pty-helper not ready on port ${port} after 1.5s`);
        }
      } else {
        // pty-helper is already running — just reconnect (no wait needed)
        console.log('[Terminal] pty-helper already running on port', port, '— reconnecting');
      }

      // 2. Create Kotlin session connected to pty-helper TCP port (with retry)
      let connected = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await TerminalEmulator.createSession({
            sessionId: session.nativeSessionId,
            port,
            rows: 24,
            cols: 80,
          });
          connected = true;
          break;
        } catch (e) {
          console.warn(`[Terminal] createSession attempt ${attempt + 1} failed:`, e);
          try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      // Last resort: kill pty-helper and start fresh
      if (!connected) {
        console.warn('[Terminal] All retries failed, restarting pty-helper on port', port);
        await runRawCommand(
          `pkill -f "pty-helper.*${port}" 2>/dev/null; true`,
          { timeoutMs: 3000, reason: 'pty-force-restart' }
        ).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 150));
        await runRawCommand(
          `nohup ~/shelly-bridge/pty-helper ${port} 80 24 > /dev/null 2>&1 &`,
          { timeoutMs: 5000, reason: 'pty-restart' }
        );
        for (let i = 0; i < 6; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            const r = await runRawCommand(
              `(echo >/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo READY || echo WAIT`,
              { timeoutMs: 2000, reason: 'pty-restart-wait' }
            );
            if (r?.stdout?.includes('READY')) break;
          } catch {}
        }
        // Final attempt
        try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}
        await TerminalEmulator.createSession({
          sessionId: session.nativeSessionId,
          port,
          rows: 24,
          cols: 80,
        });
      }

      // 3. Send Ctrl+L to refresh shell prompt (readline redraws)
      try {
        await TerminalEmulator.writeToSession(session.nativeSessionId, '\x0c');
      } catch {}


      // 4. Start foreground service to prevent task-kill
      try { await TerminalEmulator.startSessionService(); } catch {}

      // 5. Update session status to alive
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

  // Recover a session: reconnect to existing pty-helper, or restart if dead
  const recoverSession = useCallback(async (session: TabSession) => {
    setIsRecovering(true);

    // Mark as recovering
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, sessionStatus: 'recovering' as const } : s
      ),
    }));

    // Destroy old Kotlin session (not the pty-helper process!)
    try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

    // Reconnect (createNativeSession checks if pty-helper is alive first)
    await createNativeSession(session);

    setIsRecovering(false);
  }, [createNativeSession, runRawCommand]);

  // Ensure native sessions exist. Called on bridge connect AND on foreground resume.
  // pty-helper processes persist in Termux, but the TCP connection may drop
  // when Android backgrounds the app. This silently reconnects or re-creates sessions.
  const ensureNativeSessions = useCallback(async () => {
    if (bridgeStatus !== 'connected') return;
    // Don't run when hidden behind MultiPane — the MultiPane instance handles sessions
    if (isHiddenBehindMultiPane) return;

    for (const session of sessions) {
      if (session.sessionStatus === 'starting' || session.sessionStatus === 'alive') {
        // In MultiPane context, the tab-side instance already owns the Kotlin session.
        // Just ensure the session status is set to alive so TerminalView renders.
        if (isRenderedInMultiPane) {
          try {
            const alive = await TerminalEmulator.isSessionAlive(session.nativeSessionId);
            if (alive) {
              // Session exists in Kotlin registry — just make sure status is alive
              useTerminalStore.setState((state) => ({
                sessions: state.sessions.map((s) =>
                  s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
                ),
              }));
              continue;
            }
          } catch {}
          // If not alive in MultiPane, don't try to re-create (tab-side will handle it)
          continue;
        }

        try {
          const alive = await TerminalEmulator.isSessionAlive(session.nativeSessionId);
          if (!alive) {
            console.log('[Terminal] ensureNativeSessions: session not alive, re-creating:', session.nativeSessionId);
            await createNativeSession(session);
          }
        } catch {
          console.log('[Terminal] ensureNativeSessions: isSessionAlive threw, re-creating:', session.nativeSessionId);
          await createNativeSession(session);
        }
      } else if (session.sessionStatus === 'exited') {
        if (isRenderedInMultiPane) continue; // Let tab-side handle recovery
        console.log('[Terminal] ensureNativeSessions: session exited, recovering:', session.nativeSessionId);
        recoverSession(session);
      }
    }
  }, [bridgeStatus, sessions, createNativeSession, recoverSession, isHiddenBehindMultiPane, isRenderedInMultiPane]);

  // Run on bridge connect/reconnect AND on initial mount (covers Split View
  // where a new TerminalScreen instance mounts while sessions are already alive)
  useEffect(() => {
    ensureNativeSessions();
  }, [bridgeStatus]);

  // Also run on mount — Split View creates a fresh TerminalScreen instance
  // but bridgeStatus doesn't change, so the above effect won't fire.
  // Use a small delay to let the layout settle before reconnecting.
  useEffect(() => {
    if (bridgeStatus === 'connected') {
      // Immediate check
      ensureNativeSessions();
      // Delayed retry — pty-helper may need time to be ready in Split View
      const timer = setTimeout(() => ensureNativeSessions(), 2000);
      return () => clearTimeout(timer);
    }
  }, []);

  // Run on foreground resume — handles app switch, home button, split view toggle
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        ensureNativeSessions();
      }
    });
    return () => sub.remove();
  }, [ensureNativeSessions]);

  // Request battery optimization exemption on first mount
  useEffect(() => {
    (async () => {
      try {
        const exempt = await TerminalEmulator.isIgnoringBatteryOptimizations();
        if (!exempt) {
          await TerminalEmulator.requestBatteryOptimizationExemption();
        }
      } catch {}
    })();
  }, []);

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

  // ProcessGuard: listen for session exits with signal 9 (SIGKILL)
  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionExit', (event: { sessionId: string; exitCode: number; signal: number }) => {
      if (isProcessKill(event.signal, event.exitCode)) {
        killCountRef.current += 1;
        if (killCountRef.current >= 2) {
          setShowProcessGuard(true);
        }
      }
    });
    return () => sub.remove();
  }, []);

  // FirstMate: check on first successful connection
  useEffect(() => {
    if (isConnected && !firstMateChecked.current) {
      firstMateChecked.current = true;
      shouldShowFirstMate().then((show) => {
        if (show) setShowFirstMate(true);
      });
    }
  }, [isConnected]);

  // Japanese input proxy removed — NativeTerminalView handles inline JP input

  // Terminal color scheme from settings — converted to Kotlin prop format
  const terminalColorScheme = useMemo(() => {
    const theme = getTerminalTheme(settings.terminalTheme ?? 'shelly');
    return {
      color0: theme.black,    color1: theme.red,      color2: theme.green,     color3: theme.yellow,
      color4: theme.blue,     color5: theme.magenta,  color6: theme.cyan,      color7: theme.white,
      color8: theme.brightBlack,  color9: theme.brightRed,    color10: theme.brightGreen,  color11: theme.brightYellow,
      color12: theme.brightBlue,  color13: theme.brightMagenta, color14: theme.brightCyan, color15: theme.brightWhite,
      foreground: theme.foreground,
      background: theme.background,
      cursor: theme.cursor,
    };
  }, [settings.terminalTheme]);

  // Adaptive terminal font size for small screens (Z Fold6 cover ~ 373dp)
  // Terminal font size in dp (converted to px in native ShellyTerminalView).
  // Balanced for readability vs column count:
  //   Compact (cover ~370dp): 11dp → ~29px → ~33 cols
  //   Standard (phone ~400dp): 12dp → ~34px → ~31 cols
  //   Wide/split (928px pane):  11dp → ~32px → ~80 cols ← sweet spot
  //   Wide/full (1856px):       11dp → ~32px → ~160 cols
  const termFontSize = layout.isCompact ? 11 : layout.width < 500 ? 12 : layout.isWide ? 11 : 12;

  // Resize is now handled directly by pty-helper via socket protocol.
  // No JS-side fallback needed.

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
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: keyboardHeight, backgroundColor: c.background }]}>
      {/* Session Tab Header */}
      <TerminalHeader />

      {/* quickBar removed — JP input + reload now integrated into TerminalHeader */}

      {/* Preview Banner — slides in when localhost URL detected */}
      {bannerVisible && bannerUrl && isConnected && (
        <PreviewBanner url={bannerUrl} onOpen={() => openPreview()} onDismiss={dismissBanner} />
      )}

      {/* Connecting Spinner */}
      {connectionState === 'connecting' && (
        <View style={styles.connectingContainer}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={[styles.connectingText, { color: c.foreground }]}>
            {activeSession?.sessionStatus === 'recovering' ? 'Restoring session...' : t('terminal.connecting_terminal')}
          </Text>
        </View>
      )}

      {/* Terminal + Preview Split View */}
      {/* Skip rendering when hidden behind MultiPaneContainer to prevent
          two NativeTerminalView instances from fighting over emulator size */}
      {activeSession && isConnected && !isHiddenBehindMultiPane && (
        <View style={{ flex: 1, flexDirection: showSplitPreview ? 'row' : 'column' }}>
          {/* Native Terminal View */}
          <NativeTerminalView
            ref={terminalViewRef}
            sessionId={activeSession.nativeSessionId}
            fontFamily={'jetbrains-mono'}
            fontSize={termFontSize}
            cursorShape={settings.cursorShape || 'block'}
            cursorBlink={true}
            colorScheme={terminalColorScheme}
            style={[styles.terminalView, { flex: showSplitPreview ? splitRatio : 1 }]}
            onScrollStateChanged={(e) => setIsScrolledUp(e.nativeEvent.isScrolledUp)}
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
              // Resize is handled directly by Kotlin → pty-helper via socket protocol.
              // This callback is kept for JS-side logging/tracking only.
              const { cols, rows } = e.nativeEvent;
              if (cols > 0 && rows > 0) {
                console.log(`[Terminal] resize: ${cols}x${rows}`);
              }
            }}
          />

          {/* Preview Panel (side-by-side on wide screens) */}
          {showSplitPreview && (
            <View style={{ flex: 1 - splitRatio }}>
              <PreviewTabs onClose={closePreview} onEditSubmit={handleEditSubmit} />
            </View>
          )}
        </View>
      )}

      {/* Preview Panel (full screen on compact, when no split) */}
      {previewIsOpen && !showSplitPreview && isConnected && (
        <PreviewTabs onClose={closePreview} onEditSubmit={handleEditSubmit} />
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

      {/* Japanese Input Proxy removed — NativeTerminalView handles inline JP input directly */}

      {/* Command Key Bar (Ctrl+C, Tab, up, down, Paste) + Attach/Voice */}
      {isConnected && (
        <CommandKeyBar
          sendKey={sendKey}
          sendText={sendToTerminal}
          isCompact={layout.isCompact || layout.width < 400}
          onAttach={() => {
            import('expo-document-picker').then((mod) => {
              mod.getDocumentAsync({ copyToCacheDirectory: true }).then((result) => {
                if (!result.canceled && result.assets?.[0]) {
                  const asset = result.assets[0];
                  copyFileToCwd(asset.uri, asset.name || `file-${Date.now()}`);
                }
              });
            });
          }}
          onVoice={() => setVoiceChatVisible(true)}
        />
      )}

      {/* Scroll to bottom FAB */}
      {isScrolledUp && isConnected && (
        <TouchableOpacity
          style={styles.scrollToBottomFab}
          onPress={() => {
            const tag = findNodeHandle(terminalViewRef.current);
            if (tag) TerminalViewModule.scrollToBottom(tag);
            setIsScrolledUp(false);
          }}
          activeOpacity={0.7}
        >
          <MaterialIcons name="keyboard-arrow-down" size={24} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Voice Dialog Mode */}
      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
      />

      {/* ProcessGuard Modal — shown after 2+ SIGKILL detections */}
      <ProcessGuardModal
        visible={showProcessGuard}
        onClose={() => { setShowProcessGuard(false); killCountRef.current = 0; }}
      />

      {/* FirstMate Overlay — first-time onboarding */}
      <FirstMateOverlay
        visible={showFirstMate}
        onClose={() => setShowFirstMate(false)}
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Connecting
  connectingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  connectingText: { fontSize: 15, fontFamily: 'monospace', fontWeight: '600' },

  // Native terminal view
  terminalView: { backgroundColor: '#000' },

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
