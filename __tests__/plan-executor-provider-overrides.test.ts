/**
 * Provider overrides (executor v16): logs/<id>/overrides.json is applied to a
 * step before it starts; restartRunning aborts only that branch's in-flight
 * request and reruns it on the new provider; a non-dispatchable override is
 * deferred; an explicit paid pin passes the ¥0 continuous filter for that step
 * only. Runs the REAL executor + broker offline against a loopback fake model
 * server (same harness as plan-executor-progress.test.ts).
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
const AGENT_ID = 'agent-overrides';

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-overrides-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  fs.mkdirSync(path.join(home, `.shelly/agents/logs/${AGENT_ID}`), { recursive: true });
  return home;
}

const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);

function writePlan(home: string, port: number, steps: object[], extra: Record<string, unknown> = {}): string {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Overrides', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'orig' },
    toolLadder: [],
    action: { type: 'notify' },
    paths: { home },
    output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'ov', useGlobalOutput: true, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list: steps, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } },
    ...extra,
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`);
  return planFile;
}

function runExecutor(planFile: string, home: string, unattended = false): Promise<number | null> {
  const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker];
  if (unattended) args.push('--unattended', '1');
  const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => child.on('close', (status) => resolve(status)));
}

function readRunLog(home: string): any {
  const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
}

function readEvents(home: string): any[] {
  return fs.readFileSync(path.join(logDir(home), 'progress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readAudit(home: string): any[] {
  const f = path.join(logDir(home), 'plan-executor-audit.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const writeOverrides = (home: string, body: object) =>
  fs.writeFileSync(path.join(logDir(home), 'overrides.json'), JSON.stringify({ v: 1, ...body }));

describe('shelly-plan-executor.js provider overrides (v16)', () => {
  let server: http.Server;
  let port = 0;
  let requests: Array<{ instruction: string; model: string }>;
  let delayByModel: Record<string, number>;
  let delayByInstruction: Record<string, number>;
  let onRequest: ((r: { instruction: string; model: string }) => void) | null;
  const INSTRUCTIONS = ['Branch X', 'Branch Y', 'Step A', 'Step B', 'Final step'];

  beforeEach((done) => {
    requests = [];
    delayByModel = {};
    delayByInstruction = {};
    onRequest = null;
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const content = parsed.messages[0].content as string;
        // The step's own instruction follows "# This step"; earlier results may
        // quote other instructions.
        const own = content.slice(content.lastIndexOf('This step'));
        const instruction = INSTRUCTIONS.find((i) => own.includes(i)) ?? 'unknown';
        const entry = { instruction, model: String(parsed.model) };
        requests.push(entry);
        if (onRequest) onRequest(entry);
        const delay = (delayByModel[entry.model] ?? 0) + (delayByInstruction[instruction] ?? 0);
        setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: `${instruction} answered by ${entry.model}: real content here.` } }] }));
        }, delay);
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

  it('applies an override to a step that has not started yet (and emits a tool event)', async () => {
    const home = makeHome();
    writeOverrides(home, { steps: { '1': { tool: { type: 'local', model: 'new' } } } });
    const planFile = writePlan(home, port, [{ instruction: 'Step A' }, { instruction: 'Step B' }, { instruction: 'Final step' }]);
    expect(await runExecutor(planFile, home)).toBe(0);
    expect(requests).toEqual([
      { instruction: 'Step A', model: 'orig' },
      { instruction: 'Step B', model: 'new' },
      { instruction: 'Final step', model: 'orig' },
    ]);
    const toolEvents = readEvents(home).filter((e) => e.kind === 'tool' && e.stepIndex === 1);
    expect(toolEvents.some((e) => e.provider && e.provider.model === 'new')).toBe(true);
    expect(readAudit(home).some((e) => e.event === 'provider_override_applied' && e.stepIndex === 1)).toBe(true);
    expect(readRunLog(home).status).toBe('success');
  }, 60000);

  it('ignores an override scoped to another run, and defers a Codex override', async () => {
    const home = makeHome();
    writeOverrides(home, { runId: 'some-older-run', steps: { '0': { tool: { type: 'local', model: 'new' } } } });
    let planFile = writePlan(home, port, [{ instruction: 'Step A' }, { instruction: 'Final step' }]);
    expect(await runExecutor(planFile, home)).toBe(0);
    expect(requests.map((r) => r.model)).toEqual(['orig', 'orig']);

    requests = [];
    writeOverrides(home, { steps: { '0': { tool: { type: 'cli', cli: 'codex' } } } });
    planFile = writePlan(home, port, [{ instruction: 'Step A' }, { instruction: 'Final step' }]);
    expect(await runExecutor(planFile, home)).toBe(0);
    expect(requests.map((r) => r.model)).toEqual(['orig', 'orig']);
    expect(readAudit(home).some((e) => e.event === 'provider_override_deferred' && e.toolType === 'cli')).toBe(true);
  }, 60000);

  it('an autonomous plan refuses an API-key override the plan builder never cleared', async () => {
    const home = makeHome();
    writeOverrides(home, { steps: { '0': { tool: { type: 'perplexity' } } } });
    const planFile = writePlan(home, port, [{ instruction: 'Step A' }, { instruction: 'Final step' }], {
      agent: { id: AGENT_ID, name: 'Overrides', autonomous: true, autonomyLevel: 'L2' },
    });
    await runExecutor(planFile, home);
    expect(requests[0]).toEqual({ instruction: 'Step A', model: 'orig' });
    expect(readAudit(home).some((e) => e.event === 'provider_override_refused' && e.toolType === 'perplexity')).toBe(true);
  }, 60000);

  it('restartRunning aborts only that branch and reruns it on the new provider', async () => {
    const home = makeHome();
    delayByModel = { slow: 20000 };
    delayByInstruction = { 'Branch Y': 4000 };
    onRequest = (r) => {
      if (r.instruction === 'Branch X' && r.model === 'slow') {
        writeOverrides(home, { steps: { '0': { tool: { type: 'local', model: 'fast' } } }, restartRunning: [0] });
      }
    };
    const planFile = writePlan(home, port, [
      { instruction: 'Branch X', parallelGroup: 'g', tool: { type: 'local', label: 'Local LLM', model: 'slow' } },
      { instruction: 'Branch Y', parallelGroup: 'g' },
      { instruction: 'Final step' },
    ]);
    const started = Date.now();
    expect(await runExecutor(planFile, home)).toBe(0);
    expect(Date.now() - started).toBeLessThan(18000); // never waited for the slow request
    const byInstruction = (i: string) => requests.filter((r) => r.instruction === i).map((r) => r.model);
    expect(byInstruction('Branch X')).toEqual(['slow', 'fast']);
    expect(byInstruction('Branch Y')).toEqual(['orig']); // the sibling ran exactly once
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps[0].outputPreview).toContain('answered by fast');
    expect(log.steps[1].outputPreview).toContain('Branch Y answered by orig');
    const events = readEvents(home);
    expect(events.some((e) => e.kind === 'tail' && e.stepIndex === 0 && /restarting this step/.test(e.tail))).toBe(true);
    expect(events.filter((e) => e.kind === 'tail' && e.stepIndex === 1 && /restarting/.test(e.tail))).toHaveLength(0);
    expect(readAudit(home).some((e) => e.event === 'provider_override_restart' && e.stepIndex === 0)).toBe(true);
  }, 60000);
});

describe('explicit paid pin under a ¥0 continuous loop (executor)', () => {
  function writeAgentJson(home: string) {
    fs.writeFileSync(
      path.join(home, `.shelly/agents/${AGENT_ID}.json`),
      JSON.stringify({ id: AGENT_ID, prompt: 'Base task', enabled: true, continuous: { cooldownMs: 300000, goalCheck: false, loopStartedAt: 1000 } }),
    );
  }
  const paidSteps = (paidPin: boolean) => [
    { instruction: 'Step A', tool: { type: 'perplexity', label: 'Perplexity API', authRef: 'perplexity' }, ...(paidPin ? { paidPin: true } : {}) },
    { instruction: 'Final step' },
  ];
  const continuous = { continuous: { goalCheck: false, dailyBudgetJpy: 0, loopStartedAt: 1000 } };

  it('a paidPin step reaches its paid provider (here: no key configured), an unpinned one is skipped', async () => {
    const home = makeHome();
    writeAgentJson(home);
    // port 9 is never contacted: the paid call fails at the broker (no secret).
    await runExecutor(writePlan(home, 9, paidSteps(true), continuous), home, true);
    const pinned = readRunLog(home).steps[0].outputPreview as string;
    expect(pinned).toMatch(/no configured secret/i);
    expect(pinned).not.toMatch(/continuous mode/);

    const home2 = makeHome();
    writeAgentJson(home2);
    await runExecutor(writePlan(home2, 9, paidSteps(false), continuous), home2, true);
    expect(readRunLog(home2).steps[0].outputPreview).toMatch(/continuous mode: perplexity is a paid API/);
  }, 60000);
});
