/**
 * Review fixes for NL parallel groups (2026-10-30): dependent transform
 * steps never group, 「それぞれ」「一緒に」 are not markers, the tool phrase is
 * kept when it modifies a noun, trailing-step removal re-prunes dead groups,
 * sequencing-only clauses are not steps, and the all-local agent-level tool
 * rule also runs on the conversational / LLM-fallback / slot-fill paths.
 */
import { parseAgentNL } from '@/lib/agent-nl-parser';
import {
  detectToolPinnedSteps,
  pruneIneffectiveParallelGroups,
  stripToolPhrase,
  tagStepsWithToolMentions,
} from '@/lib/agent-orchestration';
import { allLocalStepSuggestion, suggestToolForDraft } from '@/lib/agent-tool-router';
import { mergeConversationalExtractionIntoDraft } from '@/lib/agent-conversational-registration';
import type { AgentOrchestrationStep } from '@/store/types';

const groups = (steps: Array<string | AgentOrchestrationStep> | null | undefined) =>
  (steps ?? []).map((s) => (typeof s === 'string' ? undefined : s.parallelGroup));

describe('1. transform verbs end a group (they likely use the previous sibling)', () => {
  it.each([
    '同時に、ローカルLLMで記事を書いて、ローカルLLMで翻訳して、最後に保存して',
    '同時に、記事を書いて、英語に翻訳して、最後にまとめて',
    '同時に、ローカルLLMでブログ記事を書いて、ローカルLLMで校正して、ローカルLLMでタイトルを付けて、最後にまとめて',
    '同時に、ローカルLLMで記事を書いて、ローカルLLMで記事を校正して、最後にまとめて',
    'At the same time: write a poem with the local LLM, translate into English with the local LLM, then save it',
  ])('%s → no group', (text) => {
    const steps = detectToolPinnedSteps(text);
    expect(groups(steps).every((g) => g === undefined)).toBe(true);
    expect(groups(parseAgentNL(text).orchestrationSteps).every((g) => g === undefined)).toBe(true);
  });

  it('a transform clause naming its own topic (「〜について」) may still group', () => {
    const steps = detectToolPinnedSteps('同時に、ローカルLLMで春のニュースについて要約して、ローカルLLMで夏のニュースについて要約して、最後に2つをまとめて');
    expect(groups(steps)).toEqual(['p1', 'p1', undefined]);
  });
});

describe('2. 「それぞれ」「一緒に」 are not parallel markers', () => {
  it.each([
    'iPhoneとPixelについて、それぞれ、ローカルLLMで調べて、ローカルLLMで比較して、最後にまとめて',
    'それぞれ、ローカルLLMでメールを読んで、ローカルLLMで返信案を作って、最後にまとめて',
    '一緒に、ローカルLLMで春について書いて、ローカルLLMで夏について書いて、最後にまとめて',
  ])('%s → no group', (text) => {
    expect(groups(detectToolPinnedSteps(text)).every((g) => g === undefined)).toBe(true);
    expect(groups(parseAgentNL(text).orchestrationSteps).every((g) => g === undefined)).toBe(true);
  });
});

describe('3. the tool phrase is kept when it modifies a noun', () => {
  it.each([
    ['Geminiで作った画像を説明して', { type: 'gemini-api' }],
    ['Codexで書いたコードをレビューして', { type: 'cli', cli: 'codex' }],
    ['パープレで調べた結果を要約して', { type: 'perplexity' }],
    ['summarize the article written with Gemini', { type: 'gemini-api' }],
  ] as const)('%s', (text, tool) => {
    expect(stripToolPhrase(text, tool as never)).toBe(text);
  });

  it('keeps 全部/すべて', () => {
    expect(stripToolPhrase('全部ローカルLLMで要約して', { type: 'local' })).toBe('全部要約して');
    expect(stripToolPhrase('すべてローカルLLMで翻訳して', { type: 'local' })).toBe('すべて翻訳して');
  });

  it('non-parallel chains (tagStepsWithToolMentions / clause split) keep the attributive phrase', () => {
    expect(tagStepsWithToolMentions(['Geminiで作った画像を説明して', 'Codexで書いたコードをレビューして'])).toEqual([
      { instruction: 'Geminiで作った画像を説明して', tool: expect.objectContaining({ type: 'gemini-api' }) },
      { instruction: 'Codexで書いたコードをレビューして', tool: { type: 'cli', cli: 'codex' } },
    ]);
    const steps = detectToolPinnedSteps('パープレで調べた結果を要約して、全部ローカルLLMで翻訳して');
    expect(steps?.map((s) => s.instruction)).toEqual(['パープレで調べた結果を要約して', '全部翻訳して']);
  });
});

