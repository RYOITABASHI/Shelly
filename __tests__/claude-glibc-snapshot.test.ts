/**
 * BASHRC_VERSION 285: Claude Code's Bash tool executed nothing on device
 * (build 2806, Claude Code 2.1.314). Claude captures its shell snapshot with
 * CLAUDE_CODE_SHELL, which is mksh for the glibc claude, so the snapshot
 * recorded mksh's `set -o` table as enabled options (`set -o noexec` ...).
 * Every tool command sources the snapshot first, so nothing ran.
 * The fix: shelly-claude-glibc() deletes poisoned snapshots before claude
 * starts and neutralizes new ones while claude runs; HomeInitializer deletes
 * them on every start.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const homeKt = fs.readFileSync(
  path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'),
  'utf8',
);

/** Shell text of the appendLine run that starts with `header`. */
function emitted(header: string): string {
  const lines = homeKt.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`sb.appendLine("${header}")`));
  expect(start).toBeGreaterThan(-1);
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/\$libDir/g, '/libdir').replace(/\\(.)/g, '$1'));
    if (m[1] === '}') break;
  }
  return out.join('\n');
}

const scrubFn = emitted('__shelly_claude_snapshot_scrub() {');
const glibcFn = emitted('shelly-claude-glibc() {');

// A trimmed copy of the snapshot Claude wrote under mksh on device.
const POISONED = [
  '# Snapshot file',
  'unalias -a 2>/dev/null || true',
  'set -o Current',
  'set -o braceexpand',
  'set -o emacs',
  'set -o inherit-xtrace',
  'set -o login',
  'set -o noexec',
  'alias hash=\'\\builtin alias -t\'',
  'export PATH=/usr/bin:/bin',
  '',
].join('\n');
const BASH_SNAPSHOT = ['# Snapshot file', 'set -o braceexpand', 'set -o hashall', 'shopt -s expand_aliases', 'export PATH=/usr/bin:/bin', ''].join('\n');

function hasBash(): boolean {
  const r = childProcess.spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return !r.error && r.stdout.trim() === 'ok';
}

function sh(script: string, args: string[] = []) {
  return childProcess.spawnSync('bash', ['-c', script, 'test', ...args], { encoding: 'utf8' });
}

const posix = (p: string) => p.replace(/\\/g, '/');

