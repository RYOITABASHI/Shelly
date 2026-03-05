#!/usr/bin/env node
/**
 * Shelly Bridge Server v2.4.2
 * WebSocket bridge between Shelly app and Termux shell.
 * Run: node ~/shelly-bridge/server.js
 */

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.SHELLY_PORT || '8765', 10);
const DANGEROUS_CHECK = !process.argv.includes('--no-dangerous-check');

let currentCwd = os.homedir();
let activeProcess = null;
let activeRequestId = null;
let activeWs = null;
let cancelPending = false;
let sigkillTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function clearSigkillTimer() {
  if (sigkillTimer) {
    clearTimeout(sigkillTimer);
    sigkillTimer = null;
  }
}

const DANGEROUS_PATTERNS = [
  /rm\s+-[^\s]*r[^\s]*\s+\/(?:\s|$)/,
  /rm\s+-[^\s]*f[^\s]*\s+\/(?:\s|$)/,
  /mkfs\./,
  /dd\s+.*of=\/dev\//,
  /:\(\)\{.*:\|.*&.*\}/,
  />\s*\/dev\/sd/,
];

function isDangerous(cmd) {
  if (!DANGEROUS_CHECK) return false;
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

// ── cd handler ───────────────────────────────────────────────────────────────

function handleCd(ws, requestId, target) {
  const resolved = path.resolve(currentCwd, target || os.homedir());
  try {
    const fs = require('fs');
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'stderr', requestId, data: `cd: ${resolved}: No such file or directory\n` });
      send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
      return;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      send(ws, { type: 'stderr', requestId, data: `cd: ${resolved}: Not a directory\n` });
      send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
      return;
    }
    currentCwd = resolved;
    send(ws, { type: 'exit', requestId, code: 0, cwd: currentCwd });
  } catch (err) {
    send(ws, { type: 'stderr', requestId, data: `cd: ${err.message}\n` });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
  }
}

// ── Run handler ──────────────────────────────────────────────────────────────

function handleRun(ws, requestId, command) {
  if (!requestId || !command) {
    send(ws, { type: 'error', requestId, message: 'requestId and command are required' });
    return;
  }

  if (activeProcess) {
    send(ws, { type: 'error', requestId, message: 'Another command is already running.' });
    return;
  }

  if (isDangerous(command)) {
    send(ws, {
      type: 'stderr',
      requestId,
      data: `[BLOCKED] Dangerous command pattern detected: ${command}\n`,
    });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
    return;
  }

  console.log(`[shelly-bridge] [${requestId}] RUN: ${command}`);

  // Handle cd specially
  const cdMatch = command.trim().match(/^cd\s*(.*)?$/);
  if (cdMatch) {
    handleCd(ws, requestId, cdMatch[1]?.trim() || os.homedir());
    return;
  }

  const proc = spawn('bash', ['-c', command], {
    cwd: currentCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLUMNS: '120',
      LINES: '40',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeProcess = proc;
  activeRequestId = requestId;
  activeWs = ws;
  cancelPending = false;

  proc.stdout.on('data', (data) => {
    send(ws, { type: 'stdout', requestId, data: data.toString() });
  });

  proc.stderr.on('data', (data) => {
    send(ws, { type: 'stderr', requestId, data: data.toString() });
  });

  proc.on('close', (code, signal) => {
    clearSigkillTimer();

    const wasCancelled = cancelPending || signal === 'SIGINT' || code === 130;
    const exitCode = wasCancelled ? 130 : (code ?? 0);

    console.log(`[shelly-bridge] [${requestId}] EXIT: code=${code} signal=${signal} cancelled=${wasCancelled}`);

    activeProcess = null;
    activeRequestId = null;
    activeWs = null;
    cancelPending = false;

    if (wasCancelled) {
      send(ws, { type: 'stderr', requestId, data: '^C\n' });
      send(ws, { type: 'cancelled', requestId, cwd: currentCwd });
    } else {
      send(ws, { type: 'exit', requestId, code: exitCode, cwd: currentCwd });
    }
  });

  proc.on('error', (err) => {
    console.error(`[shelly-bridge] [${requestId}] ERROR: ${err.message}`);
    activeProcess = null;
    activeRequestId = null;
    activeWs = null;
    send(ws, { type: 'error', requestId, message: err.message });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
  });
}

// ── Cancel handler ───────────────────────────────────────────────────────────

function handleCancel(ws, requestId) {
  if (!activeProcess || activeRequestId !== requestId) {
    send(ws, { type: 'error', requestId, message: 'No matching process to cancel' });
    return;
  }

  console.log(`[shelly-bridge] [${requestId}] CANCEL requested`);
  cancelPending = true;

  // Try SIGINT first
  try {
    activeProcess.kill('SIGINT');
  } catch (_) {}

  // Force SIGKILL after 5s if still alive
  sigkillTimer = setTimeout(() => {
    if (activeProcess) {
      console.log(`[shelly-bridge] [${requestId}] Force SIGKILL`);
      try {
        activeProcess.kill('SIGKILL');
      } catch (_) {}
    }
  }, 5000);
}

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log(`[shelly-bridge] Server listening on ws://127.0.0.1:${PORT}`);
  console.log(`[shelly-bridge] CWD: ${currentCwd}`);
  console.log(`[shelly-bridge] Dangerous command check: ${DANGEROUS_CHECK ? 'ON' : 'OFF'}`);
});

wss.on('connection', (ws) => {
  console.log('[shelly-bridge] Client connected');
  send(ws, { type: 'ready', cwd: currentCwd });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'run':
        handleRun(ws, msg.requestId, msg.command);
        break;
      case 'cancel':
        handleCancel(ws, msg.requestId);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    console.log('[shelly-bridge] Client disconnected');
    // Kill active process when client disconnects
    if (activeProcess && activeWs === ws) {
      try { activeProcess.kill('SIGKILL'); } catch (_) {}
      activeProcess = null;
      activeRequestId = null;
      activeWs = null;
    }
  });
});

wss.on('error', (err) => {
  console.error(`[shelly-bridge] Server error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`[shelly-bridge] Port ${PORT} is already in use. Kill the other process or use SHELLY_PORT=<port>`);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shelly-bridge] Shutting down...');
  if (activeProcess) {
    try { activeProcess.kill('SIGKILL'); } catch (_) {}
  }
  wss.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  if (activeProcess) {
    try { activeProcess.kill('SIGKILL'); } catch (_) {}
  }
  wss.close(() => process.exit(0));
});
