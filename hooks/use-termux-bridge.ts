/**
 * useTermuxBridge  — v1.4
 *
 * Manages the WebSocket connection to the Termux bridge server.
 *
 * Changes in v1.4:
 *  - Auto-recovery via TermuxBridge native module when reconnect exhausted
 *  - Attempts to restart bridge+tmux via start-shelly.sh before showing manual banner
 *  - Session resume: tracks activeCliSession for claude --continue after recovery
 *
 * Changes in v1.3:
 *  - cancelCurrent() now sends cancel message AND immediately marks block as 'cancelling'
 *  - Handles new 'cancelled' server message to confirm cancellation
 *  - Foreground resume triggers reconnect (via AppState)
 *  - Battery-friendly retry: max 5 attempts with exponential back-off (cap 30s)
 *  - Reconnect only when connectionMode === 'termux' AND autoReconnect is ON
 *  - Cancel timeout fallback: if no 'cancelled' response in 5s, force-finalize locally
 *
 * Protocol (JSON over WebSocket):
 *
 * Client → Server:
 *   { type: "run",    requestId: string, command: string }
 *   { type: "stdin",  requestId: string, data: string }
 *   { type: "cancel", requestId: string }
 *   { type: "ping" }
 *
 * Server → Client:
 *   { type: "stdout",    requestId: string, data: string }
 *   { type: "stderr",    requestId: string, data: string }
 *   { type: "exit",      requestId: string, code: number, cwd?: string, cancelled?: boolean }
 *   { type: "cancelled", requestId: string, code: 130 }
 *   { type: "error",     requestId: string, message: string }
 *   { type: "pong" }
 *   { type: "ready" }
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState, AppStateStatus, Linking } from 'react-native';

import { useTerminalStore, _pendingTmuxKills, _pendingTmuxClears } from '@/store/terminal-store';
import { notifyCommandComplete } from '@/lib/command-notifier';
import { runTermuxCommand } from '@/lib/termux-intent';
import { sendKeysToSession, killSession as killTmuxSession } from '@/lib/tmux-manager';
import { t } from '@/lib/i18n';

/** コマンド文字列からCLI種別を検出する */
function detectCli(command: string): 'claude' | 'gemini' | 'codex' | 'cody' | null {
  const trimmed = command.trim();
  if (/^claude(\s|$)/.test(trimmed)) return 'claude';
  if (/^gemini(\s|$)/.test(trimmed)) return 'gemini';
  if (/^codex(\s|$)/.test(trimmed)) return 'codex';
  if (/^cody(\s|$)/.test(trimmed)) return 'cody';
  return null;
}

