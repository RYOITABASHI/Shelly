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
 * The server reads mcpExecEnabled / mcpReadTerminalEnabled /
 * mcpDiagnosticsEnabled only at start (MCPBridge.kt passes them as
 * SHELLY_MCP_EXEC / SHELLY_MCP_READ_TERMINAL / SHELLY_MCP_DIAGNOSTICS and the
 * script hides the matching tools from tools/list), so the effect below also
 * depends on all three: a change stops the old process and starts a new one,
 * each step under withMcpServerLock.
 *
 * While the server runs, the snapshot's device section (device_status) is
 * re-read on every AppState change to active or background — the reading
 * taken as Shelly leaves the screen is the one served while it is in the
 * background — and every DEVICE_REFRESH_MS while it is open. Every start first revokes what is still
 * pending in the queue — the previous process and its clients are gone, so
 * nothing they asked for may still be approved or run.
 *
 * Auto-start (McpServerSupervisor.kt / McpServerService.kt): the native side
 * brings the server back after a reboot or app update without Shelly being
 * opened, from a Keystore-encrypted mirror of these settings + the token
 * (lib/mcp-autostart-mirror.ts). This hook writes the mirror with every
 * change, before starting; turning the server off clears the mirror, which
 * also stops the server and its foreground service natively (OFF wins).
 * Ordering: the mirror is narrowed before anything narrower is committed
 * (narrower settings on disk: the persist hook below; startup: before the
 * fallible token work, which only runs once that clear is confirmed; token
 * replacement: McpTokenDeps.invalidateMirror)
 * and widened only after the wider state is committed (settings: only to
 * what is on disk, effectiveMirrorSettings; token: after it is saved).
 * Adoption of a server the native side started headless = clean restart:
 * the start below revokes pending requests and passes a fresh bridge key, so
 * MCPBridge restarts the process (a headless server's key never reaches JS).
 * When the root merely unmounts with the settings unchanged, the server is
 * left to the native supervisor instead of being stopped
 * (mcpCleanupAction).
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { registerSettingsPersistHook, settingsPersistIdle, useSettingsStore } from '@/store/settings-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { getConnectorSecret, saveConnectorSecret } from '@/lib/secure-store';
import { base64UrlFromBytes } from '@/lib/x-oauth';
import {
  DEVICE_REFRESH_MS,
  refreshMCPDeviceSnapshot,
  revokePendingMCPRequests,
  setMCPBridgeKey,
  startMCPPoller,
  startMCPSnapshotPublisher,
  stopMCPPoller,
  stopMCPSnapshotPublisher,
} from '@/lib/mcp-server-bridge';
import { logError, logInfo } from '@/lib/debug-logger';
import {
  effectiveMirrorSettings,
  mcpCleanupAction,
  mirrorMayBeBroaderThan,
  mirrorStateFromSettings,
  mirrorTokenChange,
  noteSettingsLoaded,
  noteSettingsWriteStarted,
  noteSettingsWritten,
  persistNeedsMirrorClear,
  switchesFromSettings,
  writeMcpAutostartMirror,
  type McpMirrorSettings,
} from '@/lib/mcp-autostart-mirror';
import {
  MCP_SERVER_PORT,
  getOrCreateToken,
  getOrCreateTokenInLock,
  regenerateToken,
  withMcpServerLock,
  type McpServerControl,
  type McpTokenDeps,
  type RegenerateResult,
} from '@/lib/mcp-token';
import { purgeMcpAlwaysAllowRulesForNewToken } from '@/lib/mcp-always-allow';
import type { Sha256 } from '@/lib/mcp-request-auth';

const expoSha256: Sha256 = async (data) =>
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data)));

