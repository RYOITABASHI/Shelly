/**
 * 2026-10-15: a tool the user NAMES in an agent request ("パープレで…",
 * "research X with Perplexity") is honored for a SINGLE-clause request (not
 * only per clause of a ≥2-clause chain), persisted as the agent's configured
 * tool, and honored on scheduled/unattended runs the same way as attended ones.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { parseAgentNL } from '@/lib/agent-nl-parser';
import { detectExplicitToolUsage } from '@/lib/agent-tool-mentions';
import {
  resolveConfirmedToolAndRunOn,
  suggestTool,
  suggestToolForDraft,
} from '@/lib/agent-tool-router';
import { draftToConfirmedAgentDraft } from '@/lib/agent-plan-summary';
import { applySlotAnswer } from '@/lib/agent-slot-fill';
import { resolveEscalationLadder, type LadderEnv } from '@/lib/agent-escalation-ladder';
import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import type { Agent, AgentOrchestrationStep, ToolChoice } from '@/store/types';

const PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };

const baseAgent = (over: Partial<Agent> = {}): Agent => ({
  id: 'named-tool',
  name: 'Named tool',
  description: '',
  prompt: '最新のLLM論文をリサーチして要約して',
  schedule: '0 8 * * *',
  tool: PPLX,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

/** Persist a draft exactly like the chat-native confirm boundary does. */
function persistTool(utterance: string, opts: { autonomous?: boolean; cloudConsent?: boolean; needsWeb?: boolean } = {}) {
  const draft = parseAgentNL(utterance);
  const confirmed = draftToConfirmedAgentDraft(draft);
  const sig = detectRouteSignals(confirmed.prompt);
  return resolveConfirmedToolAndRunOn({
    autonomous: opts.autonomous ?? false,
    runOn: confirmed.runOn,
    tool: confirmed.tool,
    cloudConsent: opts.cloudConsent ?? false,
    needsWeb: opts.needsWeb ?? sig.needsWeb,
    needsSearch: sig.needsSearch || sig.collects === true,
    toolExplicit: confirmed.toolExplicit,
  });
}

describe('detectExplicitToolUsage — instrumental mentions only', () => {
  it.each([
    ['パープレで最新のLLM論文をリサーチして要約して', 'perplexity'],
    ['パープレキシティで今日のAIニュースを調べて', 'perplexity'],
    ['Perplexityで量子コンピュータについて調べて', 'perplexity'],
    ['Perplexity APIを使って市場動向を調べて', 'perplexity'],
    ['research the latest LLM papers with Perplexity', 'perplexity'],
    ['Using perplexity, summarize this week in AI', 'perplexity'],
    ['Geminiで議事録を要約して', 'gemini-api'],
    ['use Gemini to draft a weekly report', 'gemini-api'],
    ['ローカルLLMで日記を要約して', 'local'],
    ['Codexでリポジトリのテストを直して', 'cli'],
  ])('%s → %s', (text, type) => {
    expect(detectExplicitToolUsage(text)?.type).toBe(type);
  });

  it.each([
    'Geminiの最新ニュースを集めて',
    "summarize Perplexity's new features",
    'ローカルファイルを整理して',
    '最新のLLM論文をリサーチして要約して',
  ])('topic-only / no mention: %s → undefined', (text) => {
    expect(detectExplicitToolUsage(text)).toBeUndefined();
  });
});