/** Generate a collision-resistant request ID */
function genRequestId(prefix: string): string {
  try {
    // crypto.randomUUID() available in newer Hermes / JSC
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
  } catch { /* fallback below */ }
  // Fallback: timestamp + 9-char random (36^9 ≈ 1e14 combinations)
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

type QueueItem = {
  requestId: string;
  command: string;
  blockId: string;
};

type ServerMessage =
  | { type: 'stdout';         requestId: string; data: string }
  | { type: 'stderr';         requestId: string; data: string }
  | { type: 'exit';           requestId: string; code: number; cwd?: string; cancelled?: boolean }
  | { type: 'cancelled';      requestId: string; code: number }
  | { type: 'error';          requestId: string; message: string }
  | { type: 'pong';          requestId?: string }
  | { type: 'ready';         requestId?: string }
  | { type: 'projectCreated'; requestId: string; projectPath: string; filesWritten: number }
  | { type: 'fileWritten';    requestId: string; filePath: string }
  | { type: 'progress';       requestId: string; message: string; current: number; total: number }
  | { type: 'fileRead';       requestId: string; filePath: string; content: string; size: number }
  | { type: 'fileList';       requestId: string; dirPath: string; entries: FileEntry[]; total: number }
  | { type: 'fileEdited';     requestId: string; filePath: string; editsApplied: number };

export type ProjectFileSpec = { path: string; content: string };

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type ReadFileResult =
  | { ok: true; content: string; filePath: string; size: number }
  | { ok: false; error: string };

export type ListFilesResult =
  | { ok: true; entries: FileEntry[]; dirPath: string; total: number }
  | { ok: false; error: string };

export type EditFileEdit = { oldText: string; newText: string };

export type EditFileResult =
  | { ok: true; filePath: string; editsApplied: number }
  | { ok: false; error: string };

export type CreateProjectResult =
  | { ok: true;  projectPath: string; filesWritten: number }
  | { ok: false; error: string };

const MAX_RECONNECT = 5;
const CANCEL_TIMEOUT_MS = 5000; // force-finalize if no 'cancelled' response in 5s
const AUTO_RECOVERY_BASE_INTERVAL = 3000; // exponential backoff base (3s, 6s, 12s)
const AUTO_RECOVERY_MAX_POLLS = 4; // 4 attempts max (省バッテリー: 10→4)

export function useTermuxBridge() {
  const {
    connectionMode,
    bridgeStatus,
    termuxSettings,
    setBridgeStatus,
    setConnectionMode,
    startTermuxBlock,
    appendOutputToBlock,
    appendOutputBatch,
    finalizeBlock,
    errorBlock,
    markBlockCancelling,
    cancelBlock,
  } = useTerminalStore();

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const activeItemRef = useRef<QueueItem | null>(null);
  const blockStartTimeRef = useRef<Record<string, number>>({});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const cancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>('active');
  const [isReconnectExhausted, setIsReconnectExhausted] = useState(false);
  const [isAutoRecovering, setIsAutoRecovering] = useState(false);
  const [autoRecoveryFailed, setAutoRecoveryFailed] = useState(false);
  const autoRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveredFromCrashRef = useRef(false);
  const isAutoRecoveringRef = useRef(false); // ref mirror to avoid stale closure

  // ── Request-specific message handlers (EventEmitter pattern) ─────────────
  const requestHandlersRef = useRef<Map<string, (msg: ServerMessage) => void>>(new Map());

  // ── Output batching (50ms flush) ──────────────────────────────────────────
  const pendingLinesRef = useRef<Map<string, { text: string; type: 'stdout' | 'stderr' }[]>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingLines = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingLinesRef.current;
    if (pending.size === 0) return;
    for (const [blockId, lines] of pending) {
      if (lines.length === 1) {
        appendOutputToBlock(blockId, lines[0]);
      } else {
        appendOutputBatch(blockId, lines);
      }
    }
    pending.clear();
  }, [appendOutputToBlock, appendOutputBatch]);

  const bufferLine = useCallback((blockId: string, line: { text: string; type: 'stdout' | 'stderr' }) => {
    const buf = pendingLinesRef.current.get(blockId) ?? [];
    buf.push(line);
    pendingLinesRef.current.set(blockId, buf);
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushPendingLines, 50);
    }
  }, [flushPendingLines]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(() => {
    const { wsUrl, timeoutSeconds } = useTerminalStore.getState().termuxSettings;

    // Close existing connection cleanly
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      try { wsRef.current.close(); } catch (_) {}
      wsRef.current = null;
    }

    setBridgeStatus('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setBridgeStatus('error');
      return;
    }
    wsRef.current = ws;

    // Connection timeout
    const connTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch (_) {}
        setBridgeStatus('error');
        handleAutoFallback();
      }
    }, timeoutSeconds * 1000);

    ws.onopen = () => {
      clearTimeout(connTimeout);
      reconnectAttemptsRef.current = 0;
      setIsReconnectExhausted(false);
      setBridgeStatus('connected');
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onerror = () => {
      clearTimeout(connTimeout);
      setBridgeStatus('error');
    };

    ws.onclose = () => {
      clearTimeout(connTimeout);
      // Ignore close events from stale WebSockets (replaced by a newer connect() call)
      if (wsRef.current !== ws) return;
      setBridgeStatus('disconnected');

      // Flush buffered output and clear request handlers
      flushPendingLines();
      requestHandlersRef.current.clear();

      // Fail any active block
      if (activeItemRef.current) {
        errorBlock(activeItemRef.current.blockId, t('bridge.ws_disconnected'));
        activeItemRef.current = null;
      }
      clearCancelTimeout();

      handleAutoFallback();
      // Don't trigger reconnect cascade during auto-recovery — poll() manages its own connect()
      if (!isAutoRecoveringRef.current) {
        scheduleReconnect();
      }
    };
  }, []);

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    clearReconnectTimer();
    clearCancelTimeout();
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    pendingLinesRef.current.clear();
    requestHandlersRef.current.clear();
    reconnectAttemptsRef.current = MAX_RECONNECT; // prevent auto-reconnect
    if (wsRef.current) {
      wsRef.current.onclose = null;
      try { wsRef.current.close(); } catch (_) {}
      wsRef.current = null;
    }
    setBridgeStatus('disconnected');
  }, []);

  // ── Auto-fallback ──────────────────────────────────────────────────────────

  const handleAutoFallback = useCallback(() => {
    // autoFallbackは廃止された。接続失敗時は自動再接続のみ行う。
    // (Localmoード廃止に伴い、disconnectedへの自動フォールバックは不要)
  }, []);

  // ── Auto-reconnect (battery-friendly) ─────────────────────────────────────

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const scheduleReconnect = useCallback(() => {
    const { autoReconnect } = useTerminalStore.getState().termuxSettings;
    const { connectionMode: mode } = useTerminalStore.getState();

    // Battery guard: only reconnect when in foreground, mode is termux, autoReconnect is on
    if (!autoReconnect || mode !== 'termux') return;
    // Don't interfere with auto-recovery — it manages its own connect() calls
    if (isAutoRecoveringRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT) {
      // Prevent multiple scheduleReconnect calls from each triggering attemptAutoRecovery
      reconnectAttemptsRef.current = MAX_RECONNECT + 1;
      attemptAutoRecovery();
      return;
    }
    if (appStateRef.current !== 'active') return; // don't reconnect in background

    // Exponential back-off: 1s, 2s, 4s, 8s, 16s (capped at 30s)
    const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30000);
    reconnectAttemptsRef.current += 1;

    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      const currentMode = useTerminalStore.getState().connectionMode;
      if (currentMode === 'termux') {
        connect();
      }
    }, delay);
  }, [connect]);

  // ── Auto-recovery via Native Module ─────────────────────────────────────────

  const clearAutoRecoveryTimer = () => {
    if (autoRecoveryTimerRef.current) {
      clearTimeout(autoRecoveryTimerRef.current);
      autoRecoveryTimerRef.current = null;
    }
  };

  const attemptAutoRecovery = useCallback(async () => {
    // Prevent double-triggering (use ref to avoid stale closure)
    if (isAutoRecoveringRef.current) return;
    isAutoRecoveringRef.current = true;

    // Cancel any pending reconnect timers to prevent interference
    clearReconnectTimer();
    clearAutoRecoveryTimer();

    setIsAutoRecovering(true);
    setAutoRecoveryFailed(false);
    setIsReconnectExhausted(false);

    // Remember if there was an active CLI session before crash
    const { activeCliSession } = useTerminalStore.getState();
    if (activeCliSession) {
      recoveredFromCrashRef.current = true;
    }

    // Step 1: Restart Termux services via Native Module
    // Use absolute paths — RunCommandService doesn't source .bashrc so PATH may be bare
    const PREFIX = '/data/data/com.termux/files/usr';
    const HOME = '/data/data/com.termux/files/home';
    // ONLY restart the bridge (Node.js WebSocket server).
    // pty-helper processes are managed by ensureNativeSessions() in terminal.tsx
    // to avoid race conditions (start-shelly.sh's pkill would kill pty-helpers
    // that ensureNativeSessions just started).
    const startCmd = [
      `export PATH=${PREFIX}/bin:$PATH; `,
      `export HOME=${HOME}; `,
      `export TERM=xterm-256color; `,
      // Kill old bridge only (NOT pty-helper — ensureNativeSessions handles that)
      `pkill -f "node.*shelly-bridge/server.js" 2>/dev/null; `,
      `sleep 1; `,
      // Start bridge
      `cd ${HOME}/shelly-bridge && nohup ${PREFIX}/bin/node server.js > /dev/null 2>&1 & `,
    ].join('');

    // Recovery cascade — try multiple strategies since RunCommandService
    // is silently blocked on Android 14 Samsung (RARE standby bucket)
    const TermuxBridgeModule = require('../modules/termux-bridge').default;

    // Strategy 1: RunCommandService via context.startService()
    console.log('[AutoRecovery] Strategy 1: RunCommandService...');
    await runTermuxCommand({ command: startCmd, background: true });

    // Strategy 2: am startservice via Runtime.exec() (bypasses standby restriction)
    console.log('[AutoRecovery] Strategy 2: am startservice via shell...');
    let strategy2Success = false;
    try {
      const directResult = await TermuxBridgeModule.startBridgeDirect();
      console.log('[AutoRecovery] startBridgeDirect result:', JSON.stringify(directResult));
      strategy2Success = directResult?.success === true;
    } catch (e) {
      console.log('[AutoRecovery] startBridgeDirect failed:', e);
    }

    // Strategy 3: Launch Termux Activity — ONLY if Strategy 2 failed.
    // Activity launch causes a disruptive screen switch to Termux and back.
    if (!strategy2Success) {
      console.log('[AutoRecovery] Strategy 3: Launch Termux Activity (fallback)...');
      try {
        await TermuxBridgeModule.launchTermux();
      } catch {
        try { await Linking.openURL('com.termux://'); } catch {}
      }
    }

    // Step 2: Poll for bridge to come back online
    let pollCount = 0;
    const poll = () => {
      pollCount++;
      if (pollCount > AUTO_RECOVERY_MAX_POLLS) {
        // Recovery round timed out — retry auto-recovery after a pause
        // (ゼロ状態ユーザーに「手動で再起動」は求めない)
        // Keep isAutoRecoveringRef.current = true to block scheduleReconnect
        // from stale onclose events during the cooldown window.
        // Only the UI state is cleared so the banner can update.
        setIsAutoRecovering(false);
        autoRecoveryTimerRef.current = setTimeout(() => {
          reconnectAttemptsRef.current = 0;
          // ref is still true — attemptAutoRecovery() will see it and skip,
          // so we must reset it right before calling.
          isAutoRecoveringRef.current = false;
          attemptAutoRecovery();
        }, 10_000); // 10秒後にもう一度自動復旧を試行
        return;
      }

      // Reset counter and try connecting
      reconnectAttemptsRef.current = 0;
      connect();

      // Check if connected after a short delay
      autoRecoveryTimerRef.current = setTimeout(async () => {
        const { bridgeStatus: currentStatus } = useTerminalStore.getState();
        if (currentStatus === 'connected') {
          // Recovery succeeded!
          setIsAutoRecovering(false);
          isAutoRecoveringRef.current = false;
          setAutoRecoveryFailed(false);
          setIsReconnectExhausted(false);

          // pty-helper sessions are recovered by ensureNativeSessions() in terminal.tsx
          // (triggered by bridgeStatus → 'connected' effect). No tmux Layer 2 needed.
          return;
        }
        // Not connected yet, keep polling with exponential backoff
        poll();
      }, AUTO_RECOVERY_BASE_INTERVAL * Math.pow(2, pollCount - 1));
    };

    // Wait 7s for Termux Activity launch → .bashrc → bridge startup, then begin polling
    autoRecoveryTimerRef.current = setTimeout(poll, 7000);
  }, [connect]);

  // ── Cancel timeout helper ──────────────────────────────────────────────────

  const clearCancelTimeout = () => {
    if (cancelTimeoutRef.current) {
      clearTimeout(cancelTimeoutRef.current);
      cancelTimeoutRef.current = null;
    }
  };

  // ── Message handler ────────────────────────────────────────────────────────

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'pong' || msg.type === 'ready') return;

    // Dispatch to request-specific handlers (createProject, writeFile, runCommand, runRawCommand)
    if ('requestId' in msg && msg.requestId) {
      const handler = requestHandlersRef.current.get(msg.requestId);
      if (handler) handler(msg);
    }

    const active = activeItemRef.current;
    if (!active) return;
    if ('requestId' in msg && msg.requestId !== active.requestId) return;

    switch (msg.type) {
      case 'stdout':
        bufferLine(active.blockId, { text: msg.data, type: 'stdout' });
        break;

      case 'stderr':
        bufferLine(active.blockId, { text: msg.data, type: 'stderr' });
        break;

      case 'cancelled': {
        // Flush any buffered output before finalizing
        flushPendingLines();
        clearCancelTimeout();
        cancelBlock(active.blockId);
        activeItemRef.current = null;
        processQueue();
        break;
      }

      case 'exit': {
        // Flush any buffered output before finalizing
        flushPendingLines();
        clearCancelTimeout();
        if (msg.cancelled) {
          // exit with cancelled flag (backward compat)
          cancelBlock(active.blockId);
        } else {
          finalizeBlock(active.blockId, msg.code, msg.cwd);
          // Notify if long-running command completed
          const startTime = blockStartTimeRef.current[active.blockId];
          if (startTime) {
            const duration = Date.now() - startTime;
            notifyCommandComplete(active.command, msg.code, duration);
            delete blockStartTimeRef.current[active.blockId];
          }
          // Clear activeCli when the CLI process exits
          const { sessions: exitSessions, activeSessionId: exitActiveId } = useTerminalStore.getState();
          const exitSession = exitSessions.find((s) => s.id === exitActiveId);
          if (exitSession?.activeCli && active.command.trim().startsWith(exitSession.activeCli)) {
            useTerminalStore.getState().setActiveCli(null);
          }
        }
        activeItemRef.current = null;
        processQueue();
        break;
      }

      case 'error': {
        // Flush any buffered output before finalizing
        flushPendingLines();
        clearCancelTimeout();
        errorBlock(active.blockId, msg.message);
        activeItemRef.current = null;
        processQueue();
        break;
      }
    }
  }, [bufferLine, flushPendingLines, finalizeBlock, errorBlock, cancelBlock]);

  // ── Queue processing ───────────────────────────────────────────────────────

  const processQueue = useCallback(() => {
    // Clean up tmux sessions for removed tabs
    while (_pendingTmuxKills.length > 0) {
      const name = _pendingTmuxKills.shift()!;
      killTmuxSession(name, runRawCommand);
    }
    // Clear tmux scrollback for reset sessions
    while (_pendingTmuxClears.length > 0) {
      const name = _pendingTmuxClears.shift()!;
      sendKeysToSession(name, 'clear', runRawCommand);
      // Also clear tmux scrollback history
      runRawCommand(
        `tmux clear-history -t "${name}" 2>/dev/null`,
        { timeoutMs: 3000, reason: 'tmux-clear-history' },
      ).catch(() => {});
    }

    if (activeItemRef.current) return; // busy
    if (queueRef.current.length === 0) return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const item = queueRef.current.shift()!;
    activeItemRef.current = item;

    ws.send(JSON.stringify({
      type: 'run',
      requestId: item.requestId,
      command: item.command,
    }));
  }, []);

  // ── Public: send command ───────────────────────────────────────────────────

  const sendCommand = useCallback((command: string) => {
    const blockId = startTermuxBlock(command);
    const requestId = genRequestId('req');

    blockStartTimeRef.current[blockId] = Date.now();
    queueRef.current.push({ requestId, command, blockId });

    // Detect CLI launch and track for recovery
    const cli = detectCli(command);
    if (cli) {
      useTerminalStore.getState().setActiveCli(cli);
    }

    processQueue();

    return blockId;
  }, [startTermuxBlock, processQueue]);

  // ── Public: send stdin to active process ─────────────────────────────────

  const sendStdin = useCallback((data: string) => {
    const active = activeItemRef.current;
    if (!active) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stdin', requestId: active.requestId, data }));
  }, []);

  // ── Public: cancel current ─────────────────────────────────────────────────

  const cancelCurrent = useCallback(() => {
    const active = activeItemRef.current;
    if (!active) return;

    // Immediately update UI to 'cancelling' state
    markBlockCancelling(active.blockId);

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send cancel to server
      ws.send(JSON.stringify({ type: 'cancel', requestId: active.requestId }));

      // Safety timeout: if server doesn't respond in 5s, force-finalize locally
      clearCancelTimeout();
      cancelTimeoutRef.current = setTimeout(() => {
        const stillActive = activeItemRef.current;
        if (stillActive && stillActive.requestId === active.requestId) {
          // Force-finalize: server may be unresponsive
          cancelBlock(stillActive.blockId);
          activeItemRef.current = null;
          processQueue();
        }
      }, CANCEL_TIMEOUT_MS);
    } else {
      // WebSocket not available — cancel locally
      cancelBlock(active.blockId);
      activeItemRef.current = null;
      processQueue();
    }
  }, [markBlockCancelling, cancelBlock, processQueue]);

  // ── Public: test connection ────────────────────────────────────────────────

  const testConnection = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const { wsUrl, timeoutSeconds } = useTerminalStore.getState().termuxSettings;
      let testWs: WebSocket;
      try {
        testWs = new WebSocket(wsUrl);
      } catch {
        resolve(false);
        return;
      }

      const timer = setTimeout(() => {
        try { testWs.close(); } catch (_) {}
        resolve(false);
      }, Math.min(timeoutSeconds * 1000, 5000));

      testWs.onopen = () => {
        clearTimeout(timer);
        // Send ping and wait for pong
        testWs.send(JSON.stringify({ type: 'ping' }));
      };

      testWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'pong' || msg.type === 'ready') {
            clearTimeout(timer);
            try { testWs.close(); } catch (_) {}
            resolve(true);
          }
        } catch (_) {}
      };

      testWs.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }, []);

  // ── Effect: connect/disconnect based on mode ───────────────────────────────

  useEffect(() => {
    if (connectionMode === 'termux') {
      reconnectAttemptsRef.current = 0;
      connect();
    } else {
      disconnect();
    }
    return () => {
      clearReconnectTimer();
      clearCancelTimeout();
      clearAutoRecoveryTimer();
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    };
  }, [connectionMode]);

  // ── Effect: process queue when status becomes connected ────────────────────

  useEffect(() => {
    if (bridgeStatus === 'connected') {
      processQueue();
    }
  }, [bridgeStatus]);

  // ── Effect: AppState — reconnect on foreground resume ─────────────────────

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prevState !== 'active') {
        // App came to foreground
        const { connectionMode: mode, bridgeStatus: status } = useTerminalStore.getState();
        const { autoReconnect } = useTerminalStore.getState().termuxSettings;

        if (
          mode === 'termux' &&
          autoReconnect &&
          (status === 'disconnected' || status === 'error') &&
          reconnectAttemptsRef.current < MAX_RECONNECT
        ) {
          // Reset counter on foreground resume so user gets a fresh set of retries
          reconnectAttemptsRef.current = 0;
          connect();
        }
      }
    });

    return () => subscription.remove();
  }, [connect]);

  // ── Public: createProject ──────────────────────────────────────────────────────

  const createProject = useCallback(
    (projectPath: string, files: ProjectFileSpec[], onProgress?: (msg: string, current: number, total: number) => void): Promise<CreateProjectResult> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'Termuxに接続されていません。' });
          return;
        }

        const requestId = genRequestId('cp');
        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: 'ファイル生成がタイムアウトしたよ。' });
        }, 60000);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'progress') {
            onProgress?.(msg.message, msg.current, msg.total);
          } else if (msg.type === 'projectCreated') {
            clearTimeout(timer);
            cleanup();
            resolve({ ok: true, projectPath: msg.projectPath, filesWritten: msg.filesWritten });
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            cleanup();
            resolve({ ok: false, error: msg.message });
          }
        });

        ws.send(JSON.stringify({ type: 'createProject', requestId, projectPath, files }));
      });
    },
    []
  );

  // ── Public: writeFile ───────────────────────────────────────────────────────

  const writeFile = useCallback(
    (filePath: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'Termuxに接続されていません。' });
          return;
        }

        const requestId = genRequestId('wf');
        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: 'ファイル書き込みがタイムアウトしたよ。' });
        }, 10000);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'fileWritten') {
            clearTimeout(timer); cleanup();
            resolve({ ok: true });
          } else if (msg.type === 'error') {
            clearTimeout(timer); cleanup();
            resolve({ ok: false, error: msg.message });
          }
        });

        ws.send(JSON.stringify({ type: 'writeFile', requestId, filePath, content, encoding }));
      });
    },
    []
  );

   // ── Public: runCommand (exec — Tools mode, allowlist-gated) ────────────────────

  /**
   * runCommand — Toolsモード用実行関数 (v2.4.2)
   *
   * 「 exec 」メッセージを送信し、stdout/stderr/exitをストリーミングで受け取る。
   * - Termux未接続時は即座にエラーを返す（フォールバック案内済み）
   * - Termuxパス直打き（/data/data/com.termux/...）は一切行わない
   * - allowlist外のコマンドはTermux側でブロックされる
   *
   * @param cmd 実行コマンド（バイナリ名はallowlist内のもののみ）
   * @param opts.cwd 作業ディレクトリ（省略時は現在のcwd）
   * @param opts.env 追加環境変数（APIKey等）— Termux側ログにはキー名のみ表示
   * @param opts.onStream ストリーミングコールバック（BuildLaneのリアルタイム表示用）
   * @param opts.timeoutMs タイムアウトms（デフォルト: 120秒）
   */
  const runCommand = useCallback(
    (
      cmd: string,
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        onStream?: (type: 'stdout' | 'stderr', data: string) => void;
        timeoutMs?: number;
      }
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({
            stdout: '',
            stderr: 'Termux Bridgeに接続されていません。SettingsでWebSocket URLを設定し、TermuxでBridgeを起動してください。',
            exitCode: 1,
          });
          return;
        }

        const requestId = genRequestId('exec');
        const timeoutMs = opts?.timeoutMs ?? 120_000;
        const MAX_BUF = 1_048_576; // 1MB buffer limit
        let stdoutBuf = '';
        let stderrBuf = '';

        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({
            stdout: stdoutBuf,
            stderr: stderrBuf + '\n[タイムアウト]コマンドが時間内に完了しませんでした。',
            exitCode: 124,
          });
        }, timeoutMs);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'stdout') {
            if (stdoutBuf.length < MAX_BUF) stdoutBuf += msg.data;
            opts?.onStream?.('stdout', msg.data);
          } else if (msg.type === 'stderr') {
            if (stderrBuf.length < MAX_BUF) stderrBuf += msg.data;
            opts?.onStream?.('stderr', msg.data);
          } else if (msg.type === 'exit') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: msg.code });
          } else if (msg.type === 'cancelled') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: 130 });
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf + '\n' + msg.message, exitCode: 1 });
          }
        });

        ws.send(JSON.stringify({
          type: 'exec',
          requestId,
          cmd,
          cwd: opts?.cwd,
          env: opts?.env,
        }));
      });
    },
    []
  );

  // ── Public: openFolder ───────────────────────────────────────────────────

  const openFolder = useCallback(
    (folderPath: string): void => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const requestId = genRequestId('of');
      ws.send(JSON.stringify({ type: 'openFolder', requestId, folderPath }));
    },
    []
  );

  /**
   * runRawCommand — allowlist不要の生コマンド実行（セットアップ用）
   *
   * @internal セットアップ操作専用。AI生成コマンドを渡さないこと。
   * ⚠️ セキュリティ注意: 'run' メッセージを使用するため allowlist 制限なし。
   * llama.cpp セットアップ・モデルダウンロード等、セットアップ操作専用。
   * AI生成コマンドを直接渡さないこと（prompt injection リスク）。
   */
  const runRawCommand = useCallback(
    (
      cmd: string,
      opts?: {
        onStream?: (type: 'stdout' | 'stderr', data: string) => void;
        timeoutMs?: number;
        reason?: string;
      }
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({
            stdout: '',
            stderr: 'Termux Bridgeに接続されていません。',
            exitCode: 1,
          });
          return;
        }

        console.warn(`[Security] runRawCommand invoked (no allowlist) reason=${opts?.reason ?? 'unspecified'}:`, cmd.slice(0, 80));

        const requestId = genRequestId('raw');
        const timeoutMs = opts?.timeoutMs ?? 1_200_000;
        const MAX_BUF = 1_048_576; // 1MB buffer limit
        let stdoutBuf = '';
        let stderrBuf = '';

        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({
            stdout: stdoutBuf,
            stderr: stderrBuf + '\n[タイムアウト]コマンドが時間内に完了しませんでした。',
            exitCode: 124,
          });
        }, timeoutMs);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'stdout') {
            if (stdoutBuf.length < MAX_BUF) stdoutBuf += msg.data;
            opts?.onStream?.('stdout', msg.data);
          } else if (msg.type === 'stderr') {
            if (stderrBuf.length < MAX_BUF) stderrBuf += msg.data;
            opts?.onStream?.('stderr', msg.data);
          } else if (msg.type === 'exit') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: msg.code });
          } else if (msg.type === 'cancelled') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: 130 });
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            cleanup();
            resolve({ stdout: stdoutBuf, stderr: stderrBuf + '\n' + msg.message, exitCode: 1 });
          }
        });

        ws.send(JSON.stringify({ type: 'run', requestId, command: cmd }));
      });
    },
    []
  );

  // ── Public: readFile ────────────────────────────────────────────────────────

  const readFile = useCallback(
    (filePath: string, encoding?: string): Promise<ReadFileResult> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'Termuxに接続されていません。' });
          return;
        }

        const requestId = genRequestId('rf');
        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: 'ファイル読み取りがタイムアウトしました。' });
        }, 10000);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'fileRead') {
            clearTimeout(timer); cleanup();
            resolve({ ok: true, content: msg.content, filePath: msg.filePath, size: msg.size });
          } else if (msg.type === 'error') {
            clearTimeout(timer); cleanup();
            resolve({ ok: false, error: msg.message });
          }
        });

        ws.send(JSON.stringify({ type: 'readFile', requestId, filePath, encoding }));
      });
    },
    []
  );

  // ── Public: listFiles ─────────────────────────────────────────────────────

  const listFiles = useCallback(
    (dirPath?: string, opts?: { recursive?: boolean; maxDepth?: number; includeHidden?: boolean }): Promise<ListFilesResult> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'Termuxに接続されていません。' });
          return;
        }

        const requestId = genRequestId('lf');
        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: 'ディレクトリ一覧取得がタイムアウトしました。' });
        }, 15000);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'fileList') {
            clearTimeout(timer); cleanup();
            resolve({ ok: true, entries: msg.entries, dirPath: msg.dirPath, total: msg.total });
          } else if (msg.type === 'error') {
            clearTimeout(timer); cleanup();
            resolve({ ok: false, error: msg.message });
          }
        });

        ws.send(JSON.stringify({
          type: 'listFiles',
          requestId,
          dirPath: dirPath || '.',
          recursive: opts?.recursive,
          maxDepth: opts?.maxDepth,
          includeHidden: opts?.includeHidden,
        }));
      });
    },
    []
  );

  // ── Public: editFile (search-and-replace patches) ─────────────────────────

  const editFile = useCallback(
    (filePath: string, edits: EditFileEdit[]): Promise<EditFileResult> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'Termuxに接続されていません。' });
          return;
        }

        const requestId = genRequestId('ef');
        const cleanup = () => { requestHandlersRef.current.delete(requestId); };

        const timer = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: 'ファイル編集がタイムアウトしました。' });
        }, 10000);

        requestHandlersRef.current.set(requestId, (msg) => {
          if (msg.type === 'fileEdited') {
            clearTimeout(timer); cleanup();
            resolve({ ok: true, filePath: msg.filePath, editsApplied: msg.editsApplied });
          } else if (msg.type === 'error') {
            clearTimeout(timer); cleanup();
            resolve({ ok: false, error: msg.message });
          }
        });

        ws.send(JSON.stringify({ type: 'editFile', requestId, filePath, edits }));
      });
    },
    []
  );

  // ── Public: reset reconnect counter (for recovery banner) ──────────────

  const resetReconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setIsReconnectExhausted(false);
    setAutoRecoveryFailed(false);
    setIsAutoRecovering(false);
    clearAutoRecoveryTimer();
    connect();
  }, [connect]);

  return {
    sendCommand,
    sendStdin,
    cancelCurrent,
    testConnection,
    createProject,
    writeFile,
    readFile,
    listFiles,
    editFile,
    openFolder,
    runCommand,
    runRawCommand,
    connect,
    disconnect,
    resetReconnect,
    isConnected: bridgeStatus === 'connected',
    isConnecting: bridgeStatus === 'connecting',
    isReconnectExhausted,
    isAutoRecovering,
    autoRecoveryFailed,
    /** True if this connection was restored after a crash (for session resume) */
    recoveredFromCrash: recoveredFromCrashRef.current,
    hasActiveCommand: activeItemRef.current !== null,
  };
}