const tokenDeps: McpTokenDeps = {
  store: { get: getConnectorSecret, save: saveConnectorSecret },
  randomBytes: (n) => Crypto.getRandomBytesAsync(n),
  encode: base64UrlFromBytes,
  // Always-allow cascade, step 2: only rules of the new token's principal may
  // remain (step 1, before the save, removed all: revokePending below).
  purgeOtherClientRules: (token) => purgeMcpAlwaysAllowRulesForNewToken(token, expoSha256),
  // A new token must reach the native auto-start mirror too.
  onSaved: (token) =>
    mirrorTokenChange(TerminalEmulator, effectiveMirrorSettings(useSettingsStore.getState().settings), token),
  // ...and the old one must be gone from it before the token is replaced.
  invalidateMirror: async () => {
    if (!(await writeMcpAutostartMirror(TerminalEmulator, { enabled: false }))) {
      throw new Error('could not clear the native MCP auto-start mirror; token left unchanged');
    }
  },
};

/**
 * Settings persist hook (store/settings-store.ts), called in write order:
 * a write that would put narrower MCP settings on disk (server OFF, exec OFF,
 * read-terminal OFF, compared with what disk may hold now) first clears the
 * native auto-start mirror under the server lock — ordered with every other
 * mirror write — and the write is skipped unless the clear is confirmed.
 * Clearing natively also stops the server; the bridge effect restarts it and
 * writes the matching mirror once the settings are on disk. afterWrite /
 * loaded keep the disk bounds (lib/mcp-autostart-mirror.ts) the mirror is
 * widened against. Exported for tests.
 */
export const mcpSettingsPersistHook = {
  beforeWrite(next: McpMirrorSettings): Promise<boolean> | null {
    // Decide against what disk may hold BEFORE this write, then count the
    // write as in flight (the mirror may not widen past it from now on).
    const needsClear = persistNeedsMirrorClear(next);
    noteSettingsWriteStarted(next);
    if (!needsClear) return null;
    return withMcpServerLock(() => writeMcpAutostartMirror(TerminalEmulator, { enabled: false })).then((ok) => {
      if (!ok) logError('MCPBridge', 'could not clear the native MCP auto-start mirror; narrower MCP settings not saved yet');
      return ok;
    });
  },
  afterWrite: (next: McpMirrorSettings, ok: boolean) => noteSettingsWritten(next, ok),
  loaded: (settings: McpMirrorSettings | null) => noteSettingsLoaded(settings),
};
registerSettingsPersistHook(mcpSettingsPersistHook);

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
  return TerminalEmulator.startMCPServer(
    token,
    settings.mcpExecEnabled === true,
    settings.mcpReadTerminalEnabled === true,
    settings.mcpDiagnosticsEnabled === true,
    settings.mcpTypedOpsEnabled === true,
    bridgeKey,
  );
}

const serverControl: McpServerControl = {
  isRunning: () => TerminalEmulator.isMCPServerRunning(),
  start: startNativeServer,
  stop: () => TerminalEmulator.stopMCPServer(),
  probe: probeLocalServer,
  // Token regeneration: also removes every always-allow rule (cascade step 1).
  revokePending: () => revokePendingMCPRequests({ tokenRevoked: true }),
};

