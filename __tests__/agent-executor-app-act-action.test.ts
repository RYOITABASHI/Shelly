jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { fireReviewedAgentAppAct, parseAppActParamsResolved } from '@/lib/agent-app-act-review';
import { Agent } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appact-parse-')), 'run.sh');
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

// Phase 4: real .sh executor support for the 'app-act' agent action. The
// actual side effect (AppActExecutor driving ShellyAccessibilityService)
// happens natively in RN (fireAgentAppAct) at the moment the human taps
// Allow -- BEFORE the accept reply is written. This case only requests
// approval, waits, and reports; it must never call a broker/native function
// after approval (mirrors intent/dm-reply's existing invariant).
describe('generateRunScript — app-act action', () => {
  const s = generateRunScript(agent({ type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } }));

  it('threads ACTION_TYPE and the app-act variables through, correctly quoted', () => {
    expect(s).toContain("ACTION_TYPE='app-act'");
    expect(s).toContain("ACTION_APP_ACT_RECIPE_ID='x.post'");
    expect(s).toContain('ACTION_APP_ACT_PARAMS_JSON=');
    expect(s).toContain('{{result}}');
  });

  it('rejects autonomous/unattended execution before requesting attended Review approval when NOT Tier-B trusted', () => {
    // This fixture's agent has no `autonomous: true`, so
    // ACTION_APP_ACT_AUTO_FIRE_TRUSTED is baked '0' and the unattended hard
    // refusal below still applies exactly as before 2026-07-14's Tier-B
    // change — see the 'autonomous + on-device tool unlocks the Tier-B
    // unattended-allow' test below for the trusted case.
    expect(s).toContain('ACTION_APP_ACT_AUTO_FIRE_TRUSTED=0');
    const appActCase = s.slice(s.indexOf('\n    app-act)'), s.indexOf('\n    *)', s.indexOf('\n    app-act)')));
    expect(appActCase).toContain('[ "${AGENT_AUTONOMOUS:-0}" = "1" ]');
    expect(appActCase).toContain('[ "${SHELLY_RUN_UNATTENDED:-0}" = "1" ]');
    expect(appActCase).toContain('$ACTION_APP_ACT_AUTO_FIRE_TRUSTED');
    expect(appActCase).toContain('App-action actions require an attended Review.');
    expect(appActCase).toContain('request_and_wait_approval "app-act" "$preview" "$result_file" || return 1');
    expect(appActCase.indexOf('AGENT_AUTONOMOUS')).toBeLessThan(appActCase.indexOf('request_and_wait_approval'));
    // No broker/native dispatch call after approval — the side effect already
    // happens natively (fireAgentAppAct, or native's own auto-fire when
    // Tier-B trusted) before the accept reply is written.
    expect(appActCase).not.toContain('cap_workspace_exec');
    expect(appActCase).not.toContain('http_post_json');
  });

  it('autonomous + on-device tool unlocks the Tier-B unattended-allow (registration-time consent, not a blanket bypass)', () => {
    const trusted = generateRunScript({
      ...agent({ type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } }),
      autonomous: true,
    });
    expect(trusted).toContain('ACTION_APP_ACT_AUTO_FIRE_TRUSTED=1');
    const trustedAppActCase = trusted.slice(trusted.indexOf('\n    app-act)'), trusted.indexOf('\n    *)', trusted.indexOf('\n    app-act)')));
    // Still requests approval (native auto-fires + replies; the shell doesn't
    // skip the wait, only WHO resolves it changes) — never a blanket bypass.
    expect(trustedAppActCase).toContain('request_and_wait_approval "app-act" "$preview" "$result_file" || return 1');

    // A cloud-routed autonomous agent (not on-device) must NOT be trusted —
    // the Tier-B gate is narrower than "autonomous alone". In fact it never
    // even reaches the point where ACTION_APP_ACT_AUTO_FIRE_TRUSTED would be
    // computed: an autonomous agent pinned to a keyed cloud tool with no
    // consent is refused outright at script-generation time (Spec A §4) —
    // an even stronger boundary than the Tier-B gate alone would provide.
    const cloudAutonomous = generateRunScript({
      ...agent({ type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } }),
      autonomous: true,
      tool: { type: 'gemini-api' },
    });
    expect(cloudAutonomous).not.toContain('ACTION_APP_ACT_AUTO_FIRE_TRUSTED=1');
    expect(cloudAutonomous).toContain('autonomous mode does not allow');
  });

  it('validates recipe id and params before requesting approval', () => {
    const missingRecipe = generateRunScript(agent({ type: 'app-act', appActParams: { text: 'hi' } }));
    expect(missingRecipe).toContain('App-action is missing a recipe.');
    const missingParams = generateRunScript(agent({ type: 'app-act', appActRecipeId: 'x.post' }));
    expect(missingParams).toContain('App-action is missing its recipe parameters.');
  });

  it('emits parseable shell', () => {
    expect(() => bashParses(s)).not.toThrow();
  });
});

