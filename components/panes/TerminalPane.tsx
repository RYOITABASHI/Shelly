/**
 * Terminal Screen — Native terminal view via direct JNI forkpty (Plan B)
 * No TCP, no pty-helper, no bridge dependency.
 */
import React, { useRef, useState, useCallback, useEffect, useMemo, useContext } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
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
import {
  abandonNativeSessionCreate,
  abandonNativeSessionCreateIfTimedOut,
  beginNativeSessionCreate,
  endNativeSessionCreate,
  isNativeSessionIdReserved,
  isNativeSessionCreateAttemptCurrent,
  isNativeSessionCreateInFlight,
  isNativeSessionCreateTimedOut,
  markNativeSessionCreateTimedOut,
  releaseNativeSessionId,
} from '@/lib/terminal-native-session-reservations';
import { colors as C } from '@/theme.config';
import { KEY_BAR_HEIGHT } from '@/lib/layout-constants';

logInfo('Terminal', 'module loaded');

// ─── Status type for StatusBadge ─────────────────────────────────────────────

type ConnectionState = 'connecting' | 'connected' | 'error';

const NATIVE_SESSION_CREATE_TIMEOUT_MS = 15_000;
const NATIVE_SESSION_CREATE_AUTO_RETRY_DELAY_MS = 180;
const NATIVE_SESSION_CREATE_RETRY_IN_FLIGHT_POLL_MS = 200;
const NATIVE_SESSION_CREATE_RETRY_MAX_WAIT_MS = NATIVE_SESSION_CREATE_TIMEOUT_MS + 1_000;
const NATIVE_SESSION_CREATE_MAX_AUTO_RETRIES = 1;
const NATIVE_SESSION_EARLY_EXIT_RETRY_WINDOW_MS = 2_500;
const NATIVE_SESSION_EARLY_EXIT_ALIVE_GRACE_MS = 500;

const nativeCreateAutoRetryCounts = new Map<string, number>();
const nativeSessionCreateStartedAtMs = new Map<string, number>();
const nativeSessionAliveMarkedAtMs = new Map<string, number>();
const nativeSessionEarlyExitDecisions = new Map<string, boolean>();
const nativeSessionExitMarkers = new Set<string>();
const nativeSessionUserActivityMarkers = new Set<string>();
const nativeSessionRetrySchedules = new Set<string>();
const nativeSessionRetryBudgetClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const nativeSessionReservationsToReleaseOnAlive = new Map<string, Set<string>>();

class NativeSessionCreateTimeoutError extends Error {
  constructor(nativeSessionId: string) {
    super(`Native terminal session ${nativeSessionId} did not start within ${NATIVE_SESSION_CREATE_TIMEOUT_MS / 1000}s`);
    this.name = 'NativeSessionCreateTimeoutError';
  }
}

function sessionStatusToConnectionState(status: SessionStatus | undefined): ConnectionState {
  switch (status) {
    case 'alive': return 'connected';
    case 'starting':
    case 'recovering': return 'connecting';
    case 'exited':
    default: return 'error';
  }
}

function withNativeSessionCreateTimeout<T>(promise: Promise<T>, nativeSessionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NativeSessionCreateTimeoutError(nativeSessionId));
    }, NATIVE_SESSION_CREATE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isNativeSessionCreateTimeout(error: unknown): boolean {
  return error instanceof NativeSessionCreateTimeoutError;
}

function claimNativeCreateAutoRetry(sessionId: string, nativeSessionId: string, reason: string): boolean {
  const retryCount = nativeCreateAutoRetryCounts.get(sessionId) ?? 0;
  if (retryCount >= NATIVE_SESSION_CREATE_MAX_AUTO_RETRIES) {
    logInfo('Terminal', `native auto-retry skipped (${reason}) for ${nativeSessionId}`);
    return false;
  }

  nativeCreateAutoRetryCounts.set(sessionId, retryCount + 1);
  logInfo('Terminal', `native auto-retry claimed (${reason}) for ${nativeSessionId}`);
  return true;
}

function clearNativeCreateAutoRetry(sessionId: string): void {
  nativeCreateAutoRetryCounts.delete(sessionId);
}

function nativeSessionKey(sessionId: string, nativeSessionId: string): string {
  return `${sessionId}:${nativeSessionId}`;
}

function cancelNativeCreateRetrySchedules(sessionId: string): void {
  for (const key of Array.from(nativeSessionRetrySchedules)) {
    if (key.startsWith(`${sessionId}:`)) {
      nativeSessionRetrySchedules.delete(key);
    }
  }
}

function makeRetryNativeSessionId(session: TabSession): string {
  return `${session.tmuxSession || session.nativeSessionId}-${generateId()}`;
}

function markNativeSessionCreateStarted(sessionId: string, nativeSessionId: string): void {
  const key = nativeSessionKey(sessionId, nativeSessionId);
  nativeSessionCreateStartedAtMs.set(key, Date.now());
  nativeSessionAliveMarkedAtMs.delete(key);
  nativeSessionEarlyExitDecisions.delete(key);
  nativeSessionExitMarkers.delete(key);
  nativeSessionUserActivityMarkers.delete(key);
}

