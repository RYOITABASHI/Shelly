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
 *     Adds a `node cli.js --print "reply OK"` smoke check for Claude
 *     beyond `--version`. Exercises DNS, TLS, auth, and actual inference.
 *     Gated behind an env var because it requires valid upstream credentials
 *     on this device; default install would fail it even on a healthy release.
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
const FAILED_VERSIONS = path.join(ROOT, '.failed-versions');
const NPM_ROOT = path.join(HOME, '.shelly-cli');
const LIB = process.env.SHELLY_LIB_DIR;
const FORCE = process.argv.includes('--force');
// v60 (2026-04-26): --check-only returns exit 0 when an upgrade is available
// without smoke-fail cooldown blocking it, exit 1 when nothing to do.
// Used by the per-launch quick check in .bashrc to decide whether to fire
// the full updater. No network downloads happen in this mode beyond the
// metadata fetch (~10KB per package).
const CHECK_ONLY = process.argv.includes('--check-only');
const FAILED_COOLDOWN_S = Number(process.env.SHELLY_FAILED_VERSION_COOLDOWN || 3600);
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
const FUNCTIONAL_CHECK = process.env.SHELLY_UPDATER_FUNCTIONAL_CHECK === '1';

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

function recordFailedVersion(tool, version) {
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const line = `${tool}=${version} ${Math.floor(Date.now() / 1000)}\n`;
    fs.appendFileSync(FAILED_VERSIONS, line);
  } catch (e) {
    log(`failed-versions write error: ${e.message}`);
  }
}

function isVersionInCooldown(tool, version, nowEpoch = Math.floor(Date.now() / 1000)) {
  const records = readFailedVersions().filter((r) => r.tool === tool && r.version === version);
  if (records.length === 0) return false;
  const latest = records.reduce((acc, r) => (r.epoch > acc.epoch ? r : acc));
  return (nowEpoch - latest.epoch) < FAILED_COOLDOWN_S;
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
}

function currentVersion(tool) {
  try { return fs.readFileSync(path.join(ROOT, tool, 'version'), 'utf8').trim(); }
  catch { return ''; }
}

function currentClaudeVersion() {
  return currentVersion('claude-extracted');
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

function runNodeScript(script, args = [], extraEnv = {}) {
  return runLinker([
    path.join(LIB, 'node'),
    script,
    ...args,
  ], extraEnv);
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
  if (startRel < 4) throw new Error('cli.js size prefix missing');

  const size = bunSection.readUInt32LE(startRel - 4);
  const src = bunSection.subarray(startRel, startRel + size).toString('utf8');
  const head = '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';
  const tail = '})\n';
  if (!src.startsWith(head) || !src.endsWith(tail)) {
    throw new Error('unexpected Claude cli.js CJS wrapper shape');
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

  return '#!/usr/bin/env node\n/* __SHELLY_CLAUDE_BUN_EXTRACTED__ */\n' + body;
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
// Default 3 per Codex review 2026-04-25 — bandwidth cost of failed
// candidates (~250 MB each for Claude SEA) outweighs the marginal
// benefit of walking back further. Override via env var if you've
// hit a regression spanning more than 2 releases.
const MAX_CANDIDATES = Number(process.env.SHELLY_UPDATER_MAX_CANDIDATES || 3);

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

    // Per-run staging name avoids cross-process clobbering when two
    // updaters race on the same version (Codex review issue #1).
    const staging = path.join(TMP, `claude-extracted-${version}-${RUN_TAG}`);
    ensureCleanDir(staging);
    const pkgDir = path.join(staging, 'node_modules', '@anthropic-ai', 'claude-code-extracted');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const out = path.join(pkgDir, 'cli.js');
    const pkgJson = path.join(pkgDir, 'package.json');
    let extracted;
    try {
      extracted = extractClaudeCliFromSea(bin);
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      recordFailedVersion('claude', version);
      return { ok: false, reason: `extract cli.js: ${e.message}` };
    }
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
      fs.rmSync(staging, { recursive: true, force: true });
      recordFailedVersion('claude', version);
      return { ok: false, reason: 'extracted package dependencies missing' };
    }

    // Smoke 1: --version (no network/auth), using the same Node route
    // that HomeInitializer's claude() wrapper prefers.
    const smoke = runNodeScript(out, ['--version'], {
      USE_BUILTIN_RIPGREP: '0',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      TMPDIR: path.join(HOME, '.tmp'),
      CLAUDE_TMPDIR: path.join(HOME, '.claude-tmp'),
      CLAUDE_CODE_TMPDIR: path.join(HOME, '.claude-tmp'),
    });
    const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
    if (smoke.status !== 0 || !combined.includes(version)) {
      fs.rmSync(staging, { recursive: true, force: true });
      recordFailedVersion('claude', version);
      return { ok: false, reason: `--version smoke status=${smoke.status}: ${combined.slice(0, 200)}` };
    }
    info(`[claude] try ${version} — --version smoke OK`);

    // Smoke 2 (opt-in): --print "Reply exactly OK".
    if (FUNCTIONAL_CHECK) {
      const func = runNodeScript(out, ['--print', 'Reply exactly OK'], {
        SHELLY_UPDATER_FUNCTIONAL_CHECK: '',
        USE_BUILTIN_RIPGREP: '0',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_INSTALLATION_CHECKS: '1',
        TMPDIR: path.join(HOME, '.tmp'),
        CLAUDE_TMPDIR: path.join(HOME, '.claude-tmp'),
        CLAUDE_CODE_TMPDIR: path.join(HOME, '.claude-tmp'),
      });
      const funcOut = `${func.stdout || ''}${func.stderr || ''}`;
      if (func.status !== 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        recordFailedVersion('claude', version);
        return { ok: false, reason: `--print status=${func.status}: ${funcOut.slice(0, 200)}` };
      }
      if (!/\bOK\b/i.test(func.stdout || '')) {
        fs.rmSync(staging, { recursive: true, force: true });
        recordFailedVersion('claude', version);
        return { ok: false, reason: `--print did not return OK: ${funcOut.slice(0, 200)}` };
      }
      info(`[claude] try ${version} — functional check OK`);
    }

    return { ok: true, staging };
  } catch (err) {
    // Network / I/O exception — don't poison the failed-versions list. The
    // version itself wasn't proven bad. The cooldown is for "we proved this
    // version doesn't run on the device", not "we lost the connection".
    return { ok: false, reason: `exception ${err.message}` };
  }
}

