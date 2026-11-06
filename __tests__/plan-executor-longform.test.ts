jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  buildStepPrompt as tsBuildStepPrompt,
  MAX_LONGFORM_PROMPT_CHARS,
  MAX_LONGFORM_RESULT_CARRY_CHARS,
  normalizeStepLocal as tsNormalizeStepLocal,
  ROLE_RESULTS_DATA_NOTE,
  normalizeSteps,
} from '@/lib/agent-orchestration';
import { buildArticlePipeline } from '@/lib/agent-pipeline-presets';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

// Article pipeline Inc 1 (docs/superpowers/specs/2026-11-06-article-pipeline-plan.md):
// orchestration.longform and the `assemble` local step, against the real
// executor + broker offline, plus the pure helpers.
//
// The end-to-end runs use the real preset chain with its engine pins removed,
// so every step reaches the loopback fixture (the broker refuses any other
// test host). They end in `draft`, the only action a longform plan may have.
// The broker's fs.write is a known Windows-host failure (see
// __tests__/plan-executor-saved-path.test.ts), so on Windows the runs use
// __tests__/fixtures/fs-write-broker.js, which stands in for that one operation.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = process.platform === 'win32'
  ? path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js')
  : path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-longform';
const RESEARCH = '1. 論文A（査読前）: 数値は42%でした。 https://example.org/paper-a';
const SOURCE_URL = 'https://example.org/paper-a';
const MARKER = '【本人の材料: 未記入】';

type Reply = string | { content: string; finish_reason?: string; citations?: string[]; status?: number };

function articleChain() {
  return normalizeSteps(buildArticlePipeline('ai-steam').orchestration).map((step) => {
    const { tool: _tool, toolPinned: _pinned, ...rest } = step;
    void _tool;
    void _pinned;
    return rest;
  });
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-longform-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function writePlan(home: string, port: number, list: unknown[], longform = true): string {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Fallback title', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: longform ? 'draft' : 'notify' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'longform',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, ...(longform ? { longform: true } : {}) },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
  );
  return planFile;
}

function patchPlan(planFile: string, change: (plan: any) => void): string {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  change(plan);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  return planFile;
}

function runExecutor(planFile: string, home: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (status) => resolve(status));
  });
}

function readRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const files = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8'));
}

function readResult(home: string): string {
  return fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');
}

