jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { examplePipeline } from './fixtures/article-pipeline-config';

// Executor v42: what kept every article run at `review: unresolved`.
//  - Gemini research lost its grounding: no [n] in the notes, redirect links
//    titled with a bare domain. The notes now carry Google's own markers and
//    the links their targets (broker op http.resolve-redirect).
//  - Journal index pages left the research.
//  - The review loop gets fixed rules: findings fixable from the material, no
//    notes to an editor. assemble cuts such a note and flags the draft.
//  - The author view: more sentence starters, a 1-2-3 list apart by blank
//    lines is joined, and a locally refused section goes back once or twice.
// Every text, host and name here is made up.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const brokerScript = path.join(root, 'scripts', 'shelly-capability-broker.js');
const fixtureBroker = path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require(brokerScript);

const REDIRECT_A = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA_111-x=';
const REDIRECT_B = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB_222';
const REDIRECT_C = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/CCC_333';

function groundedResponse(text: string, supports: Array<{ text: string; chunks: number[] }>, chunks = [REDIRECT_A, REDIRECT_B, REDIRECT_C]) {
  return JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: chunks.map((uri, k) => ({ web: { uri, title: `site-${k + 1}.example` } })),
          groundingSupports: supports.map((s) => ({ segment: { text: s.text }, groundingChunkIndices: s.chunks })),
        },
      },
    ],
  });
}

