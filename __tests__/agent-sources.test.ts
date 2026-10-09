import {
  absorbResearchStep,
  buildFallbackBriefing,
  choosePerplexityModel,
  createChainEvidence,
  detectRecency,
  enforceSourcedIntermediate,
  extractSourcesFromText,
  isResearchStep,
  NO_SOURCES_MESSAGE,
  parseResearchSources,
  postProcessSourcedOutput,
  renderStepEvidence,
  requestedItemCount,
  requiresWebFacts,
  RESEARCH_REQUIREMENTS_MARKER,
  SOURCING_CONTRACT_MARKER,
  stripReasoning,
  withoutResearchDirective,
} from '@/lib/agent-sources';
import { buildStepPrompt, MAX_PROMPT_CHARS } from '@/lib/agent-orchestration';

import { DEMO_UTTERANCE, PERPLEXITY_RESPONSE } from './fixtures/sourced-briefing';

describe('parseResearchSources', () => {
  it('parses citations + search_results (sonar / sonar-pro / sonar-deep-research shape)', () => {
    const parsed = parseResearchSources(JSON.stringify(PERPLEXITY_RESPONSE));
    expect(parsed.sources.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.sources[0]).toEqual({
      id: 1,
      title: 'Announcing Gemma 3n',
      url: 'https://blog.google/technology/developers/gemma-3n/',
      date: '2026-09-30',
    });
    expect(parsed.sources[2].date).toBe('2026-09-16');
    expect(parsed.indexMap.slice(1)).toEqual([1, 2, 3, 4]);
  });

  it('parses search_results-only responses (citations field removed)', () => {
    const { citations, ...rest } = PERPLEXITY_RESPONSE;
    void citations;
    const parsed = parseResearchSources(rest);
    expect(parsed.sources).toHaveLength(5);
    expect(parsed.indexMap.slice(1)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses legacy citations-only responses with the host as the title', () => {
    const parsed = parseResearchSources({ choices: [], citations: ['https://www.example.com/a', 'https://example.com/b'] });
    expect(parsed.sources.map((s) => s.title)).toEqual(['example.com', 'example.com']);
  });

  it('dedupes by URL, keeps only http(s), caps at 10, maps markers onto deduped ids', () => {
    const citations = [
      'https://a.example/x',
      'https://a.example/x/',
      'javascript:alert(1)',
      'ftp://files.example/y',
      ...Array.from({ length: 12 }, (_, i) => `https://n${i}.example/`),
    ];
    const parsed = parseResearchSources({ citations });
    expect(parsed.sources).toHaveLength(10);
    expect(parsed.sources.every((s) => /^https?:\/\//.test(s.url))).toBe(true);
    expect(parsed.indexMap[1]).toBe(1);
    expect(parsed.indexMap[2]).toBe(1); // duplicate URL -> same source
    expect(parsed.indexMap[3]).toBe(0); // javascript: dropped
    expect(parsed.indexMap[4]).toBe(0); // ftp: dropped
    expect(parsed.indexMap[16]).toBe(0); // beyond the cap
  });

  it('parses Gemini grounding chunks', () => {
    const parsed = parseResearchSources({
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'theverge.com' } }] } }],
    });
    expect(parsed.sources).toEqual([{ id: 1, title: 'theverge.com', url: 'https://vertexaisearch.cloud.google.com/r/1' }]);
  });

  it('returns no sources for non-JSON / unrelated payloads', () => {
    expect(parseResearchSources('not json').sources).toEqual([]);
    expect(parseResearchSources({ choices: [{ message: { content: 'x' } }] }).sources).toEqual([]);
  });
});

describe('extractSourcesFromText (attended bash path)', () => {
  it('parses the extract_ai_content "## Sources" block and inline links', () => {
    const text = 'Body [1] and [2].\nSee also [Extra](https://extra.example/p).\n\n## Sources\n[1] First — https://one.example/a\n[2] Second — https://two.example/b';
    const parsed = extractSourcesFromText(text);
    expect(parsed.sources.map((s) => s.url)).toEqual(['https://one.example/a', 'https://two.example/b', 'https://extra.example/p']);
    expect(parsed.sources[0].title).toBe('First');
    expect(parsed.indexMap.slice(1)).toEqual([1, 2]);
  });
});

