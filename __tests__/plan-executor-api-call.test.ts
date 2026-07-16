/**
 * __tests__/plan-executor-api-call.test.ts — api-call (v1) executor coverage.
 *
 * Functional coverage for scripts/shelly-plan-executor.js's api-call dispatch
 * (runOrchestrationChain's non-final-step branch and dispatchActionTrusted's
 * 'api-call' case): success/failure/GET-vs-POST/empty-response/final-step
 * no-op. The SECURITY-CRITICAL tainted+authRef regression test lives in
 * __tests__/plan-executor-orchestration-chain.test.ts instead, because it
 * needs the REAL capability broker (classifyEgress) to prove the fail-closed
 * boundary — these tests intentionally do NOT exercise the real boundary.
 *
 * dispatchApiCallRequest always builds `https://${host}${path}` with no port
 * override, so a real live HTTPS endpoint (default port 443) can't be stood
 * up offline/unprivileged the way the existing loopback-HTTP model-call
 * fixtures do. Instead this file mocks `child_process.spawnSync` — the SAME
 * seam runBroker() itself calls through — so the executor's own JS dispatch
 * logic runs for real (in-process, via require()) while the broker's
 * OS-process boundary is stubbed with a canned response. "Broker mocked
 * success/failure" per the implementation plan's own wording. The broker's
 * OWN security boundary (classifyEgress, secret-by-reference, taint gate) has
 * its own dedicated coverage elsewhere (capability-broker.test.ts,
 * plan-executor-orchestration-chain.test.ts's tainted+authRef test) and is
 * NOT re-tested here.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const mockedSpawnSync = spawnSync as unknown as jest.Mock;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-apicall-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

interface CapturedCall {
  op: string;
  url: string;
  method: string;
  bodyFile: string;
  bodyText: string | null;
  authRef: string | null;
  approved: boolean;
}

interface CannedResponse {
  rc: number;
  body?: string;
  err?: string;
}

/** Wires the mocked spawnSync to serve one canned response per http.request
 *  call (in order) and to perform a REAL best-effort file copy for fs.write
 *  calls (so writeDraftOutputs' actual output can be asserted on disk) —
 *  mirroring just enough of the real broker's on-disk contract for these
 *  tests, without re-testing the broker's own security logic. */
function setupBrokerMock(httpResponses: CannedResponse[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let httpCallIndex = 0;
  mockedSpawnSync.mockReset();
  mockedSpawnSync.mockImplementation((_file: string, args: string[]) => {
    const get = (flag: string) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const op = get('--op') || '';
    const outFile = get('--out');
    const errFile = get('--err');
    if (op === 'http.request') {
      const bodyFile = get('--body-file');
      calls.push({
        op,
        url: get('--url') || '',
        method: get('--method') || '',
        bodyFile: bodyFile || '',
        bodyText: bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : null,
        authRef: get('--auth-ref'),
        approved: args.includes('--approved'),
      });
      const resp = httpResponses[httpCallIndex] ?? { rc: 0, body: '' };
      httpCallIndex += 1;
      if (outFile) fs.writeFileSync(outFile, resp.body ?? '');
      if (errFile) fs.writeFileSync(errFile, resp.err ?? '');
      return { status: resp.rc, error: null };
    }
    if (op === 'fs.write') {
      // Real best-effort copy, mirroring the broker's own fs.write op just
      // enough for these tests to assert real on-disk content.
      const dest = get('--path');
      const inputFile = get('--input-file');
      try {
        if (dest && inputFile) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(inputFile, dest);
        }
        if (outFile) fs.writeFileSync(outFile, '');
        if (errFile) fs.writeFileSync(errFile, '');
        return { status: 0, error: null };
      } catch (e) {
        if (errFile) fs.writeFileSync(errFile, String(e));
        return { status: 1, error: null };
      }
    }
    if (outFile) fs.writeFileSync(outFile, '');
    if (errFile) fs.writeFileSync(errFile, 'unsupported mocked op');
    return { status: 1, error: null };
  });
  return calls;
}

