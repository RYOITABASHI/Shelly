jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { normalizeSteps, REVIEW_OUTPUT_CONTRACT } from '@/lib/agent-orchestration';
import { ARTICLE_MATERIAL_MISSING_MARKER, buildArticlePipeline } from '@/lib/agent-pipeline-presets';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { draftToConfirmedAgentDraft, isAutoRegisterEligibleDraft, shouldUseChatConfirm, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { nextMissingSlot } from '@/lib/agent-slot-fill';
import { resolveConfirmedToolAndRunOn } from '@/lib/agent-tool-router';
import { agentToParsedAgentDraft, applyDraftPatch } from '@/lib/agent-draft-patch';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

// Article pipeline Inc 1: the AI×STEAM preset, the NL trigger, the plain-text
// confirm and the plan it produces.

const root = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(path.join(root, 'scripts', 'shelly-plan-executor.js'));

const UTTERANCE = 'AI×STEAMの記事パイプラインを作って';

function presetSteps(): AgentOrchestrationStep[] {
  return buildArticlePipeline('ai-steam').orchestration.steps as AgentOrchestrationStep[];
}

function presetAgent(): Agent {
  const preset = buildArticlePipeline('ai-steam');
  return {
    id: 'agent-article',
    name: preset.name,
    description: '',
    prompt: preset.prompt,
    schedule: preset.schedule,
    tool: preset.tool!,
    outputPath: preset.output!.outputPath,
    outputTemplate: preset.output!.outputTemplate,
    action: preset.action,
    orchestration: preset.orchestration,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
  };
}

describe('buildArticlePipeline', () => {
  it('builds research, write, two review rounds and assemble', () => {
    const steps = presetSteps();
    expect(steps).toHaveLength(7);
    expect(steps.map((s) => s.handoff?.kind)).toEqual([undefined, undefined, 'review', 'revise', 'review', 'revise', undefined]);
    expect(steps.map((s) => s.handoff?.of)).toEqual([undefined, undefined, [0, 1], [1, 2], [0, 3], [3, 4], undefined]);
    expect(steps.map((s) => s.handoff?.round)).toEqual([undefined, undefined, 1, 1, 2, 2, undefined]);
    expect(steps[6].local).toMatchObject({ kind: 'assemble', parts: [[1, 3, 5]] });
  });

  it('runs daily, attended-free, without memory, into the vault', () => {
    const preset = buildArticlePipeline('ai-steam');
    expect(preset.autonomous).toBe(false);
    expect(preset.memoryOff).toBe(true);
    expect(preset.orchestration.longform).toBe(true);
    expect(preset.schedule).toBe('0 6 * * *');
    expect(preset.output?.outputPath).toBe('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/');
    expect(preset.output?.outputTemplate).toBe('{date}-ai-steam.md');
  });

  it('pins HTTP engines: research on Gemini, the reviewer on a different engine than the writer, no Perplexity', () => {
    const steps = presetSteps();
    expect(steps[0].tool?.type).toBe('gemini-api');
    const writer = steps[1].tool?.type;
    expect(steps[3].tool?.type).toBe(writer);
    expect(steps[5].tool?.type).toBe(writer);
    expect(steps[2].tool?.type).not.toBe(writer);
    expect(steps[4].tool?.type).not.toBe(writer);
    const http = ['gemini-api', 'cerebras', 'groq'];
    steps.slice(0, 6).forEach((s) => expect(http).toContain(s.tool?.type));
    expect(steps[6].tool).toBeUndefined();
  });

  it('has no publish path and no shell: a draft action, no CLI step, no api-call step', () => {
    const preset = buildArticlePipeline('ai-steam');
    expect(preset.action).toEqual({ type: 'draft' });
    presetSteps().forEach((s) => {
      expect(s.apiCall).toBeUndefined();
      expect(s.tool?.type).not.toBe('cli');
    });
    expect(JSON.stringify(preset)).not.toMatch(/social-post|webhook|publish|ghost|twitter|\bbash\b/i);
  });

  it('survives normalization: instructions fit the 500-character cap, the review contract stays whole', () => {
    const preset = buildArticlePipeline('ai-steam');
    presetSteps().forEach((s) => expect(s.instruction.length).toBeLessThanOrEqual(500));
    const normalized = normalizeSteps(preset.orchestration);
    expect(normalized).toHaveLength(7);
    expect(normalized[2].instruction.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true);
    expect(normalized[4].instruction.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true);
    expect(normalized[2].handoff).toEqual({ kind: 'review', of: [0, 1], round: 1 });
    expect(normalized[6].local).toMatchObject({ stream: 'ai-steam' });
    expect(normalized[6].tool).toBeUndefined();
  });

  it('carries the AI×STEAM rules', () => {
    const preset = buildArticlePipeline('ai-steam');
    expect(preset.prompt).toContain('プレプリント');
    expect(preset.prompt).toContain('査読前か査読後か');
    expect(preset.prompt).toContain('全文訳はしない');
    expect(preset.prompt).toContain('CC-BY');
    const write = presetSteps()[1].instruction;
    expect(write).toContain('本人の見解');
    expect(write).toContain(ARTICLE_MATERIAL_MISSING_MARKER);
  });

  it('tells the reviewer to check against the research text, which is all it can see', () => {
    const review = presetSteps()[2].instruction;
    expect(review).toContain('調査メモの本文と照合');
    expect(review).toContain('原文ページはあなたには見えない');
    // A short review using this wording must not read as "data unavailable".
    expect(executor.isLowQualityCompletion(`VERDICT: PASS\n${review.split('\n')[0]}`)).toBe(false);
  });

  it('the base prompt stays neutral, so the plan prompt is not turned into a link-list task', () => {
    expect(detectRouteSignals(buildArticlePipeline('ai-steam').prompt).needsWeb).toBe(false);
  });

  it('only the first step is web research, by instruction', () => {
    const steps = presetSteps();
    expect(executor.isResearchStep(steps[0].instruction, 'gemini-api')).toBe(true);
    expect(executor.isResearchStep(steps[1].instruction, 'gemini-api')).toBe(false);
  });

  it('the chain text asks for the last 30 days', () => {
    const preset = buildArticlePipeline('ai-steam');
    const text = [preset.prompt, ...presetSteps().map((s) => s.instruction)].join('\n');
    expect(executor.detectRecency(text)).toBe('month');
  });
});

describe('the NL trigger', () => {
  it('turns the request into the article preset, keeping steps and autonomous:false', () => {
    const d = parseAgentNL(UTTERANCE);
    expect(d.autonomous).toBe(false);
    expect(d.longform).toBe(true);
    expect(d.orchestrationSteps).toHaveLength(7);
    const steps = d.orchestrationSteps as AgentOrchestrationStep[];
    expect(steps[0].tool?.type).toBe('gemini-api');
    expect(steps[2].handoff?.kind).toBe('review');
    expect(steps[6].local?.kind).toBe('assemble');
    expect(d.tool.type).toBe('gemini-api');
    expect(d.toolExplicit).toBe(true);
    expect(d.action).toEqual({ type: 'draft' });
    expect(d.presetOutput?.outputPath).toBe('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/');
    expect(d.schedule).toBe('0 6 * * *');
    expect(d.scheduleLabel).toBe('毎日 6:00');
    expect(d.scheduleConfident).toBe(true);
  });

  it("takes the user's own schedule", () => {
    expect(parseAgentNL('毎日7時にAI×STEAMの記事パイプラインを作って').schedule).toBe('0 7 * * *');
  });

  it('never picks up memory from the utterance', () => {
    expect(parseAgentNL('AI×STEAMの記事パイプラインを作って、覚えておいて').memory).toBeUndefined();
  });

  it('stays a draft and says so when asked to post', () => {
    const d = parseAgentNL('AI×STEAMの記事パイプラインを作ってXに投稿して');
    expect(d.action).toEqual({ type: 'draft' });
    expect(d.actionCaveat).toContain('投稿しません');
  });

  it('REGRESSION: the collection preset and other pipelines are unchanged', () => {
    const steam = parseAgentNL('STEAM×AIのパイプラインを作って');
    expect(steam.autonomous).toBe(true);
    expect(steam.longform).toBeUndefined();
    expect(steam.orchestrationSteps).toHaveLength(4);
    expect(typeof steam.orchestrationSteps?.[0]).toBe('string');
    expect(steam.scheduleLabel).toBe('毎週 月・金 8:00');
    expect(parseAgentNL('量子コンピュータの記事パイプライン').longform).toBeUndefined();
    expect(parseAgentNL('CI/CDパイプラインのエラーを直して').orchestrationSteps).toBeUndefined();
  });
});

describe('the confirmation', () => {
  it('is plain chat text and always needs the typed OK, never a card', () => {
    const d = parseAgentNL(UTTERANCE);
    expect(shouldUseChatConfirm(d)).toBe(true);
    expect(isAutoRegisterEligibleDraft(d)).toBe(false);
  });

  it('asks nothing more: the output folder is the preset\'s', () => {
    expect(nextMissingSlot(parseAgentNL(UTTERANCE), {} as any)).toBeNull();
  });

  it('states where it saves and shows the engines, without the output contract', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL(UTTERANCE), undefined, false, { cloudConsent: false });
    expect(text).toContain('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/');
    expect(text).toContain('Gemini');
    expect(text).not.toContain('Output contract');
  });

  it('hands the chain, the longform flag and the output to registration', () => {
    const confirmed = draftToConfirmedAgentDraft(parseAgentNL(UTTERANCE));
    expect(confirmed.autonomous).toBe(false);
    expect(confirmed.longform).toBe(true);
    expect(confirmed.presetOutput?.outputTemplate).toBe('{date}-ai-steam.md');
    expect(confirmed.orchestrationSteps).toHaveLength(7);
    const { tool } = resolveConfirmedToolAndRunOn({
      autonomous: confirmed.autonomous,
      runOn: confirmed.runOn,
      tool: confirmed.tool,
      cloudConsent: false,
      needsWeb: false,
      toolExplicit: confirmed.toolExplicit,
    });
    expect(tool.type).toBe('gemini-api');
  });

  it('an edit keeps the longform flag', () => {
    expect(agentToParsedAgentDraft(presetAgent()).longform).toBe(true);
  });

  it('the hook passes the preset output and the flag through (no hardcoded path for a preset)', () => {
    const hook = fs.readFileSync(path.join(root, 'hooks', 'use-ai-pane-dispatch.ts'), 'utf8');
    expect(hook).toContain('outputPath: confirmed.presetOutput?.outputPath ?? `$HOME/.shelly/agents/${safeName}/output.md`');
    expect(hook).toContain('outputTemplate: confirmed.presetOutput.outputTemplate');
    expect(hook).toContain("...(confirmed.longform ? { longform: true } : {})");
  });
});

