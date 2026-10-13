/**
 * __tests__/bashrc-ld-preload-interactive-unset.test.ts
 *
 * BASHRC_VERSION 251 (build 2525 follow-up). The generated ~/.bashrc used to
 * `unset LD_PRELOAD` unconditionally (v180: the interactive PTY shell must
 * never export libexec_wrapper.so). Codex spawns its tool/user shell as a
 * LOGIN shell (`bash -lc`), which reads ~/.profile -> ~/.bashrc, so the
 * LD_PRELOAD the wrapper-loaded Codex process exec'd it with was stripped from
 * the env every child was exec'd with -> `env python3`, `timeout 5 node`,
 * nested `bash script.sh` all hit the Knox app-data exec denial.
 *
 * The unset is now interactive-only. This suite extracts that exact line from
 * HomeInitializer.kt and runs it under a non-interactive `bash -c` (LD_PRELOAD
 * must survive) and an interactive `bash -i` (LD_PRELOAD must be gone).
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

/** Every generated .bashrc line mentioning LD_PRELOAD. */
function generatedLdPreloadLines(): string[] {
  const out: string[] = [];
  for (const line of ktSrc.split(/\r?\n/)) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    const text = unescapeKotlin(m[1]);
    if (/\bunset\b.*LD_PRELOAD/.test(text)) out.push(text);
  }
  return out;
}

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const describeBash = hasBash ? describe : describe.skip;

describe('BASHRC_VERSION', () => {
  it('is bumped to >= 251', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(251);
  });
});

describe('~/.bashrc LD_PRELOAD unset is interactive-only', () => {
  const lines = generatedLdPreloadLines();

  it('generates exactly one unset, guarded by $- containing i', () => {
    expect(lines).toEqual(['case "$-" in *i*) unset LD_PRELOAD ;; esac']);
    // the unconditional form must not come back
    expect(ktSrc).not.toMatch(/sb\.appendLine\("unset LD_PRELOAD"\)/);
  });

  describeBash('behaviour (real bash)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-ldpreload-'));
    const rc = path.join(dir, 'rc');
    // The host loader (glibc / cygwin / msys) honours a real LD_PRELOAD and
    // would try to load the fake path, so the behavioural run uses a renamed
    // variable; the structural test above pins the real generated line.
    const line = lines[0].replace(/LD_PRELOAD/g, 'SHELLY_TEST_PRELOAD');
    fs.writeFileSync(rc, `${line}\necho "LD_PRELOAD=\${SHELLY_TEST_PRELOAD:-<unset>}"\n`);
    const env = { ...process.env, SHELLY_TEST_PRELOAD: '/x/libexec_wrapper.so' } as NodeJS.ProcessEnv;

    it('non-interactive `bash -c` (Codex `bash -lc` shape) keeps the inherited LD_PRELOAD', () => {
      const r = spawnSync('bash', ['-c', `. "${rc.replace(/\\/g, '/')}"`], { encoding: 'utf8', env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('LD_PRELOAD=/x/libexec_wrapper.so');
    });

    it('interactive `bash -i` (PTY shell shape) drops it', () => {
      const r = spawnSync('bash', ['-i', '-c', `. "${rc.replace(/\\/g, '/')}"`], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(r.stdout).toContain('LD_PRELOAD=<unset>');
    });
  });
});

describe('legacy agent script launch keeps running un-wrapped', () => {
  it('AgentRuntime unsets LD_PRELOAD right after sourcing .bashrc', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'),
      'utf8',
    );
    expect(src).toMatch(/\.bashrc\\" \|\| true; \}"\)\s*(\/\/[^\n]*\n\s*)*append\(" && unset LD_PRELOAD"\)/);
  });
});