describe('shelly-plan-executor.js longform chain', () => {
  let server: http.Server;
  let port = 0;
  let prompts: string[];
  let replies: Reply[];

  beforeEach((done) => {
    prompts = [];
    replies = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        prompts.push(JSON.parse(body).messages[0].content);
        const reply = replies[prompts.length - 1] ?? `RESULT#${prompts.length}`;
        const r: Exclude<Reply, string> = typeof reply === 'string' ? { content: reply } : reply;
        res.setHeader('Content-Type', 'application/json');
        if (r.status) res.statusCode = r.status;
        res.end(JSON.stringify({
          choices: [{ message: { content: r.content }, finish_reason: r.finish_reason ?? 'stop' }],
          ...(r.citations ? { citations: r.citations } : {}),
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  const research: Reply = { content: RESEARCH, citations: [SOURCE_URL] };

  it('a PASS ends the loop even with research: the VERDICT line survives and the chain goes straight to assemble', async () => {
    const home = makeHome();
    const article = `# 見出し\n\n本文です [1]。\n\n## 本人の見解\n\n${MARKER}`;
    replies = [research, article, 'VERDICT: PASS'];
    expect(await runExecutor(writePlan(home, port, articleChain()), home)).toBe(0);

    expect(prompts).toHaveLength(3);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success', 'skipped', 'skipped', 'skipped', 'success']);

    const result = readResult(home);
    expect(result.startsWith('---\ntitle: "見出し"\nstream: "ai-steam"\n')).toBe(true);
    expect(result).toMatch(/^date: \d{4}-\d{2}-\d{2}$/m);
    expect(result).toContain('review: pass');
    expect(result).toContain('material: missing');
    expect(result).toContain('lint: []');
    expect(result).toContain(article);
    expect(result).toContain('## Sources');
    expect(result).toContain(SOURCE_URL);
    expect(result).toContain('最終確認者: RYO ITABASHI');
  }, 20000);

  it('the reviewer gets the research and the draft with their paragraphs, and is not sent back to the web', async () => {
    const home = makeHome();
    const article = '# 見出し\n\n第一段落です。\n\n第二段落です。';
    replies = [research, article, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts[2]).toContain(article);
    expect(prompts[2]).toContain('42%');
    expect(prompts[2]).toContain('VERDICT: PASS');
    // Synthesis evidence (Sources + contract), not the research directive.
    expect(prompts[2]).toContain('# Sourcing contract');
    expect(prompts[2]).not.toContain('# Research requirements');
    expect(prompts[0]).toContain('# Research requirements');
  }, 20000);

  it('REVISE flows: the reviser gets the draft + findings, the next review the rewrite, assemble the latest text', async () => {
    const home = makeHome();
    const draft1 = '# 初稿\n\n最初の本文です。';
    const findings = 'VERDICT: REVISE\n1. 数値が調査メモと違う';
    const draft2 = '# 改稿\n\n直した本文です。';
    replies = [research, draft1, findings, draft2, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts).toHaveLength(5);
    expect(prompts[3]).toContain(draft1);
    expect(prompts[3]).toContain(findings);
    expect(prompts[3]).toContain('## Step 2\n');
    expect(prompts[3]).toContain('## Step 3\n');
    expect(prompts[3]).not.toContain('## Step 1\n');
    expect(prompts[4]).toContain(draft2);
    expect(prompts[4]).toContain('42%');
    expect(prompts[4]).not.toContain('最初の本文');

    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success', 'success', 'success', 'skipped', 'success']);
    const result = readResult(home);
    expect(result).toContain('title: "改稿"');
    expect(result).toContain('review: pass');
    expect(result).toContain(draft2);
    expect(result).not.toContain('最初の本文');
  }, 20000);

  it('a draft whose last review never passed is kept, marked unresolved', async () => {
    const home = makeHome();
    replies = [research, '# 初稿\n\n一。', 'VERDICT: REVISE\n1. 直す', '# 二稿\n\n二。', 'VERDICT: REVISE\n1. まだ', '# 三稿\n\n三。'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts).toHaveLength(6);
    expect(readRunLog(home).status).toBe('success');
    const result = readResult(home);
    expect(result).toContain('review: unresolved');
    expect(result).toContain('# 三稿');
    expect(result).toContain('material: unknown');
  }, 20000);

  it('a draft cut by the carry budget is unresolved, even on a PASS', async () => {
    const home = makeHome();
    const article = `# 長い記事\n\n${'あ'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS + 500)}最後の段落`;
    replies = [research, article, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts[2]).not.toContain('最後の段落');
    expect(readRunLog(home).status).toBe('success');
    const result = readResult(home);
    expect(result).toContain('review: unresolved');
    expect(result).toContain('review_note:');
    expect(result).not.toContain('review: pass');
  }, 20000);

  it('a draft cut by the prompt budget is unresolved too, though each text fits its carry', async () => {
    const home = makeHome();
    const longNotes = { content: `${RESEARCH}\n${'い'.repeat(7500)}`, citations: [SOURCE_URL] };
    const article = `# 長い記事\n\n${'あ'.repeat(15900)}最後の段落`;
    expect(article.length).toBeLessThan(MAX_LONGFORM_RESULT_CARRY_CHARS);
    replies = [longNotes, article, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts[2]).not.toContain('最後の段落');
    expect(readResult(home)).toContain('review: unresolved');
  }, 20000);

  it('a revise step that would see a cut draft is skipped, so the full draft is kept', async () => {
    const home = makeHome();
    const article = `# 長い記事\n\n${'あ'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS + 500)}最後の段落`;
    replies = [research, article, 'VERDICT: REVISE\n1. 直す', '# 短い記事\n\n短い。'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts).toHaveLength(3);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success', 'skipped', 'skipped', 'skipped', 'success']);
    const result = readResult(home);
    expect(result).toContain('最後の段落');
    expect(result).not.toContain('短い記事');
    expect(result).toContain('review: unresolved');
    expect(result).toContain(executor.ARTICLE_PROMPT_CUT_NOTE);
  }, 20000);

  const failed: Reply = { content: 'upstream down', status: 500 };

  it('a failed review keeps the draft: skipped, not an error, and unresolved', async () => {
    const home = makeHome();
    const article = '# 記事\n\n本文です [1]。';
    replies = [research, article, failed];
    expect(await runExecutor(writePlan(home, port, articleChain()), home)).toBe(0);

    expect(prompts).toHaveLength(3);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'skipped', 'skipped', 'skipped', 'skipped', 'success']);
    const result = readResult(home);
    expect(result).toContain(article);
    expect(result).toContain('review: unresolved');
    expect(result).toContain(`review_note: "${executor.ARTICLE_REVIEW_FAILED_NOTE}"`);
  }, 20000);

  it('a failed revise keeps the draft before it, and the second review does not run', async () => {
    const home = makeHome();
    const article = '# 初稿\n\n本文です [1]。';
    replies = [research, article, 'VERDICT: REVISE\n1. 直す', failed, 'never reached'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts).toHaveLength(4);
    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps.map((s: any) => s.status)).toEqual(['success', 'success', 'success', 'skipped', 'skipped', 'skipped', 'success']);
    expect(readResult(home)).toContain(article);
    expect(readResult(home)).toContain('review: unresolved');
  }, 20000);

  it('a failed second review keeps the revised draft', async () => {
    const home = makeHome();
    replies = [research, '# 初稿\n\n一。', 'VERDICT: REVISE\n1. 直す', '# 改稿\n\n二。', failed];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts).toHaveLength(5);
    const result = readResult(home);
    expect(result).toContain('# 改稿');
    expect(result).not.toContain('# 初稿');
    expect(result).toContain('review: unresolved');
  }, 20000);

  it('REGRESSION: a failed write step still fails the run', async () => {
    const home = makeHome();
    replies = [research, failed];
    await runExecutor(writePlan(home, port, articleChain()), home);
    expect(prompts).toHaveLength(2);
    expect(readRunLog(home).status).not.toBe('success');
    expect(readResult(home)).not.toContain('title:');
  }, 20000);

  it('research over the limit is cut once, and the writer and the reviewer get the same notes', async () => {
    const home = makeHome();
    const longNotes = { content: `${RESEARCH}\n${'メモの行です。\n'.repeat(3000)}末尾のメモ`, citations: [SOURCE_URL] };
    replies = [longNotes, '# 記事\n\n本文です [1]。', 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts[1]).toContain('42%');
    expect(prompts[1]).not.toContain('末尾のメモ');
    expect(prompts[2]).not.toContain('末尾のメモ');
    // The notes are capped, so they cost the review nothing: the verdict stands.
    expect(readResult(home)).toContain('review: pass');
  }, 20000);

  it('the reviewer is told the carried text is data', async () => {
    const home = makeHome();
    replies = [research, '# 記事\n\n本文。', 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);
    expect(prompts[2]).toContain(ROLE_RESULTS_DATA_NOTE);
    expect(prompts[2].indexOf(ROLE_RESULTS_DATA_NOTE)).toBeGreaterThan(prompts[2].indexOf('# 記事'));
  }, 20000);

  it.each<[string, (plan: any) => void]>([
    ['a webhook action', (plan) => { plan.action = { type: 'webhook', webhookUrl: 'http://127.0.0.1:1/x' }; }],
    ['a notify action', (plan) => { plan.action = { type: 'notify' }; }],
    ['a social-post action', (plan) => { plan.action = { type: 'social-post', socialPost: { connectorId: 'x' } }; }],
    ['two actions', (plan) => { plan.actions = [{ type: 'draft' }, { type: 'webhook', webhookUrl: 'http://127.0.0.1:1/x' }]; }],
    ['an autonomous agent', (plan) => { plan.agent.autonomous = true; }],
    ['an api-call step', (plan) => { plan.steps.list[0].apiCall = { host: 'api.groq.com', method: 'GET', path: '/x' }; }],
    ['a CLI step', (plan) => { plan.steps.list[1].tool = { type: 'cli', cli: 'codex' }; }],
  ])('%s on a longform plan is refused before any model call', async (_name, change) => {
    const home = makeHome();
    replies = [research];
    const planFile = patchPlan(writePlan(home, port, articleChain()), change);
    expect(await runExecutor(planFile, home)).toBe(0);

    expect(prompts).toHaveLength(0);
    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.outputPreview).toBe(executor.LONGFORM_DRAFT_ONLY_MESSAGE);
    const note = path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`);
    expect(JSON.parse(fs.readFileSync(note, 'utf8')).status).toBe('error');
  }, 20000);

  it('a step marked invalid fails without its label reaching a model', async () => {
    const home = makeHome();
    replies = ['本文です。'];
    const list = normalizeSteps({
      longform: true,
      steps: [{ instruction: 'write it' }, { instruction: 'SECRET LABEL', local: { kind: 'shell' } as never }],
    });
    await runExecutor(writePlan(home, port, list), home);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('SECRET LABEL');
    expect(readRunLog(home).steps[1].status).toBe('error');
  }, 20000);

  it('a 5,000-character article reaches the draft and the next step intact', async () => {
    const home = makeHome();
    const paragraph = `${'これは本文の段落です。'.repeat(100)}\n\n`;
    const article = `# 長い記事\n\n${paragraph.repeat(5)}${MARKER}`;
    expect(article.length).toBeGreaterThan(5000);
    replies = [research, article, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);

    expect(prompts[2]).toContain(article);
    expect(readResult(home)).toContain(article);
  }, 20000);

  it('a phrase deep inside an article is not a refusal; a refusal at the top still is', async () => {
    const home = makeHome();
    const article = `# 記事\n\n${'本文。'.repeat(200)}\n\n研究者は「as an AI」という言い回しを引用した。この方法では画像を生成できません。`;
    replies = [research, article, 'VERDICT: PASS'];
    await runExecutor(writePlan(home, port, articleChain()), home);
    expect(readRunLog(home).status).toBe('success');
    expect(readResult(home)).toContain('画像を生成できません');

    const home2 = makeHome();
    prompts = [];
    replies = [research, 'As an AI, I cannot generate that content.'];
    await runExecutor(writePlan(home2, port, articleChain()), home2);
    expect(prompts).toHaveLength(2);
    expect(readRunLog(home2).status).toBe('error');
  }, 40000);

  it('a truncated completion fails the step and nothing is assembled', async () => {
    const home = makeHome();
    replies = [research, { content: '# 記事\n\n途中で切れた本', finish_reason: 'length' }, 'never reached'];
    expect(await runExecutor(writePlan(home, port, articleChain()), home)).toBe(0);

    expect(prompts).toHaveLength(2);
    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(2);
    expect(log.steps[1].status).toBe('error');
    expect(log.steps[1].outputPreview).toContain('output limit');
    expect(readResult(home)).not.toContain('途中で切れた');
    expect(readResult(home)).not.toContain('title:');
  }, 20000);

  it('zero sources still stops the chain before anything is written', async () => {
    const home = makeHome();
    replies = ['調査メモ（URLなし）'];
    await runExecutor(writePlan(home, port, articleChain()), home);
    expect(prompts).toHaveLength(1);
    expect(readRunLog(home).status).toBe('error');
  }, 20000);

  it('an invalid local config fails the step without calling a model', async () => {
    const home = makeHome();
    replies = ['本文です。'];
    const list = [{ instruction: 'write it' }, { instruction: 'assemble', local: { kind: 'shell', command: 'rm -rf /' } }];
    await runExecutor(writePlan(home, port, list), home);
    expect(prompts).toHaveLength(1);
    expect(readRunLog(home).steps[1].status).toBe('error');
  }, 20000);

  it('a local step on a plan without longform fails too', async () => {
    const home = makeHome();
    replies = ['本文です。'];
    const local = { kind: 'assemble', parts: [[0]], stream: 'ai-steam', footer: 'footer' };
    await runExecutor(writePlan(home, port, [{ instruction: 'write it' }, { instruction: 'assemble', local }], false), home);
    expect(prompts).toHaveLength(1);
    expect(readRunLog(home).steps[1].status).toBe('error');
  }, 20000);

  it('REGRESSION: a chain without longform ignores finish_reason and still collapses carried whitespace', async () => {
    const home = makeHome();
    replies = [{ content: '一行目\n\n二行目', finish_reason: 'length' }, 'done'];
    await runExecutor(writePlan(home, port, [{ instruction: 'first' }, { instruction: 'second' }], false), home);
    expect(readRunLog(home).status).toBe('success');
    expect(prompts[1]).toContain('一行目 二行目');
  }, 20000);
});

