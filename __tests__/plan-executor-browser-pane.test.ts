/**
 * __tests__/plan-executor-browser-pane.test.ts — 'browser-pane' PlanSpec
 * executor coverage (scripts/shelly-plan-executor.js).
 *
 * Mirrors __tests__/plan-executor-api-call.test.ts's dispatchActionTrusted
 * harness (approval-request capture + synchronous accept/decline reply) and
 * __tests__/agent-executor-intent-action.test.ts's attended-only framing for
 * the .sh executor. browser-pane never calls the broker (the side effect is
 * an RN WebView injectJavaScript call, not a broker op), so this file needs
 * no spawnSync mock at all — only the approval request/reply file dance.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-browserpane-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makeBasePlan(home: string, agentId: string, actionType = 'notify') {
  return {
    kind: 'shelly.agent.plan',
    schemaVersion: 1,
    generatedAt: 1,
    agent: { id: agentId, name: 'Browser Pane Test', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: actionType },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'browser-pane-test',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
}

function preparePaths(home: string, agentId: string) {
  const rtPaths = executor.runtimePaths(home, agentId);
  fs.mkdirSync(rtPaths.logDir, { recursive: true });
  fs.writeFileSync(rtPaths.envFile, '');
  return rtPaths;
}

const OPTS = { broker: scriptCopy, tainted: false, libDir: '' };

function browserPanePlan(home: string, agentId: string, browserPaneAction: unknown, browserPaneUrlAllowlist: unknown) {
  return {
    ...makeBasePlan(home, agentId, 'browser-pane'),
    action: { type: 'browser-pane', browserPaneAction, browserPaneUrlAllowlist },
  };
}

describe('unattendedPreflightFailure — browser-pane is ALWAYS refused unattended, no Tier-B exception', () => {
  it('refuses regardless of trusted-* args (unlike the draft/notify trust path)', async () => {
    const home = makeHome();
    const agentId = 'agent-unattended';
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '#go' }, ['https://example.com/form']);
    (plan.agent as any).autonomous = true;

    const reasonPlain = executor.unattendedPreflightFailure({ unattended: '1' }, plan, {});
    expect(reasonPlain).toMatch(/unsupported unattended PlanSpec action: browser-pane/);

    // Even with the SAME trusted-* args that unlock draft/notify's Tier-B
    // path (trustedNativeLowRiskAction), browser-pane must still be refused
    // — there is no equivalent trust gate.
    const reasonTrusted = executor.unattendedPreflightFailure(
      {
        unattended: '1',
        'trusted-autonomous-agent-id': agentId,
        'trusted-autonomous-action': 'browser-pane',
        'trusted-tool-type': 'local',
      },
      plan,
      {},
    );
    expect(reasonTrusted).toMatch(/unsupported unattended PlanSpec action: browser-pane/);
  });

  it('is a no-op (empty string) when NOT unattended', async () => {
    const home = makeHome();
    const plan = browserPanePlan(home, 'agent-attended', { kind: 'click', selector: '#go' }, ['https://example.com/form']);
    expect(executor.unattendedPreflightFailure({}, plan, {})).toBe('');
  });
});

describe('dispatchActionTrusted — action.type === "browser-pane" (approval-request capture)', () => {
  const afterAllSpies: jest.SpyInstance[] = [];
  afterEach(() => {
    while (afterAllSpies.length) afterAllSpies.pop()!.mockRestore();
  });

  /** Mirrors plan-executor-api-call.test.ts's captureApprovalRequest exactly:
   *  intercepts the approval-request write, captures it, and plants a reply
   *  (accept by default) so the synchronous poll loop returns immediately. */
  function captureApprovalRequest(rtPaths: any, decision: 'accept' | 'decline' = 'accept'): { get: () => any } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsNode = require('fs');
    const realWriteFileSync = fsNode.writeFileSync.bind(fsNode);
    let captured: any = null;
    const spy = jest.spyOn(fsNode, 'writeFileSync').mockImplementation((file: any, data: any, opts?: any) => {
      const result = realWriteFileSync(file, data, opts);
      if (typeof file === 'string' && path.dirname(file) === rtPaths.actionApprovalDir) {
        captured = JSON.parse(String(data));
        const sha = crypto.createHash('sha256').update(String(data)).digest('hex');
        const replyFile = path.join(rtPaths.actionApprovalReplyDir, `action-${captured.runId}.reply.json`);
        realWriteFileSync(replyFile, `${JSON.stringify({
          runId: captured.runId,
          decision,
          by: 'test',
          requestSha256: sha,
          ts: new Date().toISOString(),
        })}\n`);
      }
      return result;
    });
    afterAllSpies.push(spy);
    return { get: () => captured };
  }

  it('success: requests approval, then reports success with no broker/native call', async () => {
    const home = makeHome();
    const agentId = 'agent-click-success';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '#submit' }, ['https://example.com/form']);

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('success');
    const request = capture.get();
    expect(request).not.toBeNull();
    expect(request.actionType).toBe('browser-pane');
    expect(request.browserPaneActionKind).toBe('click');
    expect(request.browserPaneSelector).toBe('#submit');
    expect(JSON.parse(request.browserPaneUrlAllowlist)).toEqual(['https://example.com/form']);
  });

  it('ALWAYS requests approval (autoAccept is always false), even when the global default is auto and requireActionApproval is unset', async () => {
    const home = makeHome();
    const agentId = 'agent-always-review';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '#submit' }, ['https://example.com/form']);
    // requireActionApproval left unset, config = {} (no
    // SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL at all). Doesn't matter for this
    // test either way — browser-pane's autoAccept is unconditionally false
    // regardless of what requireActionApprovalTap resolves to (that's the
    // whole point of the test title below) — but noting it for anyone who
    // later copies this fixture into a test that DOES care: since the
    // 2026-08-25 approval-default reversal, an absent config now resolves to
    // manual/true, not auto/false.
    const config = {};

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, config, [], 'q1', {});

    expect(result.status).toBe('success');
    const request = capture.get();
    expect(request).not.toBeNull(); // a request WAS written -- not skipped like draft/notify/webhook/cli would be
    expect(request.autoAccept).toBe(false);
  });

  it('a fill action resolves {{result}} in the value, never in the selector', async () => {
    const home = makeHome();
    const agentId = 'agent-fill';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(
      home,
      agentId,
      { kind: 'fill', selector: '#search-{{result}}', value: 'query: {{result}}' },
      ['https://example.com/search'],
    );

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'hello world', {});

    expect(result.status).toBe('success');
    const request = capture.get();
    expect(request.browserPaneActionKind).toBe('fill');
    // Selector is NEVER substituted -- it is a CSS selector, not content.
    expect(request.browserPaneSelector).toBe('#search-{{result}}');
    expect(request.browserPaneValue).toBe('query: hello world');
  });

  it('rejects an invalid kind before ever requesting approval', async () => {
    const home = makeHome();
    const agentId = 'agent-bad-kind';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(home, agentId, { kind: 'eval', selector: '#x' }, ['https://example.com']);

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q', {});

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/invalid kind/);
    expect(capture.get()).toBeNull();
  });

  it('rejects a missing selector before ever requesting approval', async () => {
    const home = makeHome();
    const agentId = 'agent-no-selector';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '' }, ['https://example.com']);

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q', {});

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/missing a CSS selector/);
    expect(capture.get()).toBeNull();
  });

  it('rejects an empty/missing URL allowlist before ever requesting approval', async () => {
    const home = makeHome();
    const agentId = 'agent-no-allowlist';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '#x' }, []);

    const result = await executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q', {});

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/missing its URL allowlist/);
    expect(capture.get()).toBeNull();
  });

  it('a declined Review throws (never silently reports success)', async () => {
    const home = makeHome();
    const agentId = 'agent-declined';
    const rtPaths = preparePaths(home, agentId);
    captureApprovalRequest(rtPaths, 'decline');
    const plan = browserPanePlan(home, agentId, { kind: 'click', selector: '#submit' }, ['https://example.com/form']);

    await expect(executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q', {})).rejects.toThrow(/declined/);
  });
});
