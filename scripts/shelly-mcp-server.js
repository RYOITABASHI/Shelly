#!/usr/bin/env node
/*
 * shelly-mcp-server.js — minimal MCP (Model Context Protocol) server.
 *
 * Exposes a SMALL set of READ-ONLY tools so an MCP client on the same
 * network (Claude Code, Claude Desktop) can inspect this Shelly instance —
 * terminal output, git status, registered agents, configured repos.
 * Deliberately no command-execution or write tool yet: the capability
 * broker (lib/capability-envelope.ts / scripts/shelly-capability-broker.js)
 * only gates OUTGOING requests today; letting an arbitrary network caller
 * trigger command execution needs a real INGRESS-side capability gate
 * (per-client grants, an execution allowlist) that doesn't exist yet and
 * deserves its own design pass rather than being bolted on here.
 *
 * Transport: Streamable HTTP, the well-established initialize +
 * Mcp-Session-Id session model (spec revisions 2025-03-26 / 2025-06-18 /
 * 2025-11-25) — NOT the newer 2026-07-28 stateless revision. Verified
 * (2026-09-16) that Claude Code's default stdio/HTTP client behavior for a
 * locally-run server still expects this session-based flow unless the user
 * has explicitly opted into 2026-07-28 negotiation
 * (MCP_PROTOCOL_NEGOTIATION=auto); targeting the newer stateless-only
 * protocol would make this server unreachable by an unconfigured Claude
 * Code / Claude Desktop today. A single POST-only /mcp endpoint, JSON
 * responses only (no SSE streaming — every tool here is fast and
 * synchronous, so the spec's optional streaming upgrade isn't needed).
 *
 * Auth: a pre-shared bearer token (Authorization: Bearer <token>), checked
 * on every request after `initialize`. OAuth 2.1 is spec-OPTIONAL, and a
 * static token is an accepted pattern for a personal/local-network server
 * (see this project's MCP research notes) — not a compliance shortcut.
 * The token is generated on first enable and stored via the app's own
 * SecureStore (lib/secure-store.ts), same as every other API key; this
 * script reads it from an env var at spawn time, never from argv.
 *
 * No npm dependencies — Node built-ins only, same reasoning as
 * scripts/shelly-gemini-live-client.js / shelly-a2a-server.js.
 *
 * IPC with the RN app: the SAME bidirectional file-queue bridge pattern as
 * shelly-a2a-server.js (this process can't reach RN's JS state directly).
 *
 * Usage: node shelly-mcp-server.js <queueDir> <port>
 * Env:   SHELLY_MCP_TOKEN — required bearer token
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const queueDir = process.argv[2];
const port = parseInt(process.argv[3], 10) || 8767;
const token = process.env.SHELLY_MCP_TOKEN;

if (!queueDir || !token) {
  process.stderr.write('usage: SHELLY_MCP_TOKEN=<token> node shelly-mcp-server.js <queueDir> <port>\n');
  process.exit(1);
}

const requestsDir = path.join(queueDir, 'requests');
const resultsDir = path.join(queueDir, 'results');
fs.mkdirSync(requestsDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const RESULT_POLL_MS = 250;
const RESULT_TIMEOUT_MS = 15000;
const PROTOCOL_VERSION = '2025-06-18';

function log(...args) {
  process.stderr.write(`[shelly-mcp] ${args.join(' ')}\n`);
}

// Same request/result file-queue round trip as shelly-a2a-server.js — see
// that script's waitForResult for the full rationale.
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

async function callTool(toolName, args) {
  const callId = crypto.randomUUID();
  fs.writeFileSync(
    path.join(requestsDir, `${callId}.json`),
    JSON.stringify({ callId, tool: toolName, args: args || {}, receivedAt: new Date().toISOString() }),
  );
  return waitForResult(callId);
}

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
];

// ── Sessions ─────────────────────────────────────────────────────────────
const sessions = new Set();

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function dispatch(req, sessionId) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return {
        response: jsonRpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'shelly', version: '1.0.0' },
        }),
        newSessionId: crypto.randomUUID(),
      };
    case 'notifications/initialized':
      return { response: null }; // notification — no response body
    case 'tools/list':
      return { response: jsonRpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = params && params.name;
      if (!TOOLS.some((t) => t.name === toolName)) {
        return { response: jsonRpcError(id, -32602, `unknown tool: ${toolName}`) };
      }
      const result = await callTool(toolName, (params && params.arguments) || {});
      return {
        response: jsonRpcResult(id, {
          content: [{ type: 'text', text: result.ok ? JSON.stringify(result.data) : `Error: ${result.error}` }],
          isError: !result.ok,
        }),
      };
    }
    default:
      return { response: jsonRpcError(id, -32601, `method not found: ${method}`) };
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'parse error')));
      return;
    }

    if (parsed.method !== 'initialize' && (!sessionId || !sessions.has(sessionId))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(parsed.id ?? null, -32000, 'missing or unknown Mcp-Session-Id — call initialize first')));
      return;
    }

    try {
      const { response, newSessionId } = await dispatch(parsed, sessionId);
      const headers = { 'Content-Type': 'application/json' };
      if (newSessionId) {
        sessions.add(newSessionId);
        headers['Mcp-Session-Id'] = newSessionId;
      }
      if (!response) {
        // notification — no body expected
        res.writeHead(202, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(parsed.id ?? null, -32603, `internal error: ${e.message}`)));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${port}`);
});

server.on('error', (err) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
