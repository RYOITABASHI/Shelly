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
  regenerateToken,
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
  const deps: McpTokenDeps = {
    store: {
      get: async (id, field) => data.get(`${id}/${field}`) ?? null,
      save,
    },
    randomBytes: jest.fn(async (n: number) => {
      counter += 1;
      return new Uint8Array(n).fill(counter);
    }),
    encode: (bytes) => `tok-${bytes[0]}-${bytes.length}`,
  };
  const stored = () => data.get(`${MCP_TOKEN_CONNECTOR_ID}/${MCP_TOKEN_FIELD}`) ?? null;
  return { deps, save, stored };
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
  it('generates and stores a token on first use, then reuses it', async () => {
    const { deps, save, stored } = makeDeps();
    const first = await getOrCreateToken(deps);
    expect(first).toBe(`tok-1-${MCP_TOKEN_BYTES}`);
    expect(stored()).toBe(first);
    expect(await getOrCreateToken(deps)).toBe(first);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('regenerateToken', () => {
  it('replaces the stored token with a new one and leaves a stopped server off', async () => {
    const { deps, stored } = makeDeps('old-token');
    const { server, calls } = makeServer(false, 'old-token');
    const result = await regenerateToken(deps, server);
    expect(result.token).not.toBe('old-token');
    expect(stored()).toBe(result.token);
    expect(result).toMatchObject({ wasRunning: false, restarted: false, check: 'not_running' });
    expect(server.start).not.toHaveBeenCalled();
    expect(server.stop).not.toHaveBeenCalled();
    expect(calls).toEqual(['revoke']);
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

  it('reports an orphaned process that still accepts the old token', async () => {
    const { deps } = makeDeps('old-token');
    const { server } = makeServer(true, 'old-token', { orphanAccepts: 'old-token' });
    const result = await regenerateToken(deps, server);
    expect(result.check).toBe('old_token_accepted');
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
    await expect(regenerateToken(deps, server)).rejects.toThrow('boom');
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

describe('native/script wiring', () => {
  const root = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

  it('MCPBridge.stop waits for the process to exit and falls back to a forced kill', () => {
    const src = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/MCPBridge.kt');
    const stop = src.slice(src.indexOf('fun stop()'));
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
