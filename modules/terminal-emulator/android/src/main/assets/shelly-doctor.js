#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HOME = process.env.HOME || process.cwd();
const LIB = process.env.SHELLY_LIB_DIR || '';
const SDCARD_DOWNLOAD = '/sdcard/Download';
const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'CODEX_AUTH_TOKEN',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'PERPLEXITY_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch (_) {
    return false;
  }
}

function statInfo(file) {
  try {
    const stat = fs.statSync(file);
    return {
      exists: true,
      size: stat.size,
      mode: (stat.mode & 0o777).toString(8),
      mtime: stat.mtime.toISOString(),
    };
  } catch (_) {
    return { exists: false };
  }
}

function modeIsPrivate(info) {
  if (!info?.exists || !info.mode) return null;
  const mode = Number.parseInt(info.mode, 8);
  if (!Number.isFinite(mode)) return false;
  return (mode & 0o077) === 0;
}

function securityFile(file, shouldBePrivate = false) {
  const info = statInfo(file);
  return {
    file,
    ...info,
    shouldBePrivate,
    privateMode: shouldBePrivate ? modeIsPrivate(info) : null,
  };
}

function runVersion(file, args = ['--version']) {
  if (!exists(file)) return { ok: false, output: 'missing' };
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: LIB,
    SHELLY_CODEX_EXEC_PATH: file,
    SHELLY_CODEX_PROC_EXE_SHIM: '1',
    SHELLY_CODEX_PROC_EXE_OPEN_SHIM: '1',
  };
  delete env.LD_PRELOAD;
  const result = cp.spawnSync('/system/bin/linker64', [file, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function securityReport() {
  return {
    downloadCredentials: [
      securityFile(path.join(SDCARD_DOWNLOAD, 'shelly-codex-auth.json')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'codex-auth.json')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'codex-auth.tar')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'shelly-claude-root.json')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'termux-claude-dir.tar')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'termux-gemini-dir.tar')),
    ],
    privateFiles: [
      securityFile(path.join(HOME, '.codex/auth.json'), true),
      securityFile(path.join(HOME, '.shelly/agents/.env'), true),
    ],
    envKeysPresent: SECRET_ENV_NAMES.filter((name) => Boolean(process.env[name])),
  };
}

function shellCheck() {
  const shell = process.env.SHELL || '';
  const bash = process.env.BASH || '';
  return {
    shell,
    bash,
    shellInfo: statInfo(shell),
    bashInfo: statInfo(bash),
  };
}

function codexReport() {
  const tui = path.join(LIB, 'codex_tui');
  return {
    tui: { file: tui, info: statInfo(tui), version: runVersion(tui), execHelp: runVersion(tui, ['exec', '--help']) },
    jsDispatcher: statInfo(path.join(LIB, 'node_modules/@openai/codex/bin/codex.js')),
    auth: statInfo(path.join(HOME, '.codex/auth.json')),
  };
}

function localReport() {
  const endpoints = [
    process.env.LOCAL_LLM_URL,
    'http://127.0.0.1:8080',
    'http://127.0.0.1:11434',
  ].filter(Boolean);
  return { endpoints: Array.from(new Set(endpoints)) };
}

function report() {
  return {
    home: HOME,
    lib: LIB,
    shell: shellCheck(),
    native: {
      node: statInfo(path.join(LIB, 'node')),
      bash: statInfo(path.join(LIB, 'libbash.so')),
      execWrapper: statInfo(path.join(LIB, 'libexec_wrapper.so')),
      xdgOpen: statInfo(path.join(LIB, 'shelly_xdg_open')),
    },
    codex: codexReport(),
    local: localReport(),
    security: securityReport(),
  };
}

function mark(ok) {
  return ok ? 'OK' : 'WARN';
}

