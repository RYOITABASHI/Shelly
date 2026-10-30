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
 *   - generates a 128-bit random token and writes "<port> <token>\n" to
 *     <path> with mode 0600 (atomic rename). The token never appears in argv;
 *     the claude process gets it inside HTTPS_PROXY=http://shelly:<token>@…;
 *   - exits as soon as <parent-pid> is gone (polled), so the proxy's lifetime
 *     is tied to the claude invocation even if the shell is SIGKILLed;
 *   - also exits on SIGTERM/SIGINT/SIGHUP.
 *
 * Security (127.0.0.1 is shared by every app/UID on the device):
 *   - every request (CONNECT and plain HTTP) must carry
 *     `Proxy-Authorization: Basic base64("shelly:<token>")`, compared in
 *     constant time; anything else gets 407;
 *   - CONNECT only to port 443, plain HTTP forwarding only to port 80;
 *   - destinations that are (or resolve to) loopback, link-local, RFC1918,
 *     CGNAT, multicast, unspecified or IPv6 ULA/link-local are refused, checked
 *     AFTER DNS resolution via a net.connect `lookup` hook (no DNS rebinding
 *     to a LAN address).
 */
'use strict';

const http = require('http');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const crypto = require('crypto');

const CONNECT_PORTS = new Set([443]);
const HTTP_PORTS = new Set([80]);
const PROXY_USER = 'shelly';

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

function ipv4ToInt(a) {
  const p = a.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

/** true for addresses the proxy must never connect to. */
function isPrivateAddress(addr) {
  if (typeof addr !== 'string') return true;
  const fam = net.isIP(addr);
  if (fam === 4) {
    const n = ipv4ToInt(addr);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((base & mask) >>> 0);
    });
  }
  if (fam === 6) {
    const a = addr.toLowerCase();
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

/** dns.lookup wrapper that refuses private results (handles all:true too). */
function makeSafeLookup(allowPrivate) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (allowPrivate) return callback(null, address, family);
      if (Array.isArray(address)) {
        const ok = address.filter((a) => !isPrivateAddress(a.address));
        if (ok.length === 0) return callback(denied(hostname));
        return callback(null, ok);
      }
      if (isPrivateAddress(address)) return callback(denied(hostname));
      return callback(null, address, family);
    });
  };
}

function denied(host) {
  const e = new Error(`destination ${host} resolves to a private address`);
  e.code = 'EPRIVATEDEST';
  return e;
}

function expectedAuthHeader(token) {
  return `Basic ${Buffer.from(`${PROXY_USER}:${token}`).toString('base64')}`;
}

/** Constant-time check of a Proxy-Authorization header value. */
function checkProxyAuth(headerValue, token) {
  if (!token) return false;
  const want = crypto.createHash('sha256').update(expectedAuthHeader(token)).digest();
  const got = crypto.createHash('sha256').update(String(headerValue || '')).digest();
  return crypto.timingSafeEqual(want, got);
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

/**
 * opts.token (required), opts.onAuthFailure(kind) for the "client did not send
 * credentials" diagnostic. Test hooks only: opts.connectPorts / opts.httpPorts
 * (production 443 / 80) and opts.allowPrivate (production false).
 */
function createProxyServer(opts = {}) {
  const token = opts.token;
  const connectPorts = opts.connectPorts || CONNECT_PORTS;
  const httpPorts = opts.httpPorts || HTTP_PORTS;
  const allowPrivate = !!opts.allowPrivate;
  const lookup = makeSafeLookup(allowPrivate);
  const onAuthFailure = typeof opts.onAuthFailure === 'function' ? opts.onAuthFailure : () => {};
  const literalDenied = (host) => !allowPrivate && net.isIP(host) !== 0 && isPrivateAddress(host);

  const server = http.createServer((req, res) => {
    if (!checkProxyAuth(req.headers['proxy-authorization'], token)) {
      onAuthFailure(req.headers['proxy-authorization'] ? 'bad-credentials' : 'no-credentials');
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="shelly"' });
      res.end();
      return;
    }
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
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (target.protocol !== 'http:' || !httpPorts.has(port) || literalDenied(host)) {
      res.writeHead(403);
      res.end('denied');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { host, port, method: req.method, path: `${target.pathname}${target.search}`, headers, lookup },
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
    if (!checkProxyAuth(req.headers['proxy-authorization'], token)) {
      onAuthFailure(req.headers['proxy-authorization'] ? 'bad-credentials' : 'no-credentials');
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="shelly"\r\n\r\n');
      return;
    }
    const target = parseConnectTarget(req.url, connectPorts);
    if (!target || literalDenied(target.host)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ port: target.port, host: target.host, lookup }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', (e) => {
      if (clientSocket.writable && !clientSocket.destroyed) {
        try {
          clientSocket.end(
            e && e.code === 'EPRIVATEDEST' ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n',
          );
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
  const token = crypto.randomBytes(16).toString('hex');
  let warned = false;
  const server = createProxyServer({
    token,
    onAuthFailure: (kind) => {
      if (warned) return;
      warned = true;
      // Read by the bashrc EXIT trap: if the HTTP client inside claude does not
      // send credentials from the proxy URL, say so instead of failing silently.
      process.stderr.write(
        `shelly-claude-proxy: 407 (${kind}) — a client did not send valid Proxy-Authorization for the private proxy\n`,
      );
    },
  });
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
    const line = `${port} ${token}\n`;
    if (opts.portFile) {
      const tmp = `${opts.portFile}.tmp`;
      fs.writeFileSync(tmp, line, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, opts.portFile);
    } else {
      process.stdout.write(line);
    }
  });
  if (opts.parentPid) {
    const timer = setInterval(() => {
      if (!isAlive(opts.parentPid)) shutdown();
    }, 1000);
    timer.unref();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseConnectTarget,
  parseArgs,
  createProxyServer,
  isAlive,
  isPrivateAddress,
  checkProxyAuth,
  expectedAuthHeader,
  makeSafeLookup,
};
