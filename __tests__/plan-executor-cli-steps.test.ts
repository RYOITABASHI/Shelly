jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION, buildAgentPlanSpec } from '@/lib/agent-plan-spec';

// Parallel CLI steps Inc0/Inc1 (docs/superpowers/specs/2026-11-01-parallel-cli-steps-plan.md,
// executor v19). Runs the REAL executor + broker against a loopback fake model
// server for the non-CLI steps, and a FAKE shelly-agent-driver.js injected via
// the test-only --agent-driver option. The fake records its argv / selected env
// / prompt, optionally prints the driver's ESCALATE lines, and writes the
// --answer-file — so these tests pin what the executor hands the gate, never
// what codex/claude would do.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-cli-steps';
const PIN = 'a'.repeat(64);

const FAKE_DRIVER = `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const recordDir = process.env.FAKE_DRIVER_RECORD_DIR;
const cfg = JSON.parse(fs.readFileSync(path.join(recordDir, 'config.json'), 'utf8'));
const engine = get('--engine');
const behavior = cfg[engine] || {};
const promptFile = get('--prompt-file');
const prompt = fs.readFileSync(promptFile, 'utf8');
let promptMode = null;
try { promptMode = fs.statSync(promptFile).mode & 0o777; } catch (_) {}
const startedAt = Date.now();
const finish = () => {
  const record = {
    argv,
    engine,
    prompt,
    promptMode,
    startedAt,
    endedAt: Date.now(),
    env: {
      SHELLY_AGENT_RUN_ID: process.env.SHELLY_AGENT_RUN_ID || null,
      SHELLY_AGENT_ID: process.env.SHELLY_AGENT_ID || null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY === undefined ? null : process.env.ANTHROPIC_API_KEY,
      SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: process.env.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED === undefined ? null : process.env.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED,
      SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: process.env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256 || null,
    },
  };
  fs.writeFileSync(path.join(recordDir, 'call-' + engine + '-' + process.pid + '.json'), JSON.stringify(record));
  if (behavior.answer !== undefined) fs.writeFileSync(get('--answer-file'), behavior.answer);
  if (behavior.usage && get('--usage-file')) fs.writeFileSync(get('--usage-file'), JSON.stringify(behavior.usage));
  process.exit(behavior.exit || 0);
};
if (behavior.hang) {
  fs.writeFileSync(path.join(recordDir, 'started-' + engine + '.json'), JSON.stringify({ pid: process.pid }));
  process.on('SIGTERM', () => {
    if (behavior.hang !== 'exit-on-term') return; // 'ignore-term'
    fs.writeFileSync(path.join(recordDir, 'term-' + engine), 'TERM');
    setTimeout(() => process.exit(0), 100);
  });
  setInterval(() => {}, 1000);
} else if (behavior.escalate) {
  process.stdout.write('ESCALATE human_required command="rm -rf build" reqId="r1" requestPath="/x" replyChannel="native" action=wait\\n');
  setTimeout(() => {
    process.stdout.write('ESCALATE_RESOLVED reqId="r1" decision="accept" elapsedMs=1\\n');
    setTimeout(finish, behavior.delayMs || 0);
  }, 300);
} else {
  setTimeout(finish, behavior.delayMs || 0);
}
`;

type Step = { instruction: string; parallelGroup?: string; tool?: Record<string, unknown> };

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-cli-'));
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

function writeDriverConfig(recordDir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(recordDir, 'config.json'), JSON.stringify(config));
}

function readCalls(recordDir: string): any[] {
  return fs.readdirSync(recordDir)
    .filter((n) => n.startsWith('call-'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf8')))
    .sort((a, b) => a.engine.localeCompare(b.engine));
}

function writePlan(home: string, port: number, steps: Step[], opts: { cliWorker?: unknown; requireActionApproval?: boolean; env?: string } = {}): string {
  const policy = { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true };
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'CLI Steps', autonomous: false, autonomyLevel: 'L2', requireActionApproval: opts.requireActionApproval === true },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'notify' },
    paths: { home },
    output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'cli-steps', useGlobalOutput: true, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy,
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list: steps, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } },
    ...(opts.cliWorker === undefined ? { cliWorker: { cwd: '', policy } } : opts.cliWorker === null ? {} : { cliWorker: opts.cliWorker }),
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    opts.env !== undefined ? opts.env : `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\nANTHROPIC_API_KEY='sk-ant-test-key-123'\n`,
  );
  return planFile;
}