describe('4. dropping a trailing step re-prunes dead parallel groups', () => {
  it('「同時に、Aを書いて、Bを書いて、通知して」 → no group left after 通知して is dropped', () => {
    const draft = parseAgentNL('同時に、ローカルLLMでAについて書いて、ローカルLLMでBについて書いて、通知して');
    expect(draft.action.type).toBe('notify');
    expect(draft.orchestrationSteps).toHaveLength(2);
    expect(groups(draft.orchestrationSteps)).toEqual([undefined, undefined]);
  });

  it('no marker is left on the new final step', () => {
    const draft = parseAgentNL(
      '同時に、ローカルLLMでAについて調べて、ローカルLLMでBについて調べて、ローカルLLMでCについて調べて、最後に通知して',
    );
    const g = groups(draft.orchestrationSteps);
    expect(g[g.length - 1]).toBeUndefined();
    expect(g).toEqual(['p1', 'p1', undefined]);
  });

  it('pruneIneffectiveParallelGroups drops singletons and final-step markers, keeps cap overflow', () => {
    expect(
      groups(pruneIneffectiveParallelGroups([
        { instruction: 'a', parallelGroup: 'p1' },
        { instruction: 'b', parallelGroup: 'p1' },
        { instruction: 'c', parallelGroup: 'p1' },
        { instruction: 'd', parallelGroup: 'p1' },
        'final',
      ])),
    ).toEqual(['p1', 'p1', 'p1', 'p1', undefined]);
    expect(groups(pruneIneffectiveParallelGroups([{ instruction: 'a', parallelGroup: 'p1' }, 'b']))).toEqual([undefined, undefined]);
    expect(
      groups(pruneIneffectiveParallelGroups([
        { instruction: 'a', parallelGroup: 'p1' },
        { instruction: 'b', parallelGroup: 'p1' },
        { instruction: 'c', parallelGroup: 'p1' },
      ])),
    ).toEqual(['p1', 'p1', undefined]);
  });
});

describe('5. a sequencing-only clause is not a step', () => {
  it('「その後、」 sequences the next clause instead of becoming a step', () => {
    const draft = parseAgentNL('同時に、ローカルLLMでAについて調べて、ローカルLLMでBについて調べて、その後、ローカルLLMでまとめて、通知して');
    const steps = (draft.orchestrationSteps ?? []).map((s) => (typeof s === 'string' ? s : s.instruction));
    expect(steps).toEqual(['Aについて調べて', 'Bについて調べて', 'まとめて']);
    expect(steps).not.toContain('その後');
    expect(groups(draft.orchestrationSteps)).toEqual(['p1', 'p1', undefined]);
  });

  it('EN "finally," alone ends the group too', () => {
    const steps = detectToolPinnedSteps('In parallel, research spring with Perplexity, research summer with Perplexity, research autumn with Perplexity, finally, merge everything with the local LLM');
    expect(steps?.map((s) => s.instruction)).toEqual(['research spring', 'research summer', 'research autumn', 'merge everything']);
    expect(groups(steps)).toEqual(['p1', 'p1', 'p1', undefined]);
  });
});

describe('6. all-local agent-level tool on every draft path', () => {
  const localSteps = [
    { instruction: 'A', tool: { type: 'local' as const }, parallelGroup: 'p1' },
    { instruction: 'B', tool: { type: 'local' as const }, parallelGroup: 'p1' },
    { instruction: 'merge', tool: { type: 'local' as const } },
  ];

  it('suggestToolForDraft honors steps when orchestrated; mixed / unpinned stays keyword-scored', () => {
    expect(suggestToolForDraft('最新ニュースを調べて', { orchestrated: true, steps: localSteps })).toMatchObject({ tool: { type: 'local' }, explicit: true });
    expect(allLocalStepSuggestion([...localSteps.slice(0, 2), 'merge'])).toBeUndefined();
    expect(allLocalStepSuggestion([localSteps[0]])).toBeUndefined();
  });

  it('conversational merge sets a local tool once the merged steps are all local', () => {
    const base = parseAgentNL('毎日9時にニュースをまとめて');
    const { draft } = mergeConversationalExtractionIntoDraft(base, {
      prompt: '最新ニュースを調べてまとめる',
      steps: ['ローカルLLMでニュースを集める', 'ローカルLLMで要約する'],
    } as never, { connectors: [] });
    expect(draft.orchestrationSteps?.every((s) => typeof s !== 'string' && s.tool?.type === 'local')).toBe(true);
    expect(draft.tool.type).toBe('local');
    expect(draft.toolExplicit).toBe(true);
  });
});
