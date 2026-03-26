/**
 * useTtydConnection — TTYタブ用の接続管理フック（マルチセッション対応）
 *
 * セッションごとのttyUrlを受け取り、HEAD接続チェック→失敗時はTermuxBridge経由で
 * ttydを自動起動してリトライ。AppState連携でフォアグラウンド復帰時に検証。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';

type TtydStatus = 'connecting' | 'connected' | 'error';

const RETRY_INTERVAL = 3000;
const MAX_RETRIES = 10;

// Per-URL launch tracking (shared across all hook instances)
const _ttydLaunchAttempted = new Map<string, boolean>();

export function useTtydConnection(ttyUrl: string = 'http://localhost:7681') {
  const { runRawCommand, isConnected: bridgeConnected } = useTermuxBridge();

  const [status, setStatus] = useState<TtydStatus>('connecting');
  const [retryCount, setRetryCount] = useState(0);

  const retryCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>('active');
  const mountedRef = useRef(true);
  const statusRef = useRef<TtydStatus>(status);
  statusRef.current = status;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(ttyUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }, [ttyUrl]);

  // Extract port from ttyUrl for auto-launch command
  const getPort = useCallback((): string => {
    try {
      return new URL(ttyUrl).port || '7681';
    } catch {
      return '7681';
    }
  }, [ttyUrl]);

  // Auto-launch ttyd via bridge WebSocket
  const autoLaunchTtyd = useCallback(async () => {
    if (_ttydLaunchAttempted.get(ttyUrl)) return;
    _ttydLaunchAttempted.set(ttyUrl, true);
    try {
      if (bridgeConnected) {
        const port = getPort();
        const n = parseInt(port, 10) - 7681 + 1;
        const sessionName = `shelly-${n}`;
        await runRawCommand(
          `tmux has-session -t "${sessionName}" 2>/dev/null || tmux new-session -d -s "${sessionName}"; nohup ttyd -p ${port} -W tmux attach-session -t "${sessionName}" > /dev/null 2>&1 & sleep 2 && echo OK`,
          { timeoutMs: 10000, reason: 'ttyd-auto-launch' },
        );
      }
    } catch {
      // Best-effort
    }
    setTimeout(() => { _ttydLaunchAttempted.set(ttyUrl, false); }, 30000);
  }, [bridgeConnected, runRawCommand, ttyUrl, getPort]);

  const startRetryLoop = useCallback(() => {
    clearTimer();
    retryCountRef.current = 0;
    if (mountedRef.current) {
      setRetryCount(0);
      setStatus('connecting');
    }

    const tick = async () => {
      if (!mountedRef.current) return;
      if (retryCountRef.current >= MAX_RETRIES) {
        setStatus('error');
        return;
      }

      const ok = await checkConnection();
      if (!mountedRef.current) return;

      if (ok) {
        setStatus('connected');
        return;
      }

      // After 2 failed attempts, try to auto-launch ttyd
      if (retryCountRef.current === 2) {
        autoLaunchTtyd();
      }

      retryCountRef.current += 1;
      setRetryCount(retryCountRef.current);

      if (retryCountRef.current >= MAX_RETRIES) {
        setStatus('error');
        return;
      }

      timerRef.current = setTimeout(tick, RETRY_INTERVAL);
    };

    tick();
  }, [checkConnection, clearTimer, autoLaunchTtyd]);

  // Manual retry — reset counters and restart
  const retry = useCallback(() => {
    _ttydLaunchAttempted.set(ttyUrl, false);
    startRetryLoop();
  }, [startRetryLoop, ttyUrl]);

  // Called by WebView onLoadEnd — mark connected
  const onWebViewLoad = useCallback(() => {
    clearTimer();
    if (mountedRef.current) {
      setStatus('connected');
    }
  }, [clearTimer]);

  // Called by WebView onError — start retry loop
  const onWebViewError = useCallback(() => {
    startRetryLoop();
  }, [startRetryLoop]);

  // Start on mount or when ttyUrl changes (session switch)
  useEffect(() => {
    mountedRef.current = true;
    startRetryLoop();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [ttyUrl]);

  // AppState: verify connection on foreground resume (skip if already connected)
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prev !== 'active') {
        if (statusRef.current === 'connected') {
          const ok = await checkConnection();
          if (!ok && mountedRef.current) {
            _ttydLaunchAttempted.set(ttyUrl, false);
            startRetryLoop();
          }
          return;
        }
        _ttydLaunchAttempted.set(ttyUrl, false);
        startRetryLoop();
      }
    });
    return () => sub.remove();
  }, [startRetryLoop, checkConnection, ttyUrl]);

  return {
    status,
    retryCount,
    retry,
    onWebViewLoad,
    onWebViewError,
    ttyUrl,
  };
}