function runExecutor(
  planFile: string,
  home: string,
  driver: string,
  recordDir: string,
  opts: { origin?: string; unattended?: boolean; extraArgs?: string[] } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker, '--agent-driver', driver]
      .concat(opts.unattended ? ['--unattended', '1'] : [])
      .concat(opts.extraArgs || []);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      FAKE_DRIVER_RECORD_DIR: recordDir,
      SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: PIN,
      SHELLY_RUN_ORIGIN: opts.origin === undefined ? 'user' : opts.origin,
    };
    delete env.ANTHROPIC_API_KEY;
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
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readProgress(home: string): any[] {
  return fs.readFileSync(path.join(logDir(home), 'progress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('shelly-plan-executor.js CLI steps (v19)', () => {
  let server: http.Server;
  let port = 0;
  let requests: string[];

  beforeEach((done) => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const content = JSON.parse(body).messages[0].content as string;
        requests.push(content);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Final digest built from both reviews.' } }] }));
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

  const parallelSteps: Step[] = [
    { instruction: 'review the diff with Codex', parallelGroup: 'g1', tool: { type: 'cli', cli: 'codex' } },
    { instruction: 'review the diff with Claude Code', parallelGroup: 'g1', tool: { type: 'cli', cli: 'claude' } },
    { instruction: 'combine both reviews' },
  ];

  it('attended Run now: each CLI branch goes through the driver with a fixed argv, explicit unattended:false, distinct runIds, overlapping in time', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, {
      codex: { answer: 'CODEX_REVIEW: the loop in parse() is off by one.', delayMs: 700, escalate: true },
      claude: { answer: 'CLAUDE_REVIEW: rename the helper for clarity.', delayMs: 700, usage: { inputTokens: 12, outputTokens: 34 } },
    });
    const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir);
    expect(result.status).toBe(0);

    const calls = readCalls(recordDir);
    expect(calls.map((c) => c.engine)).toEqual(['claude', 'codex']);
    const [claude, codex] = calls;

    // Invariant 1: fixed argv, gate flags always present, no shell.
    const expectArgv = (call: any, engine: string, index: number) => {
      const argv: string[] = call.argv;
      const value = (flag: string) => argv[argv.indexOf(flag) + 1];
      const flags = argv.filter((a) => a.startsWith('--'));
      expect(flags).toEqual([
        '--engine', '--cwd', '--approval-policy', '--policy-json', '--agent-id',
        '--escalation-public-key-sha256', '--escalation-timeout-action', '--audit-log',
        '--answer-file', '--prompt-file', ...(engine === 'claude' ? ['--usage-file'] : []),
      ]);
      expect(value('--engine')).toBe(engine);
      expect(value('--approval-policy')).toBe('untrusted');
      expect(value('--agent-id')).toBe(AGENT_ID);
      expect(value('--escalation-public-key-sha256')).toBe(PIN);
      expect(value('--escalation-timeout-action')).toBe('queue');
      expect(value('--audit-log')).toBe(path.join(logDir(home), `agent-driver-audit-s${index}.jsonl`));
      expect(value('--cwd')).toBe(home); // content-project default missing -> HOME
      // Invariant 2: unattended always explicit.
      const policy = JSON.parse(value('--policy-json'));
      expect(policy.unattended).toBe(false);
      expect(policy.level).toBe('L2');
      // Invariant 6: the key is never in argv.
      expect(argv.join(' ')).not.toContain('sk-ant-test-key-123');
    };
    expectArgv(codex, 'codex', 0);
    expectArgv(claude, 'claude', 1);

    // Invariant 4: independent runIds per branch.
    expect(codex.env.SHELLY_AGENT_RUN_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(claude.env.SHELLY_AGENT_RUN_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(codex.env.SHELLY_AGENT_RUN_ID).not.toBe(claude.env.SHELLY_AGENT_RUN_ID);
    expect(codex.env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256).toBe(PIN);

    // Invariant 6: the Anthropic key reaches ONLY the Claude child env.
    expect(claude.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-123');
    expect(claude.env.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED).toBe('1');
    expect(codex.env.ANTHROPIC_API_KEY).toBeNull();
    expect(codex.env.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED).toBeNull();

    // Invariant 7: branch isolation (no sibling output) + private prompt files.
    expect(codex.prompt).toContain('review the diff with Codex');
    expect(codex.prompt).not.toContain('CLAUDE_REVIEW');
    expect(claude.prompt).not.toContain('CODEX_REVIEW');
    if (process.platform !== 'win32') {
      expect(codex.promptMode).toBe(0o600);
      expect(claude.promptMode).toBe(0o600);
    }
    // Per-branch temp files are removed afterwards.
    expect(fs.readdirSync(path.join(home, '.shelly/tmp')).filter((n) => n.startsWith('plan-cli-'))).toEqual([]);

    // Wall-clock parallel: both started before either finished.
    expect(Math.max(codex.startedAt, claude.startedAt)).toBeLessThan(Math.min(codex.endedAt, claude.endedAt));

    // The final (local) step sees both answers in declared order.
    expect(requests).toHaveLength(1);
    expect(requests[0].indexOf('CODEX_REVIEW')).toBeGreaterThan(-1);
    expect(requests[0].indexOf('CODEX_REVIEW')).toBeLessThan(requests[0].indexOf('CLAUDE_REVIEW'));

    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success']);

    // Progress: CLI provider, ESCALATE -> WAITING_APPROVAL -> RUNNING, usage.
    const events = readProgress(home);
    const toolEvents = events.filter((e) => e.kind === 'tool' && e.stepIndex <= 1);
    expect(toolEvents.map((e) => e.provider)).toEqual(expect.arrayContaining([
      { kind: 'CLI', name: 'cli:codex' },
      { kind: 'CLI', name: 'cli:claude' },
    ]));
    const s0 = events.filter((e) => e.kind === 'branch_state' && e.stepIndex === 0).map((e) => e.state);
    expect(s0).toEqual(['STANDBY', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING', 'DONE']);
    expect(events.some((e) => e.kind === 'usage' && e.stepIndex === 1 && e.usage.outputTokens === 34)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('sk-ant-test-key-123');

    const audit = readAudit(home);
    expect(audit.filter((e) => e.event === 'cli_branch_start').map((e) => e.engine).sort()).toEqual(['claude', 'codex']);
    expect(audit.filter((e) => e.event === 'cli_branch_end').every((e) => e.exitCode === 0)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('sk-ant-test-key-123');
  }, 60000);

  it.each([
    ['--unattended run', { unattended: true }],
    ['scheduled origin', { origin: 'schedule' }],
    ['missing origin', { origin: '' }],
  ])('%s: the run is SKIPPED visibly before any step, the driver is never spawned (no plan.tool substitution)', async (_label, opts) => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, { codex: { answer: 'should never run' } });
    const steps: Step[] = [
      { instruction: 'collect notes' }, // a non-CLI step BEFORE the CLI one never runs either
      { instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'finalize' },
    ];
    const result = await runExecutor(writePlan(home, port, steps), home, driver, recordDir, opts as any);
    expect(result.status).toBe(0); // exit 0: native never records a hard failure for it
    expect(readCalls(recordDir)).toEqual([]);
    expect(requests).toEqual([]); // no step ran, not on plan.tool either
    const log = readRunLog(home);
    // 'skipped', never 'error': native's softFailure (latest run log status
    // == "error") and the RN circuit breaker (only 'error' counts) ignore it.
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toContain(executor.CLI_STEP_ATTENDED_ONLY_MESSAGE);
    // The user sees why: native result notification + MONITOR progress.
    const notify = JSON.parse(fs.readFileSync(path.join(logDir(home), 'native-result-notification.json'), 'utf8'));
    expect(notify.status).toBe('skipped');
    expect(notify.preview).toContain('runs only with Run now');
    const events = readProgress(home);
    expect(events[events.length - 1]).toMatchObject({ kind: 'run_end', status: 'skipped' });
    expect(events.some((e) => e.kind === 'tail' && e.stepIndex === 1 && /runs only with Run now/.test(e.tail))).toBe(true);
    expect(events.filter((e) => e.kind === 'branch_state' && e.state === 'SKIPPED').map((e) => e.stepIndex).sort()).toEqual([0, 1, 2]);
    expect(readAudit(home).some((e) => e.event === 'cli_branch_refused' && e.stepIndex === 1)).toBe(true);
  }, 60000);

  it('repeated refused scheduled fires never trip the failure backoff or the circuit breaker', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { consecutiveFailures, shouldTripCircuitBreaker } = require('@/lib/agent-circuit-breaker');
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, {});
    const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
    const planFile = writePlan(home, port, steps);
    for (let i = 0; i < 4; i += 1) {
      const result = await runExecutor(planFile, home, driver, recordDir, { unattended: true, origin: 'schedule' });
      expect(result.status).toBe(0);
      await delay(1100); // run logs are keyed by epoch second
    }
    const logs = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort()
      .map((n) => JSON.parse(fs.readFileSync(path.join(logDir(home), n), 'utf8')));
    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs.every((l) => l.status === 'skipped')).toBe(true);
    // RN (lib/agent-circuit-breaker.ts, A4 auto-disable): no streak.
    expect(consecutiveFailures(logs)).toBe(0);
    expect(shouldTripCircuitBreaker(logs)).toBe(false);
    // Native (AgentRuntime.kt runPlanAgent): a hard failure is only exit != 0
    // or an unattended exit 0 whose latest run log is "error" — pin that the
    // PlanSpec path still keys on exactly those, so 'skipped' + exit 0 never
    // reaches recordNativeHardFailure / NATIVE_FAILURE_BACKOFF_THRESHOLD.
    const kotlin = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'), 'utf8');
    const planAgent = kotlin.slice(kotlin.indexOf('private fun runPlanAgent('), kotlin.indexOf('private fun ensureLocalLlmServerBeforePlanExecutor'));
    expect(planAgent).toContain('val softFailure = unattended && exitCode == 0 && latestRunLogStatus(homeDir, agentId) == "error"');
    expect(planAgent).toContain('if (exitCode == 0 && !softFailure) {');
    expect(planAgent).toContain('resetNativeFailureCount(homeDir, agentId)');
  }, 60000);

  describe('SIGTERM (STOP-ALL) stops CLI drivers TERM -> grace -> KILL and removes their temp files', () => {
    function spawnChild(script: string): import('child_process').ChildProcess {
      return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    }
    function alive(pid: number): boolean {
      try {
        process.kill(pid, 0);
      } catch (_) {
        return false;
      }
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const state = stat.charAt(stat.lastIndexOf(')') + 2);
        return state !== 'Z' && state !== 'X';
      } catch (_) {
        return true;
      }
    }

    it('stopLiveCliChildrenSync: a TERM-respecting driver exits in the grace period, an ignoring one is KILLed, files are unlinked', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-cli-stop-'));
      const marker = path.join(dir, 'term-seen');
      const polite = spawnChild(`process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'1');process.exit(0)});setInterval(()=>{},1000)`);
      const stubborn = spawnChild(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`);
      await delay(800); // let both install their handlers
      const files = ['a.prompt', 'a.answer', 'b.prompt', 'b.usage.json'].map((n) => path.join(dir, n));
      files.forEach((f) => fs.writeFileSync(f, 'x'));
      executor.liveCliChildren.set(polite, files.slice(0, 2));
      executor.liveCliChildren.set(stubborn, files.slice(2));
      const t0 = Date.now();
      executor.stopLiveCliChildrenSync(1500);
      const elapsed = Date.now() - t0;
      expect(executor.liveCliChildren.size).toBe(0);
      expect(files.filter((f) => fs.existsSync(f))).toEqual([]);
      await delay(300);
      expect(alive(polite.pid!)).toBe(false);
      expect(alive(stubborn.pid!)).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.existsSync(marker)).toBe(true); // got TERM, not an immediate KILL
        expect(elapsed).toBeGreaterThanOrEqual(1400); // waited the grace for the stubborn one
        expect(elapsed).toBeLessThan(4000);
      }
    }, 20000);

    // Windows cannot deliver a catchable SIGTERM to the executor; CI (Linux) runs it.
    (process.platform === 'win32' ? it.skip : it)('executor SIGTERM while a CLI branch runs: driver gets TERM, tmp plan-cli-* files are removed', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { codex: { hang: 'exit-on-term' }, claude: { hang: 'ignore-term' } });
      const planFile = writePlan(home, port, parallelSteps);
      const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker, '--agent-driver', driver];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, HOME: home, FAKE_DRIVER_RECORD_DIR: recordDir, SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: PIN, SHELLY_RUN_ORIGIN: 'user' },
        stdio: 'ignore',
      });
      const closed = new Promise<number | null>((resolve) => child.on('close', (s) => resolve(s)));
      for (let i = 0; i < 200; i += 1) {
        if (fs.existsSync(path.join(recordDir, 'started-codex.json')) && fs.existsSync(path.join(recordDir, 'started-claude.json'))) break;
        await delay(50);
      }
      const pids = ['codex', 'claude'].map((e) => JSON.parse(fs.readFileSync(path.join(recordDir, `started-${e}.json`), 'utf8')).pid as number);
      expect(fs.readdirSync(path.join(home, '.shelly/tmp')).some((n) => n.startsWith('plan-cli-') && n.endsWith('.prompt'))).toBe(true);
      const t0 = Date.now();
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(fs.existsSync(path.join(recordDir, 'term-codex'))).toBe(true);
      await delay(300);
      pids.forEach((pid) => expect(alive(pid)).toBe(false));
      expect(fs.readdirSync(path.join(home, '.shelly/tmp')).filter((n) => n.startsWith('plan-cli-'))).toEqual([]);
      expect(readRunLog(home).status).toBe('skipped');
    }, 30000);
  });

  it('a driver failure (non-zero exit / empty answer) fails the branch, the group fails fast', async () => {
    for (const behavior of [{ exit: 3, answer: 'partial' }, { answer: '' }]) {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      requests = [];
      writeDriverConfig(recordDir, { codex: behavior, claude: { answer: 'CLAUDE_REVIEW ok, looks fine to merge.' } });
      const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir);
      expect(result.status).toBe(0);
      expect(readCalls(recordDir)).toHaveLength(2);
      expect(requests).toEqual([]); // the post-group step never launched
      const log = readRunLog(home);
      expect(log.status).toBe('error');
      expect(log.steps[0].status).toBe('error');
      expect(log.steps[1].status).toBe('success');
    }
  }, 60000);

  it('a plan without cliWorker (built before CLI steps) fails closed', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, { codex: { answer: 'x' } });
    const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
    await runExecutor(writePlan(home, port, steps, { cliWorker: null }), home, driver, recordDir);
    expect(readCalls(recordDir)).toEqual([]);
    expect(readRunLog(home).steps[0].outputPreview).toContain('predates CLI steps');
  }, 60000);

  it('an unknown CLI worker id is refused, never spawned', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, {});
    const steps: Step[] = [{ instruction: 'do it with gemini cli', tool: { type: 'cli', cli: 'gemini' } }, { instruction: 'finalize' }];
    await runExecutor(writePlan(home, port, steps), home, driver, recordDir);
    expect(readCalls(recordDir)).toEqual([]);
    expect(readRunLog(home).steps[0].outputPreview).toContain('unsupported worker');
  }, 60000);

  describe('signed action approval (Inc0, native reply format)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const derSha = crypto.createHash('sha256').update(der).digest('hex');

    function signNative(runId: string, decision: string, requestTs: string, requestSha256: string, key = privateKey): string {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update([runId, decision, requestTs, requestSha256].join('\n'), 'utf8');
      signer.end();
      return signer.sign(key).toString('base64');
    }

    function nativeReply(runId: string, decision: string, requestTs: string, requestSha256: string, signature: string) {
      return { runId, decision, by: 'human', requestSha256, requestTs, sigAlg: 'SHA256withRSA', signature, ts: new Date().toISOString() };
    }

    it('verifyNativeActionApprovalReply accepts exactly what AgentActionApprovalBridge.writeHumanReply signs', () => {
      const sha = 'b'.repeat(64);
      const ts = '2026-11-01T00:00:00.000Z';
      const deps = { publicKey: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), expectedKeySha256: derSha };
      const expected = { runId: 'run-1', requestSha256: sha, requestTs: ts };
      const good = nativeReply('run-1', 'accept', ts, sha, signNative('run-1', 'accept', ts, sha));
      expect(executor.verifyNativeActionApprovalReply(good, expected, deps)).toEqual({ ok: true, reason: 'ok' });
      // Tampered decision (signature was over 'decline').
      const flipped = nativeReply('run-1', 'accept', ts, sha, signNative('run-1', 'decline', ts, sha));
      expect(executor.verifyNativeActionApprovalReply(flipped, expected, deps).reason).toBe('bad-signature');
      // Wrong key.
      const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const forged = nativeReply('run-1', 'accept', ts, sha, signNative('run-1', 'accept', ts, sha, other));
      expect(executor.verifyNativeActionApprovalReply(forged, expected, deps).reason).toBe('bad-signature');
      // Unsigned / no pin / other request.
      expect(executor.verifyNativeActionApprovalReply({ ...good, signature: '' }, expected, deps).reason).toBe('bad-signature');
      expect(executor.verifyNativeActionApprovalReply(good, expected, { ...deps, expectedKeySha256: '' }).reason).toBe('key-pin-mismatch');
      expect(executor.verifyNativeActionApprovalReply(good, { ...expected, requestTs: 'x' }, deps).reason).toBe('request-ts-mismatch');
      expect(executor.verifyNativeActionApprovalReply(good, { ...expected, requestSha256: 'c'.repeat(64) }, deps).reason).toBe('request-sha-mismatch');
      expect(executor.verifyNativeActionApprovalReply({ ...good, by: 'test' }, expected, deps).reason).toBe('bad-author');
    });

    it('planHasCliSteps', () => {
      expect(executor.planHasCliSteps({ steps: { list: [{ instruction: 'a', tool: { type: 'cli', cli: 'codex' } }] } })).toBe(true);
      expect(executor.planHasCliSteps({ steps: { list: [{ instruction: 'a', tool: { type: 'local' } }] } })).toBe(false);
      expect(executor.planHasCliSteps({})).toBe(false);
    });

    async function runWithApprovalReply(sign: 'none' | 'valid', extraArgs: string[]) {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { codex: { answer: 'CODEX_REVIEW all good, ship it.' } });
      const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
      const planFile = writePlan(home, port, steps, { requireActionApproval: true });
      const running = runExecutor(planFile, home, driver, recordDir, { extraArgs });
      const requestDir = path.join(home, '.shelly/agents/action-approvals');
      let replied = false;
      for (let i = 0; i < 400 && !replied; i += 1) {
        const names = fs.existsSync(requestDir) ? fs.readdirSync(requestDir).filter((n) => n.startsWith('action-') && n.endsWith('.json')) : [];
        if (names.length) {
          const bytes = fs.readFileSync(path.join(requestDir, names[0]));
          const request = JSON.parse(bytes.toString('utf8'));
          const sha = crypto.createHash('sha256').update(bytes).digest('hex');
          const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
          fs.mkdirSync(replyDir, { recursive: true });
          const reply = sign === 'valid'
            ? nativeReply(request.runId, 'accept', request.ts, sha, signNative(request.runId, 'accept', request.ts, sha))
            : { runId: request.runId, decision: 'accept', by: 'human', requestSha256: sha, ts: new Date().toISOString() };
          fs.writeFileSync(path.join(replyDir, `action-${request.runId}.reply.json`), JSON.stringify(reply) + '\n');
          replied = true;
        } else {
          await delay(50);
        }
      }
      expect(replied).toBe(true);
      await running;
      return home;
    }

    it('a CLI plan declines an unsigned (equality-only) reply', async () => {
      const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-aa-key-')), 'aa.der');
      fs.writeFileSync(keyFile, der);
      const home = await runWithApprovalReply('none', ['--signed-approval-public-key', keyFile, '--signed-approval-public-key-sha256', derSha]);
      const log = readRunLog(home);
      expect(log.status).toBe('skipped');
      expect(readAudit(home).some((e) => e.event === 'action_approval_signature_rejected')).toBe(true);
    }, 60000);

    it('a CLI plan with no pinned key declines even a validly signed reply (fail closed)', async () => {
      const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-aa-key-')), 'aa.der');
      fs.writeFileSync(keyFile, der);
      const home = await runWithApprovalReply('valid', ['--signed-approval-public-key', keyFile]);
      expect(readRunLog(home).status).toBe('skipped');
    }, 60000);

    it('a CLI plan accepts native\'s signed reply against the pinned key', async () => {
      const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-aa-key-')), 'aa.der');
      fs.writeFileSync(keyFile, der);
      const home = await runWithApprovalReply('valid', ['--signed-approval-public-key', keyFile, '--signed-approval-public-key-sha256', derSha]);
      const log = readRunLog(home);
      expect(log.status).toBe('success');
      expect(readAudit(home).some((e) => e.event === 'action_approval_signature_rejected')).toBe(false);
    }, 60000);
  });
});

describe('buildAgentPlanSpec cliWorker (Inc1)', () => {
  const baseAgent: any = {
    id: 'agent-cliw',
    name: 'CLI worker',
    prompt: 'Review the repo',
    tool: { type: 'local' },
    schedule: '',
    enabled: true,
    outputPath: '~/agent-output',
    autonomyLevel: 'L2',
    createdAt: 1,
    updatedAt: 1,
  };

  it('bakes cliWorker {cwd, policy(unattended:true)} only when a step names a CLI worker', () => {
    const withCli = buildAgentPlanSpec({
      ...baseAgent,
      orchestration: { steps: [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, 'summarize'] },
    });
    expect(withCli.cliWorker).toBeDefined();
    expect(withCli.cliWorker!.cwd).toBe('');
    expect(withCli.cliWorker!.policy.unattended).toBe(true);
    expect(withCli.cliWorker!.policy.level).toBe('L2');

    const withoutCli = buildAgentPlanSpec({ ...baseAgent, orchestration: { steps: ['collect', 'summarize'] } });
    expect(withoutCli.cliWorker).toBeUndefined();
    expect(buildAgentPlanSpec(baseAgent).cliWorker).toBeUndefined();
  });

  it('cliWorker.cwd is the agent workspaceRoot only when it validates', () => {
    const ok = buildAgentPlanSpec({
      ...baseAgent,
      workspaceRoot: '/home/shelly-test/projects/app',
      orchestration: { steps: [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, 'summarize'] },
    });
    expect(ok.cliWorker!.cwd).toBe('/home/shelly-test/projects/app');
    const bad = buildAgentPlanSpec({
      ...baseAgent,
      workspaceRoot: '/',
      orchestration: { steps: [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, 'summarize'] },
    });
    expect(bad.cliWorker!.cwd).toBe('');
  });
});