describe('longform constants and buildStepPrompt parity', () => {
  it('keeps the budgets lockstep with lib/agent-orchestration.ts', () => {
    expect(executor.LONGFORM_PROMPT_MAX_CHARS).toBe(MAX_LONGFORM_PROMPT_CHARS);
    expect(executor.LONGFORM_RESULT_CARRY_MAX_CHARS).toBe(MAX_LONGFORM_RESULT_CARRY_CHARS);
    expect(MAX_LONGFORM_PROMPT_CHARS).toBe(24000);
    expect(MAX_LONGFORM_RESULT_CARRY_CHARS).toBe(16000);
    expect(executor.LONGFORM_RESEARCH_MAX_CHARS).toBeLessThan(MAX_LONGFORM_PROMPT_CHARS - MAX_LONGFORM_RESULT_CARRY_CHARS);
  });

  it('builds the same longform prompt in TS and JS, newlines kept', () => {
    const results = ['# 記事\n\n第一段落。\n\n第二段落。', 'VERDICT: REVISE\n1. 直す'];
    const ts = tsBuildStepPrompt('Base', '直す', results, undefined, undefined, undefined, true);
    expect(executor.buildStepPrompt('Base', '直す', results, undefined, undefined, undefined, true)).toBe(ts);
    expect(ts).toContain(results[0]);
    expect(ts).toContain(results[1]);
  });

  it('matches with the synthesis evidence block too', () => {
    const evidence = { mode: 'synthesis', sources: [{ id: 1, title: 'Paper', url: SOURCE_URL }], items: [] } as any;
    const results = ['調査メモ\n\n本文'];
    expect(executor.buildStepPrompt('Base', '書く', results, evidence, undefined, undefined, true))
      .toBe(tsBuildStepPrompt('Base', '書く', results, evidence, undefined, undefined, true));
  });

  it('adds the data note to a longform prompt in both, and to no other prompt', () => {
    const results = ['調査メモ'];
    const longformPrompt = tsBuildStepPrompt('Base', '査読', results, undefined, undefined, undefined, true);
    expect(longformPrompt).toContain(ROLE_RESULTS_DATA_NOTE);
    expect(executor.buildStepPrompt('Base', '査読', results, undefined, undefined, undefined, true)).toBe(longformPrompt);
    expect(tsBuildStepPrompt('Base', '査読', results)).not.toContain(ROLE_RESULTS_DATA_NOTE);
    expect(tsBuildStepPrompt('Base', '最初の手順', [], undefined, undefined, undefined, true)).not.toContain(ROLE_RESULTS_DATA_NOTE);
  });

  it('composeStepPrompt reports a cut carry and a cut prefix, and nothing else', () => {
    const compose = (results: string[], base = 'Base') => executor.composeStepPrompt(base, '査読', results, undefined, undefined, undefined, true);
    const fits = compose(['a'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS)]);
    expect(fits.truncated).toBe(false);
    expect(compose(['a'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS + 1)]).truncated).toBe(true);
    expect(compose(['a'.repeat(12000), 'b'.repeat(12000)]).truncated).toBe(true);
    expect(compose(['short'], 'x'.repeat(MAX_LONGFORM_PROMPT_CHARS)).truncated).toBe(true);
    expect(fits.prompt).toBe(executor.buildStepPrompt('Base', '査読', ['a'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS)], undefined, undefined, undefined, true));
  });

  it('capLongformResearch leaves short notes and cuts long ones at a line end', () => {
    const limit = executor.LONGFORM_RESEARCH_MAX_CHARS;
    expect(executor.capLongformResearch('短い')).toBe('短い');
    const lines = `${'行\n'.repeat(limit)}`;
    const capped = executor.capLongformResearch(lines);
    expect(capped.length).toBeLessThanOrEqual(limit);
    expect(capped.endsWith('行')).toBe(true);
    expect(executor.capLongformResearch('a'.repeat(limit * 2))).toHaveLength(limit);
  });

  it('caps each result at the carry budget and the prompt at 24,000, keeping the instruction', () => {
    const results = ['a'.repeat(20000), 'b'.repeat(20000), 'c'.repeat(20000)];
    const ts = tsBuildStepPrompt('x'.repeat(100), '最後の指示', results, undefined, undefined, undefined, true);
    expect(executor.buildStepPrompt('x'.repeat(100), '最後の指示', results, undefined, undefined, undefined, true)).toBe(ts);
    expect(ts.length).toBeLessThanOrEqual(24000);
    expect(ts).toContain('a'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS));
    expect(ts).not.toContain('a'.repeat(MAX_LONGFORM_RESULT_CARRY_CHARS + 1));
    expect(ts.endsWith('# This step\n最後の指示')).toBe(true);
  });

  it('without the flag the prompt is unchanged in both', () => {
    const results = ['一行目\n\n二行目'];
    const ts = tsBuildStepPrompt('Base', 'step', results);
    expect(ts).toContain('一行目 二行目');
    expect(executor.buildStepPrompt('Base', 'step', results)).toBe(ts);
  });
});

