jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { fireReviewedAgentBrowserPaneAction, resolveTargetBrowserPaneId } from '@/lib/agent-browser-pane-review';
import { Agent } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'browserpane-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const agent = (action: Agent['action']): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action,
});

// browser-pane: the .sh executor support for the new agent action type that
// drives a LIVE, on-screen Browser Pane WebView (lib/browser-pane-automation.ts).
// The actual side effect (injecting the click/fill/extractText script into the
// resolved WebView) happens in RN (fireReviewedAgentBrowserPaneAction) at the
// moment the human taps Allow -- BEFORE the accept reply is written, mirroring
// intent/dm-reply/app-act's "fire-then-reply" invariant. Unlike app-act, there
// is NO Tier-B unattended-allow for this type at all -- see the hard-refusal
// test below, which asserts the refusal fires unconditionally (no autonomous/
// trusted carve-out).
describe('generateRunScript — browser-pane action', () => {
  const s = generateRunScript(agent({
    type: 'browser-pane',
    browserPaneAction: { kind: 'click', selector: '#submit' },
    browserPaneUrlAllowlist: ['https://example.com/form'],
  }));

  it('threads ACTION_TYPE and the browser-pane variables through, correctly quoted', () => {
    expect(s).toContain("ACTION_TYPE='browser-pane'");
    expect(s).toContain("ACTION_BROWSER_PANE_KIND='click'");
    expect(s).toContain("ACTION_BROWSER_PANE_SELECTOR='#submit'");
    expect(s).toContain("ACTION_BROWSER_PANE_VALUE=''");
    expect(s).toContain('ACTION_BROWSER_PANE_URL_ALLOWLIST=');
    expect(s).toContain('https://example.com/form');
  });

  it('rejects autonomous/unattended execution before requesting attended Review approval, with NO Tier-B exception', () => {
    const browserPaneCase = s.slice(s.indexOf('\n    browser-pane)'), s.indexOf('\n    *)', s.indexOf('\n    browser-pane)')));
    expect(browserPaneCase).toContain('[ "${AGENT_AUTONOMOUS:-0}" = "1" ]');
    expect(browserPaneCase).toContain('[ "${SHELLY_RUN_UNATTENDED:-0}" = "1" ]');
    expect(browserPaneCase).toContain('Browser actions require an attended Review with a visible Browser Pane.');
    expect(browserPaneCase).toContain('request_and_wait_approval "browser-pane" "$preview" "$result_file" || return 1');
    expect(browserPaneCase.indexOf('AGENT_AUTONOMOUS')).toBeLessThan(browserPaneCase.indexOf('request_and_wait_approval'));
    // No broker/native dispatch call after approval — the side effect already
    // happens natively in RN before the accept reply is written.
    expect(browserPaneCase).not.toContain('cap_workspace_exec');
    expect(browserPaneCase).not.toContain('http_post_json');
    // Unlike app-act, there is no autoFireTrusted-style flag consulted here —
    // the hard refusal above has no exception clause at all.
    expect(browserPaneCase).not.toContain('ACTION_APP_ACT_AUTO_FIRE_TRUSTED');
  });

  it('an agent flagged autonomous is STILL refused unattended (no Tier-B carve-out, unlike app-act)', () => {
    const trusted = generateRunScript({
      ...agent({
        type: 'browser-pane',
        browserPaneAction: { kind: 'click', selector: '#submit' },
        browserPaneUrlAllowlist: ['https://example.com/form'],
      }),
      autonomous: true,
    });
    const browserPaneCase = trusted.slice(
      trusted.indexOf('\n    browser-pane)'),
      trusted.indexOf('\n    *)', trusted.indexOf('\n    browser-pane)')),
    );
    // Same unconditional refusal shape regardless of agent.autonomous —
    // AGENT_AUTONOMOUS baked '1' still trips the hard refusal at runtime.
    expect(browserPaneCase).toContain('[ "${AGENT_AUTONOMOUS:-0}" = "1" ]');
    expect(browserPaneCase).toContain('Browser actions require an attended Review with a visible Browser Pane.');
  });

  it('validates kind, selector, and URL allowlist before requesting approval', () => {
    const missingSelector = generateRunScript(agent({
      type: 'browser-pane',
      browserPaneAction: { kind: 'click', selector: '' },
      browserPaneUrlAllowlist: ['https://example.com'],
    }));
    expect(missingSelector).toContain('Browser action is missing a CSS selector.');

    const missingAllowlist = generateRunScript(agent({
      type: 'browser-pane',
      browserPaneAction: { kind: 'click', selector: '#x' },
      browserPaneUrlAllowlist: [],
    }));
    expect(missingAllowlist).toContain('Browser action is missing its URL allowlist.');
  });

  it('emits parseable shell', () => {
    expect(() => bashParses(s)).not.toThrow();
  });
});

