/**
 * hooks/use-a2a-bridge.ts — starts/stops the A2A protocol server.
 *
 * Mount once near the app root (see app/_layout.tsx), same convention as
 * use-nacre-bridge.ts. Gated by settings.a2aServerEnabled (default OFF —
 * unlike Nacre Bridge, this opens a real network listener). Owns wiring
 * only: starting the native long-lived server (A2ABridge.kt via
 * TerminalEmulator.startA2AServer) together with the RN-side request-queue
 * poller (lib/a2a-bridge.ts) that actually answers requests, and tearing
 * both down together on toggle-off or unmount.
 */
import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settings-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { startA2APoller, stopA2APoller } from '@/lib/a2a-bridge';
import { logError, logInfo } from '@/lib/debug-logger';

export function useA2ABridge(): void {
  const enabled = useSettingsStore((s) => s.settings.a2aServerEnabled ?? false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    TerminalEmulator.startA2AServer()
      .then((started) => {
        if (cancelled) return;
        if (started) {
          startA2APoller();
          logInfo('A2ABridge', 'server + poller started');
        } else {
          logError('A2ABridge', 'native server failed to start');
        }
      })
      .catch((e) => {
        if (!cancelled) logError('A2ABridge', 'startA2AServer threw', e);
      });
    return () => {
      cancelled = true;
      stopA2APoller();
      TerminalEmulator.stopA2AServer().catch(() => {});
    };
  }, [enabled]);
}
