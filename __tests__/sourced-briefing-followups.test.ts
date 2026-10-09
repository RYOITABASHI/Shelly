/**
 * Sourced briefings — re-review low-severity follow-ups (2026-10-09):
 *  1. per-run `$$` in the Codex chain's evidence/carry temp file names;
 *  2. a sourced Codex chain cut short by its budget never saves the
 *     unprocessed last result as a draft;
 *  3. extract_ai_content matches citations ↔ search_results by normalized URL,
 *     falls back to a citation object's own title, and aliases a repeated
 *     citation to its first slot (no dangling [n]); readers honour the alias;
 *  4. character-limited final actions get a compact one-line-per-item form
 *     with inline source URLs (whole items dropped, never the URLs);
 *  5. cross-lingual anchor check + spelled-out quantities as numeric claims;
 *  (6 — dispatch-run timeout → 'pending' — lives in
 *   __tests__/agent-manager-sourced-briefing.test.ts.)
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import {
  absorbResearchStep,
  compactSourcedText,
  createChainEvidence,
  extractSourcesFromText,
  parseResearchSources,
  postProcessSourcedOutput,
  urlKey,
} from '@/lib/agent-sources';
import { xWeightedLength } from '@/lib/agent-pipeline-presets';
import type { Agent, AgentOrchestrationConfig, ToolChoice } from '@/store/types';
import { PERPLEXITY_RESPONSE } from './fixtures/sourced-briefing';

const agentOf = (tool: ToolChoice, orchestration?: AgentOrchestrationConfig, autonomous = true): Agent => ({
  id: 'followup-agent',
  name: 'Followup',
  description: '',
  prompt: 'Daily on-device AI news briefing',
  schedule: null,
  tool,
  autonomous,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
  orchestration,
});

const SOURCED_CHAIN: AgentOrchestrationConfig = {
  steps: ['search the web for the top 3 on-device AI news stories', 'summarize them', 'write a markdown briefing'],
};

function demoEvidence() {
  const evidence = createChainEvidence();
  absorbResearchStep(evidence, PERPLEXITY_RESPONSE.choices[0].message.content, parseResearchSources(PERPLEXITY_RESPONSE));
  return evidence;
}

describe('1 & 2 — Codex sourced chain temp names and early stop', () => {
  it('uses the per-run $$ nonce in every sourcing temp file name', () => {
    const s = generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, SOURCED_CHAIN));
    expect(s).toContain('CODEX_ORCH_SRC_STATE="$TMP_DIR/agent-orch-evidence-$AGENT_ID-$$.json"');
    expect(s).toContain('CODEX_ORCH_EVIDENCE_FILE="$TMP_DIR/agent-orch-evidence-block-$AGENT_ID-$$.txt"');
    expect(s).toContain('CODEX_ORCH_CARRY_SOURCE_FILE="$TMP_DIR/agent-orch-carry-source-$AGENT_ID-$$.txt"');
    expect(s).not.toMatch(/AGENT_ID-\$\.(json|txt)/);
  });

  it('an early-stopped sourced chain suppresses the action AND skips the draft save', () => {
    const sourced = generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, SOURCED_CHAIN));
    const tail = sourced.slice(sourced.indexOf('if [ "$CODEX_ORCH_STEP_INDEX" -lt "$CODEX_ORCH_STEP_TOTAL" ]'));
    expect(tail.slice(0, 400)).toContain('ACTION_TYPE="__suppressed__"');
    expect(tail.slice(0, 400)).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
    const plain = generateRunScript(agentOf({ type: 'cli', cli: 'codex' }, { steps: ['collect the meeting notes', 'summarize', 'post'] }));
    const plainTail = plain.slice(plain.indexOf('if [ "$CODEX_ORCH_STEP_INDEX" -lt "$CODEX_ORCH_STEP_TOTAL" ]'));
    expect(plainTail.slice(0, 300)).not.toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
  });
});

describe('3 — extract_ai_content URL matching + repeated-citation alias', () => {
  const RESPONSE = {
    choices: [{ message: { content: 'A [1]. B [2]. A again [3].' } }],
    citations: [
      'https://www.Example.com/story/?utm_source=pplx#top',
      { url: 'https://own.example/item', title: 'Own Title', date: '2026-09-02' },
      'https://example.com/story',
    ],
    search_results: [{ title: 'Story Title', url: 'https://example.com/story', date: '2026-09-01' }],
  };
  const expected = [
    '[1] Story Title — https://www.Example.com/story/?utm_source=pplx#top (2026-09-01)',
    '[2] Own Title — https://own.example/item (2026-09-02)',
    '[3] = [1]',
  ];

  function extract(marker: 'NODEEOF' | 'PYEOF'): string {
    const s = generateRunScript(agentOf({ type: 'perplexity', model: 'sonar' }, undefined, false));
    const start = s.indexOf('extract_ai_content() {');
    let idx = start;
    for (;;) {
      const open = s.indexOf(`<<'${marker}'`, idx);
      const from = s.indexOf('\n', open) + 1;
      const end = s.indexOf(`\n${marker}\n`, from);
      const body = s.slice(from, end);
      if (body.includes('search_results')) return body;
      idx = end + 1;
    }
  }

  it('node branch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-fu-'));
    fs.writeFileSync(path.join(dir, 'x.js'), extract('NODEEOF'));
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(RESPONSE));
    const out = execFileSync(process.execPath, [path.join(dir, 'x.js'), path.join(dir, 'r.json')]).toString();
    expect(out.split('## Sources\n')[1].split('\n')).toEqual(expected);
  });

  const hasPython = (() => {
    try {
      execFileSync('python3', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  (hasPython ? it : it.skip)('python fallback branch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-fu-py-'));
    fs.writeFileSync(path.join(dir, 'x.py'), extract('PYEOF'));
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(RESPONSE));
    const out = execFileSync('python3', [path.join(dir, 'x.py'), path.join(dir, 'r.json')], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }).toString().replace(/\r\n/g, '\n');
    if (!out.includes('## Sources')) throw new Error(`python output: ${out}`);
    expect(out.split('## Sources\n')[1].split('\n')).toEqual(expected);
  });

  it('readers map the alias onto the first slot (no dangling marker)', () => {
    const text = `A [1]. B [2]. A again [3].\n\n## Sources\n${expected.join('\n')}`;
    const parsed = extractSourcesFromText(text);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.indexMap[3]).toBe(parsed.indexMap[1]);
    expect(parsed.indexMap[3]).toBeGreaterThan(0);
  });

  it('urlKey drops tracking params, fragments, www and trailing slashes', () => {
    expect(urlKey('https://www.Example.com/story/?utm_source=x&id=7&fbclid=y#top')).toBe('example.com/story?id=7');
    expect(urlKey('http://example.com/story')).toBe(urlKey('https://www.example.com/story/'));
  });
});

describe('4 — compact form for character-limited actions', () => {
  const LLM = [
    '1. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]',
    '2. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster Hexagon NPU. [4]',
    '3. **Apple expands Foundation Models framework** — Open to developers. [2]',
  ].join('\n');

  it('one line per item with its source URL; whole items dropped to fit, URLs never cut', () => {
    const evidence = demoEvidence();
    const full = compactSourcedText(LLM, evidence, 4000, xWeightedLength);
    expect(full.split('\n')).toEqual([
      '• Google releases Gemma 3n for on-device AI https://blog.google/technology/developers/gemma-3n/',
      '• Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5',
      '• Apple expands Foundation Models framework https://www.apple.com/newsroom/2026/09/foundation-models/',
    ]);
    const firstLen = xWeightedLength(full.split('\n')[0]);
    const one = compactSourcedText(LLM, evidence, firstLen + 5, xWeightedLength);
    expect(one.split('\n')).toHaveLength(1);
    expect(one).toContain('https://blog.google/technology/developers/gemma-3n/');
  });

  it('returns empty (callers fail closed) when not even one item + URL fits', () => {
    expect(compactSourcedText(LLM, demoEvidence(), 40, xWeightedLength)).toBe('');
  });
});

describe('5 — cross-lingual anchor + spelled-out quantities', () => {
  it('a JA item with no anchor shared with its English source is rewritten', () => {
    const out = postProcessSourcedOutput('- **アップルが倒産を発表** — 全社員を解雇した。[2]', demoEvidence(), { finalize: true });
    expect(out.text).not.toContain('倒産');
    expect(out.rewrittenItems).toBe(1);
  });

  it('a JA item sharing an entity with its English source is kept (no false positive)', () => {
    const out = postProcessSourcedOutput('- **GoogleがGemma 3nを公開** — スマホ向けモデル。[1]', demoEvidence(), { finalize: true });
    expect(out.text).toContain('GoogleがGemma 3nを公開');
    expect(out.rewrittenItems).toBe(0);
  });

  it('"twice as fast" / 三倍 with no matching quantity in the source is rewritten', () => {
    const en = postProcessSourcedOutput(
      '- **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — The Hexagon NPU is twice as fast. [4]',
      demoEvidence(),
      { finalize: true },
    );
    expect(en.text).not.toMatch(/twice/);
    expect(en.rewrittenItems).toBe(1);
    const ja = postProcessSourcedOutput('- **QualcommのSnapdragon 8 Elite Gen 5** — NPUが三倍高速に。[4]', demoEvidence(), { finalize: true });
    expect(ja.text).not.toContain('三倍');
  });

  it('a quantity the source states is kept', () => {
    const evidence = createChainEvidence();
    absorbResearchStep(
      evidence,
      '- **Chipmaker doubles NPU speed** — The new NPU is twice as fast as last year. [1]',
      parseResearchSources({ citations: ['https://chip.example/a'] }),
    );
    const out = postProcessSourcedOutput('- **Chipmaker doubles NPU speed** — The NPU runs twice as fast. [1]', evidence, { finalize: true });
    expect(out.rewrittenItems).toBe(0);
    expect(out.text).toContain('twice as fast');
  });
});
