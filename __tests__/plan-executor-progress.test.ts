jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { parseProgressJsonl, parseProgressRuns, parseProgressLine } from '@/lib/agent-progress';

// Live progress stream (executor v12, DEFERRED.md「マルチエージェント MONITOR
// ペイン」stage 3): scripts/shelly-plan-executor.js appends one JSON event per
// line to logs/<agentId>/progress.jsonl; lib/agent-progress.ts folds it into
// a MonitorRun. Runs the REAL executor + broker offline against a loopback
// fake model server, like plan-executor-orchestration-chain.test.ts.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-progress-smoke';

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-progress-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

type StepList = Array<{ instruction: string; parallelGroup?: string }>;

function writePlan(home: string, port: number, opts: { steps?: StepList; env?: string } = {}) {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Progress Smoke', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'notify' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'progress-smoke',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    ...(opts.steps ? { steps: { list: opts.steps, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } } } : {}),
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    opts.env !== undefined ? opts.env.replace('{port}', String(port)) : `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
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

const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
const progressFile = (home: string) => path.join(logDir(home), 'progress.jsonl');

function readEvents(home: string): any[] {
  return fs.readFileSync(progressFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readRunLog(home: string): any {
  const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
}

function assertCommonShape(events: any[]) {
  const runId = events[0].runId;
  events.forEach((e, i) => {
    expect(e.v).toBe(1);
    expect(e.runId).toBe(runId);
    expect(e.agentId).toBe(AGENT_ID);
    expect(e.seq).toBe(i + 1); // monotonic, gap-free per run
    expect(typeof e.ts).toBe('string');
    if (e.kind !== 'run_start' && e.kind !== 'run_end') {
      expect(Number.isInteger(e.stepIndex)).toBe(true);
      expect(e.branchId).toBe(`${runId}#${e.stepIndex}`);
    }
  });
  expect(events[0].kind).toBe('run_start');
  expect(events[events.length - 1].kind).toBe('run_end');
}

function statesFor(events: any[], stepIndex: number): string[] {
  return events.filter((e) => e.kind === 'branch_state' && e.stepIndex === stepIndex).map((e) => e.state);
}