describe('intent helpers', () => {
  it('detects web-fact chains, research steps, counts, recency', () => {
    expect(requiresWebFacts(DEMO_UTTERANCE)).toBe(true);
    expect(requiresWebFacts('Base task')).toBe(false);
    expect(requiresWebFacts('最新のAIニュースを集めて')).toBe(true);
    expect(isResearchStep('search the web with Perplexity for the top 3 on-device AI news stories.', 'perplexity')).toBe(true);
    expect(isResearchStep('summarize them with the local LLM.', 'local')).toBe(false);
    expect(isResearchStep('write a markdown briefing.', undefined)).toBe(false);
    expect(requestedItemCount(DEMO_UTTERANCE)).toBe(3);
    expect(requestedItemCount('five news items please')).toBe(5);
    expect(requestedItemCount('ニュースを5件')).toBe(5);
    expect(requestedItemCount('Base task')).toBeUndefined();
    expect(detectRecency(DEMO_UTTERANCE)).toBe('month');
    expect(detectRecency("today's AI headlines")).toBe('day');
    expect(detectRecency('this week in robotics')).toBe('week');
    expect(detectRecency('explain transformers')).toBeUndefined();
    // The research directive's own "Today's date is …" must not read as a 'today' cue.
    const composed = buildStepPrompt(DEMO_UTTERANCE, 'search', [], { mode: 'research', today: '2026-10-09', recency: 'month' });
    expect(detectRecency(composed)).toBe('day');
    expect(detectRecency(withoutResearchDirective(composed))).toBe('month');
  });

  it('uses sonar-pro for a top-N news list, keeps deep research only when asked', () => {
    expect(choosePerplexityModel('sonar-deep-research', DEMO_UTTERANCE)).toBe('sonar-pro');
    expect(choosePerplexityModel('sonar-deep-research', 'Do a deep research report on on-device AI')).toBe('sonar-deep-research');
    expect(choosePerplexityModel('sonar-deep-research', 'Use Perplexity sonar-deep-research to collect')).toBe('sonar-deep-research');
    expect(choosePerplexityModel('sonar', DEMO_UTTERANCE)).toBe('sonar');
    expect(choosePerplexityModel(undefined, DEMO_UTTERANCE)).toBe('sonar');
  });

  it('strips reasoning blocks', () => {
    expect(stripReasoning('<think>plan</think>\nAnswer')).toBe('Answer');
  });
});

function demoEvidence() {
  const evidence = createChainEvidence();
  const parsed = parseResearchSources(PERPLEXITY_RESPONSE);
  const carried = absorbResearchStep(evidence, PERPLEXITY_RESPONSE.choices[0].message.content, parsed);
  return { evidence, carried };
}

describe('absorbResearchStep', () => {
  it('captures sources + items and remaps markers onto chain ids', () => {
    const { evidence, carried } = demoEvidence();
    expect(evidence.sources).toHaveLength(5);
    expect(evidence.items).toHaveLength(3);
    expect(evidence.items[0]).toMatchObject({ title: 'Google releases Gemma 3n for on-device AI', sourceIds: [1], date: '2026-09-30' });
    expect(evidence.items[0].summary).toMatch(/^Google released Gemma 3n/);
    expect(evidence.items[1].sourceIds).toEqual([2, 3]);
    expect(carried).toContain('[2][3]');
  });

  it('offsets a second research step onto the next chain ids', () => {
    const { evidence } = demoEvidence();
    const carried2 = absorbResearchStep(evidence, '- **MediaTek ships Dimensity NPU** — MediaTek shipped a new NPU. [1]', {
      sources: [{ id: 1, title: 'MediaTek', url: 'https://mediatek.example/npu' }],
      indexMap: [0, 1],
    });
    expect(carried2).toContain('[6]');
    expect(evidence.sources[5].url).toBe('https://mediatek.example/npu');
    expect(evidence.items[3].sourceIds).toEqual([6]);
  });

  it('a second research step citing an already-known URL reuses its id', () => {
    const { evidence } = demoEvidence();
    const carried2 = absorbResearchStep(evidence, 'Gemma again [1]', {
      sources: [{ id: 1, title: 'g', url: 'https://blog.google/technology/developers/gemma-3n' }],
      indexMap: [0, 1],
    });
    expect(carried2).toBe('Gemma again [1]');
    expect(evidence.sources).toHaveLength(5);
  });
});

