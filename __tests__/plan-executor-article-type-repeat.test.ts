/**
 * Executor v71: type-repeat demotion of article pool candidates. A saved
 * draft's history entry carries the main study's fingerprint (four axes); at
 * the pool selection a candidate matching a recent entry on enough axes is
 * offered after the others, never excluded. The vocabulary below is a
 * fixture; Shelly ships none.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ex = require('../scripts/shelly-plan-executor.js');
const executor = path.join(__dirname, '../scripts/shelly-plan-executor.js');
const broker = path.join(__dirname, 'fixtures/fs-write-broker.js');
const agentId = 'article-type-repeat';
const local = { type: 'local', label: 'Local LLM', model: 'fixture' };
const draft = '# Draft title\n\nA fictional finding [1].';

const LISTS = {
  population: ['pupils', 'teachers', 'mixed'],
  intervention: ['chat tutor', 'auto feedback', 'other'],
  outcome: ['achievement', 'motivation', 'other'],
  direction: ['positive', 'negative', 'null', 'mixed'],
  question: ['effect', 'mechanism', 'equity'],
};
type Fp = { population: string; intervention: string; outcome: string; direction: string; question?: string };
const FP_A: Fp = { population: 'pupils', intervention: 'auto feedback', outcome: 'achievement', direction: 'positive', question: 'effect' };
const FP_B: Fp = { population: 'teachers', intervention: 'chat tutor', outcome: 'motivation', direction: 'mixed', question: 'mechanism' };
const fpLines = (fp: Fp) => ['population', 'intervention', 'outcome', 'direction', 'question'].map((k) => `${k}: ${(fp as Record<string, string>)[k] || 'effect'}`);
const fourAxes = (fp: Fp) => ({ population: fp.population, intervention: fp.intervention, outcome: fp.outcome, direction: fp.direction });

const url = (study: string) => `https://study.example/${study}`;
const memo = (study: string, fp: Fp) => [
  `主研究: Study ${study} ${url(study)}`,
  '事実: 8 trials', '事実: 4 weeks', '事実: 6 tasks', '事実: 90% accuracy', '事実: 2 groups', '事実: 30 students',
  '比較研究:', '事実: 100 participants',
  ...fpLines(fp),
].join('\n');

const candidate = (id: string, fp: Fp, extra: Record<string, unknown> = {}) => ({
  id, title: `Study ${id} on fictional feedback`, url: url(id), year: 2024,
  ...fp, question: fp.question || 'effect',
  subjectTags: ['math'], sourceType: 'journal', hasNumbers: true, numbersVerified: true,
  harvestedAt: '2026-11-20T00:00:00Z', status: 'unused', ...extra,
});

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};

type HistoryEntry = { title: string; url: string; date: string; fingerprint?: unknown };
type DraftFile = { name: string; frontmatter: string };
type Setup = {
  pool: unknown; entry?: Record<string, unknown>; history?: HistoryEntry[];
  savedDrafts?: DraftFile[]; heldDrafts?: (DraftFile & { day: string })[];
  // Attended with a pinned tap and a 1 s approval timeout: the draft lands held (approval-timeout).
  heldByTimeout?: boolean;
};

const readLines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

function listHeld(agents: string): string[] {
  const root = path.join(agents, 'held');
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const day of fs.readdirSync(root)) {
    const dir = path.join(root, day, 'Drafts');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) out.push(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return out;
}

function run(replies: string[], setup: Setup) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-type-repeat-'));
  try {
    return runIn(home, replies, setup);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** One executor run in `home` (kept between runs); the audit and bodies are this run's only. */
