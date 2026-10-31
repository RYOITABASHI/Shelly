/**
 * Front agent (窓口, BASHRC_VERSION 284): settings.frontAgent picks which
 * agent CLI's INTERACTIVE TUI starts in the first terminal tab at app start.
 *
 * ToS guard: Google says third-party agents must not invoke `agy`
 * programmatically. Shelly only starts the interactive TUI in a terminal the
 * user sees; it never runs `agy -p` / `agy --print`, never routes AI-pane
 * chat to agy, never calls agy from schedules / agents.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_FRONT_AGENT,
  __resetFrontAgentLaunchForTests,
  claimFrontAgentLaunch,
  frontAgentEnvValue,
  normalizeFrontAgent,
  settleFrontAgentLaunch,
} from '../lib/front-agent';

const ROOT = path.join(__dirname, '..');
const KT_DIR = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const homeKt = read(`${KT_DIR}/HomeInitializer.kt`);

/** The generated bash lines (sb.appendLine("...") bodies, unescaped). */
function bashLines(): string[] {
  const out: string[] = [];
  for (const line of homeKt.split(/\r?\n/)) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(line);
    if (m) out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

describe('front agent setting', () => {
  it('defaults to none (current behaviour: plain bash)', () => {
    expect(DEFAULT_FRONT_AGENT).toBe('none');
    expect(read('store/settings-store.ts')).toMatch(/frontAgent: DEFAULT_FRONT_AGENT,/);
  });

  it('normalizes unknown persisted values to none, and loadSettings applies that', () => {
    expect(normalizeFrontAgent(undefined)).toBe('none');
    expect(normalizeFrontAgent('gemini')).toBe('none');
    expect(normalizeFrontAgent('antigravity')).toBe('antigravity');
    expect(normalizeFrontAgent('claude')).toBe('claude');
    const store = read('store/settings-store.ts');
    expect(store).toMatch(/settings\.frontAgent = normalizeFrontAgent\(settings\.frontAgent\);\r?\n\s*shouldPersist = true;/);
  });

  it('persists through updateSettings like every other non-secret setting', () => {
    // updateSettings writes the whole stripApiKeys(updated) blob to
    // AsyncStorage 'shelly_settings'; frontAgent is a plain AppSettings key.
    const store = read('store/settings-store.ts');
    expect(store).toContain("AsyncStorage.setItem('shelly_settings', JSON.stringify(forStorage))");
    expect(read('store/types.ts')).toMatch(/frontAgent\?: 'none' \| 'antigravity' \| 'claude';/);
  });

  it('maps settings to the native env value', () => {
    expect(frontAgentEnvValue('none')).toBeNull();
    expect(frontAgentEnvValue('antigravity')).toBe('agy');
    expect(frontAgentEnvValue('claude')).toBe('claude');
    expect(frontAgentEnvValue('agy')).toBeNull();
  });
});

describe('front agent launch slot (once per app start, primary tab only)', () => {
  beforeEach(() => __resetFrontAgentLaunchForTests());

  it('only the primary session can claim it', () => {
    expect(claimFrontAgentLaunch({ sessionId: 's2', primarySessionId: 's1', setting: 'antigravity' })).toBeNull();
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'antigravity' })).toBe('agy');
  });

  it('launches at most once, even for a later tab or the same tab', () => {
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'claude' })).toBe('claude');
    settleFrontAgentLaunch('s1', true);
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'claude' })).toBeNull();
    expect(claimFrontAgentLaunch({ sessionId: 's3', primarySessionId: 's3', setting: 'claude' })).toBeNull();
  });

  it("'none' at start still uses up the slot (changing the setting later does not launch in a new tab)", () => {
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'none' })).toBeNull();
    settleFrontAgentLaunch('s1', true);
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'antigravity' })).toBeNull();
  });

  it('a failed native create lets the retry of the same primary tab claim again', () => {
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'antigravity' })).toBe('agy');
    settleFrontAgentLaunch('s1', false);
    expect(claimFrontAgentLaunch({ sessionId: 's1', primarySessionId: 's1', setting: 'antigravity' })).toBe('agy');
  });
});

describe('native plumbing', () => {
  it('createSession allowlists the value and only passes it on a fresh fork', () => {
    const mod = read(`${KT_DIR}/TerminalEmulatorModule.kt`);
    expect(mod).toContain('(config["frontAgent"] as? String)?.takeIf { it == "agy" || it == "claude" }');
    // The resumed-session early return comes before the front agent is read.
    expect(mod.indexOf('"resumed" to true')).toBeLessThan(mod.indexOf('config["frontAgent"]'));
  });

  it('shelly-pty.c exports SHELLY_FRONT_AGENT only for agy / claude', () => {
    const c = read('modules/terminal-emulator/android/src/main/jni/shelly-pty.c');
    expect(c).toMatch(/strcmp\(frontAgent, "agy"\) == 0 \|\| strcmp\(frontAgent, "claude"\) == 0\)\) \{\r?\n\s*setenv\("SHELLY_FRONT_AGENT", frontAgent, 1\);/);
    // setenv must come after clearenv() so it survives.
    expect(c.indexOf('clearenv();')).toBeLessThan(c.indexOf('setenv("SHELLY_FRONT_AGENT"'));
  });
});