describe('buildStepPrompt evidence block (prompt contract)', () => {
  it('research step: date, recency window, structured-list request', () => {
    const prompt = buildStepPrompt(DEMO_UTTERANCE, 'search the web with Perplexity for the top 3 on-device AI news stories.', [], {
      mode: 'research',
      today: '2026-10-09',
      recency: 'month',
      count: 3,
    });
    expect(prompt).toContain(RESEARCH_REQUIREMENTS_MARKER);
    expect(prompt).toContain("Today's date is 2026-10-09");
    expect(prompt).toContain('published in the last 30 days');
    expect(prompt).toContain('up to 3 items');
    expect(prompt).toMatch(/source URL/);
    expect(prompt.endsWith('# This step\nsearch the web with Perplexity for the top 3 on-device AI news stories.')).toBe(true);
  });

  it('synthesis step: numbered sources + items + strict contract survive a huge carry', () => {
    const { evidence } = demoEvidence();
    const prompt = buildStepPrompt('x'.repeat(9000), 'summarize them with the local LLM.', ['y'.repeat(9000)], {
      mode: 'synthesis',
      sources: evidence.sources,
      items: evidence.items,
      count: 3,
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain('[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/ (2026-09-30)');
    expect(prompt).toContain('# Verified research items');
    expect(prompt).toContain(SOURCING_CONTRACT_MARKER);
    expect(prompt).toMatch(/Use ONLY facts/);
    expect(prompt).toMatch(/must end with a citation like \[1\]/);
    expect(prompt).toMatch(/output fewer\. Never invent/);
    expect(prompt).toMatch(/exactly as written/);
    expect(prompt.endsWith('# This step\nsummarize them with the local LLM.')).toBe(true);
  });

  it('no evidence = byte-identical legacy prompt', () => {
    expect(buildStepPrompt('Base task', 'gather sources', [])).toBe('Base task\n\n# This step\ngather sources');
  });

  it('caps the evidence block without ever losing the contract', () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: 't'.repeat(160), url: `https://e${i}.example/${'p'.repeat(300)}` }));
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `item ${i}`, summary: 's'.repeat(300), sourceIds: [i + 1] }));
    const block = renderStepEvidence({ mode: 'synthesis', sources, items });
    expect(block.length).toBeLessThanOrEqual(3000);
    expect(block).toContain(SOURCING_CONTRACT_MARKER);
  });
});

