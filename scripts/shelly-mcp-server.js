#!/usr/bin/env node
/*
 * shelly-mcp-server.js — minimal MCP (Model Context Protocol) server.
 *
 * Exposes tools so an MCP client on the same network (Claude Code, Claude
 * Desktop) can inspect — and, opt-in, act on — this Shelly instance:
 * read-only (always available once the server is on) — terminal output,
 * git status, registered agents, configured repos; exec/write (gated
 * behind settings.mcpExecEnabled, off by default, checked per-call in
 * lib/mcp-server-bridge.ts) — run_command and write_file. This is the
 * ingress-side capability gate this file's comment used to say didn't
 * exist: every exec/write call blocks on an in-app approval tap
 * (components/McpApprovalModal.tsx, fail-closed on timeout) and a
 * CRITICAL-risk command (lib/command-safety.ts) is refused outright
 * regardless of approval. The pre-existing capability broker
 * (lib/capability-envelope.ts / scripts/shelly-capability-broker.js) still
 * only gates OUTGOING agent requests — unrelated to this ingress path.
 *
 * Transport: Streamable HTTP, a single POST /mcp endpoint, JSON responses
 * only (no SSE — every read-only tool here is fast and synchronous). The
 * server is DUAL-ERA (spec 2026-07-28, "Versioning and Compatibility"):
 *
 *   - Legacy (2025-03-26 / 2025-06-18 / 2025-11-25): the `initialize` +
 *     `notifications/initialized` handshake and an Mcp-Session-Id session,
 *     unchanged from before. Claude Code / Claude Desktop still default to
 *     this flow for a locally-run server (verified 2026-09-16), so it must
 *     keep working as-is.
 *   - Modern (2026-07-28): stateless. No handshake, no session — every
 *     request carries `io.modelcontextprotocol/protocolVersion` +
 *     `clientCapabilities` in `params._meta`, mirrored into the
 *     MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, which are
 *     validated against the body (HeaderMismatch -32020). Unknown versions
 *     get UnsupportedProtocolVersion (-32022) listing what we support;
 *     `server/discover` is implemented; every result carries `resultType`
 *     and `_meta['io.modelcontextprotocol/serverInfo']`; tools/list is a
 *     CacheableResult (ttlMs + cacheScope).
 *
 * The era is chosen per request from how the client opens: `initialize`
 * selects legacy; per-request `_meta` (or a non-legacy MCP-Protocol-Version
 * header) selects modern. Neither era relies on a feature 2026-07-28
 * deprecated or removed: we never sent Roots / Sampling / Logging or any
 * server-initiated request, and `ping` is answered for legacy sessions only.
 *
 * Approval waits under 2026-07-28 use Multi Round-Trip Requests (MRTR):
 * instead of holding one POST open for up to 90s while the phone shows its
 * approval modal, a modern run_command / write_file returns an
 * InputRequiredResult carrying only an HMAC-protected `requestState` (no
 * `inputRequests` — the decision belongs to the PHONE OWNER, never the
 * remote client, so it is deliberately NOT elicited from the client; that
 * would move the trust boundary onto the very peer this gate distrusts).
 * The client retries with the echoed state and the server long-polls the
 * SAME pending on-device call — a retry can never start a second
 * execution, and a tampered / expired / mismatched / already-consumed state
 * is rejected without touching the queue (fail-closed). Legacy peers keep
 * the blocking single-POST behavior.
 *
 * Auth: a pre-shared bearer token (Authorization: Bearer <token>), checked
 * on every request in both eras. OAuth 2.1 is spec-OPTIONAL, and a static
 * token is an accepted pattern for a personal/local-network server (see
 * this project's MCP research notes) — not a compliance shortcut — so the
 * 2026-07-28 authorization hardening (RFC 9207 `iss`, DCR deprecation,
 * issuer-bound client credentials) has no surface here. A present Origin
 * header that isn't loopback is refused with 403 (the DNS-rebinding guard
 * the transport spec requires). The token is generated on first enable and
 * stored via the app's own SecureStore (lib/secure-store.ts), same as every
 * other API key; this script reads it from an env var at spawn time, never
 * from argv.
 *
 * No npm dependencies — Node built-ins only, same reasoning as
 * scripts/shelly-gemini-live-client.js / shelly-a2a-server.js. (The
 * official TS SDK supports 2026-07-28 but pulls express/hono/ajv/zod — not
 * shippable as the single APK asset the bundled node runs.)
 *
 * IPC with the RN app: the SAME bidirectional file-queue bridge pattern as
 * shelly-a2a-server.js (this process can't reach RN's JS state directly).
 *
 * Usage: node shelly-mcp-server.js <queueDir> <port>
 * Env:   SHELLY_MCP_TOKEN — required bearer token
 *
 * When require()d (host Jest tests) nothing starts; createMcpHandler and
 * the protocol constants are exported instead.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RESULT_POLL_MS = 250;
// run_command / write_file wait on an in-app approval tap (up to 90s,
// lib/mcp-server-bridge.ts's APPROVAL_TIMEOUT_MS) before answering — this
// has to comfortably outlast that, not just the read-only tools' instant replies.
const RESULT_TIMEOUT_MS = 100_000;

// ── Protocol versions ────────────────────────────────────────────────────
const MODERN_VERSIONS = ['2026-07-28'];
// Newest first. Our legacy surface (tools only, JSON responses) is the same
// across these three, so echoing whichever one the client asked for is honest.
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const SERVER_INFO = { name: 'shelly', version: '1.1.0' };
const SERVER_CAPABILITIES = { tools: {} };
const SERVER_INSTRUCTIONS =
  'Shelly is an Android terminal running on the user\'s phone. run_command and write_file '
  + 'are disabled unless the user enabled them, and every call waits for an approval tap on the phone.';

// JSON-RPC / MCP error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const LEGACY_SESSION_ERROR = -32000; // legacy implementation-defined sub-range (grandfathered)
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
// Vendor-prefixed hint on an InputRequiredResult so a client UI has
// something to show while it retries. Informational only.
const META_APPROVAL_STATUS = 'dev.shelly/approvalStatus';

// tools/list + server/discover never change while this process runs (the
// exec/write gate is enforced per call, not by hiding tools), so a long TTL
// is truthful. "private": every result sits behind a per-device bearer token.
const LIST_TTL_MS = 3_600_000;
const LIST_CACHE_SCOPE = 'private';

// MRTR timings. The first modern exec/write call holds briefly in case the
// bridge answers at once (gate disabled / CRITICAL refusal / instant tap);
// each retry long-polls so a client that retries immediately (allowed when
// there are no inputRequests) doesn't spin.
const MRTR_INITIAL_HOLD_MS = 1_500;
const MRTR_RETRY_HOLD_MS = 20_000;
// requestState lifetime: the bridge's own result deadline plus a grace
// window to collect an answer that landed right at the end.
const MRTR_STATE_TTL_MS = RESULT_TIMEOUT_MS + 60_000;
// Tools whose call blocks on an on-device approval tap.
const APPROVAL_TOOLS = new Set(['run_command', 'write_file']);

// Methods whose Mcp-Name header mirrors params.name / params.uri.
const NAMED_METHODS = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const TOOLS = [
  {
    name: 'read_terminal_output',
    description: 'Read recent output from a Shelly terminal session. Omit sessionId for the active session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Terminal session id (optional — defaults to the active one)' },
        maxLines: { type: 'number', description: 'Max lines to return (default 200)' },
      },
    },
  },
  {
    name: 'git_status',
    description: 'Run `git status` in a repo Shelly has configured (see list_repos for valid paths).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute repo path on the device' } },
      required: ['path'],
    },
  },
  {
    name: 'list_agents',
    description: 'Lists the Shelly agents registered on this device.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_repos',
    description: 'Lists the repository paths configured in Shelly\'s Sidebar.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_command',
    description: 'Runs a shell command on the device. Disabled unless the user turned on Settings → Agents → "MCP: Allow exec/write", and every call still blocks on an in-app approval tap on the phone — expect this to be slow or to fail with "denied" if nobody is there to approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (optional — one of list_repos or the home dir)' },
        timeoutMs: { type: 'number', description: 'Execution timeout in ms (default 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Writes a file on the device, scoped to the home dir or a repo from list_repos. Disabled unless the user turned on Settings → Agents → "MCP: Allow exec/write", and every call still blocks on an in-app approval tap.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path under the home dir or a configured repo' },
        content: { type: 'string', description: 'File content to write (overwrites the existing file)' },
      },
      required: ['path', 'content'],
    },
  },
];

// ── File-queue IPC (production callTool) ─────────────────────────────────

// Same request/result file-queue round trip as shelly-a2a-server.js — see
// that script's waitForResult for the full rationale.
function createFileQueueCallTool(queueDir) {
  const requestsDir = path.join(queueDir, 'requests');
  const resultsDir = path.join(queueDir, 'results');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  function waitForResult(callId) {
    return new Promise((resolve) => {
      const resultPath = path.join(resultsDir, `${callId}.json`);
      const deadline = Date.now() + RESULT_TIMEOUT_MS;
      const tick = () => {
        if (fs.existsSync(resultPath)) {
          try {
            const raw = fs.readFileSync(resultPath, 'utf8');
            fs.unlinkSync(resultPath);
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve({ ok: false, error: `unreadable result: ${e.message}` });
          }
          return;
        }
        if (Date.now() > deadline) {
          resolve({ ok: false, error: 'timed out waiting for the app to answer (is Shelly running?)' });
          return;
        }
        setTimeout(tick, RESULT_POLL_MS);
      };
      tick();
    });
  }

  return function callTool(toolName, args) {
    const callId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(requestsDir, `${callId}.json`),
      JSON.stringify({ callId, tool: toolName, args: args || {}, receivedAt: new Date().toISOString() }),
    );
    return waitForResult(callId);
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** Single header value, or undefined when absent / duplicated (a duplicated
 *  mirrored header is treated as malformed by the caller). */