describe('generateRunScript — browser-pane {{result}} substitution (fill value only, never the selector)', () => {
  it('resolves the {{result}} placeholder in the fill value at request-write time', () => {
    const s = generateRunScript(agent({
      type: 'browser-pane',
      browserPaneAction: { kind: 'fill', selector: '#note', value: 'Summary: {{result}}' },
      browserPaneUrlAllowlist: ['https://example.com/form'],
    }));
    expect(s).toContain("ACTION_BROWSER_PANE_VALUE='Summary: {{result}}'");
    // The literal placeholder resolves against $preview via bash pattern
    // substitution, mirroring dm_reply_text_resolved's exact style (no
    // backslash-escaping of the braces — unlike intent_share_text_resolved's
    // stylistically different but equally valid \\{\\{result\\}\\} form;
    // both compile to a valid bash `${var//pattern/repl}`).
    expect(s).toContain('browser_pane_value_resolved="${ACTION_BROWSER_PANE_VALUE//{{result}}/$preview}"');
    expect(s).toContain('browser_pane_value_json=$(json_escape_text "$browser_pane_value_resolved")');
    expect(s).toContain('"browserPaneActionKind":"$browser_pane_kind_json","browserPaneSelector":"$browser_pane_selector_json","browserPaneValue":"$browser_pane_value_json","browserPaneUrlAllowlist":"$browser_pane_url_allowlist_json"');
  });
});

describe('generateRunScript — browser-pane is excluded from the auto-mode skip (always write+wait)', () => {
  it('adds browser-pane to request_and_wait_approval\'s always-request case list', () => {
    const s = generateRunScript(agent({ type: 'draft' }));
    expect(s).toContain('intent|dm-reply|app-act|browser-pane) ;;');
  });

  it('bakes auto_accept_flag as unconditionally false for browser-pane, unlike intent/dm-reply', () => {
    const s = generateRunScript(agent({ type: 'draft' }));
    expect(s).toContain('auto_accept_flag=$([ "$approval_type" != "browser-pane" ] && [ "$ACTION_APPROVAL_MODE" != "manual" ] && printf \'true\' || printf \'false\')');
  });
});

describe('resolveTargetBrowserPaneId', () => {
  it('returns null when no Browser Pane is mounted (the fail-closed case)', () => {
    expect(resolveTargetBrowserPaneId([], null)).toBeNull();
    expect(resolveTargetBrowserPaneId([null, { id: 'a', tab: 'terminal' }], null)).toBeNull();
  });

  it('returns the only Browser Pane when exactly one is mounted, regardless of focus', () => {
    expect(resolveTargetBrowserPaneId([{ id: 'b', tab: 'browser' }, null], null)).toBe('b');
    expect(resolveTargetBrowserPaneId([{ id: 'b', tab: 'browser' }, null], 'someone-else')).toBe('b');
  });

  it('prefers the focused pane when it is one of multiple Browser Panes', () => {
    const slots = [{ id: 'b1', tab: 'browser' }, { id: 'b2', tab: 'browser' }];
    expect(resolveTargetBrowserPaneId(slots, 'b2')).toBe('b2');
  });

  it('falls back to the first Browser Pane in slot order when focus is elsewhere or unset', () => {
    const slots = [{ id: 'b1', tab: 'browser' }, { id: 'b2', tab: 'browser' }];
    expect(resolveTargetBrowserPaneId(slots, null)).toBe('b1');
    expect(resolveTargetBrowserPaneId(slots, 'terminal-pane-id')).toBe('b1');
  });
});