describe('postProcessSourcedOutput', () => {
  it('drops uncited / fabricated / duplicate items, renumbers, appends Sources', () => {
    const { evidence } = demoEvidence();
    const llm = [
      '# On-device AI Briefing',
      '',
      'Here are the top stories this month.',
      '',
      "1. **Apple Unveils 'Apple Neural LLM' on iPhone 17** — Apple launched a new neural LLM. [1]",
      '2. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster Hexagon NPU for on-device generative AI. [4]',
      '3. **Qualcomm Launches Snapdragon AI Engine 3.0** — no citation here.',
      '4. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Duplicate of item 2. [4]',
      '5. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1] See https://fake.example/made-up',
      '',
      '## Sources',
      '- https://fake.example/whatever',
    ].join('\n');
    const out = postProcessSourcedOutput(llm, evidence, { finalize: true, maxItems: 3 });
    expect(out.usedFallback).toBe(false);
    expect(out.keptItems).toBe(2);
    expect(out.text).not.toMatch(/Apple Neural LLM/);
    expect(out.text).not.toMatch(/AI Engine 3\.0/);
    expect(out.text).not.toMatch(/fake\.example/);
    expect(out.text).not.toMatch(/Here are the top stories/);
    expect(out.text.match(/Snapdragon 8 Elite Gen 5 NPU\*\*/g)).toHaveLength(1);
    // [4] (first used) -> [1], [1] -> [2]; ordered-list markers renumbered.
    expect(out.text).toContain('1. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster Hexagon NPU for on-device generative AI. [1]');
    expect(out.text).toContain('2. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [2]');
    expect(out.text.startsWith('# On-device AI Briefing')).toBe(true);
    const sourcesSection = out.text.split('## Sources')[1];
    expect(sourcesSection).toContain('- [1] [Snapdragon 8 Elite Gen 5](https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5) — 2026-09-24');
    expect(sourcesSection).toContain('- [2] [Announcing Gemma 3n](https://blog.google/technology/developers/gemma-3n/) — 2026-09-30');
    expect(sourcesSection).not.toContain('[3]');
  });

  it('drops invalid citation indices', () => {
    const { evidence } = demoEvidence();
    const out = postProcessSourcedOutput('- **Google releases Gemma 3n for on-device AI** — model. [1][42]', evidence, { finalize: true });
    expect(out.text).toContain('model. [1]');
    expect(out.text).not.toContain('[42]');
  });

  it('turns a known inline URL into a citation', () => {
    const { evidence } = demoEvidence();
    const out = postProcessSourcedOutput(
      '- **Apple expands Foundation Models framework** — https://www.apple.com/newsroom/2026/09/foundation-models/',
      evidence,
      { finalize: true },
    );
    expect(out.keptItems).toBe(1);
    expect(out.text).toContain('[1]');
    expect(out.text).toContain('[Apple Foundation Models framework](https://www.apple.com/newsroom/2026/09/foundation-models/)');
  });

  it('keeps cited section items (### heading + paragraph)', () => {
    const { evidence } = demoEvidence();
    const out = postProcessSourcedOutput(
      '# Briefing\n\n### Apple expands Foundation Models framework\nApple opened the framework to developers. [2]\n\n### Made-up Neural Thing\nBlah blah. ',
      evidence,
      { finalize: true },
    );
    expect(out.keptItems).toBe(1);
    expect(out.text).toContain('### Apple expands Foundation Models framework');
    expect(out.text).not.toContain('Made-up');
  });

  it('falls back to a deterministic template when the LLM output is uncited', () => {
    const { evidence } = demoEvidence();
    const out = postProcessSourcedOutput(
      '# On-device AI Briefing\n\nOn-device AI is booming. Apple Unveils Apple Neural LLM. Qualcomm Launches Snapdragon AI Engine 3.0.',
      evidence,
      { finalize: true, maxItems: 3 },
    );
    expect(out.usedFallback).toBe(true);
    expect(out.keptItems).toBe(3);
    expect(out.text.startsWith('# On-device AI Briefing')).toBe(true);
    expect(out.text).toContain('1. **Google releases Gemma 3n for on-device AI** (2026-09-30) — Google released Gemma 3n');
    expect(out.text).toContain('[1]');
    expect(out.text).toMatch(/## Sources\n\n- \[1\] \[Announcing Gemma 3n\]/);
    expect(out.text).not.toMatch(/Neural LLM/);
  });

  it('fallback from sources alone when no research items parsed', () => {
    const evidence = createChainEvidence();
    absorbResearchStep(evidence, 'Prose without list items.', parseResearchSources(PERPLEXITY_RESPONSE));
    expect(evidence.items).toHaveLength(0);
    const text = buildFallbackBriefing(evidence, { maxItems: 2 });
    expect(text).toBe('# Briefing\n\n1. **Announcing Gemma 3n** (2026-09-30) [1]\n2. **Apple Foundation Models framework** (2026-09-15) [2]');
    const out = postProcessSourcedOutput('nothing cited', evidence, { finalize: true, maxItems: 2 });
    expect(out.usedFallback).toBe(true);
    expect(out.text).toContain('## Sources');
  });

  it('intermediate steps keep chain-wide numbering and replace uncited output with the template', () => {
    const { evidence } = demoEvidence();
    const kept = enforceSourcedIntermediate('- **Apple expands Foundation Models framework** — opened to devs. [3]', evidence);
    expect(kept).toContain('[3]');
    expect(kept).not.toContain('## Sources');
    const replaced = enforceSourcedIntermediate('Some essay with no citations at all about on-device AI.', evidence, 3);
    expect(replaced).toContain('**Google releases Gemma 3n for on-device AI**');
    expect(replaced).toContain('[2][3]');
  });

  it('exposes a clear no-sources message', () => {
    expect(NO_SOURCES_MESSAGE).toMatch(/No verifiable sources/);
  });
});
