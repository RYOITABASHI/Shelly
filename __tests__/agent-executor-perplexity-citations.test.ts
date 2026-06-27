jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const agent = (tool: ToolChoice): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: '最新ニュースを集めて',
  schedule: null,
  tool,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

// Pull the body of the `<<'MARKER' ... MARKER` heredoc that contains `needle` out of
// the generated script (there are several NODEEOF blocks) so we run the REAL emitted
// extractor (escaping included), not a hand-copy.
function extractHeredoc(script: string, marker: string, needle: string): string {
  let idx = 0;
  for (;;) {
    const open = script.indexOf(`<<'${marker}'`, idx);
    if (open < 0) throw new Error(`heredoc ${marker} containing "${needle}" not found`);
    const from = script.indexOf('\n', open) + 1;
    const end = script.indexOf(`\n${marker}\n`, from);
    const body = script.slice(from, end);
    if (body.includes(needle)) return body;
    idx = end + 1;
  }
}

const SAMPLE = JSON.stringify({
  choices: [{ message: { content: '最新の STEAM×AI 研究の要約です[1][2]。' } }],
  search_results: [
    { title: 'AI in STEAM Education', url: 'https://arxiv.org/abs/2401.12345', date: '2026-06-20' },
    { title: 'Gen AI in K-12', url: 'https://example.edu/paper.pdf' },
    { title: 'dup', url: 'https://arxiv.org/abs/2401.12345' }, // dedup
    { title: 'no-url' }, // skipped
  ],
});

describe('extract_ai_content — appends Perplexity sidecar sources (regression)', () => {
  it('the generated node extractor turns sidecar search_results into a ## Sources list', () => {
    const script = generateRunScript(agent({ type: 'perplexity' }));
    const nodeCode = extractHeredoc(script, 'NODEEOF', 'search_results');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pplx-'));
    fs.writeFileSync(path.join(dir, 'resp.json'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'extract.js'), nodeCode);
    const out = execFileSync('node', [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();

    expect(out).toContain('最新の STEAM×AI 研究の要約です');
    expect(out).toContain('## Sources');
    expect(out).toContain('[1] AI in STEAM Education — https://arxiv.org/abs/2401.12345');
    expect(out).toContain('[2] Gen AI in K-12 — https://example.edu/paper.pdf');
    // dedup: the repeated arxiv URL is not listed a second time
    expect(out.match(/arxiv\.org\/abs\/2401\.12345/g)?.length).toBe(1);
    // the no-URL guard keys off this — it must now find a URL
    expect(/https?:\/\//.test(out)).toBe(true);
  });

  it('is a no-op when the response has no sidecar sources (other backends)', () => {
    const script = generateRunScript(agent({ type: 'perplexity' }));
    const nodeCode = extractHeredoc(script, 'NODEEOF', 'search_results');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pplx2-'));
    fs.writeFileSync(path.join(dir, 'resp.json'), JSON.stringify({ choices: [{ message: { content: 'just text' } }] }));
    fs.writeFileSync(path.join(dir, 'extract.js'), nodeCode);
    const out = execFileSync('node', [path.join(dir, 'extract.js'), path.join(dir, 'resp.json')]).toString();
    expect(out).toBe('just text');
    expect(out).not.toContain('## Sources');
  });

  // The python3 branch is the on-device fallback when node is unusable — verify it
  // mirrors the node behaviour. Skipped where python3 is unavailable.
  const hasPython = (() => {
    try { execFileSync('python3', ['--version']); return true; } catch { return false; }
  })();
  (hasPython ? it : it.skip)('the generated python3 fallback extractor also appends sidecar sources', () => {
    const script = generateRunScript(agent({ type: 'perplexity' }));
    const pyCode = extractHeredoc(script, 'PYEOF', 'search_results');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pplx-py-'));
    fs.writeFileSync(path.join(dir, 'resp.json'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'extract.py'), pyCode);
    // python branch reads sys.argv[1] (vs node's argv[2]). Force UTF-8 stdout: the
    // device's python3 is UTF-8, but Windows CI/dev defaults to cp932 and can't encode
    // the non-ASCII output — that's a harness locale quirk, not a production issue.
    const out = execFileSync('python3', [path.join(dir, 'extract.py'), path.join(dir, 'resp.json')], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }).toString();
    expect(out).toContain('## Sources');
    expect(out).toContain('[1] AI in STEAM Education — https://arxiv.org/abs/2401.12345');
    expect(out).toContain('[2] Gen AI in K-12 — https://example.edu/paper.pdf');
    expect(out.match(/arxiv\.org\/abs\/2401\.12345/g)?.length).toBe(1);
  });
});
