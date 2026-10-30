/**
 * STOP-ALL in flight (2026-10-30, docs/superpowers/DEFERRED.md「STOP-ALL が
 * 実行中のチェーンを止めない」): the unattended PlanSpec executor re-checks the
 * `.halted` sentinel before every serial step, every parallel group, every
 * branch permit and the final action. A chain halted mid-run ends as
 * 'skipped' with the kill-switch message, schedules nothing further, and
 * never fires the final action.
 *
 * The fixture model server writes the sentinel while answering a chosen
 * step's request, i.e. "STOP-ALL pressed while that step was in flight".
 * Harness mirrors __tests__/plan-executor-orchestration-chain.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
const AGENT_ID = 'agent-stop-all';
const KILL_SWITCH_MESSAGE = 'All agents are stopped (global kill-switch is on).';

type Step = { instruction: string; parallelGroup?: string };

const DISTINCT_RESULTS = [
  'gathered sources about harbor tides',
  'drafted body on mountain railways',
  'polished post covering desert botany',
  'notes regarding orbital mechanics',
  'summary of medieval cartography',
];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-halt-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

const sentinel = (home: string) => path.join(home, '.shelly/agents/.halted');

function writePlan(home: string, port: number, steps: Step[] | null, opts: { requireApproval?: boolean } = {}): string {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Stop All', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'notify' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'stop-all',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    ...(steps ? { steps: { list: steps, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } } } : {}),
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='${opts.requireApproval ? '1' : '0'}'\n`,
  );
  return planFile;
}

function startExecutor(planFile: string, home: string, env: Record<string, string> = {}): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<number | null>((resolve) => child.on('close', (status) => resolve(status)));
  return { child, done };
}

function readRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const files = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8'));
}

const readProgress = (home: string): any[] =>
  fs.readFileSync(path.join(home, `.shelly/agents/logs/${AGENT_ID}/progress.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const notificationFile = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`);

describe('shelly-plan-executor.js — STOP-ALL halts an in-flight chain', () => {
  let server: http.Server;
  let port = 0;
  let home: string;
  let requested: string[];
  // Instruction whose request writes the halt sentinel before answering.
  let haltOn: string | null;
  let delayByInstruction: Record<string, number>;
  let onRequest: ((instruction: string) => void) | null;

  beforeEach((done) => {
    home = makeHome();
    requested = [];
    haltOn = null;
    delayByInstruction = {};
    onRequest = null;
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const userContent: string = JSON.parse(body).messages[0].content;
        const instruction = userContent.split('# This step\n').pop() || userContent;
        requested.push(instruction);
        if (haltOn && instruction.includes(haltOn)) fs.writeFileSync(sentinel(home), 'halted\n');
        if (onRequest) onRequest(instruction);
        // Distinct per request so the duplicate-of-prior-step gate never trips.
        const content = DISTINCT_RESULTS[(requested.length - 1) % DISTINCT_RESULTS.length];
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        }, delayByInstruction[instruction] || 0);
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

  it('halts between serial steps: the next step is never requested and the run ends skipped', async () => {
    haltOn = 'serial step one';
    const planFile = writePlan(home, port, [
      { instruction: 'serial step one' },
      { instruction: 'serial step two' },
      { instruction: 'final notify step' },
    ]);
    const rc = await startExecutor(planFile, home).done;

    expect(rc).toBe(0);
    expect(requested).toEqual(['serial step one']);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(log.steps.map((s: any) => s.status)).toEqual(['success']);
    // Final action never fired, and a user-initiated halt does not notify.
    expect(fs.existsSync(notificationFile(home))).toBe(false);
    // The live progress stream ends cleanly: unrun steps SKIPPED, run_end halted.
    const events = readProgress(home);
    expect(events[events.length - 1]).toMatchObject({ kind: 'run_end', status: 'halted' });
    const lastState = (idx: number) => events.filter((e) => e.kind === 'branch_state' && e.stepIndex === idx).pop().state;
    expect([lastState(0), lastState(1), lastState(2)]).toEqual(['DONE', 'SKIPPED', 'SKIPPED']);
  }, 20000);

  it('halts between parallel groups: in-flight siblings settle, the next group never launches', async () => {
    haltOn = 'group one branch A';
    delayByInstruction = { 'group one branch B': 300 };
    const planFile = writePlan(home, port, [
      { instruction: 'group one branch A', parallelGroup: 'one' },
      { instruction: 'group one branch B', parallelGroup: 'one' },
      { instruction: 'group two branch C', parallelGroup: 'two' },
      { instruction: 'group two branch D', parallelGroup: 'two' },
      { instruction: 'final notify step' },
    ]);
    const rc = await startExecutor(planFile, home).done;

    expect(rc).toBe(0);
    expect(requested.sort()).toEqual(['group one branch A', 'group one branch B']);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(log.steps).toHaveLength(2);
    expect(fs.existsSync(notificationFile(home))).toBe(false);
  }, 20000);

  it('halt during the final step generation: the final action is never dispatched', async () => {
    haltOn = 'final notify step';
    const planFile = writePlan(home, port, [
      { instruction: 'serial step one' },
      { instruction: 'final notify step' },
    ]);
    const rc = await startExecutor(planFile, home).done;

    expect(rc).toBe(0);
    expect(requested).toEqual(['serial step one', 'final notify step']);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'skipped']);
    // notify's success branch writes the notification: it must not exist.
    expect(fs.existsSync(notificationFile(home))).toBe(false);
  }, 20000);

  it('a sentinel present before start is still refused up front (regression)', async () => {
    fs.writeFileSync(sentinel(home), 'halted\n');
    const planFile = writePlan(home, port, [{ instruction: 'serial step one' }, { instruction: 'final notify step' }]);
    const rc = await startExecutor(planFile, home).done;
    expect(rc).toBe(0);
    expect(requested).toEqual([]);
    expect(readRunLog(home).status).toBe('skipped');
  }, 20000);

  it('single-shot run: halt during generation skips the dispatch (no action, no notification)', async () => {
    haltOn = 'Base task';
    const planFile = writePlan(home, port, null);
    const rc = await startExecutor(planFile, home).done;

    expect(rc).toBe(0);
    expect(requested).toHaveLength(1);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(fs.existsSync(notificationFile(home))).toBe(false);
    expect(readProgress(home).pop()).toMatchObject({ kind: 'run_end', status: 'halted' });
  }, 20000);

  it('halt during the (event-loop-blocking) approval wait ends the run at once and removes the request file', async () => {
    const approvalDir = path.join(home, '.shelly/agents/action-approvals');
    const planFile = writePlan(home, port, [{ instruction: 'serial step one' }, { instruction: 'final notify step' }], { requireApproval: true });
    const started = Date.now();
    const { done } = startExecutor(planFile, home, { SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS: '60' });
    // STOP-ALL pressed while the final action waits for approval.
    const poll = setInterval(() => {
      try {
        if (fs.readdirSync(approvalDir).some((n) => n.endsWith('.json'))) {
          fs.writeFileSync(sentinel(home), 'halted\n');
          clearInterval(poll);
        }
      } catch (_) {}
    }, 50);
    const rc = await done;
    clearInterval(poll);

    expect(rc).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000); // not the 60s approval timeout
    expect(fs.readdirSync(approvalDir).filter((n) => n.endsWith('.json'))).toEqual([]);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(fs.existsSync(notificationFile(home))).toBe(false);
    expect(readProgress(home).pop()).toMatchObject({ kind: 'run_end', status: 'halted' });
  }, 30000);

  it('registry-lock wait gives up at once when halted instead of blocking ~30s', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const executor = require(scriptCopy);
    const paths = executor.runtimePaths(home, AGENT_ID);
    const registryFile = path.join(home, 'sources', 'source-registry.tsv');
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.mkdirSync(`${registryFile}.lock`); // held by someone else
    fs.writeFileSync(paths.resultFile, 'see https://example.com/a\n');
    fs.writeFileSync(sentinel(home), 'halted\n');
    const started = Date.now();
    executor.registerSourceUrls(paths, { SOURCE_REGISTRY_FILE: registryFile }, { agent: { id: AGENT_ID }, tool: { label: 'x' } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fs.existsSync(registryFile)).toBe(false);
    // The foreign lock is not ours to remove.
    expect(fs.existsSync(`${registryFile}.lock`)).toBe(true);
  });

  // Windows has no catchable SIGTERM (child.kill terminates outright), so the
  // handler can only be exercised on POSIX hosts / CI.
  (process.platform === 'win32' ? it.skip : it)('SIGTERM mid-step: records skipped, releases the pid lock, exits 0 (native must not see a hard failure)', async () => {
    delayByInstruction = { 'slow step': 10_000 };
    const planFile = writePlan(home, port, [{ instruction: 'slow step' }, { instruction: 'final notify step' }]);
    const { child, done } = startExecutor(planFile, home);
    onRequest = () => {
      fs.writeFileSync(sentinel(home), 'halted\n');
      child.kill('SIGTERM');
    };
    const rc = await done;

    expect(rc).toBe(0);
    expect(fs.existsSync(path.join(home, `.shelly/agents/locks/${AGENT_ID}.pid`))).toBe(false);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toBe(KILL_SWITCH_MESSAGE);
    expect(requested).toEqual(['slow step']);
    expect(readProgress(home).pop()).toMatchObject({ kind: 'run_end', status: 'halted' });
  }, 20000);
});