/** Returns the persisted MCP bearer token, generating and saving a fresh
 *  one on first use. Exported so Settings UI can show/copy it without
 *  duplicating the generation logic. Takes the server lock (creation and
 *  regeneration are serialized); never call it from inside the lock. */
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
  const diagnosticsEnabled = useSettingsStore((s) => s.settings.mcpDiagnosticsEnabled === true);
  const typedOpsEnabled = useSettingsStore((s) => s.settings.mcpTypedOpsEnabled === true);
  // Before the persisted settings are applied, mcpServerEnabled is just the
  // default (false); acting on it would clear the native mirror and stop a
  // server the native side auto-started.
  const settingsLoaded = useSettingsStore((s) => s.isBaseSettingsLoaded);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (!enabled) {
      // OFF wins: clear the native mirror (also stops a server the native
      // side may have started headless, and its foreground service), and
      // drop a snapshot a left-running server was still serving from.
      stopMCPSnapshotPublisher();
      void withMcpServerLock(() => writeMcpAutostartMirror(TerminalEmulator, { enabled: false }))
        .then((ok) => {
          if (!ok) logError('MCPBridge', 'could not clear the native MCP auto-start mirror');
        })
        .catch(() => {});
      return;
    }
    let cancelled = false;
    const captured = { enabled, exec: execEnabled, readTerminal: readTerminalEnabled, diagnostics: diagnosticsEnabled, typedOps: typedOpsEnabled };
    // Widen the mirror only to settings already on disk: wait for the queued
    // settings writes first. Outside the lock — a queued narrowing write
    // needs the lock for its mirror clear.
    void settingsPersistIdle().then(() => withMcpServerLock(async () => {
      if (cancelled) return;
      try {
        // Narrow first: the token work below can fail, and a failure must
        // not leave a mirror broader than these settings (e.g. exec ON from
        // an earlier process while Settings now say OFF) for a reboot /
        // update to restore. Clearing also stops a headless server; the
        // start below brings it back with these switches.
        // Fail closed: without a CONFIRMED clear nothing else happens — no
        // token load / create, no mirror write, no start (the native OFF
        // path still stops a headless server). The mirror ceiling stays
        // unchanged, so the next run of this effect (app start, or any
        // MCP switch change written to settings) tries the clear again,
        // like the settings persist barrier skipping a write it could not
        // order behind a confirmed clear.
        if (mirrorMayBeBroaderThan(switchesFromSettings(effectiveMirrorSettings(useSettingsStore.getState().settings)))) {
          if (!(await writeMcpAutostartMirror(TerminalEmulator, { enabled: false }))) {
            logError(
              'MCPBridge',
              'could not clear a possibly broader native MCP auto-start mirror; server not started (retried on the next start / MCP settings change)',
            );
            return;
          }
        }
        if (cancelled) return;
        const token = await getOrCreateTokenInLock(tokenDeps);
        if (cancelled) return;
        // Mirror first, so a reboot after this point auto-starts with exactly
        // these settings and this token. A failure only disables auto-start.
        const mirrored = await writeMcpAutostartMirror(
          TerminalEmulator,
          mirrorStateFromSettings(effectiveMirrorSettings(useSettingsStore.getState().settings), token),
        );
        if (!mirrored) logError('MCPBridge', 'native MCP auto-start mirror not written; auto-start is off');
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
          logInfo('MCPBridge', `server + poller started (exec=${execEnabled}, readTerminal=${readTerminalEnabled}, diagnostics=${diagnosticsEnabled}, typedOps=${typedOpsEnabled})`);
        } else {
          logError('MCPBridge', 'native server failed to start');
        }
      } catch (e) {
        if (!cancelled) logError('MCPBridge', 'startup failed', e);
      }
    }));
    // Device section refresh triggers (refreshMCPDeviceSnapshot is a no-op
    // until the publisher has started).
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' || state === 'background') void refreshMCPDeviceSnapshot();
    });
    const deviceTimer = setInterval(() => {
      if (AppState.currentState === 'active') void refreshMCPDeviceSnapshot();
    }, DEVICE_REFRESH_MS);
    return () => {
      cancelled = true;
      appStateSub.remove();
      clearInterval(deviceTimer);
      const { settings } = useSettingsStore.getState();
      const action = mcpCleanupAction(captured, {
        enabled: settings.mcpServerEnabled === true,
        exec: settings.mcpExecEnabled === true,
        readTerminal: settings.mcpReadTerminalEnabled === true,
        diagnostics: settings.mcpDiagnosticsEnabled === true,
        typedOps: settings.mcpTypedOpsEnabled === true,
      });
      stopMCPPoller();
      // 'keep': the native server keeps answering list_agents / list_repos
      // from the signed snapshot, so leave the file in place.
      stopMCPSnapshotPublisher({ keepFile: action === 'keep' });
      setMCPBridgeKey(null);
      if (action === 'stop') {
        void withMcpServerLock(() => TerminalEmulator.stopMCPServer()).catch(() => {});
      } else {
        logInfo('MCPBridge', 'bridge unmounted with the server still enabled; left to the native supervisor');
      }
    };
  }, [settingsLoaded, enabled, execEnabled, readTerminalEnabled, diagnosticsEnabled, typedOpsEnabled]);
}
