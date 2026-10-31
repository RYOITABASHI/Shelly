/**
 * Google Antigravity CLI (BASHRC_VERSION 282; current 283): agy-install stages Google's
 * official Android build after a SHA-512 check, and agy runs it through
 * linker64 with the bionic exec wrapper (like codex).
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
  const install = fnBody('agy-install');
  const run = fnBody('agy');

  it('reads the official Android manifest and only accepts Google storage URLs', () => {
    expect(install).toContain('/manifests/android_arm64.json');
    expect(install).toContain('https://storage.googleapis.com/antigravity-public/*) ;;');
  });

  it('verifies the published SHA-512 before anything is installed', () => {
    expect(install).toMatch(/\[ \$\{#__sha\} -eq 128 \]/);
    const verify = install.indexOf('sha512sum -c -');
    const move = install.indexOf('mv -f "$__stage/antigravity" "$__dir/antigravity"');
    expect(verify).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(verify);
  });

  it('never runs the vendor install step (it edits shell config)', () => {
    expect(install).not.toMatch(/antigravity"? install/);
  });

  it('agy runs the staged binary via linker64 with the exec wrapper and TUI paste mode', () => {
    expect(run).toContain('LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so" _run "$__bin" "$@"');
    expect(run).toMatch(/__shelly_paste_tui_begin\n[^]*\n {2}__shelly_paste_tui_end\n {2}return \$__rc\n\}$/);
    expect(run).toContain('Run: agy-install');
  });
});
