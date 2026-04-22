#!/usr/bin/env node
/**
 * Shelly-managed runtime updater for native AI CLIs.
 *
 * Updates are staged under ~/.shelly-runtime, smoke-tested, then promoted by
 * switching a `current` symlink. Broken upstream releases never replace the
 * last working version.
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
        'User-Agent': 'Shelly-runtime-updater/1',
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

async function updateClaude() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  const meta = await json('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64-musl/latest');
  const version = meta.version;
  if (!version || !meta.dist?.tarball || !meta.dist?.integrity) fail('claude registry response missing fields');
  if (!FORCE && currentVersion('claude') === version) {
    info(`[claude] already current ${version}`);
    return;
  }

  info(`[claude] downloading ${version}`);
  const tgz = await request(meta.dist.tarball);
  const actualIntegrity = integritySha512(tgz);
  if (actualIntegrity !== meta.dist.integrity) {
    fail(`[claude] integrity mismatch: ${actualIntegrity} != ${meta.dist.integrity}`);
  }

  const entries = parseTar(tgz);
  const bin = tarEntry(entries, 'package/claude') || tarEntry(entries, 'claude');
  if (!bin) fail('[claude] package/claude missing from tarball');

  const staging = path.join(TMP, `claude-${version}`);
  ensureCleanDir(staging);
  const out = path.join(staging, 'claude');
  fs.writeFileSync(out, bin, { mode: 0o755 });
  fs.chmodSync(out, 0o755);

  const smoke = runLinker([
    path.join(LIB, 'shelly_musl_exec'),
    path.join(LIB, 'ld-musl-aarch64.so.1'),
    out,
    '--version',
  ]);
  const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
  if (smoke.status !== 0 || !combined.includes(version)) {
    fail(`[claude] smoke failed status=${smoke.status}: ${combined.slice(0, 500)}`);
  }

  promote('claude', version, staging);
  info(`[claude] promoted ${version}`);
}

async function updateCodex() {
  if (!LIB) fail('SHELLY_LIB_DIR is required');
  const rel = await json('https://api.github.com/repos/DioNanos/codex-termux/releases/latest', {
    'Accept': 'application/vnd.github+json',
  });
  const tag = rel.tag_name;
  const assetName = `codex-termux-android-arm64-${tag}.tar.gz`;
  const sumName = `${assetName}.sha256`;
  const asset = (rel.assets || []).find((a) => a.name === assetName);
  const sumAsset = (rel.assets || []).find((a) => a.name === sumName);
  if (!tag || !asset?.browser_download_url || !sumAsset?.browser_download_url) {
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
    fail(`[codex] smoke failed status=${smoke.status}: ${combined.slice(0, 500)}`);
  }

  promote('codex', tag, staging);
  info(`[codex] promoted ${tag}`);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  log(`start tool=${TOOL} force=${FORCE}`);
  if (TOOL === 'claude' || TOOL === 'all') await updateClaude();
  if (TOOL === 'codex' || TOOL === 'all') await updateCodex();
  log('done');
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(1);
});