describe('fireReviewedAgentBrowserPaneAction — mocked executeBrowserPaneAction (accept/decline/validation paths)', () => {
  it('executes a click action with the approval-reviewed fields, never a caller-guessed paneId', () => {
    const request = {
      browserPaneActionKind: 'click' as const,
      browserPaneSelector: '#submit',
      browserPaneUrlAllowlist: JSON.stringify(['https://example.com/form']),
    };
    const executeAction = jest.fn(async () => ({
      actionId: 'run-1',
      kind: 'click' as const,
      ok: true,
      tainted: true as const,
    }));

    return fireReviewedAgentBrowserPaneAction(request, 'pane-1', 'run-1', executeAction).then((result) => {
      expect(executeAction).toHaveBeenCalledWith('pane-1', {
        action: { kind: 'click', selector: '#submit' },
        urlAllowlist: ['https://example.com/form'],
        approval: { approved: true, actionId: 'run-1' },
      });
      expect(result.ok).toBe(true);
    });
  });

  it('builds a fill action with its value, never leaking the value into the selector', async () => {
    const request = {
      browserPaneActionKind: 'fill' as const,
      browserPaneSelector: '#note',
      browserPaneValue: 'Summary: hello world',
      browserPaneUrlAllowlist: JSON.stringify(['https://example.com/form']),
    };
    const executeAction = jest.fn(async () => ({ actionId: 'run-2', kind: 'fill' as const, ok: true, tainted: true as const }));

    await fireReviewedAgentBrowserPaneAction(request, 'pane-1', 'run-2', executeAction);

    expect(executeAction).toHaveBeenCalledWith('pane-1', {
      action: { kind: 'fill', selector: '#note', value: 'Summary: hello world' },
      urlAllowlist: ['https://example.com/form'],
      approval: { approved: true, actionId: 'run-2' },
    });
  });

  it('rejects an unsupported action kind before ever calling executeAction', async () => {
    const request = { browserPaneActionKind: 'eval' as any, browserPaneSelector: '#x', browserPaneUrlAllowlist: '["https://example.com"]' };
    const executeAction = jest.fn(async () => ({ actionId: 'x', kind: 'click' as const, ok: true, tainted: true as const }));

    await expect(fireReviewedAgentBrowserPaneAction(request, 'pane-1', 'run-3', executeAction)).rejects.toThrow(
      'Unsupported browser-pane action kind.',
    );
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects a missing selector before ever calling executeAction', async () => {
    const request = { browserPaneActionKind: 'click' as const, browserPaneSelector: '', browserPaneUrlAllowlist: '["https://example.com"]' };
    const executeAction = jest.fn(async () => ({ actionId: 'x', kind: 'click' as const, ok: true, tainted: true as const }));

    await expect(fireReviewedAgentBrowserPaneAction(request, 'pane-1', 'run-4', executeAction)).rejects.toThrow(
      'Browser-pane action is missing a selector.',
    );
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects a missing/empty/malformed URL allowlist before ever calling executeAction (fail-closed, never widens the gate)', async () => {
    const executeAction = jest.fn(async () => ({ actionId: 'x', kind: 'click' as const, ok: true, tainted: true as const }));
    const base = { browserPaneActionKind: 'click' as const, browserPaneSelector: '#x' };

    await expect(fireReviewedAgentBrowserPaneAction({ ...base, browserPaneUrlAllowlist: null }, 'pane-1', 'run-5', executeAction))
      .rejects.toThrow('Browser-pane action is missing its URL allowlist.');
    await expect(fireReviewedAgentBrowserPaneAction({ ...base, browserPaneUrlAllowlist: '[]' }, 'pane-1', 'run-6', executeAction))
      .rejects.toThrow('Browser-pane action is missing its URL allowlist.');
    await expect(fireReviewedAgentBrowserPaneAction({ ...base, browserPaneUrlAllowlist: 'not json{{{' }, 'pane-1', 'run-7', executeAction))
      .rejects.toThrow('Browser-pane action is missing its URL allowlist.');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('propagates a native/JS throw (e.g. URL no longer allowlisted, element not found) so the caller can decline (fail-closed)', async () => {
    const request = {
      browserPaneActionKind: 'click' as const,
      browserPaneSelector: '#submit',
      browserPaneUrlAllowlist: JSON.stringify(['https://example.com/form']),
    };
    const executeAction = jest.fn(async () => {
      throw new Error('Current WebView URL is not allowlisted.');
    });

    await expect(fireReviewedAgentBrowserPaneAction(request, 'pane-1', 'run-8', executeAction)).rejects.toThrow(
      'Current WebView URL is not allowlisted.',
    );
  });
});
