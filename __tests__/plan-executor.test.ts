jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('shelly-plan-executor host smoke', () => {
  let server: http.Server;
  let port = 0;

  beforeEach((done) => {
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

    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', broker], home);

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

  it('fails closed when the broker asset is missing', async () => {
    const home = makeHome();
    const { planFile } = makePlan(home, port);
    const missingBroker = path.join(home, 'missing-broker.js');

    const result = await runExecutor([executor, '--plan-file', planFile, '--home', home, '--broker', missingBroker], home);

    expect(result.status).toBe(48);
    expect(listMarkdownFiles(path.join(home, 'agent-output'))).toHaveLength(0);
  });
});