describe('normalizeStepLocal parity', () => {
  const valid = {
    kind: 'assemble' as const,
    parts: [[1, 3, 5]],
    stream: 'ai-steam',
    footer: 'line one\nline two',
    lintTerms: ['世界初'],
    nameLint: { canonical: 'RYO ITABASHI', forms: ['itabashi'] },
  };

  it('accepts a valid config identically', () => {
    expect(tsNormalizeStepLocal(valid)).toEqual(valid);
    expect(executor.normalizeStepLocal(valid, 6)).toEqual(valid);
  });

  it.each([
    ['unknown kind', { ...valid, kind: 'exec' }],
    ['empty parts', { ...valid, parts: [] }],
    ['non-integer index', { ...valid, parts: [[1.5]] }],
    ['bad stream', { ...valid, stream: '../x' }],
    ['empty footer', { ...valid, footer: ' ' }],
    ['control character in the footer', { ...valid, footer: 'a\u0007b' }],
    ['lint terms not strings', { ...valid, lintTerms: [1] }],
    ['name lint without a canonical form', { ...valid, nameLint: { forms: ['x'] } }],
  ])('refuses %s in both', (_name, raw) => {
    expect(tsNormalizeStepLocal(raw)).toBeUndefined();
    expect(executor.normalizeStepLocal(raw, 6)).toBeUndefined();
  });

  it('refuses a part at or after the step itself', () => {
    expect(executor.normalizeStepLocal(valid, 5)).toBeUndefined();
    const steps = [{ instruction: 'a' }, { instruction: 'assemble', local: valid }];
    expect(normalizeSteps({ steps })[1].local).toBeUndefined();
  });

  it('on a longform chain an invalid local stays local, so the executor refuses it', () => {
    const bad = { instruction: 'label', local: { kind: 'shell' } as never, tool: { type: 'gemini-api' } as never };
    const [invalid] = normalizeSteps({ longform: true, steps: [bad, { instruction: 'next' }] });
    expect(invalid).toEqual({ instruction: 'label', local: { kind: 'invalid' } });
    expect(executor.normalizeStepLocal(invalid.local, 1)).toBeUndefined();
    expect(tsNormalizeStepLocal(invalid.local)).toBeUndefined();

    const late = normalizeSteps({ longform: true, steps: [{ instruction: 'a' }, { instruction: 'assemble', local: valid }] });
    expect(late[1].local).toEqual({ kind: 'invalid' });
  });

  it('REGRESSION: without longform an invalid local is still dropped', () => {
    const bad = { instruction: 'label', local: { kind: 'shell' } as never };
    expect(normalizeSteps({ steps: [bad, { instruction: 'next' }] })[0].local).toBeUndefined();
  });
});

