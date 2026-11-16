/**
 * lib/mcp-autostart-mirror.ts — keeps the native MCP auto-start mirror in
 * step with the RN settings and the SecureStore token.
 *
 * The boot / app-update auto-start (McpServerAutostartReceiver →
 * McpServerService → McpServerSupervisor) runs before RN, so it reads a
 * native copy of the settings and token (McpAutostartStore.kt, Keystore
 * AES-GCM). The RN settings and SecureStore stay the single source of truth
 * the owner edits; this module only copies them, with every change:
 *  - hooks/use-mcp-server-bridge.ts on app start and on every change of
 *    mcpServerEnabled / mcpExecEnabled / mcpReadTerminalEnabled /
 *    mcpDiagnosticsEnabled / mcpTypedOpsEnabled;
 *  - lib/mcp-token.ts create / regenerate (McpTokenDeps.invalidateMirror
 *    before the token is replaced, McpTokenDeps.onSaved after it is saved);
 *  - store/settings-store.ts writes narrower MCP settings to disk only after
 *    the mirror was durably cleared (persist hook registered by the bridge
 *    hook module), and the mirror is widened only to settings already on
 *    disk (effectiveMirrorSettings).
 *
 * Ordering rule: the durable mirror is narrowed / invalidated BEFORE the
 * narrower state (settings, token) is committed, and widened only AFTER the
 * wider state is committed. A process death in between leaves auto-start
 * OFF, never broader than Settings or holding a revoked token.
 *
 * Fail closed: when the native side cannot store an ON mirror, the mirror is
 * cleared, so auto-start can only ever be OFF or exactly what Settings say.
 * Never logs the token.
 */

export interface McpMirrorNative {
  setMCPAutostartMirror(
    enabled: boolean,
    exec: boolean,
    readTerminal: boolean,
    diagnostics: boolean,
    typedOps: boolean,
    token: string | null,
  ): Promise<boolean>;
}

export type McpMirrorSettings = {
  mcpServerEnabled?: boolean;
  mcpExecEnabled?: boolean;
  mcpReadTerminalEnabled?: boolean;
  mcpDiagnosticsEnabled?: boolean;
  mcpTypedOpsEnabled?: boolean;
};

export type McpMirrorState =
  | { enabled: false }
  | { enabled: true; exec: boolean; readTerminal: boolean; diagnostics: boolean; typedOps: boolean; token: string };

/** Only `=== true` counts as on, matching the hook and the native parser. */
export function mirrorStateFromSettings(settings: McpMirrorSettings, token: string | null): McpMirrorState {
  if (settings.mcpServerEnabled !== true || !token) return { enabled: false };
  return {
    enabled: true,
    exec: settings.mcpExecEnabled === true,
    readTerminal: settings.mcpReadTerminalEnabled === true,
    diagnostics: settings.mcpDiagnosticsEnabled === true,
    typedOps: settings.mcpTypedOpsEnabled === true,
    token,
  };
}

export type McpBridgeSwitches = { enabled: boolean; exec: boolean; readTerminal: boolean; diagnostics: boolean; typedOps: boolean };

/** The five switches as the hook / native side read them (`=== true`). */
export function switchesFromSettings(settings: McpMirrorSettings): McpBridgeSwitches {
  return {
    enabled: settings.mcpServerEnabled === true,
    exec: settings.mcpExecEnabled === true,
    readTerminal: settings.mcpReadTerminalEnabled === true,
    diagnostics: settings.mcpDiagnosticsEnabled === true,
    typedOps: settings.mcpTypedOpsEnabled === true,
  };
}

/**
 * Upper bound on what the durable native mirror may hold, as far as this JS
 * context knows. 'unknown' at JS start: an earlier process (or a write whose
 * outcome was lost) may have left anything. Only writeMcpAutostartMirror
 * updates it; native-side clears (stopMCPServer, OFF) only ever lower the
 * real mirror, so the bound stays an upper bound.
 */
type MirrorCeiling = McpBridgeSwitches | 'unknown';
let ceiling: MirrorCeiling = 'unknown';
const OFF_SWITCHES: McpBridgeSwitches = { enabled: false, exec: false, readTerminal: false, diagnostics: false, typedOps: false };