async function updateClaude() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  const pkgMeta = await json('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64-musl');

  const candidates = selectClaudeCandidates(pkgMeta, CHANNEL);
  if (candidates.length === 0) {
    info(`[claude] no candidates (channel=${CHANNEL})`);
    return;
  }
  info(`[claude] channel=${CHANNEL} candidates=${candidates.join(',')}`);

  // Fast-path: if our current promoted version matches the FIRST
  // candidate (the absolute newest), we're already on the verified
  // latest. Don't re-download.
  if (!FORCE && currentClaudeVersion() === candidates[0]) {
    info(`[claude] already on verified latest ${candidates[0]}`);
    return;
  }

  // Walk candidates newest-first. First one that passes smoke wins.
  for (const version of candidates) {
    if (!FORCE && currentClaudeVersion() === version) {
      info(`[claude] keeping current ${version} (newer candidates already failed smoke)`);
      return;
    }
    const result = await tryClaudeVersion(pkgMeta, version);
    if (result.ok) {
      promote('claude-extracted', version, result.staging);
      info(`[claude] promoted ${version} (verified, channel=${CHANNEL})`);
      return;
    }
    info(`[claude] reject ${version}: ${result.reason}`);
  }

  // All candidates failed — keep current promotion as-is. The bundled
  // golden APK version is the ultimate fallback in claude() bash
  // function, so the user always has a working Claude.
  info(`[claude] all ${candidates.length} candidates failed smoke; keeping current=${currentClaudeVersion() || '(none)'}`);
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

function cleanupStaleStaging() {
  // Purge any leftover staging directories from crashed previous runs.
  // Codex audit 2026-04-25: race window between writeFileSync and
  // promote leaks ~/.shelly-runtime/.tmp/claude-X or codex-Y if the
  // process dies mid-run. Clean at startup so disk doesn't accrue.
  try {
    if (!fs.existsSync(TMP)) return;
    for (const entry of fs.readdirSync(TMP)) {
      if (entry.startsWith('claude-') || entry.startsWith('claude-extracted-') || entry.startsWith('codex-')) {
        fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
      }
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
    const candidates = selectClaudeCandidates(pkgMeta, CHANNEL);
    if (candidates.length === 0) return false;
    return currentClaudeVersion() !== candidates[0];
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

  cleanupStaleStaging();
  if (TOOL === 'claude' || TOOL === 'all') await updateClaude();
  if (TOOL === 'codex' || TOOL === 'all') await updateCodex();
  log('done');
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(2);
});