describe('assembleArticle', () => {
  const local = {
    kind: 'assemble',
    parts: [[1, 3, 5]],
    stream: 'ai-steam',
    footer: 'フッター',
    lintTerms: ['世界初', 'world first'],
    nameLint: { canonical: 'RYO ITABASHI', forms: ['itabashi'] },
  };
  const steps = [
    {},
    {},
    { handoff: { kind: 'review', of: [0, 1], round: 1 } },
    { handoff: { kind: 'revise', of: [1, 2], round: 1 } },
    { handoff: { kind: 'review', of: [0, 3], round: 2 } },
    { handoff: { kind: 'revise', of: [3, 4], round: 2 } },
    {},
  ];
  const assemble = (results: Array<string | undefined>, skipped: boolean[] = [], over = {}) =>
    executor.assembleArticle({ ...local, ...over }, {
      steps,
      results,
      skipped,
      sources: [{ id: 1, title: 'Paper', url: SOURCE_URL, date: '2026-11-01' }],
      today: '2026-11-06',
      fallbackTitle: 'Fallback',
    });

  it('takes the last non-skipped result of each list', () => {
    const results = ['r', '# 一', 'VERDICT: REVISE', '# 三', 'VERDICT: PASS'];
    const out = assemble(results, [false, false, false, false, false, true]);
    expect(out).toContain('# 三');
    expect(out).not.toContain('# 一');
    expect(out).toContain('review: pass');
  });

  it('joins several parts in order', () => {
    const out = assemble(['r', '# 一', 'VERDICT: PASS', '二'], [], { parts: [[1], [3]] });
    expect(out.indexOf('# 一')).toBeLessThan(out.indexOf('二'));
  });

  it('strips reasoning and replaces a model-written Sources section with the chain sources', () => {
    const out = assemble(['r', '<think>考え中</think># 記事\n\n本文 [1]\n\n## Sources\n\n- [1] 捏造 https://fake.example', 'VERDICT: PASS']);
    expect(out).not.toContain('考え中');
    expect(out).not.toContain('fake.example');
    expect(out).toContain(`- [1] [Paper](${SOURCE_URL}) — 2026-11-01`);
  });

  it('review is unresolved without a verdict line, after REVISE, and with no review at all', () => {
    expect(assemble(['r', '# 記事', 'この記事は問題ありません']).split('\n')).toContain('review: unresolved');
    expect(assemble(['r', '# 記事', 'VERDICT: PASS', '# 二', 'VERDICT: REVISE', '# 三']).split('\n')).toContain('review: unresolved');
    expect(assemble(['r', '# 記事']).split('\n')).toContain('review: unresolved');
  });

  it('a later REVISE beats an earlier PASS only if the later review ran', () => {
    const skipped = [false, false, false, true, true, true];
    expect(assemble(['r', '# 記事', 'VERDICT: PASS'], skipped).split('\n')).toContain('review: pass');
  });

  it('material follows the marker, half-width or full-width colon', () => {
    expect(assemble(['r', `# 記事\n\n${MARKER}`, 'VERDICT: PASS'])).toContain('material: missing');
    expect(assemble(['r', '# 記事\n\n【本人の材料： 未記入】', 'VERDICT: PASS'])).toContain('material: missing');
    // No marker means it was dropped: an unattended chain has no owner material.
    expect(assemble(['r', '# 記事\n\n私が測りました。', 'VERDICT: PASS'])).toContain('material: unknown');
    expect(assemble(['r', '# 記事\n\n私が測りました。', 'VERDICT: PASS'])).not.toContain('material: ok');
  });

  const assembleWith = (over: object, results: string[] = ['r', '# 記事', 'VERDICT: PASS'], skipped: boolean[] = []) =>
    executor.assembleArticle(local, { steps, results, skipped, sources: [], today: '2026-11-06', fallbackTitle: 'F', ...over });

  it('a review note pins the review to unresolved over a PASS, and says why', () => {
    const cut = assembleWith({ reviewNotes: ['切れた', '動かなかった'] });
    expect(cut.split('\n')).toContain('review: unresolved');
    expect(cut.split('\n')).toContain('review_note: "切れた、動かなかった"');
    expect(assemble(['r', '# 記事', 'VERDICT: PASS'])).not.toContain('review_note');
  });

  it('writes when it was saved', () => {
    expect(assembleWith({ savedAt: '2026-11-06T06:01:02.000Z' }).split('\n')).toContain('saved_at: 2026-11-06T06:01:02.000Z');
    expect(/^saved_at: \S+$/m.test(assemble(['r', '# 記事']))).toBe(true);
  });

  it.each<[string, Array<string | undefined>]>([
    ['Gemini writer, Cerebras reviewer', [undefined, 'gemini-api', 'cerebras']],
    ['Groq writer, Gemini reviewer', [undefined, 'groq', 'gemini-api']],
    ['the local LLM, which no longform ladder reaches', [undefined, 'local', 'local']],
  ])('%s stands', (_name, usedEngines) => {
    expect(assembleWith({ usedEngines }).split('\n')).toContain('review: pass');
  });

  it.each<[string, Array<string | undefined>]>([
    ['Groq writer, Cerebras reviewer', [undefined, 'groq', 'cerebras']],
    ['Cerebras writer, Groq reviewer', [undefined, 'cerebras', 'groq']],
    ['one engine on both sides', [undefined, 'gemini-api', 'gemini-api']],
  ])('%s pins unresolved and still saves', (_name, usedEngines) => {
    const out = assembleWith({ usedEngines });
    expect(out.split('\n')).toContain('review: unresolved');
    expect(out).toContain(executor.ARTICLE_SAME_ENGINE_NOTE);
    expect(out).toContain('# 記事');
  });

  it('compares the writer of the final version with the last reviewer that ran', () => {
    const results = ['r', '# 一', 'VERDICT: REVISE', '# 二', 'VERDICT: PASS'];
    const skipped = [false, false, false, false, false, true];
    const usedEngines = [undefined, 'gemini-api', 'gemini-api', 'groq', 'cerebras'];
    expect(assembleWith({ usedEngines }, results, skipped).split('\n')).toContain('review: unresolved');
    const fine = [undefined, 'groq', 'groq', 'gemini-api', 'cerebras'];
    expect(assembleWith({ usedEngines: fine }, results, skipped).split('\n')).toContain('review: pass');
  });

  it('strips only a real Sources heading, its entries and blank lines', () => {
    const body = '# 記事\n\n参考\n\nこの段落は残る。\n\nSources\n\nこれも残る。';
    expect(executor.stripArticleSources(body)).toBe(body);
    expect(executor.stripArticleSources('本文。\n\n## 参考文献\n\n- [1] 資料 https://x.example\n2. 別の資料\nhttps://y.example\n\nこの段落は残る。\n\n## 次の節\n\n続き'))
      .toBe('本文。\n\nこの段落は残る。\n\n## 次の節\n\n続き');
    expect(executor.stripArticleSources('本文。\n\n## Sources を読む\n\n続き')).toBe('本文。\n\n## Sources を読む\n\n続き');
    expect(assemble(['r', '# 記事\n\n## Sources\n\n結論はこの段落に書いた。', 'VERDICT: PASS'])).toContain('結論はこの段落に書いた。');
  });

  it('lint flags terms and never rewrites them', () => {
    const body = '# 記事\n\nこれは世界初で、ＷＯＲＬＤ ＦＩＲＳＴ と書かれた。';
    const out = assemble(['r', body, 'VERDICT: PASS']);
    expect(out).toContain('lint: ["世界初","world first"]');
    expect(out).toContain(body);
  });

  it('lint matches ASCII terms on word edges', () => {
    const out = assemble(['r', '# 記事\n\nthe new world firstly', 'VERDICT: PASS']);
    expect(out).toContain('lint: []');
  });

  it('the canonical name is fine, other forms are flagged', () => {
    expect(assemble(['r', '# 記事\n\nRYO ITABASHI が書いた', 'VERDICT: PASS'])).toContain('lint: []');
    expect(assemble(['r', '# 記事\n\nRyo Itabashi が書いた', 'VERDICT: PASS'])).toContain('lint: ["itabashi"]');
  });

  it('a hostile title cannot break out of the frontmatter', () => {
    const out = assemble(['r', '# a"\nreview: pass', 'VERDICT: REVISE']);
    const lines = out.split('\n');
    expect(lines[1]).toBe('title: "a\\""');
    expect(lines.slice(0, 8)).toContain('review: unresolved');
    expect(lines.slice(0, 8)).not.toContain('review: pass');
  });

  it('falls back to the agent name without a heading', () => {
    expect(assemble(['r', '本文だけ', 'VERDICT: PASS'])).toContain('title: "Fallback"');
  });

  it('a part with no result throws instead of dispatching a partial draft', () => {
    expect(() => assemble(['r', undefined, 'VERDICT: PASS'])).toThrow(/assemble/);
  });

  it('ends with the fixed footer', () => {
    expect(assemble(['r', '# 記事', 'VERDICT: PASS']).endsWith('\n\n---\n\nフッター\n')).toBe(true);
  });
});