function unionCeiling(a: MirrorCeiling, b: McpBridgeSwitches): MirrorCeiling {
  if (a === 'unknown') return 'unknown';
  if (!a.enabled) return b;
  if (!b.enabled) return a;
  return {
    enabled: true,
    exec: a.exec || b.exec,
    readTerminal: a.readTerminal || b.readTerminal,
    diagnostics: a.diagnostics || b.diagnostics,
    typedOps: a.typedOps || b.typedOps,
  };
}

/**
 * True when the mirror may allow more than `current` (server ON while
 * `current` is OFF, or exec / readTerminal / diagnostics / typedOps ON while `current`
 * has it OFF).
 * The bridge hook clears the mirror before any fallible token work when this
 * holds, so a failed token load can never leave a broader mirror behind.
 */
export function mirrorMayBeBroaderThan(current: McpBridgeSwitches): boolean {
  return isNarrowerThan(current, ceiling);
}

function intersectSwitches(a: McpBridgeSwitches, b: McpBridgeSwitches): McpBridgeSwitches {
  const enabled = a.enabled && b.enabled;
  return {
    enabled,
    exec: enabled && a.exec && b.exec,
    readTerminal: enabled && a.readTerminal && b.readTerminal,
    diagnostics: enabled && a.diagnostics && b.diagnostics,
    typedOps: enabled && a.typedOps && b.typedOps,
  };
}

/** True when `next` allows less than `bound` (OFF, exec OFF, read-terminal OFF, diagnostics OFF, typedOps OFF). */
function isNarrowerThan(next: McpBridgeSwitches, bound: MirrorCeiling): boolean {
  if (bound === 'unknown') return !(next.enabled && next.exec && next.readTerminal && next.diagnostics && next.typedOps);
  if (!bound.enabled) return false;
  return (
    !next.enabled ||
    (bound.exec && !next.exec) ||
    (bound.readTerminal && !next.readTerminal) ||
    (bound.diagnostics && !next.diagnostics) ||
    (bound.typedOps && !next.typedOps)
  );
}

/**
 * What the persisted settings (AsyncStorage) may hold / surely hold, fed by
 * store/settings-store.ts persist hooks in write order. A failed write leaves
 * either the old or the new value on disk, so the upper bound takes the
 * union and the lower bound the intersection. Before the settings are loaded
 * nothing is known: upper 'unknown', lower OFF.
 *  - upper: a write narrower than it must first clear the mirror
 *    (persistNeedsMirrorClear).
 *  - lower: the mirror is never widened beyond it (effectiveMirrorSettings),
 *    i.e. only to settings that are already on disk.
 */
let diskUpper: MirrorCeiling = 'unknown';
let diskLower: McpBridgeSwitches = OFF_SWITCHES;

export function noteSettingsLoaded(settings: McpMirrorSettings | null): void {
  if (!settings) {
    diskUpper = 'unknown';
    diskLower = OFF_SWITCHES;
    return;
  }
  const s = switchesFromSettings(settings);
  diskUpper = s;
  diskLower = s;
}

/**
 * A settings write is about to start (called in write order, before it may
 * be held back). Until its outcome is known disk may hold either value, so
 * the bounds widen / narrow to cover both right away: a narrowing write in
 * flight already lowers what the mirror may be widened to (e.g. a token
 * regeneration's onSaved cannot install exec ON while an exec-OFF write is
 * pending).
 */
export function noteSettingsWriteStarted(settings: McpMirrorSettings): void {
  const s = switchesFromSettings(settings);
  diskUpper = unionCeiling(diskUpper, s);
  diskLower = intersectSwitches(diskLower, s);
}

export function noteSettingsWritten(settings: McpMirrorSettings, ok: boolean): void {
  const s = switchesFromSettings(settings);
  if (ok) {
    diskUpper = s;
    diskLower = s;
    return;
  }
  diskUpper = unionCeiling(diskUpper, s);
  diskLower = intersectSwitches(diskLower, s);
}

/**
 * True when writing `next` to disk would make the persisted settings
 * narrower than they may be now: the native mirror must be durably cleared
 * first, and the write must not happen if that is not confirmed.
 */
export function persistNeedsMirrorClear(next: McpMirrorSettings): boolean {
  return isNarrowerThan(switchesFromSettings(next), diskUpper);
}

