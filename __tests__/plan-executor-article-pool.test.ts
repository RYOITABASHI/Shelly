/**
 * Executor v69: the article candidate pool (<outputFolder>/_pool.json) and the
 * research step's main-study fingerprint, both switched on by the owner's
 * article-pipelines.json entry. The vocabulary below is a fixture; Shelly ships
 * none.
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
const executorModule = require('../scripts/shelly-plan-executor.js');
const executor = path.join(__dirname, '../scripts/shelly-plan-executor.js');
const broker = path.join(__dirname, 'fixtures/fs-write-broker.js');
const agentId = 'article-pool';
const local = { type: 'local', label: 'Local LLM', model: 'fixture' };
const writeInstruction = 'Write the draft from the research memo.';
const draft = '# Draft title\n\nA fictional finding [1].';

const LISTS = {
  population: ['pupils', 'teachers', 'mixed'],
  intervention: ['chat tutor', 'auto feedback', 'other'],
  outcome: ['achievement', 'motivation', 'other'],
  direction: ['positive', 'negative', 'null', 'mixed'],
  question: ['effect', 'mechanism', 'equity'],
};
const FP_LINES = ['population: pupils', 'intervention: auto feedback', 'outcome: achievement', 'direction: positive', 'question: effect'];

const url = (study: string) => `https://study.example/${study}`;
const memo = (study: string, fp: string[] = FP_LINES, mainUrl = url(study)) => [
  `主研究: Study ${study} ${mainUrl}`,
  '事実: 8 trials', '事実: 4 weeks', '事実: 6 tasks', '事実: 90% accuracy', '事実: 2 groups', '事実: 30 students',
  '比較研究:', '事実: 100 participants',
  ...fp,
].join('\n');

type Candidate = Record<string, unknown>;
const candidate = (id: string, extra: Candidate = {}): Candidate => ({
  id, title: `Study ${id} on fictional feedback`, url: url(id), year: 2024,
  population: 'pupils', intervention: 'auto feedback', outcome: 'achievement', direction: 'positive', question: 'effect',
  subjectTags: ['math'], sourceType: 'journal', hasNumbers: true, numbersVerified: true,
  harvestedAt: '2026-11-20T00:00:00Z', status: 'unused', ...extra,
});

type Setup = {
  pool?: unknown; // object -> JSON, string -> raw text, undefined -> no file
  entry?: Record<string, unknown>; // pipeline entry overrides
  history?: { title: string; url: string; poolCandidateId?: string }[];
  savedDrafts?: { name: string; frontmatter: string }[];
  heldDrafts?: { day: string; name: string; frontmatter: string }[];
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
    fs.writeFileSync(path.join(logs, 'article-history-pool.json'), JSON.stringify({
      version: 1, entries: setup.history.map((e) => ({ date: '2000-01-01', ...e })),
    }));
  }
  for (const d of setup.savedDrafts || []) {
    fs.writeFileSync(path.join(outputDir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
  }
  for (const d of setup.heldDrafts || []) {
    const dir = path.join(agents, 'held', d.day, 'Drafts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, d.name), `---\n${d.frontmatter}\n---\n\nBody\n`);
  }
  if (setup.pool !== undefined) {
    fs.writeFileSync(path.join(outputDir, '_pool.json'), typeof setup.pool === 'string' ? setup.pool : JSON.stringify(setup.pool));
  }
  fs.writeFileSync(path.join(agents, 'article-pipelines.json'), JSON.stringify({
    version: 1,
    pipelines: [{ id: 'pool', outputFolder: outputDir, pool: true, fingerprint: LISTS, ...(setup.entry || {}) }],
  }));
  const planFile = path.join(agents, 'plans', `plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify({
    kind: PLAN_SPEC_KIND, schemaVersion: PLAN_SPEC_SCHEMA_VERSION, generatedAt: 1,
    agent: { id: agentId, name: 'Pool test', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Prepare an article.',
    tool: local, action: { type: 'draft' }, paths: { home },
    output: { outputDir, outputNameTemplate: '{date}-pool.md', slug: 'pool', useGlobalOutput: false, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { longform: true, budget: { maxSteps: 7, totalTimeoutMs: 30 * 60_000 }, list: [
      { instruction: 'Search the web and write research notes.' },
      { instruction: writeInstruction },
      { instruction: 'Assemble draft.', local: { kind: 'assemble', stream: 'pool', parts: [[1]], reviewSteps: [], footer: '' } },
    ] },
  }));
  fs.writeFileSync(path.join(agents, '.env'), `LOCAL_LLM_URL='http://127.0.0.1:9'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\nOBSIDIAN_VAULT_PATH='${path.join(home, 'vault')}'\n`);
  return { planFile, outputDir, agents };
}

const readLines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

function run(replies: string[], setup: Setup = {}, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-article-pool-'));
  try {
    const { planFile, outputDir, agents } = writePlan(home, setup);
    const poolFile = path.join(outputDir, '_pool.json');
    const poolBefore = fs.existsSync(poolFile) ? fs.readFileSync(poolFile) : null;
    const http = path.join(home, 'fake-http.json');
    fs.writeFileSync(http, JSON.stringify({
      '127.0.0.1': replies.map((content) => ({ body: { choices: [{ message: { content }, finish_reason: 'stop' }] } })),
    }));
    const result = spawnSync(process.execPath, [executor, '--plan-file', planFile, '--home', home, '--agent-id', agentId, '--broker', broker, '--unattended', '1'], {
      env: { ...process.env, HOME: home, SHELLY_TEST_FAKE_HTTP: http, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', ...extraEnv },
      encoding: 'utf8', timeout: 30_000,
    });
    const prompts: string[] = readLines(`${http}.bodies`).map((body) => JSON.parse(body).messages[0].content);
    const audit = readLines(path.join(agents, 'logs', agentId, 'plan-executor-audit.jsonl'));
    const savedNames = new Set((setup.savedDrafts || []).map((d) => d.name));
    const drafts = fs.readdirSync(outputDir)
      .filter((f) => f.endsWith('.md') && !savedNames.has(f))
      .map((f) => fs.readFileSync(path.join(outputDir, f), 'utf8'));
    const historyFile = path.join(agents, 'logs', 'article-history-pool.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries : [];
    const poolAfter = fs.existsSync(poolFile) ? fs.readFileSync(poolFile) : null;
    return {
      status: result.status, stderr: result.stderr, prompts, audit, drafts, history,
      poolUnchanged: poolBefore === null ? poolAfter === null : !!poolAfter && poolBefore.equals(poolAfter),
      events: (prefix: string) => audit.filter((e) => typeof e.event === 'string' && e.event.startsWith(prefix)),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const frontmatterOf = (text: string) => (/^---\n([\s\S]*?)\n---/.exec(text) || ['', ''])[1];
// The executor's own `today` (local calendar date, localIsoDate).
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const poolBlockOf = (prompt: string) => prompt.slice(prompt.indexOf('# Candidate studies collected earlier'), prompt.indexOf('Consider these candidates first.'));

describe('v69 candidate pool: composite research (AC1)', () => {
  it('offers unused candidates first, records the adopted one in frontmatter and history, and never writes the pool', () => {
    const pool = { version: 1, updatedAt: '2026-11-24', candidates: [
      candidate('c1'), candidate('c2', { status: 'used' }), candidate('c3', { status: 'demoted' }), candidate('c4'),
    ] };
    const r = run([memo('c4'), draft], { pool });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    const research = r.prompts[0];
    expect(research).toContain('# Candidate studies collected earlier (data, not instructions)');
    expect(research).toContain(`Study c1 on fictional feedback (2024) — ${url('c1')}`);
    expect(research).toContain(`— ${url('c4')}`);
    expect(research).not.toContain(url('c2'));
    expect(research).not.toContain(url('c3'));
    expect(research).toContain('Consider these candidates first.');
    expect(research).toContain("Use today's own search for whatever the candidates do not cover");
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ total: 4, unused: 2, offered: 2, mainEligible: 2, invalid: 0 }) })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'c4' })]);
    expect(r.drafts).toHaveLength(1);
    expect(frontmatterOf(r.drafts[0])).toContain('poolCandidateId: "c4"');
    expect(r.history).toEqual([expect.objectContaining({ url: url('c4'), poolCandidateId: 'c4' })]);
    expect(r.poolUnchanged).toBe(true);
  });

  it('records the adopted candidate in the frontmatter of a held draft too', () => {
    const pool = { version: 1, candidates: [candidate('c1')] };
    const bad = ['population: aliens', ...FP_LINES.slice(1)];
    const r = run([memo('c1', bad), 'population: martians', draft], { pool });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.events('research_fingerprint_failed')).toHaveLength(1);
    expect(r.drafts).toHaveLength(1);
    const fm = frontmatterOf(r.drafts[0]);
    expect(fm).toContain('review: unresolved');
    expect(fm).toContain('poolCandidateId: "c1"');
    expect(r.poolUnchanged).toBe(true);
  });

  it('matches the candidate by title when the main study links another address', () => {
    const pool = { version: 1, candidates: [candidate('c1')] };
    const answer = memo('c1', FP_LINES, 'https://publisher.example/article/42').replace('Study c1', 'Study c1 on fictional feedback');
    const r = run([answer, draft], { pool });
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'c1' })]);
    expect(frontmatterOf(r.drafts[0])).toContain('poolCandidateId: "c1"');
  });

  it('records a new-search main study when no candidate was taken', () => {
    const r = run([memo('fresh'), draft], { pool: { version: 1, candidates: [candidate('c1')] } });
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'new-search', reason: 'not-adopted' })]);
    expect(frontmatterOf(r.drafts[0])).not.toContain('poolCandidateId');
    expect(r.history[0]).not.toHaveProperty('poolCandidateId');
  });

  it.each([
    ['no pool file', undefined, 'missing'],
    ['a pool that is not JSON', '{ not json', 'not-json'],
    ['a pool of another version', { version: 2, candidates: [candidate('c1')] }, 'invalid'],
    ['a pool without a candidate list', { version: 1 }, 'invalid'],
    ['an empty pool', { version: 1, candidates: [] }, 'empty'],
    ['a pool with only used or demoted candidates', { version: 1, candidates: [candidate('c1', { status: 'used' }), candidate('c2', { status: 'demoted' })] }, 'exhausted'],
  ])('falls back to today\'s search alone, with the reason recorded, for %s', (_label, pool, reason) => {
    const r = run([memo('fresh'), draft], { pool });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.prompts[0]).not.toContain('Candidate studies collected earlier');
    expect(r.events('pool_unavailable')).toEqual([expect.objectContaining({ reason })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'new-search', reason })]);
    expect(r.events('pool_offered')).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.poolUnchanged).toBe(true);
  });

  it('skips malformed candidates (unlisted value, missing field) and counts them', () => {
    const pool = { version: 1, candidates: [
      candidate('bad1', { population: 'aliens' }), candidate('bad2', { numbersVerified: undefined }), candidate('ok1'),
    ] };
    const r = run([memo('ok1'), draft], { pool });
    expect(r.prompts[0]).not.toContain(url('bad1'));
    expect(r.prompts[0]).toContain(url('ok1'));
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ invalid: 2, offered: 1 }) })]);
  });

  it('records why a pool asked for without valid fingerprint lists is not used', () => {
    const r = run([memo('fresh'), draft], { pool: { version: 1, candidates: [candidate('c1')] }, entry: { fingerprint: undefined } });
    expect(r.events('pool_unavailable')).toEqual([expect.objectContaining({ reason: 'config' })]);
    expect(r.prompts[0]).not.toContain('Candidate studies collected earlier');
  });
});

describe('v69 candidate pool: selection-time exclusion (brief 2)', () => {
  it('leaves out candidates a saved draft, a held draft or the history already used, and studies the history holds', () => {
    const pool = { version: 1, candidates: ['u1', 'u2', 'u3', 'u4', 'ok'].map((id) => candidate(id)) };
    const r = run([memo('ok'), draft], {
      pool,
      savedDrafts: [{ name: '2000-01-02-pool.md', frontmatter: 'title: "Saved"\npoolCandidateId: "u1"' }],
      heldDrafts: [{ day: '2000-01-03', name: '2000-01-03-pool.md', frontmatter: 'title: "Held"\npoolCandidateId: u2' }],
      history: [
        { title: 'Earlier', url: 'https://elsewhere.example/x', poolCandidateId: 'u3' },
        { title: 'Same study', url: url('u4') },
      ],
    });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    // The history block names u4's address on its own; the candidate block must not.
    const poolBlock = r.prompts[0].slice(r.prompts[0].indexOf('# Candidate studies collected earlier'), r.prompts[0].indexOf('Consider these candidates first.'));
    for (const id of ['u1', 'u2', 'u3', 'u4']) expect(poolBlock).not.toContain(url(id));
    expect(poolBlock).toContain(url('ok'));
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ unused: 5, excludedUsed: 3, excludedHistory: 1, offered: 1 }) })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'ok' })]);
  });

  it('leaves out candidates named by a draft saved or held today (fix round 1, B1)', () => {
    const today = localToday();
    const pool = { version: 1, candidates: ['t1', 't2', 'ok'].map((id) => candidate(id)) };
    const r = run([memo('ok'), draft], {
      pool,
      savedDrafts: [{ name: `${today}-earlier.md`, frontmatter: 'title: "Saved today"\npoolCandidateId: "t1"' }],
      heldDrafts: [{ day: today, name: `${today}-held.md`, frontmatter: 'title: "Held today"\npoolCandidateId: t2' }],
    });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    const poolBlock = poolBlockOf(r.prompts[0]);
    expect(poolBlock).not.toContain(url('t1'));
    expect(poolBlock).not.toContain(url('t2'));
    expect(poolBlock).toContain(url('ok'));
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ unused: 3, excludedUsed: 2, offered: 1 }) })]);
    // Today's titles stay out of the previously-covered block, as before.
    expect(r.prompts[0]).not.toContain('Saved today');
    expect(r.prompts[0]).not.toContain('Held today');
  });

  it('offers a main-eligible candidate even when comparison-only ones fill the cap (fix round 1, B5)', () => {
    const cap = executorModule.POOL_PROMPT_MAX_CANDIDATES as number;
    const comparison = Array.from({ length: cap }, (_v, n) => candidate(`cmp${n}`, { numbersVerified: false }));
    const pool = { version: 1, candidates: [...comparison, candidate('main1')] };
    const r = run([memo('main1'), draft], { pool });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    const poolBlock = poolBlockOf(r.prompts[0]);
    expect(poolBlock).toContain(url('main1'));
    expect(r.events('pool_offered')).toEqual([expect.objectContaining({ counts: expect.objectContaining({ unused: cap + 1, offered: cap, mainEligible: 1 }) })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'main1' })]);
  });

  it('keeps file order and fills the rest with comparison-only candidates (fix round 1, B5)', () => {
    const cands = [
      { id: 'a', mainAllowed: false, status: 'unused', url: url('a') },
      { id: 'b', mainAllowed: true, status: 'unused', url: url('b') },
      { id: 'c', mainAllowed: false, status: 'unused', url: url('c') },
    ];
    const sel = executorModule.selectPoolCandidates(cands, new Set(), new Set());
    expect(sel.offered.map((c: { id: string }) => c.id)).toEqual(['a', 'b', 'c']);
    expect(sel.counts).toEqual(expect.objectContaining({ offered: 3, mainEligible: 1 }));
  });

  it('falls back with reason exhausted when the records used every unused candidate', () => {
    const r = run([memo('fresh'), draft], {
      pool: { version: 1, candidates: [candidate('u1')] },
      history: [{ title: 'Earlier', url: 'https://elsewhere.example/x', poolCandidateId: 'u1' }],
    });
    expect(r.events('pool_unavailable')).toEqual([expect.objectContaining({ reason: 'exhausted', counts: expect.objectContaining({ excludedUsed: 1 }) })]);
  });
});

describe('v69 main-study fingerprint (brief 3)', () => {
  const noteOf = (text: string) => (/review_note: (".*")/.exec(frontmatterOf(text)) || [])[1];

  it('tells the research step the five fields and their closed lists', () => {
    const r = run([memo('fresh'), draft], { entry: { pool: false } });
    expect(r.prompts[0]).toContain('# Main study fingerprint (required)');
    expect(r.prompts[0]).toContain('population: one of pupils / teachers / mixed');
    expect(r.prompts[0]).toContain('direction: one of positive / negative / null / mixed');
    expect(r.events('research_fingerprint')).toEqual([expect.objectContaining({ event: 'research_fingerprint', retried: false, values: expect.objectContaining({ population: 'pupils', question: 'effect' }) })]);
    expect(r.prompts).toHaveLength(2);
    expect(noteOf(r.drafts[0]) || '').not.toContain('主研究の指紋');
  });

  it('asks once more for a missing field, and the valid re-output stands', () => {
    const r = run([memo('fresh', FP_LINES.slice(0, 4)), FP_LINES.join('\n'), draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint')).toEqual([
      expect.objectContaining({ event: 'research_fingerprint_invalid', attempt: 1, problems: ['question: missing'] }),
      expect.objectContaining({ event: 'research_fingerprint_retry', attempt: 2 }),
      expect.objectContaining({ event: 'research_fingerprint', retried: true }),
    ]);
    expect(r.prompts).toHaveLength(3);
    expect(r.prompts[1]).toContain('Classify that main study.');
    expect(r.prompts[1]).toContain('The last answer could not be used: question: missing.');
    expect(r.prompts[1]).toContain('主研究: Study fresh');
    expect(r.prompts[2]).toContain(writeInstruction);
    // The writer gets the corrected fingerprint in the research notes (B3).
    expect(r.prompts[2]).toContain('question: effect');
    expect(noteOf(r.drafts[0]) || '').not.toContain('主研究の指紋');
  });

  it('hands the writer the corrected fingerprint, not the out-of-list one (fix round 1, B3)', () => {
    const bad = ['population: aliens', ...FP_LINES.slice(1)];
    const r = run([memo('fresh', bad), FP_LINES.join('\n'), draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true }));
    const write = r.prompts[2];
    expect(write).toContain(writeInstruction);
    expect(write).not.toContain('population: aliens');
    for (const line of FP_LINES) expect(write).toContain(line);
    expect(write).toContain('主研究: Study fresh');
    expect(executorModule.parseFingerprint(write, LISTS).ok).toBe(true);
  });

  it('hands the writer the accepted fingerprint when the notes end in a Sources section (fix round 2, B3)', () => {
    const notes = [memo('fresh', []), '', '## Sources', `[1] Study fresh — ${url('fresh')}`, ...FP_LINES.slice(0, 4)].join('\n');
    const r = run([notes, FP_LINES.join('\n'), draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true }));
    const write = r.prompts[2];
    expect(write).toContain(writeInstruction);
    for (const line of FP_LINES) expect(write).toContain(line);
    expect(executorModule.parseFingerprint(write, LISTS).ok).toBe(true);
  });

  it('hands the writer an accepted full-width value as it is, never folded (fix round 2, B3)', () => {
    const lists = { ...LISTS, population: [...LISTS.population, 'Ａ群'] };
    const r = run([memo('fresh', FP_LINES.slice(1)), ['population: Ａ群', ...FP_LINES.slice(1)].join('\n'), draft], { entry: { pool: false, fingerprint: lists } });
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true, values: expect.objectContaining({ population: 'Ａ群' }) }));
    const write = r.prompts[2];
    expect(write).toContain('population: Ａ群');
    expect(write).not.toContain('population: A群');
    expect(executorModule.parseFingerprint(write, lists).ok).toBe(true);
  });

  it('never cites an address that only a rejected fingerprint line names (fix round 3)', () => {
    const rejected = 'https://rejected.example/only-in-fingerprint';
    const notes = memo('fresh', [`population: ${rejected}`, ...FP_LINES.slice(1)]);
    const r = run([notes, FP_LINES.join('\n'), draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true }));
    // The re-output still saw the notes as they were.
    expect(r.prompts[1]).toContain(rejected);
    const write = r.prompts[2];
    expect(write).toContain(writeInstruction);
    expect(write).not.toContain('rejected.example');
    expect(write).toContain(url('fresh'));
    for (const line of FP_LINES) expect(write).toContain(line);
    expect(r.drafts.join('\n')).not.toContain('rejected.example');
    expect(r.events('research_note_urls_added').flatMap((e) => e.hosts || [])).not.toContain('rejected.example');
  });

  it('still asks once more with less than 12 minutes left (fix round 1, B4)', () => {
    const r = run([memo('fresh', FP_LINES.slice(0, 4)), FP_LINES.join('\n'), draft], { entry: { pool: false } }, { SHELLY_PLAN_EXECUTOR_RUN_CEILING_MS: String(10 * 60_000) });
    expect(r.events('research_fingerprint_retry')).toHaveLength(1);
    expect(r.events('research_fingerprint_failed')).toEqual([]);
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true }));
  });

  it('holds without asking only when less time is left than the re-output needs (fix round 1, B4)', () => {
    const r = run([memo('fresh', FP_LINES.slice(0, 4)), draft], { entry: { pool: false } }, { SHELLY_PLAN_EXECUTOR_RUN_CEILING_MS: String(100_000) });
    expect(r.events('research_fingerprint_retry')).toEqual([]);
    expect(r.events('research_fingerprint_failed')).toEqual([expect.objectContaining({ reason: 'time' })]);
  });

  it('holds the draft with the reason when the re-output is still invalid', () => {
    const bad = ['population: aliens', ...FP_LINES.slice(1)];
    const r = run([memo('fresh', bad), 'population: martians\nintervention: chat tutor', draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint_invalid').map((e) => [e.attempt, e.problems])).toEqual([
      [1, ['population: not allowed']],
      [2, ['population: not allowed', 'outcome: missing', 'direction: missing', 'question: missing']],
    ]);
    expect(r.events('research_fingerprint_failed')).toEqual([expect.objectContaining({ reason: 'still-invalid' })]);
    expect(r.prompts).toHaveLength(3);
    expect(r.drafts).toHaveLength(1);
    const fm = frontmatterOf(r.drafts[0]);
    expect(fm).toContain('review: unresolved');
    expect(noteOf(r.drafts[0])).toContain('主研究の指紋が不正（population: 語彙外、outcome: 欠落、direction: 欠落、question: 欠落）');
  });

  it('treats two different values for one field as invalid', () => {
    const r = run([memo('fresh', [...FP_LINES, 'direction: negative']), FP_LINES.join('\n'), draft], { entry: { pool: false } });
    expect(r.events('research_fingerprint_invalid')).toEqual([expect.objectContaining({ problems: ['direction: conflicting'] })]);
    expect(r.events('research_fingerprint')).toContainEqual(expect.objectContaining({ event: 'research_fingerprint', retried: true }));
  });

  it('holds the draft when the fingerprint lists themselves are malformed', () => {
    const r = run([memo('fresh'), draft], { entry: { pool: false, fingerprint: { population: ['pupils'] } } });
    expect(r.events('research_fingerprint_config_invalid')).toHaveLength(1);
    expect(noteOf(r.drafts[0])).toContain('主研究の指紋が不正（設定が不正）');
  });

  it('changes nothing for a pipeline without fingerprint lists or pool', () => {
    const r = run([memo('fresh', []), draft], { entry: { pool: undefined, fingerprint: undefined } });
    expect(r.prompts[0]).not.toContain('Main study fingerprint');
    expect(r.events('research_fingerprint')).toEqual([]);
    expect(r.events('pool_')).toEqual([]);
    expect(noteOf(r.drafts[0]) || '').not.toContain('主研究の指紋');
  });
});

describe('v69 quality bar: unverified numbers (AC5)', () => {
  it('offers an unverified candidate only as a comparison and retries a main study that is one', () => {
    const pool = { version: 1, candidates: [candidate('unv', { numbersVerified: false }), candidate('ver')] };
    const r = run([memo('unv'), memo('ver'), draft], { pool });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.prompts[0]).toContain('main: no (numbers not verified: comparison only, without its numbers)');
    expect(r.events('pool_unverified_main')).toEqual([expect.objectContaining({ attempt: 1, candidateId: 'unv' })]);
    expect(r.events('research_numbers_retry')).toEqual([expect.objectContaining({ attempt: 2, excluded: 1 })]);
    expect(r.prompts[1]).toContain(`- Study unv on fictional feedback — ${url('unv')}`);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'ver' })]);
    expect(frontmatterOf(r.drafts[0])).toContain('poolCandidateId: "ver"');
  });

  it('stops before writing when every retry still names the unverified candidate', () => {
    const pool = { version: 1, candidates: [candidate('unv', { numbersVerified: false })] };
    const r = run([memo('unv'), memo('unv'), memo('unv')], { pool });
    expect(r.events('pool_unverified_main').map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(r.events('research_numbers_exhausted')).toHaveLength(1);
    expect(r.prompts.every((p) => !p.includes(writeInstruction))).toBe(true);
    expect(r.drafts).toEqual([]);
  });

  it('keeps the numbers lint for a pool candidate as for any main study', () => {
    const pool = { version: 1, candidates: [candidate('c1'), candidate('c2')] };
    const thin = memo('c1').replace('事実: 30 students\n', '');
    const r = run([thin, memo('c2'), draft], { pool });
    expect(r.events('research_numbers_insufficient')).toEqual([expect.objectContaining({ attempt: 1 })]);
    expect(r.events('pool_selection')).toEqual([expect.objectContaining({ mode: 'pool', candidateId: 'c2' })]);
  });
});

describe('v69 pure helpers', () => {
  it('normalizes fingerprint lists strictly', () => {
    expect(executorModule.normalizeFingerprintConfig(undefined)).toBeUndefined();
    expect(executorModule.normalizeFingerprintConfig(LISTS)).toEqual(LISTS);
    expect(executorModule.normalizeFingerprintConfig({ ...LISTS, extra: ['x'] })).toBeNull();
    expect(executorModule.normalizeFingerprintConfig({ ...LISTS, outcome: [] })).toBeNull();
    expect(executorModule.normalizeFingerprintConfig({ ...LISTS, outcome: ['a', 'a'] })).toBeNull();
    expect(executorModule.normalizeFingerprintConfig({ ...LISTS, outcome: [' a'] })).toBeNull();
  });

  it('parses fingerprint lines with field-name markup and full-width colons', () => {
    const text = ['- **population**：pupils', '* intervention:  auto feedback ', 'outcome: achievement', 'Direction: positive', 'question = effect'].join('\n');
    expect(executorModule.parseFingerprint(text, LISTS)).toEqual({ ok: true, problems: [], values: {
      population: 'pupils', intervention: 'auto feedback', outcome: 'achievement', direction: 'positive', question: 'effect',
    } });
  });

  it('matches a value only exactly as configured, never reshaped (fix round 1, B2)', () => {
    const one = (v: string) => ({ population: [v], intervention: ['i'], outcome: ['o'], direction: ['d'], question: ['q'] });
    const lines = (v: string) => [`population: ${v}`, 'intervention: i', 'outcome: o', 'direction: d', 'question: q'].join('\n');
    expect(executorModule.normalizeFingerprintConfig(one('valid.'))).toEqual(one('valid.'));
    // The gate's reproduction: `valid.` against `valid`, and the reverse.
    expect(executorModule.parseFingerprint(lines('valid.'), one('valid'))).toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    expect(executorModule.parseFingerprint(lines('valid.'), one('valid.'))).toEqual(expect.objectContaining({ ok: true, values: expect.objectContaining({ population: 'valid.' }) }));
    expect(executorModule.parseFingerprint(lines('valid'), one('valid.'))).toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    for (const v of ['`valid`', '**valid**', '"valid"', 'valid。', 'VALID', 'ｖａｌｉｄ']) {
      expect(executorModule.parseFingerprint(lines(v), one('valid'))).toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    }
  });

  it('never accepts a value that reasoning-tag removal joined together (fix round 2, B2)', () => {
    const fields = ['population', 'intervention', 'outcome', 'direction', 'question'];
    const lists = Object.fromEntries(fields.map((f) => [f, ['valid']]));
    // The gate's reproduction.
    const probe = fields.map((f) => `${f}: ${f === 'population' ? 'va<think>aside</think>lid' : 'valid'}`).join('\n');
    expect(executorModule.parseFingerprint(probe, lists)).toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    const others = fields.slice(1).map((f) => `${f}: valid`);
    for (const line of ['population: valid<think>x</think>', 'population: <think>x</think>valid', 'population: valid</think>', 'population: valid<think>']) {
      expect(executorModule.parseFingerprint([line, ...others].join('\n'), lists)).toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    }
    // A tag spanning lines taints the value line it starts on.
    expect(executorModule.parseFingerprint(['population: valid<think>', 'aside', '</think>', ...others].join('\n'), lists))
      .toEqual(expect.objectContaining({ ok: false, problems: ['population: not allowed'] }));
    // Reasoning on lines of its own is still ignored, fingerprint lines inside it too.
    expect(executorModule.parseFingerprint(['<think>', 'population: other', '</think>', 'population: valid', ...others].join('\n'), lists))
      .toEqual(expect.objectContaining({ ok: true, values: expect.objectContaining({ population: 'valid' }) }));
  });

  it('puts the accepted fingerprint back before a Sources section, values verbatim (fix round 2, B3)', () => {
    const values = { population: 'Ａ群', intervention: 'auto feedback', outcome: 'achievement', direction: 'positive', question: 'effect' };
    const block = ['population: Ａ群', 'intervention: auto feedback', 'outcome: achievement', 'direction: positive', 'question: effect'].join('\n');
    expect(executorModule.notesWithFingerprint('Notes\npopulation: aliens\n\n## Sources\n[1] x\nquestion: effect', values))
      .toBe(`Notes\n${block}\n\n## Sources\n[1] x`);
    expect(executorModule.notesWithFingerprint('Notes\n\n', values)).toBe(`Notes\n${block}`);
  });

  it('drops from text-read sources an address only fingerprint lines name, and renumbers the rest (fix round 3)', () => {
    const text = [
      'Notes citing [1] and [2].',
      'population: https://rejected.example/a',
      '',
      '## Sources',
      '[1] Kept — https://kept.example/one',
      'intervention: https://rejected.example/b',
      '[2] Also kept — https://kept.example/two',
    ].join('\n');
    const parsed = executorModule.extractSourcesFromText(text);
    expect(parsed.sources.map((s: { url: string }) => s.url)).toEqual(expect.arrayContaining(['https://rejected.example/b']));
    const out = executorModule.withoutFingerprintOnlySources(text, parsed);
    expect(out.sources.map((s: { url: string }) => s.url)).toEqual(['https://kept.example/one', 'https://kept.example/two']);
    expect(out.sources.map((s: { id: number }) => s.id)).toEqual([1, 2]);
    expect(out.indexMap[1]).toBe(1);
    expect(out.indexMap[2]).toBe(2);
    // An address the rest of the notes also names stays.
    const shared = `${text}\nSee also https://rejected.example/b`;
    const kept = executorModule.withoutFingerprintOnlySources(shared, executorModule.extractSourcesFromText(shared));
    expect(kept.sources.map((s: { url: string }) => s.url)).toContain('https://rejected.example/b');
  });

  it('keeps a source a rejected fingerprint line names in another form (http, tracking parameters) when a normal line names it (gate P1-1)', () => {
    const text = [
      'Notes citing [1] and [2].',
      'population: http://www.shared.example/study?utm_source=feed',
      'See https://shared.example/study for the trial.',
      '',
      '## Sources',
      '[1] Kept — https://kept.example/one',
      '[2] Shared — https://shared.example/study',
      'intervention: http://only-fp.example/x?utm_medium=mail',
    ].join('\n');
    const parsed = executorModule.extractSourcesFromText(text);
    const out = executorModule.withoutFingerprintOnlySources(text, parsed);
    expect(out.sources.map((s: { url: string }) => s.url)).toEqual(['https://kept.example/one', 'https://shared.example/study']);
    expect(out.sources.map((s: { id: number }) => s.id)).toEqual([1, 2]);
    expect(out.indexMap[1]).toBe(1);
    expect(out.indexMap[2]).toBe(2);
    // The address only a fingerprint line gives (http + a tracking parameter) was read as a source and is dropped.
    expect(parsed.sources.map((s: { url: string }) => s.url).some((u: string) => u.includes('only-fp.example'))).toBe(true);
    expect(out.sources.map((s: { url: string }) => s.url).some((u: string) => u.includes('only-fp.example'))).toBe(false);
  });

  describe('the pool file is read through the descriptor it was opened on (gate P1-1)', () => {
    const posix = process.platform !== 'win32';
    let vault: string;
    let dir: string;
    let file: string;
    const pool = JSON.stringify({ version: 1, candidates: [] });
    beforeEach(() => {
      vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-pool-read-')));
      dir = path.join(vault, 'Drafts');
      fs.mkdirSync(dir);
      file = path.join(dir, executorModule.POOL_FILE_NAME);
    });
    afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

    it('reads a plain file', () => {
      fs.writeFileSync(file, pool);
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'ok', data: { version: 1, candidates: [] } });
    });

    (posix ? it : it.skip)('refuses a symbolic link', () => {
      const outside = path.join(vault, 'outside.json');
      fs.writeFileSync(outside, pool);
      fs.symlinkSync(outside, file);
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'unreadable' });
    });

    it('refuses a hard link', () => {
      const outside = path.join(vault, 'outside.json');
      fs.writeFileSync(outside, pool);
      fs.linkSync(outside, file);
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'unreadable' });
    });

    it('refuses a directory', () => {
      fs.mkdirSync(file);
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'unreadable' });
    });

    (posix ? it : it.skip)('refuses a FIFO without blocking', () => {
      expect(spawnSync('mkfifo', [file]).status).toBe(0);
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'unreadable' });
    });

    it('refuses a file over the size limit', () => {
      fs.writeFileSync(file, Buffer.alloc(executorModule.POOL_MAX_BYTES + 1, 0x20));
      expect(executorModule.readPoolFile(vault, dir)).toEqual({ status: 'too-large' });
    });

    it('reads nothing when the file opened is not the one lstat saw (a swap)', () => {
      fs.writeFileSync(file, pool);
      const other = path.join(dir, 'other.json');
      fs.writeFileSync(other, pool);
      const seen = fs.lstatSync(other);
      expect(executorModule.readPoolBytes(file, seen, dir, executorModule.POOL_MAX_BYTES, fs)).toEqual({ status: 'unreadable' });
    });

    it('reads nothing when the descriptor sits outside the output folder', () => {
      fs.writeFileSync(file, pool);
      const st = fs.lstatSync(file);
      const elsewhere = { ...fs, readlinkSync: (p: string) => (String(p).startsWith('/proc/self/fd/') ? path.join(vault, 'elsewhere', '_pool.json') : fs.readlinkSync(p)), realpathSync: (p: string) => String(p) };
      expect(executorModule.readPoolBytes(file, st, dir, executorModule.POOL_MAX_BYTES, elsewhere)).toEqual({ status: 'unreadable' });
    });
  });

  it('a pool pipeline config is validated by the TS loader too', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { articlePipelineConfigError } = require('@/lib/agent-pipeline-presets');
    const base = {
      id: 'steam', name: 'S', prompt: 'p', lang: 'ja', schedule: '0 6 * * *', outputFolder: '/vault/Drafts', footer: '',
      instructions: { research: 'r', write: 'w', review: 'v', revise: 'x' },
      engines: { research: { type: 'perplexity' }, write: { type: 'gemini-api' }, review: { type: 'groq' } },
    };
    expect(articlePipelineConfigError({ ...base, pool: true, fingerprint: LISTS })).toBeNull();
    expect(articlePipelineConfigError({ ...base, fingerprint: LISTS })).toBeNull();
    expect(articlePipelineConfigError({ ...base, pool: true })).toMatch(/pool: needs "fingerprint"/);
    expect(articlePipelineConfigError({ ...base, pool: true, fingerprint: LISTS, queue: true })).toMatch(/pool: not with "queue"/);
    expect(articlePipelineConfigError({ ...base, pool: 'yes', fingerprint: LISTS })).toMatch(/pool: needs true or false/);
    expect(articlePipelineConfigError({ ...base, fingerprint: { ...LISTS, extra: ['a'] } })).toMatch(/unknown field "extra"/);
    expect(articlePipelineConfigError({ ...base, fingerprint: { ...LISTS, question: [] } })).toMatch(/question: needs a list/);
    expect(articlePipelineConfigError({ ...base, fingerprint: { ...LISTS, question: ['a|b'] } })).toMatch(/question: each value/);
  });
});