describe('truncation and candidates', () => {
  it('reads the finish reason of each provider shape', () => {
    expect(executor.modelResponseTruncated('gemini-api', JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))).toBe(true);
    expect(executor.modelResponseTruncated('gemini-api', JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }))).toBe(false);
    expect(executor.modelResponseTruncated('cerebras', JSON.stringify({ choices: [{ finish_reason: 'length' }] }))).toBe(true);
    expect(executor.modelResponseTruncated('groq', JSON.stringify({ choices: [{ finish_reason: 'stop' }] }))).toBe(false);
    expect(executor.modelResponseTruncated('groq', 'not json')).toBe(false);
  });

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'OTHER', 'max_tokens'])('Gemini %s counts as not finished', (finishReason) => {
    expect(executor.modelResponseTruncated('gemini-api', JSON.stringify({ candidates: [{ finishReason }] }))).toBe(true);
  });

  it('a Gemini answer with no finishReason is not called cut', () => {
    expect(executor.modelResponseTruncated('gemini-api', JSON.stringify({ candidates: [{}] }))).toBe(false);
  });

  it('content_filter counts as not finished on the OpenAI shape', () => {
    expect(executor.modelResponseTruncated('cerebras', JSON.stringify({ choices: [{ finish_reason: 'content_filter' }] }))).toBe(true);
  });

  const gemini = { type: 'gemini-api' };
  const local = { type: 'local' };
  const cerebras = { type: 'cerebras' };
  const ladder = [local, cerebras];

  it('keeps every candidate on an ordinary plan', () => {
    expect(executor.stepToolCandidates({ tool: gemini, toolLadder: ladder })).toEqual([gemini, local, cerebras]);
  });

  it('drops the local LLM from a longform ladder', () => {
    expect(executor.stepToolCandidates({ tool: gemini, toolLadder: ladder, steps: { longform: true } })).toEqual([gemini, cerebras]);
  });

  it('a longform research step does not climb to a backend with no web access', () => {
    expect(executor.stepToolCandidates({ tool: gemini, toolLadder: ladder, steps: { longform: true }, sourcing: { mode: 'research' } })).toEqual([gemini]);
  });

  it('keeps the other role\'s engines off a longform ladder', () => {
    const groq = { type: 'groq' };
    const review = { tool: cerebras, toolLadder: [gemini, groq], steps: { longform: true }, longformOtherTools: ['gemini-api'] };
    expect(executor.stepToolCandidates(review)).toEqual([cerebras, groq]);
    const write = { tool: gemini, toolLadder: [cerebras], steps: { longform: true }, longformOtherTools: ['cerebras'] };
    expect(executor.stepToolCandidates(write)).toEqual([gemini]);
  });

  it('REGRESSION: the exclusion does nothing on an ordinary plan', () => {
    expect(executor.stepToolCandidates({ tool: gemini, toolLadder: ladder, longformOtherTools: ['cerebras'] })).toEqual([gemini, local, cerebras]);
  });

  it('names each side\'s engines from the real chain', () => {
    const steps = normalizeSteps(buildArticlePipeline('ai-steam').orchestration);
    expect([...new Set(executor.longformOtherRoleTools(steps, 1))]).toEqual(['cerebras']);
    expect([...new Set(executor.longformOtherRoleTools(steps, 2))]).toEqual(['gemini-api']);
    expect([...new Set(executor.longformOtherRoleTools(steps, 3))]).toEqual(['cerebras']);
  });
});