/**
 * The settings the mirror may be written from: the current ones, but never
 * broader than what is surely persisted. Widening thus waits for the wider
 * settings to reach disk (the bridge re-runs after settingsPersistIdle()).
 */
export function effectiveMirrorSettings(current: McpMirrorSettings): McpMirrorSettings {
  const s = intersectSwitches(switchesFromSettings(current), diskLower);
  return {
    mcpServerEnabled: s.enabled,
    mcpExecEnabled: s.exec,
    mcpReadTerminalEnabled: s.readTerminal,
    mcpDiagnosticsEnabled: s.diagnostics,
    mcpTypedOpsEnabled: s.typedOps,
  };
}

/** Tests only: forget what this context wrote / saw on disk (as at JS start). */
export function resetMcpMirrorCeilingForTests(): void {
  ceiling = 'unknown';
  diskUpper = 'unknown';
  diskLower = OFF_SWITCHES;
}

/**
 * Writes the mirror. Resolves true when the native mirror now matches
 * `state`. An ON write that fails or throws is followed by an explicit OFF
 * (clear), so a stale ON mirror (old token, broader switches) cannot
 * survive. Note that the OFF write also stops the native server.
 * Call inside withMcpServerLock (lib/mcp-token.ts).
 */
export async function writeMcpAutostartMirror(native: McpMirrorNative, state: McpMirrorState): Promise<boolean> {
  if (!state.enabled) {
    try {
      const ok = (await native.setMCPAutostartMirror(false, false, false, false, false, null)) === true;
      if (ok) ceiling = OFF_SWITCHES;
      return ok;
    } catch {
      return false;
    }
  }
  const target: McpBridgeSwitches = {
    enabled: true,
    exec: state.exec,
    readTerminal: state.readTerminal,
    diagnostics: state.diagnostics,
    typedOps: state.typedOps,
  };
  // Until the outcome is known the mirror may hold either the old or the new value.
  ceiling = unionCeiling(ceiling, target);
  let ok = false;
  try {
    ok = (await native.setMCPAutostartMirror(true, state.exec, state.readTerminal, state.diagnostics, state.typedOps, state.token)) === true;
  } catch {
    ok = false;
  }
  if (ok) {
    ceiling = target;
    return true;
  }
  try {
    if ((await native.setMCPAutostartMirror(false, false, false, false, false, null)) === true) ceiling = OFF_SWITCHES;
  } catch {
    // The native ON write already cleared on failure; nothing more to do.
  }
  return false;
}

/**
 * Called after a NEW token was persisted (first creation or regeneration).
 * When the server is enabled the mirror gets the new token; when it is not,
 * nothing is mirrored (the next enable writes it). Throws when an enabled
 * server's mirror could not be updated, so lib/mcp-token.ts leaves a
 * regenerated server off instead of letting an old token survive natively.
 */
export async function mirrorTokenChange(
  native: McpMirrorNative,
  settings: McpMirrorSettings,
  token: string,
): Promise<void> {
  if (settings.mcpServerEnabled !== true) return;
  const ok = await writeMcpAutostartMirror(native, mirrorStateFromSettings(settings, token));
  if (!ok) throw new Error('could not update the native MCP auto-start mirror (auto-start is now off)');
}

/**
 * What the bridge hook's effect cleanup must do with the native server.
 *  - 'stop': the owner changed a switch (OFF, or exec / readTerminal / diagnostics / typedOps) —
 *    the old process must not keep serving with the old switches.
 *  - 'keep': nothing changed (the root unmounted, e.g. the activity was
 *    destroyed or JS reloaded) — the native supervisor keeps the server up;
 *    the next mount restarts it with a fresh bridge key.
 */
export function mcpCleanupAction(captured: McpBridgeSwitches, current: McpBridgeSwitches): 'stop' | 'keep' {
  if (!current.enabled) return 'stop';
  if (captured.enabled !== current.enabled) return 'stop';
  if (
    captured.exec !== current.exec ||
    captured.readTerminal !== current.readTerminal ||
    captured.diagnostics !== current.diagnostics ||
    captured.typedOps !== current.typedOps
  ) return 'stop';
  return 'keep';
}
