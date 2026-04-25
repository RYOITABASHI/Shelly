#!/usr/bin/env node
/**
 * Shelly-managed runtime updater for native AI CLIs.
 *
 * Updates are staged under ~/.shelly-runtime, smoke-tested, then promoted by
 * switching a `current` symlink. Broken upstream releases never replace the
 * last working version.
 *
 * Usage:
 *   shelly-runtime-update.js [claude|codex|all] [--force] [--channel stable|latest]
 *
 * Channels (per Codex review 2026-04-25):
 *   stable  (default) — only promote a release that's been public ≥ 7 days
 *                       (skips regressions that get pulled within the first
 *                       days of a release).
 *   latest            — promote the npm `latest` tag / GitHub latest release
 *                       immediately after smoke-test PASS.
 *
 * Environment variables:
 *   SHELLY_UPDATER_FUNCTIONAL_CHECK=1
 *     Adds a `claude --print "reply OK"` (or codex equivalent) smoke check
 *     beyond `--version`. Exercises DNS, TLS, auth, musl resolver, actual
 *     inference path. Gated behind an env var because it requires valid
 *     upstream credentials on this device; default install would fail it
 *     even on a healthy release.
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
const LIB = process.env.SHELLY_LIB_DIR;
const FORCE = process.argv.includes('--force');
const TOOL = process.argv.find((arg) => arg === 'claude' || arg === 'codex') || 'all';

// Channel selection — default stable per Codex review. Users wanting
// bleeding-edge pass --channel latest.
const CHANNEL_IDX = process.argv.indexOf('--channel');
const CHANNEL = (CHANNEL_IDX >= 0 && process.argv[CHANNEL_IDX + 1]) || 'stable';
if (!['stable', 'latest'].includes(CHANNEL)) {
  console.error(`unknown channel: ${CHANNEL} (expected stable|latest)`);
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

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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

function runLinker(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.LD_PRELOAD;
  return spawnSync('/system/bin/linker64', args, {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
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
 * Pick the target version for the requested channel. Per Codex review
 * 2026-04-25, "stable" must mean "the newest version that has aged
 * past the cooldown" — NOT "skip if the newest is too young." The
 * original implementation had a correctness bug: if latest was 1 day
 * old but a usable 10-day-old release existed, stable would skip the
 * update entirely and stay on an older, possibly-regressed pin.
 *
 * `latest` channel: resolve to dist-tags.latest unconditionally.
 * `stable` channel: walk `time` + `versions`, pick the newest version
 *                   whose publish time <= now - cooldown.
 *
 * "Shelly stable channel" is a 7-day-aged heuristic — it is NOT a
 * signal from Anthropic's server-side autoUpdatesChannel=stable
 * (which the npm package doesn't expose). README must use the
 * "Shelly stable channel" branding to avoid confusion.
 */
