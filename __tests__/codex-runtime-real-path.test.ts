/**
 * BASHRC_VERSION 286: Codex finds codex-code-mode-host next to its own path and
 * that host speaks a version-pinned protocol. Launched through the `current`
 * symlink, a running Codex would start the NEW host after an update switched
 * `current`, so every launcher resolves the real versioned directory first:
 * the driver (runtimeCodexTuiPath), codex() and the $HOME/bin/codex shim. The
 * generated bash is extracted from HomeInitializer.kt and run for real.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const ktPath = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt');
const homeKt = fs.readFileSync(ktPath, 'utf8');
const driver = require('../scripts/shelly-agent-driver.js');

function unescapeKotlin(lit: string): string {
  return lit.replace(/\\\$/g, '$').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** The generated lines from `first` up to and including `last`. */
function extract(first: string, last: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of homeKt.split(/\r?\n/)) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    const text = unescapeKotlin(m[1]);
    if (text === first) on = true;
    if (!on) continue;
    out.push(text);
    if (text === last && out.length > 1) return `${out.join('\n')}\n`;
  }
  throw new Error(`could not extract ${first}`);
}

/** HOME with current -> versions/<id>; a junction also works on the dev PC. */
function makeRuntime(files = ['.healthy', 'manifest.json', 'codex_tui']) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-')));
  const runtime = path.join(home, '.shelly-runtime', 'codex');
  const version = (id: string) => {
    const dir = path.join(runtime, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), '#!/bin/sh', { mode: 0o755 });
    return dir;
  };
  const point = (dir: string) => {
    const link = path.join(runtime, 'current');
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(dir, link, 'junction');
  };
  const cleanup = () => {
    fs.rmSync(path.join(runtime, 'current'), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, version, point, cleanup };
}

describe('driver: runtimeCodexTuiPath', () => {
  const saved = process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME;
  beforeEach(() => { delete process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME; });
  afterAll(() => {
    if (saved === undefined) delete process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME;
    else process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME = saved;
  });

  it('returns the versioned path, not the symlink, and keeps it across a switch', () => {
    const t = makeRuntime();
    try {
      const v1 = t.version('0.163.0-aaa');
      const v2 = t.version('0.167.0-bbb');
      t.point(v1);
      const first: string = driver.runtimeCodexTuiPath(t.home);
      expect(first).toBe(path.join(fs.realpathSync(v1), 'codex_tui'));
      expect(first).not.toContain(`${path.sep}current${path.sep}`);
      t.point(v2);
      expect(first).toBe(path.join(fs.realpathSync(v1), 'codex_tui'));
      expect(driver.runtimeCodexTuiPath(t.home)).toBe(path.join(fs.realpathSync(v2), 'codex_tui'));
    } finally {
      t.cleanup();
    }
  });

  it('checks health in the resolved directory', () => {
    const t = makeRuntime(['manifest.json', 'codex_tui']);
    try {
      t.point(t.version('0.163.0-aaa'));
      expect(driver.runtimeCodexTuiPath(t.home)).toBe('');
    } finally {
      t.cleanup();
    }
  });

  it('falls back when there is no runtime or it is turned off', () => {
    const t = makeRuntime();
    try {
      expect(driver.runtimeCodexTuiPath(t.home)).toBe('');
      t.point(t.version('0.163.0-aaa'));
      process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME = '1';
      expect(driver.runtimeCodexTuiPath(t.home)).toBe('');
    } finally {
      t.cleanup();
    }
  });
});

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const maybe = hasBash ? describe : describe.skip;

