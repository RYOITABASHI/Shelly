/**
 * Executor v70: the article structure (frames with requirements, openings,
 * closings) from the owner's article-pipelines.json entry. Every id, label and
 * instruction below is a neutral fixture; Shelly ships none.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { articlePipelineConfigError } from '@/lib/agent-pipeline-presets';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ex = require('../scripts/shelly-plan-executor.js');
const executor = path.join(__dirname, '../scripts/shelly-plan-executor.js');
const broker = path.join(__dirname, 'fixtures/fs-write-broker.js');
const agentId = 'article-structure';
const local = { type: 'local', label: 'Local LLM', model: 'fixture' };
const researchInstruction = 'Search the web and write research notes.';
const writeInstruction = 'Write the draft from the research memo.';
const reviewInstruction = 'Review the draft.';
const reviseInstruction = 'Revise the draft.';
const HEADING = '# Article structure for today (set by the pipeline)';

const LISTS = {
  population: ['pupils', 'teachers', 'mixed'],
  intervention: ['chat tutor', 'auto feedback', 'other'],
  outcome: ['achievement', 'motivation', 'other'],
  direction: ['positive', 'negative', 'null', 'mixed'],
  question: ['effect', 'mechanism', 'equity'],
};
const fpLines = (direction = 'positive') => ['population: pupils', 'intervention: auto feedback', 'outcome: achievement', `direction: ${direction}`, 'question: effect'];

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: `Label ${id}`, instruction: `Instruction for ${id}.`, ...extra });
const STRUCTURE = {
  frames: [
    item('intro'),
    item('contrast', { requires: { mainStudies: 2, facts: ['sample-size', 'result'] } }),
    item('practice', { requires: { facts: ['sample-size', 'result', 'implementation-detail'] } }),
    item('limits', { requires: { direction: ['null', 'negative'], facts: ['effect-size', 'confidence-interval', 'sample-size'] } }),
  ],
  fallback: 'intro',
  openings: [item('o-number'), item('o-question'), item('o-scene')],
  closings: [item('c-limits'), item('c-open'), item('c-next')],
};

const url = (study: string) => `https://study.example/${study}`;
const card = (study: string, label = '主研究') => [
  `${label}: Study ${study} ${url(study)}`,
  '事実: 8 trials', '事実: 4 weeks', '事実: 6 tasks', '事実: 90% accuracy', '事実: 2 groups', '事実: 30 students',
];
const memo = (fp: string[] = fpLines(), cards: string[][] = [card('a')]) => [
  ...cards.flat(),
  '比較研究:', '事実: 100 participants',
  ...fp,
].join('\n');
const draft = '# Draft title\n\nA fictional finding [1].';

type Setup = {
  entry?: Record<string, unknown>;
  history?: Record<string, unknown>[];
  savedDrafts?: { name: string; frontmatter: string }[];
  heldDrafts?: { day: string; name: string; frontmatter: string }[];
  loop?: boolean; // review + revise steps
  assembleQuality?: Record<string, unknown>;
};

function writePlan(home: string, setup: Setup) {
  const agents = path.join(home, '.shelly/agents');
  const logs = path.join(agents, 'logs');
  const outputDir = path.join(home, 'vault', 'Drafts');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(agents, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  if (setup.history) {
    fs.writeFileSync(path.join(logs, 'article-history-structure.json'), JSON.stringify({ version: 1, entries: setup.history }));
  }
  for (const d of setup.savedDrafts || []) {
    fs.writeFileSync(path.join(outputDir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
  }
  for (const d of setup.heldDrafts || []) {
    const dir = path.join(agents, 'held', d.day, 'Drafts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
  }
  const entry = { id: 'structure', outputFolder: outputDir, fingerprint: LISTS, structure: STRUCTURE, ...(setup.entry || {}) };
  for (const k of Object.keys(entry)) if ((entry as Record<string, unknown>)[k] === undefined) delete (entry as Record<string, unknown>)[k];
  fs.writeFileSync(path.join(agents, 'article-pipelines.json'), JSON.stringify({ version: 1, pipelines: [entry] }));
  const list: Record<string, unknown>[] = [
    { instruction: researchInstruction },
    { instruction: writeInstruction },
  ];
  if (setup.loop) {
    list.push({ instruction: reviewInstruction, handoff: { kind: 'review', of: [0, 1], round: 1 } });
    list.push({ instruction: reviseInstruction, handoff: { kind: 'revise', of: [0, 1, 2], round: 1 } });
  }
  list.push({
    instruction: 'Assemble draft.',
    local: { kind: 'assemble', stream: 'structure', parts: [setup.loop ? [1, 3] : [1]], reviewSteps: setup.loop ? [2] : [], footer: '', ...(setup.assembleQuality ? { quality: setup.assembleQuality } : {}) },
  });
  const planFile = path.join(agents, 'plans', `plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify({
    kind: PLAN_SPEC_KIND, schemaVersion: PLAN_SPEC_SCHEMA_VERSION, generatedAt: 1,
    agent: { id: agentId, name: 'Structure test', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Prepare an article.',
    tool: local, action: { type: 'draft' }, paths: { home },
    output: { outputDir, outputNameTemplate: '{date}-structure.md', slug: 'structure', useGlobalOutput: false, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { longform: true, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, list },
  }));
  fs.writeFileSync(path.join(agents, '.env'), `LOCAL_LLM_URL='http://127.0.0.1:9'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\nOBSIDIAN_VAULT_PATH='${path.join(home, 'vault')}'\n`);
  return { planFile, outputDir, agents };
}

const readLines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

function run(replies: string[], setup: Setup = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-article-structure-'));
  try {
    const { planFile, outputDir, agents } = writePlan(home, setup);
    const http = path.join(home, 'fake-http.json');
    fs.writeFileSync(http, JSON.stringify({
      '127.0.0.1': replies.map((content) => ({ body: { choices: [{ message: { content }, finish_reason: 'stop' }] } })),
    }));
    const result = spawnSync(process.execPath, [executor, '--plan-file', planFile, '--home', home, '--agent-id', agentId, '--broker', broker, '--unattended', '1'], {
      env: { ...process.env, HOME: home, SHELLY_TEST_FAKE_HTTP: http, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10' },
      encoding: 'utf8', timeout: 30_000,
    });
    const prompts: string[] = readLines(`${http}.bodies`).map((body) => JSON.parse(body).messages[0].content);
    const audit = readLines(path.join(agents, 'logs', agentId, 'plan-executor-audit.jsonl'));
    const savedNames = new Set((setup.savedDrafts || []).map((d) => d.name));
    const drafts = fs.readdirSync(outputDir)
      .filter((f) => f.endsWith('.md') && !savedNames.has(f))
      .map((f) => fs.readFileSync(path.join(outputDir, f), 'utf8'));
    const historyFile = path.join(agents, 'logs', 'article-history-structure.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries : [];
    const heldRoot = path.join(agents, 'held');
    const held: string[] = [];
    if (fs.existsSync(heldRoot)) {
      for (const day of fs.readdirSync(heldRoot)) {
        const dir = path.join(heldRoot, day, 'Drafts');
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if ((setup.heldDrafts || []).some((d) => d.day === day && d.name === name)) continue;
          held.push(fs.readFileSync(path.join(dir, name), 'utf8'));
        }
      }
    }
    return {
      status: result.status, stderr: result.stderr, prompts, audit, drafts, history, held,
      events: (name: string) => audit.filter((e) => e.event === name),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const frontmatterOf = (text: string) => (/^---\n([\s\S]*?)\n---/.exec(text) || ['', ''])[1];
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fm = (fields: Record<string, string>) => Object.entries({ title: '"Old"', review: 'pass', ...fields }).map(([k, v]) => `${k}: ${v}`).join('\n');
const fpObj = (direction: string) => ({ population: 'pupils', intervention: 'auto feedback', outcome: 'achievement', direction, question: 'effect' });
const normalized = () => ex.normalizeStructureConfig(STRUCTURE, ex.normalizeFingerprintConfig(LISTS));

describe('v70 structure config: executor normalize and TS validator', () => {
  const base = {
    id: 'steam', name: 'S', prompt: 'p', lang: 'ja', schedule: '0 6 * * *', outputFolder: '/vault/Drafts', footer: '',
    instructions: { research: 'r', write: 'w', review: 'v', revise: 'x' },
    engines: { research: { type: 'perplexity' }, write: { type: 'gemini-api' }, review: { type: 'groq' } },
    fingerprint: LISTS,
  };

  it('accepts a valid structure (and no structure at all)', () => {
    const lists = ex.normalizeFingerprintConfig(LISTS);
    expect(ex.normalizeStructureConfig(undefined, lists)).toBeUndefined();
    const out = ex.normalizeStructureConfig(STRUCTURE, lists);
    expect(out.fallback).toBe('intro');
    expect(out.frames.map((f: { id: string }) => f.id)).toEqual(['intro', 'contrast', 'practice', 'limits']);
    expect(out.frames[0].requires).toEqual({});
    expect(out.frames[3].requires).toEqual({ direction: ['null', 'negative'], facts: ['effect-size', 'confidence-interval', 'sample-size'] });
    expect(articlePipelineConfigError({ ...base, structure: STRUCTURE })).toBeNull();
  });

  const bad: [string, unknown, RegExp, boolean?][] = [
    ['an unknown top-level key', { ...STRUCTURE, extra: 1 }, /unknown field "extra"/],
    ['not an object', [], /structure: needs/],
    ['one frame', { ...STRUCTURE, frames: [item('intro')] }, /frames: needs a list of 2 to 8/],
    ['nine openings', { ...STRUCTURE, openings: Array.from({ length: 9 }, (_, k) => item(`o${k}`)) }, /openings: needs a list of 2 to 8/],
    ['a duplicate id', { ...STRUCTURE, closings: [item('c-a'), item('c-a')] }, /listed twice/],
    ['a bad id', { ...STRUCTURE, openings: [item('Upper'), item('o-b')] }, /\.id: use 1 to 24/],
    ['an unknown item key', { ...STRUCTURE, openings: [item('o-a', { extra: 1 }), item('o-b')] }, /unknown field "extra"/],
    ['requires on an opening', { ...STRUCTURE, openings: [item('o-a', { requires: {} }), item('o-b')] }, /unknown field "requires"/],
    ['a long label', { ...STRUCTURE, closings: [item('c-a', { label: 'x'.repeat(41) }), item('c-b')] }, /label: needs text of at most 40/],
    ['a long instruction', { ...STRUCTURE, closings: [item('c-a', { instruction: 'x'.repeat(301) }), item('c-b')] }, /instruction: needs text of at most 300/],
    ['a pipe in an instruction', { ...STRUCTURE, closings: [item('c-a', { instruction: 'a | b' }), item('c-b')] }, /instruction: needs text/],
    ['an angle bracket in a label', { ...STRUCTURE, closings: [item('c-a', { label: '<b>' }), item('c-b')] }, /label: needs text/],
    ['a newline in an instruction', { ...STRUCTURE, closings: [item('c-a', { instruction: 'a\nb' }), item('c-b')] }, /instruction: needs text/],
    ['space around a label', { ...STRUCTURE, closings: [item('c-a', { label: ' a' }), item('c-b')] }, /label: needs text/],
    ['an unknown fallback', { ...STRUCTURE, fallback: 'nope' }, /fallback: needs the id/],
    ['a fallback with requirements', { ...STRUCTURE, fallback: 'contrast' }, /fallback: "contrast" must be a frame without "requires"/],
    ['an unknown requirement', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { words: 3 } })] }, /unknown field "words"/],
    ['mainStudies 4', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { mainStudies: 4 } })] }, /mainStudies: use 1 to 3/],
    ['mainStudies 1.5', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { mainStudies: 1.5 } })] }, /mainStudies: use 1 to 3/],
    ['an unknown fact kind', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { facts: ['words'] } })] }, /facts: "words" is not one of/],
    ['an empty fact list', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { facts: [] } })] }, /facts: needs a list/],
    ['a duplicate fact kind', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { facts: ['result', 'result'] } })] }, /facts: "result" is listed twice/],
    ['a direction not in the fingerprint list', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { direction: ['sideways'] } })] }, /direction: "sideways" is not in fingerprint.direction/],
    ['an empty direction list', { ...STRUCTURE, frames: [item('intro'), item('x', { requires: { direction: [] } })] }, /direction: needs a list/],
  ];
  it.each(bad)('refuses %s', (_label, structure, message) => {
    expect(ex.normalizeStructureConfig(structure, ex.normalizeFingerprintConfig(LISTS))).toBeNull();
    expect(articlePipelineConfigError({ ...base, structure })).toMatch(message);
  });

  it('refuses a direction requirement without fingerprint lists', () => {
    expect(ex.normalizeStructureConfig(STRUCTURE, undefined)).toBeNull();
    expect(ex.normalizeStructureConfig(STRUCTURE, null)).toBeNull();
    const { fingerprint: _drop, ...noFingerprint } = base;
    expect(articlePipelineConfigError({ ...noFingerprint, structure: STRUCTURE })).toMatch(/direction: needs "fingerprint"/);
    const noDirection = { ...STRUCTURE, frames: STRUCTURE.frames.slice(0, 3) };
    expect(ex.normalizeStructureConfig(noDirection, undefined)).not.toBeNull();
    expect(articlePipelineConfigError({ ...noFingerprint, structure: noDirection })).toBeNull();
  });
});

describe('v70 structure requirements', () => {
  const unmetFor = (id: string, notes: string, direction: string | null = 'positive') => {
    const frame = normalized().frames.find((f: { id: string }) => f.id === id);
    return ex.structureFrameUnmet(frame, ex.researchStudyCards(notes), direction ? fpObj(direction) : null);
  };

  it('splits main-study cards at the next card, a comparison study or Sources, and counts distinct studies', () => {
    const notes = [
      ...card('a'), ...card('b', '主研究2'), ...card('a', 'main study'), '比較研究: other', '事実: 9 trials',
      '主研究 C: Study c (no address)', '事実: 1', 'Sources', '[1] x',
    ].join('\n');
    const cards = ex.researchStudyCards(notes);
    expect(cards.map((c: { key: string }) => c.key)).toEqual(['study.example/a', 'study.example/b', 'title:study c (no address)']);
    expect(cards[0].lines).toHaveLength(7);
    expect(cards[2].lines).toEqual(['主研究 C: Study c (no address)', '事実: 1']);
  });

  it('result is the numbers lint: six numeric fact lines and a sample line in the card', () => {
    const cards = ex.researchStudyCards(card('a').join('\n'));
    expect(ex.structureCardHasKind(cards[0], 'result')).toBe(true);
    expect(ex.researchMainNumbers(card('a').join('\n'))).toMatchObject({ numericLines: 6, sampleLines: 1 });
    const thin = ex.researchStudyCards(card('a').slice(0, 6).join('\n'));
    expect(ex.structureCardHasKind(thin[0], 'result')).toBe(false);
    const noSample = ex.researchStudyCards(card('a').join('\n').replace('30 students', '30 units'));
    expect(ex.structureCardHasKind(noSample[0], 'result')).toBe(false);
  });

  it.each([
    ['effect-size', ['事実: d = 0.42', '事実: Cohen\'s d = .3', '事実: odds ratio 1.8', '事実: 効果量 0.5', '事実: η² = 0.06'], ['事実: d was large', '事実: effect size unclear', '事実: η² was reported', '事実: 効果量は大きかった', '事実: group 2 improved', '事実: or 3 times a week', '事実: effect sizes in 2 studies', '事実: 2024年に実施']],
    ['confidence-interval', ['事実: 95% CI [0.1, 0.5]', '事実: confidence interval 0.2 to 0.4', '事実: 信頼区間 0.1–0.3'], ['事実: CI not reported', '事実: confidence interval unclear', '事実: 回答率は95%だった', '事実: 95% of students', '事実: 2024年']],
    ['sample-size', ['事実: n = 120', '事実: 300 students', '事実: 45人'], ['事実: many students', '事実: 3 classrooms']],
    ['percentage', ['事実: 12% higher', '事実: 12 パーセント'], ['事実: a higher share']],
    ['implementation-detail', ['事実: 8 weeks', '事実: 3 sessions', '事実: 2 times per week', '事実: 週2回', '事実: 3か月', '事実: 45分'], ['事実: weekly sessions', '事実: 1/3 of the class', '事実: 3分の1']],
    ['reliability', ['事実: Cronbach\'s α = .89', '事実: ICC 0.81', '事実: kappa = 0.7', '事実: 信頼性 0.9'], ['事実: reliable measure', '事実: validity was argued', '事実: reliability was high', '事実: α = .05', '事実: alpha level 0.05']],
  // gate P2-1: a metric name alone, a bare percentage, a year or an alpha level is not the value.
  ])('%s: met and unmet lines', (kind, yes, no) => {
    for (const line of yes) expect([line, ex.structureCardHasKind({ key: 'k', lines: ['主研究: x', line] }, kind)]).toEqual([line, true]);
    for (const line of no) expect([line, ex.structureCardHasKind({ key: 'k', lines: ['主研究: x', line] }, kind)]).toEqual([line, false]);
  });

  it('mainStudies counts distinct cards; facts apply to each of the first max(1, mainStudies) cards', () => {
    expect(unmetFor('contrast', memo())).toEqual(['mainStudies', 'facts:sample-size', 'facts:result']);
    expect(unmetFor('contrast', memo(fpLines(), [card('a'), card('a', '主研究2')]))).toEqual(['mainStudies', 'facts:sample-size', 'facts:result']);
    expect(unmetFor('contrast', memo(fpLines(), [card('a'), card('b', '主研究2')]))).toEqual([]);
    const thinSecond = [...card('b', '主研究2').slice(0, 2)];
    expect(unmetFor('contrast', memo(fpLines(), [card('a'), thinSecond]))).toEqual(['facts:sample-size', 'facts:result']);
    expect(unmetFor('practice', memo())).toEqual([]);
    expect(unmetFor('practice', memo().replace('4 weeks', '4 items'))).toEqual(['facts:implementation-detail']);
  });

  it('direction needs the accepted fingerprint and one of the listed values', () => {
    const limitsCard = ['主研究: Study n https://study.example/n', '事実: d = 0.02', '事実: 95% CI [-0.1, 0.1]', '事実: n = 400'];
    const notes = memo(fpLines('null'), [limitsCard]);
    expect(unmetFor('limits', notes, 'null')).toEqual([]);
    expect(unmetFor('limits', notes, 'negative')).toEqual([]);
    expect(unmetFor('limits', notes, 'positive')).toEqual(['direction']);
    expect(unmetFor('limits', notes, null)).toEqual(['direction']);
    expect(unmetFor('limits', memo(fpLines('null')), 'null')).toEqual(['facts:effect-size', 'facts:confidence-interval']);
  });
});

describe('v70 structure selection', () => {
  const cfg = () => normalized();
  const pick = (notes: string, uses: Record<string, unknown>[], direction: string | null = 'positive') =>
    ex.selectArticleStructure(cfg(), notes, direction ? fpObj(direction) : null, uses);
  const twoStudies = memo(fpLines(), [card('a'), card('b', '主研究2')]);

  it('takes never-used items first, in config order', () => {
    const s = pick(twoStudies, []);
    expect([s.frame.id, s.opening.id, s.closing.id, s.fallback]).toEqual(['intro', 'o-number', 'c-limits', false]);
    expect(s.met).toEqual(['intro', 'contrast', 'practice']);
    expect(s.unmet).toEqual({ limits: ['direction', 'facts:effect-size', 'facts:confidence-interval'] });
  });

  it('never repeats the most recent article and otherwise takes the least recently used', () => {
    const uses = [
      { date: '2026-11-20', savedAtMs: 0, frame: 'contrast', opening: 'o-question', closing: 'c-open' },
      { date: '2026-11-21', savedAtMs: 0, frame: 'practice', opening: 'o-scene', closing: 'c-next' },
      { date: '2026-11-22', savedAtMs: 0, frame: 'intro', opening: 'o-number', closing: 'c-limits' },
    ];
    const s = pick(twoStudies, uses);
    expect([s.frame.id, s.opening.id, s.closing.id, s.fallback, s.repeated]).toEqual(['contrast', 'o-question', 'c-open', false, false]);
  });

  it('decides the most recent article by date, then saved_at; a use without the field is ignored', () => {
    const uses = [
      { date: '2026-11-22', savedAtMs: 2000, frame: 'practice', opening: 'o-scene' },
      { date: '2026-11-22', savedAtMs: 1000, frame: 'intro', closing: 'c-next' },
      { date: '2026-11-21', savedAtMs: 0, frame: 'contrast' },
    ];
    expect(ex.structureLastUse(uses, 'frame').last).toBe('practice');
    expect(ex.structureLastUse(uses, 'closing').last).toBe('c-next');
    expect(ex.structureLastUse(uses, 'opening').last).toBe('o-scene');
    const s = pick(twoStudies, uses);
    expect(s.frame.id).toBe('contrast');
    expect(s.opening.id).toBe('o-number');
    expect(s.closing.id).toBe('c-limits');
  });

  it('falls back (reason requirements) when no frame but the fallback qualifies, even as a repeat', () => {
    const thin = memo(fpLines(), [card('a').slice(0, 3)]);
    const s = pick(thin, [{ date: '2026-11-22', savedAtMs: 0, frame: 'intro' }]);
    expect([s.frame.id, s.fallback, s.reason, s.repeated]).toEqual(['intro', true, 'requirements', true]);
    expect(Object.keys(s.unmet)).toEqual(['contrast', 'practice', 'limits']);
  });

  it('falls back (reason repeat) when the only qualifying frame was the last one', () => {
    const s = pick(memo(), [{ date: '2026-11-22', savedAtMs: 0, frame: 'practice' }]);
    expect([s.frame.id, s.fallback, s.reason, s.repeated]).toEqual(['intro', true, 'repeat', false]);
  });

  it('rotates to the fallback without calling it a fallback when other frames qualify too', () => {
    const s = pick(twoStudies, [
      { date: '2026-11-21', savedAtMs: 0, frame: 'practice' },
      { date: '2026-11-22', savedAtMs: 0, frame: 'contrast' },
    ]);
    expect([s.frame.id, s.fallback]).toEqual(['intro', false]);
  });

  it('builds the fixed block, with the review sentence for a review', () => {
    const s = pick(twoStudies, []);
    const write = ex.articleStructureBlock(s, 'write');
    expect(write.split('\n')).toEqual([
      HEADING, 'Frame: Label intro — Instruction for intro.', 'Opening: Label o-number — Instruction for o-number.',
      'Closing: Label c-limits — Instruction for c-limits.', ex.ARTICLE_STRUCTURE_WRITE_RULE,
    ]);
    expect(ex.articleStructureBlock(s, 'review')).toBe(`${write}\n${ex.ARTICLE_STRUCTURE_REVIEW_RULE}`);
    expect(ex.articleStructureBlock(null, 'write')).toBe('');
  });
});

describe('v70 records: frontmatter and history', () => {
  it('reads frame / opening / closing from frontmatter and history, valid ids only', () => {
    const out = ex.parseDraftFrontmatter('---\nheld: "text-lint"\ntitle: "T"\nframe: "contrast"\nopening: Bad Id\nclosing: c-open\n---\n');
    expect(out).toMatchObject({ frame: 'contrast', closing: 'c-open' });
    expect(out).not.toHaveProperty('opening');
    const entries = ex.parseArticleHistory(JSON.stringify({ version: 1, entries: [
      { title: 'A', url: url('a'), date: '2026-11-20', frame: 'intro', opening: 'o-scene', closing: 'X Y' },
    ] }));
    expect(entries).toEqual([{ title: 'A', url: url('a'), date: '2026-11-20', frame: 'intro', opening: 'o-scene' }]);
  });
});

describe('v70 article runs', () => {
  it('injects the structure into write, review and revise, not research, and records it', () => {
    const r = run([memo(), draft, 'VERDICT: REVISE\nTighten the opening.', draft], { loop: true });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    const byInstruction = (s: string) => r.prompts.filter((p) => p.includes(s));
    const research = byInstruction(researchInstruction).filter((p) => !p.includes(writeInstruction));
    expect(research).toHaveLength(1);
    expect(research[0]).not.toContain(HEADING);
    const write = byInstruction(writeInstruction)[0];
    expect(write).toContain(HEADING);
    expect(write).toContain('Frame: Label intro — Instruction for intro.');
    expect(write).not.toContain(ex.ARTICLE_STRUCTURE_REVIEW_RULE);
    const review = byInstruction(reviewInstruction)[0];
    expect(review).toContain(HEADING);
    expect(review).toContain(ex.ARTICLE_STRUCTURE_REVIEW_RULE);
    const revise = byInstruction(reviseInstruction)[0];
    expect(revise).toContain(HEADING);
    expect(revise).not.toContain(ex.ARTICLE_STRUCTURE_REVIEW_RULE);
    expect(r.events('article_structure')).toEqual([expect.objectContaining({ frame: 'intro', opening: 'o-number', closing: 'c-limits', fallback: false, met: ['intro', 'practice'] })]);
    expect(r.events('article_structure_fallback')).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    const front = frontmatterOf(r.drafts[0]).split('\n');
    const at = (key: string) => front.findIndex((l) => l.startsWith(`${key}:`));
    expect(front).toEqual(expect.arrayContaining(['frame: "intro"', 'opening: "o-number"', 'closing: "c-limits"']));
    expect(at('frame')).toBeLessThan(at('opening'));
    expect(at('closing')).toBeLessThan(at('material'));
    expect(r.history).toEqual([expect.objectContaining({ frame: 'intro', opening: 'o-number', closing: 'c-limits' })]);
  });

  it('takes the last use from the history and the drafts (today\'s included) and never repeats it', () => {
    const today = localToday();
    const r = run([memo(), draft], {
      history: [{ title: 'Old', url: url('old'), date: '2000-01-01', frame: 'practice', opening: 'o-question', closing: 'c-open' }],
      savedDrafts: [{ name: `${today}-other.md`, frontmatter: fm({ saved_at: `${today}T01:00:00.000Z`, frame: '"intro"', opening: '"o-number"', closing: '"c-limits"' }) }],
    });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    // Today's saved draft used intro; practice is the only other frame met.
    expect(r.events('article_structure')).toEqual([expect.objectContaining({ frame: 'practice', opening: 'o-scene', closing: 'c-next', fallback: false })]);
  });

  it('reads the last use from a held draft too and records a fallback', () => {
    const r = run([memo().replace('4 weeks', '4 items'), draft], {
      heldDrafts: [{ day: '2026-01-02', name: '2026-01-02-structure.md', frontmatter: `held: "text-lint"\n${fm({ saved_at: '2026-01-02T00:00:00.000Z', frame: '"intro"', opening: '"o-scene"', closing: '"c-next"' })}` }],
    });
    expect(r.events('article_structure_fallback')).toEqual([expect.objectContaining({ frame: 'intro', reason: 'requirements', repeated: true, unmet: expect.objectContaining({ practice: expect.any(Array) }) })]);
    expect(r.events('article_structure')).toEqual([expect.objectContaining({ frame: 'intro', opening: 'o-number', closing: 'c-limits', fallback: true })]);
  });

  it('records the structure on a held draft written after the selection', () => {
    const body = '# Draft title\n\nA fictional finding [1]. 検索結果は無い。';
    const r = run([memo(), body], { assembleQuality: { selfTalk: true } });
    expect(r.events('article_held')).toEqual([expect.objectContaining({ reason: 'text-lint', draftKept: true })]);
    expect(r.held).toHaveLength(1);
    expect(frontmatterOf(r.held[0])).toContain('frame: "intro"');
    expect(frontmatterOf(r.held[0])).toContain('closing: "c-limits"');
  });

  it('leaves prompts and frontmatter as before for an entry without structure, and for a malformed one (with an audit line)', () => {
    const plain = { fingerprint: undefined };
    const off = run([memo([]), draft, 'VERDICT: PASS'], { loop: true, entry: { ...plain, structure: undefined } });
    const broken = run([memo([]), draft, 'VERDICT: PASS'], { loop: true, entry: { ...plain, structure: { ...STRUCTURE, fallback: 'nope' } } });
    expect({ status: off.status, stderr: off.stderr }).toEqual({ status: 0, stderr: '' });
    expect(off.prompts.length).toBeGreaterThan(1);
    expect(broken.prompts).toEqual(off.prompts);
    for (const p of off.prompts) expect(p).not.toContain(HEADING);
    const strip = (t: string) => t.replace(/^saved_at: .*$/m, '');
    expect(broken.drafts.map(strip)).toEqual(off.drafts.map(strip));
    expect(frontmatterOf(off.drafts[0])).not.toMatch(/^(frame|opening|closing):/m);
    expect(off.history[0]).not.toHaveProperty('frame');
    expect(off.events('article_structure_config_invalid')).toEqual([]);
    expect(broken.events('article_structure_config_invalid')).toHaveLength(1);
    expect(broken.events('article_structure')).toEqual([]);
    expect(broken.events('article_held')).toEqual([]);
  });
});
