/**
 * Regression test for a real on-device crash found 2026-07-27: running the
 * bare `shelly-doctor` terminal command (human-readable mode, no `--json`)
 * threw `TypeError: Cannot read properties of undefined (reading 'version')`
 * at printHuman()'s "codex exec" line. codexReport() had been refactored to
 * fold the "codex exec --help" check into `tui.execHelp` (codex_tui handles
 * both the TUI and `exec` subcommand from one binary), but printHuman() was
 * never updated and kept reading the old `data.codex.exec.version` shape,
 * which no longer exists. The `--json` path (used by the Settings > Doctor
 * UI button) was unaffected — it just JSON.stringifies the data object
 * directly, never touching printHuman() — so this crash was reachable only
 * from the bare terminal command referenced in the codex-login confirm hint
 * ("Run `shelly doctor` afterwards to confirm").
 *
 * This is a plain standalone Node script (not a TS template-literal
 * generator like lib/agent-executor.ts), so the most direct regression
 * coverage is running the REAL file with a real node child process — the
 * same "don't hand-copy, execute the actual artifact" principle used
 * throughout this test suite (see agent-quality-gate-shell-emit.test.ts).
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const SCRIPT_PATH = path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-doctor.js');

describe('shelly-doctor.js — real script execution (2026-07-27 crash regression)', () => {
  it('human-readable mode (bare `shelly-doctor`, no --json) runs to completion without throwing', () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
    expect(output).toContain('Shelly doctor');
    expect(output).toContain('codex exec:');
    expect(output).not.toContain('TypeError');
    expect(output).not.toContain('at printHuman');
  });

  it('--json mode runs to completion and produces parseable JSON with a codex.tui.execHelp field', () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, '--json'], { encoding: 'utf8' });
    const data = JSON.parse(output);
    expect(data.codex).toBeDefined();
    expect(data.codex.tui).toBeDefined();
    expect(data.codex.tui.execHelp).toBeDefined();
    expect(typeof data.codex.tui.execHelp.ok).toBe('boolean');
    // The stale field this bug referenced must not silently reappear.
    expect(data.codex.exec).toBeUndefined();
  });
});
