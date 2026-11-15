/**
 * hooks/use-mcp-server-bridge.ts at hook level (Codex review 2026-11-15,
 * findings 2 and 3): the effect must clear a mirror that may be broader than
 * the current settings BEFORE the fallible token work, and the settings
 * persist barrier must clear the mirror for a restrictive change. Final gate
 * (item A): an unconfirmed startup clear fails closed — no token work, no
 * start — and the next effect run retries it.
 *
 * The unit project has no React renderer (testEnvironment 'node', see
 * __tests__/use-skill-save-offer.test.ts), so `react` is mocked: useEffect
 * captures the effect, which the test runs by hand. lib/mcp-token.ts and
 * lib/mcp-autostart-mirror.ts are the real modules; the native module keeps
 * an in-memory mirror + server.
 */
type Mirror = { exec: boolean; readTerminal: boolean; diagnostics: boolean; token: string } | null;

const native = {
  mirror: null as Mirror,
  running: null as { token: string; exec: boolean; readTerminal: boolean; diagnostics: boolean } | null,
  log: [] as string[],
  setMCPAutostartMirror: jest.fn(async (enabled: boolean, exec: boolean, readTerminal: boolean, diagnostics: boolean, token: string | null) => {
    if (!enabled) {
      native.log.push('mirror:off');
      native.mirror = null;
      native.running = null; // OFF also stops the server natively
      return true;
    }
    native.log.push(`mirror:on exec=${exec} read=${readTerminal}`);
    native.mirror = { exec, readTerminal, diagnostics, token: token! };
    return true;
  }),
  startMCPServer: jest.fn(async (token: string, exec: boolean, readTerminal: boolean, diagnostics: boolean) => {
    native.log.push(`start exec=${exec} read=${readTerminal}`);
    native.running = { token, exec, readTerminal, diagnostics };
    return true;
  }),
  stopMCPServer: jest.fn(async () => {
    native.log.push('stop');
    native.mirror = null;
    native.running = null;
  }),
  isMCPServerRunning: jest.fn(async () => native.running !== null),
};

let capturedEffect: (() => void | (() => void)) | null = null;
jest.mock('react', () => ({
  useEffect: (fn: () => void | (() => void)) => {
    capturedEffect = fn;
  },
}));

const store = {
  settings: {} as Record<string, unknown>,
  isBaseSettingsLoaded: true,
};
const registeredHooks: unknown[] = [];
const persist = { idle: Promise.resolve() as Promise<void> };
jest.mock('@/store/settings-store', () => {
  const useSettingsStore = (selector: (s: typeof store) => unknown) => selector(store);
  useSettingsStore.getState = () => ({ ...store, updateSettings: (p: Record<string, unknown>) => { store.settings = { ...store.settings, ...p }; } });
  return {
    useSettingsStore,
    registerSettingsPersistHook: (h: unknown) => {
      registeredHooks.push(h);
      return () => {};
    },
    settingsPersistIdle: () => persist.idle,
  };
});
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: native }));

const secrets = {
  value: null as string | null,
  getFails: false,
  saveFails: false,
};
jest.mock('@/lib/secure-store', () => ({
  getConnectorSecret: jest.fn(async () => {
    if (secrets.getFails) throw new Error('SecureStore read failed (simulated)');
    return secrets.value;
  }),
  saveConnectorSecret: jest.fn(async (_id: string, _f: string, v: string) => {
    if (secrets.saveFails) throw new Error('SecureStore write failed (simulated)');
    secrets.value = v;
  }),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n).fill(7)),
}));
jest.mock('@/lib/x-oauth', () => ({
  base64UrlFromBytes: () => 'A'.repeat(43),
}));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('@/lib/mcp-server-bridge', () => ({
  DEVICE_REFRESH_MS: 60_000,
  refreshMCPDeviceSnapshot: jest.fn(async () => {}),
  revokePendingMCPRequests: jest.fn(async () => {}),
  setMCPBridgeKey: jest.fn(),
  startMCPPoller: jest.fn(),
  startMCPSnapshotPublisher: jest.fn(),
  stopMCPPoller: jest.fn(),
  stopMCPSnapshotPublisher: jest.fn(),
}));
jest.mock('@/lib/debug-logger', () => ({ logError: jest.fn(), logInfo: jest.fn() }));

