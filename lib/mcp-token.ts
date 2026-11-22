/**
 * lib/mcp-token.ts — MCP server bearer-token lifecycle (create / regenerate).
 *
 * Pure logic with injected dependencies so it can be unit-tested without
 * expo-crypto / SecureStore / the native module. The real wiring lives in
 * hooks/use-mcp-server-bridge.ts.
 *
 * Why regeneration restarts the server: the native MCPBridge passes the token
 * to scripts/shelly-mcp-server.js once at start, on the process's stdin
 * (line 1; never in the environment, see MCPBridge.kt), and the script
 * checks every request against that in-process value. Replacing
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
  /**
   * Called after a NEW token was persisted (first creation, regeneration),
   * so the native auto-start mirror (lib/mcp-autostart-mirror.ts) follows
   * the token. Creation: best-effort (a failure only means no auto-start;
   * the mirror clears itself). Regeneration of a running server: a failure
   * leaves the server off ('failed_server_off'), never restarted while the
   * native copy might still hold the old token.
   */
  onSaved?(token: string): Promise<void>;
  /** Resolves null for an absent mirror and rejects when the mirror state is unknown. */
  readMirror?(): Promise<string | null>;
  readFingerprint(): Promise<string | null>;
  fingerprintOf?(token: string): Promise<string>;
  /** Writes the SHA-256 fingerprint of a token or the revocation sentinel. */
  revokeFingerprint(): Promise<void>;
  writeFingerprint(token: string): Promise<void>;
  /**
   * The always-allow cascade's second step (lib/mcp-always-allow.ts
   * purgeMcpAlwaysAllowRulesForNewToken): called right after a NEW token was
   * persisted and read back, before onSaved, to remove every rule not keyed to
   * the new token's principal (e.g. one added under the old token by a call
   * that raced the lock; the first step is revokePending, before the save).
   * Throws when not confirmed. Regeneration of a running server: a failure
   * leaves it off ('failed_server_off'). Creation / a stopped server:
   * best-effort (old-principal rules can never match the new token anyway).
   */
  purgeOtherClientRules?(token: string): Promise<void>;
  /**
   * Durably invalidates the native auto-start mirror (clears it; natively
   * this also stops the server). Called BEFORE a token is replaced or
   * created, so a process death between "new token saved" and "mirror
   * updated" can never leave a mirror that still holds the old token for a
   * reboot / sticky service restart to bring back. Throws when the mirror
   * could not be cleared; the token is then left unchanged.
   */
  invalidateMirror(): Promise<void>;
  /**
   * Called before saving a freshly minted token when no token was stored
   * (first run or credential-store recovery). Revokes the prior principal:
   * advances the queue epoch, denies pending approvals, deletes queued
   * request/result files, durably clears the persisted stage-install outcome
   * with confirmation, and removes always-allow rules. Like invalidateMirror,
   * a rejection aborts the mint and leaves no token.
   */
  revokePriorPrincipal(): Promise<void>;
  resetOmissionSwitches(): Promise<void>;
  confirmListenerStopped(oldToken: string | null): Promise<void>;
}

