/**
 * C4 (fact sheet §5, R7): launcher submissions are records next to the MCP
 * run tickets but never runs. Kotlin JVM tests don't run in CI, so the
 * properties that keep them out of every run reader are pinned here from
 * the sources.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const KT = path.join(ROOT, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const tickets = fs.readFileSync(path.join(KT, 'McpRunTickets.kt'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'scripts/shelly-mcp-server.js'), 'utf8');

describe('submission records stay out of the run readers', () => {
  it('run handles are mr_ and submission ids are ls_: no id is both', () => {
    expect(tickets).toContain('private val HANDLE_RE = Regex("^mr_[0-9a-f]{32}$")');
    expect(tickets).toContain('private val SUBMISSION_ID_RE = Regex("^ls_[0-9a-f]{32}$")');
  });

  it('every run reader in McpRunTickets filters by the run handle', () => {
    for (const fn of ['private fun ticketsOf', 'fun listForPrincipalJson', 'fun cancelLive', 'fun reconcileAfterRestart', 'fun readTicketJson']) {
      const i = tickets.indexOf(fn);
      expect({ fn, found: i >= 0 }).toEqual({ fn, found: true });
      const body = tickets.slice(i, tickets.indexOf('\n    }\n', i));
      expect({ fn, filters: /isValidHandle\(handle\)/.test(body) }).toEqual({ fn, filters: true });
    }
  });

  it('get_run_result (the MCP script) only accepts mr_ handles', () => {
    expect(script).toMatch(/RUN_HANDLE_RE = \/\^mr_\[0-9a-f\]\{32\}\$\//);
  });

  it('a pending submission expires on the approval window, not the 2-minute accepted→lost rule', () => {
    const expiry = tickets.slice(tickets.indexOf('fun applySubmissionExpiry'), tickets.indexOf('fun withUserDecision'));
    expect(expiry).toContain('LauncherIngressLimits.APPROVAL_WINDOW_MS');
    expect(expiry).not.toContain('ACCEPTED_STALE_MS');
  });

  it('the record never carries the instruction text; the text lives in no-backup app storage, not $HOME', () => {
    const keys = /private val SUBMISSION_KEYS = setOf\(([\s\S]*?)\)/.exec(tickets);
    expect(keys).not.toBeNull();
    expect(keys![1]).not.toMatch(/"text"|instruction/i);
    expect(tickets).toMatch(/File\(File\(context\.noBackupFilesDir, "launcher-ingress\/text"\), "\$id\.txt"\)/);
  });

  it('a tainted submission can only be approved by a person', () => {
    expect(tickets).toContain('!(s.untrusted && s.approvedVia != null && s.approvedVia != "user")');
  });
});
