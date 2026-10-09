/**
 * __tests__/bashrc-non-bash-guard.test.ts
 *
 * BASHRC_VERSION 250. Codex (0.156.1) runs commands with the passwd shell,
 * which on Android is /bin/sh (mksh), as a login shell (`!` user-shell commands
 * are always login). mksh reads ~/.profile, which used to source ~/.bashrc
 * unconditionally, and then failed on bash-only syntax
 * (`.bashrc[640]: export: -f: unknown option`).
 *
 * Asserts, against the real HomeInitializer.kt source:
 *  - the generated ~/.bashrc starts with a BASH_VERSION guard that makes any
 *    non-bash shell return/exit 0 silently, sourced or executed;
 *  - the generated ~/.profile only sources ~/.bashrc under bash;
 *  - the legacy ~/.profile is migrated, user-edited ones are left alone.
 * `dash` stands in for mksh (both POSIX shells without BASH_VERSION).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ktPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);
const ktSrc = fs.readFileSync(ktPath, 'utf8');

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    out += ch;
  }
  return out;
}

/** First `sb.appendLine("...")` emitted after `val sb = StringBuilder()` in the .bashrc builder. */
function firstBashrcLine(): string {
  const lines = ktSrc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('val sb = StringBuilder()'));
  expect(start).toBeGreaterThan(0);
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (m) return unescapeKotlin(m[1]);
  }
  throw new Error('no appendLine after StringBuilder');
}

function shellyProfile(): string {
  const m = ktSrc.match(/internal const val SHELLY_PROFILE =\s*\n\s*"(.*)" \+\s*\n\s*"(.*)"\s*\n/);
  if (!m) throw new Error('SHELLY_PROFILE not found');
  return unescapeKotlin(m[1]) + unescapeKotlin(m[2]);
}

const has = (sh: string) => spawnSync(sh, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const hasBash = has('bash');
const hasDash = has('dash');

function run(shell: string, script: string, cwd: string, home?: string) {
  const env = { ...process.env, ...(home ? { HOME: home } : {}) } as NodeJS.ProcessEnv;
  delete env.BASH_VERSION;
  return spawnSync(shell, ['-c', script], { encoding: 'utf8', cwd, env });
}

// Body that mksh/dash cannot parse or run: everything here must be skipped.
const BASH_ONLY_BODY = [
  'foo() { :; }',
  'export -f foo',
  'arr=(1 2 3)',
  'while read -r x; do :; done < <(echo hi)',
  'echo REACHED_BASH_BODY',
].join('\n');

describe('BASHRC_VERSION', () => {
  it('is bumped to >= 250', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(250);
  });
});

describe('~/.bashrc non-bash guard', () => {
  const guard = firstBashrcLine();

  it('is the very first generated line', () => {
    expect(guard).toBe('[ -n "${BASH_VERSION:-}" ] || return 0 2>/dev/null || exit 0');
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-guard-'));
  fs.writeFileSync(path.join(dir, 'bashrc'), `${guard}\n${BASH_ONLY_BODY}\n`);

  (hasDash ? it : it.skip)('dash: sourcing returns 0 silently and the caller continues', () => {
    const r = run('dash', '. ./bashrc; echo "rc=$?"; echo AFTER', dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toContain('REACHED_BASH_BODY');
    expect(r.stdout).toContain('rc=0');
    expect(r.stdout).toContain('AFTER');
    expect(r.status).toBe(0);
  });

  (hasDash ? it : it.skip)('dash: executing the file exits 0 silently', () => {
    const r = spawnSync('dash', ['bashrc'], { encoding: 'utf8', cwd: dir });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  (hasBash ? it : it.skip)('bash: runs the full file', () => {
    const r = run('bash', '. ./bashrc', dir);
    expect(r.stdout).toContain('REACHED_BASH_BODY');
  });
});

describe('~/.profile sources ~/.bashrc only under bash', () => {
  const profile = shellyProfile();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-profile-'));
  fs.writeFileSync(path.join(home, '.profile'), profile);
  fs.writeFileSync(path.join(home, '.bashrc'), 'echo SOURCED_BASHRC\n');

  it('replaces the legacy unconditional profile and keeps user edits', () => {
    expect(profile).toContain('BASH_VERSION');
    expect(ktSrc).toContain('val legacyProfile = "[ -f ~/.bashrc ] && . ~/.bashrc\\n"');
    expect(ktSrc).toMatch(/!profile\.exists\(\) \|\| profile\.readText\(\) == legacyProfile/);
  });

  (hasDash ? it : it.skip)('dash (mksh stand-in) does not source ~/.bashrc', () => {
    const r = run('dash', '. "$HOME/.profile"; echo "rc=$?"', home, posixPath(home));
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toContain('SOURCED_BASHRC');
    expect(r.stdout).toContain('rc=0');
  });

  (hasBash ? it : it.skip)('bash still sources ~/.bashrc', () => {
    const r = run('bash', '. "$HOME/.profile"', home, posixPath(home));
    expect(r.stdout).toContain('SOURCED_BASHRC');
  });
});

function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