export interface McpServerControl {
  isRunning(): Promise<boolean>;
  start(token: string): Promise<boolean>;
  stop(): Promise<boolean>;
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
   * (lib/mcp-server-bridge.ts revokePendingMCPRequests), and removes every
   * MCP always-allow rule (the cascade's first step). Runs inside the lock,
   * after stop() and before the new token is saved; a throw leaves the token
   * unchanged and a running server off.
   */
  revokePending(): Promise<void>;
}

// Serializes server start/stop, token creation and regeneration, and every
// native mirror write, so the bridge hook's startup, Settings showing the
// token (creation) and a Settings-triggered regeneration can't interleave
// (e.g. the hook spawning a process with the old token right after
// regeneration restarted it, or a creation paused in random generation
// resuming after a regeneration and saving / mirroring a stale token).
// Not re-entrant: code already inside the lock calls the *InLock variants.
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

/**
 * Returns the stored token, generating and saving one on first use. Takes
 * withMcpServerLock, so it can never interleave with a regeneration. Callers
 * that already hold the lock use getOrCreateTokenInLock.
 */
export function getOrCreateToken(deps: McpTokenDeps): Promise<string> {
  return withMcpServerLock(() => getOrCreateTokenInLock(deps));
}

/** getOrCreateToken for code already running inside withMcpServerLock. */
export async function getOrCreateTokenInLock(
  deps: McpTokenDeps,
  reconciled?: {
    stored: string | null;
    mirror: string | null;
    mirrorUnknown?: boolean;
    fingerprint: string | null;
    fingerprintMismatch: boolean;
    publishExisting: boolean;
    forceRecovery?: boolean;
    clearStored(): Promise<void>;
  },
): Promise<string> {
  const existing = reconciled
    ? reconciled.stored
    : await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
  let mirror = reconciled?.mirror ?? null;
  let mirrorUnknown = reconciled?.mirrorUnknown === true;
  if (!reconciled) {
    try {
      mirror = (await deps.readMirror?.()) ?? null;
    } catch {
      mirrorUnknown = true;
    }
  }
  const fingerprint = reconciled ? reconciled.fingerprint : await deps.readFingerprint();
  const fingerprintMismatch = reconciled
    ? reconciled.fingerprintMismatch
    : Boolean(existing && fingerprint !== null && await deps.fingerprintOf?.(existing) !== fingerprint);
  if (!reconciled?.forceRecovery && existing && !mirrorUnknown && !fingerprintMismatch && (!mirror || mirror === existing)) {
    if (reconciled?.publishExisting || fingerprint === null) {
      try {
        await deps.writeFingerprint(existing);
      } catch (error) {
        await deps.invalidateMirror();
        throw error;
      }
    }
    return existing;
  }
  // Persist the revocation marker before touching either credential copy.
  if (existing !== null || mirror !== null || mirrorUnknown || fingerprint !== null) {
    await deps.revokeFingerprint();
  }
  // A confirmed deletion keeps recovery pending if the process dies after
  // the mirror is cleared, before a fresh token can be published.
  if (reconciled && existing) {
    await reconciled.clearStored();
    if (await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD) !== null) {
      throw new Error('could not confirm that the stored MCP token was cleared');
    }
  }
  await deps.invalidateMirror();
  await deps.confirmListenerStopped(mirror ?? existing);
  await deps.revokePriorPrincipal();
  const token = await generateToken(deps);
  if (token === existing || token === mirror) throw new Error('random token generation repeated a prior token');
  await saveNewTokenInLock(deps, token);
  if (deps.purgeOtherClientRules) {
    try {
      await deps.purgeOtherClientRules(token);
    } catch {
      // Best-effort: a rule keyed to another principal never matches this token.
    }
  }
  // Replace the fingerprint in one commit so recovery never creates a
  // window in which a stale SecureStore token could look like bootstrap.
  await deps.writeFingerprint(token);
  if (deps.onSaved) {
    try {
      await deps.onSaved(token);
    } catch {
      // Best-effort: the in-app server still works; auto-start stays off.
    }
  }
  return token;
}

export type RegenerateResult = {
  /** The new token, or null when it could not be saved ('failed_server_off' from a save failure). */
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
   *  - 'failed_server_off' the server was stopped, then invalidating the
   *                        native mirror, revoking pending requests or
   *                        saving the new token failed; it was
   *                        left off rather than restarted on a possibly
   *                        leaked token. Also when the new token was saved
   *                        but the native auto-start mirror could not be
   *                        updated (deps.onSaved threw; token is then set),
   *                        or the always-allow rules of other tokens could not
   *                        be confirmed removed (deps.purgeOtherClientRules
   *                        threw; token is then set)
   * 'failed_server_off' also reports an unconfirmed stop or fingerprint write.
   */
  check: 'verified' | 'unverified' | 'restart_failed' | 'not_running' | 'failed_server_off';
};

const PROBE_ATTEMPTS = 16;
const PROBE_INTERVAL_MS = 500;