function markNativeSessionAlive(sessionId: string, nativeSessionId: string): void {
  nativeSessionAliveMarkedAtMs.set(nativeSessionKey(sessionId, nativeSessionId), Date.now());
}

function isWithinNativeSessionAliveGrace(sessionId: string, nativeSessionId: string): boolean {
  const markedAt = nativeSessionAliveMarkedAtMs.get(nativeSessionKey(sessionId, nativeSessionId));
  return !!markedAt && Date.now() - markedAt <= NATIVE_SESSION_EARLY_EXIT_ALIVE_GRACE_MS;
}

function markNativeSessionExited(sessionId: string, nativeSessionId: string): void {
  nativeSessionExitMarkers.add(nativeSessionKey(sessionId, nativeSessionId));
}

function didNativeSessionExit(sessionId: string, nativeSessionId: string): boolean {
  return nativeSessionExitMarkers.has(nativeSessionKey(sessionId, nativeSessionId));
}

function markNativeSessionUserActivity(sessionId: string, nativeSessionId: string): void {
  nativeSessionUserActivityMarkers.add(nativeSessionKey(sessionId, nativeSessionId));
}

function hasNativeSessionUserActivity(sessionId: string, nativeSessionId: string): boolean {
  return nativeSessionUserActivityMarkers.has(nativeSessionKey(sessionId, nativeSessionId));
}

function queueNativeSessionReservationRelease(sessionId: string, nativeSessionId: string): void {
  if (!nativeSessionId) return;
  const queued = nativeSessionReservationsToReleaseOnAlive.get(sessionId) ?? new Set<string>();
  queued.add(nativeSessionId);
  nativeSessionReservationsToReleaseOnAlive.set(sessionId, queued);
}

function forgetQueuedNativeSessionReservation(nativeSessionId: string): void {
  for (const [sessionId, queued] of nativeSessionReservationsToReleaseOnAlive) {
    queued.delete(nativeSessionId);
    if (queued.size === 0) {
      nativeSessionReservationsToReleaseOnAlive.delete(sessionId);
    }
  }
}

function releaseQueuedNativeSessionReservations(sessionId: string, aliveNativeSessionId: string): void {
  const queued = nativeSessionReservationsToReleaseOnAlive.get(sessionId);
  if (!queued) return;

  for (const nativeSessionId of queued) {
    if (nativeSessionId !== aliveNativeSessionId) {
      releaseNativeSessionId(nativeSessionId);
    }
  }
  nativeSessionReservationsToReleaseOnAlive.delete(sessionId);
}

function releaseReservedNativeSessionId(nativeSessionId: string): void {
  releaseNativeSessionId(nativeSessionId);
  forgetQueuedNativeSessionReservation(nativeSessionId);
}

function scheduleNativeCreateAutoRetryClear(sessionId: string, nativeSessionId: string): void {
  const key = nativeSessionKey(sessionId, nativeSessionId);
  const existing = nativeSessionRetryBudgetClearTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    nativeSessionRetryBudgetClearTimers.delete(key);
    nativeSessionCreateStartedAtMs.delete(key);
    nativeSessionAliveMarkedAtMs.delete(key);
    nativeSessionEarlyExitDecisions.delete(key);
    nativeSessionUserActivityMarkers.delete(key);

    const currentSession = useTerminalStore.getState().sessions.find((session) => session.id === sessionId);
    if (currentSession?.nativeSessionId === nativeSessionId && currentSession.sessionStatus === 'alive') {
      releaseQueuedNativeSessionReservations(sessionId, nativeSessionId);
      clearNativeCreateAutoRetry(sessionId);
      nativeSessionExitMarkers.delete(key);
    }
  }, NATIVE_SESSION_EARLY_EXIT_RETRY_WINDOW_MS);

  nativeSessionRetryBudgetClearTimers.set(key, timer);
}

