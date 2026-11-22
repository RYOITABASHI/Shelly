/**
 * hooks/use-mcp-server-bridge.ts at hook level (Codex review 2026-11-15,
 * findings 2 and 3): the effect compares credentials before clearing the mirror and must clear
 * a possibly broader mirror before token publication or start. The settings
 * persist barrier must clear the mirror for a restrictive change. Final gate
 * (item A): an unconfirmed startup clear fails closed — no token publication, no
 * start — and the next effect run retries it.
 *
 * The unit project has no React renderer (testEnvironment 'node', see
 * __tests__/use-skill-save-offer.test.ts), so `react` is mocked: useEffect
 * captures the effect, which the test runs by hand. lib/mcp-token.ts and
 * lib/mcp-autostart-mirror.ts are the real modules; the native module keeps
 * an in-memory mirror + server.
 */
import { createHash } from 'node:crypto';

type Mirror = { exec: boolean; readTerminal: boolean; diagnostics: boolean; typedOps: boolean; token: string } | null;

const fingerprintOf = (token: string) => createHash('sha256').update(token).digest('hex');

const tombstone = `revoked:${fingerprintOf("simulated native nonce")}`;

const native = {
  fingerprint: null as string | null,
  getMCPTokenFingerprint: jest.fn(async () => native.fingerprint),
  revokeMCPTokenFingerprint: jest.fn(async () => {
    native.fingerprint = tombstone;
    return true;
  }),
  setMCPTokenFingerprint: jest.fn(async (fingerprint: string) => {
    native.fingerprint = fingerprint;
    return true;
  }),
  mirror: null as Mirror,
  running: null as { token: string; exec: boolean; readTerminal: boolean; diagnostics: boolean; typedOps: boolean } | null,
  log: [] as string[],
  setMCPAutostartMirror: jest.fn(async (enabled: boolean, exec: boolean, readTerminal: boolean, diagnostics: boolean, typedOps: boolean, token: string | null) => {
    if (!enabled) {
      native.log.push('mirror:off');
      native.mirror = null;
      native.running = null; // OFF also stops the server natively
      return true;
    }
    native.log.push(`mirror:on exec=${exec} read=${readTerminal}`);
    native.mirror = { exec, readTerminal, diagnostics, typedOps, token: token! };
    return true;
  }),
  startMCPServer: jest.fn(async (token: string, exec: boolean, readTerminal: boolean, diagnostics: boolean, typedOps: boolean) => {
    native.log.push(`start exec=${exec} read=${readTerminal}`);
    native.running = { token, exec, readTerminal, diagnostics, typedOps };
    return true;
  }),
  getMCPAutostartToken: jest.fn(async (): Promise<string | null> => native.mirror?.token ?? null),
  refreshStageInstallResultMirror: jest.fn(async () => true),
  stopMCPServer: jest.fn(async () => {
    native.log.push('stop');
    native.mirror = null;
    native.running = null;
    return true;
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
  clearMcpTokenSecret: jest.fn(async () => { secrets.value = null; }),
  saveMcpTokenSecret: jest.fn(async (v: string) => {
    if (secrets.saveFails) throw new Error('SecureStore write failed (simulated)');
    secrets.value = v;
  }),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn(async (_algorithm: string, token: string) => fingerprintOf(token)),
  getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n).fill(7)),
}));
jest.mock('@/lib/x-oauth', () => ({
  base64UrlFromBytes: jest.fn(() => 'A'.repeat(43)),
}));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('@/lib/mcp-server-bridge', () => ({
  beginMCPRequestRevocation: jest.fn(() => jest.fn(async () => {})),
  DEVICE_REFRESH_MS: 60_000,
  refreshMCPDeviceSnapshot: jest.fn(async () => {}),
  revokePendingMCPRequests: jest.fn(async () => {}),
  resetMcpOmissionSwitches: jest.fn(async () => {}),
  setMCPBridgeKey: jest.fn(),
  startMCPPoller: jest.fn(),
  startMCPSnapshotPublisher: jest.fn(),
  stopMCPPoller: jest.fn(),
  stopMCPSnapshotPublisher: jest.fn(),
}));
jest.mock('@/lib/debug-logger', () => ({ logError: jest.fn(), logInfo: jest.fn() }));