function headerValue(headers, name) {
  const v = headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : null;
  return v;
}

/** Decodes the `=?base64?…?=` sentinel form allowed for Mcp-Name. */
function decodeHeaderValue(value) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (!m) return value;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

/** Key-sorted JSON so the same arguments always digest the same. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function toolResultBody(result) {
  return {
    content: [{ type: 'text', text: result.ok ? JSON.stringify(result.data) : `Error: ${result.error}` }],
    isError: !result.ok,
  };
}

/** Resolves to true if `promise` settled within `ms`, false otherwise; the
 *  timer is always cleared so it never keeps the event loop alive. */
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ── Handler ──────────────────────────────────────────────────────────────

/**
 * Builds the transport-agnostic request handler.
 *   opts.token     — bearer token (required)
 *   opts.callTool  — (tool, args) => Promise<{ok, data} | {ok:false, error}>
 *   opts.now       — clock (tests)
 *   opts.stateKey  — HMAC key for MRTR requestState (random per process by
 *                    default: a restart invalidates every outstanding state,
 *                    which fails closed)
 *   opts.initialHoldMs / opts.retryHoldMs — MRTR hold windows (tests)
 *   opts.log       — diagnostic sink
 * Returns handle({ method, url, headers, body }) → Promise<{ status, headers, body }>
 * where `headers` are lower-cased request headers and `body` is the raw string.
 */