function shouldAutoRetryEarlyExit(session: TabSession, exitCode: number, signal?: number): boolean {
  const key = nativeSessionKey(session.id, session.nativeSessionId);
  const existingDecision = nativeSessionEarlyExitDecisions.get(key);
  if (existingDecision !== undefined) return existingDecision;

  const startedAt = nativeSessionCreateStartedAtMs.get(key);
  const withinStartupWindow = !!startedAt && Date.now() - startedAt <= NATIVE_SESSION_EARLY_EXIT_RETRY_WINDOW_MS;
  const startupLifecycle = session.sessionStatus === 'starting'
    || session.sessionStatus === 'recovering'
    || session.sessionStatus === 'alive';
  const aliveRetryAllowed = session.sessionStatus !== 'alive'
    || isWithinNativeSessionAliveGrace(session.id, session.nativeSessionId);
  const userActivitySeen = hasNativeSessionUserActivity(session.id, session.nativeSessionId);
  const exitSummary = signal ? `signal ${signal}` : `exit ${exitCode}`;
  const shouldRetry = startupLifecycle
    && withinStartupWindow
    && aliveRetryAllowed
    && !userActivitySeen
    && claimNativeCreateAutoRetry(session.id, session.nativeSessionId, `early exit ${exitSummary}`);

  nativeSessionEarlyExitDecisions.set(key, shouldRetry);
  if (!shouldRetry) {
    nativeSessionCreateStartedAtMs.delete(key);
    nativeSessionAliveMarkedAtMs.delete(key);
    nativeSessionUserActivityMarkers.delete(key);
  }
  return shouldRetry;
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
  // Keep terminal panes opaque. Letting the wallpaper/panel background bleed
  // through the native terminal makes Android IME resize and view re-mounts
  // show gray washes behind empty cells.
  const wallpaperActive = false;
  const activeSession = paneSessionId
    ? sessions.find((s) => s.id === paneSessionId) ?? globalActiveSession
    : globalActiveSession;
  const activeSessionRecordId = activeSession?.id;
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
  const createNativeSessionRef = useRef<((session: TabSession) => Promise<void>) | null>(null);

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
  const refocusTick = useFocusStore((s) => s.refocusTick);
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const focusTerminalViewNow = useCallback(() => {
    const tag = findNodeHandle(terminalViewRef.current);
    if (!tag) return;
    Promise.resolve(TerminalViewModule.focus(tag)).catch(() => undefined);
  }, []);
  const scheduleTerminalFocus = useCallback(() => {
    const timers = [0, 80, 240, 600].map((delayMs) => (
      setTimeout(focusTerminalViewNow, delayMs)
    ));
    return () => timers.forEach(clearTimeout);
  }, [focusTerminalViewNow]);

  // Keyboard height tracking for single-pane terminal rendering. MultiPaneContainer
  // owns IME avoidance for pane-grid children; the tab-side terminal still needs
  // its own inset so the key bar and prompt do not disappear behind the keyboard.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const scrollToBottomSoon = () => {
      requestAnimationFrame(() => {
        const tag = findNodeHandle(terminalViewRef.current);
        if (tag) TerminalViewModule.scrollToBottom(tag).catch(() => undefined);
      });
    };
    const syncKeyboardMetrics = () => {
      if (isRenderedInMultiPane) return;
      const metrics = (Keyboard as any).metrics?.();
      const screenHeight = Dimensions.get('screen').height;
      const inferredFromY =
        typeof metrics?.screenY === 'number'
          ? Math.max(0, screenHeight - metrics.screenY)
          : 0;
      const raw = Math.max(metrics?.height ?? 0, inferredFromY);
      const adjusted = Math.max(0, raw - insets.bottom);
      setKeyboardHeight((prev) => (Math.abs(prev - adjusted) <= 2 ? prev : adjusted));
      if (adjusted > 0) scrollToBottomSoon();
    };
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      // Subtract navigation bar inset to avoid double-padding
      const raw = e.endCoordinates.height;
      const adjusted = Math.max(0, raw - insets.bottom);
      setKeyboardHeight(adjusted);
      scrollToBottomSoon();
      requestAnimationFrame(syncKeyboardMetrics);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    const interval = isRenderedInMultiPane ? null : setInterval(syncKeyboardMetrics, 250);
    requestAnimationFrame(syncKeyboardMetrics);
    return () => {
      showSub.remove();
      hideSub.remove();
      if (interval) clearInterval(interval);
    };
  }, [insets.bottom, isRenderedInMultiPane]);

  // Recovery state — shown while session re-creates
  const [isRecovering, setIsRecovering] = useState(false);

  // Derive connection state from native session status
  const connectionState = sessionStatusToConnectionState(activeSession?.sessionStatus);
  const isConnected = connectionState === 'connected';
  const shouldRestoreTerminalFocus = useCallback(() => {
    if (!activeSessionRecordId || !activeNativeSessionId || !isConnected) return false;
    if (isHiddenBehindMultiPane) return false;
    if (paneId && focusedPaneId !== paneId) return false;
    return true;
  }, [
    activeNativeSessionId,
    activeSessionRecordId,
    focusedPaneId,
    isConnected,
    isHiddenBehindMultiPane,
    paneId,
  ]);

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

  const abandonTimedOutCreate = useCallback((session: TabSession): TabSession => {
    if (!abandonNativeSessionCreateIfTimedOut(session.id, session.nativeSessionId)) return session;
    queueNativeSessionReservationRelease(session.id, session.nativeSessionId);

    const nextNativeSessionId = makeRetryNativeSessionId(session);
    logInfo(
      'Terminal',
      `abandonTimedOutCreate: ${session.nativeSessionId} -> ${nextNativeSessionId}`,
    );

    const nextSession: TabSession = {
      ...session,
      activeCli: null,
      nativeSessionId: nextNativeSessionId,
      sessionStatus: 'starting',
      isAlive: false,
    };
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => (s.id === session.id ? nextSession : s)),
    }));
    return nextSession;
  }, []);

  const setNativeSessionLifecycle = useCallback((session: TabSession, status: SessionStatus): TabSession => {
    let nextSession: TabSession = {
      ...session,
      activeCli: null,
      sessionStatus: status,
      isAlive: false,
    };

    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== session.id || s.nativeSessionId !== session.nativeSessionId) return s;
        nextSession = {
          ...s,
          activeCli: null,
          sessionStatus: status,
          isAlive: false,
        };
        return nextSession;
      }),
    }));

    return nextSession;
  }, []);

  const replaceNativeSessionForCreate = useCallback((
    session: TabSession,
    status: SessionStatus,
    reason: string,
  ): TabSession => {
    const currentSession = useTerminalStore.getState().sessions.find((s) => s.id === session.id) ?? session;
    const previousNativeSessionId = currentSession.nativeSessionId;
    cancelNativeCreateRetrySchedules(currentSession.id);
    const abandonedCreate = abandonNativeSessionCreate(currentSession.id, previousNativeSessionId);
    if (abandonedCreate) {
      queueNativeSessionReservationRelease(currentSession.id, previousNativeSessionId);
      logInfo('Terminal', `replaceNativeSessionForCreate abandoned in-flight create for ${previousNativeSessionId}`);
    }
    const nextNativeSessionId = makeRetryNativeSessionId(currentSession);
    let nextSession: TabSession = {
      ...currentSession,
      activeCli: null,
      nativeSessionId: nextNativeSessionId,
      sessionStatus: status,
      isAlive: false,
    };

    logInfo(
      'Terminal',
      `replaceNativeSessionForCreate (${reason}): ${previousNativeSessionId} -> ${nextNativeSessionId}`,
    );

    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== currentSession.id) return s;
        nextSession = {
          ...s,
          activeCli: null,
          nativeSessionId: nextNativeSessionId,
          sessionStatus: status,
          isAlive: false,
        };
        return nextSession;
      }),
    }));

    return nextSession;
  }, []);

  const scheduleNativeCreateRetry = useCallback((sessionId: string, nativeSessionId: string, reason: string) => {
    const key = nativeSessionKey(sessionId, nativeSessionId);
    if (nativeSessionRetrySchedules.has(key)) {
      logInfo('Terminal', `native auto-retry already scheduled (${reason}) for ${nativeSessionId}`);
      return;
    }

    nativeSessionRetrySchedules.add(key);
    const scheduledAt = Date.now();
    const runRetry = () => {
      if (!nativeSessionRetrySchedules.has(key)) return;
      const currentSession = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
      if (!currentSession || currentSession.nativeSessionId !== nativeSessionId) {
        nativeSessionRetrySchedules.delete(key);
        return;
      }
      if (currentSession.sessionStatus === 'alive' && currentSession.isAlive) {
        nativeSessionRetrySchedules.delete(key);
        return;
      }
      if (
        currentSession.sessionStatus === 'exited'
        || (currentSession.sessionStatus !== 'starting' && currentSession.sessionStatus !== 'recovering')
      ) {
        nativeSessionRetrySchedules.delete(key);
        return;
      }
      if (isNativeSessionCreateInFlight(currentSession.id)) {
        if (Date.now() - scheduledAt <= NATIVE_SESSION_CREATE_RETRY_MAX_WAIT_MS) {
          setTimeout(runRetry, NATIVE_SESSION_CREATE_RETRY_IN_FLIGHT_POLL_MS);
          return;
        }

        nativeSessionRetrySchedules.delete(key);
        logInfo('Terminal', `native auto-retry abandoned while create stayed in-flight (${reason}) for ${nativeSessionId}`);
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId && session.nativeSessionId === nativeSessionId
              ? { ...session, activeCli: null, sessionStatus: 'exited' as const, isAlive: false }
              : session
          ),
        }));
        return;
      }

      nativeSessionRetrySchedules.delete(key);
      logInfo('Terminal', `native auto-retry running (${reason}) for ${nativeSessionId}`);
      void createNativeSessionRef.current?.(currentSession);
    };
    setTimeout(runRetry, NATIVE_SESSION_CREATE_AUTO_RETRY_DELAY_MS);
  }, []);

  // Create a native session via JNI forkpty (no TCP, no pty-helper)
  const createNativeSession = useCallback(async (session: TabSession) => {
    logInfo('Terminal', 'createNativeSession called for: ' + session.nativeSessionId);
    const storeSession = useTerminalStore.getState().sessions.find((s) => s.id === session.id);
    if (storeSession?.nativeSessionId !== session.nativeSessionId) {
      logInfo('Terminal', 'createNativeSession: stale request ignored for ' + session.nativeSessionId);
      return;
    }
    const attemptId = generateId();
    if (!beginNativeSessionCreate(session.id, session.nativeSessionId, attemptId)) {
      logInfo('Terminal', 'createNativeSession: already in progress for ' + session.nativeSessionId);
      return;
    }
    markNativeSessionCreateStarted(session.id, session.nativeSessionId);

    const isCurrentAttempt = () => (
      isNativeSessionCreateAttemptCurrent(session.id, session.nativeSessionId, attemptId)
    );
    const isStoreSessionCurrent = () => {
      const currentSession = useTerminalStore.getState().sessions.find((s) => s.id === session.id);
      return currentSession?.nativeSessionId === session.nativeSessionId
        && isCurrentAttempt()
        && !didNativeSessionExit(session.id, session.nativeSessionId);
    };
    const destroyIfStale = async (phase: string) => {
      if (isStoreSessionCurrent()) return false;
      logInfo('Terminal', `createNativeSession: stale ${phase} ignored for ${session.nativeSessionId}`);
      const currentOwner = useTerminalStore.getState().sessions.find((s) => s.nativeSessionId === session.nativeSessionId);
      if (currentOwner && currentOwner.id !== session.id) {
        logInfo('Terminal', `createNativeSession: stale ${phase} destroy skipped; ${session.nativeSessionId} belongs to ${currentOwner.id}`);
        return true;
      }
      const wasReservedOrphan = isNativeSessionIdReserved(session.nativeSessionId);
      if (wasReservedOrphan) {
        logInfo('Terminal', `createNativeSession: stale ${phase} destroying reserved orphan ${session.nativeSessionId}`);
      }
      try { await TerminalEmulator.destroySession(session.nativeSessionId); } catch {}
      if (wasReservedOrphan) {
        releaseReservedNativeSessionId(session.nativeSessionId);
      }
      return true;
    };

    const finishCreate = async () => {
      try {
        // Create session via JNI forkpty. If a live session with the same id
        // already exists in the Service-owned registry (Case B — the foreground
        // service kept the forked PTY child alive across app background / RN
        // reload), the native side returns resumed=true and we skip the Case C
        // transcript replay below.
        const createResult = await TerminalEmulator.createSession({
          sessionId: session.nativeSessionId,
          rows: 24,
          cols: 80,
        }) as { resumed?: boolean } | undefined;
        if (await destroyIfStale('create')) return;
        const resumedLive = createResult?.resumed === true;
        if (resumedLive) {
          logInfo('Terminal', 'createNativeSession: resumed live session ' + session.nativeSessionId);
        }

        // Start foreground service to prevent task-kill (may fail if Service class missing)
        try { await TerminalEmulator.startSessionService(); } catch {}
        if (await destroyIfStale('service start')) return;

        // Update session status
        let markedAlive = false;
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== session.id || s.nativeSessionId !== session.nativeSessionId) return s;
            markedAlive = true;
            return {
              ...s,
              activeCli: resumedLive ? s.activeCli : null,
              sessionStatus: 'alive' as const,
              isAlive: true,
            };
          }),
        }));
        if (!markedAlive || await destroyIfStale('alive mark')) return;
        markNativeSessionAlive(session.id, session.nativeSessionId);
        scheduleNativeCreateAutoRetryClear(session.id, session.nativeSessionId);

        // bug #65: Case C fallback — only when the native side did NOT resume a
        // live session (i.e. the process was killed and forked afresh). Replay
        // the previous transcript snapshot into the fresh emulator so the user
        // sees their last-session history on startup. Visual-only; the shell
        // itself is new. When resumedLive is true the real interactive state
        // (vim, agent CLIs, REPLs) is still alive and replay would only
        // double-print history, so we skip it.
        if (!resumedLive && session.transcriptSnapshot && session.transcriptSnapshot.length > 0) {
          try {
            if (await destroyIfStale('transcript replay start')) return;
            const header = '\r\n\x1b[2m── previous session (restored) ──\x1b[0m\r\n';
            const footer = '\r\n\x1b[2m── end of restored history — fresh shell below ──\x1b[0m\r\n';
            // The native emulator consumes bytes via writeToEmulator (no shell involvement)
            await TerminalEmulator.writeToEmulator(session.nativeSessionId, header);
            if (await destroyIfStale('transcript replay header')) return;
            // Normalise newlines to CRLF so the emulator wraps rows correctly
            const normalised = session.transcriptSnapshot.replace(/\r?\n/g, '\r\n');
            await TerminalEmulator.writeToEmulator(session.nativeSessionId, normalised);
            if (await destroyIfStale('transcript replay body')) return;
            await TerminalEmulator.writeToEmulator(session.nativeSessionId, footer);
            if (await destroyIfStale('transcript replay footer')) return;
          } catch (e) {
            logInfo('Terminal', 'transcript replay skipped: ' + String(e));
          }
        }

        // First-launch setup: run CLI install commands directly on the live terminal
        if (await destroyIfStale('first launch setup')) return;
        runFirstLaunchSetup(session.nativeSessionId);
      } catch (err: any) {
        console.error('[Terminal] createNativeSession failed:', err);
        if (!isStoreSessionCurrent()) {
          logInfo('Terminal', 'createNativeSession: stale failure ignored for ' + session.nativeSessionId);
          return;
        }
        if (claimNativeCreateAutoRetry(session.id, session.nativeSessionId, 'create failure')) {
          const retrySession = replaceNativeSessionForCreate(session, 'recovering', 'create failure');
          scheduleNativeCreateRetry(retrySession.id, retrySession.nativeSessionId, 'create failure');
          return;
        }
        if (!isNativeSessionCreateTimedOut(session.id, session.nativeSessionId)) {
          Alert.alert('Terminal Error', String(err?.message || err));
        }
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === session.id && s.nativeSessionId === session.nativeSessionId
              ? { ...s, activeCli: null, sessionStatus: 'exited' as const, isAlive: false }
              : s
          ),
        }));
      } finally {
        endNativeSessionCreate(session.id, session.nativeSessionId, attemptId);
      }
    };

    const createPromise = finishCreate();
    try {
      await withNativeSessionCreateTimeout(createPromise, session.nativeSessionId);
    } catch (err) {
      if (!isNativeSessionCreateTimeout(err)) throw err;
      if (!markNativeSessionCreateTimedOut(session.id, session.nativeSessionId, attemptId)) return;
      logInfo('Terminal', 'createNativeSession timed out for: ' + session.nativeSessionId);
      if (claimNativeCreateAutoRetry(session.id, session.nativeSessionId, 'create timeout')) {
        const retrySession = abandonTimedOutCreate(session);
        const recoveringSession = setNativeSessionLifecycle(retrySession, 'recovering');
        scheduleNativeCreateRetry(recoveringSession.id, recoveringSession.nativeSessionId, 'create timeout');
        return;
      }
      useTerminalStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session.id && s.nativeSessionId === session.nativeSessionId
            ? { ...s, activeCli: null, sessionStatus: 'exited' as const, isAlive: false }
            : s
        ),
      }));
    }
  }, [abandonTimedOutCreate, replaceNativeSessionForCreate, scheduleNativeCreateRetry, setNativeSessionLifecycle]);

  createNativeSessionRef.current = createNativeSession;

  // Recover a session: destroy and re-create
  const recoverSession = useCallback(async (session: TabSession) => {
    const currentSession = useTerminalStore.getState().sessions.find((s) => s.id === session.id) ?? session;
    const previousNativeSessionId = currentSession.nativeSessionId;
    cancelNativeCreateRetrySchedules(currentSession.id);
    if (isNativeSessionCreateInFlight(currentSession.id)) {
      const abandoned = abandonNativeSessionCreate(currentSession.id, previousNativeSessionId);
      if (abandoned) {
        queueNativeSessionReservationRelease(currentSession.id, previousNativeSessionId);
      }
      logInfo('Terminal', `recoverSession: abandoned in-flight create=${abandoned} for ${previousNativeSessionId}`);
    }
    setIsRecovering(true);

    try {
      try { await TerminalEmulator.destroySession(previousNativeSessionId); } catch {}
      const targetSession = replaceNativeSessionForCreate(currentSession, 'recovering', 'manual recover');
      await createNativeSession(targetSession);
    } finally {
      setIsRecovering(false);
    }
  }, [createNativeSession, replaceNativeSessionForCreate]);

  // Reset a session: destroy, clear state, start fresh
  const resetSession = useCallback(async (session: TabSession) => {
    const currentSession = useTerminalStore.getState().sessions.find((s) => s.id === session.id) ?? session;
    const previousNativeSessionId = currentSession.nativeSessionId;
    cancelNativeCreateRetrySchedules(currentSession.id);
    if (isNativeSessionCreateInFlight(currentSession.id)) {
      const abandoned = abandonNativeSessionCreate(currentSession.id, previousNativeSessionId);
      if (abandoned) {
        queueNativeSessionReservationRelease(currentSession.id, previousNativeSessionId);
      }
      logInfo('Terminal', `resetSession: abandoned in-flight create=${abandoned} for ${previousNativeSessionId}`);
    }
    try { await TerminalEmulator.destroySession(previousNativeSessionId); } catch {}

    useTerminalStore.getState().clearSession(currentSession.id);
    const clearedSession = useTerminalStore.getState().sessions.find((s) => s.id === currentSession.id)
      ?? currentSession;
    const targetSession = replaceNativeSessionForCreate(clearedSession, 'starting', 'manual reset');

    await createNativeSession(targetSession);
  }, [createNativeSession, replaceNativeSessionForCreate]);

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
        if (session.sessionStatus === 'starting' || session.sessionStatus === 'alive' || session.sessionStatus === 'recovering') {
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
          logInfo('Terminal', 'ensureNativeSessions: session exited; waiting for explicit reload: ' + session.nativeSessionId);
        }
      }
    } finally {
      sessionMutexRef.current = false;
    }
  }, [createNativeSession]);

  // Run when terminal sessions are mounted or rehydrated. APK installs /
  // process restarts can restore persisted sessions after the first render;
  // running this only once left those restored sessions in "starting" with no
  // native PTY, which rendered as a blank terminal with no prompt.
  useEffect(() => {
    void ensureNativeSessions();
  }, [ensureNativeSessions, sessionsEnsureKey]);

  // Run on foreground resume — handles app switch, home button, split view toggle
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearResumeTimer = () => {
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        ensureNativeSessions();
        clearResumeTimer();
        // Force redraw terminal content after app resume
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          const tag = findNodeHandle(terminalViewRef.current);
          if (tag) {
            TerminalViewModule.refreshScreen(tag).catch(() => undefined);
          }
          if (shouldRestoreTerminalFocus()) {
            focusTerminalViewNow();
          }
        }, 200);
      }
    });
    return () => {
      clearResumeTimer();
      sub.remove();
    };
  }, [ensureNativeSessions, focusTerminalViewNow, shouldRestoreTerminalFocus]);

  // bug #112: focus recovery after Modal dismiss. Closing LayoutAddSheet,
  // ConfigTUI, CommandPalette, or any other Modal leaves the Activity's
  // window focus unset on Android edge-to-edge (dumpsys window shows
  // `mCurrentFocus=null`). The soft keyboard stays visible but no view
  // receives commitText, so the user has to tap the terminal before
  // typing works again. The focus-store counter is incremented by each
  // Modal's close handler; we observe it here and call the native
  // TerminalView.focus(tag) helper which does requestFocus +
  // showSoftInput and restores typing without the stray tap.
  useEffect(() => {
    if (refocusTick === 0) return; // initial mount, nothing to do
    if (isHiddenBehindMultiPane) return;
    if (paneId && focusedPaneId !== paneId) return;
    return scheduleTerminalFocus();
  }, [focusedPaneId, isHiddenBehindMultiPane, paneId, refocusTick, scheduleTerminalFocus]);

  // bug #116: Per-pane focus follow. When the user taps another terminal
  // pane, `PaneSlot.onTouchStart` -> `handleFocusPane` updates
  // `usePaneStore.focusedPaneId`, and every mounted TerminalPane observes
  // whether it just became the focused one. If so, move the native view
  // focus so keyboard input lands here instead of the previously-focused
  // pane. The `refocusTick` effect above covers modal-dismiss recovery
  // (global bump); this effect covers inter-pane switching (per-pane edge).
  useEffect(() => {
    if (!paneId) return;
    if (isHiddenBehindMultiPane) return;
    if (focusedPaneId !== paneId) return;
    return scheduleTerminalFocus();
  }, [focusedPaneId, isHiddenBehindMultiPane, paneId, scheduleTerminalFocus]);

  // Native TerminalView can mount before Android's hidden IME host is ready,
  // especially after session recovery, background resume, or pane re-layout.
  // Re-focus after the visible native session reaches connected so commitText
  // is routed to the current terminal, not a stale host target.
  useEffect(() => {
    if (!shouldRestoreTerminalFocus()) return;
    return scheduleTerminalFocus();
  }, [scheduleTerminalFocus, shouldRestoreTerminalFocus]);

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
    const sub = TerminalEmulator.addListener('onSessionExit', (event: { sessionId: string; exitCode: number; signal?: number }) => {
      const exitedSession = useTerminalStore.getState().sessions.find((session) => (
        session.nativeSessionId === event.sessionId
      ));
      if (exitedSession) {
        markNativeSessionExited(exitedSession.id, exitedSession.nativeSessionId);
      }
      const retryEarlyExit = exitedSession
        ? shouldAutoRetryEarlyExit(exitedSession, event.exitCode, event.signal)
        : false;

      const retrySession = retryEarlyExit && exitedSession
        ? replaceNativeSessionForCreate(exitedSession, 'recovering', 'early exit')
        : null;
      if (!retrySession) {
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.nativeSessionId === event.sessionId
              ? {
                  ...session,
                  activeCli: null,
                  sessionStatus: 'exited' as const,
                  isAlive: false,
                }
              : session
          ),
        }));
      }
      if (retryEarlyExit && exitedSession) {
        scheduleNativeCreateRetry(
          retrySession?.id ?? exitedSession.id,
          retrySession?.nativeSessionId ?? exitedSession.nativeSessionId,
          'early exit',
        );
      }

      if (isProcessKill(event.signal ?? 0, event.exitCode)) {
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
  }, [checkBatteryExemption, replaceNativeSessionForCreate, scheduleNativeCreateRetry]);

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
    if (activeSession.sessionStatus !== 'alive' || !activeSession.isAlive) return;

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
    markNativeSessionUserActivity(activeSession.id, target);
    const body = command.replace(/(?:\r\n|\r|\n)+$/, '');
    const trailing = command.slice(body.length);
    const trailingEnter = trailing.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    const writePromise = (async () => {
      if (body) {
        await TerminalEmulator.pasteToSession(target, body);
      }
      if (trailingEnter) {
        await TerminalEmulator.writeToSession(target, trailingEnter);
      }
    })();
    writePromise
      .then(() => {
        useTerminalStore.getState().clearPendingCommand(pendingId);
      })
      .catch((err) => {
        console.warn('[Terminal] pendingCommand pasteToSession failed:', err);
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === activeSession.id
              ? {
                  ...session,
                  activeCli: null,
                  sessionStatus: 'exited' as const,
                  isAlive: false,
                }
              : session
          ),
        }));
      });
  }, [
    pendingCommand,
    activeSession?.id,
    activeSession?.nativeSessionId,
    activeSession?.sessionStatus,
    activeSession?.isAlive,
  ]);

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
  const terminalPaneBg = terminalColorScheme.background;

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
  const terminalKeyboardInset = Platform.OS === 'android' && !isRenderedInMultiPane ? keyboardHeight : 0;
  const terminalBottomInset = (isConnected ? KEY_BAR_HEIGHT + 10 : 10) + terminalKeyboardInset;

  // Send text to terminal via native PTY
  const sendToTerminal = useCallback((text: string) => {
    if (!activeNativeSessionId || !text) return;
    if (activeSessionRecordId) {
      markNativeSessionUserActivity(activeSessionRecordId, activeNativeSessionId);
    }
    TerminalEmulator.writeToSession(activeNativeSessionId, text).catch((err) => {
      console.warn('[Terminal] writeToSession failed:', err);
    });
  }, [activeNativeSessionId, activeSessionRecordId]);

  // bug #81: Paste path for clipboard contents. Goes through the emulator's
  // paste() which normalizes CR/LF and wraps the payload in bracketed-paste
  // markers, so bash/zsh treat the whole chunk as a single paste event. The
  // raw write path clipped the first byte of multi-line clipboard payloads
  // because bash's prompt echo raced the PTY write.
  const pasteToTerminal = useCallback((text: string) => {
    if (!activeNativeSessionId || !text) return;
    if (activeSessionRecordId) {
      markNativeSessionUserActivity(activeSessionRecordId, activeNativeSessionId);
    }
    TerminalEmulator.pasteToSession(activeNativeSessionId, text).catch((err) => {
      console.warn('[Terminal] pasteToSession failed:', err);
    });
  }, [activeNativeSessionId, activeSessionRecordId]);

  const pasteClipboardToTerminal = useCallback(() => {
    if (!activeNativeSessionId) return;
    if (activeSessionRecordId) {
      markNativeSessionUserActivity(activeSessionRecordId, activeNativeSessionId);
    }
    return TerminalEmulator.pasteClipboardToSession(activeNativeSessionId).catch((err) => {
      console.warn('[Terminal] pasteClipboardToSession failed:', err);
      throw err;
    });
  }, [activeNativeSessionId, activeSessionRecordId]);

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
    if (activeSessionRecordId) {
      markNativeSessionUserActivity(activeSessionRecordId, activeNativeSessionId);
    }
    TerminalEmulator.writeToSession(activeNativeSessionId, keyCode).catch((err) => {
      console.warn('[Terminal] sendKey failed:', err);
    });
  }, [activeNativeSessionId, activeSessionRecordId]);

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
        <View
          style={[
            styles.terminalBody,
            {
              flexDirection: showSplitPreview ? 'row' : 'column',
              paddingBottom: terminalBottomInset,
            },
          ]}
        >
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
              if (activeSessionRecordId && activeNativeSessionId) {
                markNativeSessionUserActivity(activeSessionRecordId, activeNativeSessionId);
              }
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
                      const autonomous = agentResult.data?.autonomous === true;
                      const agent = createAgent({
                        name,
                        description: promptText.slice(0, 120),
                        prompt: promptText,
                        schedule: null,
                        tool: suggestion.tool,
                        autonomous,
                        outputPath: `~/.shelly/agents/${name}/output`,
                      });
                      await installAgent(agent, async (cmd) => {
                        const result = await execCommand(cmd, 120_000);
                        if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
                        return result.stdout;
                      });
                      resultMessage = `✅ Agent "${agent.name}" installed (${suggestion.label}${autonomous ? ', autonomous' : ''}). Run it with: @agent run ${agent.name}`;
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
            {t('terminal.connecting_terminal')}
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
        <View style={[styles.keyBarDock, { bottom: terminalKeyboardInset }]} pointerEvents="box-none">
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
          style={[styles.scrollToBottomFab, { bottom: 120 + terminalKeyboardInset }]}
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
  // Terminal panes intentionally stay opaque even when the app wallpaper is
  // enabled. Transparent terminal backgrounds expose panel/wallpaper blends
  // during Android IME resize and can leave gray washes behind empty cells.
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
