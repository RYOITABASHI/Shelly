#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HOME = process.env.HOME || process.cwd();
const LIB = process.env.SHELLY_LIB_DIR || '';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const force = args.includes('--force');
const tool = args.find((arg) => !arg.startsWith('--')) || 'codex';

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch (_) {
    return false;
  }
}

function runVersion(file) {
  if (!file || !exists(file)) return { ok: false, file, output: 'missing' };
  const result = cp.spawnSync('/system/bin/linker64', [file, '--version'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, LD_LIBRARY_PATH: LIB },
  });
  return {
    ok: result.status === 0,
    file,
    code: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function probeCodex() {
  const candidates = [
    path.join(HOME, '.shelly-runtime/codex/current/codex_tui'),
    path.join(LIB, 'codex_tui'),
    path.join(HOME, '.shelly-runtime/codex/current/codex_exec'),
    path.join(LIB, 'codex_exec'),
  ];
  const tried = [];
  for (const file of candidates) {
    const result = runVersion(file);
    tried.push(result);
    if (result.ok) return { ok: true, selected: result, tried };
  }
  return { ok: false, selected: null, tried };
}

function printProbe(probe) {
  if (probe.ok) {
    console.log(`[shelly] codex: OK ${probe.selected.output || probe.selected.file}`);
    return;
  }
  console.log('[shelly] codex: missing or not runnable');
  for (const item of probe.tried) {
    console.log(`  - ${item.file}: ${item.output || `exit ${item.code}`}`);
  }
}

if (!['codex', 'all'].includes(tool)) {
  console.error(`[shelly] ${tool}: removed from Shelly; only Codex is supported`);
  process.exit(2);
}

const probe = probeCodex();
printProbe(probe);

if (force) {
  console.log('[shelly] Codex runtime is APK/CI managed. No background mutation was performed.');
}

process.exit(probe.ok || checkOnly || force ? 0 : 1);
