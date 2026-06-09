#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const HOME = process.env.HOME || process.cwd();
const LIB = process.env.SHELLY_LIB_DIR || '';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const force = args.includes('--force');
const installRuntime = args.includes('--install-runtime');
const resetRuntime = args.includes('--reset-runtime');
const statusJson = args.includes('--status-json');
const tool = args.find((arg) => !arg.startsWith('--')) || 'codex';

const runtimeRoot = path.join(HOME, '.shelly-runtime', 'codex');
const versionsDir = path.join(runtimeRoot, 'versions');
const currentLink = path.join(runtimeRoot, 'current');
const tmpDir = path.join(HOME, '.shelly-runtime', '.tmp');

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch (_) {
    return false;
  }
}

function safeName(value) {
  return String(value || '').replace(/[^0-9A-Za-z._-]+/g, '_').slice(0, 120) || 'unknown';
}

function parseVersion(output) {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function runVersion(file, libDir, options = {}) {
  if (!file || !exists(file)) return { ok: false, file, output: 'missing' };
  const runtimeLib = path.dirname(file);
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [runtimeLib, libDir || LIB].filter(Boolean).join(':'),
    SHELLY_LIB_DIR: libDir || LIB,
  };
  if (options.wrap && libDir) {
    env.LD_PRELOAD = path.join(libDir, 'libexec_wrapper.so');
    env.SHELLY_CODEX_EXEC_PATH = file;
    env.SHELLY_CODEX_PROC_EXE_SHIM = '1';
    env.SHELLY_CODEX_PROC_EXE_OPEN_SHIM = '1';
  }
  const result = cp.spawnSync('/system/bin/linker64', [file, '--version'], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    ok: result.status === 0 && Boolean(parseVersion(output)),
    file,
    code: result.status,
    output,
    version: parseVersion(output),
  };
}

