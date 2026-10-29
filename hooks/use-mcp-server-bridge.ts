/**
 * hooks/use-mcp-server-bridge.ts — starts/stops the MCP protocol server.
 *
 * Mount once near the app root (see app/_layout.tsx), same convention as
 * use-a2a-bridge.ts / use-nacre-bridge.ts. Gated by
 * settings.mcpServerEnabled (default OFF — opens a real network listener,
 * same reasoning as the A2A bridge). Owns wiring only: generating/loading
 * the pre-shared bearer token (lib/secure-store.ts, same encrypted storage
 * every other API key uses) the native server checks on every request,
 * starting the native long-lived server together with the RN-side
 * request-queue poller (lib/mcp-server-bridge.ts), and tearing both down
 * together on toggle-off or unmount. Token lifecycle logic (create /
 * regenerate + restart) lives in lib/mcp-token.ts.
 */
import { useEffect } from 'react';
import * as Crypto from 'expo-crypto';
import { useSettingsStore } from '@/store/settings-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { getConnectorSecret, saveConnectorSecret } from '@/lib/secure-store';
import { base64UrlFromBytes } from '@/lib/x-oauth';
import { revokePendingMCPRequests, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { logError, logInfo } from '@/lib/debug-logger';
import {
  MCP_SERVER_PORT,
  getOrCreateToken,
  regenerateToken,
  withMcpServerLock,
  type McpServerControl,
  type McpTokenDeps,
  type RegenerateResult,
} from '@/lib/mcp-token';

const tokenDeps: McpTokenDeps = {
  store: { get: getConnectorSecret, save: saveConnectorSecret },
  randomBytes: (n) => Crypto.getRandomBytesAsync(n),
  encode: base64UrlFromBytes,
};

/** GET /mcp: the script answers 401 for a wrong token and 405 for a
 *  correct one (auth is checked before the method). No side effects. */
async function probeLocalServer(token: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_SERVER_PORT}/mcp`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const serverControl: McpServerControl = {
  isRunning: () => TerminalEmulator.isMCPServerRunning(),
  start: (token) => TerminalEmulator.startMCPServer(token),
  stop: () => TerminalEmulator.stopMCPServer(),
  probe: probeLocalServer,
  revokePending: revokePendingMCPRequests,
};

/** Returns the persisted MCP bearer token, generating and saving a fresh
 *  one on first use. Exported so Settings UI can show/copy it without
 *  duplicating the generation logic. */
export async function getOrCreateMCPToken(): Promise<string> {
  return getOrCreateToken(tokenDeps);
}

/** Replaces the MCP bearer token and, if the server is running, restarts it
 *  so the old token stops working immediately. */
export async function regenerateMCPToken(): Promise<RegenerateResult> {
  const result = await regenerateToken(tokenDeps, serverControl);
  logInfo('MCPBridge', `token regenerated (wasRunning=${result.wasRunning} check=${result.check})`);
  if (result.check === 'restart_failed' || result.check === 'failed_server_off') {
    // The server is off now; make the setting say so instead of leaving
    // "MCP Server: on" with nothing listening. Turning it back on starts it
    // with whatever token is stored.
    useSettingsStore.getState().updateSettings({ mcpServerEnabled: false });
  }
  return result;
}

export function useMCPServerBridge(): void {
  const enabled = useSettingsStore((s) => s.settings.mcpServerEnabled ?? false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void withMcpServerLock(async () => {
      try {
        const token = await getOrCreateMCPToken();
        if (cancelled) return;
        const started = await TerminalEmulator.startMCPServer(token);
        if (cancelled) return;
        if (started) {
          startMCPPoller();
          logInfo('MCPBridge', 'server + poller started');
        } else {
          logError('MCPBridge', 'native server failed to start');
        }
      } catch (e) {
        if (!cancelled) logError('MCPBridge', 'startup failed', e);
      }
    });
    return () => {
      cancelled = true;
      stopMCPPoller();
      void withMcpServerLock(() => TerminalEmulator.stopMCPServer()).catch(() => {});
    };
  }, [enabled]);
}
