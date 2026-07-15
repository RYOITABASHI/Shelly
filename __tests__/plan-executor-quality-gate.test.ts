jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLowQualityCompletion } = require(executor);

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-quality-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makePlan(home: string, port: number) {
  const agentId = 'agent-plan-quality';
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: agentId, name: 'Plan Quality', autonomous: true, autonomyLevel: 'L2', requireActionApproval: true },
    prompt: 'say hello',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'plan-quality',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
  return { plan, planFile };
}

function runExecutor(
  args: string[],
  home: string,
  envOverride: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status: number | null) => resolve({ status, stdout, stderr }));
  });
}

describe('isLowQualityCompletion (pure)', () => {
  it('flags the prompt-echo scaffold markers from buildStepPrompt', () => {
    expect(isLowQualityCompletion('# Results from previous steps\nstep 1: foo')).toBe(true);
    expect(isLowQualityCompletion('intro\n# This step\ndo the thing')).toBe(true);
  });

  it('flags EN and JA refusal boilerplate', () => {
    expect(isLowQualityCompletion('As an AI, I cannot generate a real post for you.')).toBe(true);
    expect(isLowQualityCompletion("I'm not able to post this on your behalf.")).toBe(true);
    expect(isLowQualityCompletion('私はAIなので投稿できません。')).toBe(true);
  });

  it('does not flag real content', () => {
    expect(isLowQualityCompletion('Here is a great update about our new feature launch today.')).toBe(false);
    expect(isLowQualityCompletion('')).toBe(false);
    expect(isLowQualityCompletion(null)).toBe(false);
    expect(isLowQualityCompletion(undefined)).toBe(false);
  });
});

describe('shelly-plan-executor quality gate blocks dispatch (PlanSpec path)', () => {
  let server: http.Server;
  let port = 0;
  let requestCount = 0;
  // Set by each test before the model request lands, to control the fixture's
  // canned "model" response independent of the plan prompt.
  let fixtureContent = '';

  beforeEach((done) => {
    requestCount = 0;
    fixtureContent = '';
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: fixtureContent } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('blocks a webhook dispatch when the completion is a prompt echo, without sending or requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = '# Results from previous steps\nstep 1: draft the post\n# This step\nPost this to X.';
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    // No approval request was ever created — the gate fires before dispatch.
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');

    const notify = JSON.parse(fs.readFileSync(path.join(logDir, 'native-result-notification.json'), 'utf8'));
    expect(notify.status).toBe('error');
    expect(notify.preview).toContain('prompt echo or AI refusal');
  });

  it('blocks a dm-reply dispatch when the completion is refusal boilerplate, without requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = 'As an AI, I cannot generate a real reply for you.';
    (plan as any).action = { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'Reply: {{result}}' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/dm-pairings.json'), JSON.stringify([
      { id: 'pair-1', label: 'Test conversation', revoked: false },
    ]));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');
  });

  it('blocks an app-act dispatch when the completion is a prompt echo, without requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = '# Results from previous steps\ngarbage step output, no real post text here.';
    (plan as any).action = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');
  });

  it('still dispatches a webhook when the completion is real content (no false positive)', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = 'Our new feature launched today — check it out!';
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const run = runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    // Real content still reaches the human approval request (not auto-blocked).
    for (let i = 0; i < 100; i += 1) {
      const requestDir = path.join(home, '.shelly/agents/action-approvals');
      const requests = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'))
        : [];
      if (requests.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const requests = fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'));
    expect(requests).toHaveLength(1);
    const request = JSON.parse(fs.readFileSync(path.join(requestDir, requests[0]), 'utf8'));
    expect(request.actionType).toBe('webhook');

    // Decline so the run finishes cleanly without actually sending.
    const crypto = require('crypto');
    const bytes = fs.readFileSync(path.join(requestDir, requests[0]));
    const requestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.join(home, '.shelly/agents/action-approval-replies'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.shelly/agents/action-approval-replies', `action-${request.runId}.reply.json`),
      JSON.stringify({ runId: request.runId, decision: 'decline', by: 'test', requestSha256, ts: new Date().toISOString() }) + '\n',
    );
    const result = await run;
    expect(result.status).toBe(0);
  });
});