export async function stopAndConfirmMcpServer(
  server: McpServerControl,
  oldToken: string | null,
): Promise<void> {
  const stopped = await server.stop();
  if (server.probe) {
    const sleep = server.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let status = await server.probe(oldToken ?? '');
    for (let attempt = 1; status !== null && attempt < PROBE_ATTEMPTS; attempt++) {
      await sleep(PROBE_INTERVAL_MS);
      status = await server.probe(oldToken ?? '');
    }
    if (status !== null) throw new Error('could not confirm that the old MCP listener stopped');
  }
  // Native also checks the process handle and listener, including when an
  // HTTP probe times out or a listener disappears during the wait.
  if (stopped !== true && await server.stop() !== true) {
    throw new Error('could not confirm that the old MCP server stopped');
  }
}

async function saveNewTokenInLock(deps: McpTokenDeps, token: string): Promise<void> {
  await deps.resetOmissionSwitches();
  await deps.store.save(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD, token);
  const persisted = await deps.store.get(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD);
  if (persisted !== token) throw new Error('new MCP token was not saved');
}

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
    const wasRunning = await server.isRunning();
    // The sentinel cannot be a minted bearer. Leave it in place until publication.
    let hasEvidence = oldToken !== null || await deps.readFingerprint() !== null;
    if (!hasEvidence) {
      try {
        hasEvidence = ((await deps.readMirror?.()) ?? null) !== null;
      } catch {
        hasEvidence = true;
      }
    }
    if (hasEvidence) {
      await deps.revokeFingerprint();
    }
    // Invalidate the native auto-start mirror before revoking the principal:
    // if Shelly dies anywhere after this point, a reboot / sticky restart
    // finds no mirror instead of one holding the old (revoked) token. The
    // new mirror is written only after the new token is persisted (onSaved).
    try {
      await deps.invalidateMirror();
    } catch (e) {
      if (!wasRunning) throw e;
      // The old token is unchanged; a running server is stopped rather
      // than left serving next to a mirror we could not invalidate.
      try {
        await server.stop();
      } catch {
        // Best-effort; reported as off either way.
      }
      return {
        token: null,
        wasRunning,
        restarted: false,
        check: 'failed_server_off',
        error: String((e as any)?.message || e),
      };
    }
    try {
      await stopAndConfirmMcpServer(server, oldToken);
    } catch (e) {
      return {
        token: null,
        wasRunning,
        restarted: false,
        check: 'failed_server_off',
        error: String((e as any)?.message || e),
      };
    }
    let token: string;
    try {
      await server.revokePending();
      token = await generateToken(deps);
      // Astronomically unlikely, but never "regenerate" to the same value.
      if (oldToken && token === oldToken) token = await generateToken(deps);
      if (oldToken && token === oldToken) throw new Error('random token generation repeated the old token');
      await saveNewTokenInLock(deps, token);
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

    if (deps.purgeOtherClientRules) {
      try {
        await deps.purgeOtherClientRules(token);
      } catch (e) {
        // Rules from the old token might remain (they can't match the new
        // principal, but the cascade is not confirmed): a server that was
        // running stays off, like a mirror that could not follow.
        if (wasRunning) {
          return {
            token,
            wasRunning,
            restarted: false,
            check: 'failed_server_off',
            error: String((e as any)?.message || e),
          };
        }
      }
    }

    try {
      await deps.writeFingerprint(token);
    } catch (e) {
      if (!wasRunning) throw e;
      return {
        token,
        wasRunning,
        restarted: false,
        check: 'failed_server_off',
        error: String((e as any)?.message || e),
      };
    }

    if (deps.onSaved) {
      try {
        await deps.onSaved(token);
      } catch (e) {
        // The native auto-start copy could not follow the new token (it
        // cleared itself). A server that was running stays off rather than
        // coming back next to a native copy that might hold the old token.
        if (wasRunning) {
          return {
            token,
            wasRunning,
            restarted: false,
            check: 'failed_server_off',
            error: String((e as any)?.message || e),
          };
        }
      }
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
        await server.stop().catch(() => {});
        return {
          token, wasRunning, restarted: false, check: 'failed_server_off',
          error: 'the old MCP token still answers after restart',
        };
      }
    }
    if (newStatus === null || newStatus === 401 || !(await server.isRunning())) {
      return { token, wasRunning, restarted: false, check: 'restart_failed' };
    }
    return { token, wasRunning, restarted: true, check: 'verified' };
  });
}
