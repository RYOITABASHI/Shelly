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
 *
 * The server reads mcpExecEnabled / mcpReadTerminalEnabled only at start
 * (MCPBridge.kt passes them as SHELLY_MCP_EXEC / SHELLY_MCP_READ_TERMINAL and
 * the script hides the matching tools from tools/list), so the effect below
 * also depends on both: a change stops the old process and starts a new one,
 * each step under withMcpServerLock. Every start first revokes what is still
 * pending in the queue — the previous process and its clients are gone, so
 * nothing they asked for may still be approved or run.
 */
import { useEffect } from 'react';
import * as Crypto from 'expo-crypto';
import { useSettingsStore } from '@/store/settings-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { getConnectorSecret, saveConnectorSecret } from '@/lib/secure-store';
import { base64UrlFromBytes } from '@/lib/x-oauth';
import {
  revokePendingMCPRequests,
  setMCPBridgeKey,
  startMCPPoller,
  startMCPSnapshotPublisher,
  stopMCPPoller,
  stopMCPSnapshotPublisher,
} from '@/lib/mcp-server-bridge';
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

/** Starts the native server with the tool settings as they are right now.
 *  Every start gets a fresh bridge key (RN memory only): the server signs its
 *  queue requests with it and the RN poller drops anything else
 *  (lib/mcp-request-auth.ts). Set before the start so no signed request can
 *  arrive ahead of it. */
async function startNativeServer(token: string): Promise<boolean> {
  const { settings } = useSettingsStore.getState();
  const bytes = await Crypto.getRandomBytesAsync(32);
  if (!bytes || bytes.length !== 32) throw new Error('bridge key generation failed');
  const bridgeKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  setMCPBridgeKey(bridgeKey);
  return TerminalEmulator.startMCPServer(token, settings.mcpExecEnabled === true, settings.mcpReadTerminalEnabled === true, bridgeKey);
}

const serverControl: McpServerControl = {
  isRunning: () => TerminalEmulator.isMCPServerRunning(),
  start: startNativeServer,
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
  // The snapshot is signed with the token: re-sign it with the new one so
  // direct reads keep working (an old-token snapshot is ignored by the server).
  if (useSettingsStore.getState().settings.mcpServerEnabled) {
    void getOrCreateMCPToken()
      .then((token) => {
        if (useSettingsStore.getState().settings.mcpServerEnabled) startMCPSnapshotPublisher(token);
      })
      .catch(() => {});
  }
  return result;
}

export function useMCPServerBridge(): void {
  const enabled = useSettingsStore((s) => s.settings.mcpServerEnabled ?? false);
  // Not read in the effect body (startNativeServer reads the store), but a
  // change must restart the server: see the module doc.
  const execEnabled = useSettingsStore((s) => s.settings.mcpExecEnabled === true);
  const readTerminalEnabled = useSettingsStore((s) => s.settings.mcpReadTerminalEnabled === true);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void withMcpServerLock(async () => {
      try {
        const token = await getOrCreateMCPToken();
        if (cancelled) return;
        try {
          await revokePendingMCPRequests();
        } catch (e) {
          logError('MCPBridge', 'could not clear the request queue before start', e);
        }
        if (cancelled) return;
        const started = await startNativeServer(token);
        if (cancelled) return;
        if (started) {
          startMCPPoller();
          startMCPSnapshotPublisher(token);
          logInfo('MCPBridge', `server + poller started (exec=${execEnabled}, readTerminal=${readTerminalEnabled})`);
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
      stopMCPSnapshotPublisher();
      setMCPBridgeKey(null);
      void withMcpServerLock(() => TerminalEmulator.stopMCPServer()).catch(() => {});
    };
  }, [enabled, execEnabled, readTerminalEnabled]);
}
