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
 * together on toggle-off or unmount.
 */
import { useEffect } from 'react';
import * as Crypto from 'expo-crypto';
import { useSettingsStore } from '@/store/settings-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { getConnectorSecret, saveConnectorSecret } from '@/lib/secure-store';
import { base64UrlFromBytes } from '@/lib/x-oauth';
import { startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { logError, logInfo } from '@/lib/debug-logger';

const MCP_TOKEN_CONNECTOR_ID = 'mcp-server';
const MCP_TOKEN_FIELD = 'token';
const MCP_TOKEN_BYTES = 32;

/** Returns the persisted MCP bearer token, generating and saving a fresh
 *  one on first use. Exported so Settings UI can show/copy it without
 *  duplicating the generation logic. */
export async function getOrCreateMCPToken(): Promise<string> {
  const existing = await getConnectorSecret(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
  if (existing) return existing;
  const bytes = await Crypto.getRandomBytesAsync(MCP_TOKEN_BYTES);
  const token = base64UrlFromBytes(bytes);
  await saveConnectorSecret(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD, token);
  return token;
}

export function useMCPServerBridge(): void {
  const enabled = useSettingsStore((s) => s.settings.mcpServerEnabled ?? false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
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
    })();
    return () => {
      cancelled = true;
      stopMCPPoller();
      TerminalEmulator.stopMCPServer().catch(() => {});
    };
  }, [enabled]);
}
