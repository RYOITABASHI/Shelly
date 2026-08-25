jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  buildStepPrompt as tsBuildStepPrompt,
  nextStepGate as tsNextStepGate,
  reduceStatus as tsReduceStatus,
  combineFinalPreview as tsCombineFinalPreview,
} from '@/lib/agent-orchestration';
import type { AgentRunStep } from '@/store/types';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

// Increment 2 (docs/superpowers/DEFERRED.md's 2026-07-15 "P0(c) 設計調査完了"):
// scripts/shelly-plan-executor.js now walks an ORCHESTRATED plan's additive
// `steps` field (Increment 1) as a chain, entirely within one process — no
// JS/native round trip per step, unlike the attended runAgentOrchestrated()
// path this mirrors. This file exercises BOTH the ported pure functions (for
// direct parity with lib/agent-orchestration.ts) and the full run() chain-mode
// branch against the real executor + broker, offline.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

describe('chain-mode pure-function parity with lib/agent-orchestration.ts', () => {
  // Same fixtures as __tests__/agent-orchestration.test.ts's own suites for
  // these functions — run against the JS port to confirm identical behavior
  // for identical inputs, not just a structurally-similar reimplementation.

  describe('nextStepGate', () => {
    const budget = { maxSteps: 3, totalTimeoutMs: 1000 };
    it('proceeds within budget', () => {
      const tsResult = tsNextStepGate({ stepIndex: 0, budget, startedAtMs: 0, now: 10, priorFailed: false });
      const jsResult = executor.nextStepGate({ stepIndex: 0, budget, startedAtMs: 0, now: 10, priorFailed: false });
      expect(jsResult).toEqual(tsResult);
      expect(jsResult.proceed).toBe(true);
    });
    it('stops when the prior step failed', () => {
      const opts = { stepIndex: 1, budget, startedAtMs: 0, now: 10, priorFailed: true };
      expect(executor.nextStepGate(opts)).toEqual(tsNextStepGate(opts));
      expect(executor.nextStepGate(opts).reason).toMatch(/previous step failed/);
    });
    it('stops at the step budget', () => {
      const opts = { stepIndex: 3, budget, startedAtMs: 0, now: 10, priorFailed: false };
      expect(executor.nextStepGate(opts)).toEqual(tsNextStepGate(opts));
      expect(executor.nextStepGate(opts).reason).toMatch(/step budget/);
    });
    it('stops when the time budget is exceeded', () => {
      const opts = { stepIndex: 0, budget, startedAtMs: 0, now: 2000, priorFailed: false };
      expect(executor.nextStepGate(opts)).toEqual(tsNextStepGate(opts));
      expect(executor.nextStepGate(opts).reason).toMatch(/time budget/);
    });
  });

  describe('buildStepPrompt', () => {
    it('carries prior results then the step instruction, identically to the TS original', () => {
      const tsOut = tsBuildStepPrompt('Base task', 'do step 2', ['result of step 1']);
      const jsOut = executor.buildStepPrompt('Base task', 'do step 2', ['result of step 1']);
      expect(jsOut).toBe(tsOut);
      expect(jsOut).toContain('Base task');
      expect(jsOut).toContain('result of step 1');
      expect(jsOut.indexOf('result of step 1')).toBeLessThan(jsOut.indexOf('do step 2'));
    });
    it('omits the results block on the first step', () => {
      expect(executor.buildStepPrompt('Base', 'step 1', [])).toBe(tsBuildStepPrompt('Base', 'step 1', []));
      expect(executor.buildStepPrompt('Base', 'step 1', [])).not.toContain('previous steps');
    });
    it('bounds the prompt length identically (MAX_PROMPT_CHARS = 6000)', () => {
      const tsOut = tsBuildStepPrompt('x'.repeat(9000), 'y', ['z'.repeat(9000)]);
      const jsOut = executor.buildStepPrompt('x'.repeat(9000), 'y', ['z'.repeat(9000)]);
      expect(jsOut).toBe(tsOut);
      expect(jsOut.length).toBeLessThanOrEqual(6000);
    });
    // 2026-08-04: the unattended PlanSpec-executor path (this file) carries
    // its own hand-ported buildStepPrompt — a THIRD copy of the same
    // truncation logic alongside lib/agent-orchestration.ts's original and
    // lib/agent-executor.ts's bash mirror (codex_orch_build_prompt). All
    // three had the identical bug: slicing the full composite from the front
    // could silently drop the current step's own instruction on a long
    // enough carried-results block. Locks parity on the fix, not just the
    // old truncate-from-the-front behavior.
    it('never truncates away the current step instruction, identically to the TS original', () => {
      const priorResults = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(1500)];
      const tsOut = tsBuildStepPrompt('Base task', '通知して', priorResults);
      const jsOut = executor.buildStepPrompt('Base task', '通知して', priorResults);
      expect(jsOut).toBe(tsOut);
      expect(jsOut.endsWith('# This step\n通知して')).toBe(true);
    });
  });

  describe('reduceStatus / combineFinalPreview', () => {
    const step = (over: Partial<AgentRunStep>): AgentRunStep => ({
      index: 0, instruction: 'i', status: 'success', durationMs: 1, outputPreview: 'o', ...over,
    });
    it('any error -> error, identically to the TS original', () => {
      const records = [step({ status: 'success' }), step({ status: 'error' })];
      expect(executor.reduceStatus(records)).toBe(tsReduceStatus(records));
      expect(executor.reduceStatus(records)).toBe('error');
    });
    it('all success -> success; empty -> skipped', () => {
      expect(executor.reduceStatus([step({}), step({})])).toBe(tsReduceStatus([step({}), step({})]));
      expect(executor.reduceStatus([])).toBe(tsReduceStatus([]));
      expect(executor.reduceStatus([])).toBe('skipped');
    });
    it('a transient step reduces to unavailable, not error (breaker exclusion) — matches TS precedence', () => {
      const mixed = [step({ status: 'success' }), step({ status: 'unavailable' })];
      expect(executor.reduceStatus(mixed)).toBe(tsReduceStatus(mixed));
      expect(executor.reduceStatus(mixed)).toBe('unavailable');
      const hardWins = [step({ status: 'unavailable' }), step({ status: 'error' })];
      expect(executor.reduceStatus(hardWins)).toBe(tsReduceStatus(hardWins));
      expect(executor.reduceStatus(hardWins)).toBe('error');
    });
    it('preview reports the failing step identically', () => {
      const records = [step({ index: 1, status: 'error', outputPreview: 'boom' })];
      expect(executor.combineFinalPreview(records)).toBe(tsCombineFinalPreview(records));
      expect(executor.combineFinalPreview(records)).toMatch(/Step 2.*failed.*boom/);
    });
    it('preview reports a transient step as temporarily unavailable, not failed', () => {
      const records = [
        step({ index: 0, status: 'success', outputPreview: 'ok' }),
        step({ index: 1, status: 'unavailable', outputPreview: 'Gemini 503' }),
      ];
      expect(executor.combineFinalPreview(records)).toBe(tsCombineFinalPreview(records));
      expect(executor.combineFinalPreview(records)).toMatch(/Step 2.*unavailable.*Gemini 503/);
    });
  });
});

