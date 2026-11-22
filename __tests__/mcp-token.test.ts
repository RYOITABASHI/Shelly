/**
 * MCP bearer-token lifecycle (lib/mcp-token.ts): first-use creation and
 * Settings → "Regenerate MCP Token", which must replace the stored token and
 * restart a running server so the old token stops working immediately.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  MCP_SERVER_PORT,
  MCP_TOKEN_BYTES,
  MCP_TOKEN_CONNECTOR_ID,
  MCP_TOKEN_FIELD,
  getOrCreateToken,
  getOrCreateTokenInLock,
  regenerateToken,
  stopAndConfirmMcpServer,
  type McpServerControl,
  type McpTokenDeps,
} from '../lib/mcp-token';

function makeDeps(initial: string | null = null) {
  const data = new Map<string, string>();
  if (initial) data.set(`${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`, initial);
  let counter = 0;
  const save = jest.fn(async (id: string, field: string, value: string) => {
    data.set(`${id}/${field}`, value);
  });
  const readMirror = jest.fn(async (): Promise<string | null> => null);
  const deps: McpTokenDeps = {
    readMirror,
    store: {
      get: async (id, field) => data.get(`${id}/${field}`) ?? null,
      save,
    },
    randomBytes: jest.fn(async (n: number) => {
      counter += 1;
      return new Uint8Array(n).fill(counter);
    }),
    encode: (bytes) => `tok-${bytes[0]}-${bytes.length}`,
    invalidateMirror: jest.fn(async () => {}),
    revokePriorPrincipal: jest.fn(async () => {}),
    resetOmissionSwitches: jest.fn(async () => {}),
    readFingerprint: async () => initial === null ? null : `digest:${initial}`,
    fingerprintOf: async (token) => `digest:${token}`,
    revokeFingerprint: jest.fn(async () => {}),
    writeFingerprint: jest.fn(async () => {}),
    confirmListenerStopped: jest.fn(async () => {}),
  };
  const stored = () => data.get(`${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`) ?? null;
  return { deps, readMirror, save, stored, data };
}

function expectTombstoneBefore(deps: McpTokenDeps, ...steps: Function[]) {
  expect(deps.revokeFingerprint).toHaveBeenCalledTimes(1);
  expect(deps.writeFingerprint).not.toHaveBeenCalledWith('revoked');
  const tombstoneOrder = jest.mocked(deps.revokeFingerprint).mock.invocationCallOrder[0];
  for (const step of steps) {
    expect(tombstoneOrder).toBeLessThan((step as jest.Mock).mock.invocationCallOrder[0]);
  }
}

/** Fake server: tracks the token the live process accepts. */
function makeServer(running: boolean, initialToken: string | null, opts: { orphanAccepts?: string } = {}) {
  let liveToken: string | null = running ? initialToken : null;
  const calls: string[] = [];
  const server: McpServerControl = {
    isRunning: jest.fn(async () => liveToken !== null),
    stop: jest.fn(async () => {
      calls.push('stop');
      liveToken = null;
      return true;
    }),
    start: jest.fn(async (token: string) => {
      calls.push(`start:${token}`);
      liveToken = token;
      return true;
    }),
    probe: jest.fn(async (token: string) => {
      if (opts.orphanAccepts && token === opts.orphanAccepts) return 405;
      if (liveToken === null) return null;
      return token === liveToken ? 405 : 401;
    }),
    sleep: async () => {},
    revokePending: jest.fn(async () => {
      calls.push('revoke');
    }),
  };
  return { server, calls, live: () => liveToken };
}

