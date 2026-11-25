/**
 * MCP ingress taint Inc 5 (DEFERRED.md P1 "MCP の入口（ingress）"), executor v59:
 *  - a run of an MCP-marked agent (SHELLY_INGRESS_TAINTED=1) hands `--tainted`
 *    to the agent driver of every CLI step (the driver then declines writes /
 *    exec / network sends); a notification-triggered run (SHELLY_CAP_TAINTED=1
 *    only) does not;
 *  - a run of an agent marked by MCP ingress (SHELLY_INGRESS_TAINTED=1, native)
 *    dispatches no action and writes one `ingress_tainted_refused` audit line;
 *  - untainted runs are unchanged.
 * Real executor + broker, a loopback fake model server, a fake driver that
 * records its argv (same --agent-driver test hook as plan-executor-cli-steps).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
const AGENT_ID = 'agent-ingress-taint';
const PIN = 'a'.repeat(64);
const EMPTY_PROC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fake-proc-'));

const FAKE_DRIVER = `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
fs.writeFileSync(path.join(process.env.FAKE_DRIVER_RECORD_DIR, 'call-' + process.pid + '.json'), JSON.stringify({ argv }));
fs.writeFileSync(get('--answer-file'), 'CODEX_REVIEW: fine.');
process.exit(0);
`;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-taint-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makeDriver(): { driver: string; recordDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fake-driver-'));
  const driver = path.join(dir, 'fake-agent-driver.js');
  fs.writeFileSync(driver, FAKE_DRIVER);
  const recordDir = path.join(dir, 'records');
  fs.mkdirSync(recordDir);
  return { driver, recordDir };
}

/** A --broker wrapper that records its argv, then runs the real broker. */
function makeRecordingBroker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-rec-broker-'));
  const file = path.join(dir, 'recording-broker.js');
  fs.writeFileSync(file, [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(process.env.FAKE_BROKER_RECORD, JSON.stringify(argv) + '\\n');",
    `const r = spawnSync(process.execPath, [${JSON.stringify(broker)}].concat(argv), { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);',
  ].join('\n'));
  return file;
}

let modelRequests = 0;

type Step = { instruction: string; tool?: Record<string, unknown> };

function writePlan(home: string, port: number, steps: Step[] | null, actionType = 'notify'): string {
  const policy = { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: false };
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Ingress Taint', autonomous: false, autonomyLevel: 'L2', requireActionApproval: false },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: actionType },
    paths: { home },
    output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'taint', useGlobalOutput: true, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy,
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    ...(steps ? { steps: { list: steps, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } }, cliWorker: { cwd: '', policy } } : {}),
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
  );
  return planFile;
}

function runExecutor(planFile: string, home: string, driver: string, recordDir: string, extraEnv: Record<string, string> = {}, brokerPath = broker, unattended = false) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', brokerPath, '--agent-driver', driver];
    if (unattended) args.push('--unattended', '1');
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      FAKE_DRIVER_RECORD_DIR: recordDir,
      SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: PIN,
      SHELLY_RUN_ORIGIN: 'user',
      SHELLY_PLAN_EXECUTOR_PROC_ROOT: EMPTY_PROC_ROOT,
      ...extraEnv,
    };
    delete env.SHELLY_CAP_TAINTED;
    delete env.SHELLY_INGRESS_TAINTED;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);

function readRunLog(home: string): any {
  const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
}

function readAudit(home: string): any[] {
  const file = path.join(logDir(home), 'plan-executor-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function driverArgvs(recordDir: string): string[][] {
  return fs.readdirSync(recordDir)
    .filter((n) => n.startsWith('call-'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf8')).argv);
}

describe('shelly-plan-executor.js MCP ingress taint (v59)', () => {
  let server: http.Server;
  let port = 0;

  beforeEach((done) => {
    modelRequests = 0;
    server = http.createServer((req, res) => {
      modelRequests += 1;
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Final digest of the review.' } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(() => done());
  });

  const cliSteps: Step[] = [
    { instruction: 'review the diff with Codex', tool: { type: 'cli', cli: 'codex' } },
    { instruction: 'summarize the review' },
  ];

  it('an MCP-marked run passes --tainted to the driver; notification-tainted and untainted runs do not', async () => {
    for (const [extra, expected] of [[{ SHELLY_INGRESS_TAINTED: '1', SHELLY_CAP_TAINTED: '1' }, true], [{ SHELLY_CAP_TAINTED: '1' }, false], [{}, false]] as const) {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      const result = await runExecutor(writePlan(home, port, cliSteps), home, driver, recordDir, extra);
      expect(result.status).toBe(0);
      const argvs = driverArgvs(recordDir);
      expect(argvs).toHaveLength(1);
      expect(argvs[0].includes('--tainted')).toBe(expected);
    }
  }, 60000);

  it('an MCP-marked agent still gets its model call (no broker --tainted) but dispatches no action, audits it and posts no notification', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    const brokerRecord = path.join(recordDir, 'broker-argv.jsonl');
    const result = await runExecutor(
      writePlan(home, port, null),
      home,
      driver,
      recordDir,
      { SHELLY_INGRESS_TAINTED: '1', SHELLY_INGRESS_TAINTED_REASON: 'mcp', FAKE_BROKER_RECORD: brokerRecord },
      makeRecordingBroker(),
    );
    expect(result.status).toBe(0);
    // The model call went through the broker without the tainted flag (the
    // broker turns tainted + a credential into an approval, rc 41).
    expect(modelRequests).toBeGreaterThan(0);
    const brokerCalls = fs.readFileSync(brokerRecord, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(brokerCalls.length).toBeGreaterThan(0);
    for (const argv of brokerCalls) expect(argv.join(' ')).not.toContain('--tainted 1');
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(String(log.preview || log.errorMessage || '')).toContain('created or changed through MCP');
    const refused = readAudit(home).filter((e) => e.kind === 'ingress_tainted_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ event: 'action', agentId: AGENT_ID, actionType: 'notify', reason: 'mcp' });
    expect(fs.existsSync(path.join(logDir(home), 'native-result-notification.json'))).toBe(false);
  }, 30000);

  it('a store that cannot be verified gets its own wording (every agent treated as external)', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    await runExecutor(writePlan(home, port, null), home, driver, recordDir, { SHELLY_INGRESS_TAINTED: '1', SHELLY_INGRESS_TAINTED_REASON: 'store-unreadable' });
    const log = readRunLog(home);
    expect(String(log.preview || log.errorMessage || '')).toContain('MCP taint record cannot be verified');
    expect(readAudit(home).find((e) => e.kind === 'ingress_tainted_refused')).toMatchObject({ reason: 'store-unreadable' });
  }, 30000);

  it('an intermediate (__suppressed__) step of an MCP-marked agent writes no draft output, only its private run files', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    const result = await runExecutor(writePlan(home, port, null, '__suppressed__'), home, driver, recordDir, { SHELLY_INGRESS_TAINTED: '1' });
    expect(result.status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    const outDir = path.join(home, 'agent-output');
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    expect(readAudit(home).find((e) => e.kind === 'ingress_tainted_refused')).toMatchObject({ event: 'suppressed_draft', actionType: '__suppressed__' });
  }, 30000);

  it('explicit MCP action consent completes a manual-review notify agent headlessly', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    const file = writePlan(home, port, null);
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    plan.agent.requireActionApproval = true;
    fs.writeFileSync(file, JSON.stringify(plan));
    const result = await runExecutor(file, home, driver, recordDir, { SHELLY_MCP_ACTIONS_PREAPPROVED: '1', SHELLY_RUN_ORIGIN: 'event' }, broker, true);
    expect(result.status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(fs.existsSync(path.join(logDir(home), 'native-result-notification.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.shelly/agents/action-approvals')) ? fs.readdirSync(path.join(home, '.shelly/agents/action-approvals')) : []).toEqual([]);
  }, 30000);

  it.each(['deny', 'ask'])('MCP action consent cannot bypass a content-dependent %s rule even with the policy switch off', async (effect) => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    const file = writePlan(home, port, null);
    const text = JSON.stringify({ kind: 'shelly.user-policy', userPolicy: { rules: [] }, compiledActionRules: [`${effect}|notify||digest`] });
    fs.writeFileSync(path.join(home, '.shelly/agents/policy.json'), text);
    await runExecutor(file, home, driver, recordDir, { SHELLY_MCP_ACTIONS_PREAPPROVED: '1', SHELLY_RUN_ORIGIN: 'event', SHELLY_AGENT_POLICY_SEAL: createHash('sha256').update(text).digest('hex') }, broker, true);
    expect(readRunLog(home).status).toBe('skipped');
    expect(JSON.stringify(readRunLog(home))).toContain('policy');
  }, 30000);

  it('a taint mark still refuses actions even when an MCP consent flag is present', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    await runExecutor(writePlan(home, port, null), home, driver, recordDir, { SHELLY_MCP_ACTIONS_PREAPPROVED: '1', SHELLY_INGRESS_TAINTED: '1' });
    expect(readRunLog(home).status).toBe('skipped');
    expect(readAudit(home).find((e) => e.kind === 'ingress_tainted_refused')).toBeDefined();
  }, 30000);

  it('untainted regression: the same notify agent dispatches as before' , async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    const result = await runExecutor(writePlan(home, port, null), home, driver, recordDir);
    expect(result.status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(readAudit(home).filter((e) => e.kind === 'ingress_tainted_refused')).toHaveLength(0);
  }, 30000);
});

describe('native + .sh wiring (source pins)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt');
  const taintKt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentIngressTaint.kt');

  it('AgentRuntime exports the ingress mark on every run, but never folds it into SHELLY_CAP_TAINTED', () => {
    expect(kt).toContain('val ingressReason = AgentIngressTaint.runTaintReason(appContext, agentId)');
    expect(kt).toContain('val tainted = callerTainted\n'.replace('\n', kt.includes('\r\n') ? '\r\n' : '\n'));
    expect(kt).not.toContain('callerTainted || ');
    expect(kt.match(/append\(ingressTaintExports\(ingressReason\)\)/g)).toHaveLength(2);
    expect(kt).toContain('" && readonly SHELLY_INGRESS_TAINTED SHELLY_INGRESS_TAINTED_REASON"');
    expect(kt).toContain('runOrigin, ingressReason, mcpActionsPreapproved, onExecutionStart)');
  });

  it('runTaintReason fails closed, never throws, and reads the native mcp-ever marker seal() writes', () => {
    const at = taintKt.indexOf('fun runTaintReason(');
    const body = taintKt.slice(at, at + 900);
    expect(body).toContain('snapshot(context, mcpEverEnabledNative(context))');
    expect(body).toContain('catch (e: Throwable)');
    expect(body).toContain('Status.UNREADABLE -> RUN_REASON_UNREADABLE');
    expect(body).toContain('Status.OVERFLOW -> RUN_REASON_OVERFLOW');
    const seal = taintKt.slice(taintKt.indexOf('fun seal('), taintKt.indexOf('fun seal(') + 500);
    expect(seal).toContain('getSharedPreferences(EVER_PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_EVER, true).commit()');
    const ever = taintKt.slice(taintKt.indexOf('fun mcpEverEnabledNative('), taintKt.indexOf('fun mcpEverEnabledNative(') + 300);
    expect(ever).toContain('true'); // a read error counts as "ever"
  });

  it('the .sh dispatch refuses every action of an ingress-tainted run with an audit line, and skips the consolidated notification', () => {
    const ts = read('lib/agent-executor.ts');
    expect(ts).toContain('  if [ "\\${SHELLY_INGRESS_TAINTED:-0}" = "1" ]; then\n'.replace(/\n/g, ts.includes('\r\n') ? '\r\n' : '\n'));
    expect(ts).toContain('"kind":"ingress_tainted_refused"');
    expect(ts).toContain('if [ "\\${SHELLY_INGRESS_TAINTED:-0}" != "1" ]; then');
  });

  it('v60: the research history retry reuses the step path (same --tainted handling) and never starts a web search on a tainted run', () => {
    const js = read('scripts/shelly-plan-executor.js');
    const at = js.indexOf('async function guardResearchHistory(');
    const body = js.slice(at, js.indexOf('\n  }', at));
    expect(at).toBeGreaterThan(-1);
    // v68: the same rule as the step itself (webSearchStartRefusal: ingress always,
    // a tainted run unless the owner's opt-in matches the plan's definition).
    expect(body).toContain("if (isResearchWebSearchCliStep(plan, i) && webSearchStartRefusal(opts)) return 'tainted';");
    const rule = js.slice(js.indexOf('function webSearchStartRefusal('), js.indexOf('\n}', js.indexOf('function webSearchStartRefusal(')));
    expect(rule).toContain('if (ingressTainted()) return');
    expect(rule).toContain("if (opts && opts.tainted && activeWebSearchOptIn !== 'on')");
    // The retry is the ordinary step run: dispatchCliStep adds --tainted for an MCP-marked run.
    expect(body).toContain('retry = await executeStepWithProgress(i, contextResults, carriedIndexes, true);');
    expect(body).not.toContain('dispatchCliStep(');
  });

  it('script and asset mirrors are byte-identical', () => {
    for (const name of ['shelly-plan-executor.js', 'shelly-agent-driver.js']) {
      expect(read(`modules/terminal-emulator/android/src/main/assets/${name}`)).toBe(read(`scripts/${name}`));
    }
  });
});
