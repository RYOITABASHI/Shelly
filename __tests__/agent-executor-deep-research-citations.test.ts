/**
 * Build 2603 on-device regression (2026-10-16): a scheduled single-step
 * Perplexity agent pinned to sonar-deep-research saved a note citing
 * [54] [46] [63] while the appended "## Sources" list (built by the generated
 * script's extract_ai_content, the legacy .sh path every non-orchestrated
 * unattended run takes) only held [1]..[20] — the extractor listed just the
 * first 20 citation slots and never touched the content's markers.
 *
 * v70: every marker left in the body must resolve to a listed source — cited
 * sources are always listed (in order of first use, renumbered compactly),
 * uncited extras stay capped at 20, unresolvable markers are removed. Both the
 * node extractor and the python3 fallback are exercised.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { extractSourcesFromText } from '@/lib/agent-sources';
import type { Agent } from '@/store/types';

const agent: Agent = {
  id: 'deep-research',
  name: 'LLM papers',
  description: '',
  prompt: 'research the latest LLM papers with Perplexity and summarize 3 of them in English.',
  schedule: null,
  tool: { type: 'perplexity', model: 'sonar-deep-research' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
};

function extractHeredoc(script: string, marker: string): string {
  const start = script.indexOf('extract_ai_content() {');
  const body = script.slice(start);
  return body.split(`<<'${marker}'\n`)[1].split(`\n${marker}\n`)[0];
}

// 65 citations, as sonar-deep-research returns; slot 7 repeats slot 54's URL
// (alias), slot 30 is unusable. Titles/dates come from search_results.
const citations: string[] = [];
for (let i = 1; i <= 65; i++) citations.push(`https://arxiv.org/abs/2610.${String(10000 + i)}`);
citations[6] = citations[53];
citations[29] = 'not-a-url';
const searchResults = citations
  .filter((u) => u.startsWith('https://'))
  .map((u) => ({ title: `Paper ${u.slice(-5)}`, url: u, date: '2026-10-15' }));

const CONTENT = [
  '# Latest LLM papers',
  '',
  '| Paper | Link |',
  '|---|---|',
  '| Alpha [54] | [arXiv](https://arxiv.org/abs/2610.10054) |',
  '| Beta [46][63] | [arXiv](https://arxiv.org/abs/2610.10046) |',
  '',
  'Alpha scales reasoning [54][7]. Beta adds memory [46, 63]. A broken ref [30] and an out-of-range ref [99].',
  'Gamma follows Alpha [54] [54].',
].join('\n');

const RESPONSE = JSON.stringify({
  choices: [{ message: { content: CONTENT } }],
  citations,
  search_results: searchResults,
});

function body(out: string): string {
  return out.split('\n\n## Sources\n')[0];
}

function assertEveryMarkerResolves(out: string, checkChainReader = true): void {
  expect(out).toContain('\n\n## Sources\n');
  const listed = out.split('\n\n## Sources\n')[1].split('\n');
  const numbers = listed.map((l) => parseInt(/^\[(\d+)\]/.exec(l)![1], 10));
  // compact 1..N numbering, no alias lines
  expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  const markers = Array.from(body(out).matchAll(/\[(\d{1,3})\](?!\()/g)).map((m) => parseInt(m[1], 10));
  expect(markers.length).toBeGreaterThan(0);
  for (const n of markers) expect(numbers).toContain(n);
  // the attended-chain reader (extractSourcesFromText, itself capped at
  // MAX_CHAIN_SOURCES and dropping markers past it) agrees
  if (!checkChainReader) return;
  const parsed = extractSourcesFromText(out);
  for (const n of markers) expect(parsed.indexMap[n]).toBeGreaterThan(0);
}

function checkOutput(out: string): void {
  assertEveryMarkerResolves(out);
  const b = body(out);
  // [54]→[1], [46]→[2], [63]→[3]; [7] aliases [54] and collapses; [30]/[99] dropped
  expect(b).toContain('| Alpha [1] |');
  expect(b).toContain('| Beta [2][3] |');
  expect(b).toContain('Alpha scales reasoning [1]. Beta adds memory [2][3]. A broken ref and an out-of-range ref.');
  expect(b).toContain('Gamma follows Alpha [1].');
  // markdown links untouched
  expect(b).toContain('[arXiv](https://arxiv.org/abs/2610.10054)');
  const lines = out.split('\n\n## Sources\n')[1].split('\n');
  expect(lines[0]).toBe('[1] Paper 10054 — https://arxiv.org/abs/2610.10054 (2026-10-15)');
  expect(lines[1]).toBe('[2] Paper 10046 — https://arxiv.org/abs/2610.10046 (2026-10-15)');
  expect(lines[2]).toBe('[3] Paper 10063 — https://arxiv.org/abs/2610.10063 (2026-10-15)');
  // uncited extras fill up to the cap (cited ones never displaced)
  expect(lines).toHaveLength(20);
  expect(lines[3]).toBe('[4] Paper 10001 — https://arxiv.org/abs/2610.10001 (2026-10-15)');
  // each URL listed once
  const urls = lines.map((l) => / — (\S+)/.exec(l)![1]);
  expect(new Set(urls).size).toBe(urls.length);
}

describe('extract_ai_content — every remaining [n] resolves (build 2603, v70)', () => {
  const script = generateRunScript(agent);

  it('node extractor: cited sources beyond the 20 cap are listed and markers renumbered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-'));
    fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
    fs.writeFileSync(path.join(dir, 'resp.json'), RESPONSE);
    const out = execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();
    checkOutput(out);
  });

  it('node extractor: cited sources are kept even when more than 20 are cited', () => {
    const many = Array.from({ length: 25 }, (_, i) => `x [${i + 31}]`).join('. ');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-many-'));
    fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
    fs.writeFileSync(path.join(dir, 'resp.json'), JSON.stringify({ choices: [{ message: { content: many } }], citations }));
    const out = execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();
    assertEveryMarkerResolves(out, false);
    expect(out.split('\n\n## Sources\n')[1].split('\n')).toHaveLength(25);
  });

  it('node extractor: content is untouched when the response has no sidecar sources', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-none-'));
    fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
    fs.writeFileSync(path.join(dir, 'resp.json'), JSON.stringify({ choices: [{ message: { content: 'a[1] b [54]' } }] }));
    const out = execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();
    expect(out).toBe('a[1] b [54]');
  });

  // v71: the attribution audit sidecar. The raw response file is rm -f'd right
  // after extraction, so when a note's [n] points at the wrong paper nothing
  // was left to tell Perplexity's own marker/array misalignment from a
  // mapping bug. extract_ai_content now writes ONE overwritten file per agent
  // into the existing log dir with the pre-renumbering content and the raw
  // arrays — never the key/headers (they are not in the response body).
  const LONG_CONTENT = 'Alpha [54]. ' + 'x'.repeat(30000);
  function runNode(dir: string, response: string, logDir: string): string {
    fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
    fs.writeFileSync(path.join(dir, 'resp.json'), response);
    return execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json'), logDir]).toString();
  }

  it('node extractor: writes $LOG_DIR/perplexity-last.json (model, truncated raw content, citations, search_results)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-diag-'));
    const logDir = path.join(dir, 'logs', 'deep-research');
    const response = JSON.stringify({
      id: 'resp-1',
      model: 'sonar-deep-research',
      choices: [{ message: { content: LONG_CONTENT } }],
      citations,
      search_results: searchResults.map((r) => ({ ...r, snippet: 'long snippet '.repeat(50), last_updated: '2026-10-16' })),
    });
    const out = runNode(dir, response, logDir);
    // v72: a sonar-deep-research response has its markers stripped
    expect(body(out)).toContain('Alpha. x');
    const diagPath = path.join(logDir, 'perplexity-last.json');
    const diag = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
    expect(Object.keys(diag)).toEqual(['model', 'content_chars', 'content', 'citations', 'search_results']);
    expect(diag.model).toBe('sonar-deep-research');
    expect(diag.content_chars).toBe(LONG_CONTENT.length);
    expect(diag.content).toHaveLength(20000);
    expect(diag.content.startsWith('Alpha [54].')).toBe(true); // raw markers, pre-renumbering
    expect(diag.citations).toEqual(citations);
    expect(diag.search_results).toHaveLength(searchResults.length);
    expect(diag.search_results[0]).toEqual({ title: 'Paper 10001', url: 'https://arxiv.org/abs/2610.10001', date: '2026-10-15', last_updated: '2026-10-16' });
    expect(fs.readFileSync(diagPath, 'utf8')).not.toContain('snippet');
    if (process.platform !== 'win32') expect(fs.statSync(diagPath).mode & 0o777).toBe(0o600);
    // overwritten in place on the next response (one fixed file per agent)
    runNode(dir, JSON.stringify({ model: 'sonar', choices: [{ message: { content: 'B [1]' } }], citations: ['https://b.example/'] }), logDir);
    expect(JSON.parse(fs.readFileSync(diagPath, 'utf8'))).toEqual({ model: 'sonar', content_chars: 5, content: 'B [1]', citations: ['https://b.example/'], search_results: [] });
    expect(fs.readdirSync(logDir)).toEqual(['perplexity-last.json']);
  });

  it('node extractor: no sidecar file for responses without Perplexity sources', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-nodiag-'));
    const logDir = path.join(dir, 'logs', 'deep-research');
    runNode(dir, JSON.stringify({ model: 'gpt-oss-120b', choices: [{ message: { content: 'plain [1]' } }] }), logDir);
    expect(fs.existsSync(path.join(logDir, 'perplexity-last.json'))).toBe(false);
    // and an empty LOG_DIR argument writes nothing anywhere
    runNode(dir, RESPONSE, '');
    expect(fs.existsSync(path.join(dir, 'perplexity-last.json'))).toBe(false);
  });

  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  (hasPython ? it : it.skip)('python3 fallback extractor matches the node branch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-py-'));
    fs.writeFileSync(path.join(dir, 'extract.py'), extractHeredoc(script, 'PYEOF'));
    fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
    fs.writeFileSync(path.join(dir, 'resp.json'), RESPONSE);
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const pyLog = path.join(dir, 'py-logs');
    const nodeLog = path.join(dir, 'node-logs');
    const py = execFileSync('python3', [path.join(dir, 'extract.py'), path.join(dir, 'resp.json'), pyLog], { env }).toString().replace(/\r\n/g, '\n'); // Windows text-mode stdout
    const node = execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json'), nodeLog]).toString();
    checkOutput(py);
    expect(py).toBe(node);
    // v71 sidecar: byte-identical between the two branches
    const pyDiag = fs.readFileSync(path.join(pyLog, 'perplexity-last.json'), 'utf8');
    const nodeDiag = fs.readFileSync(path.join(nodeLog, 'perplexity-last.json'), 'utf8');
    expect(pyDiag).toBe(nodeDiag);
    expect(JSON.parse(nodeDiag).content).toBe(CONTENT);
  });
});

/**
 * v72 (2026-10-16 on-device audit, sonar-deep-research): the raw content cited
 * [32] [33] [34] while the response carried only 29 citations/search_results,
 * and an earlier run's in-range markers each pointed at the NEXT paper —
 * deep-research shares one [n] id space across several search batches and
 * returns only a subset, so its inline markers cannot index the returned list.
 * For a deep-research model every inline marker is stripped and "## Sources"
 * lists the uncited sources (cap 20); other models keep the v70 renumbering.
 */