describe('resolveStepBudget — defensive re-clamp of the on-disk budget', () => {
  it('uses defaults when the budget object is missing entirely', () => {
    expect(executor.resolveStepBudget(undefined)).toEqual({ maxSteps: 6, totalTimeoutMs: 30 * 60_000 });
  });
  it('passes through a well-formed in-range budget unchanged', () => {
    expect(executor.resolveStepBudget({ maxSteps: 3, totalTimeoutMs: 60_000 })).toEqual({ maxSteps: 3, totalTimeoutMs: 60_000 });
  });
  it('clamps an over-large maxSteps to HARD_MAX_STEPS (10) — a stale/corrupt plan cannot widen the ceiling', () => {
    expect(executor.resolveStepBudget({ maxSteps: 999, totalTimeoutMs: 60_000 }).maxSteps).toBe(10);
  });
  it('clamps an over-large totalTimeoutMs to HARD_TOTAL_TIMEOUT_MS (1h)', () => {
    expect(executor.resolveStepBudget({ maxSteps: 3, totalTimeoutMs: 999 * 60_000 }).totalTimeoutMs).toBe(60 * 60_000);
  });
  it('floors maxSteps at 1 (zero/negative/NaN never disables the chain outright)', () => {
    expect(executor.resolveStepBudget({ maxSteps: 0, totalTimeoutMs: 60_000 }).maxSteps).toBe(1);
    expect(executor.resolveStepBudget({ maxSteps: -5, totalTimeoutMs: 60_000 }).maxSteps).toBe(1);
    expect(executor.resolveStepBudget({ maxSteps: NaN, totalTimeoutMs: 60_000 }).maxSteps).toBe(6);
  });
});

// ─── End-to-end: run() chain-mode branch against the real executor + broker ──

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-chain-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