function printHuman(data) {
  console.log('Shelly doctor');
  console.log(`home: ${data.home}`);
  console.log(`lib:  ${data.lib}`);
  console.log(`shell: ${data.shell.shell || '(unset)'}`);
  console.log(`bash:  ${data.shell.bash || '(unset)'}`);
  console.log(`node:  ${mark(data.native.node.exists)} ${data.native.node.size || 0} bytes`);
  console.log(`bash.so: ${mark(data.native.bash.exists)} ${data.native.bash.size || 0} bytes`);
  console.log(`exec wrapper: ${mark(data.native.execWrapper.exists)}`);
  console.log(`xdg-open: ${mark(data.native.xdgOpen.exists)}`);
  console.log(`codex tui:  ${mark(data.codex.tui.version.ok)} ${data.codex.tui.version.output}`);
  console.log(`codex exec: ${mark(data.codex.tui.execHelp.ok)} ${data.codex.tui.execHelp.output}`);
  console.log(`codex js:   ${mark(data.codex.jsDispatcher.exists)}`);
  console.log(`codex auth: ${data.codex.auth.exists ? 'present' : 'missing'}`);
  console.log(`local llm probes: ${data.local.endpoints.join(', ')}`);
  const leftover = data.security.downloadCredentials.filter((file) => file.exists);
  console.log(`download credentials: ${leftover.length > 0 ? `WARN ${leftover.map((file) => path.basename(file.file)).join(', ')}` : 'OK none'}`);
  for (const file of data.security.privateFiles) {
    if (!file.exists) continue;
    const label = path.basename(file.file) === '.env' ? 'agent env' : path.basename(file.file);
    console.log(`${label}: ${file.privateMode ? 'OK' : 'WARN'} ${file.mode}${file.privateMode ? '' : ' should be 0600/0700-private'}`);
  }
  console.log(`api env vars: ${data.security.envKeysPresent.length > 0 ? `WARN ${data.security.envKeysPresent.join(', ')}` : 'OK none'}`);
}

// ---------------------------------------------------------------------------
// `--report`: copy-pasteable Markdown block for GitHub device reports.
// Privacy: never prints tokens, emails, serials/IMEI/Android ID, IPs, or
// filesystem paths. Every probe is best-effort and degrades to "unknown".
// ---------------------------------------------------------------------------
function sh(file, args, timeout = 8000) {
  try {
    const r = cp.spawnSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return null;
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  } catch (_) {
    return null;
  }
}

function prop(name) {
  const r = sh('/system/bin/getprop', [name], 3000);
  return r && r.out ? r.out.split('\n')[0].trim() : '';
}