describe('getOrCreateToken', () => {
  it.each(['conflicting fingerprint', 'missing digest function'])('recovers an unreconciled token with a %s', async (kind) => {
    const { deps, stored } = makeDeps('old-token');
    if (kind === 'conflicting fingerprint') deps.readFingerprint = async () => 'digest:other-token';
    else delete deps.fingerprintOf;

    await expect(getOrCreateTokenInLock(deps)).resolves.toBe('tok-1-32');
    expect(stored()).toBe('tok-1-32');
    expectTombstoneBefore(deps, deps.invalidateMirror, deps.revokePriorPrincipal, deps.randomBytes, deps.writeFingerprint);
    expect(deps.revokePriorPrincipal).toHaveBeenCalledTimes(1);
  });

  it('adopts an unreconciled token with a matching fingerprint', async () => {
    const { deps, save } = makeDeps('old-token');

    await expect(getOrCreateTokenInLock(deps)).resolves.toBe('old-token');
    expect(deps.writeFingerprint).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('forces recovery even when the reconciled credentials all match', async () => {
    const { deps, data, stored } = makeDeps('old-token');
    await expect(getOrCreateTokenInLock(deps, {
      stored: 'old-token',
      mirror: 'old-token',
      fingerprint: 'digest:old-token',
      fingerprintMismatch: false,
      publishExisting: true,
      forceRecovery: true,
      clearStored: async () => { data.delete(`${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`); },
    })).resolves.toBe('tok-1-32');
    expect(stored()).toBe('tok-1-32');
    expectTombstoneBefore(deps, deps.invalidateMirror, deps.revokePriorPrincipal, deps.randomBytes, deps.writeFingerprint);
    expect(deps.writeFingerprint).toHaveBeenNthCalledWith(1, 'tok-1-32');
  });

  it('tombstones before recovering a stored token after a mirror read failure', async () => {
    const { deps, readMirror, stored } = makeDeps('old-token');
    readMirror.mockRejectedValueOnce(new Error('mirror unreadable'));
    await expect(getOrCreateTokenInLock(deps)).resolves.toBe('tok-1-32');
    expect(stored()).toBe('tok-1-32');
    expectTombstoneBefore(deps, deps.invalidateMirror, deps.revokePriorPrincipal, deps.randomBytes, deps.writeFingerprint);
  });

  it('mints without a stored token after a mirror read failure', async () => {
    const { deps, readMirror, stored } = makeDeps();
    readMirror.mockRejectedValueOnce(new Error('mirror unreadable'));
    await expect(getOrCreateTokenInLock(deps)).resolves.toBe('tok-1-32');
    expect(stored()).toBe('tok-1-32');
  });

  it('generates and reuses a token', async () => {
    const { deps, save, stored } = makeDeps();
    const first = await getOrCreateToken(deps);
    expect(first).toBe(`tok-1-${MCP_TOKEN_BYTES}`);
    expect(stored()).toBe(first);
    expect(await getOrCreateToken(deps)).toBe(first);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('records the minted token before mirroring it', async () => {
    const { deps } = makeDeps();
    deps.onSaved = jest.fn(async () => {});
    const token = await getOrCreateToken(deps);
    expect(deps.writeFingerprint).toHaveBeenCalledWith(token);
    expect(jest.mocked(deps.writeFingerprint).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(deps.onSaved).mock.invocationCallOrder[0],
    );
  });

  it('aborts publication when writing the minted token fingerprint fails', async () => {
    const { deps } = makeDeps();
    deps.onSaved = jest.fn(async () => {});
    jest.mocked(deps.writeFingerprint).mockRejectedValueOnce(new Error('fingerprint not persisted'));
    await expect(getOrCreateToken(deps)).rejects.toThrow('fingerprint not persisted');
    expect(deps.onSaved).not.toHaveBeenCalled();
  });

  it('tombstones during rotation when a failed mirror read is the only evidence', async () => {
    const { deps, readMirror } = makeDeps();
    const { server } = makeServer(false, null);
    readMirror.mockRejectedValueOnce(new Error('mirror unreadable'));
    await expect(regenerateToken(deps, server)).resolves.toMatchObject({ token: 'tok-1-32' });
    expectTombstoneBefore(deps, deps.invalidateMirror, deps.randomBytes, deps.writeFingerprint);
  });

  it('tombstones the old fingerprint before rotation can revoke or save', async () => {
    const { deps, save, stored } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    save.mockRejectedValueOnce(new Error('interrupted save'));

    await expect(regenerateToken(deps, server)).resolves.toMatchObject({ error: 'interrupted save' });

    expect(stored()).toBe('old-token');
    expect(deps.writeFingerprint).not.toHaveBeenCalled();
    expectTombstoneBefore(deps, deps.invalidateMirror, server.stop, server.revokePending, deps.randomBytes, save);
  });

  it('aborts rotation before revocation when the tombstone cannot be committed', async () => {
    const { deps, save } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    jest.mocked(deps.revokeFingerprint).mockRejectedValueOnce(new Error('tombstone not persisted'));

    await expect(regenerateToken(deps, server)).rejects.toThrow('tombstone not persisted');
    expect(deps.invalidateMirror).not.toHaveBeenCalled();
    expect(server.stop).not.toHaveBeenCalled();
    expect(server.revokePending).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps a running server off when writing the regenerated token fingerprint fails', async () => {
    const { deps } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    deps.onSaved = jest.fn(async () => {});
    jest.mocked(deps.writeFingerprint).mockRejectedValueOnce(new Error('fingerprint not persisted'));
    await expect(regenerateToken(deps, server)).resolves.toMatchObject({
      check: 'failed_server_off',
      restarted: false,
      error: 'fingerprint not persisted',
    });
    expect(deps.onSaved).not.toHaveBeenCalled();
    expect(server.start).not.toHaveBeenCalled();
  });

  it('revokes the prior principal before saving or publishing a fresh token', async () => {
    const { deps, save } = makeDeps();
    deps.onSaved = jest.fn(async () => {});
    const revoke = jest.fn(async () => {
      expect(save).not.toHaveBeenCalled();
      expect(deps.onSaved).not.toHaveBeenCalled();
    });
    deps.revokePriorPrincipal = revoke;

    const token = await getOrCreateToken(deps);

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(deps.onSaved).toHaveBeenCalledWith(token);
  });

  it('leaves no token when prior-principal revocation rejects', async () => {
    const { deps, save, stored } = makeDeps();
    const error = new Error('stage-install clear unconfirmed');
    deps.onSaved = jest.fn(async () => {});
    deps.revokePriorPrincipal = jest.fn().mockRejectedValue(error);

    await expect(getOrCreateToken(deps)).rejects.toBe(error);
    expect(save).not.toHaveBeenCalled();
    expect(deps.onSaved).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it('reuses an existing token without revoking the prior principal', async () => {
    const { deps, save } = makeDeps('existing-token');
    const revoke = jest.fn(async () => {});
    deps.revokePriorPrincipal = revoke;

    await expect(getOrCreateToken(deps)).resolves.toBe('existing-token');
    expect(revoke).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('regenerateToken', () => {
  it('replaces the stored token with a new one and leaves a stopped server off', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls } = makeServer(false, 'old-token');
    deps.revokePriorPrincipal = jest.fn(async () => {});
    const result = await regenerateToken(deps, server);
    expect(result.token).not.toBe('old-token');
    expect(stored()).toBe(result.token);
    expect(result).toMatchObject({ wasRunning: false, restarted: false, check: 'not_running' });
    expect(server.start).not.toHaveBeenCalled();
    expect(calls).toEqual(['stop', 'revoke']);
    expect(deps.revokePriorPrincipal).not.toHaveBeenCalled();
    expect(deps.randomBytes).toHaveBeenCalledWith(MCP_TOKEN_BYTES);
  });

  it('stops then restarts a running server with the new token; old token is rejected', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls, live } = makeServer(true, 'old-token');
    const result = await regenerateToken(deps, server);
    // Pending requests from the old token are revoked after the old process
    // is gone and before the new one starts.
    expect(calls).toEqual(['stop', 'revoke', `start:${result.token}`]);
    expect(live()).toBe(result.token);
    expect(stored()).toBe(result.token);
    expect(result).toMatchObject({ wasRunning: true, restarted: true, check: 'verified' });
    expect(await server.probe!('old-token')).toBe(401);
  });

  it.each([true, false])('aborts before save when an orphan still accepts the old token (tracked: %s)', async (running) => {
    const { deps, save, stored } = makeDeps('old-token');
    const { server } = makeServer(running, 'old-token', { orphanAccepts: 'old-token' });

    await expect(regenerateToken(deps, server)).resolves.toMatchObject({
      token: null, restarted: false, check: 'failed_server_off',
    });
    expect(server.stop).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(stored()).toBe('old-token');
  });

  it('probes for an orphan before minting even without a stored token', async () => {
    const { deps, save } = makeDeps();
    const { server } = makeServer(false, null);
    jest.mocked(server.probe!).mockResolvedValue(401);
    deps.confirmListenerStopped = (token) => stopAndConfirmMcpServer(server, token);

    await expect(getOrCreateToken(deps)).rejects.toThrow(/old MCP listener/);
    expect(server.stop).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports restart_failed when the native start fails', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    (server.start as jest.Mock).mockResolvedValueOnce(false);
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ restarted: false, check: 'restart_failed' });
    // The new token is still the stored one: the old one must not come back.
    expect(stored()).toBe(result.token);
  });

  it('keeps the old token if stopping the server throws', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    (server.stop as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await expect(regenerateToken(deps, server)).resolves.toMatchObject({ check: 'failed_server_off', error: 'boom' });
    expect(stored()).toBe('old-token');
  });

  it('leaves the server off with an explicit result when saving fails after stop', async () => {
    const { deps, save, stored } = makeDeps('old-token');
    const { server, calls, live } = makeServer(true, 'old-token');
    save.mockRejectedValueOnce(new Error('keystore unavailable'));
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ token: null, wasRunning: true, restarted: false, check: 'failed_server_off' });
    expect(result.error).toContain('keystore unavailable');
    // Not restarted on the old (possibly leaked) token.
    expect(server.start).not.toHaveBeenCalled();
    expect(live()).toBeNull();
    expect(calls).toEqual(['stop', 'revoke']);
    expect(stored()).toBe('old-token');
  });

  it('leaves the server off when the saved token does not read back', async () => {
    const { deps } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    const realGet = deps.store.get;
    let n = 0;
    deps.store.get = async (id, field) => (++n === 2 ? 'something-else' : realGet(id, field));
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('failed_server_off');
    expect(server.start).not.toHaveBeenCalled();
  });

  it('leaves the server off when revoking pending requests fails', async () => {
    const { deps, save } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    (server.revokePending as jest.Mock).mockRejectedValueOnce(new Error('rm failed'));
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('failed_server_off');
    expect(save).not.toHaveBeenCalled();
    expect(server.start).not.toHaveBeenCalled();
  });

  it('rethrows a save failure when the server was off (nothing to reconcile)', async () => {
    const { deps, save, stored } = makeDeps('old-token');
    const { server } = makeServer(false, 'old-token');
    save.mockRejectedValueOnce(new Error('keystore unavailable'));
    await expect(regenerateToken(deps, server)).rejects.toThrow('keystore unavailable');
    expect(stored()).toBe('old-token');
  });

  it('treats a throwing native start as restart_failed', async () => {
    const { deps } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token');
    (server.start as jest.Mock).mockRejectedValueOnce(new Error('spawn failed'));
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('restart_failed');
  });

  it('never "regenerates" to the same value', async () => {
    const { deps } = makeDeps(`tok-1-${MCP_TOKEN_BYTES}`);
    const { server } = makeServer(false, null);
    const result = await regenerateToken(deps, server);
    expect(result.token).toBe(`tok-2-${MCP_TOKEN_BYTES}`);
  });

  it('works without a probe (unverified) and when no token existed yet', async () => {
    const { deps, stored } = makeDeps(null);
    const { server } = makeServer(true, 'whatever');
    delete server.probe;
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('unverified');
    expect(stored()).toBe(result.token);
  });
});

describe('final in-lock omission switch barrier', () => {
  it.each([false, true])('resets after revocation and aborts the save if OFF is unconfirmed (rotation: %s)', async (rotation) => {
    const { deps, save } = makeDeps(rotation ? 'old-token' : null);
    const { server } = makeServer(rotation, 'old-token');
    let verifiedOff = false;
    const revoke = jest.fn(async () => { verifiedOff = true; });
    deps.revokePriorPrincipal = revoke;
    server.revokePending = revoke;
    deps.resetOmissionSwitches = jest.fn(async () => {
      expect(verifiedOff).toBe(true);
      expect(save).not.toHaveBeenCalled();
      throw new Error('OFF unconfirmed');
    });
    deps.onSaved = jest.fn(async () => {});

    if (rotation) {
      await expect(regenerateToken(deps, server)).resolves.toMatchObject({
        token: null, check: 'failed_server_off', error: 'OFF unconfirmed',
      });
    } else {
      await expect(getOrCreateToken(deps)).rejects.toThrow('OFF unconfirmed');
    }

    expect(deps.resetOmissionSwitches).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(deps.onSaved).not.toHaveBeenCalled();
  });
});

describe('always-allow cascade (purge before the save in revokePending, after it in purgeOtherClientRules)', () => {
  function withPurge(calls: string[], stored: () => string | null, deps: McpTokenDeps) {
    deps.purgeOtherClientRules = jest.fn(async (token: string) => {
      // Runs only once the NEW token is persisted.
      calls.push(`purge-after:${token}:${stored() === token ? 'saved' : 'NOT-SAVED'}`);
    });
    deps.onSaved = jest.fn(async (token: string) => {
      calls.push(`onSaved:${token}`);
    });
    return deps;
  }

  it('regeneration of a running server: revoke (purge-before) → save → purge-after(new token) → mirror → start', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls } = makeServer(true, 'old-token');
    withPurge(calls, stored, deps);
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('verified');
    expect(calls).toEqual(['stop', 'revoke', `purge-after:${result.token}:saved`, `onSaved:${result.token}`, `start:${result.token}`]);
    expect(deps.purgeOtherClientRules).toHaveBeenCalledWith(result.token);
    expect(deps.purgeOtherClientRules).not.toHaveBeenCalledWith('old-token');
  });

  it('a stopped server: the same order, and nothing starts', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls } = makeServer(false, 'old-token');
    withPurge(calls, stored, deps);
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('not_running');
    expect(calls).toEqual(['stop', 'revoke', `purge-after:${result.token}:saved`, `onSaved:${result.token}`]);
  });

  it('an unconfirmed purge-before (revokePending throws) leaves the token and a running server off', async () => {
    const { deps, save, stored } = makeDeps('old-token');
    const { server, calls, live } = makeServer(true, 'old-token');
    withPurge(calls, stored, deps);
    (server.revokePending as jest.Mock).mockRejectedValueOnce(new Error('could not confirm that the MCP always-allow rules were removed'));
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ token: null, check: 'failed_server_off' });
    expect(result.error).toMatch(/always-allow/);
    expect(save).not.toHaveBeenCalled();
    expect(stored()).toBe('old-token');
    expect(deps.purgeOtherClientRules).not.toHaveBeenCalled();
    expect(live()).toBeNull();
  });

  it('an unconfirmed purge-after leaves a running server off (token saved, mirror not rewritten)', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls, live } = makeServer(true, 'old-token');
    withPurge(calls, stored, deps);
    (deps.purgeOtherClientRules as jest.Mock).mockRejectedValueOnce(new Error('purge not confirmed'));
    const result = await regenerateToken(deps, server);
    expect(result).toMatchObject({ wasRunning: true, restarted: false, check: 'failed_server_off' });
    expect(result.token).toBe(stored());
    expect(result.error).toContain('purge not confirmed');
    expect(deps.onSaved).not.toHaveBeenCalled();
    expect(server.start).not.toHaveBeenCalled();
    expect(live()).toBeNull();
  });

  it('an unconfirmed purge-after with the server off is not fatal (old-principal rules cannot match the new token)', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls } = makeServer(false, 'old-token');
    withPurge(calls, stored, deps);
    (deps.purgeOtherClientRules as jest.Mock).mockRejectedValueOnce(new Error('purge not confirmed'));
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('not_running');
    expect(stored()).toBe(result.token);
    expect(deps.onSaved).toHaveBeenCalledWith(result.token);
  });

  it('first creation: purge-after runs with the new token, best-effort', async () => {
    const calls: string[] = [];
    const { deps, stored } = makeDeps(null);
    withPurge(calls, stored, deps);
    (deps.purgeOtherClientRules as jest.Mock).mockRejectedValueOnce(new Error('purge not confirmed'));
    const token = await getOrCreateToken(deps);
    expect(stored()).toBe(token);
    expect(deps.purgeOtherClientRules).toHaveBeenCalledWith(token);
    expect(deps.onSaved).toHaveBeenCalledWith(token);
    // An existing token is reused without another purge.
    await getOrCreateToken(deps);
    expect(deps.purgeOtherClientRules).toHaveBeenCalledTimes(1);
  });

  it('the hook wires both steps: revokePending purges (tokenRevoked) and purgeOtherClientRules purges by the new principal', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'hooks/use-mcp-server-bridge.ts'), 'utf8');
    expect(src).toMatch(/revokePending: \(\) => revokePendingMCPRequests\(\{ tokenRevoked: true \}\)/);
    expect(src).toMatch(/purgeOtherClientRules: \(token\) => purgeMcpAlwaysAllowRulesForNewToken\(token, expoSha256\)/);
    // The plain server start must not wipe the rules.
    expect(src).toMatch(/await revokePendingMCPRequests\(\);/);
  });
});