function isHealthyRuntime(dir = currentLink) {
  return Boolean(
    exists(path.join(dir, '.healthy')) &&
    exists(path.join(dir, 'manifest.json')) &&
    isExecutable(path.join(dir, 'codex_tui')) &&
    isExecutable(path.join(dir, 'codex_exec')),
  );
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function activeCodexBase() {
  if (process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME !== '1' && isHealthyRuntime(currentLink)) {
    return { source: 'runtime', base: currentLink };
  }
  return { source: 'bundled', base: LIB };
}

function probeCodex() {
  const active = activeCodexBase();
  const candidates = [
    path.join(active.base, 'codex_tui'),
    path.join(active.base, 'codex_exec'),
    path.join(LIB, 'codex_tui'),
    path.join(LIB, 'codex_exec'),
  ];
  const tried = [];
  for (const file of candidates) {
    const result = runVersion(file, LIB);
    tried.push(result);
    if (result.ok) return { ok: true, source: active.source, selected: result, tried };
  }
  return { ok: false, source: active.source, selected: null, tried };
}

function printProbe(probe) {
  if (statusJson) {
    const manifest = readJson(path.join(currentLink, 'manifest.json')) || null;
    console.log(JSON.stringify({
      ok: probe.ok,
      source: probe.source,
      version: probe.selected?.version || null,
      output: probe.selected?.output || null,
      runtimeHealthy: isHealthyRuntime(currentLink),
      runtimeManifest: manifest,
    }, null, 2));
    return;
  }
  if (probe.ok) {
    console.log(`[shelly] codex: OK ${probe.selected.output || probe.selected.file} (${probe.source})`);
    return;
  }
  console.log('[shelly] codex: missing or not runnable');
  for (const item of probe.tried) {
    console.log(`  - ${item.file}: ${item.output || `exit ${item.code}`}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, outFile, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        'User-Agent': 'Shelly',
        Accept: 'application/octet-stream',
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const next = new URL(location, parsed).toString();
        download(next, outFile, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => reject(new Error(`download HTTP ${status}: ${body.trim()}`)));
        return;
      }
      const tmp = `${outFile}.download`;
      const stream = fs.createWriteStream(tmp, { mode: 0o600 });
      response.pipe(stream);
      stream.on('finish', () => {
        stream.close(() => {
          fs.renameSync(tmp, outFile);
          resolve();
        });
      });
      stream.on('error', reject);
    });
    request.setTimeout(60000, () => {
      request.destroy(new Error('download timeout'));
    });
    request.on('error', reject);
  });
}

function runTarExtract(archive, outDir) {
  const attempts = [
    ['/system/bin/toybox', ['tar', '-xzf', archive, '-C', outDir]],
    ['tar', ['-xzf', archive, '-C', outDir]],
  ];
  const errors = [];
  for (const [bin, argv] of attempts) {
    const result = cp.spawnSync(bin, argv, {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, LD_LIBRARY_PATH: LIB },
    });
    if (result.status === 0) return;
    errors.push(`${bin}: ${`${result.stdout || ''}${result.stderr || ''}`.trim() || `exit ${result.status}`}`);
  }
  throw new Error(`extract failed: ${errors.join(' | ')}`);
}

function installFromEnvSync() {
  const manifest = {
    schemaVersion: 1,
    channel: 'codex-runtime-latest',
    version: String(process.env.SHELLY_CODEX_RUNTIME_VERSION || '').replace(/^v/, ''),
    codexVersion: process.env.SHELLY_CODEX_VERSION || '',
    codexTermuxVersion: process.env.SHELLY_CODEX_TERMUX_VERSION || '',
    gitSha: process.env.SHELLY_CODEX_RUNTIME_GIT_SHA || '',
    runId: Number(process.env.SHELLY_CODEX_RUNTIME_RUN_ID || 0) || undefined,
    assetName: process.env.SHELLY_CODEX_RUNTIME_ASSET || '',
    tarballUrl: process.env.SHELLY_CODEX_RUNTIME_URL || '',
    sha256: String(process.env.SHELLY_CODEX_RUNTIME_SHA256 || '').toLowerCase(),
    installedAt: new Date().toISOString(),
  };
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('invalid Codex runtime version');
  }
  if (!/^https:\/\//.test(manifest.tarballUrl)) {
    throw new Error('invalid Codex runtime URL');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('invalid Codex runtime sha256');
  }

  fs.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const installId = `${safeName(manifest.version)}-${safeName(manifest.runId || 'manual')}-${Date.now()}`;
  const staging = path.join(tmpDir, `codex-${installId}`);
  const archive = path.join(tmpDir, `${installId}.tar.gz`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  return download(manifest.tarballUrl, archive).then(() => {
    const actual = sha256File(archive);
    if (actual !== manifest.sha256) {
      throw new Error(`sha256 mismatch: expected ${manifest.sha256}, got ${actual}`);
    }
    runTarExtract(archive, staging);
    for (const name of ['codex_exec', 'codex_tui']) {
      const file = path.join(staging, name);
      if (!exists(file)) throw new Error(`${name} missing from Codex runtime`);
      fs.chmodSync(file, 0o700);
    }
    const cxx = path.join(staging, 'libc++_shared.so');
    if (exists(cxx)) fs.chmodSync(cxx, 0o600);

    const tui = runVersion(path.join(staging, 'codex_tui'), LIB, { wrap: true });
    const exec = runVersion(path.join(staging, 'codex_exec'), LIB, { wrap: true });
    if (!tui.ok || !exec.ok) {
      throw new Error(`Codex runtime smoke failed: tui=${tui.output || tui.code}; exec=${exec.output || exec.code}`);
    }
    const tuiVersion = tui.version;
    const execVersion = exec.version;
    if (tuiVersion !== manifest.version || execVersion !== manifest.version) {
      throw new Error(`Codex runtime version mismatch: manifest=${manifest.version}, tui=${tuiVersion}, exec=${execVersion}`);
    }

    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      ...manifest,
      smoke: {
        codex_tui: tui.output,
        codex_exec: exec.output,
      },
    }, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(staging, '.healthy'), `${new Date().toISOString()}\n`, { mode: 0o600 });

    const finalDir = path.join(versionsDir, installId);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);

    const nextLink = path.join(runtimeRoot, 'current.next');
    fs.rmSync(nextLink, { recursive: true, force: true });
    fs.symlinkSync(finalDir, nextLink);
    try {
      const currentStat = fs.lstatSync(currentLink);
      if (!currentStat.isSymbolicLink()) {
        fs.renameSync(currentLink, path.join(runtimeRoot, `current.backup.${Date.now()}`));
      } else {
        fs.unlinkSync(currentLink);
      }
    } catch (_) {}
    fs.renameSync(nextLink, currentLink);
    fs.rmSync(archive, { force: true });
    console.log(`[shelly] Codex runtime ${manifest.version} installed. Open a new terminal tab to use it.`);
  });
}

function resetRuntimeSync() {
  try {
    const currentStat = fs.lstatSync(currentLink);
    if (currentStat.isSymbolicLink()) fs.unlinkSync(currentLink);
    else fs.renameSync(currentLink, path.join(runtimeRoot, `current.disabled.${Date.now()}`));
  } catch (_) {}
  console.log('[shelly] Codex runtime reset. Bundled APK runtime will be used in new terminal tabs.');
}

if (!['codex', 'all'].includes(tool)) {
  console.error(`[shelly] ${tool}: removed from Shelly; only Codex is supported`);
  process.exit(2);
}

if (resetRuntime) {
  try {
    resetRuntimeSync();
    process.exit(0);
  } catch (error) {
    console.error(`[shelly] reset failed: ${error.message || error}`);
    process.exit(1);
  }
}

if (installRuntime) {
  installFromEnvSync().then(
    () => process.exit(0),
    (error) => {
      console.error(`[shelly] Codex runtime install failed: ${error.message || error}`);
      process.exit(1);
    },
  );
} else {
  const probe = probeCodex();
  printProbe(probe);
  if (force) {
    console.log('[shelly] Use --install-runtime from the Shelly update surface to install a verified Codex runtime.');
  }
  process.exit(probe.ok || checkOnly || force ? 0 : 1);
}
