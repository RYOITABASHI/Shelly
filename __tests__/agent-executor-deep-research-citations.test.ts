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
    const py = execFileSync('python3', [path.join(dir, 'extract.py'), path.join(dir, 'resp.json')], { env }).toString().replace(/\r\n/g, '\n'); // Windows text-mode stdout
    const node = execFileSync(process.execPath, [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();
    checkOutput(py);
    expect(py).toBe(node);
  });
});