function createMcpHandler(opts) {
  const token = opts.token;
  const callTool = opts.callTool;
  const now = opts.now || (() => Date.now());
  const stateKey = opts.stateKey || crypto.randomBytes(32);
  const initialHoldMs = opts.initialHoldMs ?? MRTR_INITIAL_HOLD_MS;
  const retryHoldMs = opts.retryHoldMs ?? MRTR_RETRY_HOLD_MS;
  const log = opts.log || (() => {});
  if (!token || typeof callTool !== 'function') throw new Error('createMcpHandler: token and callTool are required');

  const principal = sha256Hex(`shelly-mcp-principal:${token}`).slice(0, 32);
  const legacySessions = new Set();
  // callId → { tool, digest, promise, settled, result, expiresAt }. The
  // on-device call lives here, server-side, so requestState is only a
  // signed pointer to it — never the authority for anything.
  const pendingApprovals = new Map();

  const json = (status, payload, extraHeaders) => ({
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: payload === null ? null : JSON.stringify(payload),
  });

  // ── MRTR requestState (HMAC-SHA256 over a base64url JSON payload) ──
  function signState(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', stateKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  function verifyState(state) {
    if (typeof state !== 'string' || state.length > 4096) return null;
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    const expected = Buffer.from(crypto.createHmac('sha256', stateKey).update(parts[0]).digest('base64url'));
    const actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return isPlainObject(payload) && payload.v === 1 ? payload : null;
    } catch {
      return null;
    }
  }

  function sweepPending() {
    const t = now();
    for (const [callId, entry] of pendingApprovals) {
      if (entry.expiresAt <= t) pendingApprovals.delete(callId);
    }
  }

  function modernResult(id, result) {
    return jsonRpcResult(id, {
      resultType: 'complete',
      ...result,
      _meta: { ...(result._meta || {}), [META_SERVER_INFO]: SERVER_INFO },
    });
  }

  function inputRequired(id, state) {
    return jsonRpcResult(id, {
      resultType: 'input_required',
      requestState: state,
      _meta: {
        [META_SERVER_INFO]: SERVER_INFO,
        [META_APPROVAL_STATUS]: 'awaiting approval on the Shelly device — retry with requestState',
      },
    });
  }

  // ── Legacy era (initialize + Mcp-Session-Id) ──
  async function handleLegacy(parsed, headers) {
    const { id, method, params } = parsed;
    const isNotification = !Object.prototype.hasOwnProperty.call(parsed, 'id');

    if (method === 'initialize') {
      const requested = isPlainObject(params) ? params.protocolVersion : undefined;
      // Legacy negotiation: echo a version we speak, else offer our newest legacy one.
      const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      const sessionId = crypto.randomUUID();
      legacySessions.add(sessionId);
      log(`legacy initialize (requested=${requested}, negotiated=${negotiated})`);
      return json(200, jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      }), { 'Mcp-Session-Id': sessionId });
    }

    const sessionId = headerValue(headers, 'mcp-session-id');
    if (!sessionId || !legacySessions.has(sessionId)) {
      return json(400, jsonRpcError(id ?? null, LEGACY_SESSION_ERROR, 'missing or unknown Mcp-Session-Id — call initialize first'));
    }

    // Any notification (initialized, cancelled, …) is accepted with no body.
    if (isNotification) return json(202, null);

    switch (method) {
      case 'ping':
        return json(200, jsonRpcResult(id, {}));
      case 'tools/list':
        return json(200, jsonRpcResult(id, { tools: TOOLS }));
      case 'tools/call': {
        const toolName = isPlainObject(params) ? params.name : undefined;
        if (!TOOLS.some((t) => t.name === toolName)) {
          return json(200, jsonRpcError(id, INVALID_PARAMS, `unknown tool: ${toolName}`));
        }
        // Legacy peers have no MRTR — block on the bridge exactly as before.
        const result = await callTool(toolName, (params && params.arguments) || {});
        return json(200, jsonRpcResult(id, toolResultBody(result)));
      }
      default:
        return json(200, jsonRpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`));
    }
  }

  // ── Modern era (2026-07-28, stateless) ──
  async function handleModern(parsed, headers) {
    const { id, method } = parsed;
    // Modern Streamable HTTP defines no client→server notifications; accept
    // and ignore any that arrive (transport rule: 202, no body).
    if (!Object.prototype.hasOwnProperty.call(parsed, 'id')) return json(202, null);
    if (id === null || (typeof id !== 'string' && typeof id !== 'number')) {
      return json(400, jsonRpcError(null, INVALID_REQUEST, 'request id must be a string or integer'));
    }

    const params = parsed.params === undefined ? {} : parsed.params;
    if (!isPlainObject(params)) return json(400, jsonRpcError(id, INVALID_PARAMS, 'params must be an object'));
    const meta = isPlainObject(params._meta) ? params._meta : {};
    const version = meta[META_PROTOCOL_VERSION];
    const headerVersion = headerValue(headers, 'mcp-protocol-version');

    if (typeof version !== 'string') {
      return json(400, jsonRpcError(id, INVALID_PARAMS, `missing required _meta["${META_PROTOCOL_VERSION}"]`));
    }
    if (headerVersion === undefined || headerVersion === null) {
      return json(400, jsonRpcError(id, HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing'));
    }
    if (headerVersion !== version) {
      return json(400, jsonRpcError(id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'`));
    }
    if (!MODERN_VERSIONS.includes(version)) {
      log(`modern request with unsupported version ${version}`);
      return json(400, jsonRpcError(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED_VERSIONS,
        requested: version,
      }));
    }
    if (!isPlainObject(meta[META_CLIENT_CAPABILITIES])) {
      return json(400, jsonRpcError(id, INVALID_PARAMS, `missing required _meta["${META_CLIENT_CAPABILITIES}"]`));
    }

    const headerMethod = headerValue(headers, 'mcp-method');
    if (typeof headerMethod !== 'string') {
      return json(400, jsonRpcError(id, HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing'));
    }
    if (headerMethod !== method) {
      return json(400, jsonRpcError(id, HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${method}'`));
    }
    const nameField = NAMED_METHODS[method];
    if (nameField) {
      const rawName = headerValue(headers, 'mcp-name');
      if (typeof rawName !== 'string') {
        return json(400, jsonRpcError(id, HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing'));
      }
      const headerName = decodeHeaderValue(rawName);
      if (headerName !== params[nameField]) {
        return json(400, jsonRpcError(id, HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${params[nameField]}'`));
      }
    }
    // An Mcp-Session-Id header from a dual-era client is ignored here — no
    // session is minted, echoed, or required.

    switch (method) {
      case 'server/discover':
        return json(200, modernResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: SERVER_CAPABILITIES,
          instructions: SERVER_INSTRUCTIONS,
          ttlMs: LIST_TTL_MS,
          cacheScope: LIST_CACHE_SCOPE,
        }));
      case 'tools/list':
        // Deterministic order (static array) per 2026-07-28 caching guidance.
        return json(200, modernResult(id, { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: LIST_CACHE_SCOPE }));
      case 'tools/call':
        return modernToolsCall(id, params);
      default:
        // Includes `initialize`-era-only methods (ping, logging/setLevel, …)
        // that 2026-07-28 removed. Transport rule: 404 + -32601.
        return json(404, jsonRpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`));
    }
  }

  async function modernToolsCall(id, params) {
    const toolName = params.name;
    if (!TOOLS.some((t) => t.name === toolName)) {
      return json(200, jsonRpcError(id, INVALID_PARAMS, `unknown tool: ${toolName}`));
    }
    const args = isPlainObject(params.arguments) ? params.arguments : {};

    if (!APPROVAL_TOOLS.has(toolName)) {
      if (params.requestState !== undefined) {
        // We never issue requestState for read-only tools.
        return json(400, jsonRpcError(id, INVALID_PARAMS, 'unexpected requestState'));
      }
      const result = await callTool(toolName, args);
      return json(200, modernResult(id, toolResultBody(result)));
    }

    sweepPending();
    const digest = sha256Hex(`${toolName}\u0000${canonicalJson(args)}`);

    // ── MRTR retry: resume the SAME pending on-device call, never a new one ──
    if (params.requestState !== undefined) {
      const state = verifyState(params.requestState);
      const entry = state ? pendingApprovals.get(state.c) : undefined;
      if (
        !state
        || state.p !== principal
        || state.t !== toolName
        || state.d !== digest
        || typeof state.e !== 'number'
        || state.e <= now()
        || !entry
        || entry.tool !== toolName
        || entry.digest !== digest
      ) {
        log(`MRTR retry rejected (tool=${toolName}, known=${!!entry})`);
        return json(400, jsonRpcError(id, INVALID_PARAMS, 'invalid, expired, or already-consumed requestState — call the tool again without it'));
      }
      if (entry.settled || (await settlesWithin(entry.promise, retryHoldMs))) {
        pendingApprovals.delete(state.c);
        log(`MRTR retry completed (tool=${toolName}, ok=${entry.result && entry.result.ok})`);
        return json(200, modernResult(id, toolResultBody(entry.result)));
      }
      return json(200, inputRequired(id, params.requestState));
    }

    // ── First call: hand to the bridge, hold briefly, else defer via MRTR ──
    const callId = crypto.randomUUID();
    const entry = {
      tool: toolName,
      digest,
      settled: false,
      result: undefined,
      expiresAt: now() + MRTR_STATE_TTL_MS,
      promise: null,
    };
    entry.promise = Promise.resolve(callTool(toolName, args))
      .catch((e) => ({ ok: false, error: `internal error: ${e && e.message}` }))
      .then((result) => {
        entry.settled = true;
        entry.result = result;
        return result;
      });
    if (await settlesWithin(entry.promise, initialHoldMs)) {
      return json(200, modernResult(id, toolResultBody(entry.result)));
    }
    pendingApprovals.set(callId, entry);
    const state = signState({ v: 1, c: callId, t: toolName, d: digest, p: principal, e: entry.expiresAt });
    log(`MRTR deferred ${toolName} pending on-device approval`);
    return json(200, inputRequired(id, state));
  }

  /** Era selection, per 2026-07-28 "A dual-era server selects its behavior
   *  from how the client opens". */
  function isModernRequest(parsed, headers) {
    if (parsed.method === 'initialize') return false;
    const params = parsed.params;
    if (isPlainObject(params) && isPlainObject(params._meta) && params._meta[META_PROTOCOL_VERSION] !== undefined) {
      return true;
    }
    const headerVersion = headerValue(headers, 'mcp-protocol-version');
    return typeof headerVersion === 'string' && !LEGACY_VERSIONS.includes(headerVersion);
  }

  async function handle(req) {
    const headers = req.headers || {};

    const origin = headerValue(headers, 'origin');
    if (origin !== undefined && (typeof origin !== 'string' || !LOOPBACK_ORIGIN.test(origin))) {
      return json(403, { error: 'forbidden origin' });
    }
    if (req.url !== '/mcp') return json(404, { error: 'not found' });

    if (headerValue(headers, 'authorization') !== `Bearer ${token}`) {
      return json(401, { error: 'unauthorized' });
    }

    if (req.method === 'DELETE') {
      // Legacy client-initiated session termination.
      const sessionId = headerValue(headers, 'mcp-session-id');
      if (sessionId && legacySessions.delete(sessionId)) return json(200, null);
      return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
    }
    if (req.method !== 'POST') {
      // No standalone SSE stream (legacy GET) and none exists in 2026-07-28.
      return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
    }

    let parsed;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return json(400, jsonRpcError(null, PARSE_ERROR, 'parse error'));
    }
    if (!isPlainObject(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return json(400, jsonRpcError(isPlainObject(parsed) ? parsed.id ?? null : null, INVALID_REQUEST, 'invalid JSON-RPC request'));
    }

    try {
      return isModernRequest(parsed, headers) ? await handleModern(parsed, headers) : await handleLegacy(parsed, headers);
    } catch (e) {
      return json(500, jsonRpcError(parsed.id ?? null, INTERNAL_ERROR, `internal error: ${e.message}`));
    }
  }

  return { handle, _pendingApprovalCount: () => pendingApprovals.size };
}

// ── Entrypoint ───────────────────────────────────────────────────────────

function main() {
  const queueDir = process.argv[2];
  const port = parseInt(process.argv[3], 10) || 8767;
  const token = process.env.SHELLY_MCP_TOKEN;

  if (!queueDir || !token) {
    process.stderr.write('usage: SHELLY_MCP_TOKEN=<token> node shelly-mcp-server.js <queueDir> <port>\n');
    process.exit(1);
  }

  const log = (...args) => process.stderr.write(`[shelly-mcp] ${args.join(' ')}\n`);
  const handler = createMcpHandler({ token, callTool: createFileQueueCallTool(queueDir), log });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      const out = await handler.handle({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(out.status, out.headers);
      res.end(out.body === null ? undefined : out.body);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    log(`listening on 0.0.0.0:${port} (versions: ${SUPPORTED_VERSIONS.join(', ')})`);
  });

  server.on('error', (err) => {
    log(`server error: ${err.message}`);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    createMcpHandler,
    TOOLS,
    MODERN_VERSIONS,
    LEGACY_VERSIONS,
    SUPPORTED_VERSIONS,
    HEADER_MISMATCH,
    UNSUPPORTED_PROTOCOL_VERSION,
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
  };
}