const AGENT_ID = 'agent-chain-smoke';

type StepsField = {
  list: Array<{ instruction: string; apiCall?: { host: string; method: 'GET' | 'POST'; path: string; authRef?: string; bodyTemplate?: string }; tool?: { type: string; model?: string; cli?: string }; parallelGroup?: string }>;
  budget: { maxSteps: number; totalTimeoutMs: number };
} | undefined;

function writePlan(home: string, port: number, opts: { actionType?: string; steps?: StepsField; toolModel?: string } = {}) {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Chain Smoke', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: opts.toolModel || 'fixture' },
    // Default action is 'notify', not 'draft': dispatchActionTrusted's 'draft'
    // branch goes through writeDraftOutputs -> the capability broker's fs.write
    // op, which is a PRE-EXISTING Windows-environment-specific failure mode
    // unrelated to chain-mode (see __tests__/plan-executor-orchestration.test.ts
    // in this repo's own known-Windows-failing-suite list). 'notify' exercises
    // the exact same dispatchActionTrusted call, quality gate, and
    // writeNotification epilogue this increment is responsible for, without
    // depending on that orthogonal, already-tracked filesystem path. Tests that
    // specifically need 'draft' semantics (its own draft-vs-notify message
    // text) pass `actionType: 'draft'` explicitly and only do so where the
    // scenario never reaches a REAL (non-best-effort) draft write.
    action: { type: opts.actionType || 'notify' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'chain-smoke',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    ...(opts.steps ? { steps: opts.steps } : {}),
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  // Fable5 review 2026-08-25 flipped the default action-approval mode to
  // manual-unless-explicitly-opted-out — without this line, requestActionApproval()
  // in the real subprocess spawned below actually waits for an approval
  // reply that never comes, and these tests are about chain-mode
  // orchestration mechanics, not the approval gate itself.
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
  );
  return planFile;
}

function runExecutor(planFile: string, home: string, envOverride: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (status) => resolve(status));
  });
}

function readRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const files = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8'));
}

