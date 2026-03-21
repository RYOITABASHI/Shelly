/**
 * useTtydConnection — TTYタブ用の接続管理フック
 *
 * ttydへのfetch HEAD接続チェックを行い、失敗時はTermuxBridge経由で
 * ttydを自動起動してからリトライする。手動接続は不要。
 * AppState連携でフォアグラウンド復帰時にリトライカウンターをリセットして再接続。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';

type TtydStatus = 'connecting' | 'connected' | 'error';

const RETRY_INTERVAL = 3000;
const MAX_RETRIES = 10;

// Module-level flag to avoid launching ttyd multiple times
let _ttydLaunchAttempted = false;

export function useTtydConnection() {
  const { termuxSettings } = useTerminalStore();
  const { runRawCommand, isConnected: bridgeConnected } = useTermuxBridge();
  const ttyUrl = termuxSettings.ttyUrl || 'http://localhost:7681';

  const [status, setStatus] = useState<TtydStatus>('connecting');
  const [retryCount, setRetryCount] = useState(0);

  const retryCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>('active');
  const mountedRef = useRef(true);

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

  // Auto-launch ttyd via bridge WebSocket (reliable) or fallback
  const autoLaunchTtyd = useCallback(async () => {
    if (_ttydLaunchAttempted) return;
    _ttydLaunchAttempted = true;
    try {
      if (bridgeConnected) {
        // Bridge available — use nohup + sleep pattern for reliable background launch
        await runRawCommand(
          'nohup ttyd -p 7681 -W bash > /dev/null 2>&1 & sleep 2 && echo OK',
          { timeoutMs: 10000, reason: 'ttyd-auto-launch' },
        );
      }
    } catch {
      // Best-effort
    }
    setTimeout(() => { _ttydLaunchAttempted = false; }, 30000);
  }, [bridgeConnected, runRawCommand]);

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
    _ttydLaunchAttempted = false; // Allow re-launch on manual retry
    startRetryLoop();
  }, [startRetryLoop]);

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

  // Start on mount
  useEffect(() => {
    mountedRef.current = true;
    startRetryLoop();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [ttyUrl]);

  // AppState: reset retry counter on foreground resume
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prev !== 'active') {
        // Foreground resume — reset and reconnect
        _ttydLaunchAttempted = false;
        startRetryLoop();
      }
    });
    return () => sub.remove();
  }, [startRetryLoop]);

  return {
    status,
    retryCount,
    retry,
    onWebViewLoad,
    onWebViewError,
    ttyUrl,
  };
}
