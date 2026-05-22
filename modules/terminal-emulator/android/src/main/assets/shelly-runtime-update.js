#!/usr/bin/env node
/**
 * Shelly-managed runtime updater for native AI CLIs.
 *
 * Updates are staged under ~/.shelly-runtime, smoke-tested, then promoted by
 * switching a `current` symlink. Broken upstream releases never replace the
 * last working version.
 *
 * Usage:
 *   shelly-runtime-update.js [claude|codex|gemini|all] [--force] [--channel verified|stable|latest]
 *
 * Channels (per Codex review 2026-04-25):
 *   verified (default) — try newest first, promote the first candidate that
 *                        passes on-device smoke.
 *   stable             — only promote a release that's been public ≥ 7 days,
 *                        then walk back through smoke-tested candidates.
 *   latest             — promote the npm `latest` tag / GitHub latest release
 *                        immediately after smoke-test PASS.
 *
 * Environment variables:
 *   SHELLY_UPDATER_FUNCTIONAL_CHECK=1
 *     Adds Claude functional canaries beyond `--version`. Exercises DNS,
 *     TLS, auth, actual inference, and the Bash tool path that often breaks
 *     when upstream Claude changes its shell/subprocess implementation.
 *     Gated behind an env var because it requires valid upstream credentials
 *     and consumes a small amount of quota on this device.
 *   SHELLY_UPDATER_TOOL_CANARY=0
 *     Keep the authenticated `--print "Reply exactly OK"` check but skip
 *     the Bash-tool canary. Useful when debugging credentials separately
 *     from Shelly's subprocess compatibility layer.
 *   SHELLY_UPDATER_STABLE_DELAY_DAYS=7
 *     Override stable-channel cooldown in days.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.shelly-runtime');
const TMP = path.join(ROOT, '.tmp');
const LOG = path.join(ROOT, 'update.log');
const LOCK = path.join(ROOT, '.update.lock');
const FAILED_VERSIONS = path.join(ROOT, '.failed-versions');
const NPM_ROOT = path.join(HOME, '.shelly-cli');
const CLAUDE_BUN_TMP = path.join(HOME, '.bun-tmp');
const CLAUDE_TMP = path.join(HOME, '.claude-tmp');
const GENERIC_TMP = path.join(HOME, '.tmp');
const LIB = process.env.SHELLY_LIB_DIR;
const FORCE = process.argv.includes('--force');
// v60 (2026-04-26): --check-only returns exit 0 when an upgrade is available
// without smoke-fail cooldown blocking it, exit 1 when nothing to do.
// Used by the per-launch quick check in .bashrc to decide whether to fire
// the full updater. No network downloads happen in this mode beyond the
// metadata fetch (~10KB per package).
const CHECK_ONLY = process.argv.includes('--check-only');
// 2026-05-08 Codex review (PR #48): 1h was too short. Foreground native
// crashes corrupt the user's TUI; making them re-pay every hour is
// painful. 24h gives the bg updater time to fetch a newer version.
// Debug: set SHELLY_FAILED_VERSION_COOLDOWN=60 to force fast retries.
//
// Codex 3rd-pass review (push-prep): validate the env override so a
// non-numeric value doesn't yield NaN and break (now - epoch) < NaN
// comparisons (which always evaluates false → cooldown becomes a no-op,
// silently bad). Bash side already validates via `*[!0-9]*`; this keeps
// the two halves of the cooldown check in sync.
const __PARSED_FAILED_COOLDOWN = Number(process.env.SHELLY_FAILED_VERSION_COOLDOWN || 86400);
const FAILED_COOLDOWN_S =
  Number.isFinite(__PARSED_FAILED_COOLDOWN) && __PARSED_FAILED_COOLDOWN > 0
    ? __PARSED_FAILED_COOLDOWN
    : 86400;
const TOOL = process.argv.find((arg) => arg === 'claude' || arg === 'codex' || arg === 'gemini') || 'all';

// Channel selection — default `verified` per 2026-04-25 design
// discussion. "Verified" = walk the newest-first candidate list,
// promote the first version that passes smoke. Smoke gates are the
// safety mechanism, not a time cooldown.
const CHANNEL_IDX = process.argv.indexOf('--channel');
const CHANNEL = (CHANNEL_IDX >= 0 && process.argv[CHANNEL_IDX + 1]) || 'verified';
if (!['verified', 'stable', 'latest'].includes(CHANNEL)) {
  console.error(`unknown channel: ${CHANNEL} (expected verified|stable|latest)`);
  process.exit(2);
}
const STABLE_DELAY_DAYS = Number(process.env.SHELLY_UPDATER_STABLE_DELAY_DAYS || 7);
const STABLE_DELAY_MS = STABLE_DELAY_DAYS * 24 * 60 * 60 * 1000;
const CLAUDE_ENV_AUTH_NAMES = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

function hasClaudeEnvAuth() {
  return CLAUDE_ENV_AUTH_NAMES.some((name) => Boolean(process.env[name]));
}

function hasClaudeAuthForCanary() {
  if (hasClaudeEnvAuth()) return true;
  if (fs.existsSync(path.join(HOME, '.claude', '.credentials.json'))) return true;
  try {
    const raw = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(
      parsed?.tokens?.refresh_token
        || parsed?.tokens?.access_token
        || parsed?.oauthAccount?.accountUuid,
    );
  } catch (_e) {
    return false;
  }
}

const FUNCTIONAL_CHECK = process.env.SHELLY_UPDATER_FUNCTIONAL_CHECK === '1'
  || (process.env.SHELLY_UPDATER_FUNCTIONAL_CHECK !== '0' && hasClaudeAuthForCanary());
const TOOL_CANARY = FUNCTIONAL_CHECK && process.env.SHELLY_UPDATER_TOOL_CANARY !== '0';
const NATIVE_CLAUDE_UPDATE = process.env.SHELLY_UPDATER_NATIVE_CLAUDE === '1';

const CLAUDE_BUN_NODE_POLYFILL = `
if (!globalThis.Bun) globalThis.Bun = {};
if (typeof globalThis.Bun.stringWidth !== 'function') {
  globalThis.Bun.stringWidth = function shellyStringWidth(value) {
    let width = 0;
    for (const ch of String(value ?? '')) {
      const code = ch.codePointAt(0);
      if (code === undefined || code === 0) continue;
      if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
      if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) continue;
      width += (
        code >= 0x1100 &&
        (code <= 0x115f ||
          code === 0x2329 ||
          code === 0x232a ||
          (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe10 && code <= 0xfe19) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6) ||
          (code >= 0x1f300 && code <= 0x1faff))
      ) ? 2 : 1;
    }
    return width;
  };
}
// v76 (2026-05-06): Bun.hash shim for the extracted-Node tier. Mirror of
// the bashrc heredoc so the same polyfill applies whether cli.js is run
// from ~/.shelly-cli (legacy npm) or ~/.shelly-runtime/claude-extracted.
if (typeof globalThis.Bun.hash !== 'function') {
  const __shellyCryptoMod = require('crypto');
  const __shellyHashBuf = function(input) {
    if (Buffer.isBuffer(input)) return input;
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
    if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return Buffer.from(new Uint8Array(input));
    return Buffer.from(typeof input === 'string' ? input : String(input ?? ''));
  };
  // v76 review fix (Codex): honour the seed argument of Bun.hash(input, seed)
  // so Bun.hash(K, Bun.hash(q)) varies with q.
  const __shellySeedBuf = function(seed) {
    return seed === undefined ? Buffer.alloc(0) : Buffer.from(String(seed));
  };
  const __shellyHash64 = function(input, seed) {
    const hex = __shellyCryptoMod.createHash('sha256').update(__shellySeedBuf(seed)).update(Buffer.from([0])).update(__shellyHashBuf(input)).digest('hex');
    return BigInt('0x' + hex.slice(0, 16));
  };
  const __shellyHash32 = function(input, seed) {
    const hex = __shellyCryptoMod.createHash('sha256').update(__shellySeedBuf(seed)).update(Buffer.from([0])).update(__shellyHashBuf(input)).digest('hex');
    return parseInt(hex.slice(0, 8), 16) >>> 0;
  };
  const __shellyHashBase = function(input, seed) { return __shellyHash64(input, seed); };
  __shellyHashBase.wyhash = __shellyHash64;
  __shellyHashBase.cityHash64 = __shellyHash64;
  __shellyHashBase.xxHash3 = __shellyHash64;
  __shellyHashBase.xxHash64 = __shellyHash64;
  __shellyHashBase.murmur64v1 = __shellyHash64;
  __shellyHashBase.murmur64v2 = __shellyHash64;
  __shellyHashBase.rapidhash = __shellyHash64;
  __shellyHashBase.cityHash32 = __shellyHash32;
  __shellyHashBase.xxHash32 = __shellyHash32;
  __shellyHashBase.murmur32v2 = __shellyHash32;
  __shellyHashBase.murmur32v3 = __shellyHash32;
  __shellyHashBase.adler32 = __shellyHash32;
  __shellyHashBase.crc32 = __shellyHash32;
  globalThis.Bun.hash = __shellyHashBase;
}
// v82 (2026-05-08): Bun.* polyfill expansion. Sync mirror of the
// HomeInitializer.kt heredoc — Claude Code 2.1.133's cli.js wraps every
// Bun.* call in \`typeof Bun !== "u"\` guards then unconditionally
// invokes the member, so when our polyfill installs \`Bun = {}\` every
// guard takes the Bun branch and unfilled members crash. Repro 2026-05-08
// on Z Fold6: \`globalThis.Bun.which is not a function\`. Audit found 4
// surfaces called every startup (which / semver / YAML / gc) plus 1 rare
// (generateHeapSnapshot) that we shim for safety. The remaining Bun.*
// (wrapAnsi / JSONL / embeddedFiles / listen / spawn / version) are
// tolerantly handled by cli.js when undefined and stay absent.
if (typeof globalThis.Bun.which !== 'function') {
  const __shellyChild = require('child_process');
  globalThis.Bun.which = function shellyBunWhich(name) {
    if (!name) return null;
    try {
      const r = __shellyChild.spawnSync('which', [String(name)], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 1000 });
      if (r.status === 0 && r.stdout) return r.stdout.trim() || null;
    } catch (_) {}
    return null;
  };
}
if (!globalThis.Bun.semver || typeof globalThis.Bun.semver.order !== 'function') {
  const __shellySemverCmp = function(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.+-]/).map(function(x){ return /^\\d+$/.test(x) ? Number(x) : x; });
    const pb = String(b).replace(/^v/, '').split(/[.+-]/).map(function(x){ return /^\\d+$/.test(x) ? Number(x) : x; });
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] === undefined ? 0 : pa[i];
      const y = pb[i] === undefined ? 0 : pb[i];
      if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x < y ? -1 : 1; }
      else { const sx = String(x), sy = String(y); if (sx !== sy) return sx < sy ? -1 : 1; }
    }
    return 0;
  };
  globalThis.Bun.semver = {
    order: __shellySemverCmp,
    satisfies: function(version, range) {
      const v = String(version).replace(/^v/, '');
      const r = String(range).trim();
      const m = r.match(/^([<>]=?|=)?\\s*v?([\\w.+-]+)$/);
      if (!m) return false;
      const op = m[1] || '=', target = m[2];
      const c = __shellySemverCmp(v, target);
      return op === '=' ? c === 0 : op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c < 0;
    }
  };
}
if (!globalThis.Bun.YAML || typeof globalThis.Bun.YAML.parse !== 'function') {
  globalThis.Bun.YAML = {
    parse: function(s) {
      try { return require('yaml').parse(String(s)); }
      catch (e) { throw new Error('Shelly Bun.YAML.parse: yaml package unavailable: ' + e.message); }
    }
  };
}
if (typeof globalThis.Bun.gc !== 'function') {
  globalThis.Bun.gc = function shellyBunGc() {
    try { if (typeof global !== 'undefined' && typeof global.gc === 'function') global.gc(); }
    catch (_) {}
  };
}
if (typeof globalThis.Bun.generateHeapSnapshot !== 'function') {
  globalThis.Bun.generateHeapSnapshot = function() { throw new Error('Bun.generateHeapSnapshot unavailable on Shelly Node tier'); };
}
if (typeof globalThis.Bun.version !== 'string') {
  globalThis.Bun.version = '1.3.0-shelly-node';
}
if (typeof globalThis.Bun.stripANSI !== 'function') {
  globalThis.Bun.stripANSI = function shellyStripANSI(value) {
    return String(value ?? '').replace(/\\x1B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])/g, '');
  };
}
if (typeof globalThis.Bun.wrapAnsi !== 'function') {
  globalThis.Bun.wrapAnsi = function shellyWrapAnsi(value, columns) {
    const text = String(value ?? '');
    const width = Math.max(1, Number(columns) || 80);
    const lines = [];
    for (const line of text.split('\\n')) {
      let rest = line;
      while (globalThis.Bun.stringWidth(rest) > width) {
        let cut = 0, used = 0;
        for (const ch of rest) {
          const w = globalThis.Bun.stringWidth(ch);
          if (used + w > width) break;
          used += w;
          cut += ch.length;
        }
        lines.push(rest.slice(0, Math.max(cut, 1)));
        rest = rest.slice(Math.max(cut, 1));
      }
      lines.push(rest);
    }
    return lines.join('\\n');
  };
}
if (!globalThis.Bun.stdin) {
  globalThis.Bun.stdin = process.stdin;
}
if (!globalThis.Bun.embeddedFiles) {
  globalThis.Bun.embeddedFiles = [];
}
if (!globalThis.Bun.JSONL) {
  globalThis.Bun.JSONL = {
    parse: function(value) { return String(value ?? '').split(/\\r?\\n/).filter(Boolean).map(function(line) { return JSON.parse(line); }); },
    stringify: function(values) { return Array.from(values ?? []).map(function(value) { return JSON.stringify(value); }).join('\\n'); }
  };
}
(function shellyPatchClaudeChildProcessShell() {
  const SHELLY_CLAUDE_SHELL_PATCH_VERSION = 3;
  const childProcess = require('child_process');
  const shellyDiag = process.env.SHELLY_CLAUDE_DIAG === '1';
  const shellyDiagValue = function(value) {
    if (Array.isArray(value)) return { first: String(value[0] ?? ''), length: value.length };
    if (!value || typeof value !== 'object') return value;
    const out = {};
    if (value.cmd !== undefined) out.cmd = Array.isArray(value.cmd) ? { first: String(value.cmd[0] ?? ''), length: value.cmd.length } : String(value.cmd);
    if (value.cwd !== undefined) out.cwd = value.cwd;
    if (value.shell !== undefined) out.shell = value.shell;
    if (value.stdin !== undefined) out.stdin = typeof value.stdin === 'string' ? value.stdin : typeof value.stdin;
    if (value.stdout !== undefined) out.stdout = value.stdout;
    if (value.stderr !== undefined) out.stderr = value.stderr;
    if (value.stdio !== undefined) {
      out.stdio = (Array.isArray(value.stdio) ? value.stdio : [value.stdio]).map(function(item) {
        return item === null ? 'null'
          : typeof item === 'number' ? 'fd:' + item
          : typeof item === 'object' ? 'obj:' + Object.keys(item).join(',')
          : String(item);
      });
    }
    if (value.env) {
      out.env = {};
      for (const key of ['HOME', 'PATH', 'SHELL', 'BASH', 'SHELLY_LIB_DIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'TMPDIR', 'BUN_TMPDIR', 'CLAUDE_TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']) {
        if (value.env[key] !== undefined) out.env[key] = value.env[key];
      }
    }
    return out;
  };
  const shellyDiagCommand = function(value) {
    const text = String(value ?? '');
    const risky = /\s/.test(text) || [59, 38, 124, 60, 62, 36, 96, 92, 39, 34, 40, 41, 123, 125, 91, 93, 42, 63, 33].some(function(code) { return text.includes(String.fromCharCode(code)); });
    return risky ? '[redacted command]' : text;
  };
  const shellyDiagLog = function(label, value) {
    if (!shellyDiag) return;
    try {
      const json = JSON.stringify(value);
      process.stderr.write('[SHELLY-CLAUDE-SPAWN] ' + label + ' ' + json + '\\n');
    } catch (err) {
      try { process.stderr.write('[SHELLY-CLAUDE-SPAWN] ' + label + ' <log failed: ' + err.message + '>\\n'); } catch (_) {}
    }
  };
  const shellyShellPath = function() { return process.env.SHELL || '/system/bin/sh'; };
  const shellyLibDir = function() {
    return process.env.SHELLY_LIB_DIR || require('path').dirname(shellyShellPath());
  };
  const shellyHome = function() {
    return process.env.HOME || '/data/data/dev.shelly.terminal/files/home';
  };
  const shellyRepairPath = function(pathValue) {
    const seen = Object.create(null);
    const parts = [shellyHome() + '/bin', shellyLibDir(), '/system/bin', '/vendor/bin']
      .concat(String(pathValue || process.env.PATH || '').split(':'));
    return parts.filter(function(part) {
      if (!part || seen[part]) return false;
      seen[part] = true;
      return true;
    }).join(':');
  };
  const shellyRepairEnv = function(env) {
    const out = Object.assign({}, process.env, env || {});
    out.HOME = out.HOME || shellyHome();
    out.PATH = shellyRepairPath(out.PATH);
    out.SHELL = shellyCommandValue(out.SHELL || shellyShellPath());
    out.BASH = shellyCommandValue(out.BASH || shellyShellPath());
    out.SHELLY_LIB_DIR = out.SHELLY_LIB_DIR || shellyLibDir();
    out.LD_LIBRARY_PATH = out.LD_LIBRARY_PATH || shellyLibDir();
    out.LD_PRELOAD = out.LD_PRELOAD || (shellyLibDir() + '/libexec_wrapper.so');
    out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB || '0';
    out.ANDROID_ROOT = out.ANDROID_ROOT || process.env.ANDROID_ROOT || '/system';
    out.ANDROID_DATA = out.ANDROID_DATA || process.env.ANDROID_DATA || '/data';
    out.TMPDIR = out.TMPDIR || process.env.TMPDIR || (shellyHome() + '/.tmp');
    out.BUN_TMPDIR = out.BUN_TMPDIR || process.env.BUN_TMPDIR || (shellyHome() + '/.bun-tmp');
    out.CLAUDE_TMPDIR = out.CLAUDE_TMPDIR || process.env.CLAUDE_TMPDIR || (shellyHome() + '/.claude-tmp');
    out.CLAUDE_CODE_TMPDIR = out.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_CODE_TMPDIR || out.CLAUDE_TMPDIR;
    return out;
  };
  const shellyShellValue = function(value) {
    if (value === true || value === undefined) return shellyShellPath();
    const s = String(value);
    return (s === '/bin/sh' || s === '/bin/bash' || s === '/usr/bin/sh' || s === '/usr/bin/bash' || s === 'sh' || s === 'bash') ? shellyShellPath() : value;
  };
  const shellyCommandValue = function(value) {
    const s = String(value);
    return (s === '/bin/sh' || s === '/bin/bash' || s === '/usr/bin/sh' || s === '/usr/bin/bash' || s === 'sh' || s === 'bash') ? shellyShellPath() : value;
  };
  const shellyShellPathCandidates = function() {
    const seen = Object.create(null);
    const out = [];
    const add = function(value) {
      if (!value) return;
      const text = String(value);
      if (!text || seen[text]) return;
      seen[text] = true;
      out.push(text);
      if (text.indexOf('/data/user/0/') === 0) add('/data/data/' + text.slice('/data/user/0/'.length));
      if (text.indexOf('/data/data/') === 0) add('/data/user/0/' + text.slice('/data/data/'.length));
    };
    add(shellyShellPath());
    add(process.env.BASH);
    add(shellyHome() + '/bin/bash');
    return out;
  };
  const shellyPatchTrace = function(message) {
    if (process.env.SHELLY_CLAUDE_PATCH_TRACE !== '1') return;
    try {
      require('fs').appendFileSync(
        shellyHome() + '/.shelly-claude-patch.log',
        Date.now() + ' ' + message + String.fromCharCode(10)
      );
    } catch (_) {}
  };
  shellyPatchTrace('preload loaded argvCount=' + (process.argv ? process.argv.length : 0));
  const shellyTraceCommandKind = function(value) {
    if (value == null) return 'null';
    const text = String(value);
    const base = text.split('/').filter(Boolean).pop() || text;
    if (base === 'bash' || base === 'sh' || base === 'shelly_shell') return base;
    if (base === 'env' || base === 'node' || base === 'bun' || base === 'timeout') return base;
    if (base.indexOf('claude') >= 0) return 'claude';
    return 'other';
  };
  const shellyTraceArgTags = function(value) {
    if (typeof value !== 'string') return 'nonstring';
    const tags = ['len=' + value.length];
    if (value === '-c' || value === '-lc' || value === '-l' || value === '-i' || value === '--') tags.push('flag=' + value);
    if (value.indexOf('LD_PRELOAD') >= 0) tags.push('ldpreload');
    if (value.indexOf('LD_LIBRARY_PATH') >= 0) tags.push('ldpath');
    if (value.indexOf('SHELLY_PATCH_OK') >= 0) tags.push('patchok');
    if (value.indexOf('SHELLY_BASH_CANARY') >= 0) tags.push('canary');
    if (value.indexOf('SHELLY_LIB_DIR') >= 0) tags.push('libdir');
    if (value.indexOf('/dev/fd') >= 0) tags.push('devfd');
    if (value.indexOf('/proc/self/fd') >= 0) tags.push('procfd');
    if (value.indexOf('BASH_XTRACEFD') >= 0) tags.push('xtracefd');
    if (value.indexOf('CLAUDE_CODE_TMPDIR') >= 0) tags.push('claudetmp');
    if (value.indexOf('TMPDIR') >= 0) tags.push('tmpdir');
    if (value.indexOf('printf') >= 0) tags.push('printf');
    if (value.indexOf('exec') >= 0) tags.push('exec');
    if (value.indexOf('exit') >= 0) tags.push('exit');
    if (value.indexOf('trap') >= 0) tags.push('trap');
    if (value.indexOf('set -e') >= 0 || value.indexOf('set -o errexit') >= 0) tags.push('sete');
    if (value.indexOf('env') >= 0) tags.push('env');
    if (value.indexOf('|') >= 0) tags.push('pipe');
    if (value.indexOf('>') >= 0 || value.indexOf('<') >= 0) tags.push('redir');
    if (value.indexOf('$(') >= 0 || value.indexOf(String.fromCharCode(96)) >= 0) tags.push('cmdsubst');
    if (value.indexOf('<<') >= 0) tags.push('heredoc');
    if (value.indexOf('bash') >= 0 || value.indexOf('/sh') >= 0) tags.push('shellword');
    return tags.join(':');
  };
  const shellyTraceArgsShape = function(args) {
    if (!Array.isArray(args)) return 'not-array';
    return args.map(function(arg) { return shellyTraceArgTags(arg); }).join(',');
  };
  const shellyTraceStdioShape = function(value) {
    if (value === undefined) return 'unset';
    const list = Array.isArray(value) ? value : [value];
    return list.map(function(item) {
      if (item === null) return 'null';
      if (item === undefined) return 'undefined';
      if (typeof item === 'number') return 'fd:' + item;
      if (typeof item === 'string') return (item === 'pipe' || item === 'ignore' || item === 'inherit' || item === 'ipc') ? item : 'string';
      if (item && typeof item === 'object' && typeof item.fd === 'number') return 'objfd:' + item.fd;
      return typeof item;
    }).join(',');
  };
  const shellyTraceRawString = function(value) {
    return JSON.stringify(String(value).slice(0, 300));
  };
  const shellyTraceRawChildShape = function(prefix, args, options) {
    if (process.env.SHELLY_CLAUDE_PATCH_RAW !== '1') return;
    try {
      if (Array.isArray(args)) {
        args.forEach(function(arg, i) {
          shellyPatchTrace(prefix + ' rawArg' + i + '=' + shellyTraceRawString(arg));
        });
      }
      const env = options && options.env;
      if (env) {
        shellyPatchTrace(prefix + ' rawEnvKeys=' + Object.keys(env).sort().join(','));
        ['PATH', 'SHELL', 'BASH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'SHELLY_LIB_DIR', 'LD_LIBRARY_PATH', 'LD_PRELOAD'].forEach(function(key) {
          if (env[key] !== undefined) shellyPatchTrace(prefix + ' rawEnv.' + key + '=' + shellyTraceRawString(env[key]));
        });
      }
    } catch (_) {}
  };
  const shellyTraceEnvShape = function(options) {
    const env = options && options.env;
    return [
      'hasEnv=' + Boolean(env),
      'envLD=' + Boolean(env && env.LD_PRELOAD),
      'envLib=' + Boolean(env && env.LD_LIBRARY_PATH),
      'envShell=' + Boolean(env && env.SHELL),
      'envBash=' + Boolean(env && env.BASH),
      'envShellyLib=' + Boolean(env && env.SHELLY_LIB_DIR),
      'envScrub=' + Boolean(env && env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB),
      'envPath=' + Boolean(env && env.PATH),
      'envAndroidRoot=' + Boolean(env && env.ANDROID_ROOT),
      'envAndroidData=' + Boolean(env && env.ANDROID_DATA),
      'envTmp=' + Boolean(env && env.TMPDIR),
      'envClaudeTmp=' + Boolean(env && env.CLAUDE_CODE_TMPDIR),
    ].join(' ');
  };
  const shellyTraceOptionsShape = function(options) {
    if (!options || typeof options !== 'object') return 'options=none';
    let shellKind = 'none';
    if (options.shell === true) shellKind = 'true';
    else if (typeof options.shell === 'string') shellKind = shellyTraceCommandKind(options.shell);
    return 'stdio=' + shellyTraceStdioShape(options.stdio)
      + ' shell=' + shellKind
      + ' ' + shellyTraceEnvShape(options);
  };
  const shellyTraceChildShape = function(prefix, cmd, args, options) {
    shellyPatchTrace(prefix
      + ' cmdKind=' + shellyTraceCommandKind(cmd)
      + ' cmdLen=' + (cmd == null ? 0 : String(cmd).length)
      + ' argShape=' + shellyTraceArgsShape(args)
      + ' ' + shellyTraceOptionsShape(options));
  };
  const shellyTraceErrorCode = function(error) {
    if (!error) return 'none';
    return String(error.code || error.name || 'error');
  };
  const shellyPatchNestedEnvString = function(arg, source) {
    if (typeof arg !== 'string') return arg;
    const marker = arg.indexOf('&& env ');
    if (marker < 0) {
      shellyPatchTrace(source + ' no-marker length=' + arg.length);
      return arg;
    }
    const tail = arg.slice(marker);
    const candidates = shellyShellPathCandidates().flatMap(function(shellPath) {
      return ["'" + shellPath + "'", '"' + shellPath + '"', shellPath].flatMap(function(token) {
        const matches = [];
        let from = 0;
        while (from < tail.length) {
          const index = tail.indexOf(token, from);
          if (index < 0) break;
          matches.push({ token, shellPath, index });
          from = index + token.length;
        }
        return matches;
      });
    })
      .filter(function(item) {
        if (item.index < 0) return false;
        const prev = item.index === 0 ? ' ' : tail[item.index - 1];
        if (prev === '=') return false;
        const prevCode = prev.charCodeAt(0);
        if (item.token[0] !== "'" && item.token[0] !== '"' && prevCode !== 32 && prevCode !== 9 && prevCode !== 10) return false;
        return true;
      })
      .sort(function(a, b) { return a.index - b.index; });
    if (candidates.length === 0) {
      shellyPatchTrace(source + ' miss no-candidate marker=' + marker + ' tailLength=' + tail.length + ' candidateCount=' + shellyShellPathCandidates().length);
      return arg;
    }
    const libDir = shellyLibDir();
    const inject = 'LD_LIBRARY_PATH=' + libDir + ' LD_PRELOAD=' + libDir + '/libexec_wrapper.so ';
    const picked = candidates[0];
    const commandPrefix = '/system/bin/linker64 ';
    const absoluteIndex = marker + picked.index;
    const prefix = arg.slice(0, absoluteIndex);
    if (prefix.slice(-(inject.length + commandPrefix.length)) === inject + commandPrefix) {
      shellyPatchTrace(source + ' skip already-injected token=' + JSON.stringify(picked.token));
      return arg;
    }
    if (prefix.slice(-inject.length) === inject) {
      shellyPatchTrace(source + ' fired token=' + JSON.stringify(picked.token) + ' index=' + absoluteIndex + ' linker=1 existing-env=1');
      return prefix + commandPrefix + arg.slice(absoluteIndex);
    }
    shellyPatchTrace(source + ' fired token=' + JSON.stringify(picked.token) + ' index=' + absoluteIndex + ' linker=1');
    return prefix + inject + commandPrefix + arg.slice(absoluteIndex);
  };
  const shellyPatchNestedEnvArgs = function(args) {
    if (!Array.isArray(args)) return args;
    let stringArgCount = 0;
    let markerCount = 0;
    args.forEach(function(arg) {
      if (typeof arg === 'string') {
        stringArgCount += 1;
        if (arg.indexOf('&& env ') >= 0) markerCount += 1;
      }
    });
    shellyPatchTrace('nestedArgs entry argCount=' + args.length + ' stringArgCount=' + stringArgCount + ' markerCount=' + markerCount);
    return args.map(function(arg) { return shellyPatchNestedEnvString(arg, 'argv'); });
  };
  const shellyPatchShellArgv = function(cmd, args) {
    if (!Array.isArray(args) || args.length < 3) return args;
    const kind = shellyTraceCommandKind(cmd);
    if (kind !== 'bash' && kind !== 'sh' && kind !== 'shelly_shell') return args;
    if (args[0] !== '-c' || args[1] !== '-l') return args;
    shellyPatchTrace('shellArgv repaired -c -l to -lc cmdKind=' + kind + ' argCount=' + args.length);
    return ['-lc', args[2]].concat(args.slice(3));
  };
  const shellyPatchAsyncShellExec = function(name, args) {
    if (name !== 'spawn' && name !== 'execFile') return;
    if (!Array.isArray(args) || !Array.isArray(args[1])) return;
    if (!shellyShellPathCandidates().includes(String(args[0]))) return;
    shellyPatchTrace('shellExec routed through linker name=' + name + ' argCount=' + args[1].length);
    args[1] = [String(args[0])].concat(args[1]);
    args[0] = '/system/bin/linker64';
  };
  const normalizeOptions = function(options, forceShell) {
    const out = (!options || typeof options !== 'object') ? {} : Object.assign({}, options);
    if (forceShell || out.shell !== undefined) out.shell = shellyShellValue(out.shell);
    out.env = shellyRepairEnv(out.env);
    return out;
  };
  const expandShellSpawn = function(name, args) {
    if (name !== 'spawn' && name !== 'spawnSync') return;
    if (typeof args[0] !== 'string') return;
    const command = String(args[0]);
    const optionsIndex = args.length >= 3 ? 2 : (args.length >= 2 && !Array.isArray(args[1]) ? 1 : -1);
    if (optionsIndex < 0) return;
    const options = args[optionsIndex];
    if (!options || typeof options !== 'object' || options.shell === undefined || options.shell === false) return;
    const commandArgs = Array.isArray(args[1]) ? args[1] : [];
    if (commandArgs.length !== 0) return;
    const shell = shellyShellValue(options.shell);
    const nextOptions = Object.assign({}, options);
    delete nextOptions.shell;
    args[0] = String(shell);
    args[1] = ['-lc', command];
    args[2] = nextOptions;
  };
  const wrap = function(name, index) {
    const original = childProcess[name];
    if (typeof original !== 'function' || original.__shellyShellPatched) return;
    const patched = function(...args) {
      const beforeOptions = args[2] || args[1];
      const beforeHasShell = beforeOptions && typeof beforeOptions === 'object' && beforeOptions.shell !== undefined && beforeOptions.shell !== false;
      shellyPatchTrace('child entry name=' + name + ' argc=' + args.length + ' arg1Array=' + Array.isArray(args[1]) + ' beforeHasShell=' + Boolean(beforeHasShell));
      const before = { cmd: beforeHasShell ? '[redacted command]' : shellyDiagCommand(args[0]), argCount: Array.isArray(args[1]) ? args[1].length : null, options: beforeOptions };
      if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && args.length > 0) {
        args[0] = shellyCommandValue(args[0]);
      }
      const i = index(args);
      if (i >= 0) args[i] = normalizeOptions(args[i], false);
      else if (name === 'execFile' && typeof args[args.length - 1] === 'function') args.splice(args.length - 1, 0, normalizeOptions(undefined, false));
      else if (name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') args.push(normalizeOptions(undefined, false));
      expandShellSpawn(name, args);
      if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && shellyCommandValue(args[0]) === shellyShellPath() && Array.isArray(args[1])) {
        args[1] = shellyPatchNestedEnvArgs(args[1]);
      }
      if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && Array.isArray(args[1])) {
        args[1] = shellyPatchShellArgv(args[0], args[1]);
      }
      shellyPatchAsyncShellExec(name, args);
      const afterOptions = args.length >= 3 && args[2] && typeof args[2] === 'object' && !Array.isArray(args[2]) && typeof args[2] !== 'function'
        ? args[2]
        : (args.length >= 2 && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) && typeof args[1] !== 'function' ? args[1] : null);
      shellyTraceChildShape('child normalized name=' + name, args[0], Array.isArray(args[1]) ? args[1] : [], afterOptions);
      shellyTraceRawChildShape('child raw name=' + name, Array.isArray(args[1]) ? args[1] : [], afterOptions);
      shellyDiagLog('child_process.' + name, { before: shellyDiagValue(before), after: { cmd: shellyDiagCommand(args[0]), argCount: Array.isArray(args[1]) ? args[1].length : null, options: shellyDiagValue(args[2] || args[1]) } });
      if (name === 'spawnSync') {
        const result = original.apply(this, args);
        shellyPatchTrace('child result name=spawnSync status=' + result.status + ' signal=' + (result.signal || 'none') + ' error=' + shellyTraceErrorCode(result.error) + ' stdoutLen=' + (result.stdout ? result.stdout.length : 0) + ' stderrLen=' + (result.stderr ? result.stderr.length : 0));
        return result;
      }
      if (name === 'execFileSync') {
        try {
          const result = original.apply(this, args);
          shellyPatchTrace('child result name=execFileSync ok=true stdoutLen=' + (result ? result.length : 0));
          return result;
        } catch (error) {
          shellyPatchTrace('child result name=execFileSync throw=' + shellyTraceErrorCode(error) + ' status=' + (error && error.status !== undefined ? error.status : 'unknown') + ' signal=' + (error && error.signal ? error.signal : 'none') + ' stdoutLen=' + (error && error.stdout ? error.stdout.length : 0) + ' stderrLen=' + (error && error.stderr ? error.stderr.length : 0));
          throw error;
        }
      }
      const child = original.apply(this, args);
      try {
        if (child && typeof child.on === 'function') {
          child.on('exit', function(code, signal) {
            shellyPatchTrace('child result name=' + name + ' exit=' + (code === null || code === undefined ? 'null' : code) + ' signal=' + (signal || 'none'));
          });
        }
      } catch (_) {}
      return child;
    };
    try { Object.defineProperty(patched, '__shellyShellPatched', { value: true }); } catch (_) {}
    childProcess[name] = patched;
  };
  const wrapExec = function(name) {
    const original = childProcess[name];
    if (typeof original !== 'function' || original.__shellyShellPatched) return;
    const patched = function(command, options, callback) {
      shellyPatchTrace('exec entry name=' + name + ' hasOptions=' + (options !== undefined) + ' optionsIsCallback=' + (typeof options === 'function'));
      command = shellyPatchNestedEnvString(command, 'exec.' + name);
      if (typeof options === 'function') {
        const normalized = normalizeOptions(undefined, true);
        shellyTraceChildShape('exec normalized name=' + name, normalized.shell, ['-c', String(command)], normalized);
        shellyDiagLog('child_process.' + name, { command: '[redacted shell command]', options: shellyDiagValue(normalized) });
        return original.call(this, command, normalized, options);
      }
      if (options === undefined) {
        const normalized = normalizeOptions(undefined, true);
        shellyTraceChildShape('exec normalized name=' + name, normalized.shell, ['-c', String(command)], normalized);
        shellyDiagLog('child_process.' + name, { command: '[redacted shell command]', options: shellyDiagValue(normalized) });
        if (name === 'execSync') {
          try {
            const result = original.call(this, command, normalized, callback);
            shellyPatchTrace('exec result name=' + name + ' ok=true stdoutLen=' + (result ? result.length : 0));
            return result;
          } catch (error) {
            shellyPatchTrace('exec result name=' + name + ' throw=' + shellyTraceErrorCode(error) + ' status=' + (error && error.status !== undefined ? error.status : 'unknown') + ' signal=' + (error && error.signal ? error.signal : 'none') + ' stdoutLen=' + (error && error.stdout ? error.stdout.length : 0) + ' stderrLen=' + (error && error.stderr ? error.stderr.length : 0));
            throw error;
          }
        }
        return original.call(this, command, normalized, callback);
      }
      const normalized = normalizeOptions(options, true);
      shellyTraceChildShape('exec normalized name=' + name, normalized.shell, ['-c', String(command)], normalized);
      shellyDiagLog('child_process.' + name, { command: '[redacted shell command]', options: shellyDiagValue(normalized) });
      if (name === 'execSync') {
        try {
          const result = original.call(this, command, normalized, callback);
          shellyPatchTrace('exec result name=' + name + ' ok=true stdoutLen=' + (result ? result.length : 0));
          return result;
        } catch (error) {
          shellyPatchTrace('exec result name=' + name + ' throw=' + shellyTraceErrorCode(error) + ' status=' + (error && error.status !== undefined ? error.status : 'unknown') + ' signal=' + (error && error.signal ? error.signal : 'none') + ' stdoutLen=' + (error && error.stdout ? error.stdout.length : 0) + ' stderrLen=' + (error && error.stderr ? error.stderr.length : 0));
          throw error;
        }
      }
      return original.call(this, command, normalized, callback);
    };
    try { Object.defineProperty(patched, '__shellyShellPatched', { value: true }); } catch (_) {}
    childProcess[name] = patched;
  };
  wrap('spawn', function(args) { return args.length >= 3 ? 2 : (args.length >= 2 && !Array.isArray(args[1]) ? 1 : -1); });
  wrap('spawnSync', function(args) { return args.length >= 3 ? 2 : (args.length >= 2 && !Array.isArray(args[1]) ? 1 : -1); });
  wrapExec('exec');
  wrapExec('execSync');
  wrap('execFile', function(args) { return args.length >= 3 && typeof args[2] !== 'function' ? 2 : (args.length >= 2 && !Array.isArray(args[1]) && typeof args[1] !== 'function' ? 1 : -1); });
  wrap('execFileSync', function(args) { return args.length >= 3 ? 2 : (args.length >= 2 && !Array.isArray(args[1]) ? 1 : -1); });
  if (typeof globalThis.Bun.spawn !== 'function') {
    const stream = require('stream');
    const toBunReadable = function(value) {
      if (!value) return null;
      const web = typeof value.getReader === 'function'
        ? value
        : (typeof stream.Readable?.toWeb === 'function' ? stream.Readable.toWeb(value) : value);
      if (web && typeof web.text !== 'function') {
        web.text = function() { return new Response(web).text(); };
      }
      if (web && typeof web.arrayBuffer !== 'function') {
        web.arrayBuffer = function() { return new Response(web).arrayBuffer(); };
      }
      if (web && typeof web.json !== 'function') {
        web.json = function() { return new Response(web).json(); };
      }
      return web;
    };
    const toWebWritable = function(value) {
      if (!value || typeof value.getWriter === 'function') return value || null;
      return typeof stream.Writable?.toWeb === 'function' ? stream.Writable.toWeb(value) : value;
    };
    const applyBunSpawnOptions = function(spawnOptions) {
      const isMode = function(v) {
        return v === 'inherit' || v === 'ignore' || v === 'pipe'
          || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
          || (v && typeof v === 'object' && typeof v.fd === 'number');
      };
      const map = function(v, fallback) { return isMode(v) ? v : fallback; };
      if (spawnOptions.stdio === undefined && (
        spawnOptions.stdin !== undefined || spawnOptions.stdout !== undefined || spawnOptions.stderr !== undefined
      )) {
        spawnOptions.stdio = [
          map(spawnOptions.stdin, 'ignore'),
          map(spawnOptions.stdout, 'pipe'),
          map(spawnOptions.stderr, 'pipe'),
        ];
      }
      delete spawnOptions.stdin;
      delete spawnOptions.stdout;
      delete spawnOptions.stderr;
    };
    const normalizeBunSpawnSpec = function(command, options) {
      const spec = command && typeof command === 'object' && !Array.isArray(command) ? command : null;
      const cmdSpec = spec && spec.cmd !== undefined ? spec.cmd : command;
      const cmd = Array.isArray(cmdSpec) ? cmdSpec[0] : cmdSpec;
      const args = Array.isArray(cmdSpec) ? cmdSpec.slice(1) : [];
      const spawnOptions = Object.assign({}, options || {});
      const onExit = typeof spawnOptions.onExit === 'function'
        ? spawnOptions.onExit
        : (spec && typeof spec.onExit === 'function' ? spec.onExit : null);
      delete spawnOptions.onExit;
      let stdinPayload = null;
      const isMode = function(v) {
        return v === 'inherit' || v === 'ignore' || v === 'pipe'
          || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
          || (v && typeof v === 'object' && typeof v.fd === 'number');
      };
      if (spec) {
        if (spec.cwd) spawnOptions.cwd = spec.cwd;
        if (spec.env) spawnOptions.env = shellyRepairEnv(spec.env);
        if (spawnOptions.stdio === undefined) {
          const map = function(v, fallback) { return isMode(v) ? v : fallback; };
          stdinPayload = spec.stdin && !isMode(spec.stdin) ? spec.stdin : null;
          spawnOptions.stdio = [stdinPayload ? 'pipe' : map(spec.stdin, 'ignore'), map(spec.stdout, 'pipe'), map(spec.stderr, 'pipe')];
        }
        if (spec.shell !== undefined) spawnOptions.shell = spec.shell;
      }
      if (!spec && spawnOptions.stdio === undefined && spawnOptions.stdin !== undefined && !isMode(spawnOptions.stdin)) {
        stdinPayload = spawnOptions.stdin;
        spawnOptions.stdin = 'pipe';
      }
      applyBunSpawnOptions(spawnOptions);
      return {
        cmd: String(shellyCommandValue(cmd)),
        args: args.map(String),
        options: normalizeOptions(spawnOptions, false),
        stdinPayload,
        onExit,
      };
    };
    globalThis.Bun.spawn = function shellyBunSpawn(command, options) {
      const normalized = normalizeBunSpawnSpec(command, options);
      shellyPatchTrace('Bun.spawn entry argCount=' + normalized.args.length + ' hasShell=' + Boolean(normalized.options && normalized.options.shell) + ' hasStdinPayload=' + (normalized.stdinPayload != null));
      shellyDiagLog('Bun.spawn', { cmd: shellyDiagCommand(normalized.cmd), argCount: normalized.args.length, options: shellyDiagValue(normalized.options), hasStdinPayload: normalized.stdinPayload != null, hasOnExit: Boolean(normalized.onExit) });
      const child = childProcess.spawn(normalized.cmd, normalized.args, normalized.options);
      if (normalized.stdinPayload != null && child.stdin) {
        try {
          if (typeof normalized.stdinPayload === 'string' || Buffer.isBuffer(normalized.stdinPayload) || normalized.stdinPayload instanceof Uint8Array) {
            child.stdin.end(normalized.stdinPayload);
          } else if (normalized.stdinPayload && typeof normalized.stdinPayload.arrayBuffer === 'function') {
            normalized.stdinPayload.arrayBuffer().then(function(ab) { child.stdin.end(Buffer.from(ab)); }, function() { child.stdin.end(); });
          } else {
            child.stdin.end(String(normalized.stdinPayload));
          }
        } catch (_) {
          try { child.stdin.end(); } catch (_) {}
        }
      }
      const exited = new Promise(function(resolve) {
        child.on('exit', function(code, signal) { resolve(code ?? (signal ? 1 : 0)); });
        child.on('error', function() { resolve(1); });
      });
      const subprocess = {
        pid: child.pid,
        stdin: toWebWritable(child.stdin),
        stdout: toBunReadable(child.stdout),
        stderr: toBunReadable(child.stderr),
        exited,
        kill: function(signal) { return child.kill(signal); },
        ref: function() { child.ref(); return this; },
        unref: function() { child.unref(); return this; },
        get exitCode() { return child.exitCode; },
        get signalCode() { return child.signalCode; },
        nodeChildProcess: child,
      };
      if (normalized.onExit) {
        child.on('exit', function(code, signal) {
          normalized.onExit(subprocess, code ?? (signal ? 1 : 0), signal || null, null);
        });
        child.on('error', function(error) {
          normalized.onExit(subprocess, 1, null, error);
        });
      }
      return subprocess;
    };
  }
  if (typeof globalThis.Bun.spawnSync !== 'function') {
    globalThis.Bun.spawnSync = function shellyBunSpawnSync(command, options) {
      const spec = command && typeof command === 'object' && !Array.isArray(command) ? command : null;
      const cmdSpec = spec && spec.cmd !== undefined ? spec.cmd : command;
      const cmd = Array.isArray(cmdSpec) ? cmdSpec[0] : cmdSpec;
      const args = Array.isArray(cmdSpec) ? cmdSpec.slice(1) : [];
      const spawnOptions = Object.assign({}, options || {});
      let stdinPayload = null;
      const isMode = function(v) {
        return v === 'inherit' || v === 'ignore' || v === 'pipe'
          || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
          || (v && typeof v === 'object' && typeof v.fd === 'number');
      };
      if (spec) {
        if (spec.cwd) spawnOptions.cwd = spec.cwd;
        if (spec.env) spawnOptions.env = shellyRepairEnv(spec.env);
        if (spawnOptions.stdio === undefined) {
          const map = function(v, fallback) { return isMode(v) ? v : fallback; };
          stdinPayload = spec.stdin && !isMode(spec.stdin) ? spec.stdin : null;
          spawnOptions.stdio = [stdinPayload ? 'pipe' : map(spec.stdin, 'ignore'), map(spec.stdout, 'pipe'), map(spec.stderr, 'pipe')];
        }
        if (spec.shell !== undefined) spawnOptions.shell = spec.shell;
      }
      if (!spec && spawnOptions.stdio === undefined && spawnOptions.stdin !== undefined && !isMode(spawnOptions.stdin)) {
        stdinPayload = spawnOptions.stdin;
        spawnOptions.stdin = 'pipe';
      }
      if (spawnOptions.stdio === undefined && (
        spawnOptions.stdin !== undefined || spawnOptions.stdout !== undefined || spawnOptions.stderr !== undefined
      )) {
        const isMode = function(v) {
          return v === 'inherit' || v === 'ignore' || v === 'pipe'
            || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
            || (v && typeof v === 'object' && typeof v.fd === 'number');
        };
        const map = function(v, fallback) { return isMode(v) ? v : fallback; };
        spawnOptions.stdio = [map(spawnOptions.stdin, 'ignore'), map(spawnOptions.stdout, 'pipe'), map(spawnOptions.stderr, 'pipe')];
      }
      delete spawnOptions.stdin;
      delete spawnOptions.stdout;
      delete spawnOptions.stderr;
      if (stdinPayload != null && spawnOptions.input === undefined) spawnOptions.input = stdinPayload;
      const normalizedCmd = String(shellyCommandValue(cmd));
      const normalizedArgs = args.map(String);
      const normalizedOptions = normalizeOptions(spawnOptions, false);
      shellyPatchTrace('Bun.spawnSync entry argCount=' + normalizedArgs.length + ' hasShell=' + Boolean(normalizedOptions && normalizedOptions.shell) + ' hasInput=' + (normalizedOptions.input !== undefined));
      shellyDiagLog('Bun.spawnSync', { cmd: shellyDiagCommand(normalizedCmd), argCount: normalizedArgs.length, options: shellyDiagValue(normalizedOptions), hasInput: normalizedOptions.input !== undefined });
      const result = childProcess.spawnSync(normalizedCmd, normalizedArgs, normalizedOptions);
      const exitCode = result.status ?? (result.error ? 1 : 0);
      return {
        success: exitCode === 0,
        exitCode,
        signalCode: result.signal || null,
        stdout: result.stdout || Buffer.alloc(0),
        stderr: result.stderr || Buffer.alloc(0),
        error: result.error,
      };
    };
  }
})();
`;

function log(line) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function info(line) {
  log(line);
  if (process.stdout.isTTY) process.stdout.write(`${line}\n`);
}

function fail(line) {
  log(`ERROR ${line}`);
  throw new Error(line);
}

function pidIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function tryAcquireUpdateLock() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    tool: TOOL,
    channel: CHANNEL,
  });

  try {
    const fd = fs.openSync(LOCK, 'wx', 0o600);
    fs.writeFileSync(fd, `${payload}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  let lockPid = 0;
  try {
    const raw = fs.readFileSync(LOCK, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    lockPid = Number(parsed.pid || 0);
  } catch {
    // Corrupt/partial lockfile. Treat it as stale and race through wx below.
  }

  if (pidIsAlive(lockPid)) {
    log(`[lock] runtime updater already running pid=${lockPid}; skipping`);
    return false;
  }

  try {
    fs.rmSync(LOCK, { force: true });
    const fd = fs.openSync(LOCK, 'wx', 0o600);
    fs.writeFileSync(fd, `${payload}\n`);
    fs.closeSync(fd);
    log(`[lock] removed stale runtime updater lock pid=${lockPid || '(unknown)'}`);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      log('[lock] lost runtime updater lock race after stale cleanup; skipping');
      return false;
    }
    throw err;
  }
}

function releaseUpdateLock() {
  try {
    const raw = fs.readFileSync(LOCK, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    if (Number(parsed.pid || 0) === process.pid) {
      fs.rmSync(LOCK, { force: true });
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') log(`[lock] release failed: ${err.message}`);
  }
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Shelly-runtime-updater/2',
        'Accept': 'application/json',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(request(next, headers));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${url} failed ${res.statusCode}: ${body.toString('utf8').slice(0, 300)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`GET ${url} timed out`)));
  });
}

async function json(url, headers) {
  return JSON.parse((await request(url, headers)).toString('utf8'));
}

function integritySha512(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

// v60: failed-versions tracking. Each line is `<tool>=<version> <epoch>`.
// A failed entry blocks attempts at that exact version until the cooldown
// expires; if upstream re-publishes the version after a regression, the
// cooldown lapse lets the smoke gate retry.
function readFailedVersions() {
  try {
    return fs.readFileSync(FAILED_VERSIONS, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [keyVer, epochStr] = line.split(' ');
        if (!keyVer) return null;
        const eq = keyVer.indexOf('=');
        if (eq < 0) return null;
        const tool = keyVer.slice(0, eq);
        const version = keyVer.slice(eq + 1);
        const epoch = Number(epochStr);
        if (!tool || !version || !Number.isFinite(epoch)) return null;
        return { tool, version, epoch };
      })
      .filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    log(`failed-versions read error: ${e.message}`);
    return [];
  }
}

// Codex review 2026-05-08 (PR #48 spec item 8): failure classification.
// Previously every smoke failure went into .failed-versions cooldown
// uniformly. Codex pushed back: auth_failed != binary_failed,
// network_failed != binary_failed, panic/signal != binary_failed.
//
// Classification:
//   signal     — exit >= 128 (binary genuinely crashed via signal)
//   exit       — non-zero non-signal status (binary returned an error)
//   auth       — --print failure with auth-error patterns in output
//   network    — caller caught a network/IO exception
//   shape      — tarball or SEA shape unexpected (validateClaudeShape)
//   extraction — extractClaudeCliFromSea threw
//   permission — canary failed because Claude refused a tool permission
//   timeout    — canary exceeded its wall-clock budget; diagnostic only
//
// Cooldown semantics: only `signal` and `exit` and `shape` are recorded
// to .failed-versions (the binary itself is bad). `auth` / `network` /
// `timeout` / `extraction` go to .failure-log (diagnostic only) so the user /
// next updater run sees the history but the version isn't blocked from
// promotion when the user fixes their auth or net comes back.
const FAILURE_LOG = path.join(ROOT, '.failure-log');
const CANARY_SUPPRESSIONS = path.join(ROOT, '.canary-suppressions');
const COOLDOWN_CATEGORIES = new Set(['signal', 'exit', 'shape']);
const SUPPRESSIBLE_CANARY_CATEGORIES = new Set(['auth', 'network', 'permission']);
const __PARSED_CANARY_SUPPRESSION = Number(process.env.SHELLY_CANARY_SUPPRESSION_SECONDS || 21600);
const CANARY_SUPPRESSION_S =
  Number.isFinite(__PARSED_CANARY_SUPPRESSION) && __PARSED_CANARY_SUPPRESSION > 0
    ? __PARSED_CANARY_SUPPRESSION
    : 21600;

function classifyFailure({ status, signal, stdout = '', stderr = '', error = null } = {}) {
  // Native runs return status >= 128 for signal-killed processes
  // (128 + signal_number). Node child_process also exposes `signal`
  // directly, which we prefer when present.
  if (error && error.code === 'ETIMEDOUT') return 'network';
  if (status === 124) return 'timeout';
  if (signal) return 'signal';
  if (typeof status === 'number' && status >= 128) return 'signal';
  // Auth-failure patterns observed in Claude Code stderr/stdout when
  // credentials are missing/expired. Conservative — anything that
  // mentions auth/credentials/401/unauthorized in the output is
  // classified as auth so we don't mistakenly cooldown a healthy binary
  // that just lost its login.
  // Codex push-prep review: `\bunauthor\b` doesn't match `unauthorized`
  // because the closing \b sits between `r` and `i`, both word chars.
  // Matched substrings are explicit now; word boundaries only where
  // they're meaningful (numeric status codes).
  const combined = `${stdout}${stderr}`.toLowerCase();
  if (/(unauthori[sz]ed|unauthenticated|authentication|invalid api key|expired token|\b401\b|\b403\b)/.test(combined)) {
    return 'auth';
  }
  if (/(permission denied|permissions required|permission mode|not allowed|tool.*denied|tool.*not.*allowed|approval required|allowedtools|allowed tools|bypasspermissions)/.test(combined)) {
    return 'permission';
  }
  // Default: non-zero non-signal exit means the binary returned an error
  // we can't categorise more specifically. Treat as cooldown-worthy
  // (the binary itself misbehaved on input it should handle).
  return 'exit';
}

function claudeAuthFingerprint() {
  const hash = crypto.createHash('sha256');
  let hasStableAuth = false;
  const credentials = path.join(HOME, '.claude', '.credentials.json');
  try {
    const st = fs.statSync(credentials);
    if (st.isFile()) {
      hasStableAuth = true;
      hash.update(credentials);
      hash.update('\0');
      hash.update(String(st.size));
      hash.update('\0');
      hash.update(String(Math.floor(st.mtimeMs)));
      hash.update('\0');
    }
  } catch (_e) {
    // Optional credentials file.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    const tokenShape = {
      refresh: parsed?.tokens?.refresh_token || '',
      access: parsed?.tokens?.access_token || '',
      account: parsed?.oauthAccount?.accountUuid || '',
    };
    if (tokenShape.refresh || tokenShape.access || tokenShape.account) {
      hasStableAuth = true;
      hash.update(JSON.stringify(tokenShape));
    }
  } catch (_e) {
    // Shelly trust-seed .claude.json is often absent or not auth-bearing.
  }
  for (const name of CLAUDE_ENV_AUTH_NAMES) {
    const value = process.env[name];
    if (!value) continue;
    hasStableAuth = true;
    hash.update(name);
    hash.update('\0');
    hash.update(crypto.createHash('sha256').update(value).digest('hex'));
    hash.update('\0');
  }
  if (!hasStableAuth) return 'no-auth';
  return hash.digest('hex').slice(0, 16);
}

function readCanarySuppressions() {
  try {
    return fs.readFileSync(CANARY_SUPPRESSIONS, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [toolVersion, fingerprint, epochStr, category] = line.split(/\s+/, 4);
        const eq = toolVersion.indexOf('=');
        const epoch = Number(epochStr);
        if (eq < 0 || !fingerprint || !Number.isFinite(epoch)) return null;
        return {
          tool: toolVersion.slice(0, eq),
          version: toolVersion.slice(eq + 1),
          fingerprint,
          epoch,
          category,
        };
      })
      .filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    log(`canary-suppressions read error: ${e.message}`);
    return [];
  }
}

function isClaudeCanarySuppressed(version, nowEpoch = Math.floor(Date.now() / 1000)) {
  const fingerprint = claudeAuthFingerprint();
  const records = readCanarySuppressions()
    .filter((r) => r.tool === 'claude' && r.version === version && r.fingerprint === fingerprint);
  if (records.length === 0) return false;
  const latest = records.reduce((acc, r) => (r.epoch > acc.epoch ? r : acc));
  return (nowEpoch - latest.epoch) < CANARY_SUPPRESSION_S;
}

function filterClaudeCandidatesForCanarySuppression(candidates) {
  if (FORCE || !shouldFunctionalCheckClaude()) return candidates;
  const filtered = candidates.filter((version) => !isClaudeCanarySuppressed(version));
  const skipped = candidates.filter((version) => !filtered.includes(version));
  if (skipped.length > 0) info(`[claude] suppressed canary retry for ${skipped.join(',')}`);
  return filtered;
}

function isSuppressibleCanaryFailure(category) {
  return SUPPRESSIBLE_CANARY_CATEGORIES.has(category);
}

function recordClaudeCanarySuppression(version, category, reason = '') {
  if (!SUPPRESSIBLE_CANARY_CATEGORIES.has(category)) return;
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const epoch = Math.floor(Date.now() / 1000);
    const reasonOneLine = String(reason).replace(/\s+/g, ' ').slice(0, 180);
    fs.appendFileSync(
      CANARY_SUPPRESSIONS,
      `claude=${version} ${claudeAuthFingerprint()} ${epoch} ${category} ${reasonOneLine}\n`,
    );
  } catch (e) {
    log(`canary-suppressions write error: ${e.message}`);
  }
}

function recordFailedVersion(tool, version, category = 'exit', reason = '') {
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const epoch = Math.floor(Date.now() / 1000);
    if (COOLDOWN_CATEGORIES.has(category)) {
      // Backwards-compatible 2-column line for isVersionInCooldown,
      // plus a 3rd column for the category so future tooling can
      // surface why a version was cooldown'd. readFailedVersions only
      // reads the first two columns so adding the 3rd is non-breaking.
      const line = `${tool}=${version} ${epoch} ${category}\n`;
      fs.appendFileSync(FAILED_VERSIONS, line);
    }
    // Always log to .failure-log for diagnostics regardless of category
    // — even auth/network failures are useful for the user to see why
    // the updater couldn't validate a particular version.
    const reasonOneLine = String(reason).replace(/\s+/g, ' ').slice(0, 240);
    const logLine = `${tool}=${version} ${epoch} ${category} ${reasonOneLine}\n`;
    fs.appendFileSync(FAILURE_LOG, logLine);
  } catch (e) {
    log(`failed-versions/log write error: ${e.message}`);
  }
}

function isVersionInCooldown(tool, version, nowEpoch = Math.floor(Date.now() / 1000)) {
  const records = readFailedVersions().filter((r) => r.tool === tool && r.version === version);
  if (records.length === 0) return false;
  const latest = records.reduce((acc, r) => (r.epoch > acc.epoch ? r : acc));
  return (nowEpoch - latest.epoch) < FAILED_COOLDOWN_S;
}

// v76 (2026-05-06): consume runtime-failure records left by the bash
// claude() function when its native musl Bun SEA tier exits with a
// crash signal (134/139/etc.). Each line is `claude=<version> <epoch>
// <exit_code> [tier]` — the optional tier column was added so the
// updater can later route failure feedback per tier. Backward
// compatible with 3-column records written by an earlier APK. Every
// record translates into a recordFailedVersion call so a release that
// passes staging smoke but segfaults during actual interactive use
// stops being re-promoted on the next walk-back.
function consumeRuntimeFailures() {
  const failuresPath = path.join(ROOT, '.runtime-failures');
  let raw;
  try {
    raw = fs.readFileSync(failuresPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    log(`runtime-failures read error: ${e.message}`);
    return;
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let recorded = 0;
  for (const line of lines) {
    const m = line.match(/^claude=(\S+)\s+\d+\s+\d+(?:\s+\S+)?$/);
    if (!m) continue;
    const version = m[1];
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    recordFailedVersion('claude', version);
    recorded += 1;
  }
  try {
    fs.rmSync(failuresPath, { force: true });
  } catch (e) {
    log(`runtime-failures cleanup error: ${e.message}`);
  }
  if (recorded > 0) {
    info(`[claude] consumed ${recorded} runtime failure record(s); versions added to cooldown`);
  }
}

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    dereference: false,
  });
  return true;
}

function parseTar(gzBuffer) {
  const tar = zlib.gunzipSync(gzBuffer);
  const entries = new Map();
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeText ? parseInt(sizeText, 8) : 0;
    const type = String.fromCharCode(header[156] || 48);
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === '0' || type === '\0') entries.set(name, Buffer.from(data));
  }
  return entries;
}

function tarEntry(entries, name) {
  return entries.get(name) || entries.get(`./${name}`) ||
    [...entries.entries()].find(([entryName]) => entryName.endsWith(`/${name}`))?.[1];
}

function promote(tool, version, staging) {
  const toolDir = path.join(ROOT, tool);
  const finalDir = path.join(toolDir, version);
  fs.mkdirSync(toolDir, { recursive: true, mode: 0o700 });
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(staging, finalDir);

  const current = path.join(toolDir, 'current');
  const next = path.join(toolDir, '.current-next');
  fs.rmSync(next, { recursive: true, force: true });
  fs.symlinkSync(version, next, 'dir');
  fs.rmSync(current, { recursive: true, force: true });
  fs.renameSync(next, current);
  fs.writeFileSync(path.join(toolDir, 'version'), `${version}\n`);
  if (tool === 'claude-extracted') {
    fs.rmSync(path.join(toolDir, '.needs-repair'), { force: true });
  }
}

function currentVersion(tool) {
  try { return fs.readFileSync(path.join(ROOT, tool, 'version'), 'utf8').trim(); }
  catch { return ''; }
}

function currentClaudeVersion() {
  return currentVersion('claude-extracted') || (NATIVE_CLAUDE_UPDATE ? currentVersion('claude') : '');
}

function currentClaudeNativeVersion() {
  return currentVersion('claude');
}

function currentClaudeExtractedVersion() {
  return currentVersion('claude-extracted');
}

function currentClaudeExtractedCli() {
  return path.join(
    ROOT,
    'claude-extracted',
    'current',
    'node_modules',
    '@anthropic-ai',
    'claude-code-extracted',
    'cli.js',
  );
}

function claudeExtractedNodeSmokeEnv(extraEnv = {}) {
  const preloadOptions = [
    path.join(HOME, '.shelly-node-compat-preload.js'),
    path.join(HOME, '.shelly-claude-node-preload.js'),
  ]
    .filter((p) => fs.existsSync(p))
    .map((p) => `--require=${p}`)
    .join(' ');
  return {
    HOME,
    PWD: HOME,
    USER: process.env.USER || 'shelly',
    LOGNAME: process.env.LOGNAME || 'shelly',
    SHELLY_LIB_DIR: LIB,
    SHELL: path.join(HOME, 'bin', 'bash'),
    BASH: path.join(HOME, 'bin', 'bash'),
    PATH: `${path.join(HOME, 'bin')}:${LIB}:/system/bin:/vendor/bin`,
    LD_LIBRARY_PATH: LIB,
    USE_BUILTIN_RIPGREP: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_INSTALLATION_CHECKS: '1',
    NO_UPDATE_NOTIFIER: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
    TMPDIR: GENERIC_TMP,
    BUN_TMPDIR: CLAUDE_BUN_TMP,
    CLAUDE_TMPDIR: CLAUDE_TMP,
    CLAUDE_CODE_TMPDIR: CLAUDE_TMP,
    NODE_OPTIONS: preloadOptions,
    LD_PRELOAD: path.join(LIB, 'libexec_wrapper.so'),
    BASH_ENV: '',
    ENV: '',
    ...extraEnv,
  };
}

function runClaudeBashShellSmoke() {
  const homeBash = path.join(HOME, 'bin', 'bash');
  const env = {
    ...process.env,
    HOME,
    PWD: HOME,
    USER: 'shelly',
    LOGNAME: 'shelly',
    SHELLY_LIB_DIR: LIB,
    SHELL: homeBash,
    BASH: homeBash,
    PATH: `${path.join(HOME, 'bin')}:${LIB}:/system/bin:/vendor/bin`,
    LD_LIBRARY_PATH: LIB,
    LD_PRELOAD: path.join(LIB, 'libexec_wrapper.so'),
    ANDROID_ROOT: '/system',
    ANDROID_DATA: '/data',
    TMPDIR: GENERIC_TMP,
    BASH_ENV: '',
    ENV: '',
  };
  return spawnSync('/system/bin/linker64', [
    homeBash,
    '-lc',
    'printf SHELLY_SHELL_CANARY_OK; bash -lc "printf SHELLY_SHELL_CHILD_OK"; pwd >/dev/null',
  ], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function invalidateClaudeExtractedCurrent(reason) {
  const toolDir = path.join(ROOT, 'claude-extracted');
  try {
    fs.mkdirSync(toolDir, { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(toolDir, 'current'), { recursive: true, force: true });
    fs.rmSync(path.join(toolDir, 'version'), { force: true });
    fs.writeFileSync(path.join(toolDir, '.needs-repair'), `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
  } catch (err) {
    info(`[claude] failed to invalidate extracted current after ${reason}: ${err.message}`);
  }
}

function currentClaudeExtractedVerifiedVersion() {
  const marker = currentClaudeExtractedVersion();
  if (!marker) return '';
  const cli = currentClaudeExtractedCli();
  if (!fs.existsSync(cli)) {
    invalidateClaudeExtractedCurrent('missing-cli');
    return '';
  }

  const smoke = runNodeScript(cli, ['--version'], claudeExtractedNodeSmokeEnv());
  const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
  if (/\[DBG-A|\[CKPT-|claude-code_2-1-131_harness/.test(combined)) {
    invalidateClaudeExtractedCurrent('stale-harness-output');
    return '';
  }
  if (smoke.status !== 0 || !combined.includes(marker)) {
    invalidateClaudeExtractedCurrent(`version-mismatch-${marker}`);
    return '';
  }
  return marker;
}

function currentClaudeVerifiedVersion() {
  return currentClaudeExtractedVerifiedVersion() || (NATIVE_CLAUDE_UPDATE ? currentVersion('claude') : '');
}

function currentNpmVersion(pkgName) {
  try {
    const pkgJson = path.join(NPM_ROOT, 'node_modules', ...pkgName.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version || '';
  } catch {
    return '';
  }
}

function runLinker(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.LD_PRELOAD;
  return spawnSync('/system/bin/linker64', args, {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function runNodeScript(script, args = [], extraEnv = {}, timeout = 30000) {
  const env = { ...process.env, ...extraEnv };
  return spawnSync('/system/bin/linker64', [
    path.join(LIB, 'node'),
    script,
    ...args,
  ], {
    env,
    encoding: 'utf8',
    timeout,
  });
}

function runNodeScriptHardTimeout(script, args = [], extraEnv = {}, timeout = 30000) {
  const env = { ...process.env, ...extraEnv };
  const nodeArgs = [
    path.join(LIB, 'node'),
    script,
    ...args,
  ];
  if (fs.existsSync('/system/bin/timeout')) {
    const seconds = String(Math.max(1, Math.ceil(timeout / 1000)));
    return spawnSync('/system/bin/timeout', [
      '-s',
      'KILL',
      seconds,
      '/system/bin/linker64',
      ...nodeArgs,
    ], {
      env,
      encoding: 'utf8',
      timeout: timeout + 5000,
    });
  }
  return runNodeScript(script, args, extraEnv, timeout);
}

function resultSummary(result) {
  if (!result) return 'result=<null>';
  const parts = [`status=${result.status}`];
  if (result.signal) parts.push(`signal=${result.signal}`);
  if (result.error) {
    parts.push(`error=${result.error.code || result.error.name || 'Error'}`);
    if (result.error.message) parts.push(`message=${result.error.message}`);
  }
  return parts.join(' ');
}

function runClaudeNative(binary, args = [], extraEnv = {}) {
  fs.mkdirSync(CLAUDE_BUN_TMP, { recursive: true, mode: 0o700 });
  fs.mkdirSync(CLAUDE_TMP, { recursive: true, mode: 0o700 });
  fs.mkdirSync(GENERIC_TMP, { recursive: true, mode: 0o700 });
  return runLinker([
    path.join(LIB, 'shelly_musl_exec'),
    path.join(LIB, 'ld-musl-aarch64.so.1'),
    binary,
    ...args,
  ], {
    SHELLY_MUSL_LD_PRELOAD: path.join(LIB, 'libexec_wrapper_musl.so'),
    SHELLY_MUSL_DISABLE_POSIX_SPAWN: '1',
    USE_BUILTIN_RIPGREP: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_INSTALLATION_CHECKS: '1',
    TMPDIR: GENERIC_TMP,
    BUN_TMPDIR: CLAUDE_BUN_TMP,
    CLAUDE_TMPDIR: CLAUDE_TMP,
    CLAUDE_CODE_TMPDIR: CLAUDE_TMP,
    ...extraEnv,
  });
}

function replaceAllBytes(buf, from, to) {
  if (from.length !== to.length) {
    throw new Error(`internal patch length mismatch: ${from.length} != ${to.length}`);
  }
  let count = 0;
  let offset = 0;
  while ((offset = buf.indexOf(from, offset)) !== -1) {
    to.copy(buf, offset);
    offset += to.length;
    count++;
  }
  return count;
}

function patchClaudeNativeAddons(buf) {
  if (process.env.SHELLY_PATCH_CLAUDE_NATIVE_ADDONS === '0') return buf;
  const out = Buffer.from(buf);
  const counts = [
    replaceAllBytes(
      out,
      Buffer.from('try{return A28=GFK(),A28}catch{}'),
      Buffer.from('try{return A28=null,A28 }catch{}'),
    ),
    replaceAllBytes(
      out,
      Buffer.from('try{pc8=DFK()}catch{pc8=null}'),
      Buffer.from('try{pc8=null }catch{pc8=null}'),
    ),
  ];
  info(`[claude] native addon loader patch counts: audio=${counts[0]} image=${counts[1]}`);
  return out;
}

function findElfSection(buf, name) {
  if (buf.length < 64
    || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('not an ELF');
  }
  if (buf[4] !== 2) throw new Error('not ELF64');
  if (buf[5] !== 1) throw new Error('not little-endian ELF');

  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);
  if (!shoff || !shentsize || !shnum || shstrndx >= shnum) {
    throw new Error('invalid ELF section table');
  }

  function sectionHeader(idx) {
    const off = shoff + idx * shentsize;
    if (off + 64 > buf.length) throw new Error('ELF section header out of range');
    return {
      nameOff: buf.readUInt32LE(off),
      offset: Number(buf.readBigUInt64LE(off + 0x18)),
      size: Number(buf.readBigUInt64LE(off + 0x20)),
    };
  }

  const shstr = sectionHeader(shstrndx);
  const names = buf.subarray(shstr.offset, shstr.offset + shstr.size);
  function cstr(start) {
    let end = start;
    while (end < names.length && names[end] !== 0) end++;
    return names.subarray(start, end).toString('utf8');
  }

  for (let i = 0; i < shnum; i += 1) {
    const sh = sectionHeader(i);
    if (cstr(sh.nameOff) === name) {
      return buf.subarray(sh.offset, sh.offset + sh.size);
    }
  }
  throw new Error(`ELF section ${name} not found`);
}

function extractClaudeCliFromSea(seaBuf) {
  const bunSection = findElfSection(seaBuf, '.bun');
  const marker = Buffer.from('file:///$bunfs/root/src/entrypoints/cli.js');
  const markerAt = bunSection.indexOf(marker);
  if (markerAt < 0) throw new Error('cli.js marker not found in Claude .bun section');

  const startMarker = Buffer.from('// @bun');
  const startRel = bunSection.indexOf(startMarker, markerAt);
  if (startRel < 0) throw new Error('cli.js bundle start not found after marker');

  // Claude Code 2.1.133+ dropped the 4-byte little-endian size prefix
  // that used to sit immediately before the JS bundle. Keep runtime
  // extraction in sync with CI: scan forward through the text JS payload
  // until Bun's following binary payload starts, then trim to the final
  // Bun CJS wrapper close. This still accepts older size-prefixed bundles
  // because the wrapper boundaries are identical.
  const isTextByte = (b) => (b >= 9 && b <= 13) || (b >= 32 && b <= 126);
  let endRel = startRel;
  while (endRel < bunSection.length && isTextByte(bunSection[endRel])) endRel += 1;

  let src = bunSection.subarray(startRel, endRel).toString('utf8');
  const head = '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';
  const tail = '})\n';
  if (!src.startsWith(head)) {
    throw new Error(`unexpected Claude cli.js CJS wrapper head: ${JSON.stringify(src.slice(0, 120))}`);
  }
  const lastClose = src.lastIndexOf(tail);
  if (lastClose < 0) {
    throw new Error(`Claude cli.js wrapper close not found in text region (length=${src.length})`);
  }
  src = src.slice(0, lastClose + tail.length);
  if (!src.endsWith(tail)) {
    throw new Error(`unexpected Claude cli.js CJS wrapper tail: ${JSON.stringify(src.slice(-60))}`);
  }

  let body = src.slice(head.length, -tail.length);

  const tmpLiteral = '"/tmp/claude","/private/tmp/claude"';
  const tmpReplacement = '(process.env.CLAUDE_TMPDIR||"/tmp/claude"),(process.env.CLAUDE_TMPDIR||"/private/tmp/claude")';
  const tmpMatches = body.split(tmpLiteral).length - 1;
  if (tmpMatches === 1) {
    body = body.replace(tmpLiteral, tmpReplacement);
  } else if (tmpMatches === 0) {
    if (!body.includes('process.env.CLAUDE_TMPDIR||"/tmp/claude"')) {
      throw new Error('Claude tmp allowlist patch target not found');
    }
  } else {
    throw new Error(`Claude tmp allowlist target matched ${tmpMatches} times`);
  }

  const bridgeRe = /`\/tmp\/claude-mcp-browser-bridge-\$\{([A-Za-z_$][\w$]*)\(\)\}`/g;
  const matches = [...body.matchAll(bridgeRe)].map((m) => m[1]);
  const bridgeDoneMarker = 'process.env.CLAUDE_CODE_TMPDIR||process.env.TMPDIR||"/tmp"';
  if (matches.length === 1 && new Set(matches).size === 1) {
    const fn = matches[0];
    body = body.replace(
      bridgeRe,
      '`${process.env.CLAUDE_CODE_TMPDIR||process.env.TMPDIR||"/tmp"}/claude-mcp-browser-bridge-${' + fn + '()}`',
    );
  } else if (matches.length === 0) {
    if (!body.includes('claude-mcp-browser-bridge-') || !body.includes(bridgeDoneMarker)) {
      throw new Error('Claude browser bridge tmpdir patch target not found');
    }
  } else {
    throw new Error(`ambiguous Claude browser bridge matches: ${matches.join(',')}`);
  }

  body = body.replace(/(?<![\w$])await\s+using\s+/g, 'const ');
  body = body.replace(/(?<![\w$])using\s+/g, 'const ');

  return '#!/usr/bin/env node\n/* __SHELLY_CLAUDE_BUN_EXTRACTED__ */\n' + CLAUDE_BUN_NODE_POLYFILL + '\n' + body;
}

