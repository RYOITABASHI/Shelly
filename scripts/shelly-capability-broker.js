#!/usr/bin/env node
/*
 * shelly-capability-broker.js — CAP-001 / SECRET-001 / HTTP-001 / FS-001 /
 * EXEC-001 runtime broker.
 *
 * Phase 0 「床」of the L1/L2 Capability Catalog
 * (docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md). The generated
 * agent .sh funnels every secret-bearing remote request through http_post_json;
 * when SHELLY_CAP_BROKER=1 that function delegates the actual send to this broker
 * instead of building `Authorization: Bearer $KEY` inline. The broker:
 *   - HTTP-001: enforces the egress allowlist; a non-allowlist host is fail-closed
 *     (blocked) unless --approved 1 was passed by an already-approved call site.
 *   - SECRET-001: resolves an opaque --auth-ref to a real header by reading the
 *     .env file ITSELF; the raw value never returns to the shell or rides in argv.
 *     A ref is bound to one host, so a mis-routed URL cannot exfiltrate the key.
 *   - CAP-001: enforces a per-run call/wall-time budget, and appends a REDACTED
 *     audit line per attempt (host/path/ref-name/verdict/status — never the value).
 *
 * The classification constants below MIRROR lib/capability-envelope.ts; the
 * capability-broker-parity test keeps them in lock-step (same pattern as the
 * shelly-agent-driver asset parity guard).
 *
 * Exit codes (distinct from the http_post_json 0/22/23 contract this preserves):
 *   0   success (HTTP <400)
 *   22  permanent HTTP failure (4xx other than 429)
 *   23  transient HTTP failure (429 / 5xx / network / timeout)
 *   40  denied by policy (bad URL / secret bound to another host)
 *   41  non-allowlist host requires approval (fail-closed; not pre-approved)
 *   42  budget exhausted
 *   43  auth_ref could not be resolved (missing/empty secret)
 *   44  usage error
 *   45  scoped.fs denied or failed
 *   46  workspace.exec denied
 *   127 internal error
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// ---------------------------------------------------------------------------
// Mirror of lib/capability-envelope.ts — keep in sync (parity-tested).
// ---------------------------------------------------------------------------

const AUTH_REFS = {
  perplexity: { envVar: 'PERPLEXITY_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.perplexity.ai' },
  gemini: { envVar: 'GEMINI_API_KEY', header: 'x-goog-api-key', scheme: '', host: 'generativelanguage.googleapis.com' },
  cerebras: { envVar: 'CEREBRAS_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.cerebras.ai' },
  groq: { envVar: 'GROQ_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.groq.com' },
};

const EGRESS_ALLOWLIST = [
  'api.perplexity.ai',
  'generativelanguage.googleapis.com',
  'api.cerebras.ai',
  'api.groq.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github.com',
  '127.0.0.1',
  'localhost',
];

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

const DEFAULT_BUDGET = { maxCalls: 40, maxWallMs: 10 * 60 * 1000 };

const EXIT = {
  OK: 0,
  HTTP_PERMANENT: 22,
  HTTP_TRANSIENT: 23,
  DENY: 40,
  APPROVAL_REQUIRED: 41,
  BUDGET: 42,
  NO_SECRET: 43,
  USAGE: 44,
  FS_DENY: 45,
  EXEC_DENY: 46,
  INTERNAL: 127,
};

// Redaction for the free-text `reason`/error fields (defence-in-depth in case an
// upstream error body echoes a token). Mirrors lib/redact-secrets.ts's shape.
const REDACT_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{25,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const p of REDACT_PATTERNS) out = out.replace(p, '<redacted>');
  return out;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.indexOf(host) !== -1;
}

function isAllowlistedHost(host) {
  return EGRESS_ALLOWLIST.indexOf(host) !== -1;
}

/**
 * The CAP-001 §4.3 structural rule. Returns { decision, reason, signals }.
 *   decision: 'allow' | 'approve' | 'deny'
 */
function classifyEgress(url, authRef, tainted) {
  const signals = [];
  const host = hostFromUrl(url);
  let scheme = null;
  try {
    scheme = new URL(url).protocol;
  } catch (_) {
    scheme = null;
  }
  if (!host || scheme === null) {
    return { decision: 'deny', reason: 'unparseable URL', signals: ['insecure-scheme'] };
  }
  if (scheme !== 'https:' && !(scheme === 'http:' && isLoopbackHost(host))) {
    return { decision: 'deny', reason: 'insecure scheme ' + scheme + ' for host ' + host, signals: ['insecure-scheme'] };
  }
  if (authRef) {
    signals.push('secret-spend');
    const spec = AUTH_REFS[authRef];
    if (!spec) {
      return { decision: 'deny', reason: 'unknown auth_ref "' + authRef + '"', signals: signals };
    }
    if (host !== spec.host) {
      signals.push('ref-host-mismatch');
      return { decision: 'deny', reason: 'auth_ref "' + authRef + '" is bound to ' + spec.host + ', not ' + host, signals: signals };
    }
  }
  if (tainted) signals.push('tainted');
  if (!isAllowlistedHost(host)) {
    signals.push('non-allowlist-host');
    return { decision: 'approve', reason: 'host ' + host + ' is not on the egress allowlist', signals: signals };
  }
  return { decision: 'allow', reason: 'host ' + host + ' is allowlisted', signals: signals };
}