function runIn(home: string, replies: string[], setup: Setup) {
  {
    const agents = path.join(home, '.shelly/agents');
    const logs = path.join(agents, 'logs');
    const outputDir = path.join(home, 'vault', 'Drafts');
    for (const dir of [outputDir, path.join(agents, 'plans'), path.join(home, '.shelly/tmp'), logs]) fs.mkdirSync(dir, { recursive: true });
    if (setup.history) fs.writeFileSync(path.join(logs, 'article-history-tr.json'), JSON.stringify({ version: 1, entries: setup.history }));
    for (const d of setup.savedDrafts || []) fs.writeFileSync(path.join(outputDir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
    for (const d of setup.heldDrafts || []) {
      const dir = path.join(agents, 'held', d.day, 'Drafts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
    }
    const held = !!setup.heldByTimeout;
    fs.writeFileSync(path.join(outputDir, '_pool.json'), JSON.stringify(setup.pool));
    fs.writeFileSync(path.join(agents, 'article-pipelines.json'), JSON.stringify({
      version: 1,
      pipelines: [{ id: 'tr', outputFolder: outputDir, pool: true, fingerprint: LISTS, ...(setup.entry || {}) }],
    }));
    const planFile = path.join(agents, 'plans', `plan-agent-${agentId}.json`);
    fs.writeFileSync(planFile, JSON.stringify({
      kind: PLAN_SPEC_KIND, schemaVersion: PLAN_SPEC_SCHEMA_VERSION, generatedAt: 1,
      agent: { id: agentId, name: 'Type repeat test', autonomous: false, autonomyLevel: 'L2', ...(held ? { requireActionApproval: true } : {}) },
      prompt: 'Prepare an article.',
      tool: local, action: { type: 'draft' }, paths: { home },
      output: { outputDir, outputNameTemplate: '{date}-tr.md', slug: 'tr', useGlobalOutput: false, suggestedRoots: [] },
      limits: { timeoutSeconds: 30, maxConcurrent: 2 },
      policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: !held },
      routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
      steps: { longform: true, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, list: [
        { instruction: 'Search the web and write research notes.' },
        { instruction: 'Write the draft from the research memo.' },
        { instruction: 'Assemble draft.', local: { kind: 'assemble', stream: 'tr', parts: [[1]], reviewSteps: [], footer: '' } },
      ] },
    }));
    fs.writeFileSync(path.join(agents, '.env'), `LOCAL_LLM_URL='http://127.0.0.1:9'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='${held ? 1 : 0}'\n${held ? "SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS='1'\n" : ''}OBSIDIAN_VAULT_PATH='${path.join(home, 'vault')}'\n`);
    const auditFile = path.join(logs, agentId, 'plan-executor-audit.jsonl');
    fs.rmSync(auditFile, { force: true });
    const http = path.join(home, 'fake-http.json');
    fs.rmSync(`${http}.bodies`, { force: true });
    fs.writeFileSync(http, JSON.stringify({
      '127.0.0.1': replies.map((content) => ({ body: { choices: [{ message: { content }, finish_reason: 'stop' }] } })),
    }));
    const args = [executor, '--plan-file', planFile, '--home', home, '--agent-id', agentId, '--broker', broker, ...(held ? [] : ['--unattended', '1'])];
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, HOME: home, SHELLY_TEST_FAKE_HTTP: http, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10' },
      encoding: 'utf8', timeout: 30_000,
    });
    const prompts: string[] = readLines(`${http}.bodies`).map((body) => JSON.parse(body).messages[0].content);
    const audit = readLines(auditFile);
    const historyFile = path.join(logs, 'article-history-tr.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries : [];
    const preset = new Set((setup.savedDrafts || []).map((d) => d.name));
    const drafts = fs.readdirSync(outputDir).filter((f) => f.endsWith('.md') && !preset.has(f)).map((f) => fs.readFileSync(path.join(outputDir, f), 'utf8'));
    return {
      status: result.status, stderr: result.stderr, prompts, audit, history, drafts, held: listHeld(agents),
      events: (name: string) => audit.filter((e) => e.event === name),
    };
  }
}

const poolBlockOf = (prompt: string) => prompt.slice(prompt.indexOf('# Candidate studies collected earlier'), prompt.indexOf('Consider these candidates first.'));
const withoutNonces = (text: string) => text.replace(/[0-9a-f]{16}/g, 'NONCE');
const TYPE_REPEAT = { windowDays: 14, minAxes: 3 };

describe('v71 typeRepeat config (executor)', () => {
  const entry = (typeRepeat: unknown, extra: Record<string, unknown> = {}) => ({ pool: true, fingerprint: LISTS, typeRepeat, ...extra });

  it('accepts a valid setting and is off without one', () => {
    expect(ex.normalizeTypeRepeatConfig(entry(TYPE_REPEAT))).toEqual(TYPE_REPEAT);
    expect(ex.normalizeTypeRepeatConfig(entry({ windowDays: 1, minAxes: 2 }))).toEqual({ windowDays: 1, minAxes: 2 });
    expect(ex.normalizeTypeRepeatConfig(entry({ windowDays: 60, minAxes: 4 }))).toEqual({ windowDays: 60, minAxes: 4 });
    expect(ex.normalizeTypeRepeatConfig({ pool: true, fingerprint: LISTS })).toBeUndefined();
  });

  it.each([
    ['not an object', [14, 3]],
    ['null', null],
    ['an unknown key', { ...TYPE_REPEAT, extra: 1 }],
    ['missing windowDays', { minAxes: 3 }],
    ['missing minAxes', { windowDays: 14 }],
    ['windowDays 0', { windowDays: 0, minAxes: 3 }],
    ['windowDays 61', { windowDays: 61, minAxes: 3 }],
    ['windowDays not whole', { windowDays: 14.5, minAxes: 3 }],
    ['windowDays a string', { windowDays: '14', minAxes: 3 }],
    ['minAxes 1', { windowDays: 14, minAxes: 1 }],
    ['minAxes 5', { windowDays: 14, minAxes: 5 }],
  ])('refuses %s', (_name, value) => {
    expect(ex.normalizeTypeRepeatConfig(entry(value))).toBeNull();
  });

  it('needs fingerprint and pool: true (and no queue)', () => {
    expect(ex.normalizeTypeRepeatConfig({ fingerprint: LISTS, typeRepeat: TYPE_REPEAT })).toBeNull();
    expect(ex.normalizeTypeRepeatConfig({ pool: true, typeRepeat: TYPE_REPEAT })).toBeNull();
    expect(ex.normalizeTypeRepeatConfig({ pool: true, fingerprint: { ...LISTS, question: [] }, typeRepeat: TYPE_REPEAT })).toBeNull();
    expect(ex.normalizeTypeRepeatConfig(entry(TYPE_REPEAT, { queue: true }))).toBeNull();
  });
});

describe('v71 typeRepeat config (TS loader)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { articlePipelineConfigError } = require('@/lib/agent-pipeline-presets');
  const base = {
    id: 'steam', name: 'S', prompt: 'p', lang: 'ja', schedule: '0 6 * * *', outputFolder: '/vault/Drafts', footer: '',
    instructions: { research: 'r', write: 'w', review: 'v', revise: 'x' },
    engines: { research: { type: 'perplexity' }, write: { type: 'gemini-api' }, review: { type: 'groq' } },
  };

  it('accepts a valid setting', () => {
    expect(articlePipelineConfigError({ ...base, pool: true, fingerprint: LISTS, typeRepeat: TYPE_REPEAT })).toBeNull();
    expect(articlePipelineConfigError({ ...base, pool: true, fingerprint: LISTS, typeRepeat: { windowDays: 60, minAxes: 4 } })).toBeNull();
  });

  it.each([
    [[14, 3], /typeRepeat: needs \{ "windowDays": 1-60, "minAxes": 2-4 \}/],
    [{ ...TYPE_REPEAT, extra: 1 }, /typeRepeat: unknown field "extra"/],
    [{ windowDays: 0, minAxes: 3 }, /typeRepeat\.windowDays: needs a whole number of days from 1 to 60/],
    [{ windowDays: 61, minAxes: 3 }, /typeRepeat\.windowDays/],
    [{ windowDays: 1.5, minAxes: 3 }, /typeRepeat\.windowDays/],
    [{ minAxes: 3 }, /typeRepeat\.windowDays/],
    [{ windowDays: 14, minAxes: 1 }, /typeRepeat\.minAxes: needs a whole number from 2 to 4/],
    [{ windowDays: 14, minAxes: 5 }, /typeRepeat\.minAxes/],
    [{ windowDays: 14 }, /typeRepeat\.minAxes/],
  ])('refuses %j', (value, message) => {
    expect(articlePipelineConfigError({ ...base, pool: true, fingerprint: LISTS, typeRepeat: value })).toMatch(message);
  });

  it('needs fingerprint and pool: true', () => {
    expect(articlePipelineConfigError({ ...base, typeRepeat: TYPE_REPEAT })).toMatch(/typeRepeat: needs "fingerprint"/);
    expect(articlePipelineConfigError({ ...base, fingerprint: LISTS, typeRepeat: TYPE_REPEAT })).toMatch(/typeRepeat: needs "pool": true/);
    expect(articlePipelineConfigError({ ...base, pool: false, fingerprint: LISTS, typeRepeat: TYPE_REPEAT })).toMatch(/typeRepeat: needs "pool": true/);
  });
});

