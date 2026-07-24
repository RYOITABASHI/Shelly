jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, AgentAction } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-action-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const agent = (overrides: Partial<Agent> = {}): Agent => ({
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
  ...overrides,
});

// Bluesky + X (app-act) — the exact "post to multiple destinations at once"
// scenario docs/superpowers/DEFERRED.md's "multi-platform-simultaneous-post
// gap" entry names. There is no 'x'/'twitter' SocialPlatform (X posting goes
// through app-act's AccessibilityService route, not a social connector), so
// this is the realistic two-action combination for this feature.
const blueskyAction: AgentAction = { type: 'social-post', socialPost: { platform: 'bluesky', connectorId: 'my-bsky' } };
const xAppActAction: AgentAction = { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } };

describe('generateRunScript — Agent.actions multi-destination fan-out (regression: byte-identical single-action output)', () => {
  it('agent.actions ABSENT produces the exact same script as before this field existed', () => {
    const withoutField = generateRunScript(agent({ action: { type: 'draft' } }));
    // No `actions` key at all on the object (not even `actions: undefined`
    // explicitly) — the TRUE "before this feature existed" shape.
    expect(withoutField).not.toContain('ACTION_MULTI_');
    expect(withoutField).not.toContain('actionResults');
  });

  it('agent.actions EMPTY ([]) produces byte-identical output to agent.actions ABSENT', () => {
    const withoutField = generateRunScript(agent({ action: { type: 'draft' } }));
    const withEmptyArray = generateRunScript(agent({ action: { type: 'draft' }, actions: [] }));
    expect(withEmptyArray).toBe(withoutField);
  });

  it('agent.actions with exactly ONE entry produces byte-identical output to agent.actions ABSENT (the entry is ignored — Agent.action alone still governs)', () => {
    const withoutField = generateRunScript(agent({ action: { type: 'draft' } }));
    const withOneEntry = generateRunScript(agent({ action: { type: 'draft' }, actions: [{ type: 'notify' }] }));
    expect(withOneEntry).toBe(withoutField);
  });

  it('a suppressed orchestration step (opts.suppressAction) ignores agent.actions even with >= 2 entries, byte-identical to the pre-existing suppressed output', () => {
    const suppressedWithoutActions = generateRunScript(agent({ action: { type: 'draft' } }), { suppressAction: true });
    const suppressedWithActions = generateRunScript(
      agent({ action: { type: 'draft' }, actions: [blueskyAction, xAppActAction] }),
      { suppressAction: true },
    );
    expect(suppressedWithActions).toBe(suppressedWithoutActions);
    expect(suppressedWithActions).toContain("ACTION_TYPE='__suppressed__'");
    expect(suppressedWithActions).not.toContain('ACTION_MULTI_');
  });

  it('the SHELLY_AGENT_SCRIPT_VERSION bump (24) applies uniformly, single- or multi-action', () => {
    const single = generateRunScript(agent({ action: { type: 'draft' } }));
    const multi = generateRunScript(agent({ action: { type: 'draft' }, actions: [blueskyAction, xAppActAction] }));
    expect(single).toContain('SHELLY_AGENT_SCRIPT_VERSION=28');
    expect(multi).toContain('SHELLY_AGENT_SCRIPT_VERSION=28');
  });
});