describe('native/script wiring', () => {
  const root = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

  it('MCPBridge.stop waits for the process to exit and falls back to a forced kill', () => {
    const src = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/MCPBridge.kt');
    const stop = src.slice(src.indexOf('fun stop(context: Context)'), src.indexOf('internal fun isListenerPresent'));
    expect(stop).toMatch(/proc\.destroy\(\)/);
    expect(stop).toMatch(/waitForExit\(proc, STOP_GRACE_MS\)/);
    expect(stop).toMatch(/forceKill\(proc\)/);
    expect(src).toContain(`PORT = ${MCP_SERVER_PORT}`);
  });

  it('MCPBridge guards the API 26 Process methods (minSdk 24)', () => {
    const src = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/MCPBridge.kt');
    // Every API-26 call sits right behind an SDK_INT >= O check.
    for (const call of ['proc.isAlive', 'proc.waitFor(', 'proc.destroyForcibly()']) {
      const idx = src.indexOf(call);
      expect(idx).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, idx - 120), idx)).toMatch(/SDK_INT >= Build\.VERSION_CODES\.O/);
      expect(src.split(call).length - 1).toBe(1);
    }
    expect(src).toMatch(/exitValue\(\)/);
    expect(src).not.toMatch(/process\?\.isAlive/);
  });

  it('the server script drops open connections on SIGTERM and the APK asset mirrors it', () => {
    const script = read('scripts/shelly-mcp-server.js');
    expect(script).toMatch(/process\.on\('SIGTERM'[\s\S]*closeAllConnections[\s\S]*process\.exit\(0\)/);
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js')).toBe(script);
  });
});