describe('the plan', () => {
  const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(presetAgent())));

  it('carries longform, the chain and the budget', () => {
    expect(plan.steps.longform).toBe(true);
    expect(plan.steps.list).toHaveLength(7);
    expect(plan.steps.budget.maxSteps).toBe(7);
    expect(plan.steps.list[2].tool.type).toBe('cerebras');
    expect(plan.steps.list[2].handoff).toEqual({ kind: 'review', of: [0, 1], round: 1 });
    expect(plan.steps.list[6].local.parts).toEqual([[1, 3, 5]]);
    expect(executor.normalizeStepLocal(plan.steps.list[6].local, 6)).toEqual(plan.steps.list[6].local);
    expect(plan.steps.isolation).toBeUndefined();
    expect(() => executor.validatePlan(plan)).not.toThrow();
  });

  it('is not autonomous and keeps the pinned tool', () => {
    expect(plan.agent.autonomous).toBe(false);
    expect(plan.tool.type).toBe('gemini-api');
  });

  it('never reaches Perplexity through the ladder (no new costs)', () => {
    expect(plan.toolLadder.map((t: { type: string }) => t.type)).not.toContain('perplexity');
  });

  it('saves to the agent\'s own output folder, not the global one', () => {
    expect(plan.output.useGlobalOutput).toBe(false);
    expect(plan.output.outputDir).toBe('/sdcard/Documents/ObsidianVault/50_Drafts/Steam/');
    expect(plan.output.outputNameTemplate).toBe('{date}-ai-steam.md');
    expect(plan.action.type).toBe('draft');
  });

  it('keeps the base prompt out of the research-collection wrapper', () => {
    expect(plan.prompt).not.toContain('research-collection agent');
    expect(plan.prompt).toContain('AI×STEAM');
  });

  it('REGRESSION: a chain without longform has no key', () => {
    const agent = { ...presetAgent(), orchestration: { steps: ['collect', 'summarize'] } };
    expect('longform' in buildAgentPlanSpec(agent).steps!).toBe(false);
  });
});

describe('editing a longform draft', () => {
  it.each(['通知して', 'https://example.com/hook にPOSTして', 'bashで実行して'])('%s cannot change its action', (reply) => {
    const patched = applyDraftPatch(parseAgentNL(UTTERANCE), reply);
    expect(patched?.patchedDraft.action ?? { type: 'draft' }).toEqual({ type: 'draft' });
  });

  it('cannot turn it autonomous', () => {
    const patched = applyDraftPatch(parseAgentNL(UTTERANCE), '承認なしで実行して');
    expect(patched?.patchedDraft.autonomous ?? false).toBe(false);
  });

  it('REGRESSION: an ordinary draft can still change its action', () => {
    const draft = parseAgentNL('毎朝ニュースをまとめて保存して');
    expect(applyDraftPatch(draft, '通知して')?.patchedDraft.action.type).toBe('notify');
  });
});