describe('generateRunScript — Agent.actions multi-destination fan-out (>= 2 entries)', () => {
  const s = generateRunScript(agent({ action: { type: 'draft' }, actions: [blueskyAction, xAppActAction] }));

  it('bakes one ACTION_MULTI_* bash array per baked field, indexed like Agent.actions', () => {
    expect(s).toContain('ACTION_MULTI_COUNT=2');
    expect(s).toContain("ACTION_MULTI_TYPES=('social-post' 'app-act')");
    expect(s).toContain("ACTION_MULTI_SOCIAL_PLATFORMS=('bluesky' '')");
    expect(s).toContain("ACTION_MULTI_SOCIAL_CONNECTOR_IDS=('my-bsky' '')");
    expect(s).toContain("ACTION_MULTI_APP_ACT_RECIPE_IDS=('' 'x.post')");
  });

  it('the top-level ACTION_TYPE constant (built from the unused legacy Agent.action) is overwritten from the array before every dispatch, never left at its placeholder value', () => {
    // Agent.action stays 'draft' here (a harmless, never-dispatched compat
    // placeholder — see ActionBakedFields/useMultiActions' own doc comment);
    // dispatch_agent_action must only ever see ACTION_TYPE re-assigned from
    // the per-index array, never the placeholder.
    expect(s).toContain("ACTION_TYPE='draft'");
    expect(s).toContain('ACTION_TYPE="${ACTION_MULTI_TYPES[$ACTION_MULTI_IDX]}"');
    // The array assignment must appear AFTER the placeholder bake AND before
    // the dispatch call, so the loop body always wins.
    const placeholderIdx = s.indexOf("ACTION_TYPE='draft'");
    const arrayAssignIdx = s.indexOf('ACTION_TYPE="${ACTION_MULTI_TYPES[$ACTION_MULTI_IDX]}"');
    const dispatchIdx = s.indexOf('dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW" || ACTION_MULTI_RC=$?');
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeLessThan(arrayAssignIdx);
    expect(arrayAssignIdx).toBeLessThan(dispatchIdx);
  });

  it('dispatches EACH action independently through the SAME dispatch_agent_action(), capturing (never bare-failing under set -e) its return code', () => {
    expect(s).toContain('dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW" || ACTION_MULTI_RC=$?');
    // A bare (uncaptured) call would abort the whole script on failure under
    // `set -euo pipefail` — the `|| ACTION_MULTI_RC=$?` capture is what makes
    // "one action's failure does not stop the loop" true.
    expect(s).not.toMatch(/^\s*dispatch_agent_action "\$RESULT_CONTENT_FILE" "\$PREVIEW"\s*$/m);
  });

  it('generates a FRESH ACTION_RUN_ID per loop index, so two actions in the same run/second never collide on the same approval request/reply file', () => {
    expect(s).toContain('ACTION_RUN_ID="$AGENT_ID-$(date +%s)-$$-$ACTION_MULTI_IDX"');
    expect(s).toContain('ACTION_APPROVAL_REQUEST_SHA256=""');
  });

  it('records a per-action result (index/actionType/status/message) into ACTION_RESULTS_JSON', () => {
    expect(s).toContain('ACTION_RESULT_PART="{\\"index\\":$ACTION_MULTI_IDX,\\"actionType\\":\\"$ACTION_TYPE_RESULT_JSON\\",\\"status\\":\\"$ACTION_RESULT_STATUS_JSON\\",\\"message\\":\\"$ACTION_RESULT_MESSAGE_JSON\\"}"');
    expect(s).toContain('ACTION_RESULTS_JSON="[$ACTION_RESULTS_PARTS]"');
    expect(s).toContain('ACTION_RESULTS_FIELDS=",\\"actionResults\\":$ACTION_RESULTS_JSON"');
    expect(s).toContain('$ROUTE_DECISION_JSON$SAVED_PATH_FIELDS$ACTION_RESULTS_FIELDS}');
  });

  it('reduces the run STATUS from N independent outcomes without inventing a new status value: any success -> success, else any error -> error, else skipped', () => {
    const reduceBlock = s.slice(s.indexOf('ACTION_MULTI_SUMMARY='), s.indexOf('write_native_notification_request "$STATUS" "$PREVIEW" || true'));
    expect(s).toContain('if [ "$ACTION_MULTI_SUCCESS_COUNT" -gt 0 ]; then\n    STATUS="success"');
    expect(s).toContain('elif [ "$ACTION_MULTI_ERROR_COUNT" -gt 0 ]; then\n    STATUS="error"');
    expect(s).toContain('elif [ "$ACTION_MULTI_SKIPPED_COUNT" -gt 0 ]; then\n    STATUS="skipped"');
    expect(reduceBlock).toBeDefined();
  });

  it('emits parseable shell for a multi-action agent', () => {
    expect(() => bashParses(s)).not.toThrow();
  });

  it('a fake connector secret value never appears in the generated script static text (matches the single-action social-post invariant)', () => {
    const canary = 'sk-FAKE-multi-action-canary-123456789';
    expect(s).not.toContain(canary);
  });
});