// Run a tool through the interactive Shelly bash so ~/.bashrc wrappers
// (git, python3, ...) resolve exactly as they do in a terminal pane.
function toolVersion(cmd) {
  const bash = path.join(LIB, 'libbash.so');
  if (!exists(bash)) return { state: 'unknown', note: 'bash missing' };
  const env = { ...process.env, LD_LIBRARY_PATH: process.env.SHELLY_LD_LIBRARY_PATH || LIB };
  delete env.LD_PRELOAD;
  const r = cp.spawnSync('/system/bin/linker64', [bash, '-ic', `${cmd} 2>&1 | head -n 1`], {
    encoding: 'utf8', timeout: 20000, env, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = `${r.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  if (/not found|No such file/i.test(line)) return { state: 'absent', note: '' };
  if (r.status === 0 && line && !/denied/i.test(line)) return { state: 'ok', note: line.slice(0, 80) };
  return { state: 'fail', note: line.slice(0, 80) };
}

function fmtTool(t) {
  if (t.state === 'ok') return `runs (${t.note})`;
  if (t.state === 'absent') return 'not installed';
  if (t.state === 'unknown') return `unknown (${t.note})`;
  return `FAILS${t.note ? ` (${t.note})` : ''}`;
}

function gib(kb) {
  return `${(kb / 1048576).toFixed(1)} GiB`;
}

function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { total: get('MemTotal'), avail: get('MemAvailable') };
  } catch (_) {
    return { total: 0, avail: 0 };
  }
}

function storageInfo() {
  const r = sh('/system/bin/df', ['-k', HOME], 4000);
  if (!r) return null;
  const cols = (r.out.split('\n')[1] || '').trim().split(/\s+/);
  const total = Number(cols[1]);
  const avail = Number(cols[3]);
  return Number.isFinite(total) && Number.isFinite(avail) ? { total, avail } : null;
}

// Written by the app on every start (AppInfoSnapshot.kt): an app uid cannot run
// `dumpsys package` / `dumpsys deviceidle`, so this is the reliable source.
function appInfoSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, '.shelly', 'app-info.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function appPackageInfo() {
  const snap = appInfoSnapshot();
  if (snap && snap.versionCode) {
    return {
      versionName: String(snap.versionName || ''),
      versionCode: String(snap.versionCode),
      notif: typeof snap.notificationsEnabled === 'boolean' ? String(snap.notificationsEnabled) : undefined,
    };
  }
  const r = sh('/system/bin/dumpsys', ['package', 'dev.shelly.terminal'], 10000);
  const out = r ? r.out : '';
  const pick = (re) => (out.match(re) || [])[1];
  return {
    versionName: pick(/versionName=(\S+)/),
    versionCode: pick(/versionCode=(\d+)/),
    notif: pick(/android\.permission\.POST_NOTIFICATIONS: granted=(true|false)/),
  };
}

function allFilesAccess() {
  // Writing at the /sdcard root only succeeds with MANAGE_EXTERNAL_STORAGE.
  const probe = `/sdcard/.shelly-doctor-probe-${process.pid}`;
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return 'granted';
  } catch (_) {
    return 'not granted';
  }
}

function batteryExempt() {
  const snap = appInfoSnapshot();
  if (snap && typeof snap.ignoringBatteryOptimizations === 'boolean') {
    return snap.ignoringBatteryOptimizations ? 'exempt (unrestricted)' : 'NOT exempt (may be killed in background)';
  }
  const r = sh('/system/bin/dumpsys', ['deviceidle', 'whitelist'], 6000);
  if (!r || !r.out || /denied|Permission/i.test(r.out)) return 'unknown (cannot probe from shell)';
  return /dev\.shelly\.terminal/.test(r.out) ? 'exempt (unrestricted)' : 'NOT exempt (may be killed in background)';
}

function printReport(data) {
  const pkg = appPackageInfo();
  const mem = memInfo();
  const st = storageInfo();
  const abi = prop('ro.product.cpu.abi') || process.arch;
  const warnings = [];
  if (!data.native.node.exists) warnings.push('node binary missing');
  if (!data.native.bash.exists) warnings.push('libbash.so missing');
  if (!data.native.execWrapper.exists) warnings.push('exec wrapper missing');
  if (!data.codex.tui.version.ok) warnings.push('codex --version failed');
  const leftover = data.security.downloadCredentials.filter((f) => f.exists);
  if (leftover.length > 0) warnings.push(`${leftover.length} credential file(s) left in Downloads`);
  for (const f of data.security.privateFiles) {
    if (f.exists && !f.privateMode) warnings.push(`${path.basename(f.file)} not private`);
  }
  if (data.security.envKeysPresent.length > 0) warnings.push(`${data.security.envKeysPresent.length} API key env var(s) set in shell`);

  const tools = {
    bash: toolVersion('bash --version'),
    git: toolVersion('git --version'),
    node: toolVersion('node --version'),
    python3: toolVersion('python3 --version'),
  };
  if (tools.python3.state === 'fail') warnings.push('python3 present but fails to run');
  for (const k of ['bash', 'git', 'node']) {
    if (tools[k].state !== 'ok') warnings.push(`${k} did not run`);
  }
  const allFiles = allFilesAccess();
  if (allFiles !== 'granted') warnings.push('All-files access not granted');
  const notif = pkg.notif === 'true' ? 'granted' : pkg.notif === 'false' ? 'not granted' : 'unknown';
  const codexOut = data.codex.tui.version.output.split('\n')[0].slice(0, 60);

  const L = [];
  L.push('### Shelly device report');
  L.push(`- Shelly: ${pkg.versionName || 'unknown'} (versionCode ${pkg.versionCode || 'unknown'})`);
  L.push(`- Android: ${prop('ro.build.version.release') || 'unknown'} (API ${prop('ro.build.version.sdk') || 'unknown'}), security patch ${prop('ro.build.version.security_patch') || 'unknown'}`);
  L.push(`- Device: ${prop('ro.product.manufacturer') || 'unknown'} ${prop('ro.product.model') || 'unknown'}`);
  L.push(`- ABI: ${abi}`);
  L.push(`- RAM: ${mem.total ? `${gib(mem.total)} total, ${gib(mem.avail)} available` : 'unknown'}`);
  L.push(`- Storage (app data): ${st ? `${gib(st.total)} total, ${gib(st.avail)} free` : 'unknown'}`);
  L.push('- Bundled tools:');
  L.push(`  - bash: ${fmtTool(tools.bash)}`);
  L.push(`  - git: ${fmtTool(tools.git)}`);
  L.push(`  - node: ${fmtTool(tools.node)}`);
  L.push(`  - python3: ${fmtTool(tools.python3)}`);
  L.push(`  - codex --version: ${data.codex.tui.version.ok ? `runs (${codexOut})` : 'FAILS'}`);
  L.push(`- All-files access: ${allFiles}`);
  L.push(`- Notification permission: ${notif}`);
  L.push(`- Battery optimization: ${batteryExempt()}`);
  L.push(`- Codex signed in: ${data.codex.auth.exists ? 'yes' : 'no'}`);
  L.push(`- Doctor warnings: ${warnings.length === 0 ? 'none' : warnings.join('; ')}`);
  console.log(L.join('\n'));
  console.log('');
  console.log('Paste the block above into: https://github.com/RYOITABASHI/Shelly/issues/new?template=device-report.yml');
  console.log('(It contains no tokens, emails, serial numbers, IPs, or file paths.)');
}

const data = report();
if (process.argv.includes('--report')) {
  printReport(data);
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(data, null, 2));
} else {
  printHuman(data);
}
