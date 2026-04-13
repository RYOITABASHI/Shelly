/**
 * Terminal Screen — Native terminal view via direct JNI forkpty (Plan B)
 * No TCP, no pty-helper, no bridge dependency.
 */
import React, { useRef, useState, useCallback, useEffect, useMemo, useContext } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation, t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useActiveSession, useTerminalStore } from '@/store/terminal-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { useUsageStore } from '@/store/usage-store';
import type { ReadFileFn, ListFilesFn } from '@/lib/usage-parser';
import * as FileSystem from 'expo-file-system/legacy';
import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';
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
import { BlockList } from '@/components/terminal/BlockList';
import { execCommand } from '@/hooks/use-native-exec';
import { getHomePath } from '@/lib/home-path';
import { runFirstLaunchSetup } from '@/lib/first-launch-setup';
import { logInfo, logLifecycle } from '@/lib/debug-logger';
import { colors as C } from '@/theme.config';

logInfo('Terminal', 'module loaded');

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
  logLifecycle('TerminalScreen', 'render');
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { t } = useTranslation();
  const layout = useDeviceLayout();
  const activeSession = useActiveSession();
  const { removeSession, sessions, settings } = useTerminalStore();
  const { refresh: refreshUsage } = useUsageStore();

  // Usage adapters — read/list via TerminalEmulator (no bridge needed)
  const readFileAdapter: ReadFileFn = React.useCallback(async (path: string) => {
    try {
      const content = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
      return content;
    } catch {
      return null;
    }
  }, []);
  const listFilesAdapter: ListFilesFn = React.useCallback(async (dir: string) => {
    try {
      const entries = await FileSystem.readDirectoryAsync(dir);
      return entries.map((name: string) => ({ name, mtime: 0 }));
    } catch {
      return [];
    }
  }, []);

  const isMultiPane = useMultiPaneStore((s) => s.isMultiPane);
  // Detect if this instance is rendered inside MultiPaneContainer (via PaneSlot context)
  // vs. rendered by the Tabs navigator (hidden underneath the overlay)
  const multiPaneCtx = useContext(MultiPaneContext);
  const isRenderedInMultiPane = multiPaneCtx !== null;
  // Only hide tab-side terminal when MultiPane is actively visible on wide screen
  // AND the MultiPaneContainer actually renders pane slots (layout.isWide)
  const isHiddenBehindMultiPane = !isRenderedInMultiPane && isMultiPane && layout.isWide;

  // Even if hidden behind multi-pane, always ensure sessions exist
  // so the terminal is ready when the user switches to single-pane mode
  const skipSessionCreation = false;

  // Bridge terminal output events to execution-log-store
  useTerminalOutput();

  // Mutex: prevent concurrent ensureNativeSessions / createNativeSession calls
  const sessionMutexRef = useRef(false);
  // Track which sessions are currently being created (prevent double-creation)
  const creatingSessions = useRef(new Set<string>());

  // Voice dialog mode state
  const [voiceChatVisible, setVoiceChatVisible] = useState(false);

  // ProcessGuard: detect repeated SIGKILL (signal 9)
  const [showProcessGuard, setShowProcessGuard] = useState(false);
  const killCountRef = useRef(0);

  // FirstMate: first-time onboarding overlay
  const [showFirstMate, setShowFirstMate] = useState(false);
  const firstMateChecked = useRef(false);

  // Block History panel toggle
  const [showBlockHistory, setShowBlockHistory] = useState(false);

  const showSetupOverlay = false; // Setup now runs directly on PTY, no overlay needed

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

  // Click-to-Edit: send edit prompt to Chat as a user message for AI dispatch.
  // If no chat session exists, fall back to running the prompt as a terminal command.
  const handleEditSubmit = useCallback((prompt: string) => {
    const chatStore = useChatStore.getState();
    const session = chatStore.getActiveSession();
    if (!session) {
      // No chat session — execute as terminal command so the input isn't swallowed
      useTerminalStore.getState().runCommand(prompt);
      return;
    }
    chatStore.addMessage(session.id, {
      id: generateId(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });
  }, []);

  // Create a native session via JNI forkpty (no TCP, no pty-helper)
  const createNativeSession = useCallback(async (session: TabSession) => {
    logInfo('Terminal', 'createNativeSession called for: ' + session.nativeSessionId);
    if (creatingSessions.current.has(session.id)) {
      logInfo('Terminal', 'createNativeSession: already in progress for ' + session.nativeSessionId);
      return;
    }
    creatingSessions.current.add(session.id);

    try {
      // Check if emulator already exists
      const hasEmu = await TerminalEmulator.hasEmulator(session.nativeSessionId).catch(() => false);
      if (hasEmu) {
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
          ),
        }));
        return;
      }

      // Destroy any stale session
      try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch (_) {}

      // Create session via JNI forkpty
      await TerminalEmulator.createSession({
        sessionId: session.nativeSessionId,
        rows: 24,
        cols: 80,
      });

      // Start foreground service to prevent task-kill (may fail if Service class missing)
      try { await TerminalEmulator.startSessionService(); } catch (_) {}

      // Update session status
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
        ),
      }));

      // First-launch setup: run CLI install commands directly on the live terminal
      runFirstLaunchSetup(session.nativeSessionId);
    } catch (err: any) {
      console.error('[Terminal] createNativeSession failed:', err);
      Alert.alert('Terminal Error', String(err?.message || err));
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id ? { ...s, sessionStatus: 'exited' as const, isAlive: false } : s
        ),
      }));
    } finally {
      creatingSessions.current.delete(session.id);
    }
  }, []);

  // Recover a session: destroy and re-create
  const recoverSession = useCallback(async (session: TabSession) => {
    if (creatingSessions.current.has(session.id)) {
      console.log('[Terminal] recoverSession: already in progress for', session.nativeSessionId);
      return;
    }
    setIsRecovering(true);

    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, sessionStatus: 'recovering' as const } : s
      ),
    }));

    try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}
    await createNativeSession(session);

    setIsRecovering(false);
  }, [createNativeSession]);

  // Reset a session: destroy, clear state, start fresh
  const resetSession = useCallback(async (session: TabSession) => {
    creatingSessions.current.delete(session.id);
    try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

    useTerminalStore.getState().clearSession(session.id);

    await createNativeSession(session);
  }, [createNativeSession]);

  // Ensure native sessions exist. Called on mount and foreground resume.
  const ensureNativeSessions = useCallback(async () => {
    logInfo('Terminal', 'ensureNativeSessions called, sessions=' + sessions.length + ', mutex=' + sessionMutexRef.current);
    if (sessionMutexRef.current) return;
    sessionMutexRef.current = true;

    try {
      for (const session of sessions) {
        logInfo('Terminal', 'session ' + session.nativeSessionId + ' status=' + session.sessionStatus);
        if (session.sessionStatus === 'starting' || session.sessionStatus === 'alive') {
          // Check if session is already alive (works in both MultiPane and tab contexts)
          try {
            const alive = await TerminalEmulator.isSessionAlive(session.nativeSessionId);
            if (alive) {
              useTerminalStore.setState((state) => ({
                sessions: state.sessions.map((s) =>
                  s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
                ),
              }));
              continue;
            }
          } catch {}

          // Session not alive — create it regardless of MultiPane context
          console.log('[Terminal] ensureNativeSessions: session not alive, creating:', session.nativeSessionId);
          await createNativeSession(session);
        } else if (session.sessionStatus === 'exited') {
          console.log('[Terminal] ensureNativeSessions: session exited, recovering:', session.nativeSessionId);
          await recoverSession(session);
        }
      }
    } finally {
      sessionMutexRef.current = false;
    }
  }, [sessions, createNativeSession, recoverSession]);

  // Run on initial mount
  useEffect(() => {
    ensureNativeSessions();
  }, []);

  // Run on foreground resume — handles app switch, home button, split view toggle
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        ensureNativeSessions();
        // Force redraw terminal content after app resume
        setTimeout(() => {
          const tag = findNodeHandle(terminalViewRef.current);
          if (tag) {
            TerminalViewModule.refreshScreen(tag);
          }
        }, 200);
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

  // Refresh usage on mount
  useEffect(() => {
    refreshUsage(readFileAdapter, listFilesAdapter);
  }, []);

  // Battery optimization exemption — prompt once on unexpected disconnect
  const checkBatteryExemption = useCallback(async () => {
    try {
      const isExempted = await TerminalEmulator.isIgnoringBatteryOptimizations();
      if (!isExempted) {
        Alert.alert(
          'Terminal Connection',
          'To keep the terminal stable, allow Shelly to run in the background without battery restrictions.',
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Allow',
              onPress: () => TerminalEmulator.requestBatteryOptimizationExemption(),
            },
          ]
        );
      }
    } catch {}
  }, []);

  // ProcessGuard: listen for session exits with signal 9 (SIGKILL)
  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionExit', (event: { sessionId: string; exitCode: number; signal: number }) => {
      if (isProcessKill(event.signal, event.exitCode)) {
        killCountRef.current += 1;
        if (killCountRef.current >= 2) {
          setShowProcessGuard(true);
        }
      }
      // Prompt battery exemption on session exit
      checkBatteryExemption();
    });
    return () => sub.remove();
  }, [checkBatteryExemption]);

  // Handle reset requests from TerminalHeader
  const pendingResetId = useTerminalStore((s) => s.pendingResetSessionId);
  useEffect(() => {
    if (!pendingResetId) return;
    const session = sessions.find((s) => s.id === pendingResetId);
    if (session) {
        useTerminalStore.getState().clearPendingReset();
        resetSession(session);
    }
  }, [pendingResetId, sessions, resetSession]);

  // FirstMate disabled — CLI tools are pre-installed, MOTD is sufficient
  // useEffect(() => {
  //   if (isConnected && !firstMateChecked.current) {
  //     firstMateChecked.current = true;
  //     shouldShowFirstMate().then((show) => {
  //       if (show) setShowFirstMate(true);
  //     });
  //   }
  // }, [isConnected]);

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

  // Terminal font size honors the user's Settings → Display → Font Size choice
  // (8/10/12 sp = S/M/L). Falls back to a compact-friendly default when the
  // settings store hasn't loaded yet. Compact screens (Z Fold6 cover ~ 373dp)
  // shave one extra step.
  const termFontSize = (() => {
    const base = settings.fontSize ?? 12;
    // settings.fontSize comes in as 12/14/16 from the S/M/L preset.
    // Widened from the previous 8/10/12 mapping (users said fontSize
    // button had no visible effect) so each step is clearly distinct.
    const mapped = base <= 12 ? 7 : base <= 14 ? 11 : 15;
    return layout.isCompact ? Math.max(6, mapped - 1) : mapped;
  })();

  // Send text to terminal via native PTY
  const sendToTerminal = useCallback((text: string) => {
    if (!activeSession || !text) return;
    TerminalEmulator.writeToSession(activeSession.nativeSessionId, text).catch((err) => {
      console.warn('[Terminal] writeToSession failed:', err);
    });
  }, [activeSession?.nativeSessionId]);

  // Voice input routing
  const handleVoiceInput = useCallback((text: string) => {
    if (!text.trim()) return;
    const SHELL_META = /[|&;<>$`\\!{}*?[\]#~]/;
    const COMMAND_PREFIX = /^(ls|cd|mkdir|rm|cp|mv|cat|echo|grep|find|git|npm|pnpm|yarn|node|python|python3|pip|pip3|apt|pkg|curl|wget|ssh|scp|docker|make|cargo|go|java|ruby|perl|bash|sh|zsh|fish|export|source|alias|kill|ps|top|htop|df|du|pwd|which|man|chmod|chown|sudo|su|env|set|unset|clear|reset)\s/i;
    if (SHELL_META.test(text) || COMMAND_PREFIX.test(text)) {
      sendToTerminal(text + '\n');
    } else {
      sendToTerminal(text + '\n');
    }
  }, [sendToTerminal]);

  // Send raw key code to terminal
  const sendKey = useCallback((keyCode: string) => {
    if (!activeSession) return;
    TerminalEmulator.writeToSession(activeSession.nativeSessionId, keyCode).catch((err) => {
      console.warn('[Terminal] sendKey failed:', err);
    });
  }, [activeSession?.nativeSessionId]);

  // Copy file from device to terminal cwd
  const copyFileToCwd = useCallback(async (sourceUri: string, fileName: string) => {
    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const cwd = activeSession?.currentDir || getHomePath();
      const tempPath = `${FileSystem.cacheDirectory}${safeName}`;
      await FileSystem.copyAsync({ from: sourceUri, to: tempPath });
      // Use terminal to copy file to cwd
      sendToTerminal(`cp '${tempPath}' './${safeName}'\n`);
    } catch (e) {
      console.warn('[Terminal] file copy failed:', e);
    }
  }, [activeSession?.currentDir, sendToTerminal]);


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
      {/* Headers moved into PaneSlot so each pane only pays for one header row */}

      {/* Preview Banner — slides in when localhost URL detected */}
      {bannerVisible && bannerUrl && isConnected && (
        <PreviewBanner url={bannerUrl} onOpen={() => openPreview()} onDismiss={dismissBanner} />
      )}

      {/* Terminal + Preview Split View */}
      {activeSession && isConnected && !isHiddenBehindMultiPane && (
        <View style={{ flex: 1, flexDirection: showSplitPreview ? 'row' : 'column' }}>
          {/* Native Terminal View */}
          <NativeTerminalView
            ref={terminalViewRef}
            sessionId={activeSession.nativeSessionId}
            fontFamily={
              settings.uiFont === 'shelly' || settings.uiFont === 'silkscreen'
                ? 'silkscreen'
                : settings.uiFont === 'pixel'
                ? 'pixel-mplus'
                : 'jetbrains-mono'
            }
            fontSize={termFontSize}
            cursorShape={settings.cursorShape || 'block'}
            cursorBlink={true}
            colorScheme={terminalColorScheme}
            gpuRendering={settings.gpuRendering ?? false}
            style={[styles.terminalView, { flex: showSplitPreview ? splitRatio : 1 }]}
            onScrollStateChanged={(e) => setIsScrolledUp(e.nativeEvent.isScrolledUp)}
            onOutput={() => {}}
            onBlockCompleted={(e) => {
              const { command, output, exitCode } = e.nativeEvent;
              if (command && command.trim()) {
                const { addEntryBlock, activeSessionId } = useTerminalStore.getState();
                addEntryBlock({
                  id: generateId(),
                  sessionId: activeSessionId ?? '',
                  command: command.trim(),
                  output: (output || '').split('\n').map((line: string) => ({ text: line, type: 'stdout' as const })),
                  timestamp: Date.now(),
                  exitCode: typeof exitCode === 'number' ? exitCode : 0,
                  isRunning: false,
                  blockStatus: exitCode !== 0 ? 'error' : 'done',
                  // onBlockCompleted only fires when a native session is alive,
                  // so connectionMode is always 'native' here.
                  connectionMode: 'native',
                });
              }
              // Sync currentDir from PTY after each command block
              execCommand('pwd').then((pwdResult) => {
                if (pwdResult.exitCode === 0 && pwdResult.stdout.trim()) {
                  const newDir = pwdResult.stdout.trim();
                  const store = useTerminalStore.getState();
                  const session = store.sessions.find(s => s.id === store.activeSessionId);
                  if (session && session.currentDir !== newDir) {
                    useTerminalStore.setState((state) => ({
                      sessions: state.sessions.map(s =>
                        s.id === store.activeSessionId ? { ...s, currentDir: newDir } : s
                      ),
                    }));
                  }
                }
              }).catch(() => {});
            }}
            onUrlDetected={(e) => {
              const { url, type } = e.nativeEvent;
              if (type === 'url') {
                import('expo-web-browser').then(m => m.openBrowserAsync(url)).catch(() => {});
              }
            }}
            onResize={(e) => {
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
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={{ color: C.text3, fontFamily: 'Silkscreen', fontSize: 11, marginTop: 8 }}>
            Restoring session...
          </Text>
        </View>
      )}

      {/* Block History Panel — toggleable overlay over terminal */}
      {showBlockHistory && activeSession && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 20, backgroundColor: c.background }]}>
          {/* Panel Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.surface }}>
            <Text style={{ color: c.foreground, fontFamily: 'Silkscreen', fontSize: 13, fontWeight: '700', flex: 1 }}>
              {showSetupOverlay ? 'Setup' : 'Block History'}
            </Text>
            <TouchableOpacity onPress={() => {
              setShowBlockHistory(false);
              if (showSetupOverlay) {
                useTerminalStore.getState().setShowSetupOverlay(false);
              }
            }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialIcons name="close" size={20} color={c.muted} />
            </TouchableOpacity>
          </View>
          <BlockList
            blocks={activeSession.blocks}
            entries={activeSession.entries}
            currentDir={activeSession.currentDir}
            onRerun={(command) => {
              setShowBlockHistory(false);
              sendToTerminal(command + '\n');
            }}
          />
        </View>
      )}


      {/* Japanese Input Proxy removed — NativeTerminalView handles inline JP input directly */}

      {/* Command Key Bar (Ctrl+C, Tab, up, down, Paste) + Attach/Voice */}
      {isConnected && (
        <CommandKeyBar
          sendKey={sendKey}
          sendText={sendToTerminal}
          isCompact={layout.isCompact || (multiPaneCtx?.paneWidth ?? layout.width) < 420}
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
          onVoice={handleVoiceInput}
          onVoiceLong={() => setVoiceChatVisible(true)}
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
  connectingText: { fontSize: 15, fontFamily: 'Silkscreen', fontWeight: '600' },

  // Native terminal view
  terminalView: { backgroundColor: '#000' },

  // Error state
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'Silkscreen' },
  errorSubtitle: { fontSize: 13, fontFamily: 'Silkscreen', textAlign: 'center', lineHeight: 20 },

  // Retry button
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'Silkscreen' },

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
    borderColor: C.accent + '44',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },

  // Block History FAB
  blockHistoryFab: {
    position: 'absolute',
    right: 12,
    bottom: 160,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
});