describe('v71 history fingerprint and matching (pure)', () => {
  it('the history reader keeps a valid fingerprint and drops a malformed one', () => {
    const text = JSON.stringify({ version: 1, entries: [
      { title: 'A', url: url('a'), date: '2026-11-01', fingerprint: { ...FP_A } },
      { title: 'B', url: url('b'), date: '2026-11-02', fingerprint: { population: 'pupils', intervention: 'chat tutor', outcome: 'other' } },
      { title: 'C', url: url('c'), date: '2026-11-03', fingerprint: { ...fourAxes(FP_A), population: ' pupils' } },
      { title: 'D', url: url('d'), date: '2026-11-04', fingerprint: { ...fourAxes(FP_A), outcome: 'x'.repeat(41) } },
      { title: 'E', url: url('e'), date: '2026-11-05', fingerprint: 'pupils' },
      { title: 'F', url: url('f'), date: '2026-11-06', fingerprint: { ...fourAxes(FP_A), direction: 'a|b' } },
    ] });
    const entries = ex.parseArticleHistory(text);
    expect(entries.map((e: { fingerprint?: unknown }) => e.fingerprint)).toEqual([fourAxes(FP_A), undefined, undefined, undefined, undefined, undefined]);
  });

  it('counts whole local days', () => {
    expect(ex.localDateAgeDays('2026-11-12', '2026-11-26')).toBe(14);
    expect(ex.localDateAgeDays('2026-02-28', '2026-03-01')).toBe(1);
    expect(ex.localDateAgeDays('2026-11-26', '2026-11-26')).toBe(0);
    expect(Number.isNaN(ex.localDateAgeDays('', '2026-11-26'))).toBe(true);
    // gate P3-1: a day that does not exist is not rolled into the next month.
    expect(Number.isNaN(ex.localDateAgeDays('2026-11-31', '2026-12-01'))).toBe(true);
    expect(Number.isNaN(ex.localDateAgeDays('2026-02-29', '2026-03-01'))).toBe(true);
    expect(Number.isNaN(ex.localDateAgeDays('2026-13-01', '2026-12-01'))).toBe(true);
    expect(ex.localDateAgeDays('2028-02-29', '2028-03-01')).toBe(1);
  });

  it('ignores a history entry with a calendar-invalid date and compares values exactly (gate P3-1)', () => {
    const today = '2026-12-01';
    expect(ex.typeRepeatMatch(FP_A, [{ title: 'x', url: url('x'), date: '2026-11-31', fingerprint: fourAxes(FP_A) }], today, TYPE_REPEAT))
      .toEqual({ matchedAxes: 0, repeat: false });
    // A full-width variant of a value is a different value: no NFKC folding.
    const wide = (s: string) => Array.from(s).map((ch) => (/[!-~]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('');
    const widened = { population: wide(FP_A.population), intervention: wide(FP_A.intervention), outcome: wide(FP_A.outcome), direction: wide(FP_A.direction) };
    expect(ex.typeRepeatMatch(FP_A, [{ title: 'x', url: url('x'), date: today, fingerprint: widened }], today, TYPE_REPEAT))
      .toEqual({ matchedAxes: 0, repeat: false });
  });

  it('includes an entry exactly windowDays old and excludes an older or future one', () => {
    const today = '2026-11-26';
    const at = (date: string) => [{ title: 'x', url: url('x'), date, fingerprint: fourAxes(FP_A) }];
    expect(ex.typeRepeatMatch(FP_A, at('2026-11-12'), today, TYPE_REPEAT)).toEqual({ matchedAxes: 4, repeat: true });
    expect(ex.typeRepeatMatch(FP_A, at('2026-11-26'), today, TYPE_REPEAT)).toEqual({ matchedAxes: 4, repeat: true });
    expect(ex.typeRepeatMatch(FP_A, at('2026-11-11'), today, TYPE_REPEAT)).toEqual({ matchedAxes: 0, repeat: false });
    expect(ex.typeRepeatMatch(FP_A, at('2026-11-27'), today, TYPE_REPEAT)).toEqual({ matchedAxes: 0, repeat: false });
    expect(ex.typeRepeatMatch(FP_A, [{ title: 'x', url: url('x'), date: '', fingerprint: fourAxes(FP_A) }], today, TYPE_REPEAT)).toEqual({ matchedAxes: 0, repeat: false });
  });

  it('applies the minAxes boundary at 2, 3 and 4', () => {
    const today = '2026-11-26';
    const recent = (fp: Fp) => [{ title: 'x', url: url('x'), date: today, fingerprint: fourAxes(fp) }];
    const two = { ...FP_A, outcome: 'motivation', direction: 'mixed' };
    const three = { ...FP_A, direction: 'mixed' };
    for (const [fp, n] of [[two, 2], [three, 3], [FP_A, 4], [FP_B, 0]] as [Fp, number][]) {
      for (const minAxes of [2, 3, 4]) {
        expect(ex.typeRepeatMatch(fp, recent(FP_A), today, { windowDays: 14, minAxes })).toEqual({ matchedAxes: n, repeat: n >= minAxes });
      }
    }
    // question is not an axis
    expect(ex.typeRepeatMatch({ ...FP_A, question: 'equity' }, recent(FP_A), today, TYPE_REPEAT).matchedAxes).toBe(4);
  });

  it('orders repeats after the others in each group and lets the cap cut them first', () => {
    const parsed = ex.parsePool({ version: 1, candidates: [
      candidate('r1', FP_A), candidate('n1', FP_B), candidate('rc', FP_A, { numbersVerified: false }), candidate('nc', FP_B, { numbersVerified: false }),
    ] }, LISTS);
    const isRepeat = (c: { id: string }) => c.id.startsWith('r');
    const sel = ex.selectPoolCandidates(parsed.candidates, new Set(), new Set(), isRepeat);
    expect(sel.offered.map((c: { id: string }) => c.id)).toEqual(['n1', 'nc', 'r1', 'rc']);
    expect(sel.demoted.map((c: { id: string }) => c.id)).toEqual(['r1', 'rc']);
    const plain = ex.selectPoolCandidates(parsed.candidates, new Set(), new Set());
    expect(plain.offered.map((c: { id: string }) => c.id)).toEqual(['r1', 'n1', 'rc', 'nc']);
    expect(plain.demoted).toEqual([]);

    const many = ex.parsePool({ version: 1, candidates: [
      ...Array.from({ length: 6 }, (_, k) => candidate(`r${k}`, FP_A)),
      ...Array.from({ length: 10 }, (_, k) => candidate(`n${k}`, FP_B)),
    ] }, LISTS);
    const capped = ex.selectPoolCandidates(many.candidates, new Set(), new Set(), isRepeat);
    expect(capped.offered.map((c: { id: string }) => c.id)).toEqual([
      ...Array.from({ length: 10 }, (_, k) => `n${k}`), 'r0', 'r1',
    ]);
    expect(capped.demoted).toHaveLength(6);
  });

  it('marks repeat candidates in the pool block, and the block is unchanged without any', () => {
    const parsed = ex.parsePool({ version: 1, candidates: [candidate('n1', FP_B), candidate('r1', FP_A)] }, LISTS);
    const plain = ex.poolPromptBlock(parsed.candidates, 'abcdef0123456789');
    expect(ex.poolPromptBlock(parsed.candidates, 'abcdef0123456789', new Set())).toBe(plain);
    expect(plain).not.toContain('type: repeat');
    const marked = ex.poolPromptBlock(parsed.candidates, 'abcdef0123456789', new Set(['r1']));
    const r1Line = marked.indexOf(`— ${url('r1')}`);
    expect(marked.indexOf(ex.POOL_TYPE_REPEAT_LINE)).toBeGreaterThan(r1Line);
    expect(marked.split(ex.POOL_TYPE_REPEAT_LINE)).toHaveLength(2);
    expect(marked).toContain(ex.POOL_TYPE_REPEAT_RULE);
    // The mark sits inside the data fence.
    expect(marked.indexOf(ex.POOL_TYPE_REPEAT_LINE)).toBeLessThan(marked.indexOf('Consider these candidates first.'));
  });
});

describe('v71 type-repeat demotion in a run', () => {
  const recentA = (n: number): HistoryEntry => ({ title: 'Earlier article', url: url('old'), date: daysAgo(n), fingerprint: fourAxes(FP_A) });
  const pool = { version: 1, candidates: [candidate('r1', FP_A), candidate('n1', FP_B)] };

  it('offers a repeat after the others, marks it, audits it, and records the fingerprint in the history', () => {
    const r = run([memo('n1', FP_B), draft], { pool, entry: { typeRepeat: TYPE_REPEAT }, history: [recentA(3)] });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    const block = poolBlockOf(r.prompts[0]);
    expect(block.indexOf(url('n1'))).toBeGreaterThan(-1);
    expect(block.indexOf(url('n1'))).toBeLessThan(block.indexOf(url('r1')));
    expect(block.indexOf(ex.POOL_TYPE_REPEAT_LINE)).toBeGreaterThan(block.indexOf(url('r1')));
    expect(r.prompts[0]).toContain(ex.POOL_TYPE_REPEAT_RULE);
    expect(r.events('pool_type_repeat')).toEqual([expect.objectContaining({ demoted: 1, ids: ['r1'], windowDays: 14, minAxes: 3 })]);
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ offered: 2 }) })]);
    expect(r.events('research_type_repeat')).toEqual([expect.objectContaining({ matchedAxes: 0, windowDays: 14, minAxes: 3, repeat: false })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'n1' })]);
    expect(r.history).toHaveLength(2);
    expect(r.history[1]).toEqual(expect.objectContaining({ url: url('n1'), poolCandidateId: 'n1', fingerprint: fourAxes(FP_B) }));
    expect(r.history[1].fingerprint).not.toHaveProperty('question');
    expect(r.history[0].fingerprint).toEqual(fourAxes(FP_A));
  });

  it('still offers a repeat that is the only candidate, and research_type_repeat records the match', () => {
    const r = run([memo('r1', FP_A), draft], { pool: { version: 1, candidates: [candidate('r1', FP_A)] }, entry: { typeRepeat: TYPE_REPEAT }, history: [recentA(14)] });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(poolBlockOf(r.prompts[0])).toContain(ex.POOL_TYPE_REPEAT_LINE);
    expect(r.events('pool_type_repeat')).toEqual([expect.objectContaining({ demoted: 1, ids: ['r1'] })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'r1' })]);
    expect(r.events('research_type_repeat')).toEqual([expect.objectContaining({ matchedAxes: 4, repeat: true })]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).not.toContain('review_note');
  });

  it('does not demote outside the window', () => {
    const r = run([memo('n1', FP_B), draft], { pool, entry: { typeRepeat: TYPE_REPEAT }, history: [recentA(15)] });
    expect(r.status).toBe(0);
    expect(poolBlockOf(r.prompts[0])).not.toContain('type: repeat');
    expect(r.events('pool_type_repeat')).toEqual([]);
    expect(r.events('research_type_repeat')).toEqual([expect.objectContaining({ matchedAxes: 0, repeat: false })]);
  });

  it('feature off: the prompt and pool block are as before, and no type-repeat audit', () => {
    const withFp = run([memo('n1', FP_B), draft], { pool, history: [recentA(3)] });
    const { fingerprint: _drop, ...bare } = recentA(3);
    const withoutFp = run([memo('n1', FP_B), draft], { pool, history: [bare] });
    expect(withFp.status).toBe(0);
    expect(withoutNonces(withFp.prompts[0])).toBe(withoutNonces(withoutFp.prompts[0]));
    expect(poolBlockOf(withFp.prompts[0]).indexOf(url('r1'))).toBeLessThan(poolBlockOf(withFp.prompts[0]).indexOf(url('n1')));
    expect(withFp.prompts[0]).not.toContain('type: repeat');
    for (const r of [withFp, withoutFp]) {
      expect(r.events('pool_type_repeat')).toEqual([]);
      expect(r.events('research_type_repeat')).toEqual([]);
      expect(r.events('pool_type_repeat_config_invalid')).toEqual([]);
    }
    // The accepted fingerprint is history data whether or not typeRepeat is on.
    expect(withFp.history[1]).toEqual(expect.objectContaining({ fingerprint: fourAxes(FP_B) }));
  });

  it('a malformed typeRepeat is off for the run with an audit line, and holds nothing', () => {
    const r = run([memo('n1', FP_B), draft], { pool, entry: { typeRepeat: { windowDays: 0, minAxes: 3 } }, history: [recentA(3)] });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.events('pool_type_repeat_config_invalid')).toHaveLength(1);
    expect(r.events('pool_type_repeat')).toEqual([]);
    expect(r.events('research_type_repeat')).toEqual([]);
    expect(poolBlockOf(r.prompts[0])).not.toContain('type: repeat');
    expect(r.drafts).toHaveLength(1);
  });
});

