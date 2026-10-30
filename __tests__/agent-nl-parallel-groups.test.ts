/**
 * NL authoring of fan-out groups (2026-10-30, on-device build 2679 repro):
 * 「同時に」/"in parallel" markers turn the following sibling work clauses into
 * one `parallelGroup`, the marker never becomes a step, the instrument phrase
 * a pin came from is stripped from the step text, the summaries show the
 * grouping, and an all-local chain reaches the attended executor route.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { parseAgentNL } from '@/lib/agent-nl-parser';
import {
  MAX_PARALLEL_BRANCHES,
  detectToolPinnedSteps,
  normalizeSteps,
  planParallelGroups,
  stripToolPhrase,
  tagStepsWithToolMentions,
} from '@/lib/agent-orchestration';
import { summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { buildAgentAddSummary } from '@/lib/agent-add-approval';
import { decideAttendedRoute, effectiveGroupCount, storedPlanSpecOpts } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import type { LadderEnv } from '@/lib/agent-escalation-ladder';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

const DEVICE_UTTERANCE =
  '名前: 並列テスト、同時に、ローカルLLMで日本の春について200字で書いて、ローカルLLMで日本の夏について200字で書いて、ローカルLLMで日本の秋について200字で書いて、最後にローカルLLMで3つを1つの文章にまとめて、結果をメモとして保存して';

const ENV: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };

const objSteps = (steps: Array<string | AgentOrchestrationStep> | undefined) =>
  (steps ?? []).map((s) => (typeof s === 'string' ? { instruction: s } : s));

const binding = {
  reqId: 'req-1',
  riskReasons: ['step-tool'],
  approvable: false,
  expiresAt: 0,
  fireable: true,
  draftHash: 'abcdef0123456789',
};

describe('device utterance (build 2679)', () => {
  const draft = parseAgentNL(DEVICE_UTTERANCE);
  const steps = objSteps(draft.orchestrationSteps);

  it('splits into a group of 3 + the final merge step, with no marker step and no save step', () => {
    expect(draft.name).toBe('並列テスト');
    expect(steps.map((s) => s.instruction)).toEqual([
      '日本の春について200字で書いて',
      '日本の夏について200字で書いて',
      '日本の秋について200字で書いて',
      '3つを1つの文章にまとめて',
    ]);
    expect(steps.every((s) => s.tool?.type === 'local')).toBe(true);
    expect(steps.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', 'p1', undefined]);
    expect(steps.some((s) => s.instruction.includes('同時に'))).toBe(false);
    expect(draft.action.type).toBe('draft');
  });

  it('planParallelGroups gives exactly one effective group of 3 members', () => {
    const plan = planParallelGroups(normalizeSteps({ steps: draft.orchestrationSteps! }));
    expect(plan.group).toEqual(['p1', 'p1', 'p1', undefined]);
    expect(plan.contextBase).toEqual([0, 0, 0, 3]);
    expect(effectiveGroupCount(plan.group)).toBe(1);
  });

  it('the agent-level tool is local for an every-step-local chain', () => {
    expect(draft.tool.type).toBe('local');
    expect(draft.toolExplicit).toBe(true);
  });

  it('chat summary shows the group on one line (JA) and the merge step after it', () => {
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain(
      '1. 同時に: [Local LLM] 日本の春について200字で書いて ／ [Local LLM] 日本の夏について200字で書いて ／ [Local LLM] 日本の秋について200字で書いて',
    );
    expect(text).toContain('2. [Local LLM] 3つを1つの文章にまとめて');
    expect(text).not.toMatch(/^3\. /m);
    expect(text).not.toContain('∥');
  });

  it('`shelly agent add` summary shows the grouping and the pins', () => {
    const summary = buildAgentAddSummary(binding, draft, 'manual');
    expect(summary.steps).toEqual([
      'In parallel: [Local LLM] 日本の春について200字で書いて / [Local LLM] 日本の夏について200字で書いて / [Local LLM] 日本の秋について200字で書いて',
      '[Local LLM] 3つを1つの文章にまとめて',
    ]);
    expect(summary.stepsNote).toBeNull();
  });

  it('registration → PlanSpec writes parallelGroup and decideAttendedRoute picks the executor route', () => {
    const agent: Agent = {
      id: 'nl-parallel-agent',
      name: draft.name,
      description: '',
      prompt: draft.prompt,
      schedule: null,
      tool: draft.tool,
      toolExplicit: draft.toolExplicit,
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
      action: draft.action,
      orchestration: { steps: draft.orchestrationSteps! },
    } as Agent;
    const plan = buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, ENV));
    expect(plan.tool.type).toBe('local');
    const list = (plan.steps as { list: Array<{ parallelGroup?: string }> }).list;
    expect(list.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', 'p1', undefined]);
    const route = decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV });
    expect(route).toMatchObject({ route: 'executor', groupCount: 1 });
  });
});

describe('English markers', () => {
  it('"In parallel," + three clauses + "then" merge', () => {
    const draft = parseAgentNL(
      'Using the local LLM, in parallel, write about spring in Japan, write about summer in Japan, write about autumn in Japan, then merge the three into one essay',
    );
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.instruction)).toEqual([
      'write about spring in Japan',
      'write about summer in Japan',
      'write about autumn in Japan',
      'merge the three into one essay',
    ]);
    expect(steps.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', 'p1', undefined]);
    expect(steps.every((s) => s.tool?.type === 'local')).toBe(true);
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain(
      '1. In parallel: [Local LLM] write about spring in Japan / [Local LLM] write about summer in Japan / [Local LLM] write about autumn in Japan',
    );
    expect(text).toContain('2. [Local LLM] merge the three into one essay');
  });

  it('"at the same time:" leading work, trailing tool phrases stripped, "finally" ends the group', () => {
    const steps = detectToolPinnedSteps(
      'At the same time: summarize the tech news with Perplexity, summarize the sports news with Perplexity, and finally combine both with the local LLM',
    );
    expect(steps).toEqual([
      { instruction: 'summarize the tech news', tool: expect.objectContaining({ type: 'perplexity' }), parallelGroup: 'p1' },
      { instruction: 'summarize the sports news', tool: expect.objectContaining({ type: 'perplexity' }), parallelGroup: 'p1' },
      { instruction: 'combine both', tool: { type: 'local' } },
    ]);
  });

  it('"simultaneously" / "each of these:" markers', () => {
    for (const lead of ['Simultaneously', 'Each of these:']) {
      const steps = detectToolPinnedSteps(`${lead}, draft a haiku about rain, draft a haiku about snow, then pick the better one`);
      expect(steps?.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    }
  });
});

describe('grouping rules', () => {
  it('more than 3 siblings: the first 3 run together, the rest one after another, and the summary says so', () => {
    const draft = parseAgentNL(
      '同時に、ローカルLLMで春について書いて、ローカルLLMで夏について書いて、ローカルLLMで秋について書いて、ローカルLLMで冬について書いて、最後にローカルLLMで4つを1つにまとめて',
    );
    const normalized = normalizeSteps({ steps: draft.orchestrationSteps! });
    expect(normalized).toHaveLength(5);
    const plan = planParallelGroups(normalized);
    expect(plan.group).toEqual(['p1', 'p1', 'p1', undefined, undefined]);
    expect(MAX_PARALLEL_BRANCHES).toBe(3);
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('1. 同時に: [Local LLM] 春について書いて ／ [Local LLM] 夏について書いて ／ [Local LLM] 秋について書いて');
    expect(text).toContain('2. [Local LLM] 冬について書いて');
    expect(text).toContain('3. [Local LLM] 4つを1つにまとめて');
    expect(text).toContain('同時に実行できるのは3つまでです。残りの1つは順番に実行します。');
    expect(buildAgentAddSummary(binding, draft, 'manual').stepsNote).toMatch(/At most 3 steps run at the same time; the other 1/);
  });

  it('a marker with only one sibling forms no group (and is still not a step)', () => {
    const steps = detectToolPinnedSteps('同時に、ローカルLLMで春について書いて、最後にローカルLLMでそれを英訳して');
    expect(steps).toEqual([
      { instruction: '春について書いて', tool: { type: 'local' } },
      { instruction: 'それを英訳して', tool: { type: 'local' } },
    ]);
  });

  it('a group never takes the final step', () => {
    const steps = detectToolPinnedSteps('同時に、ローカルLLMで春について書いて、ローカルLLMで夏について書いて、ローカルLLMで秋について書いて');
    expect(steps?.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    // Two siblings + final: the final is severed, the singleton marker removed.
    const two = detectToolPinnedSteps('同時に、ローカルLLMで春について書いて、ローカルLLMで夏について書いて');
    expect(two?.map((s) => s.parallelGroup)).toEqual([undefined, undefined]);
  });

  it('a clause using earlier output ends the group even without a sequencing word', () => {
    const steps = detectToolPinnedSteps('並行して、ローカルLLMで春の俳句を作って、ローカルLLMで夏の俳句を作って、ローカルLLMでそれらを比べて、ローカルLLMで感想を書いて');
    expect(steps?.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined, undefined]);
  });

  it('only an explicit marker forms a group; no tool mention needed once it does', () => {
    expect(detectToolPinnedSteps('春について書いて、夏について書いて、最後にまとめて')).toBeNull();
    const steps = detectToolPinnedSteps('並列で、春について書いて、夏について書いて、最後に2つをまとめて');
    expect(steps).toEqual([
      { instruction: '春について書いて', parallelGroup: 'p1' },
      { instruction: '夏について書いて', parallelGroup: 'p1' },
      { instruction: '2つをまとめて' },
    ]);
  });

  it('「同時に」 leading a work clause starts the group too; 「それぞれ」 leading work is an ordinary word', () => {
    const lead = detectToolPinnedSteps('同時にローカルLLMで春について書いて、ローカルLLMで夏について書いて、最後にローカルLLMで両方をまとめて');
    expect(lead?.map((s) => [s.instruction, s.parallelGroup])).toEqual([
      ['春について書いて', 'p1'],
      ['夏について書いて', 'p1'],
      ['両方をまとめて', undefined],
    ]);
    const each = detectToolPinnedSteps('ローカルLLMでニュースを3つ集めて、それぞれ要約して、最後にまとめて');
    expect(each?.some((s) => s.parallelGroup)).toBe(false);
  });

  it('the explicit-sequence splitter does not swallow a marked group (「その後」+「最後に」)', () => {
    const draft = parseAgentNL('同時に、ローカルLLMで春について書いて、ローカルLLMで夏について書いて、その後ローカルLLMで2つを比べて、最後にローカルLLMで結論を書いて');
    expect(objSteps(draft.orchestrationSteps).map((s) => [s.instruction, s.parallelGroup])).toEqual([
      ['春について書いて', 'p1'],
      ['夏について書いて', 'p1'],
      ['2つを比べて', undefined],
      ['結論を書いて', undefined],
    ]);
  });

  it('a delivery clause never joins a group', () => {
    const steps = detectToolPinnedSteps('同時に、ローカルLLMで春について書いて、Xに投稿して、最後にローカルLLMで感想を書いて');
    expect(steps?.some((s) => s.parallelGroup)).toBe(false);
  });

  it('a mixed-tool chain keeps keyword routing for the agent-level tool', () => {
    const draft = parseAgentNL('同時に、パープレで春のニュースを集めて、パープレで夏のニュースを集めて、最後にローカルLLMで2つをまとめて');
    expect(objSteps(draft.orchestrationSteps).map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    expect(draft.toolExplicit).not.toBe(true);
  });
});

describe('tool phrase stripping', () => {
  it('strips only the instrument phrase of the pinned tool', () => {
    expect(stripToolPhrase('ローカルLLMで日本の春について書いて', { type: 'local' })).toBe('日本の春について書いて');
    expect(stripToolPhrase('Perplexityを使って最新ニュースを集めて', { type: 'perplexity' })).toBe('最新ニュースを集めて');
    expect(stripToolPhrase('Geminiの新機能をまとめて', { type: 'gemini-api' })).toBe('Geminiの新機能をまとめて');
    expect(stripToolPhrase('write a haiku with the local LLM', { type: 'local' })).toBe('write a haiku');
    // No pin, or nothing left → unchanged.
    expect(stripToolPhrase('ローカルLLMで書いて', undefined)).toBe('ローカルLLMで書いて');
    expect(stripToolPhrase('ローカルLLMで', { type: 'local' })).toBe('ローカルLLMで');
  });

  it('keeps the provider name on an explicit API-call clause', () => {
    expect(stripToolPhrase('PerplexityでAPIを呼んで論文を集めて', { type: 'perplexity' })).toBe('PerplexityでAPIを呼んで論文を集めて');
  });

  it('explicit-marker steps are stripped too, pin kept', () => {
    expect(tagStepsWithToolMentions(['パープレで論文を集めて', 'ローカルLLMで要約して', 'まとめて'])).toEqual([
      { instruction: '論文を集めて', tool: expect.objectContaining({ type: 'perplexity' }) },
      { instruction: '要約して', tool: { type: 'local' } },
      'まとめて',
    ]);
  });
});