describe('front agent .bashrc snippet (v284)', () => {
  const lines = bashLines();
  const all = lines.join('\n');

  it('bumped BASHRC_VERSION to 284 (283 is reserved for S4)', () => {
    expect(homeKt).toMatch(/private const val BASHRC_VERSION = 284\b/);
  });

  it('captures the value only in an interactive shell and unsets the env var at the top', () => {
    const capture = lines.indexOf('case "$-" in *i*) __shelly_front_agent="${SHELLY_FRONT_AGENT:-}" ;; esac');
    const unsetEnv = lines.indexOf('unset SHELLY_FRONT_AGENT');
    expect(capture).toBeGreaterThan(0);
    expect(unsetEnv).toBe(capture + 1);
    // Before any function definition (i.e. before anything can be spawned).
    expect(unsetEnv).toBeLessThan(lines.findIndex((l) => l.startsWith('agy() {')));
    expect(unsetEnv).toBeLessThan(lines.findIndex((l) => l.startsWith('__shelly_toybox() {')));
    // Never exported.
    expect(all).not.toMatch(/export __shelly_front_agent/);
  });

  const start = lines.indexOf('if [ -n "${__shelly_front_agent:-}" ]; then');
  // The block ends at the unconditional `unset` right after its closing `fi`.
  const end = lines.findIndex((l, i) => i > start && l === 'fi' && lines[i + 1] === 'unset __shelly_front_agent');
  const block = lines.slice(start, end + 2);
  const launch = block.join('\n');

  it('launch block is the very last thing in .bashrc (after PROMPT_COMMAND / MOTD)', () => {
    expect(start).toBeGreaterThan(lines.indexOf('PROMPT_COMMAND=__shelly_prompt_command'));
    expect(start).toBeGreaterThan(lines.indexOf('  touch "$HOME/.shelly_motd_shown"'));
    expect(end).toBeGreaterThan(start);
    expect(homeKt).toMatch(/sb\.appendLine\("unset __shelly_front_agent"\)\r?\n\r?\n\s*bashrc\.writeText\(sb\.toString\(\)\)/);
    expect(block.length).toBeGreaterThan(5);
  });

  it('clears the shell variable before running the CLI (no re-launch on re-source)', () => {
    const agyCase = launch.indexOf('    agy)');
    expect(launch.indexOf('unset __shelly_front_agent', agyCase)).toBeLessThan(launch.indexOf('then agy', agyCase));
    const claudeCase = launch.indexOf('    claude)');
    expect(launch.indexOf('unset __shelly_front_agent', claudeCase)).toBeLessThan(launch.indexOf('then claude', claudeCase));
  });

  it('checks the installed binary and function, else prints a one-line hint and stays in bash', () => {
    expect(launch).toContain('if [ -f "$HOME/.shelly-runtime/agy/antigravity" ] && declare -F agy >/dev/null; then agy\n');
    expect(launch).toMatch(/else printf '[^\n]*Antigravity is not installed\. Run: agy-install[^\n]*' >&2; fi ;;/);
    expect(launch).toContain('if [ -e "$HOME/.shelly-runtime/claude-glibc/claude" ] && declare -F claude >/dev/null; then claude\n');
    expect(launch).toMatch(/else printf '[^\n]*Claude Code is not installed[^\n]*' >&2; fi ;;/);
    // Never `exec`: when the CLI exits the user lands in this tab's bash.
    expect(launch).not.toMatch(/\bexec\b/);
  });

  it('runs the interactive TUI with no arguments', () => {
    expect(launch).toMatch(/then agy\n/);
    expect(launch).toMatch(/then claude\n/);
  });
});

describe('ToS guard: Shelly never invokes agy non-interactively', () => {
  // Scan every source file Shelly ships (TS/JS/Kotlin/Java/C/shell). The only
  // place agy is wired up is the bashrc agy() function, which forwards the
  // user's own typed "$@" and has no literal print flag.
  const SCAN_DIRS = ['app', 'components', 'hooks', 'lib', 'store', 'scripts', 'modules', 'plugins', 'android'];
  const EXT = /\.(ts|tsx|js|mjs|cjs|kt|java|c|h|sh)$/;
  const SKIP_DIR = /(^|[\\/])(node_modules|build|\.gradle|\.cxx|assets|jniLibs)([\\/]|$)/;

  function walk(rel: string, out: string[]): void {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || SKIP_DIR.test(rel)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(rel, ent.name);
      if (ent.isDirectory()) walk(child, out);
      else if (EXT.test(ent.name)) out.push(child);
    }
  }
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(d, files);

  // `agy`/`antigravity` followed on the same line by -p / --print / --prompt.
  const PRINT_INVOCATION = /\b(agy|antigravity)\b[^\n]*?\s(-p|--print|--prompt)\b/;

  it('scans a real file set', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('HomeInitializer.kt'))).toBe(true);
  });

  it('no `agy -p` / `agy --print` invocation exists anywhere', () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        // Comments that document the constraint itself are fine.
        if (/^\s*(\/\/|\/?\*|#)/.test(line)) return;
        if (PRINT_INVOCATION.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the bashrc agy() function only forwards the user-typed arguments', () => {
    const fn = bashLines();
    const s = fn.findIndex((l) => l === 'agy() {');
    const body = fn.slice(s, fn.indexOf('}', s) + 1).join('\n');
    expect(body).toContain('_run "$__bin" "$@"');
    expect(body).not.toMatch(/\s(-p|--print)\b/);
  });

  it('AI pane dispatch, agent executor and plan executor never reference agy', () => {
    for (const rel of [
      'hooks/use-ai-pane-dispatch.ts',
      'lib/agent-executor.ts',
      'lib/agent-manager.ts',
      'scripts/shelly-plan-executor.js',
    ]) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      expect(read(rel)).not.toMatch(/\bagy\b|antigravity/i);
    }
  });
});
