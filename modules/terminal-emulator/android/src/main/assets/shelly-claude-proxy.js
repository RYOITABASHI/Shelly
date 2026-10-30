#!/usr/bin/env node
/*
 * shelly-claude-proxy.js — private HTTP(S) proxy for the Claude Code glibc
 * binary (DEFERRED.md "Claude Code 公式 glibc 版（2.1.314）を Shelly で動かす", S2).
 *
 * Why: glibc's resolver reads /etc/resolv.conf, which does not exist on
 * Android (bionic resolves through netd instead). Inside the glibc world every
 * hostname lookup therefore hangs/fails, so `claude -p` never reaches
 * api.anthropic.com. This proxy runs on Shelly's bundled *bionic* node, where
 * DNS works, and the glibc process only ever connects to the IP literal
 * 127.0.0.1 (no lookup needed).
 *
 * Contract (used by the bashrc `shelly-claude-glibc` function):
 *   node shelly-claude-proxy.js --port-file <path> [--parent-pid <pid>]
 *   - listens on 127.0.0.1 with an OS-assigned free port (port 0);
 *   - writes the port number to <path> (atomic rename) once listening;
 *   - exits as soon as <parent-pid> is gone (polled), so the proxy's lifetime
 *     is tied to the claude invocation even if the shell is SIGKILLed;
 *   - also exits on SIGTERM/SIGINT/SIGHUP.
 *
 * Scope is deliberately narrow:
 *   - CONNECT tunnels to port 443 only (TLS; the proxy never sees plaintext);
 *   - absolute-form plain HTTP forwarding to port 80 only;
 *   - bound to 127.0.0.1 only, and only lives as long as one claude process.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');

const CONNECT_PORTS = new Set([443]);
const HTTP_PORTS = new Set([80]);

/** Parse a CONNECT authority ("host:port", "[v6]:port"). null when invalid/denied. */
function parseConnectTarget(authority, allowedPorts = CONNECT_PORTS) {
  if (typeof authority !== 'string' || authority.length === 0 || authority.length > 300) return null;
  let host;
  let portStr;
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(authority);
  if (v6) {
    host = v6[1];
    portStr = v6[2];
  } else {
    const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(authority);
    if (!m) return null;
    host = m[1];
    portStr = m[2];
  }
  const port = Number(portStr);
  if (!allowedPorts.has(port)) return null;
  return { host, port };
}

function parseArgs(argv) {
  const out = { portFile: null, parentPid: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port-file') out.portFile = argv[++i] || null;
    else if (a === '--parent-pid') {
      const n = Number(argv[++i]);
      out.parentPid = Number.isInteger(n) && n > 1 ? n : null;
    }
  }
  return out;
}

/** opts.connectPorts / opts.httpPorts: test hooks only; production uses 443 / 80. */
function createProxyServer(opts = {}) {
  const connectPorts = opts.connectPorts || CONNECT_PORTS;
  const httpPorts = opts.httpPorts || HTTP_PORTS;
  const server = http.createServer((req, res) => {
    // Absolute-form request (HTTP_PROXY for a plain http:// URL).
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('absolute-form URL required');
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    if (target.protocol !== 'http:' || !httpPorts.has(port)) {
      res.writeHead(403);
      res.end('denied');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { host: target.hostname, port, method: req.method, path: `${target.pathname}${target.search}`, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url, connectPorts);
    if (!target) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', () => {
      if (clientSocket.writable && !clientSocket.destroyed) {
        try {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {
          /* ignore */
        }
      }
      close();
    });
    clientSocket.on('error', close);
    upstream.on('close', close);
    clientSocket.on('close', close);
  });
  return server;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours — still alive.
    return !!(e && e.code === 'EPERM');
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  const server = createProxyServer();
  const shutdown = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown);
  server.on('error', (e) => {
    process.stderr.write(`shelly-claude-proxy: ${e && e.message}\n`);
    process.exit(1);
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    if (opts.portFile) {
      const tmp = `${opts.portFile}.tmp`;
      fs.writeFileSync(tmp, `${port}\n`, { mode: 0o600 });
      fs.renameSync(tmp, opts.portFile);
    } else {
      process.stdout.write(`${port}\n`);
    }
  });
  if (opts.parentPid) {
    const timer = setInterval(() => {
      if (!isAlive(opts.parentPid)) shutdown();
    }, 1000);
    timer.unref();
    // Keep the process alive through the server; the timer itself must not.
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseConnectTarget, parseArgs, createProxyServer, isAlive };