import { getOrCreateMCPToken, mcpSettingsPersistHook, regenerateMCPToken, useMCPServerBridge } from '@/hooks/use-mcp-server-bridge';
import {
  effectiveMirrorSettings,
  mirrorTokenChange,
  noteSettingsLoaded,
  noteSettingsWritten,
  resetMcpMirrorCeilingForTests,
} from '@/lib/mcp-autostart-mirror';
import { beginMCPRequestRevocation, revokePendingMCPRequests } from '@/lib/mcp-server-bridge';
import { withMcpServerLock } from '@/lib/mcp-token';

const drain = () => withMcpServerLock(async () => {});

// Every mount's effect cleanup is registered here and drained in afterEach, so
// the hook's 5-minute device-refresh setInterval never outlives a test (an
// un-cleared interval keeps jest from exiting in --runInBand mode). Each
// cleanup is wrapped to run at most once, so tests that call it themselves
// are unaffected; tests that deliberately skip it run it after their asserts.
const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length) pendingCleanups.pop()!();
  jest.restoreAllMocks();
});

/** Mounts the hook with the current settings and lets the startup finish. */
async function mount(): Promise<() => void> {
  capturedEffect = null;
  useMCPServerBridge();
  const cleanup = capturedEffect!();
  // Register the run-once cleanup immediately, before any await, so a rejected
  // or hung startup still gets its interval cleared in afterEach.
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    if (typeof cleanup === 'function') cleanup();
  };
  pendingCleanups.push(once);
  // The startup waits for queued settings writes, then takes the lock.
  await persist.idle;
  await new Promise((r) => setImmediate(r));
  await drain();
  return once;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no loopback listener'));
  resetMcpMirrorCeilingForTests();
  native.mirror = null;
  native.fingerprint = null;
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
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) }; // left by an earlier process
    secrets.getFails = true;
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.running).toBeNull();
    expect(native.log).toEqual(['mirror:off']);
  });

  it('fresh process, both permissions OFF, no token and creation fails: the old broader mirror is cleared', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
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
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
    await mount();
    expect(native.log).toEqual(['mirror:off', 'mirror:on exec=true read=false', 'start exec=true read=false']);
    expect(native.mirror).toEqual({ exec: true, readTerminal: false, diagnostics: false, typedOps: false, token: 'T'.repeat(43) });
  });

  it('records the existing token fingerprint before returning it for Settings Copy', async () => {
    native.setMCPTokenFingerprint.mockResolvedValueOnce(false);
    await expect(getOrCreateMCPToken()).rejects.toThrow('could not persist the MCP token fingerprint');
    expect(native.fingerprint).toBeNull();

    await expect(getOrCreateMCPToken()).resolves.toBe(secrets.value);
    expect(native.fingerprint).toBe(fingerprintOf(secrets.value!));
  });

  it('tombstones before clearing the mirror when only the mirror exists', async () => {
    secrets.value = null;
    native.mirror = { exec: false, readTerminal: false, diagnostics: false, typedOps: false, token: 'T'.repeat(43) };
    await regenerateMCPToken();
    expect(native.revokeMCPTokenFingerprint).toHaveBeenCalledTimes(1);
    expect(native.revokeMCPTokenFingerprint.mock.invocationCallOrder[0]).toBeLessThan(
      native.setMCPAutostartMirror.mock.invocationCallOrder[0],
    );
  });

  it('records the startup token fingerprint before serving it', async () => {
    await mount();
    expect(native.fingerprint).toBe(fingerprintOf('T'.repeat(43)));
    expect(native.setMCPTokenFingerprint.mock.invocationCallOrder[0]).toBeLessThan(
      native.startMCPServer.mock.invocationCallOrder[0],
    );
  });

  it('does not start or enable autostart when the fingerprint write fails', async () => {
    native.setMCPTokenFingerprint.mockResolvedValueOnce(false);
    await mount();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.mirror).toBeNull();
  });

  it('revokes a token whose fingerprint differs even when the mirror agrees with SecureStore', async () => {
    native.fingerprint = fingerprintOf('O'.repeat(43));
    native.mirror = { exec: false, readTerminal: false, diagnostics: false, typedOps: false, token: 'T'.repeat(43) };
    await mount();
    expect(revokePendingMCPRequests).toHaveBeenCalledWith({ tokenRevoked: true });
    expect(native.mirror?.token).toBe('A'.repeat(43));
    expect(native.fingerprint).toBe(fingerprintOf('A'.repeat(43)));
  });

  it('recovers on startup when the mirror read fails with a stored token', async () => {
    native.getMCPAutostartToken.mockRejectedValueOnce(new Error('mirror unreadable'));
    await mount();
    expect(native.revokeMCPTokenFingerprint).toHaveBeenCalledTimes(1);
    expect(revokePendingMCPRequests).toHaveBeenCalledWith({ tokenRevoked: true });
    expect(native.startMCPServer).toHaveBeenCalledTimes(1);
    expect(native.running?.token).toBe('A'.repeat(43));
    expect(native.mirror?.token).toBe('A'.repeat(43));
  });

  it('recovers on startup after a tombstoned rotation is interrupted before saving', async () => {
    const oldToken = secrets.value!;
    native.fingerprint = fingerprintOf(oldToken);
    secrets.saveFails = true;

    await expect(regenerateMCPToken()).rejects.toThrow('SecureStore write failed');
    expect(secrets.value).toBe(oldToken);
    expect(native.fingerprint).toBe(tombstone);
    expect(native.fingerprint).not.toBe(fingerprintOf(secrets.value!));

    secrets.saveFails = false;
    jest.mocked(revokePendingMCPRequests).mockClear();
    await mount();
    expect(revokePendingMCPRequests).toHaveBeenNthCalledWith(1, { tokenRevoked: true });
    expect(native.running?.token).toBe('A'.repeat(43));
    expect(native.fingerprint).toBe(fingerprintOf('A'.repeat(43)));
  });

  it('commits a recovery tombstone before clearing or revoking the old credentials', async () => {
    const { clearMcpTokenSecret, saveMcpTokenSecret } = jest.requireMock('@/lib/secure-store');
    native.fingerprint = fingerprintOf('O'.repeat(43));
    secrets.saveFails = true;

    await expect(getOrCreateMCPToken()).rejects.toThrow('SecureStore write failed');
    expect(native.fingerprint).toBe(tombstone);
    expect(native.startMCPServer).not.toHaveBeenCalled();
    const tombstoneOrder = native.revokeMCPTokenFingerprint.mock.invocationCallOrder[0];
    for (const step of [clearMcpTokenSecret, native.setMCPAutostartMirror, revokePendingMCPRequests, saveMcpTokenSecret]) {
      expect(tombstoneOrder).toBeLessThan(step.mock.invocationCallOrder[0]);
    }
  });

  it('preserves the fingerprint through OFF and reconciles stale SecureStore on the next startup', async () => {
    await mount();
    setPersisted({ mcpServerEnabled: false });
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.fingerprint).toBe(fingerprintOf('T'.repeat(43)));

    expect(revokePendingMCPRequests).not.toHaveBeenCalledWith({ tokenRevoked: true });

    secrets.value = 'O'.repeat(43);
    resetMcpMirrorCeilingForTests();
    setPersisted({ mcpServerEnabled: true });
    await mount();
    expect(revokePendingMCPRequests).toHaveBeenCalledWith({ tokenRevoked: true });
    expect(native.mirror?.token).toBe('A'.repeat(43));
    expect(native.fingerprint).toBe(fingerprintOf('A'.repeat(43)));
  });

  it('revokes the mismatched startup credentials before minting and serving a fresh token', async () => {
    const { saveMcpTokenSecret } = jest.requireMock('@/lib/secure-store');
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'O'.repeat(43) };

    await mount();

    expect(native.getMCPAutostartToken).toHaveBeenCalledTimes(1);
    expect(revokePendingMCPRequests).toHaveBeenNthCalledWith(1, { tokenRevoked: true });
    expect(jest.mocked(revokePendingMCPRequests).mock.invocationCallOrder[0]).toBeLessThan(
      saveMcpTokenSecret.mock.invocationCallOrder[0],
    );
    expect(native.mirror?.token).toBe('A'.repeat(43));
    expect(native.running?.token).toBe('A'.repeat(43));
    expect(native.refreshStageInstallResultMirror).toHaveBeenCalled();
  });

  it('keeps token recovery pending when the revocation barrier fails', async () => {
    const { saveMcpTokenSecret } = jest.requireMock('@/lib/secure-store');
    const oldMirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'O'.repeat(43) };
    native.mirror = oldMirror;
    jest.mocked(revokePendingMCPRequests).mockRejectedValueOnce(new Error('revocation unconfirmed'));

    const cleanup = await mount();

    expect(saveMcpTokenSecret).not.toHaveBeenCalled();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.mirror).toBeNull();
    expect(secrets.value).toBeNull();
    cleanup();
    await mount();
    expect(native.running?.token).toBe('A'.repeat(43));
  });

  it('begins pending-request revocation immediately on OFF while the server lock is busy', async () => {
    const cleanup = await mount();
    jest.mocked(revokePendingMCPRequests).mockClear();
    setPersisted({ mcpServerEnabled: false });
    cleanup();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const busy = withMcpServerLock(() => wait);
    const mounted = mount();
    const finish = jest.mocked(beginMCPRequestRevocation).mock.results[0]?.value;
    try {
      expect(beginMCPRequestRevocation).toHaveBeenCalledTimes(1);
      expect(beginMCPRequestRevocation).toHaveBeenCalledWith();
      expect(finish).not.toHaveBeenCalled();
    } finally {
      release();
      await busy;
      await mounted;
    }
    expect(finish).toHaveBeenCalledTimes(1);
    expect(revokePendingMCPRequests).not.toHaveBeenCalled();
    expect(native.running).toBeNull();
    expect(native.mirror).toBeNull();
  });

  it.each(['T'.repeat(43), null])('uses plain queue cleanup even if cleanup fails (stored token: %s)', async (token) => {
    secrets.value = token;
    const revocation = jest.mocked(revokePendingMCPRequests);
    if (!token) revocation.mockResolvedValueOnce(undefined);
    revocation.mockRejectedValueOnce(new Error('queue cleanup failed'));

    await mount();

    expect(revocation.mock.calls).toEqual(token ? [[]] : [[{ tokenRevoked: true }], []]);
    expect(native.startMCPServer).toHaveBeenCalledTimes(1);
  });

  it('rejects minting when prior-principal revocation cannot confirm the stage-install clear', async () => {
    secrets.value = null;
    const { saveMcpTokenSecret } = jest.requireMock('@/lib/secure-store');
    const error = new Error('could not confirm that the latest stage install result was cleared');
    jest.mocked(revokePendingMCPRequests).mockRejectedValueOnce(error);

    await expect(getOrCreateMCPToken()).rejects.toBe(error);

    expect(revokePendingMCPRequests).toHaveBeenCalledWith({ tokenRevoked: true });
    expect(saveMcpTokenSecret).not.toHaveBeenCalled();
    expect(secrets.value).toBeNull();
  });

  it('typed ops turned OFF while every other switch stays ON: the mirror is narrowed before the token read fails', async () => {
    const all = { mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true, mcpTypedOpsEnabled: true };
    setPersisted(all);
    const cleanup = await mount();
    expect(native.mirror).toMatchObject({ typedOps: true });
    expect(native.running).toMatchObject({ typedOps: true });

    store.settings = { ...all, mcpTypedOpsEnabled: false };
    void cleanup;
    secrets.getFails = true;
    native.log = [];
    await mount();
    expect(native.mirror).toBeNull();
    expect(native.running).toBeNull();
  });

  it('typed ops ON is passed through to the mirror and to startMCPServer; OFF by default', async () => {
    setPersisted({ mcpServerEnabled: true, mcpTypedOpsEnabled: true });
    await mount();
    expect(native.mirror).toMatchObject({ exec: false, typedOps: true });
    expect(native.running).toMatchObject({ exec: false, typedOps: true });
  });

  it('typed ops default OFF: the server and the mirror start with typedOps=false', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true });
    await mount();
    expect(native.mirror).toMatchObject({ exec: true, typedOps: false });
    expect(native.running).toMatchObject({ exec: true, typedOps: false });
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

  it('unconfirmed clear: fails closed before token publication and never starts the server (final gate, item A)', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
    secrets.getFails = true;
    const { getConnectorSecret, saveMcpTokenSecret } = jest.requireMock('@/lib/secure-store');
    getConnectorSecret.mockClear();
    saveMcpTokenSecret.mockClear();
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      native.log.push('mirror:off unconfirmed');
      return false;
    });
    await mount();
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
    expect(saveMcpTokenSecret).not.toHaveBeenCalled();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.log).toEqual(['mirror:off unconfirmed']);
  });

  it('unconfirmed clear with a working token: prevents token creation and server start', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
    secrets.value = null; // would create a token
    native.setMCPAutostartMirror.mockImplementationOnce(async () => false);
    await mount();
    expect(secrets.value).toBeNull();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    expect(native.log.some((l) => l.startsWith('mirror:on'))).toBe(false);
  });

  it('a clear that throws counts as unconfirmed: no token save or start, retried next time', async () => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
    secrets.value = null;
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      throw new Error('native clear failed (simulated)');
    });
    const cleanup = await mount();
    expect(jest.requireMock('@/lib/secure-store').getConnectorSecret).toHaveBeenCalledTimes(1);
    expect(secrets.value).toBeNull();
    expect(native.startMCPServer).not.toHaveBeenCalled();
    cleanup();
    await mount();
    expect(native.log[0]).toBe('mirror:off');
    expect(native.startMCPServer).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('unconfirmed narrowing reaches recovery, with confirmed recovery clear: %s', async (confirmed) => {
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
    native.getMCPAutostartToken.mockRejectedValueOnce(new Error('mirror unreadable'));
    native.setMCPAutostartMirror.mockImplementationOnce(async () => {
      native.log.push('mirror:off unconfirmed');
      return false;
    });
    if (!confirmed) native.setMCPAutostartMirror.mockResolvedValueOnce(false);

    await mount();

    expect(native.revokeMCPTokenFingerprint).toHaveBeenCalledTimes(1);
    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(2, false, false, false, false, false, null);
    if (confirmed) {
      expect(secrets.value).toBe('A'.repeat(43));
      expect(native.running).toMatchObject({ token: 'A'.repeat(43), exec: false, readTerminal: false });
    } else {
      expect(jest.requireMock('@/lib/secure-store').saveMcpTokenSecret).not.toHaveBeenCalled();
      expect(native.startMCPServer).not.toHaveBeenCalled();
    }
  });

  it('adopts matching credentials after a confirmed narrowing clear', async () => {
    const token = 'T'.repeat(43);
    secrets.value = token;
    native.fingerprint = fingerprintOf(token);
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token };

    await mount();

    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(1, false, false, false, false, false, null);
    expect(native.revokeMCPTokenFingerprint).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/secure-store').saveMcpTokenSecret).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/x-oauth').base64UrlFromBytes).not.toHaveBeenCalled();
    expect(native.mirror).toEqual({ token, exec: false, readTerminal: false, diagnostics: false, typedOps: false });
    expect(native.running).toMatchObject({ token, exec: false, readTerminal: false });
  });

  it.each([true, false])('matching credentials recover after a failed narrowing clear (recovery clear confirmed: %s)', async (confirmed) => {
    const token = 'T'.repeat(43);
    secrets.value = token;
    native.fingerprint = fingerprintOf(token);
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token };
    native.setMCPAutostartMirror.mockResolvedValueOnce(false);
    if (!confirmed) native.setMCPAutostartMirror.mockResolvedValueOnce(false);

    await mount();

    expect(native.revokeMCPTokenFingerprint).toHaveBeenCalledTimes(1);
    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(1, false, false, false, false, false, null);
    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(2, false, false, false, false, false, null);
    const revokeOrder = native.revokeMCPTokenFingerprint.mock.invocationCallOrder[0];
    const [, recoveryClearOrder] = native.setMCPAutostartMirror.mock.invocationCallOrder;
    expect(revokeOrder).toBeLessThan(recoveryClearOrder);
    const mint = jest.requireMock('@/lib/x-oauth').base64UrlFromBytes;
    if (confirmed) {
      expect(recoveryClearOrder).toBeLessThan(mint.mock.invocationCallOrder[0]);
      expect(secrets.value).toBe('A'.repeat(43));
      expect(native.running).toMatchObject({ token: 'A'.repeat(43), exec: false, readTerminal: false });
    } else {
      expect(mint).not.toHaveBeenCalled();
      expect(jest.requireMock('@/lib/secure-store').saveMcpTokenSecret).not.toHaveBeenCalled();
      expect(native.startMCPServer).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])('matching credentials recover after a rejected narrowing clear (recovery clear confirmed: %s)', async (confirmed) => {
    const token = 'T'.repeat(43);
    secrets.value = token;
    native.fingerprint = fingerprintOf(token);
    native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token };
    native.setMCPAutostartMirror.mockRejectedValueOnce(new Error('native clear failed (simulated)'));
    if (!confirmed) native.setMCPAutostartMirror.mockResolvedValueOnce(false);

    await mount();

    expect(native.revokeMCPTokenFingerprint).toHaveBeenCalledTimes(1);
    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(1, false, false, false, false, false, null);
    expect(native.setMCPAutostartMirror).toHaveBeenNthCalledWith(2, false, false, false, false, false, null);
    const revokeOrder = native.revokeMCPTokenFingerprint.mock.invocationCallOrder[0];
    const [, recoveryClearOrder] = native.setMCPAutostartMirror.mock.invocationCallOrder;
    expect(revokeOrder).toBeLessThan(recoveryClearOrder);
    const mint = jest.requireMock('@/lib/x-oauth').base64UrlFromBytes;
    if (confirmed) {
      expect(recoveryClearOrder).toBeLessThan(mint.mock.invocationCallOrder[0]);
      expect(secrets.value).toBe('A'.repeat(43));
      expect(native.running).toMatchObject({ token: 'A'.repeat(43), exec: false, readTerminal: false });
    } else {
      expect(mint).not.toHaveBeenCalled();
      expect(jest.requireMock('@/lib/secure-store').saveMcpTokenSecret).not.toHaveBeenCalled();
      expect(native.startMCPServer).not.toHaveBeenCalled();
    }
  });

  it('with everything ON nothing can be broader, so a fresh start does not clear first', async () => {
    setPersisted({ mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true, mcpTypedOpsEnabled: true });
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
    const cleanup = capturedEffect!();
    if (typeof cleanup === 'function') pendingCleanups.push(cleanup);
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
  const on = { mcpServerEnabled: true, mcpExecEnabled: true, mcpReadTerminalEnabled: true, mcpDiagnosticsEnabled: true, mcpTypedOpsEnabled: true };

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
      native.mirror = { exec: true, readTerminal: true, diagnostics: true, typedOps: true, token: 'T'.repeat(43) };
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