describe('generateRunScript — app-act redaction before {{result}} substitution', () => {
  it('bakes resolve_app_act_params, which redacts a SECOND time after substituting {{result}}', () => {
    const s = generateRunScript(agent({
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: 'Posting: {{result}}' },
    }));
    // The resolver function exists and is called from write_action_approval_request
    // with the already-redacted $preview, then redacts the resolved JSON again
    // (defense-in-depth) before it reaches the approval-request preview.
    expect(s).toContain('resolve_app_act_params()');
    expect(s).toContain('v.split(\'{{result}}\').join(preview)');
    expect(s).toContain('redact_secrets_text "$tmp_resolved"');
    expect(s).toContain('app_act_params_resolved=$(resolve_app_act_params "$ACTION_APP_ACT_PARAMS_JSON" "$preview")');
    expect(s).toContain('app_act_params_resolved_json=$(json_escape_text "$app_act_params_resolved")');
    expect(s).toContain('"appActRecipeId":"$app_act_recipe_id_json","appActParamsResolved":"$app_act_params_resolved_json"');
  });

  it('never bypasses redaction by inlining a raw {{result}} substitution outside resolve_app_act_params', () => {
    const s = generateRunScript(agent({
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: 'leaking: {{result}}' },
    }));
    // Unlike ACTION_INTENT_SHARE_TEXT/ACTION_DM_REPLY_TEXT (which substitute
    // {{result}} inline against the already-redacted $preview with no second
    // pass), app-act's resolution always routes through resolve_app_act_params
    // — this is the non-negotiable extra redaction pass for the first action
    // type that can publish externally.
    expect(s).not.toMatch(/ACTION_APP_ACT_PARAMS_JSON\/\/\\\{\\\{result\\\}\\\}/);
  });
});

describe('fireReviewedAgentAppAct — mocked native bridge (accept/decline/throw paths)', () => {
  it('fires the recipe with the resolved params during Review acceptance', async () => {
    const request = {
      appActRecipeId: 'x.post',
      appActParamsResolved: JSON.stringify({ text: 'Hello world' }),
    };
    const events: string[] = [];
    const fireAgentAppAct = jest.fn(async (recipeId: string, params: Record<string, string>) => {
      events.push(`fire:${recipeId}:${JSON.stringify(params)}`);
    });

    await fireReviewedAgentAppAct(request, fireAgentAppAct);

    expect(fireAgentAppAct).toHaveBeenCalledWith('x.post', { text: 'Hello world' });
    expect(events).toEqual(['fire:x.post:{"text":"Hello world"}']);
  });

  it('propagates a native throw so the caller can resolve the approval as declined (fail-closed)', async () => {
    const request = {
      appActRecipeId: 'x.post',
      appActParamsResolved: JSON.stringify({ text: 'Hello world' }),
    };
    const fireAgentAppAct = jest.fn(async () => {
      throw new Error('Accessibility Service is not enabled/connected');
    });

    await expect(fireReviewedAgentAppAct(request, fireAgentAppAct)).rejects.toThrow(
      'Accessibility Service is not enabled/connected',
    );
  });

  it('fails closed to an empty param map on malformed appActParamsResolved JSON, never throwing itself', async () => {
    const request = { appActRecipeId: 'x.post', appActParamsResolved: 'not json{{{' };
    const fireAgentAppAct = jest.fn(async () => undefined);

    await fireReviewedAgentAppAct(request, fireAgentAppAct);

    expect(fireAgentAppAct).toHaveBeenCalledWith('x.post', {});
  });
});

describe('parseAppActParamsResolved', () => {
  it('parses a valid resolved-params JSON object', () => {
    expect(parseAppActParamsResolved('{"text":"hi","other":"x"}')).toEqual({ text: 'hi', other: 'x' });
  });

  it('returns {} for null/undefined/empty input', () => {
    expect(parseAppActParamsResolved(null)).toEqual({});
    expect(parseAppActParamsResolved(undefined)).toEqual({});
    expect(parseAppActParamsResolved('')).toEqual({});
  });

  it('returns {} for a JSON array or a JSON primitive (not a plain object)', () => {
    expect(parseAppActParamsResolved('["a","b"]')).toEqual({});
    expect(parseAppActParamsResolved('"just a string"')).toEqual({});
    expect(parseAppActParamsResolved('42')).toEqual({});
  });

  it('drops non-string values from an otherwise valid object', () => {
    expect(parseAppActParamsResolved('{"text":"hi","count":3,"nested":{"a":1}}')).toEqual({ text: 'hi' });
  });
});
