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

  if (channel === 'latest') {
    // Codex review 2026-04-25 issue #2: validate dist-tags.latest is a
    // real semver release that actually exists in pkgMeta.versions
    // before using it. npm has historically allowed `latest` to point
    // at prereleases or malformed strings — accepting blindly would
    // bypass our /^\d+\.\d+\.\d+$/ filter.
    const distLatest = pkgMeta['dist-tags']?.latest;
    if (distLatest && /^\d+\.\d+\.\d+$/.test(distLatest) && pkgMeta.versions?.[distLatest]) {
      return [distLatest];
    }
    return sorted.slice(0, 1);
  }

  if (channel === 'stable') {
    const cutoff = Date.now() - STABLE_DELAY_MS;
    const aged = sorted.filter((v) => {
      const t = Date.parse(pkgMeta.time?.[v] || '');
      return Number.isFinite(t) && t <= cutoff;
    });
    return aged.slice(0, MAX_CANDIDATES);
  }

  // verified (default): all versions, newest first
  return sorted.slice(0, MAX_CANDIDATES);
}

function selectCodexCandidates(releases, channel) {
  const usable = releases.filter((r) => !r.prerelease && !r.draft);
  // GitHub /releases is newest-first already.

  if (channel === 'latest') {
    return usable.slice(0, 1).map((r) => r.tag_name);
  }

  if (channel === 'stable') {
    const cutoff = Date.now() - STABLE_DELAY_MS;
    const aged = usable.filter((r) => {
      const t = Date.parse(r.published_at || '');
      return Number.isFinite(t) && t <= cutoff;
    });
    return aged.slice(0, MAX_CANDIDATES).map((r) => r.tag_name);
  }

  // verified (default)
  return usable.slice(0, MAX_CANDIDATES).map((r) => r.tag_name);
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
    const staging = path.join(TMP, `claude-${version}-${RUN_TAG}`);
    ensureCleanDir(staging);
    const out = path.join(staging, 'claude');
    fs.writeFileSync(out, bin, { mode: 0o755 });
    fs.chmodSync(out, 0o755);

    try {
      validateClaudeShape(out);
    } catch (e) {
      // Eager cleanup on shape rejection — these dirs accumulate
      // otherwise and a series of bad upstream releases bloats disk.
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, reason: `shape check: ${e.message}` };
    }

    // Smoke 1: --version (no network/auth).
    const smoke = runLinker([
      path.join(LIB, 'shelly_musl_exec'),
      path.join(LIB, 'ld-musl-aarch64.so.1'),
      out,
      '--version',
    ]);
    const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
    if (smoke.status !== 0 || !combined.includes(version)) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, reason: `--version smoke status=${smoke.status}: ${combined.slice(0, 200)}` };
    }
    info(`[claude] try ${version} — --version smoke OK`);

    // Smoke 2 (opt-in): --print "Reply exactly OK".
    if (FUNCTIONAL_CHECK) {
      const func = runLinker([
        path.join(LIB, 'shelly_musl_exec'),
        path.join(LIB, 'ld-musl-aarch64.so.1'),
        out,
        '--print',
        'Reply exactly OK',
      ], { SHELLY_UPDATER_FUNCTIONAL_CHECK: '' });
      const funcOut = `${func.stdout || ''}${func.stderr || ''}`;
      if (func.status !== 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: `--print status=${func.status}: ${funcOut.slice(0, 200)}` };
      }
      if (!/\bOK\b/i.test(func.stdout || '')) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { ok: false, reason: `--print did not return OK: ${funcOut.slice(0, 200)}` };
      }
      info(`[claude] try ${version} — functional check OK`);
    }

    return { ok: true, staging };
  } catch (err) {
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
  if (!FORCE && currentVersion('claude') === candidates[0]) {
    info(`[claude] already on verified latest ${candidates[0]}`);
    return;
  }

  // Walk candidates newest-first. First one that passes smoke wins.
  for (const version of candidates) {
    if (!FORCE && currentVersion('claude') === version) {
      info(`[claude] keeping current ${version} (newer candidates already failed smoke)`);
      return;
    }
    const result = await tryClaudeVersion(pkgMeta, version);
    if (result.ok) {
      promote('claude', version, result.staging);
      info(`[claude] promoted ${version} (verified, channel=${CHANNEL})`);
      return;
    }
    info(`[claude] reject ${version}: ${result.reason}`);
  }

  // All candidates failed — keep current promotion as-is. The bundled
  // golden APK version is the ultimate fallback in claude() bash
  // function, so the user always has a working Claude.
  info(`[claude] all ${candidates.length} candidates failed smoke; keeping current=${currentVersion('claude') || '(none)'}`);
}

async function tryCodexTag(releases, tag) {
  try {
    const rel = releases.find((r) => r.tag_name === tag);
    if (!rel) return { ok: false, reason: 'release disappeared' };
    const assetName = `codex-termux-android-arm64-${tag}.tar.gz`;
    const sumName = `${assetName}.sha256`;
    const asset = (rel.assets || []).find((a) => a.name === assetName);
    const sumAsset = (rel.assets || []).find((a) => a.name === sumName);
    if (!asset?.browser_download_url || !sumAsset?.browser_download_url) {
      return { ok: false, reason: 'release assets missing' };
    }
    info(`[codex] try ${tag} — downloading`);
    const [tgz, sumBuf] = await Promise.all([
      request(asset.browser_download_url),
      request(sumAsset.browser_download_url),
    ]);
    const expected = sumBuf.toString('utf8').trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(tgz).digest('hex');
    if (actual !== expected) return { ok: false, reason: `sha256 mismatch ${actual} != ${expected}` };

    const entries = parseTar(tgz);
    const execBin = tarEntry(entries, 'codex-exec.bin');
    const tuiBin = tarEntry(entries, 'codex.bin');
    if (!execBin || !tuiBin) return { ok: false, reason: 'codex-exec.bin or codex.bin missing' };

    const staging = path.join(TMP, `codex-${tag}-${RUN_TAG}`);
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
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, reason: `--version status=${smoke.status}: ${combined.slice(0, 200)}` };
    }
    info(`[codex] try ${tag} — --version smoke OK`);
    // codex has no --print equivalent that's safe without auth, so we
    // stop here even when FUNCTIONAL_CHECK=1.
    return { ok: true, staging };
  } catch (err) {
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
