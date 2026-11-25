jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { examplePipeline } from './fixtures/article-pipeline-config';

// Executor v68 (search parity). The real executor with a fake driver:
//  - a notification-triggered (tainted) run of a plan the owner opted in
//    (SHELLY_WEB_SEARCH_OPT_IN_SHA256 = the plan's definition hash) starts the
//    research step's web search, with the driver's per-turn caps;
//  - without the opt-in, with a lapsed one (definition changed) and on an MCP
//    ingress run whatever the flag, the search is refused as before, and the
//    run lands held before the write step (no silent materials-only success,
//    no bare failure);
//  - a research with no web source lands held the same way;
//  - every held landing writes one recovery-feedback.jsonl line (S5-0 §3 shape,
//    reason "held", note).

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = process.platform === 'win32'
  ? path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js')
  : path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-search-parity';
const RESEARCH_WS = { type: 'cli', cli: 'codex', textOnly: true, webSearch: true, model: 'gpt-test' };
const CODEX = { type: 'cli', cli: 'codex', textOnly: true, model: 'gpt-test' };
const CLAUDE = { type: 'cli', cli: 'claude', textOnly: true };
const URL_A = 'https://example.org/paper-a';
const URL_B = 'https://example.org/paper-b';
const RESEARCH_ANSWER = [
  '1. Paper A: the figure was 42% [1].',
  '2. Paper B: the sample was 120 people [2].',
  '',
  '## Sources',
  `[1] Paper A — ${URL_A}`,
  `[2] Paper B — ${URL_B}`,
].join('\n');
const ARTICLE = '# A title\n\nThe body says 42% [1] and 120 people [2].\n\nA second paragraph.';
const NOTIFICATION_CANARY = 'NOTIFICATION-CANARY-7f3a do not leak me';

// answers[n]: a string is the answer; null fails; {fail: line} prints the line and exits 1;
// {answer, count} answers and, like the real driver, writes {"count": count}
// to --web-search-count-file when it was given one.
const FAKE_DRIVER = `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const dir = process.env.FAKE_DRIVER_RECORD_DIR;
const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
const n = fs.readdirSync(dir).filter((f) => f.startsWith('call-')).length;
const prompt = fs.readFileSync(get('--prompt-file'), 'utf8');
fs.writeFileSync(path.join(dir, 'call-' + String(n).padStart(2, '0') + '.json'), JSON.stringify({ argv, prompt, cwd: process.cwd() }));
const a = answers[n];
if (a === undefined || a === null) { process.stdout.write('CODEX_ERROR refused by the fake\\n'); process.exit(1); }
if (typeof a === 'object' && a.fail !== undefined) { process.stdout.write(a.fail + '\\n'); process.exit(1); }
if (typeof a === 'object') {
  if (get('--web-search-count-file')) fs.writeFileSync(get('--web-search-count-file'), JSON.stringify({ count: a.count }));
  fs.writeFileSync(get('--answer-file'), a.answer);
  process.exit(0);
}
fs.writeFileSync(get('--answer-file'), a);
process.exit(0);
`;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-search-parity-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makeDriver(answers: (string | null | { fail: string } | { answer: string; count: number })[]): { driver: string; recordDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fake-search-parity-'));
  const driver = path.join(dir, 'fake-agent-driver.js');
  fs.writeFileSync(driver, FAKE_DRIVER);
  const recordDir = path.join(dir, 'records');
  fs.mkdirSync(recordDir);
  fs.writeFileSync(path.join(recordDir, 'answers.json'), JSON.stringify(answers));
  return { driver, recordDir };
}

const readCalls = (recordDir: string): any[] => fs.readdirSync(recordDir).filter((n) => n.startsWith('call-')).sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf8')));

function chain(research: Record<string, unknown>, write: Record<string, unknown>, review: Record<string, unknown>): any[] {
  return normalizeSteps(examplePipeline('example-a').orchestration).map((step: any, i) => {
    const { tool: _tool, toolPinned: _pinned, ...rest } = step;
    void _tool;
    void _pinned;
    if (step.local !== undefined) return rest;
    if (i === 0) return { ...rest, tool: research, toolPinned: true };
    return { ...rest, tool: step.handoff?.kind === 'review' ? review : write, toolPinned: true };
  });
}

