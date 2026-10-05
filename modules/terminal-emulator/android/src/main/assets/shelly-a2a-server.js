#!/usr/bin/env node
/*
 * shelly-a2a-server.js — minimal A2A (Agent2Agent) protocol server.
 *
 * Exposes ONE read-only skill (list_agents — the Shelly agents registered
 * on this device) to any A2A client on the same network, per the Linux
 * Foundation's A2A spec v1.0 (https://a2a-protocol.org/latest/specification/,
 * governance: https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents).
 * A2A is agent-to-agent task delegation between independent systems
 * (as opposed to MCP's agent-to-tool model) — this is Shelly's first,
 * deliberately narrow inbound skill: a remote A2A agent can ask "what
 * agents does this Shelly instance have?" and get a real answer, without
 * being able to trigger a run or touch anything else. Triggering a run via
 * A2A is a natural next skill but isn't implemented here.
 *
 * No npm dependencies on purpose — same reasoning as
 * scripts/shelly-gemini-live-client.js's header: the device's bundled Node
 * runtime has no node_modules alongside it. Unlike that script, A2A's
 * transport (JSON-RPC 2.0 over plain HTTP POST, a static JSON file for the
 * Agent Card) needs nothing beyond Node's built-in `http` module — no
 * binary framing, no handshake choreography.
 *
 * IPC with the RN app (which owns the actual agent list in
 * store/agent-store.ts — this process can't reach into RN's JS state
 * directly): a file-queue bridge, the SAME pattern already used for the
 * native xdg-open -> RN deep-link queue (see app/_layout.tsx's queuePath
 * poller) and the agent action-approval bridges, just bidirectional here —
 * this process writes a request file, the RN side (lib/a2a-bridge.ts) polls
 * for it, answers, and writes a result file this process polls for in turn.
 *   requests/<taskId>.json  (written here, deleted by RN once read)
 *   results/<taskId>.json   (written by RN, deleted here once read)
 *
 * Usage: node shelly-a2a-server.js <queueDir> <port>
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const queueDir = process.argv[2];
const port = parseInt(process.argv[3], 10) || 8766;

if (!queueDir) {
  process.stderr.write('usage: shelly-a2a-server.js <queueDir> <port>\n');
  process.exit(1);
}

const requestsDir = path.join(queueDir, 'requests');
const resultsDir = path.join(queueDir, 'results');
fs.mkdirSync(requestsDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const RESULT_POLL_MS = 250;
const RESULT_TIMEOUT_MS = 15000;

function log(...args) {
  process.stderr.write(`[shelly-a2a] ${args.join(' ')}\n`);
}

// Polls resultsDir/<taskId>.json until it appears (RN wrote it) or the
// timeout elapses. Deletes the file once read (single-consumer).
function waitForResult(taskId) {
  return new Promise((resolve) => {
    const resultPath = path.join(resultsDir, `${taskId}.json`);
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
        resolve({ ok: false, error: 'timed out waiting for the app to answer (is Shelly in the foreground/background-allowed?)' });
        return;
      }
      setTimeout(tick, RESULT_POLL_MS);
    };
    tick();
  });
}

// In-memory task store — process-lifetime only, matches the A2A spec's
// allowance for servers to not persist task history indefinitely. Tasks
// here complete synchronously from the client's point of view (SendMessage
// waits for the RN round-trip before responding) since every skill so far
// is fast/read-only; a longer-running skill would need SendMessage to
// return "working" immediately and rely on GetTask/SubscribeToTask polling
// instead — not needed yet.
const tasks = new Map();

function buildAgentCard(host) {
  return {
    name: 'Shelly',
    description: 'On-device autonomous agent runtime (Android). Read-only skills only in this version.',
    supportedInterfaces: [
      { url: `http://${host}/a2a/rpc`, protocol: 'JSONRPC', version: '1.0' },
    ],
    capabilities: { streaming: false, pushNotifications: false, extensions: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'list_agents',
        name: 'List Agents',
        description: 'Lists the Shelly agents registered on this device (id, name, schedule, enabled).',
      },
    ],
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleSendMessage(id, params) {
  const taskId = crypto.randomUUID();
  const text = extractText(params && params.message);
  const skillId = text && text.trim() === 'list_agents' ? 'list_agents' : 'list_agents'; // only skill for now

  tasks.set(taskId, { id: taskId, status: { state: 'working' } });

  fs.writeFileSync(
    path.join(requestsDir, `${taskId}.json`),
    JSON.stringify({ taskId, skillId, receivedAt: new Date().toISOString() }),
  );

  const result = await waitForResult(taskId);

  const task = {
    id: taskId,
    status: { state: result.ok ? 'completed' : 'failed' },
    artifacts: result.ok
      ? [{ name: skillId, parts: [{ kind: 'text', text: JSON.stringify(result.data) }] }]
      : [],
    ...(result.ok ? {} : { error: result.error }),
  };
  tasks.set(taskId, task);
  return jsonRpcResult(id, task);
}

function extractText(message) {
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts
    .filter((p) => p && p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

async function dispatch(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'SendMessage':
      return handleSendMessage(id, params);
    case 'GetTask': {
      const task = tasks.get(params && params.id);
      if (!task) return jsonRpcError(id, -32001, 'task not found');
      return jsonRpcResult(id, task);
    }
    case 'ListTasks':
      return jsonRpcResult(id, { tasks: Array.from(tasks.values()) });
    case 'CancelTask': {
      const task = tasks.get(params && params.id);
      if (!task) return jsonRpcError(id, -32001, 'task not found');
      task.status = { state: 'canceled' };
      return jsonRpcResult(id, task);
    }
    default:
      return jsonRpcError(id, -32601, `method not found: ${method}`);
  }
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || `127.0.0.1:${port}`;

  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
    const body = JSON.stringify(buildAgentCard(host));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && req.url === '/a2a/rpc') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // guard against a runaway body
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
      try {
        const response = await dispatch(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(parsed.id ?? null, -32603, `internal error: ${e.message}`)));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
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