import { mcpSettingsPersistHook, useMCPServerBridge } from '@/hooks/use-mcp-server-bridge';
import {
  effectiveMirrorSettings,
  mirrorTokenChange,
  noteSettingsLoaded,
  noteSettingsWritten,
  resetMcpMirrorCeilingForTests,
} from '@/lib/mcp-autostart-mirror';
import { withMcpServerLock } from '@/lib/mcp-token';

const drain = () => withMcpServerLock(async () => {});

/** Mounts the hook with the current settings and lets the startup finish. */
async function mount(): Promise<() => void> {
  capturedEffect = null;
  useMCPServerBridge();
  const cleanup = capturedEffect!();
  // The startup waits for queued settings writes, then takes the lock.
  await persist.idle;
  await new Promise((r) => setImmediate(r));
  await drain();
  return typeof cleanup === 'function' ? cleanup : () => {};
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMcpMirrorCeilingForTests();
  native.mirror = null;
  native.running = null;
  native.log = [];
  secrets.value = 'T'.repeat(43);
  secrets.getFails = false;
  secrets.saveFails = false;
  store.settings = { mcpServerEnabled: true, mcpExecEnabled: false, mcpReadTerminalEnabled: false };
  persist.idle = Promise.resolve();
  noteSettingsLoaded(store.settings);
});

/** Sets the settings as loaded from / already written to disk. */
function setPersisted(settings: Record<string, unknown>): void {
  store.settings = settings;
  noteSettingsLoaded(settings);
}