describe('Gemini grounded research (v42)', () => {
  const NOTES = '調査メモ。\n- 素材Aは1990年代に広まった。\n- 素材Bは輸入品が多い [7]。\n- 結論は出ていない。';
  const supports = [
    { text: '素材Aは1990年代に広まった。', chunks: [0] },
    { text: '素材Bは輸入品が多い', chunks: [1, 2] },
    { text: 'ここには無い文', chunks: [0] },
  ];

  it('puts Google\'s chunk numbers after the text they back, and drops the model\'s own markers', () => {
    const out = executor.geminiGroundedResearch(groundedResponse(NOTES, supports), NOTES, {});
    expect(out.text).toContain('素材Aは1990年代に広まった。[1]');
    expect(out.text).toContain('素材Bは輸入品が多い[2][3]');
    expect(out.text).not.toContain('[7]');
    expect(out.text).toContain('結論は出ていない。');
    expect(out.parsed.indexMap).toEqual([0, 1, 2, 3]);
    expect(out.parsed.sources.map((s: any) => s.url)).toEqual([REDIRECT_A, REDIRECT_B, REDIRECT_C]);
  });

  it('uses resolved targets, keeps a link it could not resolve, and dedupes two links to one page', () => {
    const resolved = { [REDIRECT_A]: 'https://site-1.example/a', [REDIRECT_B]: 'https://site-1.example/a' };
    const out = executor.geminiGroundedResearch(groundedResponse(NOTES, supports), NOTES, resolved);
    expect(out.parsed.sources.map((s: any) => s.url)).toEqual(['https://site-1.example/a', REDIRECT_C]);
    // Chunks 1 and 2 are the same page now: both markers name source 1.
    expect(out.parsed.indexMap).toEqual([0, 1, 1, 2]);
  });

  it.each([
    ['a loopback host', 'http://127.0.0.1/x'],
    ['localhost', 'https://localhost/x'],
    ['a port', 'https://site.example:8443/x'],
    ['credentials', 'https://user:pw@site.example/x'],
    ['another redirect', REDIRECT_B],
    ['not http', 'javascript:alert(1)'],
    ['an IPv6 literal', 'https://[::1]/x'],
  ])('refuses a target with %s', (_name, target) => {
    expect(executor.usableRedirectTarget(target)).toBeNull();
    const out = executor.geminiGroundedResearch(groundedResponse(NOTES, supports), NOTES, { [REDIRECT_A]: target });
    expect(out.parsed.sources[0].url).toBe(REDIRECT_A);
  });

  it('is null without grounding chunks (the old parse stands)', () => {
    expect(executor.geminiGroundedResearch(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), 'x', {})).toBeNull();
    expect(executor.geminiGroundedResearch('not json', 'x', {})).toBeNull();
  });

  it('lists only redirect links, once each, at most ten', () => {
    const many = Array.from({ length: 12 }, (_, k) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/T${k}`);
    expect(executor.groundingRedirectUris(groundedResponse('x', [], many))).toHaveLength(10);
    expect(executor.groundingRedirectUris(groundedResponse('x', [], [REDIRECT_A, REDIRECT_A, 'https://site.example/p']))).toEqual([REDIRECT_A]);
  });
});

describe('journal index pages leave the research (v42)', () => {
  it('drops an index source, maps its marker to nothing and cuts its inline link', () => {
    const parsed = {
      sources: [
        { id: 1, title: 'Paper', url: 'https://www.tandfonline.com/doi/full/10.0000/x' },
        { id: 2, title: 'Journal', url: 'https://www.tandfonline.com/toc/abcd/1/1' },
        { id: 3, title: 'Blog', url: 'https://blog.example/post' },
      ],
      indexMap: [0, 1, 2, 3],
    };
    const out = executor.withoutIndexSources('目次 https://www.tandfonline.com/toc/abcd/1/1 と本文', parsed);
    expect(out.parsed.sources.map((s: any) => [s.id, s.url])).toEqual([
      [1, 'https://www.tandfonline.com/doi/full/10.0000/x'],
      [2, 'https://blog.example/post'],
    ]);
    expect(out.parsed.indexMap).toEqual([0, 1, 0, 2]);
    expect(out.text).not.toContain('/toc/abcd');
  });
});

describe('notes to an editor (v42)', () => {
  const steps = [{ instruction: 'r' }, { instruction: 'w' }, { instruction: 'review', handoff: { kind: 'review', of: [0, 1], round: 1 } }];
  const local = { kind: 'assemble', parts: [[1]], stream: 'example', footer: 'F', quality: { selfTalk: true } };
  const lintOf = (out: string) => JSON.parse(/^lint: (.*)$/m.exec(out)![1]);
  const assemble = (body: string) =>
    executor.assembleArticle(local, { steps, results: ['r', body, 'VERDICT: PASS'], skipped: [], sources: [], today: '2026-11-09', fallbackTitle: 'F' });

  it.each([
    ['a ※ line', '※編集メモ（本文外・公開時に削除してください）：出典の対応はまだ見ていません。'],
    ['a bracketed label at the line start', '（記事外・公開時に削除）この段落は後で直す。'],
    ['an English note', "Editor's note: remove before publishing, the second source is unchecked."],
    ['a note to the editor', 'Note to editor: check [2] again.'],
    ['a remove-before line', '[Remove this paragraph before publishing.]'],
  ])('cuts %s and flags the draft', (_name, note) => {
    const out = assemble(`# 記事\n\n本文の一段落目です。\n\n${note}\n\n本文の二段落目です。`);
    expect(out).not.toContain(note);
    expect(out).toContain('本文の一段落目です。\n\n本文の二段落目です。');
    expect(lintOf(out)).toContain(`${executor.ARTICLE_META_NOTE_CUT_FLAG}: 1`);
  });

  it('cuts a note that follows prose on its line, and keeps the prose', () => {
    const out = assemble('# 記事\n\n本文です。（記事外・公開時に削除）ここはメモ。\n\n続き。');
    expect(out).toContain('本文です。\n\n続き。');
    expect(out).not.toContain('ここはメモ');
  });

  it.each([
    '公開時に作られたものと、後年の再販を比べます。',
    'The editor of the magazine wrote a note about it.',
    'Release notes list the change before publishing day.',
    '記事の外側にある資料も読みました。',
  ])('leaves ordinary prose alone: %s', (line) => {
    const out = assemble(`# 記事\n\n${line}`);
    expect(out).toContain(line);
    expect(lintOf(out).join()).not.toContain('編集メモ');
  });

  it('leaves a code fence alone', () => {
    const code = '```\n// TODO: editor\'s note: remove before publishing\n```';
    expect(assemble(`# 記事\n\n${code}`)).toContain(code);
  });

  it('the quality check catches a note still in the body', () => {
    expect(executor.articleHasMetaNote('本文\n編集メモ: 後で直す')).toBe(true);
    expect(executor.articleHasMetaNote('本文\n```\n編集メモ: 後で直す\n```')).toBe(false);
  });
});