describe('the draft lands in the vault with no mirror copy', () => {
  const { output } = buildArticlePipeline('ai-steam');

  it('saves under 50_Drafts/Steam with the preset file name', () => {
    const plan = {
      agent: { id: AGENT_ID },
      output: { outputDir: output!.outputPath, outputNameTemplate: output!.outputTemplate, slug: 'x', useGlobalOutput: false },
    };
    const { dest, rel, useGlobalOutput } = executor.resolveDraftDestination({ home: '/home/x' }, plan, {}, new Date(2026, 10, 6, 6, 0, 0));
    expect(useGlobalOutput).toBe(false);
    expect(rel).toBe('2026-11-06-ai-steam.md');
    expect(dest).toBe(path.join('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/', '2026-11-06-ai-steam.md'));
  });

  it('no 90_Log copy when a longform output folder is inside the vault', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-vault-'));
    const plan = { steps: { longform: true }, output: { outputDir: path.join(vault, '50_Drafts', 'Steam') } };
    expect(executor.resolveObsidianMirror(plan, { OBSIDIAN_VAULT_PATH: vault }, 'a.md')).toBeNull();
  });

  it('REGRESSION: another agent saving inside the vault keeps its 90_Log copy, the .sh context source', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-vault-'));
    const plan = { output: { outputDir: path.join(vault, '50_Drafts', 'Steam') } };
    expect(executor.resolveObsidianMirror(plan, { OBSIDIAN_VAULT_PATH: vault }, 'a.md')).toBe(path.join(vault, '90_Log/Agent_Output', 'a.md'));
  });

  it('REGRESSION: the .sh save path keeps its mirror and its script version', () => {
    const src = fs.readFileSync(path.join(root, 'lib', 'agent-executor.ts'), 'utf8');
    expect(src).not.toContain('OBSIDIAN_VAULT_PATH%/}');
    expect(src).toContain('const AGENT_SCRIPT_VERSION = 77;');
  });

  it('a sibling folder that only shares the prefix is not inside the vault', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-vault-'));
    const plan = { output: { outputDir: `${vault}-other/drafts` } };
    expect(executor.resolveObsidianMirror(plan, { OBSIDIAN_VAULT_PATH: vault }, 'a.md')).toBe(path.join(vault, '90_Log/Agent_Output', 'a.md'));
  });

  it('REGRESSION: an output folder outside the vault still mirrors', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-vault-'));
    const plan = { output: { outputDir: '/home/x/projects/shelly-content-studio/drafts/x' } };
    expect(executor.resolveObsidianMirror(plan, { OBSIDIAN_VAULT_PATH: vault }, 'a.md')).toBe(path.join(vault, '50_Drafts/X', 'a.md'));
  });
});
