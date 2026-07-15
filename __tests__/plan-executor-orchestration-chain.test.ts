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

type StepsField = { list: Array<{ instruction: string }>; budget: { maxSteps: number; totalTimeoutMs: number } } | undefined;

function writePlan(home: string, port: number, opts: { actionType?: string; steps?: StepsField } = {}) {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Chain Smoke', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
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
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
  return planFile;
}

function runExecutor(planFile: string, home: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home },
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
  let responses: string[];

  beforeEach((done) => {
    requestPrompts = [];
    responses = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userContent = parsed.messages[0].content;
        requestPrompts.push(userContent);
        const n = requestPrompts.length;
        const content = responses[n - 1] !== undefined ? responses[n - 1] : `RESULT#${n}`;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
    expect(log.outputPreview).toMatch(/Step 2\/2 failed/);

    // The final step's dispatchActionTrusted was never reached, so this
    // executor's own fallback fired the ONE aggregate notification.
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
});
