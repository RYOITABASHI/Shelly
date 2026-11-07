/**
 * Google Antigravity CLI (BASHRC_VERSION 282; installer moved in 289): agy-install
 * hands off to scripts/shelly-cli-update.js (see shelly-cli-update.test.ts for the
 * checks), and agy runs the build through linker64 with the bionic exec wrapper
 * (like codex).
 */
import * as fs from 'fs';
import * as path from 'path';

const homeKt = fs.readFileSync(
  path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'),
  'utf8',
);

function fnBody(name: string): string {
  const lines = homeKt.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`sb.appendLine("${name}() {")`));
  const out: string[] = [];
  for (let i = start; i >= 0 && i < lines.length; i++) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/\\(.)/g, '$1'));
    if (m[1] === '}') break;
  }
  return out.join('\n');
}

describe('Antigravity CLI bashrc functions', () => {
  const run = fnBody('agy');

  it('hands off to the shared installer', () => {
    expect(homeKt).toContain('sb.appendLine("agy-install() { __shelly_cli_update agy install \\"\\$@\\"; }")');
  });

  it('agy runs the staged binary via linker64 with the exec wrapper and TUI paste mode', () => {
    expect(run).toContain('LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so" _run "$__bin" "$@"');
    expect(run).toMatch(/__shelly_paste_tui_begin\n[^]*\n {2}__shelly_paste_tui_end\n {2}return \$__rc\n\}$/);
    expect(run).toContain('Run: agy-install');
  });
});