describe('bridge startup narrows the mirror before fallible token work (finding 3)', () => {
  it('fresh process, both permissions OFF, token READ fails: the old broader mirror is cleared', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, token: 'O'.repeat(43) }; // left by an earlier process
    secrets.getFails = true;
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.running).toBeNull();
    expect(native.log).toEqual(['mirror:off']);
  });

  it('fresh process, both permissions OFF, no token and creation fails: the old broader mirror is cleared', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, token: 'O'.repeat(43) };
    secrets.value = null;
    secrets.saveFails = true;
    await mount();
    expect(native.mirror).toBeNull();
    expect(secrets.value).toBeNull();
  });

  it('same process: permissions turned OFF in memory (before any write) and the token read then fails', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true });
    const cleanup = await mount();
    expect(native.mirror).toMatchObject({ exec: true, readTerminal: true });
    expect(native.running).toMatchObject({ exec: true, readTerminal: true });

    store.settings = { mcpServerEnabled: true, mcpExecEnabled: false, mcpReadTerminalEnabled: false };
    // Not running the old effect's cleanup here: its 'stop' clears the mirror
    // natively too (stopMCPServer), which would hide whether the startup
    // guard itself narrows. This isolates the guard.
    void cleanup;
    secrets.getFails = true;
    native.log = [];
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.running).toBeNull();
  });

  it('writes exactly the current settings and starts when the token works', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: false });
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, token: 'O'.repeat(43) };
    await mount();
    expect(native.log).toEqual(['mirror:off', 'mirror:on exec=true read=false', 'start exec=true read=false']);
    expect(native.mirror).toEqual({ exec: true, readTerminal: false, diagnostics: false, token: 'T'.repeat(43) });
  });

  it('diagnostics turned OFF while exec / read-terminal stay ON: the mirror is narrowed before the token read fails', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true });
    const cleanup = await mount();
    expect(native.mirror).toMatchObject({ exec: true, readTerminal: true, diagnostics: true });
    expect(native.running).toMatchObject({ diagnostics: true });

    store.settings = { mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: false };
    void cleanup;
    secrets.getFails = true;
    native.log = [];
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.running).toBeNull();
  });

  it('does not clear (and stop) again once this process knows the mirror is not broader', async () => {
    const cleanup = await mount();
    cleanup(); // unchanged settings: 'keep'
    native.log = [];
    await mount();
    expect(native.log).toEqual(['mirror:on exec=false read=false', 'start exec=false read=false']);
  });

  it('unconfirmed clear: fails closed before any token work and never starts the server (final gate, item A)', async () => {
    native.mirror = { exec: true, readTerminal: true, token: 'O'.repeat(43) };
    secrets.getFails = true; // token work would fail too: it must not even be tried
    const { getConnectorSecret, saveConnectorSecret } = jest.requireMock('@/lib/secure-store');
    getConnectorSecret.mockClear();
    saveConnectorSecret.mockClear();
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      native.log.push('mirror:off unconfirmed');
      return false;
    });
    await mount();
    expect(getConnectorSecret).not.toHaveBeenCalled();
    expect(saveConnectorSecret).not.toHaveBeenCalled();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.log).toEqual(['mirror:off unconfirmed']);
  });

  it('unconfirmed clear with a working token: still no token load / create and no start', async () => {
    native.mirror = { exec: true, readTerminal: true, token: 'O'.repeat(43) };
    secrets.value = null; // would create a token
    native.setMCPAutostartMirror.mockImplementationOnce(async () => false);
    await mount();
    expect(secrets.value).toBeNull();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.log.some((l) => l.startsWith('mirror:on'))).toBe(false);
  });

  it('a clear that throws counts as unconfirmed: no token work, no start, retried next time', async () => {
    native.mirror = { exec: true, readTerminal: true, token: 'O'.repeat(43) };
    secrets.value = null;
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      throw new Error('native clear failed (simulated)');
    });
    const cleanup = await mount();
    expect(jest.requireMock('@/lib/secure-store').getConnectorSecret).not.toHaveBeenCalled();
    expect(secrets.value).toBeNull();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    cleanup();
    await mount();
    expect(native.log[0]).toBe('mirror:off');
    expect(native.startMCPServer).toHaveBeenCalledTimes(1);
  });

  it('unconfirmed clear: the next trigger retries the clear, then proceeds once it is confirmed', async () => {
    native.mirror = { exec: true, readTerminal: true, token: 'O'.repeat(43) };
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      native.log.push('mirror:off unconfirmed');
      return false;
    });
    const cleanup = await mount();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    cleanup();
    native.log = [];
    await mount(); // next app start / settings-driven re-run
    expect(native.log).toEqual(['mirror:off', 'mirror:on exec=false read=false', 'start exec=false read=false']);
    expect(native.running).toMatchObject({ exec: false, readTerminal: false });
  });

  it('with everything ON nothing can be broader, so a fresh start does not clear first', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true });
    await mount();
    expect(native.log[0]).toBe('mirror:on exec=true read=true');
  });
});

describe('the mirror widens only to settings already on disk (finding 2, review round 2)', () => {
  it('waits for queued settings writes before writing a broader mirror', async () => {
    const plain = { mcpServerEnabled: true, mcpExecEnabled: false, mcpReadTerminalEnabled: false };
    const wide = { ...plain, mcpExecEnabled: true };
    setPersisted(plain);
    store.settings = wide; // in memory; the write is still queued
    let finishWrite!: () => void;
    persist.idle = new Promise<void>((r) => { finishWrite = r; });
    capturedEffect = null;
    useMCPServerBridge();
    capturedEffect!();
    await new Promise((r) => setImmediate(r));
    await drain();
    expect(native.log).toEqual([]); // nothing written while the settings write is pending
    noteSettingsWritten(wide, true);
    finishWrite();
    await persist.idle;
    await new Promise((r) => setImmediate(r));
    await drain();
    expect(native.mirror).toMatchObject({ exec: true });
  });

  it('a failed settings write keeps the mirror at what is surely on disk', async () => {
    const plain = { mcpServerEnabled: true, mcpExecEnabled: false, mcpReadTerminalEnabled: false };
    setPersisted(plain);
    store.settings = { ...plain, mcpExecEnabled: true };
    noteSettingsWritten(store.settings, false);
    await mount();
    expect(native.mirror).toMatchObject({ exec: false });
    // The running server follows the owner's in-memory choice.
    expect(native.running).toMatchObject({ exec: true });
  });
});

