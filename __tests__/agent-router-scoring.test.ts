import { detectRouteSignals, scoreRoutes } from '@/lib/agent-router-scoring';
import { resolveAgentRoute } from '@/lib/agent-tool-router';
import { Agent, ToolChoice } from '@/store/types';

const mkAgent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

describe('detectRouteSignals', () => {
  it('classifies by category with keyword priority code > research > prose > transform', () => {
    expect(detectRouteSignals('review my github pull request').category).toBe('code');
    expect(detectRouteSignals('find the latest research paper').category).toBe('research');
    expect(detectRouteSignals('write a blog article').category).toBe('prose');
    expect(detectRouteSignals('要約して整形して').category).toBe('transform');
    expect(detectRouteSignals('say hello').category).toBe('general');
  });

  it('short Latin keywords match on a word boundary (not substring)', () => {
    // "previous" must NOT match 'pr', "report" must NOT match 'repo' — this bit
    // orchestration's "# Results from previous steps" scaffolding.
    expect(detectRouteSignals('use results from previous steps').category).toBe('general');
    expect(detectRouteSignals('write a weather report').category).not.toBe('code');
    // a bare "pr" / "repo" as a word still matches code.
    expect(detectRouteSignals('open a pr').category).toBe('code');
  });

  it('raises reasoning weight on complexity markers and length', () => {
    expect(detectRouteSignals('hi').reasoningWeight).toBeLessThan(0.3);
    expect(detectRouteSignals('deeply analyze and compare the strategy').reasoningWeight).toBeGreaterThan(0.4);
  });

  it('flags search need for research / fresh-info tasks', () => {
    expect(detectRouteSignals('最新ニュースを調べて').needsSearch).toBe(true);
    expect(detectRouteSignals('rename this variable').needsSearch).toBe(false);
  });

  it('flags needsWeb only for collect + fresh (web-mandatory), not summarize or trivial freshness', () => {
    // Collect CURRENT info → only a live web fetch can do it.
    expect(detectRouteSignals('ニュースを集めて').needsWeb).toBe(true);
    expect(detectRouteSignals('collect the latest news').needsWeb).toBe(true);
    expect(detectRouteSignals('最新情報を収集して').needsWeb).toBe(true);
    // Summarize the news = transform, NO collection verb → not web-mandatory (stays cheap/local).
    expect(detectRouteSignals('ニュースを要約して').needsWeb).toBe(false);
    // Freshness alone (no collection verb) is a weak signal → not web-mandatory.
    expect(detectRouteSignals('今日の天気は？').needsWeb).toBe(false);
    // Collection without freshness → not web-mandatory.
    expect(detectRouteSignals('資料を集めて整理して').needsWeb).toBe(false);
  });

  it('classifies the web domain — academic (Perplexity) vs general (Gemini)', () => {
    expect(detectRouteSignals('最新の論文を集めて').webDomain).toBe('academic');
    expect(detectRouteSignals('ニュースを集めて').webDomain).toBe('general');
  });
});

describe('scoreRoutes — deterministic + offline', () => {
  it('returns identical output for the same prompt', () => {
    const a = scoreRoutes('summarize the article');
    const b = scoreRoutes('summarize the article');
    expect(a.tool).toEqual(b.tool);
    expect(a.why).toBe(b.why);
    expect(a.confidence).toBe(b.confidence);
  });

  it('routes code → Codex, research → Perplexity, transform → Local', () => {
    expect(scoreRoutes('review the github pull request').tool.type).toBe('cli');
    expect(scoreRoutes('summarize the research paper with citations').tool.type).toBe('perplexity');
    expect(scoreRoutes('要約して箇条書きにして').tool.type).toBe('local');
  });

  it('keeps "summarize the news" a transform task → on-device (not paid research)', () => {
    // Regression: "news/最新" used to be a research keyword, so summarizing news
    // wrongly routed to Perplexity (paid, key-required) and failed on device.
    expect(detectRouteSignals('ニュースを簡潔に要約').category).toBe('transform');
    expect(scoreRoutes('ニュースを簡潔に要約').tool.type).toBe('local');
    expect(scoreRoutes('summarize the news in bullets').tool.type).toBe('local');
    // Genuine research still routes to Perplexity.
    expect(scoreRoutes('最新の論文を調べて出典付きでまとめて').tool.type).toBe('perplexity');
  });

  it('keeps simple general tasks on-device (on-device-first, no widened cloud)', () => {
    expect(scoreRoutes('say hi').tool.type).toBe('local');
  });

  it('routes web-mandatory collection to a web backend, not a hallucinating local LLM', () => {
    // Collect current news → Gemini (grounded), NOT local — local has no web access.
    expect(scoreRoutes('ニュースを集めて').tool.type).toBe('gemini-api');
    expect(scoreRoutes('collect the latest tech news').tool.type).toBe('gemini-api');
    // Academic web-mandatory → Perplexity.
    expect(scoreRoutes('最新の論文を集めて').tool.type).toBe('perplexity');
    // Summarize the news (no collection) stays a cheap on-device transform.
    expect(scoreRoutes('ニュースを要約して').tool.type).toBe('local');
  });

  it('does not send a trivial freshness question to the paid deep-research backend', () => {
    // general + a freshness word is a WEAK search signal — must not pick Perplexity.
    expect(scoreRoutes('what is the current weather today').tool.type).not.toBe('perplexity');
    expect(scoreRoutes('今日の天気は？').tool.type).not.toBe('perplexity');
  });

  it('lets a heavy-reasoning general task earn a cloud route', () => {
    const out = scoreRoutes('analyze and compare the long-term strategy in depth, weighing many tradeoffs across the whole plan');
    expect(out.tool.type).not.toBe('local');
  });

  it('records confidence and the full candidate list for the audit log', () => {
    const out = scoreRoutes('review the github pull request');
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(out.candidates.length).toBe(4);
    expect(out.candidates[0].score).toBeGreaterThanOrEqual(out.candidates[1].score);
  });
});

describe('hard guards always win over the scorer', () => {
  it('secret-guard forces on-device regardless of a code-task score', () => {
    const r = resolveAgentRoute(mkAgent({ prompt: 'review github PR with key sk-ant-api03-AAAABBBBCCCCDDDD' }));
    expect(r.decision.guard).toBe('secret');
    expect(r.decision.route).toBe('on-device');
    expect(r.decision.noCloudFallback).toBe(true);
  });

  it('manual on-device pin overrides the scorer', () => {
    const r = resolveAgentRoute(mkAgent({ prompt: 'review github PR', runOn: 'on-device' }));
    expect(r.decision.guard).toBe('manual-pin');
    expect(r.decision.route).toBe('on-device');
  });

  it('manual cloud pin overrides the scorer', () => {
    const r = resolveAgentRoute(mkAgent({ prompt: '要約して', runOn: 'cloud' }));
    expect(r.decision.guard).toBe('manual-pin');
    expect(r.decision.route).toBe('cloud');
  });

  it('autonomous auto resolves to OAuth Codex, not the scorer', () => {
    const r = resolveAgentRoute(mkAgent({ prompt: '要約して', autonomous: true }));
    expect(r.decision.guard).toBe('autonomous-policy');
  });
});

describe('resolveAgentRoute attaches scorer metadata for auto agents', () => {
  it('records the score on the decision and uses scorer/keyword guard', () => {
    const r = resolveAgentRoute(mkAgent({ prompt: 'review the github pull request' }));
    expect(r.decision.score).toBeDefined();
    expect(r.decision.score?.candidates.length).toBe(4);
    expect(['scorer', 'keyword']).toContain(r.decision.guard);
  });
});
