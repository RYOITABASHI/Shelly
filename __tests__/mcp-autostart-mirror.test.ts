/**
 * MCP server auto-start: the RN → native settings/token mirror
 * (lib/mcp-autostart-mirror.ts), the bridge hook's cleanup decision, the
 * token lifecycle hook (lib/mcp-token.ts onSaved), and the native wiring
 * (McpAutostartStore / McpServerSupervisor / McpServerService /
 * McpServerAutostartReceiver + module manifest), checked structurally since
 * Kotlin compiles only in CI.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  effectiveMirrorSettings,
  mcpCleanupAction,
  mirrorMayBeBroaderThan,
  noteSettingsLoaded,
  noteSettingsWriteStarted,
  noteSettingsWritten,
  persistNeedsMirrorClear,
  mirrorStateFromSettings,
  mirrorTokenChange,
  resetMcpMirrorCeilingForTests,
  writeMcpAutostartMirror,
  type McpMirrorNative,
} from '../lib/mcp-autostart-mirror';
import {
  MCP_TOKEN_CONNECTOR_ID,
  MCP_TOKEN_FIELD,
  getOrCreateToken,
  getOrCreateTokenInLock,
  regenerateToken,
  withMcpServerLock,
  type McpServerControl,
  type McpTokenDeps,
} from '../lib/mcp-token';

type Call = [boolean, boolean, boolean, boolean, boolean, string | null];

function makeNative(results: Array<boolean | Error> = []) {
  const calls: Call[] = [];
  const native: McpMirrorNative = {
    setMCPAutostartMirror: jest.fn(async (enabled, exec, readTerminal, diagnostics, typedOps, token) => {
      calls.push([enabled, exec, readTerminal, diagnostics, typedOps, token]);
      const r = results.length ? results.shift()! : true;
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  return { native, calls };
}

describe('mirrorStateFromSettings', () => {
  it('is OFF unless mcpServerEnabled is exactly true and a token exists', () => {
    expect(mirrorStateFromSettings({}, 'tok')).toEqual({ enabled: false });
    expect(mirrorStateFromSettings({ mcpServerEnabled: false, mcpExecEnabled: true }, 'tok')).toEqual({ enabled: false });
    expect(mirrorStateFromSettings({ mcpServerEnabled: 'yes' as any }, 'tok')).toEqual({ enabled: false });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true }, null)).toEqual({ enabled: false });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true }, '')).toEqual({ enabled: false });
  });

  it('copies the tool switches exactly (never broader than Settings)', () => {
    expect(mirrorStateFromSettings({ mcpServerEnabled: true }, 'tok')).toEqual({
      enabled: true, exec: false, readTerminal: false, diagnostics: false, typedOps: false, token: 'tok',
    });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: false }, 'tok'))
      .toEqual({ enabled: true, exec: true, readTerminal: false, diagnostics: false, typedOps: false, token: 'tok' });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpExecEnabled: 1 as any, mcpReadTerminalEnabled: true }, 'tok'))
      .toEqual({ enabled: true, exec: false, readTerminal: true, diagnostics: false, typedOps: false, token: 'tok' });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpDiagnosticsEnabled: true }, 'tok'))
      .toEqual({ enabled: true, exec: false, readTerminal: false, diagnostics: true, typedOps: false, token: 'tok' });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpDiagnosticsEnabled: 'yes' as any }, 'tok'))
      .toEqual({ enabled: true, exec: false, readTerminal: false, diagnostics: false, typedOps: false, token: 'tok' });
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpTypedOpsEnabled: true }, 'tok'))
      .toEqual({ enabled: true, exec: false, readTerminal: false, diagnostics: false, typedOps: true, token: 'tok' });
    // Typed ops are separate from exec: neither implies the other.
    expect(mirrorStateFromSettings({ mcpServerEnabled: true, mcpExecEnabled: true, mcpTypedOpsEnabled: 'yes' as any }, 'tok'))
      .toEqual({ enabled: true, exec: true, readTerminal: false, diagnostics: false, typedOps: false, token: 'tok' });
  });
});

describe('writeMcpAutostartMirror', () => {
  it('writes OFF as a clear with no token', async () => {
    const { native, calls } = makeNative();
    expect(await writeMcpAutostartMirror(native, { enabled: false })).toBe(true);
    expect(calls).toEqual([[false, false, false, false, false, null]]);
  });

  it('writes ON with the switches and token', async () => {
    const { native, calls } = makeNative();
    expect(await writeMcpAutostartMirror(native, { enabled: true, exec: true, readTerminal: false, diagnostics: true, typedOps: true, token: 't' })).toBe(true);
    expect(calls).toEqual([[true, true, false, true, true, 't']]);
  });

  it('clears the mirror when the ON write fails or throws (fail closed)', async () => {
    for (const failure of [false, new Error('keystore')]) {
      const { native, calls } = makeNative([failure]);
      expect(await writeMcpAutostartMirror(native, { enabled: true, exec: false, readTerminal: false, diagnostics: false, typedOps: false, token: 't' })).toBe(false);
      expect(calls).toEqual([[true, false, false, false, false, 't'], [false, false, false, false, false, null]]);
    }
  });

  it('reports a failed OFF write without throwing', async () => {
    const { native } = makeNative([new Error('no module')]);
    expect(await writeMcpAutostartMirror(native, { enabled: false })).toBe(false);
  });
});

describe('mirrorTokenChange', () => {
  it('does nothing while the server is disabled', async () => {
    const { native, calls } = makeNative();
    await mirrorTokenChange(native, { mcpServerEnabled: false }, 'new');
    expect(calls).toEqual([]);
  });

  it('writes the new token with the current switches when enabled', async () => {
    const { native, calls } = makeNative();
    await mirrorTokenChange(native, { mcpServerEnabled: true, mcpReadTerminalEnabled: true }, 'new');
    expect(calls).toEqual([[true, false, true, false, false, 'new']]);
    await mirrorTokenChange(native, { mcpServerEnabled: true, mcpTypedOpsEnabled: true }, 'new2');
    expect(calls[calls.length - 1]).toEqual([true, false, false, false, true, 'new2']);
  });

  it('throws (after clearing) when an enabled mirror cannot follow the token', async () => {
    const { native, calls } = makeNative([false]);
    await expect(mirrorTokenChange(native, { mcpServerEnabled: true }, 'new')).rejects.toThrow(/auto-start is now off/);
    expect(calls[calls.length - 1]).toEqual([false, false, false, false, false, null]);
  });
});

describe('mcpCleanupAction', () => {
  const on = { enabled: true, exec: false, readTerminal: false, diagnostics: false, typedOps: false };
  it('keeps the server when the root unmounts with unchanged settings', () => {
    expect(mcpCleanupAction(on, { ...on })).toBe('keep');
  });
  it('stops on OFF and on any tool-switch change', () => {
    expect(mcpCleanupAction(on, { ...on, enabled: false })).toBe('stop');
    expect(mcpCleanupAction(on, { ...on, exec: true })).toBe('stop');
    expect(mcpCleanupAction({ ...on, exec: true }, on)).toBe('stop');
    expect(mcpCleanupAction(on, { ...on, readTerminal: true })).toBe('stop');
    expect(mcpCleanupAction(on, { ...on, diagnostics: true })).toBe('stop');
    expect(mcpCleanupAction({ ...on, diagnostics: true }, on)).toBe('stop');
    expect(mcpCleanupAction(on, { ...on, typedOps: true })).toBe('stop');
    expect(mcpCleanupAction({ ...on, typedOps: true }, on)).toBe('stop');
    expect(mcpCleanupAction({ ...on, typedOps: true }, { ...on, typedOps: true })).toBe('keep');
  });
});

describe('token lifecycle → mirror (McpTokenDeps.onSaved)', () => {
  function makeDeps(initial: string | null, onSaved?: (t: string) => Promise<void>) {
    const data = new Map<string, string>();
    if (initial) data.set(`${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`, initial);
    let n = 0;
    const deps: McpTokenDeps = {
      store: {
        get: async (id, f) => data.get(`${id}/${f}`) ?? null,
        save: async (id, f, v) => { data.set(`${id}/${f}`, v); },
      },
      randomBytes: async (len) => new Uint8Array(len).fill(++n),
      encode: (b) => `tok-${b[0]}`,
      revokePriorPrincipal: async () => {},
      resetOmissionSwitches: async () => {},
      readFingerprint: async () => null,
      revokeFingerprint: async () => {},
      writeFingerprint: async () => {},
      confirmListenerStopped: async () => {},
      onSaved: onSaved ? jest.fn(onSaved) : undefined,
      invalidateMirror: async () => {},
    };
    return deps;
  }
  function makeServer(running: boolean) {
    const calls: string[] = [];
    let live = running;
    const server: McpServerControl = {
      isRunning: async () => live,
      stop: async () => { calls.push('stop'); live = false; return true; },
      start: async (t) => { calls.push(`start:${t}`); live = true; return true; },
      revokePending: async () => { calls.push('revoke'); },
    };
    return { server, calls };
  }

  it('mirrors a newly created token once, but not a reused one', async () => {
    const seen: string[] = [];
    const deps = makeDeps(null, async (t) => { seen.push(t); });
    const t = await getOrCreateToken(deps);
    await getOrCreateToken(deps);
    expect(seen).toEqual([t]);
  });

  it('a mirror failure on creation does not break the in-app server', async () => {
    const deps = makeDeps(null, async () => { throw new Error('mirror'); });
    await expect(getOrCreateToken(deps)).resolves.toBe('tok-1');
  });

  it('regeneration invalidates the mirror before replacing the token and mirrors the new one before restarting', async () => {
    const order: string[] = [];
    const deps = makeDeps('old', async (t) => { order.push(`mirror:${t}`); });
    deps.invalidateMirror = async () => { order.push('invalidate'); };
    const origSave = deps.store.save;
    deps.store.save = async (id, f, v) => { order.push(`save:${v}`); return origSave(id, f, v); };
    const { server } = makeServer(true);
    server.stop = async () => { order.push('stop'); return true; };
    server.revokePending = async () => { order.push('revoke'); };
    server.start = async (t) => { order.push(`start:${t}`); return true; };
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ restarted: true, check: 'unverified' });
    const t = result.token;
    expect(order).toEqual(['invalidate', 'stop', 'revoke', `save:${t}`, `mirror:${t}`, `start:${t}`]);
  });

  it('regeneration leaves the token unchanged when the mirror cannot be invalidated (running → off)', async () => {
    const deps = makeDeps('old');
    deps.invalidateMirror = async () => { throw new Error('keystore'); };
    const { server, calls } = makeServer(true);
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ token: null, wasRunning: true, restarted: false, check: 'failed_server_off' });
    expect(result.error).toContain('keystore');
    expect(await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD)).toBe('old');
    expect(calls).toEqual(['stop']);
  });

  it('regeneration of a stopped server throws (token unchanged) when the mirror cannot be invalidated', async () => {
    const deps = makeDeps('old');
    deps.invalidateMirror = async () => { throw new Error('keystore'); };
    const { server, calls } = makeServer(false);
    await expect(regenerateToken(deps, server)).rejects.toThrow('keystore');
    expect(await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD)).toBe('old');
    expect(calls).toEqual([]);
  });

  it('first creation invalidates the mirror before saving; a failed invalidation saves nothing', async () => {
    const order: string[] = [];
    const deps = makeDeps(null, async (t) => { order.push(`mirror:${t}`); });
    deps.invalidateMirror = async () => { order.push('invalidate'); };
    const origSave = deps.store.save;
    deps.store.save = async (id, f, v) => { order.push(`save:${v}`); return origSave(id, f, v); };
    const t = await getOrCreateToken(deps);
    expect(order).toEqual(['invalidate', `save:${t}`, `mirror:${t}`]);
    // An existing token is returned without touching the mirror.
    await getOrCreateToken(deps);
    expect(order).toHaveLength(3);

    const failing = makeDeps(null);
    failing.invalidateMirror = async () => { throw new Error('keystore'); };
    await expect(getOrCreateToken(failing)).rejects.toThrow('keystore');
    expect(await failing.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD)).toBeNull();
  });

  it('a running server stays off when the mirror cannot follow the new token', async () => {
    const deps = makeDeps('old', async () => { throw new Error('keystore'); });
    const { server, calls } = makeServer(true);
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ wasRunning: true, restarted: false, check: 'failed_server_off' });
    expect(result.error).toContain('keystore');
    expect(calls).toEqual(['stop', 'revoke']);
  });

  it('a stopped server just reports not_running when the mirror fails', async () => {
    const deps = makeDeps('old', async () => { throw new Error('keystore'); });
    const { server } = makeServer(false);
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ wasRunning: false, check: 'not_running' });
    expect(result.token).toBeTruthy();
  });
});

describe('token creation vs regeneration race (finding 4: one lock for all token writes)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('a creation paused in random generation cannot overwrite a regeneration that ran meanwhile', async () => {
    const data = new Map<string, string>();
    const key = `${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`;
    const gate = deferred<Uint8Array>();
    const mirrored: string[] = [];
    let calls = 0;
    const deps: McpTokenDeps = {
      store: {
        get: async () => data.get(key) ?? null,
        save: async (_id, _f, v) => { data.set(key, v); },
      },
      // The first generation (the Settings-triggered creation) is paused
      // until the regeneration was requested; later ones resolve at once.
      randomBytes: (n) => (++calls === 1 ? gate.promise : Promise.resolve(new Uint8Array(n).fill(calls))),
      encode: (b) => `tok-${b[0]}`,
      revokePriorPrincipal: async () => {},
      resetOmissionSwitches: async () => {},
      readFingerprint: async () => null,
      revokeFingerprint: async () => {},
      writeFingerprint: async () => {},
      confirmListenerStopped: async () => {},
      onSaved: async (t) => { mirrored.push(t); },
      invalidateMirror: async () => { mirrored.push('<cleared>'); },
    };
    let live: string | null = null;
    const server: McpServerControl = {
      isRunning: async () => live !== null,
      stop: async () => { live = null; return true; },
      start: async (t) => { live = t; return true; },
      revokePending: async () => {},
    };
    live = 'already-running';

    const creation = getOrCreateToken(deps);
    // Let the creation reach the paused generation.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const regeneration = regenerateToken(deps, server);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    gate.resolve(new Uint8Array(32).fill(100));
    const created = await creation;
    const regenerated = await regeneration;

    expect(created).toBe('tok-100');
    expect(regenerated.token).toBeTruthy();
    expect(regenerated.token).not.toBe(created);
    // SecureStore, the last mirror write and the running server all agree.
    expect(data.get(key)).toBe(regenerated.token);
    expect(mirrored[mirrored.length - 1]).toBe(regenerated.token);
    expect(live).toBe(regenerated.token);
    // The creation finished (save + mirror) before the regeneration began.
    expect(mirrored).toEqual(['<cleared>', 'tok-100', '<cleared>', regenerated.token]);
  });

  it('getOrCreateTokenInLock runs inside the lock without deadlocking', async () => {
    const deps: McpTokenDeps = {
      store: { get: async () => 'existing', save: async () => {} },
      randomBytes: async (n) => new Uint8Array(n),
      encode: () => 'x',
      invalidateMirror: async () => {},
      revokePriorPrincipal: async () => {},
      resetOmissionSwitches: async () => {},
      readFingerprint: async () => null,
      revokeFingerprint: async () => {},
      writeFingerprint: async () => {},
      confirmListenerStopped: async () => {},
    };
    await expect(withMcpServerLock(() => getOrCreateTokenInLock(deps))).resolves.toBe('existing');
  });
});

describe('mirror ceiling (what the durable mirror may still hold)', () => {
  beforeEach(() => resetMcpMirrorCeilingForTests());
  const sw = (enabled: boolean, exec: boolean, readTerminal: boolean, diagnostics = false, typedOps = false) => ({ enabled, exec, readTerminal, diagnostics, typedOps });

  it('is unknown at JS start: anything short of everything ON may be narrower', () => {
    expect(mirrorMayBeBroaderThan(sw(true, true, true, true, true))).toBe(false);
    expect(mirrorMayBeBroaderThan(sw(true, true, true, true, false))).toBe(true);
    expect(mirrorMayBeBroaderThan(sw(true, true, true, false, true))).toBe(true);
    expect(mirrorMayBeBroaderThan(sw(true, false, true, true, true))).toBe(true);
    expect(mirrorMayBeBroaderThan(sw(false, false, false))).toBe(true);
  });

  it('keeps the previous ceiling when native refuses to clear the legacy mirror', async () => {
    const { native, calls } = makeNative([true, false, true]);
    const enabled = { ...sw(true, true, false), enabled: true as const, token: 'legacy-token' };
    const off = sw(false, false, false);
    expect(await writeMcpAutostartMirror(native, enabled)).toBe(true);
    expect(await writeMcpAutostartMirror(native, { enabled: false })).toBe(false);
    expect(mirrorMayBeBroaderThan(off)).toBe(true);
    expect(calls[1]).toEqual([false, false, false, false, false, null]);
    expect(await writeMcpAutostartMirror(native, { enabled: false })).toBe(true);
    expect(mirrorMayBeBroaderThan(off)).toBe(false);
  });

  it('tracks successful writes exactly, and a failed ON write as possibly-either', async () => {
    const { native } = makeNative();
    await writeMcpAutostartMirror(native, { enabled: true, exec: true, readTerminal: false, diagnostics: false, typedOps: false, token: 't' });
    expect(mirrorMayBeBroaderThan(sw(true, true, false))).toBe(false);
    expect(mirrorMayBeBroaderThan(sw(true, false, false))).toBe(true);
    await writeMcpAutostartMirror(native, { enabled: true, exec: false, readTerminal: false, diagnostics: true, typedOps: true, token: 't' });
    expect(mirrorMayBeBroaderThan(sw(true, false, false, true, true))).toBe(false);
    expect(mirrorMayBeBroaderThan(sw(true, false, false, true, false))).toBe(true); // typedOps may still be ON
    expect(mirrorMayBeBroaderThan(sw(true, false, false, false, true))).toBe(true);
    await writeMcpAutostartMirror(native, { enabled: false });
    expect(mirrorMayBeBroaderThan(sw(true, false, false))).toBe(false);
    expect(mirrorMayBeBroaderThan(sw(false, false, false))).toBe(false);

    // ON write fails AND the follow-up clear throws: the mirror may hold the
    // attempted (broader) value.
    const broken = makeNative([false, new Error('gone')]).native;
    await writeMcpAutostartMirror(broken, { enabled: true, exec: false, readTerminal: true, diagnostics: false, typedOps: false, token: 't' });
    expect(mirrorMayBeBroaderThan(sw(true, false, false))).toBe(true);
    // A failed OFF write keeps the bound.
    await writeMcpAutostartMirror(makeNative([new Error('gone')]).native, { enabled: false });
    expect(mirrorMayBeBroaderThan(sw(true, false, false))).toBe(true);
  });
});

describe('disk bounds (persisted settings vs the mirror)', () => {
  beforeEach(() => resetMcpMirrorCeilingForTests());
  const all = { mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true, mcpTypedOpsEnabled: true };
  const plain = { mcpServerEnabled: true, mcpExecEnabled: false, mcpReadTerminalEnabled: false, mcpDiagnosticsEnabled: false, mcpTypedOpsEnabled: false };

  it('before load nothing is known: every write short of all-ON clears first, and nothing widens', () => {
    expect(persistNeedsMirrorClear(plain)).toBe(true);
    expect(persistNeedsMirrorClear(all)).toBe(false);
    expect(effectiveMirrorSettings(all)).toEqual({
      mcpServerEnabled: false, mcpExecEnabled: false, mcpReadTerminalEnabled: false, mcpDiagnosticsEnabled: false, mcpTypedOpsEnabled: false,
    });
  });

  it('a write that takes a switch away from what is on disk needs a clear; others do not', () => {
    noteSettingsLoaded(all);
    expect(persistNeedsMirrorClear({ ...all, mcpServerEnabled: false })).toBe(true);
    expect(persistNeedsMirrorClear({ ...all, mcpExecEnabled: false })).toBe(true);
    expect(persistNeedsMirrorClear({ ...all, mcpReadTerminalEnabled: false })).toBe(true);
    expect(persistNeedsMirrorClear({ ...all, mcpDiagnosticsEnabled: false })).toBe(true);
    expect(persistNeedsMirrorClear({ ...all, mcpTypedOpsEnabled: false })).toBe(true);
    expect(persistNeedsMirrorClear(all)).toBe(false);
    noteSettingsWritten({ mcpServerEnabled: false }, true);
    expect(persistNeedsMirrorClear({ mcpServerEnabled: false, mcpExecEnabled: false })).toBe(false);
    expect(persistNeedsMirrorClear(plain)).toBe(false);
  });

  it('the mirror widens only to what is surely on disk', () => {
    noteSettingsLoaded(plain);
    expect(effectiveMirrorSettings(all)).toEqual(plain);
    noteSettingsWritten(all, true);
    expect(effectiveMirrorSettings(all)).toEqual(all);
    // Narrowing in memory takes effect at once.
    expect(effectiveMirrorSettings(plain)).toEqual(plain);
  });

  it('a write in flight counts as possibly on disk until its outcome is known', () => {
    noteSettingsLoaded(all);
    noteSettingsWriteStarted(plain);
    expect(effectiveMirrorSettings(all)).toEqual(plain);
    noteSettingsWritten(plain, true);
    noteSettingsWriteStarted(all);
    expect(effectiveMirrorSettings(all)).toEqual(plain); // not yet on disk
    expect(persistNeedsMirrorClear(plain)).toBe(true); // disk may hold all-ON now
    noteSettingsWritten(all, true);
    expect(effectiveMirrorSettings(all)).toEqual(all);
  });

  it('a failed write leaves either value on disk: union above, intersection below', () => {
    noteSettingsLoaded(plain);
    noteSettingsWritten(all, false);
    expect(effectiveMirrorSettings(all)).toEqual(plain); // not surely widened
    expect(persistNeedsMirrorClear(plain)).toBe(true); // disk may hold exec ON now
    noteSettingsLoaded(null);
    expect(persistNeedsMirrorClear(plain)).toBe(true);
    expect(effectiveMirrorSettings(all).mcpServerEnabled).toBe(false);
  });
});

describe('native wiring (structural; Kotlin compiles in CI)', () => {
  const root = path.resolve(__dirname, '..');
  const ktDir = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const store = read(`${ktDir}/McpAutostartStore.kt`);
  const supervisor = read(`${ktDir}/McpServerSupervisor.kt`);
  const service = read(`${ktDir}/McpServerService.kt`);
  const receiver = read(`${ktDir}/McpServerAutostartReceiver.kt`);
  const bridge = read(`${ktDir}/MCPBridge.kt`);
  const moduleKt = read(`${ktDir}/TerminalEmulatorModule.kt`);
  const manifest = read('modules/terminal-emulator/android/src/main/AndroidManifest.xml');

  it('the module manifest declares the specialUse service and the boot/update receiver', () => {
    expect(manifest).toMatch(/<service\s+android:name="\.McpServerService"[\s\S]*?android:foregroundServiceType="specialUse"[\s\S]*?PROPERTY_SPECIAL_USE_FGS_SUBTYPE[\s\S]*?<\/service>/);
    const rcv = manifest.slice(manifest.indexOf('android:name=".McpServerAutostartReceiver"'));
    expect(rcv.slice(0, 400)).toMatch(/android:exported="true"/);
    expect(rcv.slice(0, 400)).toContain('android.intent.action.BOOT_COMPLETED');
    expect(rcv.slice(0, 400)).toContain('android.intent.action.MY_PACKAGE_REPLACED');
    // No sender-permission attribute on the receiver (breaks delivery).
    expect(rcv.slice(0, rcv.indexOf('</receiver>'))).not.toMatch(/android:permission=/);
  });

  it('the receiver only reacts to the two protected system actions and defers to the mirror', () => {
    expect(receiver).toMatch(/action != Intent\.ACTION_BOOT_COMPLETED && action != Intent\.ACTION_MY_PACKAGE_REPLACED\) return/);
    expect(receiver).toContain('McpServerSupervisor.requestAutostart');
    const req = supervisor.slice(supervisor.indexOf('fun requestAutostart'));
    expect(req.slice(0, 500)).toMatch(/if \(!McpAutostartStore\.isOn\(app\)\) \{[^}]*ensureWatching\(app\)\s*return\s*\}/);
  });

  it('the service starts foreground with the specialUse type behind an API 34 check', () => {
    const idx = service.indexOf('ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
    expect(idx).toBeGreaterThan(-1);
    expect(service.slice(Math.max(0, idx - 200), idx)).toMatch(/SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/);
    expect(service).toMatch(/Notification\.Builder\(this, CHANNEL_ID\)/);
    expect(service.slice(service.indexOf('Notification.Builder(this, CHANNEL_ID)') - 120)).toMatch(/SDK_INT >= Build\.VERSION_CODES\.O/);
  });

  it('nothing requests a battery-optimization exemption', () => {
    for (const src of [store, supervisor, service, receiver]) {
      expect(src).not.toMatch(/IGNORE_BATTERY_OPTIMIZATIONS|isIgnoringBatteryOptimizations/);
    }
  });

  it('the token mirror is encrypted, re-keyed per write and never logged', () => {
    expect(store).toContain('AES/GCM/NoPadding');
    expect(store).toContain('"AndroidKeyStore"');
    const writeOn = store.slice(store.indexOf('fun writeOn'), store.indexOf('fun clear('));
    expect(writeOn).toMatch(/val key = newKey\(\)/);
    // No plaintext token in prefs.
    expect(store).not.toMatch(/putString\(\s*"token"/);
    for (const src of [store, supervisor, service, receiver, bridge]) {
      for (const line of src.split('\n').filter((l) => /Log\.[diwe]\(/.test(l))) {
        expect(line).not.toMatch(/\$\{?(token|bridgeKey|key|blob|cfg\.token|use\.token)\b/);
      }
    }
  });

  it('headless starts ensure the runtime natively and read the mirror before (re)starting', () => {
    const start = supervisor.slice(supervisor.indexOf('fun onServiceStart'), supervisor.indexOf('// ── Watchdog'));
    // The mirror is re-read and the generation re-checked UNDER the lock,
    // after the slow extraction, so an OFF during extraction wins.
    expect(start).toMatch(/prepareRuntime\(app, reason\)[\s\S]*synchronized\(lock\)[\s\S]*generation != startGeneration[\s\S]*McpAutostartStore\.read\(app\)[\s\S]*spawnWithFingerprint\(app, request\)/);
    for (const fn of ['fun startFromApp', 'fun stop(']) {
      const body = supervisor.slice(supervisor.indexOf(fn), supervisor.indexOf(fn) + 600);
      expect(body).toMatch(/generation \+= 1/);
    }
    expect(supervisor).toMatch(/HomeInitializer\.initialize\(app\)/);
    expect(supervisor).toMatch(/LibExtractor\.ensureExtracted\(app\)/);
    const reconcile = supervisor.slice(supervisor.indexOf('private fun reconcile'));
    expect(reconcile).toMatch(/if \(!d\.fromApp\)[\s\S]*McpAutostartStore\.read\(app\)[\s\S]*prepareRuntime\(app, "watchdog restart"\)[\s\S]*spawnWithFingerprint\(app, use\)/);
  });

  it('scans for orphans with or without a tracked process, even before any listener binds', () => {
    const stop = bridge.slice(bridge.indexOf('fun stop('), bridge.indexOf('internal fun isListenerPresent'));
    expect(stop).toMatch(/val proc = process \?: return killOrphanListeners\(context\)/);
    expect(stop).toMatch(/if \(isAlive\(proc\)\) return false\s*process = null\s*return killOrphanListeners\(context\)/);
    expect(bridge).toMatch(/if \(!isRunning\(\) && !killOrphanListeners\(context\)\)/);
  });

  it('requires exact orphan identity and refuses an inconclusive scan', () => {
    const identify = bridge.slice(bridge.indexOf('private fun identifyOrphan'), bridge.indexOf('internal fun killOrphanListeners'));
    expect(identify).toMatch(/val linker = "\/system\/bin\/linker64"\s*val viaLinker = argv\.getOrNull\(0\) == linker && argv\.getOrNull\(1\) == nodePath/);
    expect(identify).toMatch(/val scriptIndex = when \{\s*viaLinker -> 2\s*argv\.getOrNull\(0\) == nodePath -> 1\s*else -> return OrphanScan\.NoMatch\s*\}/);
    expect(identify).toMatch(/if \(argv\.getOrNull\(scriptIndex \+ 1\) != queuePath \|\|\s*argv\.getOrNull\(scriptIndex \+ 2\) != PORT\.toString\(\)\s*\) return OrphanScan\.NoMatch/);
    expect(identify).toMatch(/val script = File\(argv\[scriptIndex\]\)\s*val resolved = if \(script\.isAbsolute\) script else File\(Os\.readlink\("\$\{dir\.path\}\/cwd"\), argv\[scriptIndex\]\)\s*if \(resolved\.canonicalPath != scriptPath\) return OrphanScan\.NoMatch/);
    expect(identify).not.toMatch(/\.any\s*\{|script\.name/);
    expect(bridge).toMatch(/Os\.readlink\("\/system\/bin\/linker64"\)/);
    expect(bridge).toMatch(/if \(target\.startsWith\("\/"\)\) target else File\("\/system\/bin\/", target\)\.canonicalPath\s*\}\.getOrDefault\("\/system\/bin\/linker64"\)/);
    expect(bridge).toMatch(/val expectedNode = runCatching \{ File\(node\)\.canonicalPath \}\.getOrDefault\(node\)/);
    expect(identify).toMatch(/val exe = Os\.readlink\("\$\{dir\.path\}\/exe"\)\s*if \(!\(viaLinker && \(exe == linker \|\| exe == resolvedLinker\)\) &&\s*exe != expectedNode && exe != "\$expectedNode \(deleted\)"\s*\) \{\s*return OrphanScan\.NoMatch/);
    expect(identify).toMatch(/if \(uid != android\.os\.Process\.myUid\(\)\) return OrphanScan\.NoMatch/);
    expect(identify).toMatch(/if \(readStartTime\(\) != startTime\) return OrphanScan\.Unknown\s*OrphanScan\.Match\(pid, exe, ByteBuffer\.wrap\(cmdline\)\.asReadOnlyBuffer\(\), startTime\)/);
    expect(identify).toMatch(/if \(startTime != captured\.startTime \|\| argvBytes != captured\.argv\) return OrphanScan\.NoMatch/);
    expect(identify).toMatch(/if \(exe\.removeSuffix\(" \(deleted\)"\) != captured\.exe\.removeSuffix\(" \(deleted\)"\)\) \{\s*return OrphanScan\.Unknown\s*\}\s*return OrphanScan\.Match\(pid, exe, argvBytes, startTime\)/);
    expect(bridge).toMatch(/when \(val current = reread\(identity\)\) \{\s*OrphanScan\.Unknown -> return null\s*OrphanScan\.NoMatch -> null\s*is OrphanScan\.Match -> current/);
    expect(bridge).toMatch(/when \(val current = reread\(identity\)\) \{\s*OrphanScan\.Unknown -> return null\s*OrphanScan\.NoMatch -> Unit\s*is OrphanScan\.Match -> \{\s*runCatching \{ Os\.kill\(current\.pid, signal\) \}\s*signaled\.add\(current\)/);
    expect(bridge).toMatch(/File\("\/proc"\)\.list\(\) \?: return false/);
    expect(bridge).toMatch(/OrphanScan\.Unknown -> return false[\s\S]*?signal\(orphans, OsConstants\.SIGTERM\)/);

    const stop = supervisor.slice(supervisor.indexOf('fun stop('), supervisor.indexOf('return stopped') + 14);
    expect(stop).toMatch(/if \(stopped\)[\s\S]*?else \{[\s\S]*?ensureWatching\(app\)[\s\S]*?return stopped/);

    const off = supervisor.slice(supervisor.indexOf('if (d == null)', supervisor.indexOf('private fun reconcile')),
      supervisor.indexOf('restoreServiceIfNeededLocked(app, now)', supervisor.indexOf('private fun reconcile')));
    expect(off).toMatch(/if \(now >= nextAttemptAt\) \{\s*if \(MCPBridge\.stop\(app\)\)/);
    expect(off).not.toMatch(/isListenerPresent|\brunning\b/);
    expect(off).toMatch(/failures \+= 1\s*nextAttemptAt = now \+ backoffMs\(failures\)/);
    expect(off).toMatch(/resetBackoff\(\)\s*nextAttemptAt = now \+ POLL_MS/);
  });

  it('classifies a decrypted blob with no usable token as a read failure', () => {
    const readToken = store.slice(store.indexOf('internal fun readToken('), store.indexOf('private fun decrypt('));
    expect(readToken).toMatch(/val token = runCatching \{ JSONObject\(decrypted\).*\}\.getOrNull\(\)/);
    expect(readToken).toMatch(/if \(token != null && isValidToken\(token\)\) TokenRead\.Present\(token\) else TokenRead\.Failed/);
    expect(readToken.match(/TokenRead\.Absent/g)).toHaveLength(2);
  });

  it('MCPBridge never reuses a process started with other settings or token', () => {
    expect(bridge).toMatch(/processBridgeKey == bridgeKey && processToken == token &&\s*processExec == exec && processReadTerminal == readTerminal &&\s*processDiagnostics == diagnostics && processTypedOps == typedOps/);
  });

  it('the store writes v2 with typedOps and reads a v1 blob (no typedOps) as typedOps OFF', () => {
    expect(store).toMatch(/private const val VERSION = 2/);
    expect(store).toMatch(/private const val VERSION_V1 = 1/);
    expect(store).toContain('.put("typedOps", typedOps)');
    expect(store).toMatch(/if \(version != VERSION && version != VERSION_V1\) return null/);
    // v1: OFF without looking at any field; v2: a non-boolean is unreadable.
    expect(store).toMatch(/val typedOps = if \(version == VERSION_V1\) false else \{\s*if \(typedOpsRaw !is Boolean\) return null\s*typedOpsRaw\s*\}/);
  });

  it('the supervisor carries typedOps through Desired and every start path', () => {
    expect(supervisor).toMatch(/val typedOps: Boolean,\s*val bridgeKey/);
    expect(supervisor).toContain('Desired(token, exec, readTerminal, diagnostics, typedOps, bridgeKey, fromApp = true)');
    expect(supervisor).toContain('Desired(cfg.token, cfg.exec, cfg.readTerminal, cfg.diagnostics, cfg.typedOps, key, fromApp = false)');
    expect(supervisor).toContain('Desired(cfg.token, cfg.exec, cfg.readTerminal, cfg.diagnostics, cfg.typedOps, d.bridgeKey, fromApp = false)');
    expect(moduleKt).toContain('McpAutostartStore.writeOn(context, exec, readTerminal, diagnostics, typedOps, token)');
  });

  it('"is running" includes a wanted-but-dead server, so regeneration restarts it on the new token', () => {
    const fn = moduleKt.slice(moduleKt.indexOf('AsyncFunction("isMCPServerRunning")'));
    expect(fn.slice(0, 120)).toContain('McpServerSupervisor.isRunningOrWanted()');
    expect(supervisor).toMatch(/fun isRunningOrWanted\(\): Boolean = desired != null \|\| MCPBridge\.isRunning\(\)/);
  });

  it('the module routes start/stop through the supervisor and OFF clears + stops', () => {
    expect(moduleKt).toContain('McpServerSupervisor.startFromApp(context, token, exec, readTerminal, diagnostics, typedOps, bridgeKey)');
    const mirror = moduleKt.slice(moduleKt.indexOf('AsyncFunction("setMCPAutostartMirror")'));
    expect(mirror.slice(0, 900)).toMatch(/if \(!enabled\) \{[\s\S]*?val cleared = McpAutostartStore\.clear\(context, "settings off"\)\s*val stopped = McpServerSupervisor\.stop\(context, "settings off"\)\s*cleared && stopped\s*\}/);
    // No API hands a bridge key to JS.
    expect(moduleKt).not.toMatch(/AsyncFunction\("get\w*BridgeKey/);
  });

  it('every foreground-service start/stop request is issued under the supervisor lock (finding 5)', () => {
    // Only the *Locked helpers call startForegroundService / stopService.
    expect(supervisor).not.toMatch(/\b(startService|stopService)\(app/);
    const body = supervisor.slice(0, supervisor.indexOf('// ── Helpers'));
    // Walk every call site and check it sits inside an open synchronized(lock) block.
    const re = /\b(startServiceLocked|stopServiceLocked)\(/g;
    let m: RegExpExecArray | null;
    let sites = 0;
    while ((m = re.exec(body))) {
      const before = body.slice(0, m.index);
      const fnStart = before.lastIndexOf('\n    fun ') > before.lastIndexOf('\n    private fun ')
        ? before.lastIndexOf('\n    fun ')
        : before.lastIndexOf('\n    private fun ');
      const fnBody = before.slice(fnStart);
      const isLockedHelper = /private fun \w+Locked\(/.test(fnBody.slice(0, 80));
      const syncIdx = fnBody.lastIndexOf('synchronized(lock)');
      let depth = 0;
      if (syncIdx >= 0) {
        for (const ch of fnBody.slice(syncIdx)) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }
      expect({ site: fnBody.slice(0, 60), inside: isLockedHelper || (syncIdx >= 0 && depth > 0) })
        .toEqual({ site: fnBody.slice(0, 60), inside: true });
      sites++;
    }
    expect(sites).toBeGreaterThanOrEqual(5);
    // The watchdog's give-up clears `desired` and requests the stop together.
    const reconcile = supervisor.slice(supervisor.indexOf('private fun reconcile'), supervisor.indexOf('private fun restoreServiceIfNeededLocked'));
    expect(reconcile).toMatch(/desired = null\s*resetBackoff\(\)\s*stopServiceLocked\(app\)/);
  });

  it('a service destroyed while the server is wanted is restored by the watchdog, without the main thread taking the lock', () => {
    expect(service).toMatch(/override fun onCreate\(\) \{[\s\S]*?McpServerSupervisor\.onServiceCreated\(\)/);
    expect(service).toMatch(/override fun onDestroy\(\) \{[\s\S]*?McpServerSupervisor\.onServiceDestroyed\(\)/);
    const destroyed = supervisor.slice(supervisor.indexOf('fun onServiceDestroyed'), supervisor.indexOf('fun onServiceStart('));
    expect(destroyed).not.toContain('synchronized');
    const reconcile = supervisor.slice(supervisor.indexOf('private fun reconcile'));
    expect(reconcile).toMatch(/val d = desired\s+val now = System\.currentTimeMillis\(\)\s+if \(d == null\) \{[\s\S]*?\n {16}return POLL_MS\s+\}\s+restoreServiceIfNeededLocked\(app, now\)/);
    const restore = supervisor.slice(supervisor.indexOf('private fun restoreServiceIfNeededLocked'));
    expect(restore.slice(0, 600)).toMatch(/if \(serviceAlive \|\| now < serviceRetryAt\) return[\s\S]*startServiceLocked\(app, "restore"\)[\s\S]*backoffMs\(serviceRestores\)/);
  });

  it('the native clear reports a verified result (no blob, or no key)', () => {
    const clear = store.slice(store.indexOf('fun clear('), store.indexOf('/** Verified ON config'));
    expect(clear).toMatch(/fun clear\(context: Context, reason: String\): Boolean/);
    expect(clear).toMatch(/private fun clearLocked\(context: Context\): Boolean/);
    expect(clear).toMatch(/return prefsGone \|\| keyGone/);
    // Durable only: commit() itself, never an in-memory read after a failed commit.
    expect(clear).toMatch(/val prefsGone = runCatching \{\s*context\.getSharedPreferences\(PREFS, Context\.MODE_PRIVATE\)\.edit\(\)\.remove\(KEY_BLOB\)\.commit\(\)\s*\}\.getOrDefault\(false\)/);
    expect(clear).not.toMatch(/getString\(KEY_BLOB/);
    expect(clear).toMatch(/!ks\.containsAlias\(KEY_ALIAS\)/);
  });

  it('an app stop clears the auto-start mirror before stopping (finding 1)', () => {
    const fn = moduleKt.slice(moduleKt.indexOf('AsyncFunction("stopMCPServer")'));
    expect(fn.slice(0, 400)).toMatch(/val cleared = McpAutostartStore\.clear\(context, "app stop"\)\s*val stopped = McpServerSupervisor\.stop\(context, "app stop"\)\s*cleared && stopped/);
  });

  it('the plan executor and the server script pair stay untouched by this feature', () => {
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js')).toBe(read('scripts/shelly-mcp-server.js'));
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js')).toBe(read('scripts/shelly-plan-executor.js'));
  });
});