function selectClaudeVersion(pkgMeta, channel) {
  const distTags = pkgMeta['dist-tags'] || {};
  if (channel === 'latest') return { version: distTags.latest, reason: 'latest dist-tag' };

  const cutoff = Date.now() - STABLE_DELAY_MS;
  const versions = Object.keys(pkgMeta.versions || {});
  const aged = versions
    .filter((v) => {
      const t = Date.parse(pkgMeta.time?.[v] || '');
      return Number.isFinite(t) && t <= cutoff;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (aged.length === 0) {
    return { version: null, reason: `no version older than ${STABLE_DELAY_DAYS}d` };
  }
  const pick = aged[aged.length - 1];
  const ageDays = Math.round((Date.now() - Date.parse(pkgMeta.time[pick])) / 86400000);
  return { version: pick, reason: `newest version aged >=${STABLE_DELAY_DAYS}d (pick=${pick}, age=${ageDays}d)` };
}

function selectCodexTag(releases, channel) {
  if (channel === 'latest') return { tag: releases[0]?.tag_name, reason: 'latest release' };

  const cutoff = Date.now() - STABLE_DELAY_MS;
  const aged = releases
    .filter((r) => {
      const t = Date.parse(r.published_at || '');
      return Number.isFinite(t) && t <= cutoff && !r.prerelease && !r.draft;
    });
  if (aged.length === 0) {
    return { tag: null, reason: `no codex release older than ${STABLE_DELAY_DAYS}d` };
  }
  // releases[] from GitHub is ordered newest-first, so aged[0] is the
  // newest qualifying release.
  const pick = aged[0];
  const ageDays = Math.round((Date.now() - Date.parse(pick.published_at)) / 86400000);
  return { tag: pick.tag_name, reason: `newest release aged >=${STABLE_DELAY_DAYS}d (pick=${pick.tag_name}, age=${ageDays}d)` };
}

async function updateClaude() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  const pkgMeta = await json('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64-musl');

  const selection = selectClaudeVersion(pkgMeta, CHANNEL);
  if (!selection.version) {
    info(`[claude] skip (${selection.reason}; channel=${CHANNEL})`);
    return;
  }
  const targetVersion = selection.version;
  info(`[claude] channel=${CHANNEL} target=${targetVersion} (${selection.reason})`);

  if (!FORCE && currentVersion('claude') === targetVersion) {
    info(`[claude] already current ${targetVersion}`);
    return;
  }

  const meta = pkgMeta.versions?.[targetVersion];
  if (!meta?.dist?.tarball || !meta?.dist?.integrity) fail('[claude] version metadata missing dist fields');

  info(`[claude] downloading ${targetVersion}`);
  const tgz = await request(meta.dist.tarball);
  const actualIntegrity = integritySha512(tgz);
  if (actualIntegrity !== meta.dist.integrity) {
    fail(`[claude] integrity mismatch: ${actualIntegrity} != ${meta.dist.integrity}`);
  }

  const entries = parseTar(tgz);
  const bin = tarEntry(entries, 'package/claude') || tarEntry(entries, 'claude');
  if (!bin) fail('[claude] package/claude missing from tarball');

  const staging = path.join(TMP, `claude-${targetVersion}`);
  ensureCleanDir(staging);
  const out = path.join(staging, 'claude');
  fs.writeFileSync(out, bin, { mode: 0o755 });
  fs.chmodSync(out, 0o755);

  // Shape check before spawning — catches packaging shifts without
  // the 30-second spawn timeout cost.
  validateClaudeShape(out);

  // Smoke test 1: --version (no network, no auth required).
  const smoke = runLinker([
    path.join(LIB, 'shelly_musl_exec'),
    path.join(LIB, 'ld-musl-aarch64.so.1'),
    out,
    '--version',
  ]);
  const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
  if (smoke.status !== 0 || !combined.includes(targetVersion)) {
    fail(`[claude] --version smoke failed status=${smoke.status}: ${combined.slice(0, 500)}`);
  }
  info(`[claude] --version smoke OK`);

  // Smoke test 2 (optional, opt-in): --print "Reply exactly OK".
  // Exercises DNS, TLS, auth, musl resolver, actual inference path.
  // Skipped by default because it requires valid Anthropic credentials
  // on this device — would fail on a healthy release for a user who
  // hasn't transplanted .claude/.credentials.json yet. Codex audit
  // 2026-04-25 pointed out the prompt must verify the model ACTUALLY
  // returned OK, not just that the API round-trip succeeded — so we
  // grep stdout for /OK/ and fail otherwise.
  if (FUNCTIONAL_CHECK) {
    info(`[claude] functional check: --print "Reply exactly OK"`);
    const func = runLinker([
      path.join(LIB, 'shelly_musl_exec'),
      path.join(LIB, 'ld-musl-aarch64.so.1'),
      out,
      '--print',
      'Reply exactly OK',
    ], { SHELLY_UPDATER_FUNCTIONAL_CHECK: '' }); // don't recurse into check
    const funcOut = `${func.stdout || ''}${func.stderr || ''}`;
    if (func.status !== 0) {
      fail(`[claude] --print functional check failed status=${func.status}: ${funcOut.slice(0, 500)}`);
    }
    if (!/\bOK\b/i.test(func.stdout || '')) {
      fail(`[claude] --print functional check: model did not return OK: ${funcOut.slice(0, 500)}`);
    }
    info(`[claude] functional check OK`);
  }

  promote('claude', targetVersion, staging);
  info(`[claude] promoted ${targetVersion} (channel=${CHANNEL})`);
}

async function updateCodex() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  // GitHub /releases returns newest-first. Need the full list for
  // stable channel so we can walk backwards past any release younger
  // than the cooldown.
  const releases = await json('https://api.github.com/repos/DioNanos/codex-termux/releases?per_page=20', {
    'Accept': 'application/vnd.github+json',
  });

  const selection = selectCodexTag(releases, CHANNEL);
  if (!selection.tag) {
    info(`[codex] skip (${selection.reason}; channel=${CHANNEL})`);
    return;
  }
  const tag = selection.tag;
  info(`[codex] channel=${CHANNEL} target=${tag} (${selection.reason})`);

  const rel = releases.find((r) => r.tag_name === tag);
  if (!rel) fail(`[codex] release ${tag} disappeared between listing and selection`);
  const assetName = `codex-termux-android-arm64-${tag}.tar.gz`;
  const sumName = `${assetName}.sha256`;
  const asset = (rel.assets || []).find((a) => a.name === assetName);
  const sumAsset = (rel.assets || []).find((a) => a.name === sumName);
  if (!asset?.browser_download_url || !sumAsset?.browser_download_url) {
    fail('[codex] release assets missing');
  }
  if (!FORCE && currentVersion('codex') === tag) {
    info(`[codex] already current ${tag}`);
    return;
  }

  info(`[codex] downloading ${tag}`);
  const [tgz, sumBuf] = await Promise.all([
    request(asset.browser_download_url),
    request(sumAsset.browser_download_url),
  ]);
  const expected = sumBuf.toString('utf8').trim().split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(tgz).digest('hex');
  if (actual !== expected) fail(`[codex] sha256 mismatch: ${actual} != ${expected}`);

  const entries = parseTar(tgz);
  const execBin = tarEntry(entries, 'codex-exec.bin');
  const tuiBin = tarEntry(entries, 'codex.bin');
  if (!execBin || !tuiBin) fail('[codex] codex-exec.bin or codex.bin missing from tarball');

  const staging = path.join(TMP, `codex-${tag}`);
  ensureCleanDir(staging);
  const execOut = path.join(staging, 'codex_exec');
  const tuiOut = path.join(staging, 'codex_tui');
  fs.writeFileSync(execOut, execBin, { mode: 0o755 });
  fs.writeFileSync(tuiOut, tuiBin, { mode: 0o755 });
  fs.chmodSync(execOut, 0o755);
  fs.chmodSync(tuiOut, 0o755);

  const smoke = runLinker([execOut, '--version']);
  const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
  const plainVersion = tag.replace(/^v/, '');
  if (smoke.status !== 0 || !combined.includes(plainVersion)) {
    fail(`[codex] --version smoke failed status=${smoke.status}: ${combined.slice(0, 500)}`);
  }
  info(`[codex] --version smoke OK`);

  // codex has no --print equivalent that's safe to run without auth.
  // Skip functional check for codex even when FUNCTIONAL_CHECK=1.

  promote('codex', tag, staging);
  info(`[codex] promoted ${tag} (channel=${CHANNEL})`);
}

function cleanupStaleStaging() {
  // Purge any leftover staging directories from crashed previous runs.
  // Codex audit 2026-04-25: race window between writeFileSync and
  // promote leaks ~/.shelly-runtime/.tmp/claude-X or codex-Y if the
  // process dies mid-run. Clean at startup so disk doesn't accrue.
  try {
    if (!fs.existsSync(TMP)) return;
    for (const entry of fs.readdirSync(TMP)) {
      if (entry.startsWith('claude-') || entry.startsWith('codex-')) {
        fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
      }
    }
  } catch (err) {
    log(`cleanupStaleStaging: ${err.message}`);
  }
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  cleanupStaleStaging();
  log(`start tool=${TOOL} channel=${CHANNEL} force=${FORCE} functional=${FUNCTIONAL_CHECK} stableDelay=${STABLE_DELAY_DAYS}d`);
  if (TOOL === 'claude' || TOOL === 'all') await updateClaude();
  if (TOOL === 'codex' || TOOL === 'all') await updateCodex();
  log('done');
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(1);
});