/**
 * Shape detection for a candidate claude binary. We reject anything
 * that doesn't look like the expected Bun SEA musl ELF — if Anthropic
 * ever changes packaging (ships a cli.js-style shim, or switches to a
 * different loader), we want to fall back to the bundled golden rather
 * than silently promote an incompatible shape.
 */
function validateClaudeShape(binPath) {
  let fd;
  try {
    fd = fs.openSync(binPath, 'r');
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, 20, 0);
    // ELF magic
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      fail(`[claude] shape check: not an ELF (magic=${header.slice(0, 4).toString('hex')})`);
    }
    // EI_CLASS == ELFCLASS64
    if (header[4] !== 2) fail(`[claude] shape check: not 64-bit ELF (class=${header[4]})`);
    // e_machine == EM_AARCH64 (0xB7)
    if (header[18] !== 0xb7 || header[19] !== 0x00) {
      fail(`[claude] shape check: not aarch64 (machine=${header[18].toString(16)}${header[19].toString(16)})`);
    }
    const size = fs.statSync(binPath).size;
    // Bun SEA is typically ~200-300 MB. Anything under 50 MB is probably
    // a wrapper/stub that wouldn't work under our musl loader.
    if (size < 50 * 1024 * 1024) {
      fail(`[claude] shape check: binary suspiciously small (${size} bytes), expected ≥ 50 MiB SEA`);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Build a ranked candidate list (newest-first) for the requested
 * channel. The caller walks the list, downloads + smoke-tests each
 * candidate, and promotes the FIRST one that passes — this is the
 * "Shelly-verified latest" model: we always run the newest release
 * we can prove works on Android, no arbitrary cooldown.
 *
 * Channels (per 2026-04-25 design discussion):
 *   verified (default) — try the absolute newest first. If smoke
 *                        fails, walk back through prior versions
 *                        until one promotes or the cap is exhausted.
 *                        Strictly better than time-based cooldown:
 *                        we get day-1 access to working releases AND
 *                        avoid broken ones via active checks.
 *   latest             — newest only, no walk-back. Fail loud if it
 *                        doesn't smoke (used by power users / debug).
 *   stable             — only consider versions aged past
 *                        SHELLY_UPDATER_STABLE_DELAY_DAYS, then walk
 *                        back from there. Conservative paranoia path.
 *
 * Returns up to MAX_CANDIDATES versions, newest first.
 */
// Default 6: keep enough rollback depth to walk past a bad upstream
// release cluster while still bounding bandwidth. Override via env var if
// needed.
const MAX_CANDIDATES = Number(process.env.SHELLY_UPDATER_MAX_CANDIDATES || 6);

function shouldFunctionalCheckClaude() {
  return FUNCTIONAL_CHECK;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function claudeCanaryResult(name, result, expectedRe) {
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    const category = classifyFailure(result);
    return {
      ok: false,
      category,
      reason: `${name} ${resultSummary(result)}: ${out.slice(0, 240)}`,
    };
  }
  if (expectedRe && !expectedRe.test(out)) {
    const category = classifyFailure({
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return {
      ok: false,
      category,
      reason: `${name} missing expected output: ${out.slice(0, 240)}`,
    };
  }
  return { ok: true, out };
}

function runClaudeExtractedFunctionalCanaries(cli) {
  const bashNonce = `SHELLY_BASH_${crypto.randomBytes(8).toString('hex')}`;
  const canaryDiag = process.env.SHELLY_UPDATER_CANARY_DIAG === '1';
  const parsedTimeout = Number(process.env.SHELLY_UPDATER_CANARY_TIMEOUT_MS || 60000);
  const canaryTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 5000
    ? parsedTimeout
    : 60000;
  const checks = [
    {
      name: 'print-ok',
      args: ['--print', 'Reply exactly SHELLY_CANARY_OK and nothing else.'],
      expected: /\bSHELLY_CANARY_OK\b/,
    },
  ];
  if (TOOL_CANARY) {
    checks.push({
      name: 'bash-tool',
      args: [
        '--print',
        '--allowedTools',
        'Bash',
        '--tools',
        'Bash',
        '--permission-mode',
        'bypassPermissions',
        'Use the Bash tool to run this exact command: printf "$SHELLY_BASH_CANARY_NONCE". Return only the command output.',
      ],
      env: {
        SHELLY_BASH_CANARY_NONCE: bashNonce,
        ...(canaryDiag ? { SHELLY_CLAUDE_DIAG: '1' } : {}),
      },
      expected: new RegExp(escapeRegExp(bashNonce)),
    });
  }

  const passed = [];
  for (const check of checks) {
    info(`[claude] functional canary ${check.name} start`);
    const result = runNodeScriptHardTimeout(cli, check.args, claudeExtractedNodeSmokeEnv({
      SHELLY_SILENT_CLI_TIER: '1',
      ...(check.env || {}),
    }), canaryTimeoutMs);
    const verdict = claudeCanaryResult(check.name, result, check.expected);
    if (!verdict.ok) return { ...verdict, passed };
    passed.push(check.name);
  }
  return { ok: true, passed };
}

function claudeFunctionalMarker(version = currentClaudeExtractedVersion()) {
  if (!version) return '';
  return path.join(
    ROOT,
    'claude-extracted',
    version,
    'node_modules',
    '@anthropic-ai',
    'claude-code-extracted',
    '.shelly-functional-smoke-ok',
  );
}

function markerHasClaudeFunctionalChecks(markerPath) {
  if (!markerPath || !fs.existsSync(markerPath)) return false;
  try {
    const content = fs.readFileSync(markerPath, 'utf8');
    if (!/\bprint-ok\b/.test(content)) return false;
    if (TOOL_CANARY && !/\bbash-tool\b/.test(content)) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

function claudeNativeFunctionalMarker(version = currentClaudeNativeVersion()) {
  if (!version) return '';
  return path.join(ROOT, 'claude', version, '.shelly-functional-smoke-ok');
}

function currentClaudeFunctionalSmokeOk() {
  const extractedMarker = claudeFunctionalMarker();
  if (markerHasClaudeFunctionalChecks(extractedMarker)) return true;
  if (!NATIVE_CLAUDE_UPDATE) return false;
  const nativeMarker = claudeNativeFunctionalMarker();
  return markerHasClaudeFunctionalChecks(nativeMarker);
}

// Per-process unique staging suffix avoids the race where two
// concurrent updater runs collide on TMP/claude-${version}/ via
// ensureCleanDir(). Codex review 2026-04-25 issue #1.
const RUN_TAG = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function selectClaudeCandidates(pkgMeta, channel) {
  const versions = Object.keys(pkgMeta.versions || {});
  const sorted = versions
    .filter((v) => {
      // Drop pre-releases (1.2.3-beta.4 etc.) — Anthropic doesn't
      // ship pre-release tags via dist-tags.latest, but the metadata
      // can include them. Skip anything with a hyphen suffix.
      return /^\d+\.\d+\.\d+$/.test(v);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse(); // newest first

  // v60: drop versions still inside their failure cooldown so the
  // walk-back doesn't waste a slot re-trying a known-bad version.
  // FORCE skips this filter for `shelly-update-clis --force`.
  const noCooldown = FORCE
    ? sorted
    : sorted.filter((v) => !isVersionInCooldown('claude', v));

  if (channel === 'latest') {
    // Codex review 2026-04-25 issue #2: validate dist-tags.latest is a
    // real semver release that actually exists in pkgMeta.versions
    // before using it. npm has historically allowed `latest` to point
    // at prereleases or malformed strings — accepting blindly would
    // bypass our /^\d+\.\d+\.\d+$/ filter.
    const distLatest = pkgMeta['dist-tags']?.latest;
    if (distLatest
      && /^\d+\.\d+\.\d+$/.test(distLatest)
      && pkgMeta.versions?.[distLatest]
      && (FORCE || !isVersionInCooldown('claude', distLatest))) {
      return [distLatest];
    }
    return noCooldown.slice(0, 1);
  }

  if (channel === 'stable') {
    const cutoff = Date.now() - STABLE_DELAY_MS;
    const aged = noCooldown.filter((v) => {
      const t = Date.parse(pkgMeta.time?.[v] || '');
      return Number.isFinite(t) && t <= cutoff;
    });
    return aged.slice(0, MAX_CANDIDATES);
  }

  // verified (default): all non-cooldown versions, newest first
  return noCooldown.slice(0, MAX_CANDIDATES);
}

function selectCodexCandidates(releases, channel) {
  const usable = releases.filter((r) => !r.prerelease && !r.draft);
  // GitHub /releases is newest-first already.

  // v60: same cooldown filter for codex.
  const noCooldown = FORCE
    ? usable
    : usable.filter((r) => !isVersionInCooldown('codex', r.tag_name));

  if (channel === 'latest') {
    return noCooldown.slice(0, 1).map((r) => r.tag_name);
  }

  if (channel === 'stable') {
    const cutoff = Date.now() - STABLE_DELAY_MS;
    const aged = noCooldown.filter((r) => {
      const t = Date.parse(r.published_at || '');
      return Number.isFinite(t) && t <= cutoff;
    });
    return aged.slice(0, MAX_CANDIDATES).map((r) => r.tag_name);
  }

  // verified (default)
  return noCooldown.slice(0, MAX_CANDIDATES).map((r) => r.tag_name);
}

/**
 * Try to download + smoke-test a single Claude version. Returns
 * { ok: true, staging } on success, { ok: false, reason } otherwise.
 * NEVER throws — caller decides whether to walk to the next candidate.
 */
async function tryClaudeVersion(pkgMeta, version) {
  try {
    const meta = pkgMeta.versions?.[version];
    if (!meta?.dist?.tarball || !meta?.dist?.integrity) {
      return { ok: false, reason: 'metadata missing dist fields' };
    }
    info(`[claude] try ${version} — downloading`);
    const tgz = await request(meta.dist.tarball);
    const actualIntegrity = integritySha512(tgz);
    if (actualIntegrity !== meta.dist.integrity) {
      return { ok: false, reason: `integrity mismatch ${actualIntegrity} != ${meta.dist.integrity}` };
    }
    const entries = parseTar(tgz);
    const bin = tarEntry(entries, 'package/claude') || tarEntry(entries, 'claude');
    if (!bin) return { ok: false, reason: 'package/claude missing from tarball' };
    const patchedBin = patchClaudeNativeAddons(bin);

    let nativeStaging = null;
    if (NATIVE_CLAUDE_UPDATE) {
      nativeStaging = path.join(TMP, `claude-${version}-${RUN_TAG}`);
      ensureCleanDir(nativeStaging);
      const nativeOut = path.join(nativeStaging, 'claude');
      fs.writeFileSync(nativeOut, patchedBin, { mode: 0o755 });
      fs.chmodSync(nativeOut, 0o755);

      const __PARSED_SMOKE_RUNS = Number(process.env.SHELLY_NATIVE_VERSION_SMOKE_RUNS || 3);
      const NATIVE_VERSION_SMOKE_RUNS =
        Number.isInteger(__PARSED_SMOKE_RUNS) && __PARSED_SMOKE_RUNS > 0
          ? __PARSED_SMOKE_RUNS
          : 3;
      let nativeSmoke;
      let nativeCombined = '';
      for (let i = 1; i <= NATIVE_VERSION_SMOKE_RUNS; i += 1) {
        nativeSmoke = runClaudeNative(nativeOut, ['--version']);
        nativeCombined = `${nativeSmoke.stdout || ''}${nativeSmoke.stderr || ''}`;
        if (nativeSmoke.status !== 0 || !nativeCombined.includes(version)) {
          const category = classifyFailure(nativeSmoke);
          const reason = `native --version run ${i}/${NATIVE_VERSION_SMOKE_RUNS} status=${nativeSmoke.status} signal=${nativeSmoke.signal || ''} cat=${category}: ${nativeCombined.slice(0, 200)}`;
          fs.rmSync(nativeStaging, { recursive: true, force: true });
          recordFailedVersion('claude', version, category, reason);
          return { ok: false, reason };
        }
      }
      info(`[claude] try ${version} — native --version smoke OK (${NATIVE_VERSION_SMOKE_RUNS}x)`);
    } else {
      info(`[claude] try ${version} — native smoke skipped (set SHELLY_UPDATER_NATIVE_CLAUDE=1 to opt in)`);
    }

    let staging = null;
    let suppressibleCanaryFailure = null;
    try {
      // Per-run staging name avoids cross-process clobbering when two
      // updaters race on the same version (Codex review issue #1).
      staging = path.join(TMP, `claude-extracted-${version}-${RUN_TAG}`);
      ensureCleanDir(staging);
      const pkgDir = path.join(staging, 'node_modules', '@anthropic-ai', 'claude-code-extracted');
      fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
      const out = path.join(pkgDir, 'cli.js');
      const pkgJson = path.join(pkgDir, 'package.json');
      const extracted = extractClaudeCliFromSea(patchedBin);
      fs.writeFileSync(out, extracted, { mode: 0o755 });
      fs.chmodSync(out, 0o755);
      fs.writeFileSync(pkgJson, JSON.stringify({
        name: '@anthropic-ai/claude-code-extracted',
        version,
        private: true,
        shelly: {
          source: '@anthropic-ai/claude-code-linux-arm64-musl',
          extractedAt: new Date().toISOString(),
        },
      }, null, 2));
      const depsDest = path.join(pkgDir, 'node_modules');
      const runtimeDeps = path.join(ROOT, 'claude-extracted', 'current', 'node_modules', '@anthropic-ai', 'claude-code-extracted', 'node_modules');
      const apkDeps = path.join(LIB, 'node_modules', '@anthropic-ai', 'claude-code-extracted', 'node_modules');
      if (copyDir(runtimeDeps, depsDest)) {
        info(`[claude] try ${version} — copied dependencies from runtime current`);
      } else if (copyDir(apkDeps, depsDest)) {
        info(`[claude] try ${version} — copied dependencies from APK extracted package`);
      } else {
        throw new Error('extracted package dependencies missing');
      }

      const smoke = runNodeScript(out, ['--version'], claudeExtractedNodeSmokeEnv());
      const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
      if (smoke.status !== 0 || !combined.includes(version)) {
        throw new Error(`extracted --version ${resultSummary(smoke)}: ${combined.slice(0, 200)}`);
      }
      info(`[claude] try ${version} — extracted --version smoke OK`);

      const shellSmoke = runClaudeBashShellSmoke();
      const shellCombined = `${shellSmoke.stdout || ''}${shellSmoke.stderr || ''}`;
      if (shellSmoke.status !== 0 ||
          !shellCombined.includes('SHELLY_SHELL_CANARY_OK') ||
          !shellCombined.includes('SHELLY_SHELL_CHILD_OK')) {
        const category = classifyFailure(shellSmoke);
        recordFailedVersion('claude', version, category, `claude bash shell smoke failed: ${resultSummary(shellSmoke)} ${shellCombined.slice(0, 200)}`);
        throw new Error(`claude bash shell smoke ${resultSummary(shellSmoke)}: ${shellCombined.slice(0, 200)}`);
      }
      info(`[claude] try ${version} — claude bash shell smoke OK`);

      if (shouldFunctionalCheckClaude()) {
        const canary = runClaudeExtractedFunctionalCanaries(out);
        if (!canary.ok) {
          recordClaudeCanarySuppression(version, canary.category, canary.reason);
          recordFailedVersion('claude', version, canary.category, canary.reason);
          if (isSuppressibleCanaryFailure(canary.category)) {
            suppressibleCanaryFailure = {
              category: canary.category,
              reason: canary.reason,
            };
          }
          throw new Error(`extracted functional canary failed: ${canary.reason}`);
        }
        info(`[claude] try ${version} — extracted functional canary OK (${canary.passed.join(',')})`);
        fs.writeFileSync(
          path.join(pkgDir, '.shelly-functional-smoke-ok'),
          `${new Date().toISOString()} ${canary.passed.join(',')}\n`,
          { mode: 0o600 },
        );
      }
    } catch (e) {
      if (nativeStaging) fs.rmSync(nativeStaging, { recursive: true, force: true });
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      staging = null;
      info(`[claude] try ${version} — extracted fallback unavailable: ${e.message}`);
    }

    if (!staging) {
      return {
        ok: false,
        category: suppressibleCanaryFailure?.category,
        reason: suppressibleCanaryFailure?.reason || 'extracted cli.js fallback unavailable',
      };
    }
    return { ok: true, nativeStaging, staging };
  } catch (err) {
    // Network / I/O exception — don't poison the failed-versions list. The
    // version itself wasn't proven bad. The cooldown is for "we proved this
    // version doesn't run on the device", not "we lost the connection".
    return { ok: false, reason: `exception ${err.message}` };
  }
}

async function updateClaude() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');

  // v76: pull runtime failures into the cooldown list before deciding
  // which candidate to try, so a release that segfaulted during real
  // interactive use stops being re-promoted on this walk-back.
  consumeRuntimeFailures();

  const pkgMeta = await json('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64-musl');

  const rawCandidates = selectClaudeCandidates(pkgMeta, CHANNEL);
  const latestCandidate = rawCandidates[0] || '';
  const currentExtracted = currentClaudeExtractedVerifiedVersion();
  if (!FORCE && shouldFunctionalCheckClaude() && currentExtracted && !currentClaudeFunctionalSmokeOk() && isClaudeCanarySuppressed(currentExtracted)) {
    info(`[claude] current ${currentExtracted} has suppressed canary retry; keeping current`);
    return;
  }
  if (!FORCE && latestCandidate && currentExtracted === latestCandidate && isClaudeCanarySuppressed(latestCandidate)) {
    info(`[claude] current latest ${latestCandidate} has suppressed canary retry; keeping current`);
    return;
  }
  const candidates = filterClaudeCandidatesForCanarySuppression(rawCandidates);
  if (candidates.length === 0) {
    info(`[claude] no candidates (channel=${CHANNEL})`);
    return;
  }
  info(`[claude] channel=${CHANNEL} candidates=${candidates.join(',')}`);

  const needsFunctionalSmoke = shouldFunctionalCheckClaude();

  // Fast-path: if our current promoted version matches the FIRST
  // candidate (the absolute newest), we're already on the verified
  // latest. Don't re-download unless this authenticated device has never
  // proven that current release can complete `--print`.
  if (!FORCE && currentExtracted === candidates[0]) {
    if (needsFunctionalSmoke && !currentClaudeFunctionalSmokeOk()) {
      info(`[claude] current ${candidates[0]} lacks functional smoke marker; re-testing`);
    } else {
      info(`[claude] already on verified latest ${candidates[0]}`);
      return;
    }
  }

  // Walk candidates newest-first. First one that passes smoke wins.
  for (const version of candidates) {
    if (!FORCE && currentClaudeExtractedVerifiedVersion() === version) {
      if (needsFunctionalSmoke && !currentClaudeFunctionalSmokeOk()) {
        info(`[claude] current ${version} lacks functional smoke marker; re-testing before keeping`);
      } else {
        info(`[claude] keeping current ${version} (newer candidates already failed smoke)`);
        return;
      }
    }
    const result = await tryClaudeVersion(pkgMeta, version);
    if (result.ok) {
      if (result.nativeStaging) promote('claude', version, result.nativeStaging);
      if (result.staging) promote('claude-extracted', version, result.staging);
      info(`[claude] promoted ${version} (verified, channel=${CHANNEL}, native=${!!result.nativeStaging}, extracted=${!!result.staging})`);
      return;
    }
    info(`[claude] reject ${version}: ${result.reason}`);
    if (isSuppressibleCanaryFailure(result.category)) {
      info(`[claude] stopping candidate walk after ${result.category} canary failure`);
      return;
    }
  }

  // All candidates failed — keep current promotion as-is. The bundled
  // golden APK version is the ultimate fallback in claude() bash
  // function, so the user always has a working Claude.
  info(`[claude] all ${candidates.length} candidates failed smoke; keeping current=${currentClaudeVerifiedVersion() || currentClaudeVersion() || '(none)'}`);
}

async function tryCodexTag(releases, tag) {
  try {
    const rel = releases.find((r) => r.tag_name === tag);
    if (!rel) return { ok: false, reason: 'release disappeared' };
    const packageVersion = tag.replace(/^v/, '');
    const assetName = `codex-termux-android-arm64-${tag}.tar.gz`;
    const sumName = `${assetName}.sha256`;
    const asset = (rel.assets || []).find((a) => a.name === assetName);
    const sumAsset = (rel.assets || []).find((a) => a.name === sumName);
    const npmAssetName = `mmmbuto-codex-cli-termux-${packageVersion}.tgz`;
    const npmAsset = (rel.assets || []).find((a) => a.name === npmAssetName);

    let tgz;
    if (asset?.browser_download_url && sumAsset?.browser_download_url) {
      info(`[codex] try ${tag} — downloading legacy tarball`);
      const [legacyTgz, sumBuf] = await Promise.all([
        request(asset.browser_download_url),
        request(sumAsset.browser_download_url),
      ]);
      const expected = sumBuf.toString('utf8').trim().split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(legacyTgz).digest('hex');
      if (actual !== expected) return { ok: false, reason: `sha256 mismatch ${actual} != ${expected}` };
      tgz = legacyTgz;
    } else if (npmAsset?.browser_download_url) {
      // v0.125.0-termux switched to npm-pack format:
      // mmmbuto-codex-cli-termux-<version>.tgz. Verify against the npm
      // registry integrity field instead of trusting the GitHub asset alone.
      info(`[codex] try ${tag} — downloading npm-pack tarball`);
      const pkgMeta = await json('https://registry.npmjs.org/@mmmbuto%2fcodex-cli-termux');
      const dist = pkgMeta.versions?.[packageVersion]?.dist;
      if (!dist?.tarball || !dist?.integrity) {
        return { ok: false, reason: `npm metadata missing for @mmmbuto/codex-cli-termux@${packageVersion}` };
      }
      tgz = await request(dist.tarball);
      const actualIntegrity = integritySha512(tgz);
      if (actualIntegrity !== dist.integrity) {
        return { ok: false, reason: `integrity mismatch ${actualIntegrity} != ${dist.integrity}` };
      }
    } else {
      return { ok: false, reason: 'release assets missing' };
    }

    const entries = parseTar(tgz);
    const execBin = tarEntry(entries, 'codex-exec.bin');
    const tuiBin = tarEntry(entries, 'codex.bin');
    if (!execBin || !tuiBin) return { ok: false, reason: 'codex-exec.bin or codex.bin missing' };
    const libcxx = tarEntry(entries, 'libc++_shared.so');

    const staging = path.join(TMP, `codex-${tag}-${RUN_TAG}`);
    ensureCleanDir(staging);
    const execOut = path.join(staging, 'codex_exec');
    const tuiOut = path.join(staging, 'codex_tui');
    fs.writeFileSync(execOut, execBin, { mode: 0o755 });
    fs.writeFileSync(tuiOut, tuiBin, { mode: 0o755 });
    fs.chmodSync(execOut, 0o755);
    fs.chmodSync(tuiOut, 0o755);
    if (libcxx) {
      const libcxxOut = path.join(staging, 'libc++_shared.so');
      fs.writeFileSync(libcxxOut, libcxx, { mode: 0o755 });
      fs.chmodSync(libcxxOut, 0o755);
    }

    const smoke = runLinker([execOut, '--version']);
    const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
    const plainVersion = packageVersion.replace(/-termux$/, '');
    if (smoke.status !== 0 || !combined.includes(plainVersion)) {
      fs.rmSync(staging, { recursive: true, force: true });
      recordFailedVersion('codex', tag);
      return { ok: false, reason: `--version status=${smoke.status}: ${combined.slice(0, 200)}` };
    }
    info(`[codex] try ${tag} — --version smoke OK`);
    // codex has no --print equivalent that's safe without auth, so we
    // stop here even when FUNCTIONAL_CHECK=1.
    return { ok: true, staging };
  } catch (err) {
    // Network / I/O — do not poison failed-versions; see tryClaudeVersion.
    return { ok: false, reason: `exception ${err.message}` };
  }
}

async function updateCodex() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  // Pull a window of recent releases so verified-channel walk-back
  // has somewhere to walk to. /releases returns newest-first.
  const releases = await json('https://api.github.com/repos/DioNanos/codex-termux/releases?per_page=20', {
    'Accept': 'application/vnd.github+json',
  });

  const candidates = selectCodexCandidates(releases, CHANNEL);
  if (candidates.length === 0) {
    info(`[codex] no candidates (channel=${CHANNEL})`);
    return;
  }
  info(`[codex] channel=${CHANNEL} candidates=${candidates.join(',')}`);

  if (!FORCE && currentVersion('codex') === candidates[0]) {
    info(`[codex] already on verified latest ${candidates[0]}`);
    return;
  }

  for (const tag of candidates) {
    if (!FORCE && currentVersion('codex') === tag) {
      info(`[codex] keeping current ${tag} (newer candidates already failed smoke)`);
      return;
    }
    const result = await tryCodexTag(releases, tag);
    if (result.ok) {
      promote('codex', tag, result.staging);
      info(`[codex] promoted ${tag} (verified, channel=${CHANNEL})`);
      return;
    }
    info(`[codex] reject ${tag}: ${result.reason}`);
  }

  info(`[codex] all ${candidates.length} candidates failed smoke; keeping current=${currentVersion('codex') || '(none)'}`);
}

// Codex review 2026-05-08 (PR #48): age-aware GC for staging directories.
// Earlier impl was unconditional — every updater run nuked every claude-*
// / codex-* entry in TMP, including in-flight stages from a concurrent
// updater process. RUN_TAG (per-process pid+rand suffix) gives unique
// paths but doesn't help if a sibling process arrives at startup and
// finds another's WIP stage. The mtime check below preserves anything
// touched in the last 24h, so two updater instances don't trample each
// other while still recovering disk from genuinely abandoned crashes.
//
// Codex push-prep review (item F): validate the env override so a
// malformed SHELLY_STAGING_GC_AGE_S doesn't either disable GC (NaN/0)
// or set an absurdly small cutoff that nukes in-flight stages. Floor
// at 3600s (1h) — anything shorter risks racing concurrent updaters.
const __PARSED_GC_AGE = Number(process.env.SHELLY_STAGING_GC_AGE_S || 86400);
const STAGING_GC_AGE_S =
  Number.isFinite(__PARSED_GC_AGE) && __PARSED_GC_AGE >= 3600
    ? __PARSED_GC_AGE
    : 86400;

function cleanupStaleStaging() {
  try {
    if (!fs.existsSync(TMP)) return;
    const cutoffMs = Date.now() - (STAGING_GC_AGE_S * 1000);
    let removed = 0;
    let preserved = 0;
    for (const entry of fs.readdirSync(TMP)) {
      if (!(entry.startsWith('claude-') || entry.startsWith('claude-extracted-') || entry.startsWith('codex-'))) {
        continue;
      }
      const full = path.join(TMP, entry);
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (e) {
        // Stat failed (race with another rm? broken symlink?). Try to
        // remove it; if rm also fails, log and move on.
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed += 1;
        } catch (re) {
          log(`cleanupStaleStaging: stat+rm both failed for ${entry}: ${re.message}`);
        }
        continue;
      }
      if (mtimeMs < cutoffMs) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed += 1;
        } catch (re) {
          log(`cleanupStaleStaging: rm failed for ${entry}: ${re.message}`);
        }
      } else {
        preserved += 1;
      }
    }
    if (removed > 0 || preserved > 0) {
      info(`[gc] staging cleanup: removed=${removed} preserved=${preserved} (age cutoff ${STAGING_GC_AGE_S}s)`);
    }
  } catch (err) {
    log(`cleanupStaleStaging: ${err.message}`);
  }
}

/**
 * v60 (2026-04-26): --check-only mode. Cheap version check that fetches
 * upstream metadata (~10KB per package) and compares with the currently
 * promoted version, honouring the failed-versions cooldown. Does NOT
 * download any binary or run any smoke test. Returns:
 *   exit 0 — at least one upgrade is available (full updater should run)
 *   exit 1 — everything up-to-date or all upgrades blocked by cooldown
 *   exit >1 — fetch / parsing error (caller should treat as "no info")
 *
 * Used by the per-launch quick check in .bashrc to decide whether to
 * fire __shelly_bg_runtime_update.
 */
async function checkClaudeAvailable() {
  try {
    const pkgMeta = await json('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64-musl');
    const rawCandidates = selectClaudeCandidates(pkgMeta, CHANNEL);
    if (rawCandidates.length === 0) return false;
    const latestCandidate = rawCandidates[0];
    const currentExtracted = currentClaudeExtractedVerifiedVersion();
    if (shouldFunctionalCheckClaude() && currentExtracted && !currentClaudeFunctionalSmokeOk() && isClaudeCanarySuppressed(currentExtracted)) {
      info(`[check] claude current ${currentExtracted} canary retry suppressed`);
      return false;
    }
    if (currentExtracted === latestCandidate && isClaudeCanarySuppressed(latestCandidate)) {
      info(`[check] claude ${latestCandidate} canary retry suppressed`);
      return false;
    }
    const candidates = filterClaudeCandidatesForCanarySuppression(rawCandidates);
    if (candidates.length === 0) return false;
    if (shouldFunctionalCheckClaude()
      && currentClaudeExtractedVerifiedVersion() === candidates[0]
      && !currentClaudeFunctionalSmokeOk()
      && !isClaudeCanarySuppressed(candidates[0])) {
      info(`[check] claude ${candidates[0]} lacks functional canary marker`);
      return true;
    }
    return currentClaudeExtractedVerifiedVersion() !== candidates[0];
  } catch (err) {
    info(`[check] claude metadata fetch failed: ${err.message}`);
    return false;
  }
}

async function checkCodexAvailable() {
  try {
    const releases = await json('https://api.github.com/repos/DioNanos/codex-termux/releases?per_page=20', {
      'Accept': 'application/vnd.github+json',
    });
    const candidates = selectCodexCandidates(releases, CHANNEL);
    if (candidates.length === 0) return false;
    return currentVersion('codex') !== candidates[0];
  } catch (err) {
    info(`[check] codex release fetch failed: ${err.message}`);
    return false;
  }
}

async function checkNpmPackageAvailable(tool, pkgName) {
  try {
    const meta = await json(`https://registry.npmjs.org/${pkgName.replace('/', '%2f')}`);
    const latest = meta['dist-tags']?.latest;
    if (!latest || isVersionInCooldown(tool, latest)) return false;
    return currentNpmVersion(pkgName) !== latest;
  } catch (err) {
    info(`[check] ${tool} npm metadata fetch failed: ${err.message}`);
    return false;
  }
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  log(`start tool=${TOOL} channel=${CHANNEL} force=${FORCE} functional=${FUNCTIONAL_CHECK} checkOnly=${CHECK_ONLY} stableDelay=${STABLE_DELAY_DAYS}d`);

  if (CHECK_ONLY) {
    let anyAvailable = false;
    if (TOOL === 'claude' || TOOL === 'all') {
      const claudeAvailable = await checkClaudeAvailable();
      log(`[check] claude upgrade available=${claudeAvailable}`);
      if (claudeAvailable) anyAvailable = true;
    }
    if (TOOL === 'codex' || TOOL === 'all') {
      const codexAvailable = await checkCodexAvailable();
      log(`[check] codex upgrade available=${codexAvailable}`);
      if (codexAvailable) anyAvailable = true;
    }
    if (TOOL === 'gemini') {
      const geminiAvailable = await checkNpmPackageAvailable('gemini', '@google/gemini-cli');
      log(`[check] gemini npm upgrade available=${geminiAvailable}`);
      if (geminiAvailable) anyAvailable = true;
    }
    log(`[check] anyAvailable=${anyAvailable}`);
    process.exit(anyAvailable ? 0 : 1);
  }

  if (!tryAcquireUpdateLock()) {
    log('done (skipped, locked)');
    return;
  }

  try {
    cleanupStaleStaging();
    if (TOOL === 'claude' || TOOL === 'all') await updateClaude();
    if (TOOL === 'codex' || TOOL === 'all') await updateCodex();
    log('done');
  } finally {
    releaseUpdateLock();
  }
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(2);
});