describe('extract_ai_content — deep-research markers are stripped (v72)', () => {
  const script = generateRunScript(agent);
  const cites29 = Array.from({ length: 29 }, (_, i) => `https://arxiv.org/abs/2610.${String(20001 + i)}`);
  const sr29 = cites29.map((u) => ({ title: `Paper ${u.slice(-5)}`, url: u, date: '2026-10-15' }));
  const OUT_OF_RANGE = [
    '| Paper | Link |',
    '|---|---|',
    '| Alpha [32] | [arXiv](https://arxiv.org/abs/2610.20001) |',
    '',
    'Alpha [32] scales reasoning [33][34]. Beta adds memory [33, 34].',
  ].join('\n');
  const IN_RANGE = 'Alpha scales reasoning [1][2]. Beta adds memory [3, 4]. Gamma [5] [5].';

  function run(kind: 'node' | 'py', response: object, requestModel?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `deep-v72-${kind}-`));
    fs.writeFileSync(path.join(dir, 'resp.json'), JSON.stringify(response));
    const args = [path.join(dir, 'resp.json'), path.join(dir, 'logs')];
    if (requestModel !== undefined) args.push(requestModel);
    if (kind === 'node') {
      fs.writeFileSync(path.join(dir, 'extract.js'), extractHeredoc(script, 'NODEEOF'));
      return execFileSync(process.execPath, [path.join(dir, 'extract.js'), ...args]).toString();
    }
    fs.writeFileSync(path.join(dir, 'extract.py'), extractHeredoc(script, 'PYEOF'));
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    return execFileSync('python3', [path.join(dir, 'extract.py'), ...args], { env }).toString().replace(/\r\n/g, '\n');
  }

  function sourcesOf(out: string): string[] {
    return out.split('\n\n## Sources\n')[1].split('\n');
  }

  function checkDeepOutOfRange(out: string): void {
    const b = body(out);
    expect(b).toBe([
      '| Paper | Link |',
      '|---|---|',
      '| Alpha | [arXiv](https://arxiv.org/abs/2610.20001) |',
      '',
      'Alpha scales reasoning. Beta adds memory.',
    ].join('\n'));
    expect(b).not.toMatch(/\[\d{1,3}(?:,\s*\d{1,3})*\](?!\()/);
    const lines = sourcesOf(out);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('[1] Paper 20001 — https://arxiv.org/abs/2610.20001 (2026-10-15)');
    expect(lines[19]).toBe('[20] Paper 20020 — https://arxiv.org/abs/2610.20020 (2026-10-15)');
  }

  function checkDeepInRange(out: string): void {
    expect(body(out)).toBe('Alpha scales reasoning. Beta adds memory. Gamma.');
    expect(sourcesOf(out)).toHaveLength(20);
  }

  function checkNonDeep(out: string): void {
    // v70 renumbering unchanged: [5]→[5] etc. (order of first use), repeats collapsed
    expect(body(out)).toBe('Alpha scales reasoning [1][2]. Beta adds memory [3][4]. Gamma [5].');
    const lines = sourcesOf(out);
    expect(lines).toHaveLength(20);
    expect(lines[4]).toBe('[5] Paper 20005 — https://arxiv.org/abs/2610.20005 (2026-10-15)');
  }

  const deepOut = { model: 'sonar-deep-research', choices: [{ message: { content: OUT_OF_RANGE } }], citations: cites29, search_results: sr29 };
  const deepIn = { model: 'perplexity/sonar-deep-research', choices: [{ message: { content: IN_RANGE } }], citations: cites29, search_results: sr29 };
  const proIn = { model: 'sonar-pro', choices: [{ message: { content: IN_RANGE } }], citations: cites29, search_results: sr29 };
  const noModelIn = { choices: [{ message: { content: IN_RANGE } }], citations: cites29, search_results: sr29 };

  it('node: out-of-range markers [32][33][34] with 29 citations are stripped, Sources lists 20', () => {
    checkDeepOutOfRange(run('node', deepOut));
  });

  it('node: in-range deep-research markers are still stripped (prefixed model id)', () => {
    checkDeepInRange(run('node', deepIn));
  });

  it('node: request model alone marks the response as deep-research', () => {
    checkDeepInRange(run('node', noModelIn, 'sonar-deep-research'));
  });

  it('node: non-deep-research (sonar-pro) keeps the v70 renumbering', () => {
    checkNonDeep(run('node', proIn, 'sonar-pro'));
    checkNonDeep(run('node', noModelIn));
  });

  it('generated Perplexity script passes the request model to extract_ai_content', () => {
    expect(script).toContain('extract_ai_content "$RESULT_FILE.response.json" "$MODEL" >');
  });

  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  (hasPython ? it : it.skip)('python3 fallback matches the node branch byte-for-byte', () => {
    const cases: Array<[object, string | undefined, (o: string) => void]> = [
      [deepOut, undefined, checkDeepOutOfRange],
      [deepIn, undefined, checkDeepInRange],
      [noModelIn, 'sonar-deep-research', checkDeepInRange],
      [proIn, 'sonar-pro', checkNonDeep],
    ];
    for (const [resp, model, check] of cases) {
      const py = run('py', resp, model);
      const node = run('node', resp, model);
      check(py);
      expect(py).toBe(node);
    }
  });
});

