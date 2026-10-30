/**
 * Compiles the vendored TerminalEmulator (plus the minimal real dependencies it
 * needs) against JVM stubs so __tests__/claude-glibc-s2.test.ts can push real
 * OSC 8 bytes through it. Returns the classes dir, or null when no javac.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const termux = path.join(root, 'modules/terminal-emulator/android/src/main/java/com/termux/terminal');
const stubs = path.join(__dirname, 'stubs');
const REAL = [
  'TerminalEmulator', 'TerminalBuffer', 'TerminalRow', 'TextStyle', 'WcWidth',
  'TerminalColors', 'TerminalColorScheme', 'TerminalOutput',
];

function listJava(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJava(p));
    else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

function build() {
  const probe = spawnSync('javac', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return { dir: null, error: 'javac not available' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc8-harness-'));
  const srcs = [...listJava(stubs), ...REAL.map((n) => path.join(termux, `${n}.java`))];
  const r = spawnSync('javac', ['-nowarn', '-encoding', 'UTF-8', '-d', dir, ...srcs], { encoding: 'utf8' });
  if (r.status !== 0) return { dir: null, error: `${r.stdout}\n${r.stderr}` };
  return { dir, error: null };
}

function run(dir, input, chunk) {
  const hex = Buffer.from(input, 'latin1').toString('hex');
  const r = spawnSync('java', ['-cp', dir, 'com.termux.terminal.Osc8Harness', String(chunk), hex], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`harness failed: ${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/);
  return {
    uris: lines.filter((l) => l.startsWith('URI ')).map((l) => l.slice(4)),
    screen: (lines.find((l) => l.startsWith('SCREEN ')) || '').slice(7),
  };
}

module.exports = { build, run };
