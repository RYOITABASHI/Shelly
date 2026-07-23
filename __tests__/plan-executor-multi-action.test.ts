jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { Agent } from '@/store/types';

// Multi-action fan-out (2026-07-23, Agent.actions — see its own doc comment in
// store/types.ts). These tests exercise scripts/shelly-plan-executor.js's
// dispatchActionsTrusted end-to-end (real subprocess, real approval-file
// round trip) — the strongest black-box evidence this repo's test suite has
// for "one action's decline/failure does not stop the other" and "each
// action is gated/dispatched completely independently".

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-multi-action-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function writePlan(home: string, agentId: string, actions: unknown[] | undefined): { planFile: string } {
  const plan: Record<string, unknown> = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: agentId, name: 'Multi Action', autonomous: true, autonomyLevel: 'L2', requireActionApproval: true },
    prompt: 'say hello',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    ...(actions ? { actions } : {}),
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'multi-action',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return { planFile };
}

function writeLocalEnv(home: string, port: number): void {
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
}

function runExecutor(args: string[], home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for the NEXT pending action-approval request file NOT already in
 *  `seen`, reads + hashes it, and marks its filename seen. Each action's own
 *  unique runId (the very fix this feature needed, see requestActionApproval's
 *  own comment) guarantees a FRESH request never collides with an earlier
 *  one's filename — but the executor's own poll loop only checks for a reply
 *  every ~500ms (requestActionApproval's sleepMs(500)), so the JUST-ANSWERED
 *  request file can still be sitting on disk, unconsumed, for up to ~500ms
 *  after this test writes its reply. Without `seen`, a second immediate call
 *  would re-discover that SAME still-pending file and double-reply to it
 *  instead of waiting for the NEXT action's real request — starving that next
 *  action's approval of any reply at all until its own ~120s internal
 *  timeout (a real bug found the hard way: a test-only race, not a
 *  dispatchActionsTrusted bug — see this file's own dev notes). */
async function nextActionRequest(home: string, seen: Set<string>): Promise<{ request: any; sha: string }> {
  const requestDir = path.join(home, '.shelly/agents/action-approvals');
  for (let i = 0; i < 200; i += 1) {
    const requests = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json') && !seen.has(name))
      : [];
    if (requests.length > 0) {
      seen.add(requests[0]);
      const file = path.join(requestDir, requests[0]);
      const bytes = fs.readFileSync(file);
      return { request: JSON.parse(bytes.toString('utf8')), sha: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
    await delay(50);
  }
  throw new Error('timed out waiting for action approval request');
}

function replyToAction(home: string, pending: { request: any; sha: string }, decision: 'accept' | 'decline'): void {
  const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
  fs.mkdirSync(replyDir, { recursive: true });
  fs.writeFileSync(
    path.join(replyDir, `action-${pending.request.runId}.reply.json`),
    JSON.stringify({ runId: pending.request.runId, decision, by: 'test', requestSha256: pending.sha, ts: new Date().toISOString() }) + '\n',
  );
}

/** Sequentially answers `decisions.length` pending action-approval requests
 *  as they appear, in order — one per dispatched action. Runs concurrently
 *  with the executor subprocess (fire-and-forget, matching this file's
 *  existing runExecutorWithApproval pattern). */
async function answerActionsInOrder(home: string, decisions: Array<'accept' | 'decline'>): Promise<void> {
  const seen = new Set<string>();
  for (const decision of decisions) {
    const pending = await nextActionRequest(home, seen);
    replyToAction(home, pending, decision);
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function readSoleRunLog(home: string, agentId: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${agentId}`);
  const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
  expect(runLogs).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
}

const baseAgent = (overrides: Partial<Agent> = {}): Agent => ({
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

describe('buildAgentPlanSpec — Agent.actions plumbing', () => {
  it('emits plan.actions ONLY when agent.actions has >= 2 entries, and always keeps plan.action populated', () => {
    const single = buildAgentPlanSpec(baseAgent({ action: { type: 'draft' } }));
    expect(single.actions).toBeUndefined();

    const oneEntryActions = buildAgentPlanSpec(baseAgent({ action: { type: 'draft' }, actions: [{ type: 'notify' }] }));
    expect(oneEntryActions.actions).toBeUndefined();

    const multi = buildAgentPlanSpec(
      baseAgent({ action: { type: 'draft' }, actions: [{ type: 'draft' }, { type: 'notify' }] }),
    );
    expect(multi.actions).toHaveLength(2);
    expect(multi.actions?.[0]).toMatchObject({ type: 'draft' });
    expect(multi.actions?.[1]).toMatchObject({ type: 'notify' });
    // `action` (legacy singular field) is still populated for schema
    // validity, even though dispatchActionsTrusted never dispatches it in
    // the multi case.
    expect(multi.action.type).toBe('draft');
  });

  it('a suppressed orchestration step never carries actions, even with >= 2 configured', () => {
    const suppressed = buildAgentPlanSpec(
      baseAgent({ action: { type: 'draft' }, actions: [{ type: 'draft' }, { type: 'notify' }] }),
      { suppressAction: true },
    );
    expect(suppressed.actions).toBeUndefined();
    expect(suppressed.action.type).toBe('__suppressed__');
  });
});

describe('shelly-plan-executor.js — dispatchActionsTrusted (multi-action fan-out)', () => {
  let server: import('http').Server;
  let port = 0;

  beforeEach((done) => {
    const http = require('http');
    server = http.createServer((req: any, res: any) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: `fixture result: ${parsed.messages[0].content}` } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? (address as any).port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('dispatches both actions independently when both are accepted, recording per-action results', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-both-accept';
    const { planFile } = writePlan(home, agentId, [{ type: 'draft' }, { type: 'notify' }]);
    writeLocalEnv(home, port);

    const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    await answerActionsInOrder(home, ['accept', 'accept']);
    const result = await run;

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    expect(runLog.status).toBe('success');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'draft', status: 'success', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'success', message: expect.any(String) },
    ]);
    // The draft action's real side effect (a saved file) actually happened —
    // this is not just a status flag.
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(1);
  }, 20000);

  it('a DECLINED first action does not stop the second action from dispatching (partial success)', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-decline-first';
    const { planFile } = writePlan(home, agentId, [{ type: 'draft' }, { type: 'notify' }]);
    writeLocalEnv(home, port);

    const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    await answerActionsInOrder(home, ['decline', 'accept']);
    const result = await run;

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    // Partial success: one delivered action is enough for the WHOLE run to
    // read as 'success' (mirrors AgentRunLog.status's doc comment) — it must
    // not be reported as 'error' just because the FIRST action was declined.
    expect(runLog.status).toBe('success');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'draft', status: 'skipped', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'success', message: expect.any(String) },
    ]);
    // Declined draft really did NOT save a file.
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
    // Accepted notify really did fire (native-result-notification.json is the
    // ONE consolidated write for the whole run, but its message reflects the
    // real partial-delivery summary).
    const notifyFile = path.join(home, `.shelly/agents/logs/${agentId}/native-result-notification.json`);
    const notify = JSON.parse(fs.readFileSync(notifyFile, 'utf8'));
    expect(notify.status).toBe('success');
    expect(notify.preview).toContain('1/2 actions delivered');
  }, 20000);

  it('a DECLINED second action does not erase the first action´s already-delivered success', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-decline-second';
    const { planFile } = writePlan(home, agentId, [{ type: 'draft' }, { type: 'notify' }]);
    writeLocalEnv(home, port);

    const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    await answerActionsInOrder(home, ['accept', 'decline']);
    const result = await run;

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    expect(runLog.status).toBe('success');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'draft', status: 'success', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'skipped', message: expect.any(String) },
    ]);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(1);
  }, 20000);

  it('all actions declined -> overall status is skipped (zero successes, zero hard errors — mirrors a single declined action\'s existing "skipped" status, not "error")', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-both-decline';
    const { planFile } = writePlan(home, agentId, [{ type: 'draft' }, { type: 'notify' }]);
    writeLocalEnv(home, port);

    const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    await answerActionsInOrder(home, ['decline', 'decline']);
    const result = await run;

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    expect(runLog.status).toBe('skipped');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'draft', status: 'skipped', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'skipped', message: expect.any(String) },
    ]);
  }, 20000);

  it('a hard action ERROR (missing webhook URL) alongside a declined action -> overall status is error, not skipped', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-error-plus-decline';
    // webhook with no webhookUrl is a hard validation error inside
    // dispatchActionTrusted — no approval round trip for it at all.
    const { planFile } = writePlan(home, agentId, [{ type: 'webhook' }, { type: 'notify' }]);
    writeLocalEnv(home, port);

    const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    await answerActionsInOrder(home, ['decline']);
    const result = await run;

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    expect(runLog.status).toBe('error');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'webhook', status: 'error', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'skipped', message: expect.any(String) },
    ]);
  }, 20000);

  it('regression: absent/empty/1-entry plan.actions produces a run log with NO actionResults key, exactly like before this feature', async () => {
    const cases: Array<unknown[] | undefined> = [undefined, [], [{ type: 'draft' }]];
    for (const actions of cases) {
      const home = makeHome();
      const agentId = `agent-single-${actions ? actions.length : 'absent'}`;
      const { planFile } = writePlan(home, agentId, actions);
      writeLocalEnv(home, port);

      const run = runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
      void answerActionsInOrder(home, ['accept']).catch(() => undefined);
      const result = await run;

      expect(result.status).toBe(0);
      const runLog = readSoleRunLog(home, agentId);
      expect(runLog.status).toBe('success');
      expect('actionResults' in runLog).toBe(false);
    }
  }, 30000);

  it('on an UNATTENDED fire, an action ineligible to run unattended (intent) is recorded as its own "skipped" outcome — it does not abort the other, eligible action (notify)', async () => {
    const home = makeHome();
    const agentId = 'agent-multi-unattended-mixed';
    // requireActionApproval left unset (falls back to config default, which
    // this fixture's .env never sets -> 'auto') so `notify` auto-dispatches
    // unattended with NO approval round trip at all — only `intent` is
    // gated (unconditionally refused unattended, same as the single-action
    // .sh executor's own intent/dm-reply hard refusal).
    const { planFile } = writePlan(home, agentId, [
      { type: 'intent', intentMode: 'launch', intentTarget: 'geo:0,0' },
      { type: 'notify' },
    ]);
    // Multi-action plans skip the TOP-LEVEL unattendedPreflightFailure gate
    // (which only ever reads plan.action.type, wrong for a fan-out) — each
    // entry of plan.actions is gated individually inside
    // dispatchActionsTrusted instead. Write agent.requireActionApproval=false
    // explicitly so this test does not depend on the config-file default.
    const raw = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    raw.agent.requireActionApproval = false;
    fs.writeFileSync(planFile, JSON.stringify(raw, null, 2));
    writeLocalEnv(home, port);

    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker, '--unattended'], home);

    expect(result.status).toBe(0);
    const runLog = readSoleRunLog(home, agentId);
    // notify delivered unattended (no human tap needed in auto mode) ->
    // partial success still reads as the whole run's 'success'.
    expect(runLog.status).toBe('success');
    expect(runLog.actionResults).toEqual([
      { index: 0, actionType: 'intent', status: 'skipped', message: expect.any(String) },
      { index: 1, actionType: 'notify', status: 'success', message: expect.any(String) },
    ]);
    // The refused intent action never even created an approval request file
    // (unattendedPreflightFailure short-circuits before dispatchActionTrusted
    // is called for it at all).
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const leftoverRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(leftoverRequests).toHaveLength(0);
  }, 20000);

  it('the plan executor and its APK asset mirror are byte-identical (multi-action fan-out addition)', () => {
    const executorSrc = fs.readFileSync(path.join(root, 'scripts', 'shelly-plan-executor.js'), 'utf8');
    const assetSrc = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
      'utf8',
    );
    expect(assetSrc).toBe(executorSrc);
    expect(executorSrc).toContain('function dispatchActionsTrusted(');
  });
});