function basePlan(home: string, list: unknown[], over: Record<string, unknown> = {}): any {
  const policy = { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true };
  return {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Fallback title', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'search-parity', useGlobalOutput: false, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy,
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, longform: true },
    cliWorker: { cwd: home, policy },
    ...over,
  };
}

function writePlan(home: string, port: number, plan: unknown): string {
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`);
  return planFile;
}

/** The pipeline entry the held line takes its pipelineId from (outputFolder = the plan's). */
function writePipelines(home: string) {
  fs.writeFileSync(path.join(home, '.shelly/agents/article-pipelines.json'), JSON.stringify({
    version: 1,
    pipelines: [{ id: 'example-a', outputFolder: `${path.join(home, 'agent-output')}/` }],
  }));
}

function runExecutor(planFile: string, home: string, driver: string, recordDir: string, env: Record<string, string> = {}, attended = false): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker, '--agent-driver', driver, ...(attended ? [] : ['--unattended', '1'])];
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, FAKE_DRIVER_RECORD_DIR: recordDir, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', ...env };
    delete childEnv.SHELLY_RUN_ORIGIN;
    for (const key of ['SHELLY_CAP_TAINTED', 'SHELLY_INGRESS_TAINTED', 'SHELLY_INGRESS_TAINTED_REASON', 'SHELLY_WEB_SEARCH_OPT_IN_SHA256', 'SHELLY_NOTIFICATION_TEXT']) {
      if (env[key] === undefined) delete childEnv[key];
    }
    const child = spawn(process.execPath, args, { env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (status) => resolve(status));
  });
}

const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);

function readRunLog(home: string): any {
  const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
}

function readAudit(home: string): any[] {
  return fs.readFileSync(path.join(logDir(home), 'plan-executor-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readFeedback(home: string): any[] {
  const file = path.join(home, '.shelly/agents/recovery-feedback.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const definitionHash = (planFile: string) => executor.planDefinitionSha256(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const flagValue = (call: any, flag: string) => (call.argv.indexOf(flag) === -1 ? undefined : call.argv[call.argv.indexOf(flag) + 1]);

// The S5-0 §3 fields, plus `note` (held only).
const FEEDBACK_KEYS = ['agentId', 'artifacts', 'delivery', 'lastStep', 'note', 'pipelineId', 'planId', 'reason', 'refire', 'runId', 'scheduledAt', 'startedAt', 'terminatedAt'];

describe('the definition hash and the opt-in state', () => {
  const plan = { kind: 'k', agent: { id: 'a' }, steps: { list: [{ instruction: 'x' }] }, generatedAt: 1 };

  it('ignores generatedAt and key order, and changes with any edit', () => {
    const h = executor.planDefinitionSha256(plan);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(executor.planDefinitionSha256({ ...plan, generatedAt: 999 })).toBe(h);
    expect(executor.planDefinitionSha256({ generatedAt: 2, steps: plan.steps, agent: plan.agent, kind: 'k' })).toBe(h);
    expect(executor.planDefinitionSha256({ ...plan, steps: { list: [{ instruction: 'y' }] } })).not.toBe(h);
    expect(executor.planDefinitionSha256({ ...plan, prompt: 'more' })).not.toBe(h);
    expect(executor.planDefinitionSha256(null)).toBe('');
    expect(executor.planDefinitionSha256([1])).toBe('');
  });

  it('is on only for the exact hash, never on MCP ingress', () => {
    const h = executor.planDefinitionSha256(plan);
    const env = (v: string) => ({ [executor.WEB_SEARCH_OPT_IN_ENV]: v });
    expect(executor.webSearchOptInState(h, {}, false)).toBe('off');
    expect(executor.webSearchOptInState(h, env(h), false)).toBe('on');
    expect(executor.webSearchOptInState(h, env(h.toUpperCase()), false)).toBe('on');
    expect(executor.webSearchOptInState(h, env(h), true)).toBe('ingress');
    expect(executor.webSearchOptInState(h, env('0'.repeat(64)), false)).toBe('lapsed');
    expect(executor.webSearchOptInState(h, env('1'), false)).toBe('invalid');
    expect(executor.webSearchOptInState('', env(h), false)).toBe('lapsed');
  });

  it('the CLI prints the same hash the run binds to', () => {
    const home = makeHome();
    const planFile = writePlan(home, 1, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const out = require('child_process').execFileSync(process.execPath, [scriptCopy, '--web-search-definition-hash', planFile], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(out.trim()).toBe(definitionHash(planFile));
  });

  // Fix round 1 (item 1): the consent binds the plan with its
  // article-pipelines.json entry, and Settings lists the article plans with
  // the very hash the run computes.
  it('binds the article-pipelines.json entry too, and the candidates op lists that hash', () => {
    const home = makeHome();
    writePipelines(home);
    const planFile = writePlan(home, 1, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const execFile = (args: string[]) => require('child_process').execFileSync(process.execPath, [scriptCopy, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const withEntry = execFile(['--web-search-definition-hash', planFile]).trim();
    expect(withEntry).not.toBe(definitionHash(planFile));
    const entry = JSON.parse(fs.readFileSync(path.join(home, '.shelly/agents/article-pipelines.json'), 'utf8')).pipelines[0];
    expect(withEntry).toBe(executor.planDefinitionSha256(JSON.parse(fs.readFileSync(planFile, 'utf8')), entry));
    const listed = JSON.parse(execFile(['--web-search-opt-in-candidates']));
    expect(listed).toEqual({ pipelines: [{ agentId: AGENT_ID, name: 'Fallback title', pipelineId: 'example-a', definitionSha256: withEntry, webSearchStep: true }] });
    // Editing the owner's pipeline entry changes the hash (the consent lapses).
    fs.writeFileSync(path.join(home, '.shelly/agents/article-pipelines.json'), JSON.stringify({
      version: 1,
      pipelines: [{ id: 'example-a', outputFolder: `${path.join(home, 'agent-output')}/`, reviewRounds: 3 }],
    }));
    expect(execFile(['--web-search-definition-hash', planFile]).trim()).not.toBe(withEntry);
  });

  it('the executor never reads the notification text (premise 3 of the opt-in)', () => {
    // Code, not comments: no env read and no quoted name of the two variables.
    const code = fs.readFileSync(scriptCopy, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join('\n');
    expect(/SHELLY_NOTIFICATION_(?:TEXT|PACKAGE)/.test(code)).toBe(false);
    expect(/SHELLY_NOTIFICATION/.test(code)).toBe(false);
  });
});

describe('a run with the Codex web-search research step (v68)', () => {
  let server: http.Server;
  let port = 0;

  beforeEach((done) => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'unused' }, finish_reason: 'stop' }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.closeAllConnections();
    server.close(done);
  });

  it('an opted-in notification-triggered run starts the search, with the caps and no notification text', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const status = await runExecutor(planFile, home, driver, recordDir, {
      SHELLY_CAP_TAINTED: '1',
      SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile),
      SHELLY_NOTIFICATION_TEXT: NOTIFICATION_CANARY,
    });
    expect(status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    const calls = readCalls(recordDir);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.argv.includes('--web-search'))).toEqual([true, false, false]);
    expect(flagValue(calls[0], '--web-search-max-queries')).toBe(String(executor.WEB_SEARCH_OPT_IN_MAX_QUERIES));
    expect(flagValue(calls[0], '--web-search-max-query-chars')).toBe(String(executor.WEB_SEARCH_OPT_IN_MAX_QUERY_CHARS));
    // A notification run is not MCP-marked: the driver is not told --tainted.
    for (const call of calls) {
      expect(call.argv).not.toContain('--tainted');
      expect(call.prompt).not.toContain('NOTIFICATION-CANARY');
    }
    expect(calls[1].prompt).toContain(URL_A);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'web_search_opt_in')).toMatchObject({ state: 'on', tainted: true, ingress: false, webSearchStep: true });
    expect(audit.filter((e) => e.event === 'web_search_opt_in_applied')).toHaveLength(1);
    expect(audit.some((e) => e.event === 'cli_branch_refused')).toBe(false);
    expect(readFeedback(home)).toEqual([]);
  }, 60000);

  it('without the opt-in a notification-triggered run is refused as before and lands held before the write step', async () => {
    const home = makeHome();
    writePipelines(home);
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const status = await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1' });
    expect(status).toBe(0);
    expect(readCalls(recordDir)).toHaveLength(0);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toMatch(/^Held \(web-search-refused\): /);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'web_search_opt_in')).toMatchObject({ state: 'off', tainted: true });
    expect(audit.some((e) => e.event === 'cli_branch_refused' && e.reason === 'web search on a tainted run')).toBe(true);
    expect(audit.find((e) => e.event === 'article_held')).toMatchObject({ reason: 'web-search-refused', stepIndex: 0, draftKept: false });
    expect(audit.find((e) => e.event === 'plan_finish')).toMatchObject({ status: 'skipped' });

    // One feedback line, S5-0 §3 + note, recorded content -> line -> marker.
    const lines = readFeedback(home);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(Object.keys(line).sort()).toEqual(FEEDBACK_KEYS);
    expect(line).toMatchObject({
      agentId: AGENT_ID,
      pipelineId: 'example-a',
      reason: 'held',
      scheduledAt: null,
      lastStep: { index: 0, kind: 'research' },
      artifacts: { draft: false, paths: [] },
      delivery: { delivered: false, channel: 'draft' },
      refire: { eligible: false, refired: false, refireRunId: null },
    });
    expect(line.planId).toMatch(new RegExp(`^plan-agent-${AGENT_ID}@[0-9a-f]{12}$`));
    expect(line.note[0]).toBe('web-search-refused');
    expect(line.note.every((n: unknown) => typeof n === 'string')).toBe(true);
    expect(typeof line.runId).toBe('string');
    expect(Date.parse(line.startedAt)).toBeLessThanOrEqual(Date.parse(line.terminatedAt));
    expect(typeof line.lastStep.startedAt).toBe('string');
    const recovery = audit.filter((e) => e.kind === 'plan.recovery');
    expect(recovery.map((e) => e.event)).toEqual(['recovery_feedback', 'recovery_feedback_shared']);
    expect(recovery[0].feedback).toEqual(line);
    expect(recovery[1]).toMatchObject({ runId: line.runId, reason: 'held' });
  }, 60000);

  it('an opt-in for an earlier definition has lapsed: refused, held', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const consented = definitionHash(planFile);
    // The owner's definition changes after the consent (an edit / rebuild).
    writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE), { prompt: 'Base task, edited' }));
    await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1', SHELLY_WEB_SEARCH_OPT_IN_SHA256: consented });
    expect(readCalls(recordDir)).toHaveLength(0);
    expect(readRunLog(home).outputPreview).toMatch(/^Held \(web-search-refused\)/);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'web_search_opt_in')).toMatchObject({ state: 'lapsed' });
    expect(audit.some((e) => e.event === 'cli_branch_refused' && e.reason === 'web search on a tainted run (opt-in lapsed)')).toBe(true);
    expect(readFeedback(home)).toHaveLength(1);
  }, 60000);

  it('an MCP-marked (ingress) run never starts the search, opt-in or not, and posts no notification', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, {
      SHELLY_INGRESS_TAINTED: '1',
      SHELLY_INGRESS_TAINTED_REASON: 'mcp',
      SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile),
    });
    expect(readCalls(recordDir)).toHaveLength(0);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'web_search_opt_in')).toMatchObject({ state: 'ingress', ingress: true });
    expect(audit.some((e) => e.event === 'cli_branch_refused' && e.reason === 'web search on an ingress-tainted run (mcp)')).toBe(true);
    expect(audit.some((e) => e.event === 'web_search_opt_in_applied')).toBe(false);
    expect(readRunLog(home).outputPreview).toMatch(/^Held \(web-search-refused\)/);
    expect(fs.existsSync(path.join(logDir(home), 'native-result-notification.json'))).toBe(false);
    expect(readFeedback(home)).toHaveLength(1);
  }, 60000);

  it('an MCP-marked notification run with the opt-in is still refused (ingress wins over the flag)', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, {
      SHELLY_CAP_TAINTED: '1',
      SHELLY_INGRESS_TAINTED: '1',
      SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile),
    });
    expect(readCalls(recordDir)).toHaveLength(0);
    expect(readAudit(home).some((e) => e.event === 'cli_branch_refused' && /ingress-tainted/.test(e.reason))).toBe(true);
  }, 60000);

  it('a research with no web source lands held (no-web-sources) before the write step', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver(['1. Paper A: the figure was 42%.', ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const status = await runExecutor(planFile, home, driver, recordDir);
    expect(status).toBe(0);
    expect(readCalls(recordDir)).toHaveLength(1);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toMatch(/^Held \(no-web-sources\): /);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'sourcing_no_web_sources')).toMatchObject({ stepIndex: 1, materials: 0 });
    expect(audit.some((e) => e.event === 'sourcing_no_sources')).toBe(false);
    const [line] = readFeedback(home);
    expect(line).toMatchObject({ reason: 'held', lastStep: { index: 0, kind: 'research' }, artifacts: { draft: false, paths: [] } });
    expect(line.note).toEqual(['no-web-sources']);
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
  }, 60000);

  it('the driver stopping the search (cap) lands held (web-search-stopped)', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([{ fail: 'CODEX_ERROR Web search limit reached (20 searches); stopped.' }, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1', SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile) });
    expect(readCalls(recordDir)).toHaveLength(1);
    expect(readRunLog(home).outputPreview).toMatch(/^Held \(web-search-stopped\): /);
    const [line] = readFeedback(home);
    expect(line.note[0]).toBe('web-search-stopped');
    expect(line.note[1]).toContain('Web search limit reached');
  }, 60000);

  /** An attended run's .env: the global default asks for the tap, and the wait is 1 s. */
  function attendedEnv(home: string) {
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='1'\nSHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS='1'\n`);
  }

  it('5b: an attended run saves the article draft with no tap, even when the global default asks for one', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    attendedEnv(home);
    const status = await runExecutor(planFile, home, driver, recordDir, {}, true);
    expect(status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(fs.readdirSync(path.join(home, 'agent-output')).filter((n) => n.endsWith('.md'))).toHaveLength(1);
    const audit = readAudit(home);
    expect(audit.some((e) => e.event === 'action_article_draft_allow')).toBe(true);
    expect(fs.existsSync(path.join(home, '.shelly/agents/action-approvals'))
      ? fs.readdirSync(path.join(home, '.shelly/agents/action-approvals')).filter((n) => n.startsWith('action-')) : []).toEqual([]);
  }, 60000);

  it('5a: an agent that pins the tap and gets no answer keeps the full draft in held/ (approval-timeout)', async () => {
    const home = makeHome();
    writePipelines(home);
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const plan = basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE));
    plan.agent.requireActionApproval = true;
    const planFile = writePlan(home, port, plan);
    attendedEnv(home);
    const status = await runExecutor(planFile, home, driver, recordDir, {}, true);
    expect(status).toBe(0);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toMatch(/^Held \(approval-timeout\): /);
    // Nothing in the output folder; the whole draft in held/<today>/agent-output/.
    expect(fs.existsSync(path.join(home, 'agent-output')) ? fs.readdirSync(path.join(home, 'agent-output')).filter((n) => n.endsWith('.md')) : []).toEqual([]);
    const heldRoot = path.join(home, '.shelly/agents/held');
    const [day] = fs.readdirSync(heldRoot);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const heldDir = path.join(heldRoot, day, 'agent-output');
    const [name] = fs.readdirSync(heldDir);
    expect(name).toBe(`${day}-search-parity.md`);
    const held = fs.readFileSync(path.join(heldDir, name), 'utf8');
    expect(held.startsWith('---\nheld: "approval-timeout"\n')).toBe(true);
    expect(held).toContain('The body says 42% [1] and 120 people [2].');
    expect(held).toContain(URL_A);
    expect(held).toContain('review: pass');
    expect((fs.statSync(path.join(heldDir, name)).mode & 0o777)).toBe(0o600);

    const [line] = readFeedback(home);
    expect(Object.keys(line).sort()).toEqual(FEEDBACK_KEYS);
    expect(line).toMatchObject({
      reason: 'held',
      pipelineId: 'example-a',
      lastStep: { kind: 'assemble' },
      artifacts: { draft: true, paths: [path.join(heldDir, name)] },
      delivery: { delivered: false, channel: 'draft' },
    });
    expect(line.note[0]).toBe('approval-timeout');
    expect(line.note[1]).toBe('draft action approval timed out');
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'article_held')).toMatchObject({ reason: 'approval-timeout', draftKept: true });
    expect(audit.some((e) => e.event === 'action_article_draft_allow')).toBe(false);
  }, 60000);

  it('3a: work talk with no fact is cut once and the draft is saved (review unresolved), not held', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, `${ARTICLE} The search results said nothing more.`, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const status = await runExecutor(planFile, home, driver, recordDir);
    expect(status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    const [name] = fs.readdirSync(path.join(home, 'agent-output')).filter((n) => n.endsWith('.md'));
    const saved = fs.readFileSync(path.join(home, 'agent-output', name), 'utf8');
    expect(saved).not.toContain('search results');
    expect(saved).toContain('The body says 42% [1] and 120 people [2].');
    expect(saved).toContain(`${executor.ARTICLE_SELF_TALK_CUT_FLAG}: 1`);
    // No review read the cut text.
    expect(saved).toContain('review: unresolved');
    expect(saved).toContain(executor.ARTICLE_SELF_TALK_CUT_NOTE);
    expect(readFeedback(home)).toEqual([]);
    expect(readAudit(home).some((e) => e.event === 'article_held')).toBe(false);
  }, 60000);

  it('3b: a passed draft whose work talk holds a fact lands held (text-lint) with the lint in the note', async () => {
    const home = makeHome();
    writePipelines(home);
    const kept = 'The search results put it at 7 of 10 [1].';
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, `${ARTICLE} ${kept}`, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    const status = await runExecutor(planFile, home, driver, recordDir);
    expect(status).toBe(0);
    const log = readRunLog(home);
    expect(log.status).toBe('skipped');
    expect(log.outputPreview).toMatch(/^Held \(text-lint\): /);
    expect(fs.existsSync(path.join(home, 'agent-output')) ? fs.readdirSync(path.join(home, 'agent-output')).filter((n) => n.endsWith('.md')) : []).toEqual([]);
    const heldRoot = path.join(home, '.shelly/agents/held');
    const [day] = fs.readdirSync(heldRoot);
    const heldDir = path.join(heldRoot, day, 'agent-output');
    const [name] = fs.readdirSync(heldDir);
    const held = fs.readFileSync(path.join(heldDir, name), 'utf8');
    expect(held.startsWith('---\nheld: "text-lint"\n')).toBe(true);
    expect(held).toContain(kept);
    expect(held).toContain('review: pass');

    const lines = readFeedback(home);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Object.keys(line).sort()).toEqual(FEEDBACK_KEYS);
    expect(line).toMatchObject({
      reason: 'held',
      pipelineId: 'example-a',
      lastStep: { kind: 'assemble' },
      artifacts: { draft: true, paths: [path.join(heldDir, name)] },
      delivery: { delivered: false, channel: 'draft' },
      refire: { eligible: false, refired: false, refireRunId: null },
    });
    expect(line.note).toEqual(['text-lint', `${executor.ARTICLE_SELF_TALK_LEFT_FLAG}: search results`]);
    const audit = readAudit(home);
    expect(audit.find((e) => e.event === 'article_held')).toMatchObject({ reason: 'text-lint', draftKept: true });
    expect(audit.filter((e) => e.kind === 'plan.recovery').map((e) => e.event)).toEqual(['recovery_feedback', 'recovery_feedback_shared']);
    // Never dispatched: no save, no approval request.
    expect(audit.some((e) => e.event === 'action_article_draft_allow')).toBe(false);
  }, 60000);

  it('3b: a draft the review did not pass is saved with its flags as before (not held)', async () => {
    const home = makeHome();
    const draft = `${ARTICLE} The search results put it at 7 of 10 [1].`;
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, draft, 'VERDICT: REVISE\nfix it', draft, 'VERDICT: REVISE\nstill', draft]);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir);
    expect(readRunLog(home).status).toBe('success');
    const [name] = fs.readdirSync(path.join(home, 'agent-output')).filter((n) => n.endsWith('.md'));
    const saved = fs.readFileSync(path.join(home, 'agent-output', name), 'utf8');
    expect(saved).toContain('review: unresolved');
    expect(saved).toContain(executor.ARTICLE_SELF_TALK_LEFT_FLAG);
    expect(readAudit(home).some((e) => e.event === 'article_held')).toBe(false);
    expect(readFeedback(home)).toEqual([]);
  }, 60000);

  // Fix round 1 (item 2): the opted-in query budget is per run, across every
  // launch of the research step (here a numbers retry), not per driver turn.
  const THIN_RESEARCH = [
    '主研究: Paper A [1]',
    '事実: the figure was 42% [1].',
    '',
    '## Sources',
    `[1] Paper A — ${URL_A}`,
    `[2] Paper B — ${URL_B}`,
  ].join('\n');

  it('item 2: a research retry gets only what is left of the run\'s query budget', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([{ answer: THIN_RESEARCH, count: 5 }, { answer: RESEARCH_ANSWER, count: 3 }, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1', SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile) });
    const calls = readCalls(recordDir);
    const research = calls.filter((c) => c.argv.includes('--web-search'));
    expect(research).toHaveLength(2);
    const max = executor.WEB_SEARCH_OPT_IN_MAX_QUERIES;
    expect(research.map((c) => flagValue(c, '--web-search-max-queries'))).toEqual([String(max), String(max - 5)]);
    expect(research.every((c) => typeof flagValue(c, '--web-search-count-file') === 'string')).toBe(true);
    const budget = readAudit(home).filter((e) => e.event === 'web_search_budget');
    expect(budget.map((e) => [e.used, e.runUsed])).toEqual([[5, 5], [3, 8]]);
  }, 60000);

  it('item 2: with the run\'s budget spent the research is not retried', async () => {
    const home = makeHome();
    const max = executor.WEB_SEARCH_OPT_IN_MAX_QUERIES;
    const { driver, recordDir } = makeDriver([{ answer: THIN_RESEARCH, count: max }, { answer: RESEARCH_ANSWER, count: 1 }, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1', SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile) });
    expect(readCalls(recordDir).filter((c) => c.argv.includes('--web-search'))).toHaveLength(1);
    expect(readAudit(home).filter((e) => e.event === 'web_search_budget').map((e) => e.runUsed)).toEqual([max]);
  }, 60000);

  it('item 2: a launch whose count cannot be read spends the rest of the budget (fail closed)', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([THIN_RESEARCH, RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir, { SHELLY_CAP_TAINTED: '1', SHELLY_WEB_SEARCH_OPT_IN_SHA256: definitionHash(planFile) });
    expect(readCalls(recordDir).filter((c) => c.argv.includes('--web-search'))).toHaveLength(1);
    expect(readAudit(home).find((e) => e.event === 'web_search_budget')).toMatchObject({ used: null, runUsed: executor.WEB_SEARCH_OPT_IN_MAX_QUERIES });
  }, 60000);

  it('any other research failure still fails the run as before (not held)', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([null, ARTICLE, 'VERDICT: PASS']);
    const planFile = writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE)));
    await runExecutor(planFile, home, driver, recordDir);
    expect(readRunLog(home).status).toBe('error');
    expect(readFeedback(home)).toEqual([]);
    expect(readAudit(home).some((e) => e.event === 'article_held')).toBe(false);
  }, 60000);
});