describe('Claude shell snapshot scrub (BASHRC_VERSION 285)', () => {
  it('bumped BASHRC_VERSION to 285', () => {
    expect(Number(homeKt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(285);
  });

  it('shelly-claude-glibc() deletes poisoned snapshots, then scrubs for the claude lifetime', () => {
    expect(homeKt).toMatch(/appendClaudeSnapshotScrubFunction\(sb\)\r?\n\s*sb\.appendLine\("shelly-claude-glibc\(\) \{"\)/);
    expect(glibcFn).toContain('__snapd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/shell-snapshots"');
    expect(glibcFn).toContain('__shelly_claude_snapshot_scrub "$__snapd" delete');
    expect(glibcFn).toContain('__shelly_claude_snapshot_scrub "$__snapd" neutralize');
    expect(glibcFn).toContain('while kill -0 "$__me" 2>/dev/null; do');
    expect(glibcFn).toContain('[ -n "${__scrub_pid:-}" ] && kill "$__scrub_pid" 2>/dev/null');
    // the scrubber starts before claude is launched
    expect(glibcFn.indexOf('__scrub_pid=$!')).toBeLessThan(glibcFn.indexOf('"$SHELLY_LIB_DIR/shelly_glibc_exec"'));
    // the env-file sanitization from 5f7216503 is untouched
    expect(glibcFn).toContain('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN NODE_OPTIONS BASH_ENV ENV CDPATH PROMPT_COMMAND');
  });

  it('the runner shares the same function (one definition, emitted twice)', () => {
    expect(homeKt.split('sb.appendLine("__shelly_claude_snapshot_scrub() {")').length - 1).toBe(1);
    expect(homeKt.split('appendClaudeSnapshotScrubFunction(sb)').length - 1).toBe(1);
    expect(homeKt.split('appendClaudeGlibcFunction(sb, libDir)').length - 1).toBe(2);
  });

  it('HomeInitializer deletes poisoned snapshots on every start', () => {
    expect(homeKt).toContain('removePoisonedClaudeSnapshots(File(home, ".claude/shell-snapshots"))');
    expect(homeKt).toContain('private val CLAUDE_POISONED_SNAPSHOT_MARKERS = listOf("set -o noexec", "set -o Current", "set -o inherit-xtrace")');
  });

  it('generated scrub + glibc function are valid bash', () => {
    if (!hasBash()) return;
    const r = childProcess.spawnSync('bash', ['-n'], { input: `${scrubFn}\n${glibcFn}\n`, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  describe('behavior (real bash)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-snap-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('root cause: sourcing the mksh-generated snapshot stops bash from executing', () => {
      if (!hasBash()) return;
      const snap = path.join(dir, 'snapshot-bash-1-a.sh');
      fs.writeFileSync(snap, POISONED);
      const r = sh('source "$1" 2>/dev/null || true; echo U-ok', [posix(snap)]);
      expect(r.stdout).not.toContain('U-ok');
    });

    it('delete mode removes files containing set -o noexec and keeps bash snapshots', () => {
      if (!hasBash()) return;
      const bad = path.join(dir, 'snapshot-bash-1-a.sh');
      const bad2 = path.join(dir, 'snapshot-bash-2-b.sh');
      const good = path.join(dir, 'snapshot-bash-3-c.sh');
      const other = path.join(dir, 'notes.sh');
      fs.writeFileSync(bad, POISONED);
      fs.writeFileSync(bad2, 'set -o noexec\n');
      fs.writeFileSync(good, BASH_SNAPSHOT);
      fs.writeFileSync(other, 'set -o noexec\n');
      const r = sh(`${scrubFn}\n__shelly_claude_snapshot_scrub "$1" delete; echo rc=$?`, [posix(dir)]);
      expect(r.stdout.trim()).toBe('rc=0');
      expect(fs.existsSync(bad)).toBe(false);
      expect(fs.existsSync(bad2)).toBe(false);
      expect(fs.readFileSync(good, 'utf8')).toBe(BASH_SNAPSHOT);
      expect(fs.existsSync(other)).toBe(true); // only snapshot-*.sh is touched
    });

    it('neutralize mode keeps the path (claude keeps sourcing it) and commands run again', () => {
      if (!hasBash()) return;
      const bad = path.join(dir, 'snapshot-bash-1-a.sh');
      const good = path.join(dir, 'snapshot-bash-3-c.sh');
      fs.writeFileSync(bad, POISONED);
      fs.writeFileSync(good, BASH_SNAPSHOT);
      sh(`${scrubFn}\n__shelly_claude_snapshot_scrub "$1"`, [posix(dir)]);
      const body = fs.readFileSync(bad, 'utf8');
      expect(body.startsWith('# Shelly:')).toBe(true);
      expect(body).not.toContain('set -o');
      expect(fs.readFileSync(good, 'utf8')).toBe(BASH_SNAPSHOT);
      expect(fs.readdirSync(dir).sort()).toEqual(['snapshot-bash-1-a.sh', 'snapshot-bash-3-c.sh']);
      // the same command shape Claude runs per Bash-tool call
      const r = sh('source "$1" 2>/dev/null || true && eval \'echo U-ok\'', [posix(bad)]);
      expect(r.stdout.trim()).toBe('U-ok');
      // idempotent: a neutralized file is left alone
      const before = fs.statSync(bad).mtimeMs;
      sh(`${scrubFn}\n__shelly_claude_snapshot_scrub "$1"`, [posix(dir)]);
      expect(fs.readFileSync(bad, 'utf8')).toBe(body);
      expect(fs.statSync(bad).mtimeMs).toBe(before);
    });

    it('a missing directory is a no-op', () => {
      if (!hasBash()) return;
      const r = sh(`${scrubFn}\n__shelly_claude_snapshot_scrub "$1" delete; echo rc=$?`, [posix(path.join(dir, 'nope'))]);
      expect(r.stdout.trim()).toBe('rc=0');
    });
  });
});