describe('v71 type_axes frontmatter: saved and held drafts count (gate P3-2)', () => {
  const frontmatterOf = (text: string) => (/^---\n([\s\S]*?)\n---/.exec(text) || ['', ''])[1];
  const typeAxesLine = (fp: Fp) => `type_axes: ${JSON.stringify(fourAxes(fp))}`;
  const pool = { version: 1, candidates: [candidate('r1', FP_A), candidate('n1', FP_B)] };
  const demotesR1 = (r: ReturnType<typeof run>) => {
    const block = poolBlockOf(r.prompts[0]);
    expect(block.indexOf(url('n1'))).toBeLessThan(block.indexOf(url('r1')));
    expect(block).toContain(ex.POOL_TYPE_REPEAT_LINE);
    expect(r.events('pool_type_repeat')).toEqual([expect.objectContaining({ demoted: 1, ids: ['r1'] })]);
  };

  it('the frontmatter line is written only when a fingerprint was accepted, after the P1/P2 keys and before material', () => {
    expect(ex.typeAxesFrontmatterLines(FP_A)).toEqual([typeAxesLine(FP_A)]);
    expect(ex.typeAxesFrontmatterLines(null)).toEqual([]);
    expect(ex.typeAxesFrontmatterLines({ ...FP_A, outcome: '' })).toEqual([]);
    const r = run([memo('n1', FP_B), draft], { pool });
    expect(r.status).toBe(0);
    const fm = frontmatterOf(r.drafts[0]).split('\n');
    const at = fm.indexOf(typeAxesLine(FP_B));
    expect(at).toBeGreaterThan(fm.indexOf('poolCandidateId: "n1"'));
    expect(at).toBe(fm.findIndex((line) => line.startsWith('material:')) - 1);
    expect(ex.parseDraftFrontmatter(r.drafts[0]).typeAxes).toEqual(fourAxes(FP_B));
  });

  it('a pipeline without a fingerprint writes no type_axes line', () => {
    const r = run([`主研究: Study n1 ${url('n1')}\n事実: 8 trials\n事実: 4 weeks\n事実: 6 tasks\n事実: 90% accuracy\n事実: 2 groups\n事実: 30 students`, draft], { pool, entry: { pool: false, fingerprint: undefined } });
    expect(r.status).toBe(0);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).not.toContain('type_axes');
  });

  it('the frontmatter parser ignores a malformed type_axes', () => {
    const parse = (value: string) => ex.parseDraftFrontmatter(`---\ntitle: "t"\ntype_axes: ${value}\n---\n`).typeAxes;
    expect(parse(JSON.stringify(fourAxes(FP_A)))).toEqual(fourAxes(FP_A));
    for (const bad of [
      'pupils', '{', '[]', 'null',
      JSON.stringify({ ...fourAxes(FP_A), question: 'effect' }),
      JSON.stringify({ population: 'pupils', intervention: 'chat tutor', outcome: 'other' }),
      JSON.stringify({ ...fourAxes(FP_A), direction: ' positive' }),
      JSON.stringify({ ...fourAxes(FP_A), outcome: 'x'.repeat(41) }),
      JSON.stringify({ ...fourAxes(FP_A), population: 'a|b' }),
    ]) {
      expect(parse(bad)).toBeUndefined();
    }
  });

  it('a draft held on approval timeout carries type_axes, and the next run demotes a matching candidate', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-type-repeat-'));
    try {
      const first = runIn(home, [memo('x1', FP_A), draft], { pool: { version: 1, candidates: [] }, entry: { typeRepeat: TYPE_REPEAT }, heldByTimeout: true });
      expect(first.events('article_held')).toEqual([expect.objectContaining({ reason: 'approval-timeout', draftKept: true })]);
      expect(first.drafts).toEqual([]);
      expect(first.history).toEqual([]);
      expect(first.held).toHaveLength(1);
      expect(first.held[0]).toContain(typeAxesLine(FP_A));
      const second = runIn(home, [memo('n1', FP_B), draft], { pool, entry: { typeRepeat: TYPE_REPEAT } });
      expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });
      demotesR1(second);
      expect(second.events('research_type_repeat')).toEqual([expect.objectContaining({ matchedAxes: 0, repeat: false })]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a held draft (text-lint) in the archive counts, inside the window only', () => {
    const fm = (fp: Fp) => ['held: "text-lint"', 'title: "Earlier held"', 'review: pass', typeAxesLine(fp), 'material: ok'].join('\n');
    const recent = run([memo('n1', FP_B), draft], { pool, entry: { typeRepeat: TYPE_REPEAT }, heldDrafts: [{ day: daysAgo(14), name: `${daysAgo(14)}-tr.md`, frontmatter: fm(FP_A) }] });
    expect(recent.status).toBe(0);
    demotesR1(recent);
    const old = run([memo('n1', FP_B), draft], { pool, entry: { typeRepeat: TYPE_REPEAT }, heldDrafts: [{ day: daysAgo(15), name: `${daysAgo(15)}-tr.md`, frontmatter: fm(FP_A) }] });
    expect(old.events('pool_type_repeat')).toEqual([]);
  });

  it('a saved draft with type_axes counts (today included), and research_type_repeat sees it', () => {
    const r = run([memo('r1', FP_A), draft], {
      pool, entry: { typeRepeat: TYPE_REPEAT },
      savedDrafts: [{ name: `${daysAgo(0)}-earlier.md`, frontmatter: ['title: "Earlier saved"', 'review: pass', typeAxesLine(FP_A), 'material: ok'].join('\n') }],
    });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    demotesR1(r);
    expect(r.events('research_type_repeat')).toEqual([expect.objectContaining({ matchedAxes: 4, repeat: true })]);
  });

  it('a malformed type_axes on a draft is ignored', () => {
    const r = run([memo('n1', FP_B), draft], {
      pool, entry: { typeRepeat: TYPE_REPEAT },
      savedDrafts: [{ name: `${daysAgo(1)}-earlier.md`, frontmatter: ['title: "Earlier saved"', `type_axes: ${JSON.stringify({ ...fourAxes(FP_A), extra: 'x' })}`, 'material: ok'].join('\n') }],
    });
    expect(r.status).toBe(0);
    expect(r.events('pool_type_repeat')).toEqual([]);
    expect(poolBlockOf(r.prompts[0])).not.toContain('type: repeat');
  });
});