function makeBasePlan(home: string, agentId: string, actionType = 'notify') {
  return {
    kind: 'shelly.agent.plan',
    schemaVersion: 1,
    generatedAt: 1,
    agent: { id: agentId, name: 'Api Call Test', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: actionType },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'api-call-test',
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

describe('runOrchestrationChain — api-call non-final step (broker mocked)', () => {
  it('GET step: broker success -> response lands in priorResults, visible in the NEXT step\'s built prompt', () => {
    const home = makeHome();
    const agentId = 'agent-get-success';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([
      { rc: 0, body: '{"answer":42}' }, // step 0: api-call GET
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'final content' } }] }) }, // step 1: model call
    ]);
    const plan = {
      ...makeBasePlan(home, agentId, 'notify'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' } },
          { instruction: 'summarize' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].status).toBe('success');
    expect(result.steps[0].outputPreview).toContain('42');

    // First call: GET, no body file, no auth-ref (host is not authRef-bound here).
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.perplexity.ai/v1/search');
    expect(calls[0].bodyFile).toBe('');
    expect(calls[0].approved).toBe(false);

    // Second call: the model request body embeds step 0's api-call response
    // as prior-step context (buildStepPrompt).
    expect(calls[1].bodyText).toContain('42');
    expect(calls[1].bodyText).toContain('summarize');
  });

  it('POST step: sends a templated body with {{result}} resolved from the prior step', () => {
    const home = makeHome();
    const agentId = 'agent-post-template';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'gathered sources' } }] }) }, // step 0: model call
      { rc: 0, body: '{"ok":true}' }, // step 1: api-call POST
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'final' } }] }) }, // step 2: model call
    ]);
    const plan = {
      ...makeBasePlan(home, agentId, 'notify'),
      steps: {
        list: [
          { instruction: 'gather' },
          {
            instruction: 'post to search index',
            apiCall: { host: 'api.perplexity.ai', method: 'POST', path: '/v1/index', bodyTemplate: '{"q":"{{result}}"}' },
          },
          { instruction: 'finalize' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());

    expect(result.status).toBe('success');
    expect(result.steps[1].status).toBe('success');
    // The POST call: method POST, a body file was written, and its content
    // has {{result}} resolved to step 0's ("gathered sources") result.
    expect(calls[1].method).toBe('POST');
    expect(calls[1].bodyFile).not.toBe('');
    expect(calls[1].bodyText).toBe('{"q":"gathered sources"}');
  });

  it('GET step sends no body file at all (--body-file is never passed)', () => {
    const home = makeHome();
    const agentId = 'agent-get-no-body';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([
      { rc: 0, body: 'ok response' },
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'final' } }] }) },
    ]);
    const plan = {
      ...makeBasePlan(home, agentId, 'notify'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search', bodyTemplate: 'should be ignored for GET' } },
          { instruction: 'summarize' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());
    expect(calls[0].bodyFile).toBe('');
    expect(calls[0].bodyText).toBeNull();
  });

  it('broker failure (generic rc) marks the step error and halts the chain — NOT silent success', () => {
    const home = makeHome();
    const agentId = 'agent-broker-fail';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 1, err: 'boom: connection refused' }]);
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' } },
          { instruction: 'never reached' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());
    expect(result.status).toBe('error');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].outputPreview).toMatch(/boom: connection refused/);
  });

  it('broker failure with rc=23 (transient) marks the step unavailable, not a hard error', () => {
    const home = makeHome();
    const agentId = 'agent-broker-unavailable';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 23, err: 'upstream 503' }]);
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' } },
          { instruction: 'never reached' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());
    expect(result.status).toBe('unavailable');
    expect(result.steps[0].status).toBe('unavailable');
  });

  it('an empty response body is a step error, not a silent success', () => {
    const home = makeHome();
    const agentId = 'agent-empty-response';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 0, body: '   ' }]);
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' } },
          { instruction: 'never reached' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());
    expect(result.status).toBe('error');
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].outputPreview).toMatch(/empty/i);
  });

  it('apiCall on the FINAL step index is a no-op: the final step still dispatches via plan.action unchanged', () => {
    const home = makeHome();
    const agentId = 'agent-final-noop';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'model output, not an api-call response' } }] }) },
    ]);
    const plan = {
      ...makeBasePlan(home, agentId, 'notify'),
      steps: {
        // Only ONE step (the final one) — deliberately carries an apiCall,
        // which must be ignored: the final step's real action is always
        // plan.action, dispatched via the normal model-call path.
        list: [
          { instruction: 'do the real work', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' } },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now());

    expect(result.status).toBe('success');
    // The ONE broker call made was the MODEL call (loopback-shaped local URL
    // via chatEndpoint), never the api-call's https://api.perplexity.ai URL —
    // proving step.apiCall was ignored on the final step index.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('api.perplexity.ai');
    expect(result.steps[0].outputPreview).toContain('model output, not an api-call response');
  });

  // SECURITY (2026-07-16 adversarial review finding, closed in dispatchApiCallRequest):
  // a tainted run with NO authRef against a remote allowlisted host must be
  // refused by the EXECUTOR itself, before the broker is ever called — the
  // broker's own classifyEgress only gates tainted+authRef ("trifecta") or a
  // non-allowlisted host, not tainted-with-no-secret against an allowlisted
  // host, which would otherwise fall through to 'allow'.
  it('SECURITY: a tainted run with a NO-authRef apiCall step is refused BEFORE the broker is ever invoked', () => {
    const home = makeHome();
    const agentId = 'agent-tainted-no-authref';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([]); // no responses queued — the broker must never be called
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.github.com', method: 'GET', path: '/rate_limit' } }, // no authRef
          { instruction: 'never reached' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const taintedOpts = { ...OPTS, tainted: true };
    const result = executor.runOrchestrationChain(rtPaths, taintedOpts, plan, {}, [], {}, Date.now());

    expect(result.status).toBe('error');
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].outputPreview).toMatch(/no credential is refused on a tainted/);
    expect(calls).toHaveLength(0); // the broker was NEVER invoked for this step
  });

  it('REGRESSION: the tainted+no-authRef guard does not fire for a non-tainted run (no over-refusal)', () => {
    const home = makeHome();
    const agentId = 'agent-nontainted-no-authref';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([
      { rc: 0, body: '{"limit":5000}' },
      { rc: 0, body: JSON.stringify({ choices: [{ message: { content: 'final' } }] }) },
    ]);
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.github.com', method: 'GET', path: '/rate_limit' } }, // no authRef, NOT tainted
          { instruction: 'summarize' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const result = executor.runOrchestrationChain(rtPaths, OPTS, plan, {}, [], {}, Date.now()); // OPTS.tainted === false
    expect(result.status).toBe('success');
    expect(result.steps[0].status).toBe('success');
    expect(calls).toHaveLength(2);
  });

  it('REGRESSION: the tainted guard does not fire for a tainted run when authRef IS set (the trifecta case is handled by the broker, not this guard)', () => {
    const home = makeHome();
    const agentId = 'agent-tainted-with-authref';
    const rtPaths = preparePaths(home, agentId);
    // rc=41 simulates the broker's own APPROVAL_REQUIRED rejection for the
    // trifecta case — proving THIS request actually reached the broker
    // (unlike the no-authRef guard test above, which never does).
    const calls = setupBrokerMock([{ rc: 41, err: 'capability broker: tainted input plus a live secret requires human approval' }]);
    const plan = {
      ...makeBasePlan(home, agentId, 'draft'),
      steps: {
        list: [
          { instruction: 'search', apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search', authRef: 'perplexity' } },
          { instruction: 'never reached' },
        ],
        budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
      },
    };
    const taintedOpts = { ...OPTS, tainted: true };
    const result = executor.runOrchestrationChain(rtPaths, taintedOpts, plan, {}, [], {}, Date.now());
    expect(result.status).toBe('error');
    expect(calls).toHaveLength(1); // reached the broker (unlike the no-authRef case)
    expect(result.steps[0].outputPreview).not.toMatch(/no credential is refused on a tainted/);
  });
});

describe('dispatchActionTrusted — action.type === "api-call" (broker mocked)', () => {
  function apiCallPlan(home: string, agentId: string, apiCall: Record<string, unknown>) {
    return { ...makeBasePlan(home, agentId, 'api-call'), action: { type: 'api-call', apiCall } };
  }

  it('success: writes the response as a draft and fires a success notification', () => {
    const home = makeHome();
    const agentId = 'agent-dispatch-success';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 0, body: '{"result":"the api response"}' }]);
    const plan = apiCallPlan(home, agentId, { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' });

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('success');
    expect(result.preview).toContain('the api response');

    const notification = JSON.parse(fs.readFileSync(rtPaths.notifyFile, 'utf8'));
    expect(notification.status).toBe('success');
    expect(notification.preview).toContain('the api response');

    // A draft was actually written (reuses writeDraftOutputs — no new
    // persistence mechanism), via the mocked fs.write real-copy shim.
    const outputDir = path.join(home, 'agent-output');
    expect(fs.existsSync(outputDir)).toBe(true);
    const files = fs.readdirSync(outputDir, { recursive: true } as any).filter((f: any) => String(f).endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    const draftContent = fs.readFileSync(path.join(outputDir, String(files[0])), 'utf8');
    expect(draftContent).toContain('the api response');
  });

  it('missing apiCall config -> clean error, no notification of success', () => {
    const home = makeHome();
    const agentId = 'agent-missing-config';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([]);
    const plan = { ...makeBasePlan(home, agentId, 'api-call'), action: { type: 'api-call' } }; // no apiCall at all

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('error');
    const notification = JSON.parse(fs.readFileSync(rtPaths.notifyFile, 'utf8'));
    expect(notification.status).toBe('error');
    // No draft was ever written for a missing config.
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
  });

  it('empty response -> clean error, no partial draft', () => {
    const home = makeHome();
    const agentId = 'agent-empty-dispatch';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 0, body: '' }]);
    const plan = apiCallPlan(home, agentId, { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' });

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('error');
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
  });

  it('broker failure -> clean error, no partial draft', () => {
    const home = makeHome();
    const agentId = 'agent-broker-fail-dispatch';
    const rtPaths = preparePaths(home, agentId);
    setupBrokerMock([{ rc: 1, err: 'network unreachable' }]);
    const plan = apiCallPlan(home, agentId, { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' });

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/network unreachable/);
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
  });

  // SECURITY (2026-07-16 adversarial review finding): the terminal-action
  // (single-step / final-step) dispatch path is guarded by the SAME
  // tainted+no-authRef check as the non-final chain-step path — this proves
  // it applies uniformly, not just in runOrchestrationChain.
  it('SECURITY: a tainted terminal api-call action with NO authRef is refused BEFORE the broker is ever invoked', () => {
    const home = makeHome();
    const agentId = 'agent-dispatch-tainted-no-authref';
    const rtPaths = preparePaths(home, agentId);
    const calls = setupBrokerMock([]); // no responses queued — the broker must never be called
    const plan = apiCallPlan(home, agentId, { host: 'api.github.com', method: 'GET', path: '/rate_limit' }); // no authRef

    const taintedOpts = { ...OPTS, tainted: true };
    const result = executor.dispatchActionTrusted(rtPaths, taintedOpts, plan, {}, [], 'the prompt result', {});

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/no credential is refused on a tainted/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
  });
});

describe('dispatchActionTrusted — api-call approval-request payload (Track F, docs/superpowers/DEFERRED.md)', () => {
  function apiCallPlan(home: string, agentId: string, apiCall: Record<string, unknown>) {
    return { ...makeBasePlan(home, agentId, 'api-call'), action: { type: 'api-call', apiCall } };
  }

  // jest doesn't auto-restore spies across `it` blocks in this file (no
  // restoreMocks configured), so each test restores its own spy explicitly.
  const afterAllSpies: jest.SpyInstance[] = [];
  afterEach(() => {
    while (afterAllSpies.length) afterAllSpies.pop()!.mockRestore();
  });

  /** Intercepts the ONE fs.writeFileSync call requestActionApproval makes
   *  into paths.actionApprovalDir (via writeAtomic's tmp-then-rename), lets
   *  it through to disk for real, captures the parsed request, and
   *  synchronously plants a matching "accept" reply — unblocking
   *  requestActionApproval's poll loop on its very first iteration so the
   *  synchronous dispatchActionTrusted call under test returns immediately
   *  instead of blocking for the real approval timeout. Mirrors the
   *  requestSha256 the naive accept-path actually checks: sha256 of the
   *  EXACT bytes written to the request file (writeAtomic renames the tmp
   *  file with no content change, so hashing the written string here equals
   *  the executor's own sha256File(requestFile)). */
  function captureApprovalRequest(rtPaths: any): { get: () => any } {
    // `import * as fs from 'fs'` resolves to a genuine ES module namespace
    // object under this project's ts-jest config — its properties are
    // non-configurable accessor getters (no setter), so `jest.spyOn(fs, ...)`
    // throws "Cannot redefine property" here even though it's the FIRST spy
    // in the file (verified: TypeError comes from Object.defineProperty
    // itself, not a double-spy/missing-restore issue). `require('fs')`
    // returns the real, mutable CommonJS module.exports object instead — the
    // SAME singleton the executor code under test also gets via its own
    // `require('fs')`, so spying on it here still intercepts those calls.
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
          decision: 'accept',
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

  it('includes destinationHost, destinationHostAllowlisted=true, and a "METHOD /resolved/path" command — the fields NotificationDispatcher.kt\'s "api-call" branch reads', () => {
    const home = makeHome();
    const agentId = 'agent-approval-payload';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    setupBrokerMock([{ rc: 0, body: '{"ok":true}' }]);
    const plan = apiCallPlan(home, agentId, {
      host: 'api.example.com',
      method: 'GET',
      path: '/v1/search?q={{result}}',
    });
    // Force the approval-tap path (mirrors requireActionApprovalTap's
    // per-agent override) so requestActionApproval actually writes a
    // request file instead of maybeRequestActionApproval's unattended skip.
    (plan.agent as any).requireActionApproval = true;

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q1', {});

    expect(result.status).toBe('success');
    const request = capture.get();
    expect(request).not.toBeNull();
    expect(request.actionType).toBe('api-call');
    expect(request.destinationHost).toBe('api.example.com');
    expect(request.destinationHostAllowlisted).toBe(true);
    // The path is the RESOLVED one ({{result}} substituted, URL-encoded),
    // not the raw authored template — the approver sees the real request.
    expect(request.command).toBe('GET /v1/search?q=q1');
  });

  it('a POST api-call also carries method+path in `command` (bodyTemplate itself is not echoed into it)', () => {
    const home = makeHome();
    const agentId = 'agent-approval-payload-post';
    const rtPaths = preparePaths(home, agentId);
    const capture = captureApprovalRequest(rtPaths);
    setupBrokerMock([{ rc: 0, body: '{"ok":true}' }]);
    const plan = apiCallPlan(home, agentId, {
      host: 'api.example.com',
      method: 'POST',
      path: '/v1/index',
      bodyTemplate: '{"q":"{{result}}"}',
    });
    (plan.agent as any).requireActionApproval = true;

    const result = executor.dispatchActionTrusted(rtPaths, OPTS, plan, {}, [], 'q1', {});

    expect(result.status).toBe('success');
    const request = capture.get();
    expect(request.command).toBe('POST /v1/index');
  });
});
