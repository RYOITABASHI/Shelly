/**
 * lib/mcp-token.ts — MCP server bearer-token lifecycle (create / regenerate).
 *
 * Pure logic with injected dependencies so it can be unit-tested without
 * expo-crypto / SecureStore / the native module. The real wiring lives in
 * hooks/use-mcp-server-bridge.ts.
 *
 * Why regeneration restarts the server: the native MCPBridge passes the token
 * to scripts/shelly-mcp-server.js once, via the SHELLY_MCP_TOKEN env var, and
 * the script checks every request against that in-process value. Replacing
 * the stored token alone would leave the running process accepting the old
 * one. Legacy Mcp-Session-Id sessions and MRTR requestState are in-process
 * memory too (and auth is checked before any session lookup), so killing the
 * process is what invalidates them — there is no on-disk session cache.
 */

export const MCP_TOKEN_CONNECTOR_ID = 'mcp-server';
export const MCP_TOKEN_FIELD = 'token';
export const MCP_TOKEN_BYTES = 32;
/** Must match MCPBridge.kt PORT. */
export const MCP_SERVER_PORT = 8767;

export interface McpTokenStore {
  get(connectorId: string, field: string): Promise<string | null>;
  save(connectorId: string, field: string, value: string): Promise<void>;
}

export interface McpTokenDeps {
  store: McpTokenStore;
  randomBytes(n: number): Promise<Uint8Array>;
  encode(bytes: Uint8Array): string;
}

export interface McpServerControl {
  isRunning(): Promise<boolean>;
  start(token: string): Promise<boolean>;
  stop(): Promise<void>;
  /**
   * Optional HTTP probe: resolves the status code a request to the local
   * server returns with `Authorization: Bearer <token>`, or null when nothing
   * answers. Used to confirm the old token is really rejected.
   */
  probe?(token: string): Promise<number | null>;
  sleep?(ms: number): Promise<void>;
  /**
   * Cancels everything accepted under the old token: denies/closes pending
   * approvals, invalidates in-flight calls and clears the file queue
   * (lib/mcp-server-bridge.ts revokePendingMCPRequests). Runs inside the
   * lock, after stop() and before start(newToken).
   */
  revokePending?(): Promise<void>;
}

// Serializes server start/stop/regenerate so the bridge hook's startup and a
// Settings-triggered regeneration can't interleave (e.g. the hook spawning a
// process with the old token right after regeneration restarted it).
let chain: Promise<unknown> = Promise.resolve();
export function withMcpServerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function generateToken(deps: McpTokenDeps): Promise<string> {
  const bytes = await deps.randomBytes(MCP_TOKEN_BYTES);
  if (!bytes || bytes.length !== MCP_TOKEN_BYTES) {
    throw new Error('random token generation returned the wrong length');
  }
  const token = deps.encode(bytes);
  if (!token) throw new Error('random token generation returned an empty token');
  return token;
}

/** Returns the stored token, generating and saving one on first use. */
export async function getOrCreateToken(deps: McpTokenDeps): Promise<string> {
  const existing = await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
  if (existing) return existing;
  const token = await generateToken(deps);
  await deps.store.save(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD, token);
  return token;
}

export type RegenerateResult = {
  /** The new token, or null when it could not be saved ('failed_server_off'). */
  token: string | null;
  /** Set with 'failed_server_off'. */
  error?: string;
  /** The server was running before regeneration. */
  wasRunning: boolean;
  /** The server was restarted with the new token. */
  restarted: boolean;
  /**
   * Only meaningful when wasRunning:
   *  - 'verified'          probe: old token 401 (or nothing on the old port), new token accepted
   *  - 'unverified'        no probe available; restart reported success
   *  - 'restart_failed'    the new server did not come up
   *  - 'old_token_accepted' something on the port still accepts the old token
   *                        (e.g. an orphaned server from an earlier app process)
   *  - 'failed_server_off' the server was stopped, then revoking pending
   *                        requests or saving the new token failed; it was
   *                        left off rather than restarted on a possibly
   *                        leaked token
   * Both 'restart_failed' and 'failed_server_off' mean the server is now off.
   */
  check: 'verified' | 'unverified' | 'restart_failed' | 'old_token_accepted' | 'not_running' | 'failed_server_off';
};

const PROBE_ATTEMPTS = 16;
const PROBE_INTERVAL_MS = 500;

/**
 * Replaces the stored token with a fresh random one. If the server is
 * running, it is stopped (MCPBridge.stop waits for the process to exit) and
 * started again with the new token, then — when a probe is available — the
 * old token is checked to be rejected. When the server is off it stays off.
 */
export async function regenerateToken(
  deps: McpTokenDeps,
  server: McpServerControl,
): Promise<RegenerateResult> {
  return withMcpServerLock(async () => {
    const oldToken = await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
    let token = await generateToken(deps);
    // Astronomically unlikely, but never "regenerate" to the same value.
    if (oldToken && token === oldToken) token = await generateToken(deps);
    if (oldToken && token === oldToken) throw new Error('random token generation repeated the old token');

    const wasRunning = await server.isRunning();
    // Stop first so the old process is gone before the new token is
    // persisted; if stop throws, nothing has changed yet.
    if (wasRunning) await server.stop();
    try {
      // Nothing accepted under the old token may survive: pending approvals,
      // in-flight calls and queued request/result files.
      if (server.revokePending) await server.revokePending();
      await deps.store.save(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD, token);
      const persisted = await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
      if (persisted !== token) throw new Error('new MCP token was not saved');
    } catch (e) {
      if (!wasRunning) throw e;
      // The server is already stopped. Restarting it with whatever is stored
      // could mean the leaked token, so it stays off and the caller is told
      // explicitly (the UI turns the MCP Server setting off to match).
      return {
        token: null,
        wasRunning,
        restarted: false,
        check: 'failed_server_off',
        error: String((e as any)?.message || e),
      };
    }

    if (!wasRunning) return { token, wasRunning, restarted: false, check: 'not_running' };

    let started = false;
    try {
      started = await server.start(token);
    } catch {
      started = false;
    }
    if (!started) return { token, wasRunning, restarted: false, check: 'restart_failed' };
    if (!server.probe) return { token, wasRunning, restarted: true, check: 'unverified' };

    const sleep = server.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // Wait for the new process to listen: an authorized GET is answered 405
    // (method not allowed) by the script; an unauthorized one 401.
    let newStatus: number | null = null;
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      newStatus = await server.probe(token);
      if (newStatus !== null) break;
      await sleep(PROBE_INTERVAL_MS);
    }
    if (oldToken) {
      const oldStatus = await server.probe(oldToken);
      if (oldStatus !== null && oldStatus !== 401) {
        return { token, wasRunning, restarted: true, check: 'old_token_accepted' };
      }
    }
    if (newStatus === null || newStatus === 401 || !(await server.isRunning())) {
      return { token, wasRunning, restarted: false, check: 'restart_failed' };
    }
    return { token, wasRunning, restarted: true, check: 'verified' };
  });
}
