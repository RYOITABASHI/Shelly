/**
 * __tests__/optional-packs-bashrc-sync.test.ts
 *
 * The tool -> packId mapping for `shelly install <pack>` lives in TWO
 * places that can drift out of sync over time:
 *
 *   1. lib/optional-packs.ts's OPTIONAL_PACKS manifest (the canonical JS
 *      source of truth — CI publishes pack archives from exactly this list,
 *      see .github/workflows/build-android.yml's "Publish optional tool
 *      pack archives" step).
 *   2. HomeInitializer.kt's generated .bashrc content, where each bundled
 *      tool gets a bash wrapper function (jq/sqlite3/make/gh/vim/tmux/nano/
 *      less/rg/unzip/python3) that resolves bundled-vs-pack at call time via
 *      __shelly_tool_path(tool, packId) — see BASHRC_VERSION 241's
 *      changelog comment there for why this exists.
 *
 * HomeInitializer.kt cannot be compiled or run in this repo's JS toolchain
 * (no Android/NDK toolchain here) — matching this project's established
 * pattern (__tests__/plan-executor-parity.test.ts,
 * __tests__/agent-action-approval-bridge-hardening.test.ts), this is a
 * source-assertion test: it reads the real .kt file as plain text and
 * asserts the shape it depends on is present, byte-for-byte, rather than
 * simulating behavior. It exists to catch FUTURE drift (e.g. a new tool
 * added to a pack's `tools` array without a matching wrapper, or a wrapper
 * accidentally pointed at the wrong packId), not just to validate today's
 * state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { OPTIONAL_PACKS } from '@/lib/optional-packs';

const root = path.resolve(__dirname, '..');
const homeInitializerPath = path.join(
  root,
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);
const src = fs.readFileSync(homeInitializerPath, 'utf8');

/** Escape a tool/pack id for safe use inside a RegExp (defensive — current names are all plain alnum/hyphen). */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The literal Kotlin-source text of a real call site, built with plain
 * string concatenation (not regex-escaping gymnastics) so it's unambiguous
 * to read and verify: a bash command substitution `$(__shelly_tool_path
 * <tool> <packId>)` is written in HomeInitializer.kt's Kotlin string
 * literals as `\$(__shelly_tool_path <tool> <packId>)` (the backslash
 * escapes Kotlin's own `$`-templating, producing a literal `$` in the
 * generated bashrc). Anchoring on this exact prefix/suffix — rather than a
 * loose `__shelly_tool_path (\S+) (\S+)` regex — matters: an earlier draft
 * of this suite used the loose form and it false-matched plain English
 * comment prose ("...whether __shelly_tool_path above) instead of...").
 */
function callSite(tool: string, packId: string): string {
  return '\\$(__shelly_tool_path ' + tool + ' ' + packId + ')';
}

