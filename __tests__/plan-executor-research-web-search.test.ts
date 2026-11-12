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

// Executor v58: an article pipeline's research step on the Codex CLI with its
// hosted web search and no other tool (tool.webSearch, driver --text-only
// --web-search). The real executor with a fake driver: what the executor
// accepts, refuses and hands over. The driver side is in
// __tests__/agent-driver-text-only.test.ts (--web-search).

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = process.platform === 'win32'
  ? path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js')
  : path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-research-web-search';
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
fs.writeFileSync(get('--answer-file'), a);
process.exit(0);
`;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-research-ws-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makeDriver(answers: (string | null)[]): { driver: string; recordDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fake-research-ws-'));
  const driver = path.join(dir, 'fake-agent-driver.js');
  fs.writeFileSync(driver, FAKE_DRIVER);
  const recordDir = path.join(dir, 'records');
  fs.mkdirSync(recordDir);
  fs.writeFileSync(path.join(recordDir, 'answers.json'), JSON.stringify(answers));
  return { driver, recordDir };
}

const readCalls = (recordDir: string): any[] => fs.readdirSync(recordDir).filter((n) => n.startsWith('call-')).sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf8')));

/** The real preset chain: research, write and review pinned to the given engines. */
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

function basePlan(home: string, list: unknown[], over: Record<string, unknown> = {}, longform = true): any {
  const policy = { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true };
  return {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Fallback title', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: longform ? 'draft' : 'notify' },
    paths: { home },
    output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'research-ws', useGlobalOutput: true, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy,
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, ...(longform ? { longform: true } : {}) },
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

function runExecutor(planFile: string, home: string, driver: string, recordDir: string, env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker, '--agent-driver', driver, '--unattended', '1'];
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, FAKE_DRIVER_RECORD_DIR: recordDir, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', ...env };
    delete childEnv.SHELLY_RUN_ORIGIN;
    if (!env.SHELLY_CAP_TAINTED) delete childEnv.SHELLY_CAP_TAINTED;
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

const readResult = (home: string) => fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');

describe('isResearchWebSearchCliStep / textOnlyPlanRefusal', () => {
  const plan = (mutate: (list: any[], p: any) => void = () => {}, longform = true, write: any = CODEX, review: any = CLAUDE) => {
    const list = chain(RESEARCH_WS, write, review);
    const p = basePlan('/h', list, {}, longform);
    mutate(list, p);
    return p;
  };
  const refused = (p: any) => expect(executor.textOnlyPlanRefusal(p)).not.toBe('');

  it('takes the research step of a generated chain, and only it carries webSearch', () => {
    const p = plan();
    expect(p.steps.list.map((_s: unknown, i: number) => executor.isResearchWebSearchCliStep(p, i))).toEqual([true, false, false, false, false, false, false]);
    expect(p.steps.list.map((_s: unknown, i: number) => executor.isTextOnlyCliStep(p, i))).toEqual([true, true, true, true, true, true, false]);
    expect(executor.textOnlyPlanRefusal(p)).toBe('');
    expect(executor.longformPlanRefusal(p)).toBe('');
    expect(executor.cliStepNeedingAttended(p, { unattended: true })).toBe(-1);
  });

  it('a research step on HTTP engines with HTTP writers is unchanged', () => {
    const p = plan((l) => { l[0].tool = { type: 'perplexity' }; }, true, { type: 'groq' }, { type: 'cerebras' });
    expect(executor.isResearchWebSearchCliStep(p, 0)).toBe(false);
    expect(executor.textOnlyPlanRefusal(p)).toBe('');
  });

  it.each<[string, (list: any[], p: any) => void]>([
    ['webSearch on the write step', (l) => { l[1].tool = { ...CODEX, webSearch: true }; }],
    ['webSearch on a review step', (l) => { l[2].tool = { ...CLAUDE, webSearch: true }; }],
    ['webSearch on Claude research', (l) => { l[0].tool = { ...RESEARCH_WS, cli: 'claude' }; }],
    ['webSearch without textOnly', (l) => { const { textOnly: _t, ...rest } = RESEARCH_WS; void _t; l[0].tool = rest; }],
    ['webSearch set to a string', (l) => { l[0].tool = { ...RESEARCH_WS, webSearch: 'true' }; }],
    ['webSearch set to false', (l) => { l[0].tool = { ...RESEARCH_WS, webSearch: false }; }],
    ['an extra key on the research tool', (l) => { l[0].tool = { ...RESEARCH_WS, sandbox: 'danger-full-access' }; }],
    ['a model with shell characters', (l) => { l[0].tool = { ...RESEARCH_WS, model: 'x; rm -rf ~' }; }],
    ['webSearch on the step itself', (l) => { l[0].webSearch = true; }],
    ['a role on the research step', (l) => { l[0].role = { id: 'r', name: 'n', instructions: 'i', roleHash: 'h' }; }],
    ['a parallel research step', (l) => { l[0].parallelGroup = 'g'; }],
    ['a hand-off on the research step', (l) => { l[0].handoff = { kind: 'review', of: [0], round: 1 }; }],
    ['a research step after another model step', (l) => { l.unshift({ instruction: 'first', tool: { type: 'groq' } }); }],
    ['webSearch on the agent tool', (_l, p) => { p.tool = { type: 'gemini-api', webSearch: true }; }],
    ['webSearch on a ladder rung', (_l, p) => { p.toolLadder = [{ type: 'cli', cli: 'codex', webSearch: true }]; }],
    ['webSearch on an editor engine', (l) => { l[l.length - 1].local = { ...l[l.length - 1].local, editor: { notes: [0], lang: 'ja', engine: { ...CODEX, webSearch: true }, minScore: 3.5 } }; }],
    ['webSearch in a local config', (l) => { l[l.length - 1].local = { ...l[l.length - 1].local, webSearch: true }; }],
  ])('refuses %s', (_name, mutate) => {
    refused(plan(mutate));
  });

  it('refuses the flag as the final step, on a chain that is not long-form, and on a digest', () => {
    refused(plan((l) => { l.splice(1); }));
    refused(plan(() => {}, false));
    const digest = basePlan('/h', [{ instruction: 'x', local: { kind: 'list-drafts', streams: [] } }, { instruction: 'y', tool: RESEARCH_WS }, { instruction: 'z', local: { kind: 'assemble', parts: [[0]], stream: 'digest', footer: 'f' } }]);
    refused(digest);
  });

  it('without the research mark, a text-only writer after a CLI research step is refused as before', () => {
    const p = plan((l) => { l[0].tool = { ...CODEX }; });
    expect(executor.isTextOnlyCliStep(p, 1)).toBe(false);
    refused(p);
  });
});

describe('the research directive', () => {
  it('asks a CLI research step for a Sources section, and no other step', () => {
    const cli = executor.renderStepEvidence({ mode: 'research', today: '2026-11-13', listSources: true });
    const http = executor.renderStepEvidence({ mode: 'research', today: '2026-11-13' });
    expect(cli).toContain('## Sources');
    expect(http).not.toContain('## Sources');
  });
});

describe('a run with the Codex research step', () => {
  let server: http.Server;
  let port = 0;
  let prompts: string[];

  beforeEach((done) => {
    prompts = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        prompts.push(body);
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

  it('runs unattended: --web-search only on research, and Sources come from the answer', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const status = await runExecutor(writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE))), home, driver, recordDir);
    expect(status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(prompts).toHaveLength(0);

    const calls = readCalls(recordDir);
    expect(calls).toHaveLength(3);
    const value = (c: any, flag: string) => c.argv[c.argv.indexOf(flag) + 1];
    expect(calls.map((c) => value(c, '--engine'))).toEqual(['codex', 'codex', 'claude']);
    expect(calls.map((c) => c.argv.includes('--web-search'))).toEqual([true, false, false]);
    for (const call of calls) {
      expect(call.argv).toContain('--text-only');
      expect(value(call, '--cwd')).toBe(path.join(home, '.shelly/tmp'));
    }
    expect(value(calls[0], '--text-only-model')).toBe('gpt-test');
    // The research prompt asks for the Sources section; the write prompt gets them as data.
    expect(calls[0].prompt).toContain('## Sources');
    expect(calls[1].prompt).toContain(URL_A);
    expect(calls[1].prompt).toContain(URL_B);

    const result = readResult(home);
    expect(result).toContain(URL_A);
    expect(result).toContain(URL_B);
    const audit = readAudit(home);
    const starts = audit.filter((e) => e.event === 'cli_branch_start');
    expect(starts.map((e) => e.webSearch === true)).toEqual([true, false, false]);
    expect(audit.find((e) => e.event === 'sourcing_research')).toMatchObject({ sources: 2 });
  }, 60000);

  it('a research answer with no sources stops the chain before the write step', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver(['1. Paper A: the figure was 42%.', ARTICLE, 'VERDICT: PASS']);
    await runExecutor(writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE))), home, driver, recordDir);
    expect(readCalls(recordDir)).toHaveLength(1);
    expect(readRunLog(home).status).not.toBe('success');
  }, 60000);

  it('a notification-triggered (tainted) run never starts the web search', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    await runExecutor(writePlan(home, port, basePlan(home, chain(RESEARCH_WS, CODEX, CLAUDE))), home, driver, recordDir, { SHELLY_CAP_TAINTED: '1' });
    expect(readCalls(recordDir)).toHaveLength(0);
    expect(readRunLog(home).status).not.toBe('success');
    expect(readAudit(home).some((e) => e.event === 'cli_branch_refused' && e.reason === 'web search on a tainted run')).toBe(true);
  }, 60000);

  it('a hostile plan with webSearch on the write step runs nothing', async () => {
    const home = makeHome();
    const { driver, recordDir } = makeDriver([RESEARCH_ANSWER, ARTICLE, 'VERDICT: PASS']);
    const list = chain(RESEARCH_WS, CODEX, CLAUDE);
    list[1].tool = { ...CODEX, webSearch: true };
    await runExecutor(writePlan(home, port, basePlan(home, list)), home, driver, recordDir);
    expect(readCalls(recordDir)).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(readRunLog(home).status).toBe('error');
    expect(readAudit(home).some((e) => e.event === 'text_only_refused')).toBe(true);
  }, 60000);
});
