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
  console.log(`codex exec: ${mark(data.codex.exec.version.ok)} ${data.codex.exec.version.output}`);
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

const data = report();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(data, null, 2));
} else {
  printHuman(data);
}