describe('settings persist hook (finding 2)', () => {
  const on = { mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true };

  it('is registered with the settings store at module load', () => {
    expect(registeredHooks).toContain(mcpSettingsPersistHook);
  });

  it('clears the mirror before writing OFF / exec OFF / read-terminal OFF, and ignores other writes', async () => {
    for (const next of [
      { ...on, mcpServerEnabled: false },
      { ...on, mcpExecEnabled: false },
      { ...on, mcpReadTerminalEnabled: false },
    ]) {
      noteSettingsLoaded(on);
      native.mirror = { exec: true, readTerminal: true, diagnostics: true, token: 'T'.repeat(43) };
      const wait = mcpSettingsPersistHook.beforeWrite(next);
      expect(wait).not.toBeNull();
      await expect(wait).resolves.toBe(true);
      expect(native.mirror).toBeNull();
    }
    noteSettingsLoaded(on);
    expect(mcpSettingsPersistHook.beforeWrite({ ...on })).toBeNull();
    noteSettingsLoaded({ mcpServerEnabled: false });
    expect(mcpSettingsPersistHook.beforeWrite(on)).toBeNull();
  });

  it('reports an unconfirmed clear as false (the store then skips the write)', async () => {
    noteSettingsLoaded(on);
    native.setMCPAutostartMirror.mockImplementationOnce(async () => false);
    await expect(mcpSettingsPersistHook.beforeWrite({ ...on, mcpExecEnabled: false })).resolves.toBe(false);
  });

  it('compares with what disk may hold, not with the previous in-memory value', async () => {
    noteSettingsLoaded({ mcpServerEnabled: false });
    // A widening write failed: disk may hold exec ON now.
    mcpSettingsPersistHook.afterWrite(on, false);
    const wait = mcpSettingsPersistHook.beforeWrite({ ...on, mcpExecEnabled: false });
    expect(wait).not.toBeNull();
    await wait;
  });

  it('a narrowing write in flight already caps what a token change may mirror (review round 2)', async () => {
    // Disk: exec ON. An exec-OFF write starts (its clear runs), its
    // AsyncStorage write is still pending; exec is toggled back ON in memory
    // and the token is regenerated: onSaved must not mirror exec ON.
    noteSettingsLoaded(on);
    const wait = mcpSettingsPersistHook.beforeWrite({ ...on, mcpExecEnabled: false });
    await wait;
    native.log = [];
    await mirrorTokenChange(native, effectiveMirrorSettings(on), 'N'.repeat(43));
    expect(native.mirror).toMatchObject({ exec: false, readTerminal: true });
    // Once the OFF write is on disk and a later ON write too, exec may widen again.
    mcpSettingsPersistHook.afterWrite({ ...on, mcpExecEnabled: false }, true);
    expect(mcpSettingsPersistHook.beforeWrite(on)).toBeNull();
    mcpSettingsPersistHook.afterWrite(on, true);
    expect(effectiveMirrorSettings(on)).toEqual(on);
  });

  it('runs under the server lock, after a startup already queued there', async () => {
    noteSettingsLoaded(on);
    const order: string[] = [];
    let release!: () => void;
    void withMcpServerLock(() => new Promise<void>((r) => { release = () => { order.push('startup'); r(); }; }));
    const wait = mcpSettingsPersistHook.beforeWrite({ mcpServerEnabled: false })!.then(() => order.push('clear'));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await wait;
    expect(order).toEqual(['startup', 'clear']);
  });
});