describe('review loop rules (v42)', () => {
  const contract = executor.REVIEW_OUTPUT_CONTRACT;

  it('a review gets the rules before its output contract, which stays last', () => {
    const out = executor.longformHandoffInstruction({ instruction: `Check the draft.\n\n${contract}`, handoff: { kind: 'review', of: [0, 1], round: 1 } });
    expect(out.startsWith('Check the draft.')).toBe(true);
    expect(out).toContain(executor.LONGFORM_REVIEW_RULES);
    expect(out.endsWith(contract)).toBe(true);
  });

  it('a revision gets its rules after its instruction; other steps are unchanged', () => {
    const out = executor.longformHandoffInstruction({ instruction: 'Apply the findings.', handoff: { kind: 'revise', of: [1, 2], round: 1 } });
    expect(out).toBe(`Apply the findings.\n\n${executor.LONGFORM_REVISE_RULES}`);
    expect(executor.longformHandoffInstruction({ instruction: 'Write.' })).toBe('Write.');
  });

  it('the rules forbid notes and outside checks, and keep an unsupported claim a finding', () => {
    expect(executor.LONGFORM_REVIEW_RULES).toMatch(/do not state.*is a finding/);
    expect(executor.LONGFORM_REVIEW_RULES).toContain('Never ask for a new search');
    expect(executor.LONGFORM_REVISE_RULES).toContain('Never write a note to an editor');
  });
});

describe('author view (v42)', () => {
  const profile = executor.parseVoiceProfile('---\nreviewed: 2026-11-01\n---\n\n## Values\n- Small tools beat big platforms.\n');
  const article = '# A post\n\nPlain words about small tools.\n\n【本人の材料: 未記入】';
  const people = (section: string) => executor.voicePeopleProblem(section, { profile, article });

  it('an everyday katakana word is not a name, a made-up one still is', () => {
    expect(people('コピーして貼るだけの話ではないと思います。')).toBe('');
    expect(people('ゾルバクさんの考えは正しいと思います。')).toContain('ゾルバク');
  });

  it.each(['Another reason is the cost.', 'Every tool has a limit.', 'Instead, small tools win.', 'Neither side is wrong.'])('a sentence may open with a function word: %s', (section) => {
    expect(people(section)).toBe('');
  });

  it('a capitalised word that is neither a starter nor in the article is still refused', () => {
    expect(people('Zorvak liked it.')).toContain('Zorvak');
    expect(people('I think Zorvak is right.')).toContain('Zorvak');
  });

  it('joins a 1-2-3 list that only blank lines kept apart, references and all', () => {
    const section = '理由を並べてみました。\n①古いから\n\n②手間がかかるから\n\n③数が少ないから\nそして③のせいで、①と②が目立たないのが悩ましいところです…';
    expect(executor.voiceSectionProblem(section, 'ja', {})).toContain('1から始まらない');
    const fixed = executor.voiceRenumberList(section);
    expect(fixed).toBe('理由を並べてみました。\n①古いから\n②手間がかかるから\n③数が少ないから\nそして③のせいで、①と②が目立たないのが悩ましいところです…');
    expect(executor.voiceSectionProblem(fixed, 'ja', {})).toBe('');
  });

  it('still refuses to reorder a list with references whose numbers are wrong', () => {
    const section = '②古いから\n③手間がかかるから\nそして③のせいで困ります。';
    expect(executor.voiceRenumberList(section)).toBe(section);
  });

  it('the finding for a locally refused section names the reason', () => {
    expect(executor.voiceLocalFinding('プロフィールに無い数: 7')).toMatch(/^1\. .*プロフィールに無い数: 7/);
    expect(executor.VOICE_LOCAL_RETRY_MAX).toBe(2);
  });
});