describe('optional-packs <-> HomeInitializer.kt bashrc wrapper sync', () => {
  const allPackTools = Object.values(OPTIONAL_PACKS).flatMap((pack) =>
    pack.tools.map((tool) => ({ tool, packId: pack.id })),
  );

  it('sanity: the manifest actually has tools to check (a broken import would silently pass an empty suite)', () => {
    expect(allPackTools.length).toBeGreaterThan(0);
  });

  it.each(allPackTools)(
    'HomeInitializer.kt defines a bash wrapper function for pack tool "$tool"',
    ({ tool }) => {
      // Matches both single-line (`sb.appendLine("jq() { ... }")`) and
      // multi-line (`sb.appendLine("python3() {")` followed by more
      // appendLine calls for the body) wrapper definitions — the shared
      // shape across every wrapper is the opening `sb.appendLine("<tool>() {`.
      const defPattern = new RegExp(`sb\\.appendLine\\("${reEscape(tool)}\\(\\) \\{`);
      expect(src).toMatch(defPattern);
    },
  );

  it.each(allPackTools)(
    'the "$tool" wrapper resolves via __shelly_tool_path against its OWN pack id "$packId", not a stale/wrong one',
    ({ tool, packId }) => {
      // Every pack-eligible wrapper calls __shelly_tool_path <tool> <packId>
      // (see the v241 rewrite) — this is the actual mapping that matters at
      // runtime; the function-definition check above only proves a wrapper
      // exists, not that it resolves against the right pack.
      expect(src).toContain(callSite(tool, packId));

      // Defensive cross-check: the same tool must not ALSO be wired to any
      // OTHER pack id (would indicate a copy-paste mistake during a future
      // edit — e.g. jq accidentally resolving against 'editor-tools').
      const otherPackIds = Object.keys(OPTIONAL_PACKS).filter((id) => id !== packId);
      for (const otherPackId of otherPackIds) {
        expect(src).not.toContain(callSite(tool, otherPackId));
      }
    },
  );

  it('every tool referenced by __shelly_tool_path in HomeInitializer.kt also exists in some OPTIONAL_PACKS entry (no orphaned/renamed pack tool)', () => {
    const knownTools = new Set(allPackTools.map((t) => t.tool));
    // Same anchored shape as callSite() above, but capturing the two
    // arguments instead of checking a specific pair.
    // Literal tool/pack names only (command_not_found_handle calls it with
    // "$1" "$__p", which is checked separately below).
    const calls = [...src.matchAll(/\\\$\(__shelly_tool_path ([A-Za-z0-9._-]+) ([a-z0-9-]+)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, tool, packId] of calls) {
      expect(knownTools.has(tool)).toBe(true);
      expect(OPTIONAL_PACKS[packId]).toBeDefined();
      expect(OPTIONAL_PACKS[packId].tools).toContain(tool);
    }
  });

  it('__shelly_tool_path and __shelly_pack_hint helpers are actually defined (not just referenced)', () => {
    expect(src).toContain('__shelly_tool_path() {');
    expect(src).toContain('__shelly_pack_hint() {');
    expect(src).toContain('export -f __shelly_tool_path __shelly_pack_hint');
  });

  it('the hint names the pack in the "<cmd> is available: shelly install <pack>" form', () => {
    expect(src).toContain("bash: %s: command not found\\\\n%s is available: shelly install %s\\\\n");
  });

  it('command_not_found_handle exists, is exported, and its case lists match the manifest exactly', () => {
    expect(src).toContain('sb.appendLine("command_not_found_handle() {")');
    expect(src).toContain('sb.appendLine("export -f command_not_found_handle")');
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      expect(src).toContain(`sb.appendLine("    ${pack.tools.join('|')}) __p=${pack.id} ;;")`);
    }
  });

  it('command_not_found_handle runs an existing (pack-installed) tool via _run instead of reporting not-found', () => {
    const start = src.indexOf('sb.appendLine("command_not_found_handle() {")');
    const end = src.indexOf('sb.appendLine("export -f command_not_found_handle")');
    const body = src.slice(start, end);
    expect(body).toContain('__t=\\$(__shelly_tool_path \\"\\$1\\" \\"\\$__p\\")');
    expect(body).toContain('*) _run \\"\\$__t\\" \\"\\$@\\" ;;');
    expect(body).toContain('LD_PRELOAD=\\"\\$SHELLY_LIB_DIR/libexec_wrapper.so\\" _run');
    expect(body).toContain('PYTHONHOME=\\"\\$__h\\"');
    // bash's own not-found format, plus the hint only for pack tools.
    expect(body).toContain("'%s: line %s: %s: command not found\\\\n' \\\"\\$0\\\" \\\"\\${BASH_LINENO[0]}\\\"");
    expect(body).toContain("[ -n \\\"\\$__p\\\" ] && printf '%s is available: shelly install %s\\\\n'");
  });

  it('the shelly helper shim pack list (install --list / uninstall) mirrors the manifest exactly', () => {
    const m = src.match(/sb\.appendLine\("const OPTIONAL_PACKS = (\{.*\});"\)/);
    expect(m).not.toBeNull();
    // The literal is plain JS object syntax with single quotes.
    // eslint-disable-next-line no-new-func
    const shimPacks = new Function(`return ${m![1]};`)() as Record<string, string[]>;
    const manifest = Object.fromEntries(Object.values(OPTIONAL_PACKS).map((p) => [p.id, p.tools]));
    expect(shimPacks).toEqual(manifest);
  });
});
