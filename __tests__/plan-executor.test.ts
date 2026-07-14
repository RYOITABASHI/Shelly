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

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makePlan(home: string, port: number) {
  const agentId = 'agent-plan-smoke';
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: agentId, name: 'Plan Smoke', autonomous: true, autonomyLevel: 'L2' },
    prompt: 'say hello',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'plan-smoke',
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

function runExecutor(
  args: string[],
  home: string,
  envOverride: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function approveNextAction(home: string): Promise<void> {
  const requestDir = path.join(home, '.shelly/agents/action-approvals');
  const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
  for (let i = 0; i < 100; i += 1) {
    const requests = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'))
      : [];
    if (requests.length > 0) {
      const requestFile = path.join(requestDir, requests[0]);
      const bytes = fs.readFileSync(requestFile);
      const request = JSON.parse(bytes.toString('utf8'));
      const requestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.mkdirSync(replyDir, { recursive: true });
      fs.writeFileSync(
        path.join(replyDir, `action-${request.runId}.reply.json`),
        JSON.stringify({
          runId: request.runId,
          decision: 'accept',
          by: 'test',
          requestSha256,
          ts: new Date().toISOString(),
        }) + '\n',
      );
      return;
    }
    await delay(50);
  }
  throw new Error('timed out waiting for action approval request');
}

function runExecutorWithApproval(args: string[], home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const run = runExecutor(args, home);
  void approveNextAction(home).catch(() => undefined);
  return run;
}

async function readNextActionRequest(home: string): Promise<{ file: string; request: any; sha: string }> {
  const requestDir = path.join(home, '.shelly/agents/action-approvals');
  for (let i = 0; i < 100; i += 1) {
    const requests = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'))
      : [];
    if (requests.length > 0) {
      const file = path.join(requestDir, requests[0]);
      const bytes = fs.readFileSync(file);
      return {
        file,
        request: JSON.parse(bytes.toString('utf8')),
        sha: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }
    await delay(50);
  }
  throw new Error('timed out waiting for action approval request');
}

function writeActionReply(home: string, pending: { request: any; sha: string }, decision = 'accept'): void {
  fs.mkdirSync(path.join(home, '.shelly/agents/action-approval-replies'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.shelly/agents/action-approval-replies', `action-${pending.request.runId}.reply.json`),
    JSON.stringify({
      runId: pending.request.runId,
      decision,
      by: 'test',
      requestSha256: pending.sha,
      ts: new Date().toISOString(),
    }) + '\n',
  );
}

describe('shelly-plan-executor host smoke', () => {
  let server: http.Server;
  let port = 0;
  let requestCount = 0;

  beforeEach((done) => {
    requestCount = 0;
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
        const parsed = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: `fixture result: ${parsed.messages[0].content}` } }],
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

  it('runs local loopback through the broker, writes draft output, log, and audits', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const outputFiles = listMarkdownFiles(path.join(home, 'agent-output'));
    expect(outputFiles).toHaveLength(1);
    expect(fs.readFileSync(outputFiles[0], 'utf8')).toContain('fixture result: say hello');

    const logs = listMarkdownFiles(path.join(home, '.shelly/agents/logs'));
    expect(logs).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    expect(runLogs).toHaveLength(1);
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog).toMatchObject({ status: 'success', executor: 'planspec', toolUsed: 'Local LLM' });

    const brokerAudit = fs.readFileSync(path.join(logDir, 'agent-driver-audit.jsonl'), 'utf8');
    expect(brokerAudit).toContain('"kind":"http.request"');
    expect(brokerAudit).toContain('"kind":"scoped.fs"');
    expect(brokerAudit).not.toContain('Bearer ');

    const planAudit = fs.readFileSync(path.join(logDir, 'plan-executor-audit.jsonl'), 'utf8');
    expect(planAudit).toContain('"event":"plan_start"');
    expect(planAudit).toContain('"event":"plan_finish"');
  });

  it('refuses to run when the global kill-switch (.halted) sentinel is present', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fs.writeFileSync(path.join(home, '.shelly/agents/.halted'), 'halted\n');

    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);

    expect(result.status).toBe(0);
    // Fail-closed before any model IO: the loopback fixture is never hit.
    expect(requestCount).toBe(0);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('global kill-switch');

    const planAudit = fs.readFileSync(path.join(logDir, 'plan-executor-audit.jsonl'), 'utf8');
    expect(planAudit).toContain('"status":"skipped"');
    // Broker was never invoked, so no broker audit file was produced.
    expect(fs.existsSync(path.join(logDir, 'agent-driver-audit.jsonl'))).toBe(false);
  });

  it('writes the native-result-notification.json completion request on a successful draft', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);
    expect(result.status).toBe(0);

    const notifyFile = path.join(home, `.shelly/agents/logs/${plan.agent.id}/native-result-notification.json`);
    expect(fs.existsSync(notifyFile)).toBe(true);
    const notify = JSON.parse(fs.readFileSync(notifyFile, 'utf8'));
    expect(notify).toMatchObject({ agentId: plan.agent.id, status: 'success' });
    expect(notify.preview).toContain('fixture result: say hello');
  });

  it('denies a symlink outputDir instead of adding it as a scoped root', async () => {
    const home = makeHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-outside-'));
    const outsideReal = path.join(outside, 'real');
    fs.mkdirSync(outsideReal, { recursive: true });
    const linkDir = path.join(home, 'agent-output/linkdir');
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    fs.symlinkSync(outsideReal, linkDir, 'dir');

    const { plan, planFile } = makePlan(home, port);
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = linkDir;
    plan.output.outputNameTemplate = 'escaped';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outsideReal, 'escaped.md'))).toBe(false);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('scoped filesystem write denied');

    const brokerAudit = fs.readFileSync(path.join(logDir, 'agent-driver-audit.jsonl'), 'utf8');
    expect(brokerAudit).toContain('"kind":"scoped.fs"');
    expect(brokerAudit).toContain('"decision":"deny"');
    expect(brokerAudit).toContain('outside-root');
  });

  it('requires the native agent id to match the PlanSpec agent id', async () => {
    const home = makeHome();
    const { planFile } = makePlan(home, port);

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', 'agent-other',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(47);
    expect(requestCount).toBe(0);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
    expect(result.stderr).toContain('plan agent id mismatch');
  });

  it('does not trust plan.paths.home as a runtime home fallback', async () => {
    const home = makeHome();
    const { planFile } = makePlan(home, port);

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--broker', broker,
    ], '', { HOME: '' });

    expect(result.status).toBe(47);
    expect(requestCount).toBe(0);
    expect(result.stderr).toContain('--home or absolute HOME is required');
  });

  it('fails closed before model IO for unattended runs without native low-risk trust', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--unattended', '1',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    expect(requestCount).toBe(0);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const approvalRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(approvalRequests).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    expect(runLogs).toHaveLength(1);
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('not trusted for unattended');
  });

  it('allows unattended local draft only when native supplies matching trusted action and tool', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--unattended', '1',
      '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'draft',
      '--trusted-tool-type', 'local',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    expect(requestCount).toBe(1);
    const outputFiles = listMarkdownFiles(path.join(home, 'agent-output'));
    expect(outputFiles).toHaveLength(1);
    expect(fs.readFileSync(outputFiles[0], 'utf8')).toContain('fixture result: say hello');

    const planAudit = fs.readFileSync(path.join(home, `.shelly/agents/logs/${plan.agent.id}/plan-executor-audit.jsonl`), 'utf8');
    expect(planAudit).toContain('"event":"action_trusted_allow"');
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const approvalRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(approvalRequests).toHaveLength(0);
  });

  it('does not let trusted action args authorize a tampered cloud tool in unattended mode', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).tool = { type: 'gemini-api', label: 'Gemini', model: 'gemini-2.5-flash', authRef: 'gemini' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--unattended', '1',
      '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'draft',
      '--trusted-tool-type', 'local',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    expect(requestCount).toBe(0);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('not trusted for unattended');
  });

  it('redacts secret-like model text from action approval request previews', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    plan.prompt = 'return gsk_abcdefghijklmnopqrstuvwxyz1234567890';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const run = runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);
    const pending = await readNextActionRequest(home);
    expect(pending.request.preview).toContain('<redacted>');
    expect(pending.request.preview).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz1234567890');

    writeActionReply(home, pending);
    const result = await run;
    expect(result.status).toBe(0);
  });

  it('requests webhook approval with destination host and redacted payload path, then skips on decline without sending', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const run = runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);
    const pending = await readNextActionRequest(home);
    expect(pending.request.actionType).toBe('webhook');
    expect(pending.request.destinationHost).toBe('hooks.example.test');
    expect(pending.request.destinationHostAllowlisted).toBe(false);
    expect(pending.request.payloadPath).toMatch(/^webhook-payload-\d+\.json$/);
    expect(pending.request.payloadPath).not.toContain(home);
    const actualPayloadPath = path.join(home, `.shelly/agents/logs/${plan.agent.id}`, pending.request.payloadPath);
    expect(fs.readFileSync(actualPayloadPath, 'utf8')).toContain('"result":"fixture result: say hello"');

    writeActionReply(home, pending, 'decline');
    const result = await run;
    expect(result.status).toBe(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('webhook action declined');
    const brokerAudit = fs.readFileSync(path.join(logDir, 'agent-driver-audit.jsonl'), 'utf8');
    expect(brokerAudit).toContain('"kind":"http.request"');
    expect(brokerAudit).not.toContain('hooks.example.test');
  });

  it('marks an allowlisted webhook host as known but still waits for human approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.appendFileSync(path.join(home, '.shelly/agents/.env'), "SHELLY_WEBHOOK_HOST_ALLOWLIST='hooks.example.test'\n");

    const run = runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);
    const pending = await readNextActionRequest(home);
    expect(pending.request.destinationHostAllowlisted).toBe(true);
    expect(requestCount).toBe(1); // model request only; webhook has not been sent

    writeActionReply(home, pending, 'decline');
    const result = await run;
    expect(result.status).toBe(0);
    expect(requestCount).toBe(1);
  });

  it('runs approved cli actions through workspace.exec and appends the action report', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = {
      type: 'cli',
      command: 'printf ok',
      safety: { level: 'SAFE', reason: 'No risky command pattern matched.', message: '', autoApprovable: true },
    };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutorWithApproval([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const resultFile = path.join(home, `.shelly/tmp/agent-result-${plan.agent.id}.md`);
    const resultText = fs.readFileSync(resultFile, 'utf8');
    expect(resultText).toContain('## CLI action');
    expect(resultText).toContain('Command:');
    expect(resultText).toContain('printf ok');
    expect(resultText).toContain('Exit code: 0');
    expect(resultText).toContain('ok');

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const brokerAudit = fs.readFileSync(path.join(logDir, 'agent-driver-audit.jsonl'), 'utf8');
    expect(brokerAudit).toContain('"kind":"workspace.exec"');
    expect(brokerAudit).toContain('"decision":"allow"');
  });

  it('saves the draft (primary + mirror) for a __suppressed__ orchestration step without approval or notification', async () => {
    const home = makeHome();
    const vault = path.join(home, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const { plan, planFile } = makePlan(home, port);
    plan.action = { type: '__suppressed__' };
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = path.join(home, 'projects/shelly-content-studio/drafts/x');
    plan.output.outputNameTemplate = '{date}-{slug}';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nOBSIDIAN_VAULT_PATH='${vault}'\n`);

    // No approval helper: a suppressed step must not request approval (else it would hang).
    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    expect(result.status).toBe(0);

    // Draft AND mirror written so the next orchestration step can read them (.sh parity)...
    expect(listMarkdownFiles(plan.output.outputDir)).toHaveLength(1);
    expect(listMarkdownFiles(path.join(vault, '50_Drafts/X'))).toHaveLength(1);
    // ...but no approval request and no completion notification for a non-final step.
    const approvalsDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(approvalsDir) ? fs.readdirSync(approvalsDir) : []).toHaveLength(0);
    expect(fs.existsSync(path.join(home, `.shelly/agents/logs/${plan.agent.id}/native-result-notification.json`))).toBe(false);
    const runLogDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(runLogDir).filter((name) => /^\d+\.json$/.test(name));
    expect(JSON.parse(fs.readFileSync(path.join(runLogDir, runLogs[0]), 'utf8')).status).toBe('success');
  });

  it('appends newline-separated draft source URLs to the shared registry, deduped (.sh parity)', async () => {
    const home = makeHome();
    const contentProject = path.join(home, 'content');
    fs.mkdirSync(path.join(contentProject, 'sources'), { recursive: true });
    const { plan, planFile } = makePlan(home, port);
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = path.join(contentProject, 'drafts/x');
    plan.output.outputNameTemplate = '{date}-{slug}';
    // URLs on separate lines: the line-oriented .sh grep must not merge them.
    plan.prompt = 'refs:\nhttps://a.example/x\nhttps://b.example/y';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_CONTENT_PROJECT='${contentProject}'\n`);

    const registry = path.join(contentProject, 'sources', 'source-registry.tsv');
    await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    const rows1 = fs.readFileSync(registry, 'utf8').trim().split('\n');
    expect(rows1).toHaveLength(2);
    // Column 4 (tab-separated) is the URL; adjacent-line URLs stay separate, not merged.
    expect(rows1.map((r) => r.split('\t')[3])).toEqual(['https://a.example/x', 'https://b.example/y']);

    // Re-running the same agent must not duplicate URLs already in the registry.
    await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    expect(fs.readFileSync(registry, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('creates the source registry on a fresh content-studio project (.sh parity)', async () => {
    const home = makeHome();
    const contentProject = path.join(home, 'fresh-content');
    // No pre-existing sources/ dir: the .sh mkdir -p's it at startup, so URLs still register.
    const { plan, planFile } = makePlan(home, port);
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = path.join(contentProject, 'drafts/x');
    plan.prompt = 'ref https://c.example/z';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_CONTENT_PROJECT='${contentProject}'\n`);

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    expect(result.status).toBe(0);
    const registry = path.join(contentProject, 'sources', 'source-registry.tsv');
    expect(fs.existsSync(registry)).toBe(true);
    expect(fs.readFileSync(registry, 'utf8')).toContain('https://c.example/z');
  });

  it('mirrors a content-studio draft into the keyword-routed Obsidian vault (.sh parity)', async () => {
    const home = makeHome();
    const vault = path.join(home, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const { plan, planFile } = makePlan(home, port);
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = path.join(home, 'projects/shelly-content-studio/drafts/x');
    plan.output.outputNameTemplate = '{date}-{slug}';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nOBSIDIAN_VAULT_PATH='${vault}'\n`);

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    expect(result.status).toBe(0);

    const primary = listMarkdownFiles(plan.output.outputDir);
    expect(primary).toHaveLength(1);
    // drafts/x -> 50_Drafts/X keyword route (lib/agent-executor.ts save_draft_result).
    const mirror = listMarkdownFiles(path.join(vault, '50_Drafts/X'));
    expect(mirror).toHaveLength(1);
    expect(fs.readFileSync(mirror[0], 'utf8')).toBe(fs.readFileSync(primary[0], 'utf8'));
    expect(fs.readFileSync(mirror[0], 'utf8')).toContain('fixture result: say hello');
    // Both writes went through the broker's scoped.fs (root-jailed), not raw fs.
    const brokerAudit = fs.readFileSync(path.join(home, `.shelly/agents/logs/${plan.agent.id}/agent-driver-audit.jsonl`), 'utf8');
    const scopedWrites = brokerAudit.split('\n').filter((l) => l.includes('"kind":"scoped.fs"') && l.includes('"decision":"allow"'));
    expect(scopedWrites.length).toBe(2);
  });

  it('skips the Obsidian mirror when no vault directory is present (silent, like the .sh)', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    plan.output.useGlobalOutput = false;
    plan.output.outputDir = path.join(home, 'projects/shelly-content-studio/drafts/x');
    plan.output.outputNameTemplate = '{date}-{slug}';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    // OBSIDIAN_VAULT_PATH points at a non-existent dir: the mirror must be skipped, run still succeeds.
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nOBSIDIAN_VAULT_PATH='${path.join(home, 'no-vault')}'\n`);

    const result = await runExecutorWithApproval([executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker], home);
    expect(result.status).toBe(0);
    expect(listMarkdownFiles(plan.output.outputDir)).toHaveLength(1);
    expect(fs.existsSync(path.join(home, 'no-vault'))).toBe(false);
    const runLogDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(runLogDir).filter((name) => /^\d+\.json$/.test(name));
    expect(JSON.parse(fs.readFileSync(path.join(runLogDir, runLogs[0]), 'utf8')).status).toBe('success');
  });

  it('recomputes cli safety in the executor and blocks critical command tampering', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = {
      type: 'cli',
      command: 'rm -rf /',
      safety: { level: 'SAFE', reason: 'tampered safe classification', message: '', autoApprovable: true },
    };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const approvalRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(approvalRequests).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('blocked by command safety');
    const brokerAudit = fs.readFileSync(path.join(logDir, 'agent-driver-audit.jsonl'), 'utf8');
    expect(brokerAudit).toContain('"kind":"http.request"');
    expect(brokerAudit).not.toContain('"kind":"workspace.exec"');
  });

  it('keeps webhook and cli actions fail-closed in unattended mode', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'cli', command: 'printf ok' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--unattended', '1',
      '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'cli',
      '--trusted-tool-type', 'local',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    expect(requestCount).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const approvalRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(approvalRequests).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('unsupported unattended PlanSpec action: cli');
  });

  it('requests and accepts a targetless share intent with resolved share text', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = {
      type: 'intent',
      intentMode: 'share',
      intentShareText: 'Result: {{result}}',
    };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const run = runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', broker,
    ], home);
    const pending = await readNextActionRequest(home);
    expect(pending.request.intentMode).toBe('share');
    expect(pending.request.intentTarget).toBe('');
    expect(pending.request.intentShareText).toContain('Result: fixture result: say hello');
    writeActionReply(home, pending);

    const result = await run;
    expect(result.status).toBe(0);
  });

  it('keeps intent actions fail-closed in unattended mode', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'intent', intentMode: 'launch', intentTarget: 'geo:0,0' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--unattended', '1',
      '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'intent',
      '--trusted-tool-type', 'local',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    expect(requestCount).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const approvalRequests = fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : [];
    expect(approvalRequests).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
    expect(runLog.status).toBe('skipped');
    expect(runLog.errorMessage).toContain('unsupported unattended PlanSpec action: intent');
  });

  it('resolves dm-reply from the live mirror and binds target/text into Review approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'Reply: {{result}}' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/dm-pairings.json'), JSON.stringify([
      { id: 'pair-1', label: 'Test conversation', revoked: false },
    ]));

    const run = runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);
    const pending = await readNextActionRequest(home);
    expect(pending.request).toMatchObject({
      actionType: 'dm-reply',
      dmPairingId: 'pair-1',
      dmPairingLabel: 'Test conversation',
    });
    expect(pending.request.dmReplyText).toContain('Reply: fixture result: say hello');
    writeActionReply(home, pending);
    expect((await run).status).toBe(0);
  });

  it('fails closed on revoked dm pairing without creating an approval request', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'hello' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/dm-pairings.json'), JSON.stringify([
      { id: 'pair-1', label: 'Revoked', revoked: true },
    ]));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);
    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    expect(JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8')).errorMessage)
      .toContain('no longer paired');
  });

  it('keeps dm-reply fail-closed in unattended PlanSpec mode', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    (plan as any).action = { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'hello' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id,
      '--unattended', '1', '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'dm-reply', '--trusted-tool-type', 'local', '--broker', broker,
    ], home);
    expect(result.status).toBe(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    expect(JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8')).errorMessage)
      .toContain('unsupported unattended PlanSpec action: dm-reply');
  });

  it('redacts secret-like model text from previews and native notifications', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    plan.prompt = 'return sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--trusted-autonomous-agent-id', plan.agent.id,
      '--trusted-autonomous-action', 'draft',
      '--trusted-tool-type', 'local',
      '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
    const runLogRaw = fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8');
    const notifyRaw = fs.readFileSync(path.join(logDir, 'native-result-notification.json'), 'utf8');
    expect(runLogRaw).toContain('<redacted>');
    expect(notifyRaw).toContain('<redacted>');
    expect(runLogRaw).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(notifyRaw).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('fails closed when the broker asset is missing', async () => {
    const home = makeHome();
    const { planFile } = makePlan(home, port);
    const missingBroker = path.join(home, 'missing-broker.js');

    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', missingBroker], home);

    expect(result.status).toBe(48);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
  });
});