// ---------------------------------------------------------------------------
// FS-001 / EXEC-001 path policy
// ---------------------------------------------------------------------------

function normalizePath(p) {
  const text = String(p == null ? '' : p);
  const isAbs = text[0] === '/';
  const out = [];
  for (const seg of text.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
}

function isWithinRoot(root, target) {
  if (!root || !target || String(target).startsWith('~')) return false;
  const r = normalizePath(root).replace(/\/$/, '');
  const t = normalizePath(String(target)[0] === '/' ? target : r + '/' + target);
  return t === r || t.indexOf(r + '/') === 0;
}

function lexicalAbsolute(p, cwd) {
  const value = String(p == null ? '' : p);
  if (!value || value.indexOf('\0') !== -1 || value[0] === '~') throw new Error('invalid path');
  const base = cwd && cwd[0] === '/' ? cwd : '/';
  return normalizePath(value[0] === '/' ? value : base + '/' + value);
}

function realpathWithMissingTail(target) {
  const absolute = lexicalAbsolute(target, '/');
  return resolveRealPathNoDanglingSymlink(absolute, 0);
}

function resolveRealPathNoDanglingSymlink(absoluteTarget, depth) {
  if (depth > 40) throw new Error('too many symbolic links');
  const absolute = lexicalAbsolute(absoluteTarget, '/');
  const parts = absolute.split('/').filter(Boolean);
  let current = '/';
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = normalizePath(path.join(current, parts[i]));
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return normalizePath(path.join(current, ...parts.slice(i)));
      }
      throw e;
    }
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(candidate);
      if (!link || link.indexOf('\0') !== -1) throw new Error('invalid symbolic link target');
      const resolved = normalizePath(path.isAbsolute(link) ? link : path.join(path.dirname(candidate), link));
      const remaining = parts.slice(i + 1);
      return resolveRealPathNoDanglingSymlink(path.join(resolved, ...remaining), depth + 1);
    }
    current = candidate;
  }
  try {
    return normalizePath(fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute));
  } catch (_) {
    return normalizePath(absolute);
  }
}

function readRoots(args) {
  const roots = [];
  if (args['roots-file']) {
    try {
      for (const line of fs.readFileSync(args['roots-file'], 'utf8').split('\n')) {
        const root = line.trim();
        if (root) roots.push(root);
      }
    } catch (_) {
      /* handled as no roots below */
    }
  }
  if (args.root) roots.push(args.root);
  const out = [];
  for (const root of roots) {
    try {
      const real = realpathWithMissingTail(root);
      if (out.indexOf(real) === -1) out.push(real);
    } catch (_) {
      /* skip invalid roots */
    }
  }
  return out;
}

function classifyScopedPath(op, targetPath, roots, cwd) {
  let canonical;
  try {
    canonical = realpathWithMissingTail(lexicalAbsolute(targetPath, cwd || '/'));
  } catch (e) {
    return { decision: 'deny', reason: e && e.message ? e.message : 'invalid path', signals: ['invalid-path'], path: '<invalid>', root: null };
  }
  if (!roots.length) {
    return { decision: 'deny', reason: 'no scoped roots declared', signals: ['no-roots'], path: canonical, root: null };
  }
  const matched = roots.find((root) => isWithinRoot(root, canonical)) || null;
  if (!matched) {
    return { decision: 'deny', reason: op + ' path is outside declared roots', signals: ['outside-root'], path: canonical, root: null };
  }
  return { decision: 'allow', reason: op + ' path is inside declared root', signals: ['inside-root'], path: canonical, root: matched };
}

function classifyWorkspaceExec(command, cwd, roots) {
  const safety = classifyCommandSafety(command);
  const verdict = classifyScopedPath('workspace.exec cwd', cwd, roots, roots[0] || '/');
  verdict.dangerLevel = safety.level;
  verdict.command = null;
  if (safety.level === 'CRITICAL') {
    return {
      decision: 'deny',
      reason: safety.reason,
      signals: ['critical-command'],
      path: verdict.path,
      root: verdict.root,
      dangerLevel: safety.level,
      command: null,
    };
  }
  if (verdict.decision !== 'allow') return verdict;
  const curated = parseCuratedExecCommand(command);
  if (!curated.ok) {
    return {
      decision: 'deny',
      reason: curated.reason,
      signals: [curated.signal],
      path: verdict.path,
      root: verdict.root,
      dangerLevel: safety.level,
      command: null,
    };
  }
  for (const rawPath of curated.command.pathArgs) {
    const pathVerdict = classifyScopedPath('workspace.exec path argument', rawPath, roots, verdict.path);
    if (pathVerdict.decision !== 'allow') {
      return {
        decision: 'deny',
        reason: pathVerdict.reason,
        signals: pathVerdict.signals,
        path: verdict.path,
        root: verdict.root,
        dangerLevel: safety.level,
        command: null,
      };
    }
  }
  verdict.reason = safety.reason || 'curated command allowed inside workspace root';
  verdict.command = curated.command;
  return verdict;
}

function splitCuratedCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { error: 'command is empty', signal: 'unsupported-command' };
  if (/[\0\r\n]/.test(text)) return { error: 'multi-line shell commands are not supported by workspace.exec', signal: 'unsafe-shell-syntax' };
  if (/[|&;()<>`$\\*?\[\]{}!~]/.test(text)) return { error: 'shell expansion and control operators are not supported by workspace.exec', signal: 'unsafe-shell-syntax' };
  const argv = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return { error: 'unterminated quote in workspace.exec command', signal: 'unsafe-shell-syntax' };
  if (current) argv.push(current);
  if (!argv.length) return { error: 'command is empty', signal: 'unsupported-command' };
  return { argv: argv };
}

function parseCuratedExecCommand(command) {
  const split = splitCuratedCommand(command);
  if (split.error) return { ok: false, reason: split.error, signal: split.signal };
  const argv = split.argv;
  const name = argv[0];
  const pathArgs = [];

  if (name === 'env') {
    if (argv.length !== 1) return { ok: false, reason: 'env template does not accept arguments', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'env', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'printenv') {
    if (argv.length > 2 || (argv[1] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[1]))) {
      return { ok: false, reason: 'printenv template accepts at most one variable name', signal: 'unsupported-command' };
    }
    return { ok: true, command: { template: 'printenv', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'pwd' || name === 'true' || name === 'false') {
    if (argv.length !== 1) return { ok: false, reason: name + ' template does not accept arguments', signal: 'unsupported-command' };
    return { ok: true, command: { template: name, argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'printf') {
    if (argv.length < 2 || argv.length > 8) return { ok: false, reason: 'printf template requires 1-7 literal arguments', signal: 'unsupported-command' };
    if (argv.slice(1).some((arg) => arg[0] === '-')) return { ok: false, reason: 'printf template only accepts literal arguments', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'printf', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'sleep') {
    if (argv.length !== 2 || !/^\d+(?:\.\d+)?$/.test(argv[1])) return { ok: false, reason: 'sleep template requires one numeric duration', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'sleep', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'cat') {
    const args = argv.slice(1).filter((arg) => arg !== '--');
    if (!args.length || args.some((arg) => arg[0] === '-')) return { ok: false, reason: 'cat template requires one or more file paths', signal: 'unsupported-command' };
    pathArgs.push.apply(pathArgs, args);
    return { ok: true, command: { template: 'cat', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'ls') {
    for (const arg of argv.slice(1)) {
      if (arg[0] === '-') {
        if (['-a', '-l', '-la', '-al'].indexOf(arg) === -1) return { ok: false, reason: 'ls template only supports -a/-l/-la/-al', signal: 'unsupported-command' };
      } else {
        pathArgs.push(arg);
      }
    }
    return { ok: true, command: { template: 'ls', argv: argv, pathArgs: pathArgs } };
  }
  if (name === 'grep') {
    const rest = [];
    for (const arg of argv.slice(1)) {
      if (arg[0] === '-') {
        if (['-n', '-i', '-r', '-R'].indexOf(arg) === -1) return { ok: false, reason: 'grep template only supports -n/-i/-r/-R', signal: 'unsupported-command' };
      } else {
        rest.push(arg);
      }
    }
    if (rest.length < 2) return { ok: false, reason: 'grep template requires a literal query and at least one path', signal: 'unsupported-command' };
    pathArgs.push.apply(pathArgs, rest.slice(1));
    return { ok: true, command: { template: 'grep', argv: argv, pathArgs: pathArgs } };
  }
  return { ok: false, reason: 'workspace.exec command is not in the curated template allowlist: ' + name, signal: 'unsupported-command' };
}

function classifyCommandSafety(command) {
  const cleaned = String(command || '').replace(/#[^\n]*/g, '').trim();
  if (!cleaned) return { level: 'SAFE', reason: 'empty command' };
  const critical = [
    { re: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~\/?\s*$|\/\*|~\/\*)/i, reason: 'recursive removal of root or home is forbidden' },
    { re: /rm\s+-rf\s+\/(?:usr|bin|lib|etc|boot|sys|proc|dev|sbin)/i, reason: 'system directory removal is forbidden' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb is forbidden' },
    { re: /dd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\/(?:sd[a-z]|nvme|mmcblk)/i, reason: 'raw storage overwrite is forbidden' },
    { re: /mkfs\s+.*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i, reason: 'device formatting is forbidden' },
    { re: />\s*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i, reason: 'direct device write is forbidden' },
    { re: /shred\s+.*\/dev\//i, reason: 'device shredding is forbidden' },
  ];
  for (const item of critical) {
    if (item.re.test(cleaned)) return { level: 'CRITICAL', reason: item.reason };
  }
  const high = [
    { re: /curl\s+.*\|\s*(?:bash|sh|zsh|fish|python3?|node|ruby|perl)/i, reason: 'remote script pipe is high risk' },
    { re: /wget\s+.*-O\s*-\s*\|\s*(?:bash|sh|zsh|fish)/i, reason: 'remote script pipe is high risk' },
    { re: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/i, reason: 'recursive force removal is high risk' },
    { re: /git\s+reset\s+--hard/i, reason: 'hard reset is high risk' },
    { re: /git\s+(?:push\s+.*--force|push\s+-f)\b/i, reason: 'force push is high risk' },
  ];
  for (const item of high) {
    if (item.re.test(cleaned)) return { level: 'HIGH', reason: item.reason };
  }
  return { level: 'SAFE', reason: 'No risky command pattern matched.' };
}

// ---------------------------------------------------------------------------
// .env parsing (secret-by-reference resolution — SECRET-001)
// ---------------------------------------------------------------------------

// The agent .env is written by settings-store as KEY='value' (bash single-quoted,
// with ' escaped as '\''), one per line, NOT exported. So a child node process
// does not inherit these — the broker must read the file itself. That is the
// point: the raw secret never becomes an environment variable a sibling skill can
// read via /proc, and never rides in this process's argv.
function parseEnvFile(filePath) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    key = key.replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1).replace(/'\\''/g, "'");
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Budget accounting (CAP-001)
// ---------------------------------------------------------------------------

function loadBudgetState(budgetFile, nowMs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    if (parsed && typeof parsed.calls === 'number' && typeof parsed.startedAtMs === 'number') {
      return { calls: parsed.calls, startedAtMs: parsed.startedAtMs };
    }
  } catch (_) {
    /* first call / unreadable → fresh envelope */
  }
  return { calls: 0, startedAtMs: nowMs };
}

function saveBudgetState(budgetFile, state) {
  try {
    fs.writeFileSync(budgetFile, JSON.stringify(state));
  } catch (_) {
    /* best-effort; a lost counter fails safe on the next read (fresh, still capped) */
  }
}

function checkBudget(state, budget, nowMs) {
  if (state.calls >= budget.maxCalls) {
    return { ok: false, reason: 'call budget exhausted (' + state.calls + '/' + budget.maxCalls + ')' };
  }
  const elapsed = nowMs - state.startedAtMs;
  if (elapsed >= budget.maxWallMs) {
    return { ok: false, reason: 'wall-time budget exhausted (' + elapsed + 'ms/' + budget.maxWallMs + 'ms)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audit (CAP-001 redacted)
// ---------------------------------------------------------------------------

function appendAudit(auditFile, entry) {
  if (!auditFile) return;
  try {
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch (_) {
    /* best-effort */
  }
}

function buildAudit(nowIso, method, url, authRef, tainted, verdict, extra) {
  let host = '<unparseable>';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname; // query dropped on purpose (may carry ?key=…)
  } catch (_) {
    /* keep placeholders */
  }
  const entry = {
    ts: nowIso,
    kind: 'http.request',
    method: (method || 'GET').toUpperCase(),
    host: host,
    path: path,
    authRef: authRef || null,
    tainted: tainted === true,
    decision: verdict.decision,
    signals: verdict.signals,
    reason: redact(verdict.reason),
  };
  if (extra) {
    if (typeof extra.status === 'number') entry.status = extra.status;
    if (typeof extra.ok === 'boolean') entry.ok = extra.ok;
    if (extra.reason) entry.reason = redact(extra.reason);
  }
  return entry;
}

function buildFsAudit(nowIso, op, verdict, extra) {
  const entry = {
    ts: nowIso,
    kind: 'scoped.fs',
    op: op,
    path: verdict.path || '<invalid>',
    root: verdict.root || null,
    decision: verdict.decision,
    signals: verdict.signals || [],
    reason: redact(verdict.reason),
  };
  if (extra && typeof extra.ok === 'boolean') entry.ok = extra.ok;
  if (extra && extra.reason) entry.reason = redact(extra.reason);
  return entry;
}

function writeFileNoFollowFromFile(srcPath, destPath) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const inFd = fs.openSync(srcPath, fs.constants.O_RDONLY);
  let outFd = null;
  try {
    outFd = fs.openSync(destPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow, 0o600);
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const n = fs.readSync(inFd, buf, 0, buf.length, null);
      if (n <= 0) break;
      fs.writeSync(outFd, buf, 0, n);
    }
  } finally {
    try { fs.closeSync(inFd); } catch (_) {}
    if (outFd !== null) {
      try { fs.closeSync(outFd); } catch (_) {}
    }
  }
}

function buildExecAudit(nowIso, verdict, timeoutSeconds, extra) {
  const entry = {
    ts: nowIso,
    kind: 'workspace.exec',
    cwd: verdict.path || '<invalid>',
    root: verdict.root || null,
    decision: verdict.decision,
    signals: verdict.signals || [],
    dangerLevel: verdict.dangerLevel || 'SAFE',
    timeoutSeconds: Number(timeoutSeconds || 0),
    reason: redact(verdict.reason),
  };
  if (extra && typeof extra.ok === 'boolean') entry.ok = extra.ok;
  if (extra && typeof extra.exitCode === 'number') entry.exitCode = extra.exitCode;
  if (extra && extra.reason) entry.reason = redact(extra.reason);
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP send (mirrors the http_post_json node contract in agent-executor.ts)
// ---------------------------------------------------------------------------

function sendRequest(opts, cb) {
  // opts: { method, url, bodyBuf, headers, timeoutSeconds, outFd, errFd }
  let url;
  try {
    url = new URL(opts.url);
  } catch (e) {
    fs.writeSync(opts.errFd, 'invalid URL\n');
    return cb(EXIT.INTERNAL);
  }
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  const headers = Object.assign({}, opts.headers);
  if (opts.bodyBuf) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(opts.bodyBuf.length);
  }
  const req = client.request(
    {
      method: opts.method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: headers,
    },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        try {
          fs.writeSync(opts.outFd, chunk);
        } catch (_) {}
      });
      res.on('end', () => {
        const code = res.statusCode || 0;
        let exit;
        if (code < 400) exit = EXIT.OK;
        else if (code === 429 || code >= 500) exit = EXIT.HTTP_TRANSIENT;
        else exit = EXIT.HTTP_PERMANENT;
        cb(exit, code);
      });
    },
  );
  req.on('error', (err) => {
    try {
      fs.writeSync(opts.errFd, redact(err && err.message ? err.message : String(err)) + '\n');
    } catch (_) {}
    cb(EXIT.HTTP_TRANSIENT, 0);
  });
  const timeoutSeconds = Number(opts.timeoutSeconds || 0);
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    req.setTimeout(timeoutSeconds * 1000, () => {
      req.destroy(new Error('request timed out'));
    });
  }
  if (opts.bodyBuf) req.write(opts.bodyBuf);
  req.end();
}

// ---------------------------------------------------------------------------
// FS-001 scoped.fs operations
// ---------------------------------------------------------------------------

function openOutErr(outFile, errFile) {
  if (!outFile || !errFile) throw new Error('out and err files are required');
  return {
    outFd: fs.openSync(outFile, 'w'),
    errFd: fs.openSync(errFile, 'w'),
  };
}

function runFsOp(args, nowIso) {
  const op = args.op || '';
  const targetPath = args.path || '';
  const auditFile = args['audit-log'] || '';
  let fds;
  try {
    fds = openOutErr(args.out || '', args.err || '');
  } catch (e) {
    process.stderr.write('cannot open out/err files\n');
    process.exit(EXIT.INTERNAL);
  }
  const finish = (code, verdict, extra) => {
    appendAudit(auditFile, buildFsAudit(nowIso, op, verdict, extra));
    try { fs.closeSync(fds.outFd); } catch (_) {}
    try { fs.closeSync(fds.errFd); } catch (_) {}
    process.exit(code);
  };

  const roots = readRoots(args);
  const verdict = classifyScopedPath(op, targetPath, roots, args.cwd || '/');
  if (verdict.decision !== 'allow') {
    fs.writeSync(fds.errFd, 'scoped.fs: ' + redact(verdict.reason) + '\n');
    return finish(EXIT.FS_DENY, verdict, { ok: false });
  }

  try {
    if (op === 'fs.read') {
      const data = fs.readFileSync(verdict.path);
      fs.writeSync(fds.outFd, data);
      return finish(EXIT.OK, verdict, { ok: true });
    }
    if (op === 'fs.write') {
      const inputFile = args['input-file'] || '';
      if (!inputFile) {
        fs.writeSync(fds.errFd, 'scoped.fs: --input-file is required for fs.write\n');
        return finish(EXIT.USAGE, verdict, { ok: false });
      }
      const inputVerdict = classifyScopedPath('fs.write input', inputFile, roots, args.cwd || '/');
      if (inputVerdict.decision !== 'allow') {
        const reason = 'fs.write input file is outside declared roots';
        const denyVerdict = {
          decision: 'deny',
          reason: reason,
          signals: inputVerdict.signals || ['outside-root'],
          path: verdict.path,
          root: verdict.root,
        };
        fs.writeSync(fds.errFd, 'scoped.fs: ' + redact(reason) + '\n');
        return finish(EXIT.FS_DENY, denyVerdict, { ok: false });
      }
      fs.mkdirSync(path.dirname(verdict.path), { recursive: true });
      const writeVerdict = classifyScopedPath(op, verdict.path, roots, args.cwd || '/');
      if (writeVerdict.decision !== 'allow') {
        fs.writeSync(fds.errFd, 'scoped.fs: ' + redact(writeVerdict.reason) + '\n');
        return finish(EXIT.FS_DENY, writeVerdict, { ok: false });
      }
      writeFileNoFollowFromFile(inputVerdict.path, writeVerdict.path);
      fs.writeSync(fds.outFd, verdict.path + '\n');
      return finish(EXIT.OK, writeVerdict, { ok: true });
    }
    if (op === 'fs.list') {
      const entries = fs.readdirSync(verdict.path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      }));
      fs.writeSync(fds.outFd, JSON.stringify(entries) + '\n');
      return finish(EXIT.OK, verdict, { ok: true });
    }
    if (op === 'fs.search') {
      const query = String(args.query || '');
      if (!query) {
        fs.writeSync(fds.errFd, 'scoped.fs: --query is required for fs.search\n');
        return finish(EXIT.USAGE, verdict, { ok: false });
      }
      const results = [];
      searchFiles(verdict.path, query, verdict.root, results, 200);
      fs.writeSync(fds.outFd, JSON.stringify(results) + '\n');
      return finish(EXIT.OK, verdict, { ok: true });
    }
    fs.writeSync(fds.errFd, 'scoped.fs: unknown op ' + op + '\n');
    return finish(EXIT.USAGE, verdict, { ok: false });
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    fs.writeSync(fds.errFd, 'scoped.fs: ' + redact(reason) + '\n');
    return finish(EXIT.FS_DENY, verdict, { ok: false, reason: reason });
  }
}

function searchFiles(rootPath, query, allowedRoot, results, maxResults) {
  if (results.length >= maxResults) return;
  let stat;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (_) {
    return;
  }
  const real = realpathWithMissingTail(rootPath);
  if (!isWithinRoot(allowedRoot, real)) return;
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(rootPath);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      searchFiles(path.join(rootPath, entry), query, allowedRoot, results, maxResults);
    }
    return;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) return;
  try {
    const text = fs.readFileSync(rootPath, 'utf8');
    const idx = text.indexOf(query);
    if (idx !== -1) {
      results.push({ path: real, index: idx, preview: text.slice(Math.max(0, idx - 80), idx + query.length + 80) });
    }
  } catch (_) {
    /* binary/unreadable */
  }
}

// ---------------------------------------------------------------------------
// EXEC-001 workspace.exec
// ---------------------------------------------------------------------------

function safeExecEnv() {
  const env = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!env.PATH) env.PATH = '/system/bin:/bin:/usr/bin';
  return env;
}

function writeSafeEnv(outFd, variableName) {
  const env = safeExecEnv();
  const keys = Object.keys(env).sort();
  if (variableName) {
    if (Object.prototype.hasOwnProperty.call(env, variableName)) {
      fs.writeSync(outFd, variableName + '=' + env[variableName] + '\n');
      return 0;
    }
    return 1;
  }
  for (const key of keys) {
    fs.writeSync(outFd, key + '=' + env[key] + '\n');
  }
  return 0;
}

function safeReadScopedFile(filePath, roots, cwd) {
  const verdict = classifyScopedPath('workspace.exec file', filePath, roots, cwd);
  if (verdict.decision !== 'allow') return { ok: false, verdict: verdict, reason: verdict.reason };
  let stat;
  try {
    stat = fs.statSync(verdict.path);
  } catch (e) {
    return { ok: false, verdict: verdict, reason: e && e.message ? e.message : 'cannot stat file' };
  }
  if (!stat.isFile()) return { ok: false, verdict: verdict, reason: 'path is not a regular file' };
  if (stat.size > 1024 * 1024) return { ok: false, verdict: verdict, reason: 'file exceeds workspace.exec 1MiB read limit' };
  try {
    return { ok: true, path: verdict.path, data: fs.readFileSync(verdict.path) };
  } catch (e) {
    return { ok: false, verdict: verdict, reason: e && e.message ? e.message : 'cannot read file' };
  }
}

function renderScopedList(targetPath, roots, cwd, longFormat, allEntries) {
  const verdict = classifyScopedPath('workspace.exec list', targetPath || '.', roots, cwd);
  if (verdict.decision !== 'allow') return { ok: false, reason: verdict.reason };
  let stat;
  try {
    stat = fs.lstatSync(verdict.path);
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : 'cannot stat path' };
  }
  if (!stat.isDirectory()) {
    return { ok: true, text: verdict.path + '\n' };
  }
  let entries;
  try {
    entries = fs.readdirSync(verdict.path, { withFileTypes: true });
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : 'cannot list directory' };
  }
  const lines = entries
    .filter((entry) => allEntries || entry.name[0] !== '.')
    .map((entry) => {
      const suffix = entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '';
      if (!longFormat) return entry.name + suffix;
      const full = path.join(verdict.path, entry.name);
      let size = 0;
      try { size = fs.lstatSync(full).size; } catch (_) {}
      return String(size).padStart(8, ' ') + ' ' + entry.name + suffix;
    })
    .sort();
  return { ok: true, text: lines.join('\n') + (lines.length ? '\n' : '') };
}

function renderScopedGrep(argv, roots, cwd) {
  let ignoreCase = false;
  const rest = [];
  for (const arg of argv.slice(1)) {
    if (arg === '-i') ignoreCase = true;
    else if (arg === '-n' || arg === '-r' || arg === '-R') {
      /* accepted for template compatibility; output is path:index:preview */
    } else {
      rest.push(arg);
    }
  }
  const query = rest[0];
  const paths = rest.slice(1);
  const needle = ignoreCase ? query.toLowerCase() : query;
  const results = [];
  for (const rawPath of paths) {
    const verdict = classifyScopedPath('workspace.exec grep', rawPath, roots, cwd);
    if (verdict.decision !== 'allow') return { ok: false, reason: verdict.reason };
    if (ignoreCase) {
      collectCaseInsensitiveMatches(verdict.path, needle, verdict.root, results, 200);
    } else {
      searchFiles(verdict.path, query, verdict.root, results, 200);
    }
    if (results.length >= 200) break;
  }
  const text = results.slice(0, 200).map((item) => item.path + ':' + item.index + ':' + item.preview.replace(/\n/g, '\\n')).join('\n');
  return { ok: true, text: text + (text ? '\n' : '') };
}

function collectCaseInsensitiveMatches(rootPath, needle, allowedRoot, results, maxResults) {
  if (results.length >= maxResults) return;
  let stat;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (_) {
    return;
  }
  const real = realpathWithMissingTail(rootPath);
  if (!isWithinRoot(allowedRoot, real)) return;
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(rootPath);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      collectCaseInsensitiveMatches(path.join(rootPath, entry), needle, allowedRoot, results, maxResults);
    }
    return;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) return;
  try {
    const text = fs.readFileSync(rootPath, 'utf8');
    const idx = text.toLowerCase().indexOf(needle);
    if (idx !== -1) {
      results.push({ path: real, index: idx, preview: text.slice(Math.max(0, idx - 80), idx + needle.length + 80) });
    }
  } catch (_) {
    /* binary/unreadable */
  }
}

function runWorkspaceExec(args, nowIso) {
  const auditFile = args['audit-log'] || '';
  const outFile = args.out || '';
  const errFile = args.err || '';
  const commandFile = args['command-file'] || '';
  const timeoutSeconds = Number(args['timeout-seconds'] || '600');
  const roots = readRoots(args);
  const commandFileVerdict = classifyScopedPath('workspace.exec command file', commandFile, roots, roots[0] || '/');
  if (commandFileVerdict.decision !== 'allow') {
    process.stderr.write('workspace.exec: command file is outside declared roots\n');
    appendAudit(auditFile, buildExecAudit(nowIso, {
      decision: 'deny',
      reason: commandFileVerdict.reason,
      signals: commandFileVerdict.signals,
      path: commandFileVerdict.path,
      root: commandFileVerdict.root,
      dangerLevel: 'SAFE',
      command: null,
    }, timeoutSeconds, { ok: false }));
    process.exit(EXIT.EXEC_DENY);
  }
  let command = '';
  try {
    command = fs.readFileSync(commandFile, 'utf8');
  } catch (_) {
    process.stderr.write('workspace.exec: cannot read command file\n');
    process.exit(EXIT.USAGE);
  }
  let fds;
  try {
    fds = openOutErr(outFile, errFile);
  } catch (_) {
    process.stderr.write('cannot open out/err files\n');
    process.exit(EXIT.INTERNAL);
  }
  const verdict = classifyWorkspaceExec(command, args.cwd || '', roots);
  const finish = (code, extra) => {
    appendAudit(auditFile, buildExecAudit(nowIso, verdict, timeoutSeconds, extra));
    try { fs.closeSync(fds.outFd); } catch (_) {}
    try { fs.closeSync(fds.errFd); } catch (_) {}
    process.exit(code);
  };
  if (verdict.decision !== 'allow') {
    fs.writeSync(fds.errFd, 'workspace.exec: ' + redact(verdict.reason) + '\n');
    return finish(EXIT.EXEC_DENY, { ok: false });
  }

  const cmd = verdict.command;
  if (!cmd) {
    fs.writeSync(fds.errFd, 'workspace.exec: command template missing\n');
    return finish(EXIT.EXEC_DENY, { ok: false, reason: 'command template missing' });
  }

  try {
    if (cmd.template === 'env') {
      return finish(writeSafeEnv(fds.outFd, null), { ok: true, exitCode: 0 });
    }
    if (cmd.template === 'printenv') {
      const rc = writeSafeEnv(fds.outFd, cmd.argv[1] || null);
      return finish(rc, { ok: rc === 0, exitCode: rc });
    }
    if (cmd.template === 'pwd') {
      fs.writeSync(fds.outFd, verdict.path + '\n');
      return finish(0, { ok: true, exitCode: 0 });
    }
    if (cmd.template === 'true') return finish(0, { ok: true, exitCode: 0 });
    if (cmd.template === 'false') return finish(1, { ok: false, exitCode: 1 });
    if (cmd.template === 'printf') {
      fs.writeSync(fds.outFd, cmd.argv.slice(1).join(''));
      return finish(0, { ok: true, exitCode: 0 });
    }
    if (cmd.template === 'sleep') {
      const seconds = Number(cmd.argv[1]);
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 && seconds > timeoutSeconds) {
        setTimeout(() => {
          fs.writeSync(fds.errFd, 'workspace.exec: timed out\n');
          finish(124, { ok: false, exitCode: 124, reason: 'timed out' });
        }, timeoutSeconds * 1000);
        return;
      }
      setTimeout(() => finish(0, { ok: true, exitCode: 0 }), Math.max(0, seconds * 1000));
      return;
    }
    if (cmd.template === 'cat') {
      for (const rawPath of cmd.pathArgs) {
        const read = safeReadScopedFile(rawPath, roots, verdict.path);
        if (!read.ok) {
          fs.writeSync(fds.errFd, 'workspace.exec: ' + redact(read.reason) + '\n');
          return finish(EXIT.EXEC_DENY, { ok: false, reason: read.reason });
        }
        fs.writeSync(fds.outFd, read.data);
      }
      return finish(0, { ok: true, exitCode: 0 });
    }
    if (cmd.template === 'ls') {
      const longFormat = cmd.argv.indexOf('-l') !== -1 || cmd.argv.indexOf('-la') !== -1 || cmd.argv.indexOf('-al') !== -1;
      const allEntries = cmd.argv.indexOf('-a') !== -1 || cmd.argv.indexOf('-la') !== -1 || cmd.argv.indexOf('-al') !== -1;
      const targets = cmd.pathArgs.length ? cmd.pathArgs : ['.'];
      for (const target of targets) {
        const listed = renderScopedList(target, roots, verdict.path, longFormat, allEntries);
        if (!listed.ok) {
          fs.writeSync(fds.errFd, 'workspace.exec: ' + redact(listed.reason) + '\n');
          return finish(EXIT.EXEC_DENY, { ok: false, reason: listed.reason });
        }
        fs.writeSync(fds.outFd, listed.text);
      }
      return finish(0, { ok: true, exitCode: 0 });
    }
    if (cmd.template === 'grep') {
      const rendered = renderScopedGrep(cmd.argv, roots, verdict.path);
      if (!rendered.ok) {
        fs.writeSync(fds.errFd, 'workspace.exec: ' + redact(rendered.reason) + '\n');
        return finish(EXIT.EXEC_DENY, { ok: false, reason: rendered.reason });
      }
      fs.writeSync(fds.outFd, rendered.text);
      return finish(rendered.text ? 0 : 1, { ok: Boolean(rendered.text), exitCode: rendered.text ? 0 : 1 });
    }
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    fs.writeSync(fds.errFd, 'workspace.exec: ' + redact(reason) + '\n');
    return finish(EXIT.EXEC_DENY, { ok: false, reason: reason });
  }

  fs.writeSync(fds.errFd, 'workspace.exec: unsupported command template\n');
  return finish(EXIT.EXEC_DENY, { ok: false, reason: 'unsupported command template' });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') {
        args[key] = '1';
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const op = args.op || 'http.request';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (op === 'fs.read' || op === 'fs.write' || op === 'fs.list' || op === 'fs.search') {
    return runFsOp(args, nowIso);
  }
  if (op === 'workspace.exec') {
    return runWorkspaceExec(args, nowIso);
  }
  if (op !== 'http.request') {
    process.stderr.write('unknown capability op: ' + op + '\n');
    process.exit(EXIT.USAGE);
  }

  const method = (args.method || 'POST').toUpperCase();
  const url = args.url || '';
  const authRef = args['auth-ref'] || '';
  const tainted = args.tainted === '1';
  const approved = args.approved === '1';
  const envFile = args['secret-env-file'] || '';
  const auditFile = args['audit-log'] || '';
  const budgetFile = args['budget-file'] || '';
  const outFile = args.out || '';
  const errFile = args.err || '';
  const bodyFile = args['body-file'] || '';
  const timeoutSeconds = args['timeout-seconds'] || '30';

  if (!url || !outFile || !errFile) {
    process.stderr.write('usage: --url <u> --out <f> --err <f> [--method] [--body-file] [--auth-ref] [--tainted 0|1] [--approved 0|1] [--secret-env-file] [--audit-log] [--budget-file] [--timeout-seconds]\n');
    process.exit(EXIT.USAGE);
  }

  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
  } catch (e) {
    process.stderr.write('cannot open out/err files\n');
    process.exit(EXIT.INTERNAL);
  }

  const finish = (code, verdict, extra) => {
    appendAudit(auditFile, buildAudit(nowIso, method, url, authRef, tainted, verdict, extra));
    try {
      fs.closeSync(outFd);
    } catch (_) {}
    try {
      fs.closeSync(errFd);
    } catch (_) {}
    process.exit(code);
  };

  // 1. Structural classification.
  const verdict = classifyEgress(url, authRef, tainted);
  if (verdict.decision === 'deny') {
    fs.writeSync(errFd, 'capability broker: ' + redact(verdict.reason) + '\n');
    return finish(EXIT.DENY, verdict);
  }
  if (verdict.decision === 'approve' && !approved) {
    // Fail-closed: a non-allowlist host is blocked unless the call site already
    // obtained a human approval (the webhook action path does, and passes
    // --approved 1). Interactive mid-run egress approval is a Phase-0 follow-up.
    fs.writeSync(errFd, 'capability broker: ' + redact(verdict.reason) + ' (egress blocked — not approved)\n');
    return finish(EXIT.APPROVAL_REQUIRED, verdict);
  }

  // 2. Budget (fail-closed).
  const budgetState = loadBudgetState(budgetFile, nowMs);
  const budgetVerdict = checkBudget(budgetState, DEFAULT_BUDGET, nowMs);
  if (!budgetVerdict.ok) {
    fs.writeSync(errFd, 'capability broker: ' + budgetVerdict.reason + '\n');
    return finish(EXIT.BUDGET, verdict, { reason: budgetVerdict.reason });
  }

  // 3. Secret-by-reference resolution (inside the broker only).
  const headers = {};
  if (authRef) {
    const spec = AUTH_REFS[authRef]; // classifyEgress already validated existence + host binding
    const env = envFile ? parseEnvFile(envFile) : {};
    const value = env[spec.envVar];
    if (!value) {
      const reason = 'auth_ref "' + authRef + '" has no configured secret (' + spec.envVar + ')';
      fs.writeSync(errFd, 'capability broker: ' + reason + '\n');
      return finish(EXIT.NO_SECRET, verdict, { reason: reason });
    }
    headers[spec.header] = spec.scheme + value;
  }

  // 4. Body (POST) and send.
  let bodyBuf = null;
  if (method !== 'GET' && bodyFile) {
    try {
      bodyBuf = fs.readFileSync(bodyFile);
    } catch (e) {
      fs.writeSync(errFd, 'capability broker: cannot read body file\n');
      return finish(EXIT.INTERNAL, verdict);
    }
  }

  // Count the call against the budget BEFORE sending (fail-closed: a crash mid-send
  // still consumed the slot). NOTE: http_post_json_retry re-invokes the broker once
  // per transient retry, so each retry counts as a separate egress here — intended,
  // since a retry IS a real outbound request; the budget caps actual egress, not
  // logical calls.
  budgetState.calls += 1;
  saveBudgetState(budgetFile, budgetState);

  sendRequest(
    {
      method: method,
      url: url,
      bodyBuf: bodyBuf,
      headers: headers,
      timeoutSeconds: timeoutSeconds,
      outFd: outFd,
      errFd: errFd,
    },
    (code, status) => {
      finish(code, verdict, { status: status, ok: code === EXIT.OK });
    },
  );
}

main();
