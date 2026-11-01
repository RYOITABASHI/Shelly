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
import { cliBranchOverlap } from '@/lib/agent-progress';

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
// v20: the phantom-headroom check counts own-uid processes; tests pin it to
// an empty fake /proc unless they exercise it (a busy CI host would serialize).
const EMPTY_PROC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fake-proc-'));

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
if (behavior.grandchild) {
  // v20 tree-kill: a child of the driver (stands in for codex_tui / claude).
  const gc = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(recordDir, 'grandchild-' + engine + '.pid'), String(gc.pid));
}
const fanoutFile = cfg.locksDir ? path.join(cfg.locksDir, cfg.agentId + '.fanout.pid') : '';
const fanoutAt = (when) => {
  if (!fanoutFile) return null;
  let pid = null;
  try { pid = fs.readFileSync(fanoutFile, 'utf8').trim(); } catch (_) {}
  return { when, pid, starttime: fs.existsSync(fanoutFile + '.lockdir/starttime') };
};
const fanoutStart = fanoutAt('start');
// v24 heartbeat: driver stdout lines printed at start (e.g. an AUDIT item_started).
for (const line of behavior.lines || []) process.stdout.write(line + '\\n');
const finish = () => {
  const record = {
    ppid: process.ppid,
    fanoutStart,
    fanoutEnd: fanoutAt('end'),
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
  opts: { origin?: string; unattended?: boolean; extraArgs?: string[]; procRoot?: string; extraEnv?: Record<string, string> } = {},
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
      SHELLY_PLAN_EXECUTOR_PROC_ROOT: opts.procRoot || EMPTY_PROC_ROOT,
      ...(opts.extraEnv || {}),
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
  let serverReply: string | null = null;

  beforeEach((done) => {
    requests = [];
    serverReply = null;
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const content = JSON.parse(body).messages[0].content as string;
        requests.push(content);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: serverReply ?? 'Final digest built from both reviews.' } }] }));
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
      codex: { answer: 'CODEX_REVIEW: the loop in parse() is off by one.', delayMs: 700, escalate: true, usage: { inputTokens: 100, outputTokens: 6 } },
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
        '--escalation-public-key-sha256', '--escalation-timeout-action', '--escalation-timeout-ms', '--timeout-ms', '--audit-log',
        // v22: every engine gets the usage sidecar (Codex included).
        '--answer-file', '--prompt-file', '--usage-file',
      ]);
      expect(value('--engine')).toBe(engine);
      expect(value('--approval-policy')).toBe('untrusted');
      expect(value('--agent-id')).toBe(AGENT_ID);
      expect(value('--escalation-public-key-sha256')).toBe(PIN);
      expect(value('--escalation-timeout-action')).toBe('queue');
      // v20: the driver's turn timeout ends just under the branch timeout.
      expect(Number(value('--timeout-ms'))).toBe(executor.CLI_DRIVER_TIMEOUT_MS);
      expect(executor.CLI_DRIVER_TIMEOUT_MS).toBeGreaterThan(300000);
      expect(executor.CLI_DRIVER_TIMEOUT_MS).toBeLessThan(20 * 60 * 1000);
      // v23: the ask waits 10 min (not the driver's 120 s default), under
      // the turn timeout.
      expect(Number(value('--escalation-timeout-ms'))).toBe(executor.CLI_ESCALATION_TIMEOUT_MS);
      expect(executor.CLI_ESCALATION_TIMEOUT_MS).toBe(10 * 60 * 1000);
      expect(executor.CLI_ESCALATION_TIMEOUT_MS).toBeLessThan(executor.CLI_DRIVER_TIMEOUT_MS);
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
    // v21 (Inc3): the CLI workers' reported usage reaches the run's totals;
    // v22: Codex's tokens are counted too.
    expect(log.usage).toEqual({ inputTokens: 112, outputTokens: 40 });
    // Inc3 finish log: the RN side computes overlapMs from this very stream.
    const progressText = fs.readFileSync(path.join(logDir(home), 'progress.jsonl'), 'utf8');
    const runId = JSON.parse(progressText.split('\n')[0]).runId;
    const overlap = cliBranchOverlap(progressText, runId);
    expect(overlap.cliBranches).toBe(2);
    expect(overlap.overlapMs).toBeGreaterThan(0);

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
    expect(events.some((e) => e.kind === 'usage' && e.stepIndex === 0 && e.usage.inputTokens === 100 && e.usage.outputTokens === 6)).toBe(true);
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
        env: { ...process.env, HOME: home, FAKE_DRIVER_RECORD_DIR: recordDir, SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: PIN, SHELLY_RUN_ORIGIN: 'user', SHELLY_PLAN_EXECUTOR_PROC_ROOT: EMPTY_PROC_ROOT },
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

  describe('CLI slot pool (v20, Inc2): total 2 / per engine 1 / other agents / phantom headroom / fan-out lock / tree-kill', () => {
    const locksOf = (home: string) => path.join(home, '.shelly/agents/locks');
    const overlap = (a: any, b: any) => Math.max(a.startedAt, b.startedAt) < Math.min(a.endedAt, b.endedAt);
    const fanoutSeen = (calls: any[]) => calls.flatMap((c) => [c.fanoutStart, c.fanoutEnd]).filter((f) => f && f.pid);
    const slotWaits = (home: string) => readAudit(home).filter((e) => e.event === 'cli_slot_wait');
    const fanoutLeft = (home: string) => (fs.existsSync(locksOf(home)) ? fs.readdirSync(locksOf(home)).filter((n) => n.includes('fanout')) : []);
    function procAlive(pid: number): boolean {
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
    async function waitFor(check: () => boolean, ms = 10000): Promise<boolean> {
      for (let waited = 0; waited < ms; waited += 50) {
        if (check()) return true;
        await delay(50);
      }
      return check();
    }
    const twoCodexSteps: Step[] = [
      { instruction: 'review the parser with Codex', parallelGroup: 'g1', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'review the renderer with Codex', parallelGroup: 'g1', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'combine both reviews' },
    ];
    const reviewers = (delayMs: number) => ({
      codex: { answer: 'CODEX_REVIEW: the loop in parse() is off by one.', delayMs },
      claude: { answer: 'CLAUDE_REVIEW: rename the helper for clarity.', delayMs },
    });

    it('different engines overlap; locks/<id>.fanout.pid (executor pid + starttime record) exists only during the overlap', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { locksDir: locksOf(home), agentId: AGENT_ID, ...reviewers(1200) });
      const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir);
      expect(result.status).toBe(0);
      const calls = readCalls(recordDir);
      expect(calls).toHaveLength(2);
      expect(overlap(calls[0], calls[1])).toBe(true);
      const seen = fanoutSeen(calls);
      expect(seen.length).toBeGreaterThan(0);
      for (const f of seen) {
        expect(f.pid).toBe(String(calls[0].ppid)); // the executor itself
        if (process.platform === 'linux') expect(f.starttime).toBe(true);
      }
      expect(slotWaits(home)).toEqual([]);
      expect(fanoutLeft(home)).toEqual([]);
      expect(readRunLog(home).status).toBe('success');
    }, 60000);

    it('two branches of the same engine run one after the other (MONITOR tail "Waiting for CLI slot"), no fan-out lock', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { locksDir: locksOf(home), agentId: AGENT_ID, ...reviewers(800) });
      const result = await runExecutor(writePlan(home, port, twoCodexSteps), home, driver, recordDir);
      expect(result.status).toBe(0);
      const calls = readCalls(recordDir);
      expect(calls.map((c) => c.engine)).toEqual(['codex', 'codex']);
      expect(overlap(calls[0], calls[1])).toBe(false);
      expect(slotWaits(home).map((e) => e.reason)).toEqual(['engine']);
      expect(readAudit(home).filter((e) => e.event === 'cli_slot_acquired')).toHaveLength(1);
      expect(readProgress(home).some((e) => e.kind === 'tail' && /^Waiting for CLI slot/.test(e.tail))).toBe(true);
      expect(fanoutSeen(calls)).toEqual([]);
      expect(fanoutLeft(home)).toEqual([]);
      const log = readRunLog(home);
      expect(log.status).toBe('success');
      expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success']);
    }, 60000);

    it('another agent holding a live locks/*.pid serializes the CLI branches (the .sh MAX_CONCURRENT=2 would be exceeded)', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      fs.mkdirSync(locksOf(home), { recursive: true });
      const otherLock = path.join(locksOf(home), 'agent-other.pid');
      fs.writeFileSync(otherLock, `${process.pid}\n`); // a live pid that is not the executor
      fs.writeFileSync(path.join(locksOf(home), 'agent-dead.pid'), '999999999\n'); // stale: not counted
      writeDriverConfig(recordDir, { locksDir: locksOf(home), agentId: AGENT_ID, ...reviewers(800) });
      const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir);
      expect(result.status).toBe(0);
      const calls = readCalls(recordDir);
      expect(calls).toHaveLength(2);
      expect(overlap(calls[0], calls[1])).toBe(false);
      expect(slotWaits(home).map((e) => e.reason)).toEqual(['other-agents']);
      expect(fanoutSeen(calls)).toEqual([]);
      expect(fs.existsSync(otherLock)).toBe(true); // never touched
      expect(readRunLog(home).status).toBe('success');
    }, 60000);

    it('no phantom-process headroom (own-uid processes + 8 > 28) serializes the CLI branches', async () => {
      const busyProc = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-busy-proc-'));
      for (let pid = 100; pid < 121; pid += 1) fs.mkdirSync(path.join(busyProc, String(pid)));
      fs.mkdirSync(path.join(busyProc, 'self'));
      fs.mkdirSync(path.join(busyProc, 'sys'));
      expect(executor.countOwnUidProcesses(busyProc)).toBe(21);
      expect(executor.countOwnUidProcesses(path.join(busyProc, 'missing'))).toBe(0);
      expect(21 + executor.CLI_BRANCH_PROCESS_COST).toBeGreaterThan(executor.PHANTOM_PROCESS_CEILING);

      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { locksDir: locksOf(home), agentId: AGENT_ID, ...reviewers(800) });
      const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir, { procRoot: busyProc });
      expect(result.status).toBe(0);
      const calls = readCalls(recordDir);
      expect(calls).toHaveLength(2);
      expect(overlap(calls[0], calls[1])).toBe(false);
      expect(slotWaits(home).map((e) => e.reason)).toEqual(['phantom']);
      expect(fanoutSeen(calls)).toEqual([]);
      expect(readRunLog(home).status).toBe('success');
    }, 60000);

    // Windows cannot deliver a catchable SIGTERM to the executor and has no
    // /proc to walk; CI (Linux) runs these.
    (process.platform === 'linux' ? it : it.skip)('executor SIGTERM during the overlap removes the fan-out lock and KILLs a TERM-ignoring driver\'s child', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, {
        locksDir: locksOf(home),
        agentId: AGENT_ID,
        codex: { hang: 'exit-on-term' },
        claude: { hang: 'ignore-term', grandchild: true },
      });
      const planFile = writePlan(home, port, parallelSteps);
      const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker, '--agent-driver', driver];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, HOME: home, FAKE_DRIVER_RECORD_DIR: recordDir, SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256: PIN, SHELLY_RUN_ORIGIN: 'user', SHELLY_PLAN_EXECUTOR_PROC_ROOT: EMPTY_PROC_ROOT },
        stdio: 'ignore',
      });
      const closed = new Promise<number | null>((resolve) => child.on('close', (s) => resolve(s)));
      const fanout = path.join(locksOf(home), `${AGENT_ID}.fanout.pid`);
      expect(await waitFor(() => ['started-codex.json', 'started-claude.json', 'grandchild-claude.pid'].every((n) => fs.existsSync(path.join(recordDir, n))))).toBe(true);
      expect(await waitFor(() => fs.existsSync(fanout))).toBe(true);
      expect(fs.readFileSync(fanout, 'utf8').trim()).toBe(String(child.pid));
      const startRecord = fs.readFileSync(`${fanout}.lockdir/starttime`, 'utf8').trim();
      const ownStat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      expect(startRecord).toBe(ownStat.slice(ownStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
      const grandchild = Number(fs.readFileSync(path.join(recordDir, 'grandchild-claude.pid'), 'utf8'));
      expect(procAlive(grandchild)).toBe(true);
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(fs.existsSync(fanout)).toBe(false);
      expect(fs.existsSync(`${fanout}.lockdir`)).toBe(false);
      expect(await waitFor(() => !procAlive(grandchild), 3000)).toBe(true);
      expect(readRunLog(home).status).toBe('skipped');
    }, 30000);

    (process.platform === 'linux' ? it : it.skip)('STOP-ALL (.halted) mid-turn: a TERM-ignoring driver is KILLed together with its child (no orphaned codex/claude)', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { codex: { hang: 'ignore-term', grandchild: true } });
      const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
      const running = runExecutor(writePlan(home, port, steps), home, driver, recordDir);
      expect(await waitFor(() => fs.existsSync(path.join(recordDir, 'grandchild-codex.pid')) && fs.existsSync(path.join(recordDir, 'started-codex.json')))).toBe(true);
      const driverPid = JSON.parse(fs.readFileSync(path.join(recordDir, 'started-codex.json'), 'utf8')).pid as number;
      const grandchild = Number(fs.readFileSync(path.join(recordDir, 'grandchild-codex.pid'), 'utf8'));
      expect(executor.listDescendantProcs(driverPid).map((p: any) => p.pid)).toContain(grandchild);
      fs.writeFileSync(path.join(home, '.shelly/agents/.halted'), 'test\n');
      const result = await running;
      expect(result.status).toBe(0);
      expect(await waitFor(() => !procAlive(driverPid) && !procAlive(grandchild), 3000)).toBe(true);
      expect(requests).toEqual([]); // the final step never ran
    }, 30000);
    it('a stale <id>.fanout.pid (+ lockdir) left by a dead run is removed once this run holds the agent lock', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      fs.mkdirSync(path.join(locksOf(home), `${AGENT_ID}.fanout.pid.lockdir`), { recursive: true });
      const stale = path.join(locksOf(home), `${AGENT_ID}.fanout.pid`);
      fs.writeFileSync(stale, `${process.pid}\n`); // a live (recycled) pid: removeFanoutLock alone would keep it
      fs.writeFileSync(`${stale}.lockdir/starttime`, '1\n');
      writeDriverConfig(recordDir, { locksDir: locksOf(home), agentId: AGENT_ID, codex: { answer: 'CODEX_REVIEW all good, ship it.' } });
      const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
      const result = await runExecutor(writePlan(home, port, steps), home, driver, recordDir);
      expect(result.status).toBe(0);
      const [call] = readCalls(recordDir);
      expect(call.fanoutStart.pid).toBeNull(); // already gone when the CLI step started
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(`${stale}.lockdir`)).toBe(false);
      expect(readRunLog(home).status).toBe('success');
    }, 60000);

    it('native 30-min ceiling: a CLI step with too little run time left fails visibly without starting the driver', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { codex: { answer: 'should never run' } });
      const steps: Step[] = [{ instruction: 'review with Codex', tool: { type: 'cli', cli: 'codex' } }, { instruction: 'finalize' }];
      const result = await runExecutor(writePlan(home, port, steps), home, driver, recordDir, {
        extraEnv: { SHELLY_PLAN_EXECUTOR_RUN_CEILING_MS: '30000', SHELLY_PLAN_EXECUTOR_CLI_MIN_RUN_MS: '60000' },
      });
      expect(result.status).toBe(0);
      expect(readCalls(recordDir)).toEqual([]);
      expect(requests).toEqual([]);
      expect(readAudit(home).filter((e) => e.event === 'cli_run_time_exhausted').map((e) => e.waitedMs)).toEqual([0]);
      expect(readProgress(home).some((e) => e.kind === 'tail' && /not enough run time left/.test(e.tail))).toBe(true);
      const log = readRunLog(home);
      expect(log.status).toBe('error');
      expect(log.steps[0].outputPreview).toMatch(/not enough run time left/);
    }, 60000);

    it('native 30-min ceiling: a serialized CLI branch stops waiting when the run would run out, and the running branch\'s timers are clamped to the run', async () => {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, { codex: { answer: 'CODEX_REVIEW: the loop in parse() is off by one.', delayMs: 4500 } });
      // deadline = start + 20s - 2s; a branch needs 15s, so waiting ends at ~start + 3s.
      const result = await runExecutor(writePlan(home, port, twoCodexSteps), home, driver, recordDir, {
        extraEnv: { SHELLY_PLAN_EXECUTOR_RUN_CEILING_MS: '20000', SHELLY_PLAN_EXECUTOR_CLI_MIN_RUN_MS: '15000' },
      });
      expect(result.status).toBe(0);
      const calls = readCalls(recordDir);
      expect(calls).toHaveLength(1); // the waiting branch never spawned a driver
      const timeoutMs = Number(calls[0].argv[calls[0].argv.indexOf('--timeout-ms') + 1]);
      expect(timeoutMs).toBeGreaterThan(5000);
      expect(timeoutMs).toBeLessThan(18000);
      // v23: a clamped turn clamps the approval wait under it too.
      const escalationMs = Number(calls[0].argv[calls[0].argv.indexOf('--escalation-timeout-ms') + 1]);
      expect(escalationMs).toBe(executor.cliEscalationTimeoutMs(timeoutMs));
      expect(escalationMs).toBeLessThan(timeoutMs);
      const audit = readAudit(home);
      expect(audit.filter((e) => e.event === 'cli_slot_wait').map((e) => e.reason)).toEqual(['engine']);
      const exhausted = audit.filter((e) => e.event === 'cli_run_time_exhausted');
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0].waitedMs).toBeGreaterThan(0);
      expect(requests).toEqual([]); // the group failed fast
      const log = readRunLog(home);
      expect(log.status).toBe('error');
      expect(log.steps.map((s: any) => s.status).slice(0, 2).sort()).toEqual(['error', 'success']);
    }, 60000);

    it('cliBranchTimeouts: unclamped = 20 min / driver 19.5 min; near the ceiling both shrink to the time left', () => {
      const far = executor.cliBranchTimeouts({ deadlineMs: Date.now() + 60 * 60_000, minRunMs: 1 });
      expect(far.branchMs).toBe(20 * 60_000);
      expect(far.driverMs).toBe(executor.CLI_DRIVER_TIMEOUT_MS);
      const near = executor.cliBranchTimeouts({ deadlineMs: Date.now() + 5 * 60_000, minRunMs: 1 });
      expect(near.branchMs).toBeLessThanOrEqual(5 * 60_000);
      expect(near.branchMs).toBeGreaterThan(5 * 60_000 - 1000);
      expect(near.driverMs).toBe(near.branchMs - 30_000);
    });

    (process.platform === 'linux' ? it : it.skip)('stopLiveCliChildrenSync never walks / kills the descendants of a driver that already exited (recycled pid)', async () => {
      const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      await delay(300);
      // An exited driver whose pid now names this jest worker (the bystander's parent).
      const exited: any = { pid: process.pid, exitCode: 0, signalCode: null, kill: () => true };
      executor.liveCliChildren.set(exited, []);
      executor.stopLiveCliChildrenSync(0);
      await delay(200);
      expect(procAlive(bystander.pid!)).toBe(true);
      bystander.kill('SIGKILL');
    }, 20000);

    (process.platform === 'linux' ? it : it.skip)('the tree-kill spares llama-server (pid file or cmdline) and everything below it, like STOP-ALL', async () => {
      const home = makeHome();
      fs.mkdirSync(path.join(home, 'models'), { recursive: true });
      // root -> [spared-by-pidfile -> its child], [named llama-server], [plain victim]
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-tree-'));
      const script = `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const keep = (args) => spawn(process.execPath, args, { stdio: 'ignore' });
        const watcher = keep(['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"]);
        const llama = spawn('bash', ['-c', 'exec -a llama-server-fake ${process.execPath} -e "setInterval(()=>{},1000)"'], { stdio: 'ignore' });
        const victim = keep(['-e', 'setInterval(()=>{},1000)']);
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'pids.json'))}, JSON.stringify({ watcher: watcher.pid, llama: llama.pid, victim: victim.pid }));
        setInterval(() => {}, 1000);`;
      const root = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      expect(await waitFor(() => fs.existsSync(path.join(dir, 'pids.json')))).toBe(true);
      await delay(500);
      const pids = JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf8'));
      fs.writeFileSync(path.join(home, 'models/llama-server-watcher.pid'), `${pids.watcher}\n`);
      const found = executor.listDescendantProcs(root.pid, home).map((p: any) => p.pid);
      expect(found).toContain(pids.victim);
      expect(found).not.toContain(pids.watcher);
      expect(found).not.toContain(pids.llama);
      expect(found).toHaveLength(1); // the watcher's own child is spared with it
      const watcherKids = executor.listDescendantProcs(pids.watcher, '').map((p: any) => p.pid);
      expect(watcherKids).toHaveLength(1);
      for (const pid of [root.pid, pids.watcher, ...watcherKids, pids.llama, pids.victim]) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      }
    }, 20000);
  });

  it('v24: a running CLI branch heartbeats while its driver is alive (quietMs, activity), and stops once it exits', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, {
      codex: {
        answer: 'CODEX_REVIEW: fine.',
        delayMs: 900,
        lines: ['AUDIT ' + JSON.stringify({ ts: 'x', kind: 'item_started', itemType: 'commandExecution', command: 'cat secret.txt' })],
      },
      claude: {
        answer: 'CLAUDE_REVIEW: fine.',
        delayMs: 900,
        lines: ['AUDIT ' + JSON.stringify({ ts: 'x', kind: 'item_started', itemType: 'tool_use', tool: 'Bash', itemId: 't1' })],
      },
    });
    const result = await runExecutor(writePlan(home, port, parallelSteps), home, driver, recordDir, {
      extraEnv: { SHELLY_PLAN_EXECUTOR_CLI_HEARTBEAT_MS: '150' },
    });
    expect(result.status).toBe(0);
    await delay(400); // a leaked timer would have nothing to write to, but give it the chance
    const events = readProgress(home);
    for (const [stepIndex, activity] of [[0, 'command'], [1, 'Bash']] as const) {
      const beats = events.filter((e) => e.kind === 'heartbeat' && e.stepIndex === stepIndex);
      expect(beats.length).toBeGreaterThanOrEqual(2);
      for (const b of beats) {
        expect(b.branchId).toBe(`${b.runId}#${stepIndex}`);
        expect(b.groupId).toBe(events.find((e) => e.kind === 'branch_state' && e.stepIndex === stepIndex && e.groupId)?.groupId);
        expect(typeof b.elapsedMs).toBe('number');
        expect(typeof b.quietMs).toBe('number');
        expect(b.activity).toBe(activity);
        expect(b.tail).toBeUndefined();
        expect(JSON.stringify(b)).not.toContain('secret.txt');
      }
      // The driver printed only at start: its quiet time grows.
      expect(beats[beats.length - 1].quietMs).toBeGreaterThan(beats[0].quietMs);
      // Nothing after the step settled (the timer stops with the driver).
      const settled = events.find((e) => e.kind === 'branch_state' && e.stepIndex === stepIndex && e.state === 'DONE');
      expect(settled).toBeDefined();
      expect(Math.max(...beats.map((b) => b.seq))).toBeLessThan(settled.seq);
    }
    // The final (non-CLI) step never heartbeats.
    expect(events.some((e) => e.kind === 'heartbeat' && e.stepIndex === 2)).toBe(false);
  });

  it('v24: cliActivityFromDriverLine reads only item_started AUDIT lines, never the command', () => {
    const line = (o: unknown) => 'AUDIT ' + JSON.stringify(o);
    expect(executor.CLI_HEARTBEAT_MS).toBe(10_000);
    expect(executor.cliActivityFromDriverLine(line({ kind: 'item_started', itemType: 'tool_use', tool: 'Edit' }))).toBe('Edit');
    expect(executor.cliActivityFromDriverLine(line({ kind: 'item_started', itemType: 'commandExecution', command: 'rm -rf /' }))).toBe('command');
    expect(executor.cliActivityFromDriverLine(line({ kind: 'item_started', itemType: 'fileChange' }))).toBe('file change');
    expect(executor.cliActivityFromDriverLine(line({ kind: 'item_started', itemType: 'tool_use', tool: '<b>' + 'x'.repeat(80) }))).toBe('b' + 'x'.repeat(39));
    expect(executor.cliActivityFromDriverLine(line({ kind: 'turn_started', note: 'item_started' }))).toBeNull();
    expect(executor.cliActivityFromDriverLine('S->C {"kind":"item_started"}')).toBeNull();
    expect(executor.cliActivityFromDriverLine('AUDIT {"item_started"')).toBeNull();
    expect(executor.cliActivityFromDriverLine(undefined)).toBeNull();
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

  it('v21 (Inc3): an isolation-blocked step reads the attended wording on Run now, the unattended one otherwise', async () => {
    for (const attended of [true, false]) {
      const home = makeHome();
      const { driver, recordDir } = makeDriver();
      writeDriverConfig(recordDir, {});
      const steps: Step[] = [
        { instruction: 'summarize my notes' },
        { instruction: 'search the web about the summary above', tool: { type: 'perplexity', label: 'Perplexity', model: 'sonar', authRef: 'perplexity' } },
        { instruction: 'finalize' },
      ];
      const planFile = writePlan(home, port, steps, { cliWorker: null });
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      const blocked = "Step 2 would send earlier steps' results to Perplexity unattended, but those results may contain local data. Run this agent with Run now.";
      plan.agent.autonomous = true;
      plan.steps.isolation = [null, { blocked }, null];
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
      await runExecutor(planFile, home, driver, recordDir, attended ? {} : { origin: 'event', unattended: true });
      const step = readRunLog(home).steps[1];
      expect(step.status).toBe('error');
      if (attended) {
        expect(step.outputPreview).not.toMatch(/unattended/i);
        expect(step.outputPreview).toContain('Step 2');
        expect(step.outputPreview).toContain('Autonomous');
      } else {
        expect(step.outputPreview).toContain('unattended');
      }
    }
  }, 60000);

  it('review H1: a CLI step after web research gets no driver — TOOL_DENY with the tainted-input reason', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver();
    writeDriverConfig(recordDir, { codex: { answer: 'should never run' } });
    serverReply = [
      '- OpenAI ships a new model — https://example.com/news/a',
      '- A new benchmark is out — https://example.com/news/b',
      '',
      '## Sources',
      '1. https://example.com/news/a',
      '2. https://example.com/news/b',
    ].join('\n');
    const steps: Step[] = [
      { instruction: 'search the web for the latest AI news' },
      { instruction: 'turn the findings into a review with Codex', tool: { type: 'cli', cli: 'codex' } },
      { instruction: 'finalize' },
    ];
    await runExecutor(writePlan(home, port, steps), home, driver, recordDir);
    expect(readCalls(recordDir)).toEqual([]);
    const log = readRunLog(home);
    expect(log.steps[1].status).toBe('error');
    expect(log.steps[1].outputPreview).toContain('comes after a web research step');
    expect(readAudit(home).some((e) => e.event === 'cli_branch_refused' && e.reason === 'tainted web research input')).toBe(true);
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