describe('single-clause parse pins the named tool (JA + EN)', () => {
  it('JA: パープレで… pins Perplexity with no orchestration steps', () => {
    const d = parseAgentNL('毎朝8時にパープレで最新のLLM論文をリサーチして要約して');
    expect(d.orchestrationSteps).toBeUndefined();
    expect(d.tool.type).toBe('perplexity');
    expect(d.toolExplicit).toBe(true);
  });

  it('JA: Perplexityで… overrides keyword scoring that would have picked another tool', () => {
    const text = '毎日9時にPerplexityで今日のニュースをまとめて通知して';
    const d = parseAgentNL(text);
    expect(d.orchestrationSteps).toBeUndefined();
    // Without the pin, keyword routing picks something else for this prompt.
    expect(suggestTool(d.prompt).tool.type).not.toBe('perplexity');
    expect(d.tool.type).toBe('perplexity');
    expect(d.toolExplicit).toBe(true);
  });

  it('EN: "research … with Perplexity" pins Perplexity', () => {
    const d = parseAgentNL('Every day at 9am research the latest AI chip news with Perplexity');
    expect(d.orchestrationSteps).toBeUndefined();
    expect(d.tool.type).toBe('perplexity');
    expect(d.toolExplicit).toBe(true);
  });

  it('other TOOL_MENTIONS work the same way (Gemini / local)', () => {
    expect(parseAgentNL('毎日9時にGeminiで今日の予定を整理して').tool.type).toBe('gemini-api');
    expect(parseAgentNL('毎日21時にローカルLLMで今日のメモを要約して').tool.type).toBe('local');
  });

  it('no explicit mention → unchanged keyword routing, no toolExplicit', () => {
    const d = parseAgentNL('毎日9時に今日のニュースをまとめて通知して');
    expect(d.toolExplicit).toBeUndefined();
    expect(d.tool).toEqual(suggestTool(d.prompt).tool);
  });

  it('multi-clause chain keeps per-step pins and today\'s agent-level routing', () => {
    const d = parseAgentNL('毎朝8時に、パープレで最新のAI論文を集めて、ローカルLLMで要約して');
    expect(d.orchestrationSteps).toBeDefined();
    const steps = normalizeSteps({ steps: d.orchestrationSteps as Array<string | AgentOrchestrationStep> });
    expect(steps[0].tool?.type).toBe('perplexity');
    expect(steps[1].tool?.type).toBe('local');
    expect(d.toolExplicit).toBeUndefined();
  });

  it('an explicit A/B comparison request keeps the ab-article-eval route', () => {
    expect(suggestToolForDraft('QwenとCodexで記事を書き比べて').tool.type).toBe('ab-article-eval');
  });

  it('slot-fill clarification keeps the pin from the original utterance', () => {
    const d = parseAgentNL('毎朝8時にパープレで調べて');
    const { draft } = applySlotAnswer('taskDetail', { ...d, prompt: '調べて' }, '最新のLLM論文について', 0);
    expect(draft.tool.type).toBe('perplexity');
    expect(draft.toolExplicit).toBe(true);
  });
});

describe('persistence at the confirm boundary', () => {
  it('non-autonomous RUN ON=Auto keeps the explicitly named tool instead of storing auto', () => {
    const { tool, runOn } = persistTool('毎朝8時にパープレで最新のLLM論文をリサーチして要約して');
    expect(tool.type).toBe('perplexity');
    expect(runOn).toBe('auto');
  });

  it('keyword-inferred tools are still stored as auto (re-scored each run, unchanged)', () => {
    expect(persistTool('毎日9時に今日のニュースをまとめて通知して').tool.type).toBe('auto');
  });

  it('autonomous + cloud consent keeps the named Perplexity on a research task without a web topic signal', () => {
    expect(persistTool('毎朝8時にパープレで量子計算について調べて', { autonomous: true, cloudConsent: true }).tool.type).toBe('perplexity');
  });

  it('autonomous without consent still fails closed to the Codex driver', () => {
    expect(persistTool('毎朝8時にパープレで量子計算について調べて', { autonomous: true, cloudConsent: false }).tool).toEqual({ type: 'cli', cli: 'codex' });
  });
});