describe('broker http.resolve-redirect', () => {
  it('accepts only the fixed redirect endpoint', () => {
    expect(broker.isGroundingRedirectUrl(REDIRECT_A)).toBe(true);
    for (const bad of [
      'http://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA',
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA?x=1',
      'https://vertexaisearch.cloud.google.com/other/AAA',
      'https://vertexaisearch.cloud.google.com.evil.example/grounding-api-redirect/AAA',
      'https://vertexaisearch.cloud.google.com:444/grounding-api-redirect/AAA',
      'https://example.org/grounding-api-redirect/AAA',
    ]) {
      expect(broker.isGroundingRedirectUrl(bad)).toBe(false);
    }
  });

  it('hands back only a plain web address from a redirect status', () => {
    expect(broker.groundingRedirectTarget(302, 'https://site.example/a?b=1')).toBe('https://site.example/a?b=1');
    expect(broker.groundingRedirectTarget(200, 'https://site.example/a')).toBeNull();
    expect(broker.groundingRedirectTarget(302, '/relative')).toBeNull();
    expect(broker.groundingRedirectTarget(302, 'http://10.0.0.1/a')).toBeNull();
    expect(broker.groundingRedirectTarget(302, 'https://localhost/a')).toBeNull();
    expect(broker.groundingRedirectTarget(302, `https://site.example/${'a'.repeat(600)}`)).toBeNull();
    expect(broker.groundingRedirectTarget(302, REDIRECT_B)).toBeNull();
  });

  it('asks only for redirect links, charges the budget once and logs no token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-redirect-'));
    const urlsFile = path.join(dir, 'urls.json');
    fs.writeFileSync(urlsFile, JSON.stringify([REDIRECT_A, 'https://elsewhere.example/x', REDIRECT_A, REDIRECT_B]));
    const asked: string[] = [];
    const probe = (url: string) => {
      asked.push(url);
      return Promise.resolve(url === REDIRECT_A ? { status: 302, target: 'https://site.example/a' } : { status: 302, target: 'http://127.0.0.1/' });
    };
    const args = { 'urls-file': urlsFile, out: path.join(dir, 'out'), err: path.join(dir, 'err'), 'audit-log': path.join(dir, 'audit'), 'budget-file': path.join(dir, 'budget') };
    expect(await broker.runResolveRedirects(args, '2026-11-09T00:00:00Z', Date.now(), probe)).toBe(0);
    expect(asked).toEqual([REDIRECT_A, REDIRECT_B]);
    expect(JSON.parse(fs.readFileSync(args.out, 'utf8'))).toEqual({ [REDIRECT_A]: 'https://site.example/a' });
    expect(JSON.parse(fs.readFileSync(args['budget-file'], 'utf8')).calls).toBe(1);
    const audit = fs.readFileSync(args['audit-log'], 'utf8');
    expect(audit).not.toContain('AAA_111');
    expect(audit).toContain('"decision":"deny"');
    expect(audit).toContain('"targetHost":"site.example"');
  });

  it('refuses more than ten links', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-redirect-'));
    const urlsFile = path.join(dir, 'urls.json');
    fs.writeFileSync(urlsFile, JSON.stringify(Array.from({ length: 11 }, () => REDIRECT_A)));
    const probe = jest.fn();
    const args = { 'urls-file': urlsFile, out: path.join(dir, 'out'), err: path.join(dir, 'err') };
    expect(await broker.runResolveRedirects(args, 'now', Date.now(), probe)).toBe(44);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('a longform run with Gemini research (fixture broker)', () => {
  const AGENT_ID = 'agent-article-pass';
  const gemini = (body: string) => ({ body: JSON.parse(body) });
  const openAi = (text: string) => ({ body: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
  const NOTES = '- 素材Aは1990年代に広まった。\n- 素材Bは輸入品が多い。';
  const research = groundedResponse(NOTES, [
    { text: '素材Aは1990年代に広まった。', chunks: [0] },
    { text: '素材Bは輸入品が多い。', chunks: [1] },
  ], [REDIRECT_A, REDIRECT_B]);

  async function run(redirects: Record<string, string> | null) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-article-pass-'));
    fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
    fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
    const list = normalizeSteps(examplePipeline('example-a').orchestration);
    list[0] = { ...list[0], tool: { type: 'gemini-api', label: 'Gemini' } as never };
    const plan = {
      kind: PLAN_SPEC_KIND,
      schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
      generatedAt: 1,
      agent: { id: AGENT_ID, name: 'Fallback title', autonomous: false, autonomyLevel: 'L2' },
      prompt: 'Base task',
      tool: { type: 'gemini-api', label: 'Gemini' },
      action: { type: 'draft' },
      paths: { home },
      output: { outputDir: path.join(home, 'agent-output'), outputNameTemplate: '{date}-{slug}', slug: 'longform', useGlobalOutput: true, suggestedRoots: [] },
      limits: { timeoutSeconds: 30, maxConcurrent: 2 },
      policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
      routeDecision: { route: 'cloud', toolType: 'gemini-api', toolLabel: 'Gemini', guard: 'configured-tool', why: 'test' },
      steps: { list, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, longform: true },
    };
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan));
    fs.writeFileSync(path.join(home, '.shelly/agents/.env'), "GEMINI_API_KEY='x'\nCEREBRAS_API_KEY='x'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n");
    const httpFile = path.join(home, 'fake-http.json');
    fs.writeFileSync(httpFile, JSON.stringify({
      generativelanguage: [gemini(research), gemini(JSON.stringify({ candidates: [{ content: { parts: [{ text: '# 記事\n\n素材Aは1990年代に広まった [1]。' }] }, finishReason: 'STOP' }] }))],
      'api.cerebras.ai': [openAi('VERDICT: PASS')],
    }));
    const env: Record<string, string> = { HOME: home, SHELLY_TEST_FAKE_HTTP: httpFile, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10' };
    const redirectFile = path.join(home, 'fake-redirects.json');
    if (redirects) {
      fs.writeFileSync(redirectFile, JSON.stringify(redirects));
      env.SHELLY_TEST_FAKE_REDIRECTS = redirectFile;
    }
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', fixtureBroker], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('close', resolve);
    });
    const bodies = fs.readFileSync(`${httpFile}.bodies`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const result = fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');
    const asked = redirects && fs.existsSync(`${redirectFile}.calls`) ? fs.readFileSync(`${redirectFile}.calls`, 'utf8').trim().split('\n') : [];
    return { bodies, result, asked };
  }

  it('the writer sees Google\'s markers and real links, and the draft cites them', async () => {
    const { bodies, result, asked } = await run({ [REDIRECT_A]: 'https://site-a.example/page', [REDIRECT_B]: 'https://site-b.example/page' });
    expect(asked).toEqual([REDIRECT_A, REDIRECT_B]);
    const writerPrompt = JSON.parse(bodies[1]).contents[0].parts[0].text as string;
    expect(writerPrompt).toContain('素材Aは1990年代に広まった。[1]');
    expect(writerPrompt).toContain('[1] site-1.example — https://site-a.example/page');
    expect(writerPrompt).not.toContain('grounding-api-redirect');
    // The reviewer gets the loop's rules.
    const reviewPrompt = JSON.parse(bodies[2]).messages[0].content as string;
    expect(reviewPrompt).toContain(executor.LONGFORM_REVIEW_RULES);
    expect(result).toContain('review: pass');
    expect(result).toContain('https://site-a.example/page');
    expect(result).not.toContain('転送リンク');
  }, 30000);

  it('with the lookup down, the links stay and are flagged as before', async () => {
    const { result } = await run(null);
    expect(result).toContain(REDIRECT_A);
    expect(result).toContain('転送リンク');
  }, 30000);
});