describe('shelly-plan-executor.js live progress stream (v12)', () => {
  let server: http.Server;
  let port = 0;
  let responseByInstruction: Record<string, string>;
  let delayByInstruction: Record<string, number>;
  let usageByInstruction: Record<string, unknown>;

  beforeEach((done) => {
    responseByInstruction = {};
    delayByInstruction = {};
    usageByInstruction = {};
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const userContent = JSON.parse(body).messages[0].content as string;
        const instruction = Object.keys(responseByInstruction).find((c) => userContent.includes(c));
        const content = instruction ? responseByInstruction[instruction] : 'plain result';
        const usage = instruction ? usageByInstruction[instruction] : undefined;
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }));
        }, instruction ? delayByInstruction[instruction] || 0 : 0);
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

  it('serial 3-step chain: run_start, STANDBY x3, then RUNNING->tool->usage->tail->DONE per step in order, run_end', async () => {
    const home = makeHome();
    responseByInstruction = { 'gather sources': 'gathered sources', 'draft the body': 'drafted body', 'polish and finalize': 'final polished post' };
    usageByInstruction = { 'gather sources': { prompt_tokens: 11, completion_tokens: 7 } };
    const rc = await runExecutor(writePlan(home, port, { steps: [
      { instruction: 'gather sources' }, { instruction: 'draft the body' }, { instruction: 'polish and finalize' },
    ] }), home);
    expect(rc).toBe(0);

    const events = readEvents(home);
    assertCommonShape(events);
    expect(events[0]).toMatchObject({ mode: 'SERIAL', stepCount: 3, executorVersion: 15 });
    expect(events.slice(1, 4).map((e) => [e.kind, e.stepIndex, e.state])).toEqual([
      ['branch_state', 0, 'STANDBY'], ['branch_state', 1, 'STANDBY'], ['branch_state', 2, 'STANDBY'],
    ]);
    // Strictly sequential: step N settles before step N+1 starts.
    const seqOf = (step: number, state: string) => events.find((e) => e.kind === 'branch_state' && e.stepIndex === step && e.state === state).seq;
    expect(seqOf(0, 'DONE')).toBeLessThan(seqOf(1, 'RUNNING'));
    expect(seqOf(1, 'DONE')).toBeLessThan(seqOf(2, 'RUNNING'));
    for (const step of [0, 1, 2]) expect(statesFor(events, step)).toEqual(['STANDBY', 'RUNNING', 'DONE']);

    const step0 = events.filter((e) => e.stepIndex === 0 && e.kind !== 'branch_state').map((e) => e.kind);
    expect(step0).toEqual(['tool', 'usage', 'tail']);
    expect(events.find((e) => e.kind === 'tool' && e.stepIndex === 0)).toMatchObject({
      tool: 'Local LLM',
      provider: { kind: 'LOCAL', name: 'local', model: 'fixture' },
    });
    expect(events.find((e) => e.kind === 'usage' && e.stepIndex === 0).usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    // No usage reported by the provider -> no usage event (never fabricated).
    expect(events.filter((e) => e.kind === 'usage' && e.stepIndex !== 0)).toHaveLength(0);
    expect(events.find((e) => e.kind === 'tail' && e.stepIndex === 2).tail).toContain('final polished post');
    expect(events[events.length - 1]).toMatchObject({ kind: 'run_end', status: 'success' });
    expect(events.every((e) => e.groupId === undefined)).toBe(true);

    const run = parseProgressJsonl(fs.readFileSync(progressFile(home), 'utf8'))!;
    expect(run.mode).toBe('SERIAL');
    expect(run.status).toBe('success');
    expect(run.endedAt).toBeDefined();
    expect(run.branches.map((b) => b.state)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(run.branches[0].usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(run.branches[0].provider).toEqual({ kind: 'LOCAL', name: 'local', model: 'fixture' });
  }, 20000);

  it('3-branch parallel group: all three RUNNING before any settles, groupId tagged, aggregate step after', async () => {
    const home = makeHome();
    responseByInstruction = { 'branch A': 'A_R', 'branch B': 'B_R', 'branch C': 'C_R', 'aggregate them': 'digest' };
    delayByInstruction = { 'branch A': 1500, 'branch B': 700, 'branch C': 0 };
    const rc = await runExecutor(writePlan(home, port, { steps: [
      { instruction: 'branch A', parallelGroup: 'g' },
      { instruction: 'branch B', parallelGroup: 'g' },
      { instruction: 'branch C', parallelGroup: 'g' },
      { instruction: 'aggregate them' },
    ] }), home);
    expect(rc).toBe(0);

    const events = readEvents(home);
    assertCommonShape(events);
    expect(events[0]).toMatchObject({ mode: 'PARALLEL', stepCount: 4 });
    const running = events.filter((e) => e.kind === 'branch_state' && e.state === 'RUNNING' && e.stepIndex < 3);
    const firstSettle = events.find((e) => e.kind === 'branch_state' && e.state === 'DONE');
    expect(running).toHaveLength(3);
    expect(Math.max(...running.map((e) => e.seq))).toBeLessThan(firstSettle.seq);
    // Completion order follows latency (fast C before slow A), not declared order.
    const doneOrder = events.filter((e) => e.kind === 'branch_state' && e.state === 'DONE').map((e) => e.stepIndex);
    expect(doneOrder.indexOf(2)).toBeLessThan(doneOrder.indexOf(0));
    expect(doneOrder[3]).toBe(3);
    for (const e of events.filter((x) => x.stepIndex !== undefined && x.stepIndex < 3)) expect(e.groupId).toBe('g');
    expect(events.filter((e) => e.stepIndex === 3).every((e) => e.groupId === undefined)).toBe(true);
    const aggregateRunning = events.find((e) => e.kind === 'branch_state' && e.stepIndex === 3 && e.state === 'RUNNING');
    expect(aggregateRunning.seq).toBeGreaterThan(Math.max(...events.filter((e) => e.state === 'DONE' && e.stepIndex < 3).map((e) => e.seq)));

    const run = parseProgressJsonl(fs.readFileSync(progressFile(home), 'utf8'))!;
    expect(run.mode).toBe('PARALLEL');
    expect(run.branches.map((b) => [b.stepIndex, b.groupId, b.state])).toEqual([
      [0, 'g', 'DONE'], [1, 'g', 'DONE'], [2, 'g', 'DONE'], [3, undefined, 'DONE'],
    ]);
    // The run log itself is unchanged by progress.
    expect(readRunLog(home).steps.map((s: any) => s.outputPreview)).toEqual(['A_R', 'B_R', 'C_R', 'digest']);
  }, 20000);

  it('a failing step settles FAILED and steps never launched settle SKIPPED', async () => {
    const home = makeHome();
    // An AI-refusal completion trips the quality gate -> step 0 fails.
    responseByInstruction = { 'first step': 'As an AI, I cannot generate that content.' };
    const rc = await runExecutor(writePlan(home, port, { steps: [{ instruction: 'first step' }, { instruction: 'second step' }] }), home);
    expect(rc).toBe(0);
    const events = readEvents(home);
    assertCommonShape(events);
    expect(statesFor(events, 0)).toEqual(['STANDBY', 'RUNNING', 'FAILED']);
    expect(statesFor(events, 1)).toEqual(['STANDBY', 'SKIPPED']);
    expect(events[events.length - 1].status).not.toBe('success');
  }, 20000);

  it('single-shot run: SINGLE mode, approval wait then timeout settles SKIPPED', async () => {
    const home = makeHome();
    const planFile = writePlan(home, port, { env: "LOCAL_LLM_URL='http://127.0.0.1:{port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='1'\n" });
    const rc = await runExecutor(planFile, home, { SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS: '1' });
    expect(rc).toBe(0);
    const events = readEvents(home);
    assertCommonShape(events);
    expect(events[0]).toMatchObject({ mode: 'SINGLE', stepCount: 1 });
    expect(statesFor(events, 0)).toEqual(['STANDBY', 'RUNNING', 'WAITING_APPROVAL', 'SKIPPED']);
    expect(events[events.length - 1]).toMatchObject({ kind: 'run_end', status: 'skipped' });
    const run = parseProgressJsonl(fs.readFileSync(progressFile(home), 'utf8'))!;
    expect(run.mode).toBe('SINGLE');
    expect(run.branches[0].state).toBe('SKIPPED');
    expect(run.branches[0].tail).toMatch(/timed out/);
  }, 20000);

  it('rotates: keeps only the current run + the previous run', async () => {
    const home = makeHome();
    const planFile = writePlan(home, port);
    for (let i = 0; i < 3; i += 1) expect(await runExecutor(planFile, home)).toBe(0);
    const files = fs.readdirSync(logDir(home)).filter((n) => n.startsWith('progress'));
    expect(files.sort()).toEqual(['progress.jsonl', 'progress.prev.jsonl']);
    const cur = parseProgressRuns(fs.readFileSync(progressFile(home), 'utf8'));
    const prev = parseProgressRuns(fs.readFileSync(path.join(logDir(home), 'progress.prev.jsonl'), 'utf8'));
    expect(cur).toHaveLength(1);
    expect(prev).toHaveLength(1);
    expect(cur[0].runId).not.toBe(prev[0].runId);
  }, 30000);

  it('write failure never breaks the run: progress.jsonl unwritable -> run succeeds, one audit line', async () => {
    const home = makeHome();
    // Both paths are non-empty directories: rotation fails, opening fails.
    fs.mkdirSync(path.join(progressFile(home), 'x'), { recursive: true });
    fs.mkdirSync(path.join(logDir(home), 'progress.prev.jsonl', 'y'), { recursive: true });
    const rc = await runExecutor(writePlan(home, port), home);
    expect(rc).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    const audit = fs.readFileSync(path.join(logDir(home), 'plan-executor-audit.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(audit.filter((e) => e.event === 'progress_write_failed')).toHaveLength(1);
  }, 20000);
});

describe('progress helpers (unit)', () => {
  it('tail is redacted and capped at 240 code points', () => {
    const secret = 'sk-ant-' + 'a'.repeat(40);
    const tail = executor.progressTail(`token ${secret} ` + '日本語'.repeat(200));
    expect(tail).not.toContain(secret);
    expect(tail).toContain('<redacted>');
    expect(Array.from(tail)).toHaveLength(executor.PROGRESS_TAIL_MAX_CHARS);
    expect(executor.PROGRESS_TAIL_MAX_CHARS).toBe(240);
  });

  it('usage is read only from what the provider reports', () => {
    expect(executor.progressUsage('groq', JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }))).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(executor.progressUsage('perplexity', JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: { total_cost: 0.0062 } } })))
      .toEqual({ inputTokens: 3, outputTokens: 4, usd: 0.0062 });
    expect(executor.progressUsage('gemini-api', JSON.stringify({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }))).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(executor.progressUsage('local', JSON.stringify({ choices: [] }))).toBeNull();
    expect(executor.progressUsage('groq', 'not json')).toBeNull();
    expect(executor.progressUsage('groq', JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 'x' } }))).toBeNull();
  });

  it('provider kind / model derivation', () => {
    expect(executor.progressProvider({ type: 'gemini-api' }, { url: 'https://x/v1beta/models/gemini-2.5-flash:generateContent', body: {} }))
      .toEqual({ kind: 'API', name: 'gemini-api', model: 'gemini-2.5-flash' });
    expect(executor.progressProvider({ type: 'local' }, { body: { model: 'Qwen' } })).toEqual({ kind: 'LOCAL', name: 'local', model: 'Qwen' });
    expect(executor.progressProvider({ type: 'cli' }, null)).toEqual({ kind: 'CLI', name: 'cli' });
  });

  it('progressStart into an unwritable location degrades to no-ops without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-progress-unit-'));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const audit = path.join(dir, 'audit.jsonl');
    const paths = { progressFile: path.join(blocker, 'progress.jsonl'), progressPrevFile: path.join(blocker, 'p.jsonl'), planAuditFile: audit };
    const progress = executor.progressStart(paths, { agent: { id: 'a' } }, null);
    expect(() => {
      executor.progressState(progress, 0, 'RUNNING', 'x');
      executor.progressFinish(progress, 'success', undefined, '');
    }).not.toThrow();
    expect(progress.disabled).toBe(true);
    expect(fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('lib/agent-progress.ts reader', () => {
  const ev = (seq: number, kind: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, runId: 'r1', agentId: 'a1', seq, ts: `2026-10-30T00:00:${String(seq).padStart(2, '0')}Z`, kind, ...extra });
  const br = (seq: number, stepIndex: number, extra: Record<string, unknown>) =>
    ev(seq, extra.kind as string || 'branch_state', { stepIndex, branchId: `r1#${stepIndex}`, ...extra });

  it('drops malformed lines, unknown versions and invalid events', () => {
    const text = [
      ev(1, 'run_start', { mode: 'PARALLEL', stepCount: 2 }),
      '{not json',
      '',
      JSON.stringify({ v: 2, runId: 'r1', agentId: 'a1', seq: 2, ts: 't', kind: 'run_end' }),
      br(2, 0, { state: 'BOGUS' }),
      ev(3, 'tool'), // step event without stepIndex
      br(4, 0, { state: 'RUNNING', groupId: 'g' }),
      '{"v":1,"runId":"r1","agentId":"a1","seq":5,"ts":"t","kind":"tail","stepIndex":0,"tail":"partial', // torn write
    ].join('\n');
    const run = parseProgressJsonl(text)!;
    expect(run.mode).toBe('PARALLEL');
    expect(run.endedAt).toBeUndefined();
    expect(run.lastSeq).toBe(4);
    expect(run.branches).toEqual([expect.objectContaining({ stepIndex: 0, groupId: 'g', state: 'RUNNING', branchId: 'r1#0' })]);
    expect(parseProgressLine('[1,2]')).toBeNull();
  });

  it('drops stale / out-of-order / duplicate seq and never reopens a settled branch', () => {
    const text = [
      ev(1, 'run_start', { mode: 'SERIAL', stepCount: 1 }),
      br(2, 0, { state: 'STANDBY' }),
      br(4, 0, { state: 'RUNNING' }),
      br(3, 0, { state: 'FAILED' }), // out of order -> dropped
      br(4, 0, { state: 'DONE' }), // duplicate seq -> dropped
      br(5, 0, { kind: 'tail', tail: 'ok' }),
      br(6, 0, { state: 'DONE' }),
      br(7, 0, { state: 'RUNNING' }), // terminal state is final
      br(8, 0, { kind: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }),
      br(9, 0, { kind: 'usage', usage: { inputTokens: 2, usd: 0.01 } }),
      ev(10, 'run_end', { status: 'success' }),
    ].join('\n');
    const run = parseProgressJsonl(text)!;
    expect(run.status).toBe('success');
    expect(run.branches[0]).toMatchObject({ state: 'DONE', tail: 'ok', usage: { inputTokens: 7, outputTokens: 1, usd: 0.01 } });
    expect(run.branches[0].startedAt).toBe('2026-10-30T00:00:04Z');
    expect(run.branches[0].endedAt).toBe('2026-10-30T00:00:06Z');
  });

  it('separates runs and returns the latest', () => {
    const other = JSON.stringify({ v: 1, runId: 'r2', agentId: 'a1', seq: 1, ts: 't2', kind: 'run_start', mode: 'SINGLE' });
    const runs = parseProgressRuns([ev(1, 'run_start', { mode: 'SERIAL' }), other].join('\n'));
    expect(runs.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(parseProgressJsonl([ev(1, 'run_start'), other].join('\n'))!.mode).toBe('SINGLE');
    expect(parseProgressJsonl('')).toBeNull();
  });
});
