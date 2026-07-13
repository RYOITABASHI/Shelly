jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { buildStepPrompt } from '@/lib/agent-orchestration';

// Option B multi-step orchestration is already wired app-side: agent-manager
// materializes a per-step PlanSpec and re-dispatches through the native gate into
// the single-plan executor, threading prior results as prompt text via
// buildStepPrompt and suppressing the action on non-final steps. This test locks
// that contract end-to-end against the REAL executor + broker, offline: a
// __suppressed__ step saves its draft without notifying, and the next step's
// buildStepPrompt-carried prompt actually reaches the broker's outbound request.

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-orch-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

const AGENT_ID = 'agent-orch-smoke';

function writePlan(home: string, port: number, prompt: string, actionType: 'draft' | '__suppressed__') {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Orch Smoke', autonomous: false, autonomyLevel: 'L2' },
    prompt,
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: actionType },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'orch-smoke',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
  return planFile;
}

function runExecutor(planFile: string, home: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executor, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (status) => resolve(status));
  });
}

// A __suppressed__ step never requests approval; a terminal draft does. Auto-accept
// any approval request that appears so the terminal step can complete.
function autoApprove(home: string): void {
  const requestDir = path.join(home, '.shelly/agents/action-approvals');
  const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
  const timer = setInterval(() => {
    if (!fs.existsSync(requestDir)) return;
    for (const name of fs.readdirSync(requestDir)) {
      if (!name.startsWith('action-') || !name.endsWith('.json')) continue;
      const bytes = fs.readFileSync(path.join(requestDir, name));
      const request = JSON.parse(bytes.toString('utf8'));
      const requestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.mkdirSync(replyDir, { recursive: true });
      fs.writeFileSync(
        path.join(replyDir, `action-${request.runId}.reply.json`),
        JSON.stringify({ runId: request.runId, decision: 'accept', by: 'test', requestSha256, ts: new Date().toISOString() }) + '\n',
      );
    }
  }, 40);
  (autoApprove as any)._timer = timer;
}
function stopAutoApprove(): void {
  if ((autoApprove as any)._timer) clearInterval((autoApprove as any)._timer);
}

describe('shelly-plan-executor orchestration (Option B per-step contract)', () => {
  let server: http.Server;
  let port = 0;
  let requestPrompts: string[];

  beforeEach((done) => {
    requestPrompts = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userContent = parsed.messages[0].content;
        requestPrompts.push(userContent);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: `RESULT#${requestPrompts.length}` } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    stopAutoApprove();
    server.close(done);
  });

  it('carries prior-step results into the next step and only the final step notifies', async () => {
    const home = makeHome();
    autoApprove(home);
    const notifyFile = path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`);

    // Step 1 — non-final, suppressed. Saves a draft for the next step, no notification.
    const step1Prompt = buildStepPrompt('Base task', 'gather the sources', []);
    const rc1 = await runExecutor(writePlan(home, port, step1Prompt, '__suppressed__'), home);
    expect(rc1).toBe(0);
    const step1Result = fs.readFileSync(path.join(home, '.shelly/tmp', `agent-result-${AGENT_ID}.md`), 'utf8').trim();
    expect(step1Result).toBe('RESULT#1');
    // Suppressed step wrote a draft but did NOT fire a completion notification.
    expect(listMd(path.join(home, 'agent-output')).length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(notifyFile)).toBe(false);

    // Step 2 — final, draft. Prompt is built (as agent-manager does) from the base
    // prompt + step 1's carried result.
    const step2Prompt = buildStepPrompt('Base task', 'write the article from the sources', [step1Result]);
    const rc2 = await runExecutor(writePlan(home, port, step2Prompt, 'draft'), home);
    expect(rc2).toBe(0);

    // The carried prior result actually reached the broker's outbound request for step 2.
    expect(requestPrompts).toHaveLength(2);
    expect(requestPrompts[1]).toContain('RESULT#1');
    expect(requestPrompts[1]).toContain('# Results from previous steps');
    expect(requestPrompts[1]).toContain('write the article from the sources');

    // Final step notified exactly once, with a shape-compatible run log.
    expect(fs.existsSync(notifyFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(notifyFile, 'utf8')).status).toBe('success');
    const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
    const runLogs = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n));
    expect(runLogs.length).toBeGreaterThanOrEqual(1);
    const lastLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs.sort()[runLogs.length - 1]), 'utf8'));
    expect(lastLog).toMatchObject({ status: 'success', executor: 'planspec', toolUsed: 'Local LLM' });
  });
});

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMd(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
