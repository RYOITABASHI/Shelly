jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { parseAgentNL, type ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { hasDraftAssumptions, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { markAntigravitySteps, stripAntigravityInstrument } from '@/lib/agent-antigravity';
import { describeDraftTool } from '@/lib/agent-tool-router';
import { tFor } from '@/lib/i18n';

const AGY_RE = /antigravity|アンチグラビティ|\bagy\b/i;

function stepTexts(d: ParsedAgentDraft): string[] {
  return (d.orchestrationSteps ?? []).map((s) => (typeof s === 'string' ? s : s.instruction));
}

function noAgyAnywhere(d: ParsedAgentDraft): void {
  expect(d.name).not.toMatch(AGY_RE);
  expect(d.prompt).not.toMatch(AGY_RE);
  for (const s of stepTexts(d)) expect(s).not.toMatch(AGY_RE);
  // Never a pin or a ToolChoice for it.
  expect(JSON.stringify(d.tool)).not.toMatch(AGY_RE);
  for (const s of d.orchestrationSteps ?? []) {
    if (typeof s !== 'string') expect(JSON.stringify(s.tool ?? null)).not.toMatch(AGY_RE);
  }
}

describe('stripAntigravityInstrument', () => {
  it.each([
    ['Antigravityでニュースを集めて', 'ニュースを集めて'],
    ['Antigravityを使ってニュースを集めて', 'ニュースを集めて'],
    ['agyで今日のニュースを要約して', '今日のニュースを要約して'],
    ['Summarize the news using Antigravity', 'Summarize the news'],
    ['Using the Antigravity CLI, summarize the news', 'summarize the news'],
    ['Collect the news with agy and save it', 'Collect the news and save it'],
    ['Antigravity CLI: summarize the news', 'summarize the news'],
    ['Use Antigravity to summarize the news', 'summarize the news'],
  ])('%s → %s', (input, expected) => {
    expect(stripAntigravityInstrument(input)).toBe(expected);
  });

  it.each([
    'Antigravityについて調べて',
    'Antigravityでの評判を調べて',
    'Antigravityで作ったアプリを説明して',
    'Summarize the news on Antigravity',
    'Describe the app built with Antigravity',
    'Compare Codex with Antigravity',
    'ニュースを集めて',
  ])('not an instrument: %s', (input) => {
    expect(stripAntigravityInstrument(input)).toBeNull();
  });

  it('a clause that only names it is empty', () => {
    expect(stripAntigravityInstrument('Antigravityで')).toBe('');
    expect(stripAntigravityInstrument('using Antigravity')).toBe('');
  });

  it('markAntigravitySteps: a tool-only clause covers the following unpinned steps', () => {
    const r = markAntigravitySteps(['Antigravityで', 'Aを書いて', { instruction: 'Bを書いて', tool: { type: 'local' } }]);
    expect(r.steps).toEqual(['Aを書いて', { instruction: 'Bを書いて', tool: { type: 'local' } }]);
    expect(r.flagged).toEqual([0]);
  });
});

describe('parseAgentNL — Antigravity notice', () => {
  it('JA two-step: step 1 named Antigravity, step 2 keeps its local LLM pin', () => {
    const d = parseAgentNL('Antigravityで今日のAIニュースを集めて、ローカルLLMで3行に要約して');
    expect(d.orchestrationSteps).toHaveLength(2);
    expect(stepTexts(d)[0]).toBe('今日のAIニュースを集めて');
    const s0 = d.orchestrationSteps![0];
    expect(typeof s0 === 'string' || s0.tool === undefined).toBe(true);
    const s1 = d.orchestrationSteps![1];
    expect(typeof s1 !== 'string' && s1.tool).toEqual({ type: 'local' });
    expect(d.antigravityRequested).toEqual({ steps: [0] });
    noAgyAnywhere(d);
    expect(hasDraftAssumptions(d)).toBe(true);

    const engine = describeDraftTool(d, false).label;
    const summary = summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false });
    expect(summary).toContain(tFor('ja', 'agentplan.antigravity_step_note', { n: 1, engine }));
    expect(summary).toContain('手順 1 は');
    expect(summary).not.toContain('手順 2 は');
  });

  it('EN two-step: step 2 named Antigravity and runs on the agent engine', () => {
    const d = parseAgentNL('Research the latest AI papers with Perplexity, then summarize them using Antigravity');
    expect(d.orchestrationSteps).toHaveLength(2);
    const s0 = d.orchestrationSteps![0];
    expect(typeof s0 !== 'string' && s0.tool?.type).toBe('perplexity');
    expect(stepTexts(d)[1]).toBe('summarize them');
    expect(d.antigravityRequested).toEqual({ steps: [1] });
    noAgyAnywhere(d);

    const engine = describeDraftTool(d, false).label;
    const summary = summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false });
    expect(summary).toContain(`⚠ Antigravity can't run agent steps, so step 2 will run on ${engine}.`);
  });

  it('JA single-step: whole-task line, no step number, default engine', () => {
    const baseline = parseAgentNL('今日のAIニュースを3行に要約して');
    const d = parseAgentNL('agyで今日のAIニュースを3行に要約して');
    expect(d.orchestrationSteps).toBeUndefined();
    expect(d.antigravityRequested).toEqual({ steps: [] });
    expect(d.prompt).toBe('今日のAIニュースを3行に要約して');
    expect(d.tool).toEqual(baseline.tool);
    expect(d.toolExplicit).toBeUndefined();
    noAgyAnywhere(d);

    const engine = describeDraftTool(d, false).label;
    const summary = summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false });
    expect(summary).toContain(tFor('ja', 'agentplan.antigravity_task_note', { engine }));
    expect(summary).not.toMatch(/手順 \d+ は/);
  });

  it('EN single-step: whole-task line in English', () => {
    const baseline = parseAgentNL('Summarize the top AI news in 3 lines');
    const d = parseAgentNL('Using Antigravity, summarize the top AI news in 3 lines');
    expect(d.antigravityRequested).toEqual({ steps: [] });
    expect(d.tool).toEqual(baseline.tool);
    noAgyAnywhere(d);
    const engine = describeDraftTool(d, false).label;
    const summary = summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false });
    expect(summary).toContain(`⚠ Antigravity can't run agent steps, so this task will run on ${engine}.`);
  });

  it('a topic mention is not a request', () => {
    const d = parseAgentNL('Antigravityについての最新ニュースを要約して');
    expect(d.antigravityRequested).toBeUndefined();
    expect(summarizeAgentDraftAsText(d)).not.toContain('⚠ Antigravity');
  });

  it('Codex / Claude Code pins are unchanged', () => {
    const codex = parseAgentNL('Codexでリポジトリのテストを実行して、ローカルLLMで結果を要約して');
    const s0 = codex.orchestrationSteps![0];
    expect(typeof s0 !== 'string' && s0.tool).toEqual({ type: 'cli', cli: 'codex' });
    expect(codex.antigravityRequested).toBeUndefined();

    const claude = parseAgentNL('Claude Codeでリポジトリのテストを実行して、ローカルLLMで結果を要約して');
    const c0 = claude.orchestrationSteps![0];
    expect(typeof c0 !== 'string' && c0.tool).toEqual({ type: 'cli', cli: 'claude' });
    expect(claude.antigravityRequested).toBeUndefined();
    expect(summarizeAgentDraftAsText(claude)).not.toContain('Antigravity');
  });
});
