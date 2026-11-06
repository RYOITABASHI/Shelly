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
// test host). They end in `notify`, not `draft`: the broker's fs.write path is
// a known Windows-host failure (see __tests__/plan-executor-saved-path.test.ts),
// so the assembled text is read from the result file `draft` would save, and
// the vault destination is covered at the function level below.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-longform';
const RESEARCH = '1. 論文A（査読前）: 数値は42%でした。 https://example.org/paper-a';
const SOURCE_URL = 'https://example.org/paper-a';
const MARKER = '【本人の材料: 未記入】';

type Reply = string | { content: string; finish_reason?: string; citations?: string[] };

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
    action: { type: 'notify' },
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
        const r = typeof reply === 'string' ? { content: reply } : reply;
        res.setHeader('Content-Type', 'application/json');
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
    expect(result).toContain('material: ok');
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
    expect(MAX_LONGFORM_RESULT_CARRY_CHARS).toBe(12000);
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

  it('caps each result at 12,000 characters and the prompt at 24,000, keeping the instruction', () => {
    const results = ['a'.repeat(20000), 'b'.repeat(20000), 'c'.repeat(20000)];
    const ts = tsBuildStepPrompt('x'.repeat(100), '最後の指示', results, undefined, undefined, undefined, true);
    expect(executor.buildStepPrompt('x'.repeat(100), '最後の指示', results, undefined, undefined, undefined, true)).toBe(ts);
    expect(ts.length).toBeLessThanOrEqual(24000);
    expect(ts).toContain('a'.repeat(12000));
    expect(ts).not.toContain('a'.repeat(12001));
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
    expect(assemble(['r', '# 記事\n\n私が測りました。', 'VERDICT: PASS'])).toContain('material: ok');
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

  it('no 90_Log copy when the output folder is inside the vault', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-vault-'));
    const plan = { output: { outputDir: path.join(vault, '50_Drafts', 'Steam') } };
    expect(executor.resolveObsidianMirror(plan, { OBSIDIAN_VAULT_PATH: vault }, 'a.md')).toBeNull();
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