maybe('generated wrappers', () => {
  const helper = extract('__shelly_codex_runtime_tui() {', '}');
  const shim = extract('__runtime_tui=""', 'fi');
  const quarantine = extract('__shelly_codex_mark_tui_failed() {', '}');
  const bashPath = (p: string) => spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout?.trim() || p;

  const bash = (script: string, home: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: bashPath(home), MSYS: 'winsymlinks:nativestrict', ...env },
    });
    return { status: r.status, out: (r.stdout || '').trim() };
  };

  it('__shelly_codex_runtime_tui prints the versioned path', () => {
    const t = makeRuntime();
    try {
      t.point(t.version('0.163.0-aaa'));
      const r = bash(`${helper}__shelly_codex_runtime_tui`, t.home);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/\.shelly-runtime\/codex\/versions\/0\.163\.0-aaa\/codex_tui$/);
    } finally {
      t.cleanup();
    }
  });

  it('__shelly_codex_runtime_tui fails on no runtime, an unhealthy one, or the opt-out', () => {
    const t = makeRuntime(['manifest.json', 'codex_tui']);
    try {
      expect(bash(`${helper}__shelly_codex_runtime_tui`, t.home).status).toBe(1);
      t.point(t.version('0.163.0-aaa'));
      expect(bash(`${helper}__shelly_codex_runtime_tui`, t.home).status).toBe(1);
      const u = makeRuntime();
      try {
        u.point(u.version('0.163.0-aaa'));
        const r = bash(`${helper}__shelly_codex_runtime_tui`, u.home, { SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME: '1' });
        expect(r.status).toBe(1);
        expect(r.out).toBe('');
      } finally {
        u.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });

  it('the shim resolves the same way', () => {
    const t = makeRuntime();
    try {
      t.point(t.version('0.163.0-aaa'));
      const r = bash(`SHELLY_LIB_DIR=/lib\n${shim}printf '%s %s' "$__runtime_ready" "$__runtime_tui"`, t.home);
      expect(r.out).toMatch(/^1 .*\/versions\/0\.163\.0-aaa\/codex_tui$/);
      const none = makeRuntime();
      try {
        expect(bash(`SHELLY_LIB_DIR=/lib\n${shim}printf '[%s]' "$__runtime_ready"`, none.home).out).toBe('[0]');
      } finally {
        none.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });

  it('a child bash has the helper: exported codex() still resolves the runtime', () => {
    const exportLine = homeKt.split(/\r?\n/).map((l) => l.match(/sb\.appendLine\("(export -f bash codex .*)"\)/)).find(Boolean)![1];
    expect(exportLine.split(' ')).toContain('__shelly_codex_runtime_tui');
    const t = makeRuntime();
    try {
      t.point(t.version('0.163.0-aaa'));
      // The real export line, with a codex() that calls the helper as the real one does.
      const parent = [
        helper,
        'command_not_found_handle() { echo "NOT-FOUND-STDOUT"; return 127; }',
        'export -f command_not_found_handle',
        'codex() { local __runtime_tui=""; if __runtime_tui="$(__shelly_codex_runtime_tui)"; then echo "runtime:$__runtime_tui"; else echo "bundled:$__runtime_tui"; fi; }',
        `${exportLine} 2>/dev/null`,
      ].join('\n');
      const viaC = bash(`${parent}\nbash -c 'codex'`, t.home);
      expect(viaC.out).toMatch(/^runtime:.*\/versions\/0\.163\.0-aaa\/codex_tui$/);
      const script = path.join(t.home, 'child.sh');
      fs.writeFileSync(script, 'codex\n');
      const viaScript = bash(`${parent}\nbash "$CHILD_SCRIPT"`, t.home, { CHILD_SCRIPT: bashPath(script) });
      expect(viaScript.out).toMatch(/^runtime:.*\/versions\/0\.163\.0-aaa\/codex_tui$/);
    } finally {
      t.cleanup();
    }
  });

  it('a crash of the versioned path still quarantines the runtime', () => {
    const t = makeRuntime();
    try {
      const v1 = t.version('0.163.0-aaa');
      t.point(v1);
      const script = `${helper}${quarantine}__shelly_codex_mark_tui_failed "$(__shelly_codex_runtime_tui)"`;
      const r = bash(script, t.home);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(v1, '.healthy'))).toBe(false);
      expect(fs.readdirSync(v1).some((n) => n.startsWith('.healthy.tui-failed.'))).toBe(true);
      expect(bash(`${helper}__shelly_codex_runtime_tui`, t.home).status).toBe(1);
    } finally {
      t.cleanup();
    }
  });
});

describe('HomeInitializer source', () => {
  it('bumped BASHRC_VERSION to 288', () => {
    expect(Number(homeKt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(288);
  });

  it('no launcher takes the symlink path any more', () => {
    expect(homeKt).not.toContain('.shelly-runtime/codex/current/codex_tui');
    expect(homeKt).not.toContain('__shelly_codex_runtime_ready');
  });

  it('both crash quarantines accept the versioned path', () => {
    expect(homeKt.split('*/.shelly-runtime/codex/versions/*)').length - 1).toBe(2);
  });
});
