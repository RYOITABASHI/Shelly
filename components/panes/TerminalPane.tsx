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
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { NativeTerminalView } from '@/modules/terminal-view/src';
import TerminalViewModule from '@/modules/terminal-view/src/TerminalViewModule';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useTerminalOutput } from '@/hooks/use-terminal-output';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useActiveSession, useTerminalStore } from '@/store/terminal-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { MultiPaneContext, PaneIdContext } from '@/components/multi-pane/PaneSlot';
import { useFocusStore } from '@/store/focus-store';
import { usePaneStore } from '@/store/pane-store';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { usePanelBackground } from '@/hooks/use-panel-background';
import * as FileSystem from 'expo-file-system/legacy';
import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';
import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import { VoiceChat } from '@/components/VoiceChat';
import { PreviewBanner } from '@/components/terminal/PreviewBanner';
import { PreviewTabs } from '@/components/preview/PreviewTabs';
import { usePreviewStore } from '@/store/preview-store';
import { ProcessGuardModal } from '@/components/terminal/ProcessGuardModal';
import { FirstMateOverlay } from '@/components/terminal/FirstMateOverlay';
import { isProcessKill } from '@/lib/process-guard';
import { getTerminalTheme } from '@/lib/terminal-theme';
import type { TabSession, SessionStatus } from '@/store/types';
import { generateId } from '@/lib/id';
import { BlockList } from '@/components/terminal/BlockList';
import { execCommand } from '@/hooks/use-native-exec';
import { parseInput } from '@/lib/input-router';
import { parseAgentCommand, createAgent, installAgent, runAgentNow, stopAgent } from '@/lib/agent-manager';
import { suggestTool } from '@/lib/agent-tool-router';
import { runFirstLaunchSetup } from '@/lib/first-launch-setup';
import { logInfo, logLifecycle } from '@/lib/debug-logger';
import { colors as C } from '@/theme.config';
import { KEY_BAR_HEIGHT } from '@/lib/layout-constants';

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
  const paneId = useContext(PaneIdContext);
  const paneSessionId = useMultiPaneStore((s) => {
    if (!paneId) return null;
    for (const slot of s.slots) {
      if (slot && slot.id === paneId && slot.sessionId) return slot.sessionId;
    }
    return null;
  });
  const globalActiveSession = useActiveSession();
  // Selector-based reads. The previous `const { removeSession, sessions,
  // settings } = useTerminalStore()` whole-store destructure caused a
  // re-render on EVERY store update (transcript byte append, cwd change,
  // any session field mutation). Combined with `ensureNativeSessions`'s
  // `[sessions, …]` useCallback deps, that re-built the callback every
  // render, re-fired the dependent useEffect, and produced the 40 fps
  // logcat storm observed on Z Fold6 the moment a heavy WebView SPA
  // (YouTube) started posting onMessage / onNavigationStateChange.
  // Splitting into per-key selectors keeps each subscription scoped to
  // its own slice — `sessions` array reference only flips on
  // add/remove/edit, not on every byte append.
  const sessions = useTerminalStore((s) => s.sessions);
  const settings = useTerminalStore((s) => s.settings);
  // Phase B: when a wallpaper is set, ask the native TerminalView to drop
  // its opaque background + padding fill so the wallpaper shows through.
  // Cells with non-default backgrounds still paint, so prompt colours /
  // syntax highlights stay visible as expected.
  const wallpaperActive = useCosmeticStore((s) => !!s.wallpaperUri);
  const activeSession = paneSessionId
    ? sessions.find((s) => s.id === paneSessionId) ?? globalActiveSession
    : globalActiveSession;
  const activeNativeSessionId = activeSession?.nativeSessionId;
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

  // Block History panel toggle
  const [showBlockHistory, setShowBlockHistory] = useState(false);

  const showSetupOverlay = false; // Setup now runs directly on PTY, no overlay needed

  // Scroll state — show FAB when user scrolls up
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const terminalViewRef = useRef<any>(null);

  // Keyboard height tracking for terminal resize (same pattern as Chat screen)
  const [, setKeyboardHeight] = useState(0);
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
  const sessionsEnsureKey = useMemo(
    () => sessions.map((s) => `${s.id}:${s.nativeSessionId}:${s.sessionStatus}`).join('|'),
    [sessions],
  );

  // Click-to-Edit: placeholder — AI edit dispatch will be routed through
  // the AI pane in a future version. For now, log and ignore.
  const handleEditSubmit = useCallback((_prompt: string) => {
    logInfo('Terminal', 'handleEditSubmit: AI edit not yet routed to AI pane');
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
      try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}

      // Create session via JNI forkpty. If a live session with the same id
      // already exists in the Service-owned registry (Case B — the foreground
      // service kept the forked PTY child alive across app background / RN
      // reload), the native side returns resumed=true and we skip the Case C
      // transcript replay below.
      const createResult = await TerminalEmulator.createSession({
        sessionId: session.nativeSessionId,
        rows: 24,
        cols: 80,
      });
      const resumedLive = createResult?.resumed === true;
      if (resumedLive) {
        logInfo('Terminal', 'createNativeSession: resumed live session ' + session.nativeSessionId);
      }

      // Start foreground service to prevent task-kill (may fail if Service class missing)
      try { await TerminalEmulator.startSessionService(); } catch {}

      // Update session status
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id ? { ...s, sessionStatus: 'alive' as const, isAlive: true } : s
        ),
      }));

      // bug #65: Case C fallback — only when the native side did NOT resume a
      // live session (i.e. the process was killed and forked afresh). Replay
      // the previous transcript snapshot into the fresh emulator so the user
      // sees their last-session history on startup. Visual-only; the shell
      // itself is new. When resumedLive is true the real interactive state
      // (vim, agent CLIs, REPLs) is still alive and replay would only
      // double-print history, so we skip it.
      if (!resumedLive && session.transcriptSnapshot && session.transcriptSnapshot.length > 0) {
        try {
          const header = '\r\n\x1b[2m── previous session (restored) ──\x1b[0m\r\n';
          const footer = '\r\n\x1b[2m── end of restored history — fresh shell below ──\x1b[0m\r\n';
          // The native emulator consumes bytes via writeToEmulator (no shell involvement)
          await TerminalEmulator.writeToEmulator(session.nativeSessionId, header);
          // Normalise newlines to CRLF so the emulator wraps rows correctly
          const normalised = session.transcriptSnapshot.replace(/\r?\n/g, '\r\n');
          await TerminalEmulator.writeToEmulator(session.nativeSessionId, normalised);
          await TerminalEmulator.writeToEmulator(session.nativeSessionId, footer);
        } catch (e) {
          logInfo('Terminal', 'transcript replay skipped: ' + String(e));
        }
      }

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
  // Reads `sessions` via getState() rather than via the closure to keep
  // this useCallback's identity stable across re-renders. Previously the
  // dep `[sessions, ...]` made the callback re-create on every store
  // update, which re-fired the dependent useEffect (line ~370) and
  // produced a 40 fps render storm visible in logcat as
  // `ensureNativeSessions called` once per render. Mutex on line 329
  // already prevented runaway PTY creation; the loop was just log /
  // scheduling churn, but enough to starve the WebView render thread
  // when YouTube SPA was busy posting messages.
  const ensureNativeSessions = useCallback(async () => {
    const sessions = useTerminalStore.getState().sessions;
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
  }, [createNativeSession, recoverSession]);

  // Run when terminal sessions are mounted or rehydrated. APK installs /
  // process restarts can restore persisted sessions after the first render;
  // running this only once left those restored sessions in "starting" with no
  // native PTY, which rendered as a blank terminal with no prompt.
  useEffect(() => {
    void ensureNativeSessions();
  }, [ensureNativeSessions, sessionsEnsureKey]);

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

  // bug #112: focus recovery after Modal dismiss. Closing LayoutAddSheet,
  // ConfigTUI, CommandPalette, or any other Modal leaves the Activity's
  // window focus unset on Android edge-to-edge (dumpsys window shows
  // `mCurrentFocus=null`). The soft keyboard stays visible but no view
  // receives commitText, so the user has to tap the terminal before
  // typing works again. The focus-store counter is incremented by each
  // Modal's close handler; we observe it here and call the native
  // TerminalView.focus(tag) helper which does requestFocus +
  // showSoftInput and restores typing without the stray tap.
  const refocusTick = useFocusStore((s) => s.refocusTick);
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  useEffect(() => {
    if (refocusTick === 0) return; // initial mount, nothing to do
    if (paneId && focusedPaneId !== paneId) return;
    const tag = findNodeHandle(terminalViewRef.current);
    if (tag) TerminalViewModule.focus(tag);
  }, [refocusTick, focusedPaneId, paneId]);

  // bug #116: Per-pane focus follow. When the user taps another terminal
  // pane, `PaneSlot.onTouchStart` -> `handleFocusPane` updates
  // `usePaneStore.focusedPaneId`, and every mounted TerminalPane observes
  // whether it just became the focused one. If so, move the native view
  // focus so keyboard input lands here instead of the previously-focused
  // pane. The `refocusTick` effect above covers modal-dismiss recovery
  // (global bump); this effect covers inter-pane switching (per-pane edge).
  useEffect(() => {
    if (!paneId) return;
    if (focusedPaneId !== paneId) return;
    const tag = findNodeHandle(terminalViewRef.current);
    if (tag) TerminalViewModule.focus(tag);
  }, [focusedPaneId, paneId]);

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

  // Battery optimization exemption — prompt once per app launch on
  // unexpected disconnect. Earlier revisions fired this on every
  // onSessionExit, including intentional tab closes and `exit` commands,
  // which made the modal spam across add/remove cycles (observed
  // 2026-04-19 running __shelly_bg_cli_update). Gate with a ref so one
  // dismissal is enough for this session, and the caller further gates
  // on isProcessKill() so only SIGKILL exits (Android battery-optimiser
  // killing us) trigger the prompt.
  const batteryPromptShownRef = useRef(false);
  const checkBatteryExemption = useCallback(async () => {
    if (batteryPromptShownRef.current) return;
    try {
      const isExempted = await TerminalEmulator.isIgnoringBatteryOptimizations();
      if (!isExempted) {
        batteryPromptShownRef.current = true;
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
        // Only prompt battery exemption on actual SIGKILLs (= Android
        // killed our child due to battery optimisation, the thing the
        // exemption is actually for). Prompting on every session exit,
        // including intentional tab closes and user-typed `exit`, made
        // the modal spam during normal session add/remove cycles.
        checkBatteryExemption();
      }
    });
    return () => sub.remove();
  }, [checkBatteryExemption]);

  // Handle reset requests from PaneCliTabs long-press menu
  const pendingResetId = useTerminalStore((s) => s.pendingResetSessionId);
  useEffect(() => {
    if (!pendingResetId) return;
    const session = sessions.find((s) => s.id === pendingResetId);
    if (session) {
        useTerminalStore.getState().clearPendingReset();
        resetSession(session);
    }
  }, [pendingResetId, sessions, resetSession]);

  // Consume staged writes from the rest of the app. Quick-launch/login callers
  // scope the command to the newly created session; legacy unscoped inserts are
  // consumed only by the globally active terminal so mounted panes cannot race.
  const pendingCommand = useTerminalStore((s) => s.pendingCommand);
  useEffect(() => {
    if (!pendingCommand) return;
    if (!activeSession?.id || !activeSession.nativeSessionId) return;

    const command = typeof pendingCommand === 'string'
      ? pendingCommand
      : pendingCommand.command;
    const pendingId = typeof pendingCommand === 'string'
      ? undefined
      : pendingCommand.id;
    const targetSessionId = typeof pendingCommand === 'string'
      ? null
      : pendingCommand.sessionId ?? null;

    if (targetSessionId) {
      if (activeSession.id !== targetSessionId) return;
    } else {
      const globallyActiveSessionId = useTerminalStore.getState().activeSessionId;
      if (activeSession.id !== globallyActiveSessionId) return;
    }

    const target = activeSession.nativeSessionId;
    TerminalEmulator.writeToSession(target, command).catch((err) => {
      console.warn('[Terminal] pendingCommand writeToSession failed:', err);
    });
    useTerminalStore.getState().clearPendingCommand(pendingId);
  }, [pendingCommand, activeSession?.id, activeSession?.nativeSessionId]);

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

  // Terminal ANSI palette follows Terminal Theme only. App chrome/UI theme
  // must not collapse syntax highlighting into one accent color.
  const terminalColorScheme = useMemo(() => {
    const themeName = settings.terminalTheme ?? 'shelly';
    const theme = getTerminalTheme(themeName);
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
  const terminalPaneBg = usePanelBackground(terminalColorScheme.background);

  // Terminal font size honors the user's Settings → Display → Font Size
  // choice. Since the terminal now uses JetBrains Mono (not Silkscreen),
  // the old "pixel font is tiny, scale it up aggressively" mapping does
  // not apply. JetBrains Mono at 11px is already readable; 14px is
  // comfortable; 17px is spacious. Mapping chosen for comfortable
  // reading on phone and Fold screens:
  //   S  -> 11 sp (compact, fits more on screen)
  //   M  -> 14 sp (default, balanced)
  //   L  -> 17 sp (spacious, glasses-friendly)
  // Compact screens (Z Fold 6 cover display ~ 373dp) shave one extra sp.
  const termFontSize = (() => {
    const base = settings.fontSize ?? 14;
    const mapped = base <= 12 ? 11 : base <= 14 ? 14 : 17;
    const adjusted = layout.isCompact ? Math.max(10, mapped - 1) : mapped;
    // Bug #56 — in 2×2 / 3-pane grids each pane drops below ~420dp.
    // Step the font down so terminal content reflows instead of
    // overflowing the pane chrome.
    const pw = multiPaneCtx?.paneWidth ?? 0;
    if (pw > 0 && pw < 260) return Math.max(9, adjusted - 3);
    if (pw > 0 && pw < 360) return Math.max(10, adjusted - 2);
    if (pw > 0 && pw < 480) return Math.max(10, adjusted - 1);
    return adjusted;
  })();
  const terminalBottomInset = isConnected ? KEY_BAR_HEIGHT + 10 : 10;

  // Send text to terminal via native PTY
  const sendToTerminal = useCallback((text: string) => {
    if (!activeNativeSessionId || !text) return;
    TerminalEmulator.writeToSession(activeNativeSessionId, text).catch((err) => {
      console.warn('[Terminal] writeToSession failed:', err);
    });
  }, [activeNativeSessionId]);

  // bug #81: Paste path for clipboard contents. Goes through the emulator's
  // paste() which normalizes CR/LF and wraps the payload in bracketed-paste
  // markers, so bash/zsh treat the whole chunk as a single paste event. The
  // raw write path clipped the first byte of multi-line clipboard payloads
  // because bash's prompt echo raced the PTY write.
  const pasteToTerminal = useCallback((text: string) => {
    if (!activeNativeSessionId || !text) return;
    TerminalEmulator.pasteToSession(activeNativeSessionId, text).catch((err) => {
      console.warn('[Terminal] pasteToSession failed:', err);
    });
  }, [activeNativeSessionId]);

  const pasteClipboardToTerminal = useCallback(() => {
    if (!activeNativeSessionId) return;
    return TerminalEmulator.pasteClipboardToSession(activeNativeSessionId).catch((err) => {
      console.warn('[Terminal] pasteClipboardToSession failed:', err);
      throw err;
    });
  }, [activeNativeSessionId]);

  // bug #44: Voice input routing.
  //
  // Previously the STT transcript was written straight into the PTY, which
  // meant Japanese utterances like "ハローワールドを一応出して" were handed
  // to bash as a literal command and immediately produced "command not
  // found". Voice input is overwhelmingly used to talk to the AI, not to
  // type shell commands character-by-character, so we route every voice
  // transcript through the AI pane dispatch instead of the terminal.
  //
  // The rare case of dictating a real shell command (e.g. "ls -la") is
  // still recoverable: the AI pane will echo it back or the user can paste
  // it via the key bar. This is the "always send to AI" path the spec calls
  // out as the minimum viable implementation.
  const slots = useMultiPaneStore((s) => s.slots);
  const firstAiPaneId = useMemo(() => {
    for (const slot of slots) {
      if (slot && slot.tab === 'ai') return slot.id;
    }
    return '';
  }, [slots]);
  const { dispatch: aiDispatch } = useAIPaneDispatch(firstAiPaneId);

  const handleVoiceInput = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (firstAiPaneId) {
      void aiDispatch(trimmed);
      return;
    }
    // No AI pane open — fall back to a visible warning rather than
    // silently dumping the transcript into bash.
    Alert.alert(
      'No AI pane open',
      'Voice input is routed to the AI pane. Open an AI pane to use it.',
    );
  }, [aiDispatch, firstAiPaneId]);

  // Send raw key code to terminal
  const sendKey = useCallback((keyCode: string) => {
    if (!activeNativeSessionId) return;
    TerminalEmulator.writeToSession(activeNativeSessionId, keyCode).catch((err) => {
      console.warn('[Terminal] sendKey failed:', err);
    });
  }, [activeNativeSessionId]);

  // Copy file from device to terminal cwd
  const copyFileToCwd = useCallback(async (sourceUri: string, fileName: string) => {
    try {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tempPath = `${FileSystem.cacheDirectory}${safeName}`;
      await FileSystem.copyAsync({ from: sourceUri, to: tempPath });
      // Use terminal to copy file to cwd
      sendToTerminal(`cp '${tempPath}' './${safeName}'\n`);
    } catch (e) {
      console.warn('[Terminal] file copy failed:', e);
    }
  }, [sendToTerminal]);


  const handleReload = useCallback(() => {
    if (activeSession) {
      recoverSession(activeSession);
    }
  }, [activeSession, recoverSession]);

  // bug (post-v0.1.0): in a 3-pane split layout the per-pane paddingBottom:
  // keyboardHeight double/triple-counted, so each terminal reserved the full
  // keyboard height at the bottom and the content area collapsed to 0px.
  // Keyboard avoidance is now done once at the MultiPaneContainer level, so
  // individual panes must NOT add their own keyboardHeight padding — we keep
  // the Keyboard listener around only because other UX pieces (scroll
  // anchoring) may read it later.
  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: terminalPaneBg }]}>
      {/* Headers moved into PaneSlot so each pane only pays for one header row */}

      {/* Preview Banner — slides in when localhost URL detected */}
      {bannerVisible && bannerUrl && isConnected && (
        <PreviewBanner url={bannerUrl} onOpen={() => openPreview()} onDismiss={dismissBanner} />
      )}

      {/* Terminal + Preview Split View */}
      {activeSession && isConnected && !isHiddenBehindMultiPane && (
        <View style={[styles.terminalBody, { flexDirection: showSplitPreview ? 'row' : 'column' }]}>
          {/* Native Terminal View */}
          <NativeTerminalView
            ref={terminalViewRef}
            testID="native-terminal-view"
            sessionId={activeSession.nativeSessionId}
            // Terminal font is deliberately NOT Silkscreen. Silkscreen's
            // glyph design has all letters drawn in uppercase shapes —
            // even lowercase code points render as visual capitals — so
            // using it in the terminal makes it impossible to tell what
            // you actually typed. The surrounding UI chrome can still
            // wear Silkscreen as its brand identity, but the terminal
            // pane itself uses JetBrains Mono so character case is
            // readable. The 'pixel' preset still gets PixelMplus for
            // users who want a pixel aesthetic with real lowercase.
            fontFamily={
              settings.uiFont === 'pixel'
                ? 'pixel-mplus'
                : 'jetbrains-mono'
            }
            fontSize={termFontSize}
            cursorShape={settings.cursorShape || 'block'}
            cursorBlink={true}
            colorScheme={terminalColorScheme}
            gpuRendering={settings.gpuRendering ?? false}
            transparentBackground={wallpaperActive}
            style={[
              styles.terminalView,
              {
                flex: showSplitPreview ? splitRatio : 1,
                backgroundColor: wallpaperActive ? 'transparent' : terminalColorScheme.background,
                paddingBottom: terminalBottomInset,
              },
            ]}
            onScrollStateChanged={(e) => setIsScrolledUp(e.nativeEvent.isScrolledUp)}
            onFocusRequested={(e) => {
              // Native bridge for bug #116 follow-up. Body taps inside the
              // terminal don't reach PaneSlot.onTouchStart because the
              // Termux TerminalView calls requestDisallowInterceptTouchEvent.
              // We mirror handleFocusPane here so every tap — header, tab,
              // or body — drives the same 4-store focus handoff.
              if (!paneId) return;
              const evSessId = e.nativeEvent.sessionId || '';
              console.log('[Shelly][Pane] onFocusRequested paneId=' + paneId + ' sessId=' + evSessId);
              usePaneStore.getState().setFocusedPane(paneId);
              const mps = useMultiPaneStore.getState();
              const idx = mps.slots.findIndex((s) => s?.id === paneId);
              if (idx >= 0 && idx < 4) {
                mps.focusSlot(idx as 0 | 1 | 2 | 3);
                const slot = mps.slots[idx];
                if (slot && slot.tab === 'terminal' && slot.sessionId) {
                  useTerminalStore.getState().setActiveSession(slot.sessionId);
                }
              }
              useFocusStore.getState().requestTerminalRefocus();
            }}
            onOutput={() => {}}
            onBlockCompleted={async (e) => {
              const { command, output, exitCode } = e.nativeEvent;
              if (command && command.trim()) {
                const trimmedCmd = command.trim();

                // bug #59: Intercept @mention commands (@agent / ...)
                // Bash naturally rejects them ("@agent: command not found") so
                // we swallow that error and route through Shelly's own layer.
                // Typing goes straight through the native PTY, so the earliest
                // JS-visible intercept point is onBlockCompleted — we replace
                // the failed bash block with a synthetic success block.
                const parsed = parseInput(trimmedCmd);
                if (parsed.layer === 'mention' && parsed.target === 'agent') {
                  const { addEntryBlock, activeSessionId } = useTerminalStore.getState();
                  let resultMessage: string;
                  try {
                    const agentResult = parseAgentCommand(parsed.prompt);
                    if (agentResult.type === 'create') {
                      // Natural-language agent creation. Build a minimal agent
                      // with sensible defaults — the full creation wizard can
                      // refine this later. Name is derived from the first word
                      // of the prompt (e.g. "test echo hello" -> "test").
                      const promptText = agentResult.message;
                      const firstWord = promptText.split(/\s+/)[0] || 'agent';
                      const name = firstWord.replace(/[^a-zA-Z0-9_-]/g, '') || `agent-${Date.now().toString(36)}`;
                      const suggestion = agentResult.data?.suggestion ?? suggestTool(promptText);
                      const agent = createAgent({
                        name,
                        description: promptText.slice(0, 120),
                        prompt: promptText,
                        schedule: null,
                        tool: suggestion.tool,
                        outputPath: `~/.shelly/agents/${name}/output`,
                      });
                      await installAgent(agent, async (cmd) => {
                        const result = await execCommand(cmd, 120_000);
                        if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
                        return result.stdout;
                      });
                      resultMessage = `✅ Agent "${agent.name}" installed (${suggestion.label}). Run it with: @agent run ${agent.name}`;
                    } else if (agentResult.type === 'run') {
                      await runAgentNow(agentResult.data.agentId, async (cmd) => {
                        const result = await execCommand(cmd, 120_000);
                        if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
                        return result.stdout;
                      });
                      resultMessage = agentResult.message;
                    } else if (agentResult.type === 'stop') {
                      await stopAgent(agentResult.data.agentId, async (cmd) => {
                        const result = await execCommand(cmd, 120_000);
                        if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
                        return result.stdout;
                      });
                      resultMessage = agentResult.message;
                    } else {
                      resultMessage = agentResult.message;
                    }
                  } catch (err) {
                    resultMessage = `[@agent] error: ${err instanceof Error ? err.message : String(err)}`;
                  }
                  addEntryBlock({
                    id: generateId(),
                    sessionId: activeSessionId ?? '',
                    command: trimmedCmd,
                    output: resultMessage.split('\n').map((line: string) => ({ text: line, type: 'stdout' as const })),
                    timestamp: Date.now(),
                    exitCode: 0,
                    isRunning: false,
                    blockStatus: 'done',
                    connectionMode: 'native',
                  });
                  return;
                }

                const { addEntryBlock, activeSessionId } = useTerminalStore.getState();
                addEntryBlock({
                  id: generateId(),
                  sessionId: activeSessionId ?? '',
                  command: trimmedCmd,
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
        <View style={[StyleSheet.absoluteFill, { backgroundColor: terminalPaneBg, justifyContent: 'center', alignItems: 'center', zIndex: 10 }]}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={{ color: C.text3, fontFamily: 'JetBrainsMono_400Regular', fontSize: 11, marginTop: 8 }}>
            Restoring session...
          </Text>
        </View>
      )}

      {connectionState === 'connecting' && !isRecovering && activeSession && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: terminalPaneBg, justifyContent: 'center', alignItems: 'center', zIndex: 10 }]}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={{ color: C.text3, fontFamily: 'JetBrainsMono_400Regular', fontSize: 11, marginTop: 8 }}>
            Starting terminal...
          </Text>
        </View>
      )}

      {/* Block History Panel — toggleable overlay over terminal */}
      {showBlockHistory && activeSession && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 20, backgroundColor: c.background }]}>
          {/* Panel Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.surface }}>
            <Text style={{ color: c.foreground, fontFamily: 'JetBrainsMono_400Regular', fontSize: 13, fontWeight: '700', flex: 1 }}>
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
        <View style={styles.keyBarDock} pointerEvents="box-none">
          <CommandKeyBar
            sendKey={sendKey}
            sendText={sendToTerminal}
            sendPaste={pasteToTerminal}
            pasteFromClipboard={pasteClipboardToTerminal}
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
        </View>
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
        onClose={() => {
          setShowProcessGuard(false);
          killCountRef.current = 0;
          useFocusStore.getState().requestTerminalRefocus();
        }}
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
  container: { flex: 1, position: 'relative' },
  terminalBody: {
    flex: 1,
    paddingBottom: KEY_BAR_HEIGHT + 10,
  },
  keyBarDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: KEY_BAR_HEIGHT,
    zIndex: 30,
    elevation: 30,
  },

  // Connecting
  connectingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  connectingText: { fontSize: 15, fontFamily: 'JetBrainsMono_400Regular', fontWeight: '600' },

  // Native terminal view. bug #82: small horizontal gutter so text
  // doesn't crash into the pane edge. The native updateSize() subtracts
  // getPaddingLeft/Right before computing cols, so this correctly reduces
  // the reflow width instead of just cropping the rightmost column.
  //
  // Wallpaper mode: the native TerminalView receives transparentBackground,
  // and the RN wrapper stays transparent so the shared BackgroundLayer shows.
  terminalView: { paddingHorizontal: 6, paddingVertical: 2 },

  // Error state
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'JetBrainsMono_400Regular' },
  errorSubtitle: { fontSize: 13, fontFamily: 'JetBrainsMono_400Regular', textAlign: 'center', lineHeight: 20 },

  // Retry button
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'JetBrainsMono_400Regular' },

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