describe('scheduled/unattended execution honors the pin like attended runs', () => {
  const KEYED: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, hasPerplexityKey: true };
  const NON_WEB_PROMPT = '量子計算について調べて';

  it('attended ladder: explicit Perplexity pin on a non-web prompt → [perplexity, codex], no local hallucination hop', () => {
    const l = resolveEscalationLadder(baseAgent({ prompt: NON_WEB_PROMPT }), KEYED);
    expect(l.tools.map((t) => t.type)).toEqual(['perplexity', 'cli']);
  });

  it('autonomous ladder with consent → Perplexity first (was local→Codex, pin silently dropped)', () => {
    const l = resolveEscalationLadder(
      baseAgent({ prompt: NON_WEB_PROMPT, autonomous: true }),
      { ...KEYED, autonomousCloudConsent: true },
    );
    expect(l.tools[0].type).toBe('perplexity');
  });

  it('keyless explicit pin keeps the pin (legible missing-key error) and logs it', () => {
    const l = resolveEscalationLadder(baseAgent({ prompt: NON_WEB_PROMPT }), { ...KEYED, hasPerplexityKey: false });
    expect(l.tools.map((t) => t.type)).toEqual(['perplexity', 'cli']);
    expect(l.why).toContain('key not configured');
  });

  it('scheduled .sh (non-autonomous) dispatches to the Perplexity API', () => {
    const s = generateRunScript(baseAgent({ prompt: NON_WEB_PROMPT }));
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('https://api.perplexity.ai/chat/completions');
  });

  it('scheduled .sh (autonomous + consent) keeps the named Perplexity even on a non-web prompt', () => {
    const s = generateRunScript(baseAgent({ prompt: NON_WEB_PROMPT, autonomous: true }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('https://api.perplexity.ai/chat/completions');
  });

  it('scheduled .sh (autonomous, no consent) refuses clearly and says how to enable it', () => {
    const s = generateRunScript(baseAgent({ prompt: NON_WEB_PROMPT, autonomous: true }));
    expect(s).toContain('[REFUSED]');
    expect(s).toContain('enable Autonomous Cloud consent');
    expect(s).not.toContain('https://api.perplexity.ai/chat/completions');
  });

  it('PlanSpec (scheduled multi-step): a parsed Perplexity step pin survives for a consented autonomous agent whose agent-level tool is local', () => {
    const d = parseAgentNL('毎朝8時に、パープレで量子計算の話題を集めて、ローカルLLMで要約して');
    const agent = baseAgent({
      prompt: d.prompt,
      autonomous: true,
      tool: { type: 'local' },
      orchestration: { steps: d.orchestrationSteps as Array<string | AgentOrchestrationStep> },
    });
    const spec = buildAgentPlanSpec(agent, { autonomousCloudConsent: true });
    expect(spec.steps!.list[0].tool?.type).toBe('perplexity');
    expect(spec.steps!.list[1].tool?.type).toBe('local');
  });

  it('codex-chain .sh (scheduled multi-step): a consented Perplexity step pin gets its own dispatch arm', () => {
    const agent = baseAgent({
      prompt: 'chain',
      autonomous: true,
      tool: { type: 'cli', cli: 'codex' },
      orchestration: {
        steps: [
          { instruction: 'パープレで量子計算の話題を集めて', tool: PPLX },
          'Codexでまとめて保存して',
        ],
      },
    });
    const withConsent = generateRunScript(agent, { autonomousCloudConsent: true });
    expect(withConsent).toContain('https://api.perplexity.ai/chat/completions');
    const noConsent = generateRunScript(agent);
    expect(noConsent).not.toContain('https://api.perplexity.ai/chat/completions');
  });
});

describe('review M1: consent covers a Perplexity pin only for web/research text', () => {
  it('a non-research step pin (「パープレで要約して」) is stripped even with consent, and the reason is logged', () => {
    const agent = baseAgent({
      prompt: '最新のAIニュースを集めて要約して',
      autonomous: true,
      tool: { type: 'local' },
      orchestration: {
        steps: [
          { instruction: 'パープレで最新のAIニュースを集めて', tool: PPLX },
          { instruction: 'パープレで要約して', tool: PPLX },
        ],
      },
    });
    const spec = buildAgentPlanSpec(agent, { autonomousCloudConsent: true });
    expect(spec.steps!.list[0].tool?.type).toBe('perplexity');
    expect(spec.steps!.list[1].tool).toBeUndefined();
    expect(spec.routeDecision.why).toContain('only for web/research tasks');
  });

  it('agent-level non-research Perplexity pin refuses unattended with the consent-scope reason', () => {
    const s = generateRunScript(baseAgent({ prompt: 'パープレで次の文章を要約して', autonomous: true }), { autonomousCloudConsent: true });
    expect(s).toContain('[REFUSED]');
    expect(s).toContain('only for web/research tasks');
  });

  it('ladder: autonomous consent + non-research Perplexity pin → Codex only, with the reason', () => {
    const l = resolveEscalationLadder(
      baseAgent({ prompt: 'この文章を要約して', autonomous: true }),
      { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true },
    );
    expect(l.tools.map((t) => t.type)).toEqual(['cli']);
    expect(l.why).toContain('only for web/research tasks');
  });

  it('collect/search verbs count as research intent', () => {
    const s = generateRunScript(baseAgent({ prompt: 'search for quantum computing sources', autonomous: true }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
  });
});