function readNotification(home: string): any {
  const notifyFile = path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`);
  return JSON.parse(fs.readFileSync(notifyFile, 'utf8'));
}

describe('shelly-plan-executor.js run() — chain mode (Increment 2)', () => {
  let server: http.Server;
  let port = 0;
  let requestPrompts: string[];
  let requestModels: string[];
  let responses: string[];
  let responseByInstruction: Record<string, string>;
  let delayByInstruction: Record<string, number>;

  beforeEach((done) => {
    requestPrompts = [];
    requestModels = [];
    responses = [];
    responseByInstruction = {};
    delayByInstruction = {};
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userContent = parsed.messages[0].content;
        requestPrompts.push(userContent);
        requestModels.push(parsed.model);
        const n = requestPrompts.length;
        const instruction = Object.keys(responseByInstruction).find((candidate) => userContent.includes(candidate));
        const content = instruction
          ? responseByInstruction[instruction]
          : (responses[n - 1] !== undefined ? responses[n - 1] : `RESULT#${n}`);
        const delayMs = instruction ? (delayByInstruction[instruction] || 0) : 0;
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        }, delayMs);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('(a) REGRESSION: a plan with no `steps` field is untouched — one request, no `steps` key in the run log', async () => {
    const home = makeHome();
    const rc = await runExecutor(writePlan(home, port), home);
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(1);
    expect(requestPrompts[0]).toBe('Base task');
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.executor).toBe('planspec');
    expect('steps' in log).toBe(false);
    // notify succeeded -> exactly one notification, from dispatchActionTrusted itself.
    expect(readNotification(home).status).toBe('success');
  }, 20000);

  it('(b) a 3-step chain sequences correctly: non-final steps are suppressed, only the final step dispatches', async () => {
    const home = makeHome();
    responses = ['gathered sources', 'drafted body', 'final polished post'];
    const steps: StepsField = {
      list: [{ instruction: 'gather sources' }, { instruction: 'draft the body' }, { instruction: 'polish and finalize' }],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    expect(rc).toBe(0);

    // Three model calls, one per step, each carrying the prior steps' results.
    expect(requestPrompts).toHaveLength(3);
    expect(requestPrompts[0]).toBe('Base task\n\n# This step\ngather sources');
    expect(requestPrompts[1]).toContain('gathered sources');
    expect(requestPrompts[1]).toContain('draft the body');
    expect(requestPrompts[2]).toContain('gathered sources');
    expect(requestPrompts[2]).toContain('drafted body');
    expect(requestPrompts[2]).toContain('polish and finalize');

    // Exactly one notification, carrying the FINAL step's content (not an
    // intermediate suppressed step's) — dispatchActionTrusted's own 'notify'
    // success branch, reached only for the last step.
    const notification = readNotification(home);
    expect(notification.status).toBe('success');
    expect(notification.preview).toContain('final polished post');

    // Aggregate run log carries per-step detail (mirrors AgentRunLog.steps).
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps).toHaveLength(3);
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success']);
    expect(log.steps[2].outputPreview).toContain('final polished post');
  }, 20000);

  it('(c) a low-quality completion at a NON-final step stops the chain before it can poison later steps', async () => {
    const home = makeHome();
    responses = ['gathered sources', 'As an AI, I cannot generate that content.', 'never reached'];
    const steps: StepsField = {
      list: [{ instruction: 'gather sources' }, { instruction: 'draft the body' }, { instruction: 'polish and finalize' }],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home);
    expect(rc).toBe(0);

    // The chain stopped after the bad step 2 — step 3's model call never happened.
    expect(requestPrompts).toHaveLength(2);

    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(2);
    expect(log.steps[0].status).toBe('success');
    expect(log.steps[1].status).toBe('error');
    // 2026-08-03: the denominator is now the chain's PLANNED total (3), not
    // "steps attempted so far" (2) — see combineFinalPreview's doc comment.
    expect(log.outputPreview).toMatch(/Step 2\/3 failed/);

    // The final step's dispatchActionTrusted was never reached, so this
    // executor's own fallback fired the ONE aggregate notification.
    const notification = readNotification(home);
    expect(notification.status).toBe('error');
  }, 20000);

  it('(j) a DUPLICATE-of-prior-step completion at a NON-final step stops the chain before it can poison later steps (2026-08-06 Fable5/Codex Hermes-parity re-review finding)', async () => {
    // Mirrors (c) exactly, but step 2's completion is a near-verbatim repeat
    // of step 1's — the "notify step echoed the summarize step verbatim"
    // shape isDuplicateOfPriorStep exists to catch (see
    // lib/agent-escalation-ladder.ts's doc comment and
    // __tests__/plan-executor-quality-gate.test.ts's direct unit tests for the
    // predicate itself). Before this fix, requestModelContentWithLadder had
    // no priorStepContent wiring at all in the chain loop, so this exact
    // on-device incident shape — a duplicate step slipping past the quality
    // gate and poisoning every later step's prompt — was reproducible via the
    // real executor, not just a unit-level gap.
    const home = makeHome();
    const summary =
      '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。経産省の組織再編も発表された。';
    responses = [summary, summary, 'never reached'];
    const steps: StepsField = {
      list: [{ instruction: 'summarize the news' }, { instruction: 'draft the notification' }, { instruction: 'polish and finalize' }],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home);
    expect(rc).toBe(0);

    // The chain stopped after the duplicate step 2 — step 3's model call never happened.
    expect(requestPrompts).toHaveLength(2);

    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(2);
    expect(log.steps[0].status).toBe('success');
    expect(log.steps[1].status).toBe('error');
    expect(log.outputPreview).toMatch(/Step 2\/3 failed/);

    const notification = readNotification(home);
    expect(notification.status).toBe('error');
  }, 20000);

  it('(d) a low-quality completion at the FINAL step is rejected by dispatchActionTrusted\'s own gate, not silently drafted', async () => {
    const home = makeHome();
    responses = ['gathered sources', "I'm not able to help with that."];
    const steps: StepsField = {
      list: [{ instruction: 'gather sources' }, { instruction: 'write the final post' }],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const outputDir = path.join(home, 'agent-output');
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home);
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(2);

    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(2);
    expect(log.steps[1].status).toBe('error');
    expect(log.outputPreview).toMatch(/prompt echo or AI refusal/);

    // No draft was ever written for the bad final content.
    expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir, { recursive: true } as any).filter((f: any) => String(f).endsWith('.md')) : []).toHaveLength(0);
    expect(readNotification(home).status).toBe('error');
  }, 20000);

  it('(e) budget/step-count enforcement: maxSteps=1 stops the chain after the first step even though more are declared', async () => {
    const home = makeHome();
    responses = ['only step that runs', 'never reached', 'never reached'];
    const steps: StepsField = {
      list: [{ instruction: 'step one' }, { instruction: 'step two' }, { instruction: 'step three' }],
      budget: { maxSteps: 1, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home);
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(1);

    const log = readRunLog(home);
    expect(log.steps).toHaveLength(1);
    expect(log.status).toBe('success');
    expect(log.outputPreview).toMatch(/Completed 1 step\(s\)/);
    // The chain never reached its declared final step, so the fallback
    // notification fired (exactly once) with the partial-chain outcome.
    expect(readNotification(home).status).toBe('success');
  }, 20000);

  it('(e2) an oversized maxSteps in the on-disk budget does not crash or misbehave (defensive re-clamp smoke check)', async () => {
    // The actual clamp-to-HARD_MAX_STEPS(10) VALUE is asserted directly by the
    // "resolveStepBudget" unit tests above; this end-to-end smoke test only
    // confirms a corrupted/stale budget field doesn't break a real run (a
    // 2-step declared list still runs its 2 steps regardless of whether
    // 9999 was clamped, since the loop is bounded by the list length here).
    const home = makeHome();
    responses = ['s1', 's2'];
    const steps: StepsField = {
      list: [{ instruction: 'step one' }, { instruction: 'step two' }],
      budget: { maxSteps: 9999, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(2);
    const log = readRunLog(home);
    expect(log.steps).toHaveLength(2);
    expect(log.status).toBe('success');
  }, 20000);

  // SECURITY-CRITICAL (api-call v1, 2026-07-16): locks in the deliberate
  // omission of `approved: true` in dispatchApiCallRequest
  // (scripts/shelly-plan-executor.js) — see that function's own doc comment.
  // A tainted run (opts.tainted = true, i.e. SHELLY_CAP_TAINTED=1) with an
  // authRef-bound apiCall step against an ALLOWLISTED host must still be
  // REFUSED by the real capability broker's classifyEgress
  // (tainted-secret-spend rule, lib/capability-envelope.ts / mirrored in
  // scripts/shelly-capability-broker.js) — broker rc 41 (APPROVAL_REQUIRED) —
  // NOT silently sent. This exercises the REAL broker (not a mock), so it
  // proves the fail-closed behavior end-to-end, not just in a unit test of
  // the classifier alone. No real network call ever happens: classifyEgress
  // rejects the request before any HTTP is attempted, so this test is fully
  // offline-safe.
  it('(f) SECURITY: a tainted run with an authRef-bound apiCall step against an allowlisted host is REFUSED (broker rc 41), not silently sent', async () => {
    const home = makeHome();
    const steps: StepsField = {
      list: [
        {
          instruction: 'search for sources',
          apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search', authRef: 'perplexity' },
        },
        { instruction: 'never reached' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home, { SHELLY_CAP_TAINTED: '1' });
    expect(rc).toBe(0);

    // Neither step ever reached the local model endpoint: step 0 is an
    // apiCall step (skips modelRequest entirely) and step 1 never launches
    // because step 0 failed (chain stops on first failure).
    expect(requestPrompts).toHaveLength(0);

    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(1);
    expect(log.steps[0].status).toBe('error');
    // The broker's own rc=41 (APPROVAL_REQUIRED) rejection message, redacted
    // and surfaced as this step's failure — not a silent success carrying a
    // real (or fabricated) response forward as if the call had been sent.
    expect(log.steps[0].outputPreview).toMatch(/HTTP broker failed rc=41/);
    expect(readNotification(home).status).toBe('error');
  }, 20000);

  // SECURITY-CRITICAL sibling of (f): 2026-07-16 adversarial review finding.
  // classifyEgress's taint gate only fires when EITHER the host is
  // non-allowlisted OR a secret (authRef) is being spent — it does NOT gate
  // `tainted && !authRef` against an allowlisted host, which falls through to
  // 'allow' (lib/capability-envelope.ts). Every pre-existing broker caller
  // reaching a remote host always sets an authRef, so this combination was
  // unreachable before api-call (the first caller that can legitimately omit
  // authRef while targeting a remote allowlisted host). dispatchApiCallRequest
  // now refuses this case itself (in the executor, before ever calling the
  // broker) rather than widening the shared classifyEgress primitive. This
  // test locks that fix in: a tainted run with NO authRef against a remote
  // allowlisted host must be refused, not silently sent as 'allow' would
  // otherwise permit.
  it('(g) SECURITY: a tainted run with a NO-authRef apiCall step against a remote allowlisted host is REFUSED, not silently allowed', async () => {
    const home = makeHome();
    const steps: StepsField = {
      list: [
        {
          instruction: 'post to public endpoint',
          apiCall: { host: 'api.github.com', method: 'GET', path: '/rate_limit' }, // no authRef
        },
        { instruction: 'never reached' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home, { SHELLY_CAP_TAINTED: '1' });
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(0);

    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(1);
    expect(log.steps[0].status).toBe('error');
    // Refused by the EXECUTOR's own guard, before the broker (and therefore
    // before any real network I/O) is ever invoked — distinct from (f)'s
    // broker-level rc=41 rejection message.
    expect(log.steps[0].outputPreview).toMatch(/no credential is refused on a tainted/);
    expect(readNotification(home).status).toBe('error');
  }, 20000);

  // The "does not over-refuse when non-tainted" regression check for this
  // same guard lives in __tests__/plan-executor-api-call.test.ts (mocked
  // broker) — not here, since a NO-authRef apiCall step that actually
  // proceeds would need a real network response from a real external host to
  // exercise end-to-end, which is not offline-safe.

  // Phase 7 (2026-08-03): a step's own tool pin is now honored here (was
  // unconditionally ignored before — see runOrchestrationChain's own
  // comment). This is the consuming half of the fix; the credential-gating
  // half (a step's tool must already be vetted by resolveForAutonomous
  // before it ever reaches this JSON) is covered separately in
  // __tests__/agent-plan-spec.test.ts's "per-step credential resolution"
  // suite — this executor makes no credential decision, it only dispatches.
  it('(h) a step.tool pin changes which model this executor actually requests — proof step.tool is consumed, not ignored', async () => {
    const home = makeHome();
    responses = ['step-1 result', 'final result'];
    const steps: StepsField = {
      list: [
        { instruction: 'gather sources', tool: { type: 'local', model: 'step-pinned-model' } },
        { instruction: 'finalize' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps, toolModel: 'plan-level-model' }), home);
    expect(rc).toBe(0);
    expect(requestModels).toHaveLength(2);
    // Step 1 carries its OWN pinned model, not the plan-level one.
    expect(requestModels[0]).toBe('step-pinned-model');
    // Step 2 (final, no tool pin) falls back to plan.tool's model, unchanged.
    expect(requestModels[1]).toBe('plan-level-model');
  }, 20000);

  it('(i) a step.tool pinned to `cli` (a type this executor cannot dispatch) falls back to plan.tool instead of failing the run', async () => {
    const home = makeHome();
    responses = ['step-1 result', 'final result'];
    const steps: StepsField = {
      list: [
        { instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } },
        { instruction: 'finalize' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps, toolModel: 'plan-level-model' }), home);
    expect(rc).toBe(0);
    // Both requests went to the local HTTP server (proving `cli` never got
    // dispatched to some other, nonexistent path) and both used plan.tool's
    // model — the step's `cli` pin was inert, not fatal.
    expect(requestModels).toEqual(['plan-level-model', 'plan-level-model']);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
  }, 20000);

  it('(k) FAN-OUT (2026-08-13): branches of a parallel group are context-isolated from each other and aggregated for the post-group step', async () => {
    const home = makeHome();
    responseByInstruction = {
      'collect the base data': 'BASE_R',
      'research angle A': 'BRANCH_A_R',
      'research angle B': 'BRANCH_B_R',
      'aggregate everything': 'final digest',
    };
    const steps: StepsField = {
      list: [
        { instruction: 'collect the base data' },
        { instruction: 'research angle A', parallelGroup: 'research' },
        { instruction: 'research angle B', parallelGroup: 'research' },
        { instruction: 'aggregate everything' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    expect(rc).toBe(0);

    expect(requestPrompts).toHaveLength(4);
    const branchAPrompt = requestPrompts.find((prompt) => prompt.includes('research angle A'))!;
    const branchBPrompt = requestPrompts.find((prompt) => prompt.includes('research angle B'))!;
    const aggregatePrompt = requestPrompts.find((prompt) => prompt.includes('aggregate everything'))!;
    // Both branches see the same pre-group snapshot, regardless of arrival order.
    expect(branchAPrompt).toContain('BASE_R');
    expect(branchAPrompt).not.toContain('BRANCH_B_R');
    expect(branchBPrompt).toContain('BASE_R');
    expect(branchBPrompt).not.toContain('BRANCH_A_R');
    // The post-group (final) step aggregates every branch result, in declared
    // order (buildStepPrompt labels: base = Step 1, A = Step 2, B = Step 3).
    expect(aggregatePrompt).toContain('BRANCH_A_R');
    expect(aggregatePrompt).toContain('BRANCH_B_R');
    expect(aggregatePrompt).toMatch(/## Step 2[\s\S]{0,40}BRANCH_A_R/);
    expect(aggregatePrompt).toMatch(/## Step 3[\s\S]{0,40}BRANCH_B_R/);

    // The aggregate run log records which steps ran as branches.
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.parallelGroup)).toEqual([undefined, 'research', 'research', undefined]);
  }, 20000);

  it('(k2) FAN-OUT concurrency proof: three delayed branches complete near max latency, not summed latency', async () => {
    const home = makeHome();
    responseByInstruction = {
      'slow branch A': 'BRANCH_A_R',
      'slow branch B': 'BRANCH_B_R',
      'slow branch C': 'BRANCH_C_R',
      'aggregate delayed branches': 'final digest',
    };
    delayByInstruction = { 'slow branch A': 700, 'slow branch B': 700, 'slow branch C': 700 };
    const steps: StepsField = {
      list: [
        { instruction: 'slow branch A', parallelGroup: 'slow' },
        { instruction: 'slow branch B', parallelGroup: 'slow' },
        { instruction: 'slow branch C', parallelGroup: 'slow' },
        { instruction: 'aggregate delayed branches' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const started = Date.now();
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    const elapsedMs = Date.now() - started;
    console.info(`[concurrency-proof] elapsedMs=${elapsedMs} (three branches x 700ms)`);

    expect(rc).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(650);
    expect(elapsedMs).toBeLessThan(1800);
    const log = readRunLog(home);
    expect(log.steps.map((step: any) => step.outputPreview)).toEqual([
      'BRANCH_A_R', 'BRANCH_B_R', 'BRANCH_C_R', 'final digest',
    ]);
  }, 20000);

  it('(k3) SECURITY: every tainted apiCall branch is independently refused before the next step dispatches', async () => {
    const home = makeHome();
    const steps: StepsField = {
      list: [
        { instruction: 'tainted branch A', apiCall: { host: 'api.github.com', method: 'GET', path: '/a' }, parallelGroup: 'tainted' },
        { instruction: 'tainted branch B', apiCall: { host: 'api.github.com', method: 'GET', path: '/b' }, parallelGroup: 'tainted' },
        { instruction: 'tainted branch C', apiCall: { host: 'api.github.com', method: 'GET', path: '/c' }, parallelGroup: 'tainted' },
        { instruction: 'must never dispatch' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home, { SHELLY_CAP_TAINTED: '1' });

    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(0);
    const log = readRunLog(home);
    expect(log.steps).toHaveLength(3);
    expect(log.steps.map((step: any) => step.status)).toEqual(['error', 'error', 'error']);
    expect(log.steps.every((step: any) => /no credential is refused on a tainted/.test(step.outputPreview))).toBe(true);
  }, 20000);

  it('(k4) FAN-OUT fail-fast waits for in-flight siblings, then halts before the next step', async () => {
    const home = makeHome();
    responseByInstruction = {
      'failing branch': 'As an AI, I cannot generate that content.',
      'slow successful sibling': 'SLOW_SIBLING_FINISHED',
      'must not run after failed group': 'unexpected',
    };
    delayByInstruction = { 'slow successful sibling': 450 };
    const steps: StepsField = {
      list: [
        { instruction: 'failing branch', parallelGroup: 'atomic' },
        { instruction: 'slow successful sibling', parallelGroup: 'atomic' },
        { instruction: 'must not run after failed group' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const started = Date.now();
    const rc = await runExecutor(writePlan(home, port, { actionType: 'draft', steps }), home);
    const elapsedMs = Date.now() - started;

    expect(rc).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(400);
    expect(requestPrompts.some((prompt) => prompt.includes('must not run after failed group'))).toBe(false);
    const log = readRunLog(home);
    expect(log.steps).toHaveLength(2);
    expect(log.steps.map((step: any) => step.status)).toEqual(['error', 'success']);
    expect(log.steps[1].outputPreview).toBe('SLOW_SIBLING_FINISHED');
  }, 20000);

  it('(l) FAN-OUT: two branches legitimately producing near-identical output are NOT duplicate-failed against each other (contrast with (j))', async () => {
    const home = makeHome();
    const similarResearch =
      '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。経産省の組織再編も発表された。';
    // Branch B returns the SAME >= 20-char text as branch A — in a serial
    // chain (case (j)) this is exactly what isDuplicateOfPriorStep rejects;
    // as sibling branches it must pass, because each branch is compared only
    // against the last PRE-group result.
    responses = ['BASE_R', similarResearch, similarResearch, 'final digest'];
    const steps: StepsField = {
      list: [
        { instruction: 'collect the base data' },
        { instruction: 'research angle A', parallelGroup: 'research' },
        { instruction: 'research angle B', parallelGroup: 'research' },
        { instruction: 'aggregate everything' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    expect(rc).toBe(0);
    expect(requestPrompts).toHaveLength(4);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(readNotification(home).status).toBe('success');
  }, 20000);

  it('(m) FAN-OUT: a marker that only ever reaches the FINAL step is severed — the chain runs serially, records carry no group', async () => {
    const home = makeHome();
    responses = ['step-1 result', 'final result'];
    const steps: StepsField = {
      list: [
        { instruction: 'gather' },
        { instruction: 'finalize', parallelGroup: 'g' },
      ],
      budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 },
    };
    const rc = await runExecutor(writePlan(home, port, { steps }), home);
    expect(rc).toBe(0);
    // Serial carry-forward preserved (the final step still sees step 1).
    expect(requestPrompts[1]).toContain('step-1 result');
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.parallelGroup)).toEqual([undefined, undefined]);
  }, 20000);
});

// ─── Fan-out subtasks (parallel groups, 2026-08-13): pure-function parity ────

describe('fan-out parallel-groups pure-function parity with lib/agent-orchestration.ts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MAX_PARALLEL_BRANCHES: TS_MAX_PARALLEL_BRANCHES, planParallelGroups: tsPlanParallelGroups } =
    require('@/lib/agent-orchestration');

  it('MAX_PARALLEL_BRANCHES is numerically identical', () => {
    expect(executor.MAX_PARALLEL_BRANCHES).toBe(TS_MAX_PARALLEL_BRANCHES);
  });

  const fixtures: Array<{ name: string; steps: Array<{ instruction: string; parallelGroup?: string }> }> = [
    { name: 'all serial', steps: [{ instruction: 'a' }, { instruction: 'b' }, { instruction: 'c' }] },
    {
      name: 'group of two mid-chain',
      steps: [
        { instruction: 'collect' },
        { instruction: 'A', parallelGroup: 'g' },
        { instruction: 'B', parallelGroup: 'g' },
        { instruction: 'aggregate' },
      ],
    },
    {
      name: 'final-step severing',
      steps: [
        { instruction: 'a', parallelGroup: 'g' },
        { instruction: 'b', parallelGroup: 'g' },
        { instruction: 'final', parallelGroup: 'g' },
      ],
    },
    {
      name: 'cap overflow',
      steps: [
        { instruction: 'b1', parallelGroup: 'g' },
        { instruction: 'b2', parallelGroup: 'g' },
        { instruction: 'b3', parallelGroup: 'g' },
        { instruction: 'b4', parallelGroup: 'g' },
        { instruction: 'b5', parallelGroup: 'g' },
        { instruction: 'final' },
      ],
    },
    { name: 'singleton stays serial', steps: [{ instruction: 'a', parallelGroup: 'g' }, { instruction: 'b' }, { instruction: 'c' }] },
    {
      name: 'adjacent different groups',
      steps: [
        { instruction: 'a1', parallelGroup: 'g1' },
        { instruction: 'a2', parallelGroup: 'g1' },
        { instruction: 'b1', parallelGroup: 'g2' },
        { instruction: 'b2', parallelGroup: 'g2' },
        { instruction: 'final' },
      ],
    },
  ];

  for (const { name, steps } of fixtures) {
    it(`planParallelGroups behaves identically for: ${name}`, () => {
      expect(executor.planParallelGroups(steps)).toEqual(tsPlanParallelGroups(steps));
    });
  }

  it('JS-side extra hardening: an invalid group id read from an untrusted on-disk plan is dropped (fail-safe to serial)', () => {
    // The TS original only ever sees normalizeStep-sanitized ids; the JS port
    // re-validates because its input is the raw plan file.
    const plan = executor.planParallelGroups([
      { instruction: 'a', parallelGroup: 'has spaces' },
      { instruction: 'b', parallelGroup: 'has spaces' },
      { instruction: 'final' },
    ]);
    expect(plan.group).toEqual([undefined, undefined, undefined]);
    expect(plan.contextBase).toEqual([0, 1, 2]);
  });

  it('JS-side hardening: ids are trimmed before comparison, matching normalizeStep', () => {
    const plan = executor.planParallelGroups([
      { instruction: 'a', parallelGroup: ' g ' },
      { instruction: 'b', parallelGroup: 'g' },
      { instruction: 'final' },
    ]);
    expect(plan.group).toEqual(['g', 'g', undefined]);
    expect(plan.contextBase).toEqual([0, 0, 2]);
  });
});
