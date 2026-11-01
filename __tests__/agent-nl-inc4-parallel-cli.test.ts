/**
 * Parallel CLI steps Inc4 (docs/superpowers/specs/2026-11-01-parallel-cli-steps-plan.md):
 * natural-language authoring of "Codex ∥ Claude Code, then merge".
 *
 * On-device finding (build 2761, EN UI): utterances A / B below never became
 * an agent draft — "explain how to fix …" inside the task matched the
 * capability-question heuristic ("how to"), so `@agent` answered with advice.
 * B also lost "Right now." (period) and the JA form lost the group because
 * 「直し方」 read as a transform verb (直し).
 *
 * Each utterance must parse to [Codex step ∥ Claude Code step (same group,
 * toolPinned cli), unpinned final merge step], a local agent-level tool, and
 * — through the confirm boundary and the PlanSpec — the attended executor
 * route with cli=2.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { parseAgentNL } from '@/lib/agent-nl-parser';
import { isCapabilityQuestionForAgentFlow, isLowConfidenceAgentDraft } from '@/lib/agent-llm-fallback';
import { nextMissingSlot } from '@/lib/agent-slot-fill';
import { detectToolPinnedSteps, isToolOnlyClause } from '@/lib/agent-orchestration';
import { draftToConfirmedAgentDraft, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { cliFanOutLocalSuggestion, resolveConfirmedToolAndRunOn } from '@/lib/agent-tool-router';
import { decideAttendedRoute, storedPlanSpecOpts } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import type { LadderEnv } from '@/lib/agent-escalation-ladder';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

const ENV: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };

const EN_A =
  'Right now, in parallel, using Codex list 3 improvement ideas for ~/demo/src/task.ts, using Claude Code explain how to fix the type errors in ~/demo/user.ts, then combine the two results into one memo';
const EN_B =
  'Right now. At the same time: list 3 improvement ideas for ~/demo/src/task.ts with Codex, explain how to fix the type errors in ~/demo/user.ts with Claude Code, and finally combine both into one memo';
const EN_AND =
  'In parallel, using Codex, list 3 improvement ideas for ~/demo/src/task.ts, and using Claude Code, explain how to fix the type errors in ~/demo/user.ts, then combine the two results into one memo';
const JA =
  '今すぐ、同時に、Codexで~/demo/src/task.tsの改善案を3つ挙げて、Claude Codeで~/demo/user.tsの型エラーの直し方を説明して、最後に2つの結果を1つのメモにまとめて';

const objSteps = (steps: Array<string | AgentOrchestrationStep> | undefined) =>
  (steps ?? []).map((s) => (typeof s === 'string' ? { instruction: s } : s));

/** The confirm boundary (hooks/use-ai-pane-dispatch.ts confirmAgentDraftInner)
 *  → the stored agent → its PlanSpec → decideAttendedRoute. */
function routeFor(draft: ParsedAgentDraft) {
  const confirmed = draftToConfirmedAgentDraft(draft);
  const { tool, runOn } = resolveConfirmedToolAndRunOn({
    autonomous: confirmed.autonomous,
    runOn: confirmed.runOn,
    tool: confirmed.tool,
    cloudConsent: false,
    needsWeb: false,
    needsSearch: false,
    toolExplicit: confirmed.toolExplicit,
  });
  const agent = {
    id: 'inc4-nl-agent',
    name: confirmed.name,
    description: '',
    prompt: confirmed.prompt,
    schedule: confirmed.schedule,
    tool,
    runOn,
    toolExplicit: confirmed.toolExplicit,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: confirmed.action,
    orchestration: { steps: confirmed.orchestrationSteps! },
  } as Agent;
  const plan = buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, ENV));
  return { agent, plan, route: decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV }) };
}

describe.each([
  ['EN A (on-device)', EN_A, 'combine the two results into one memo', true],
  ['EN B (on-device)', EN_B, 'combine both into one memo', true],
  ['EN ", and using X,"', EN_AND, 'combine the two results into one memo', false],
  ['EN "Right now, " + ", and using X,"', `Right now, ${EN_AND.charAt(0).toLowerCase()}${EN_AND.slice(1)}`, 'combine the two results into one memo', true],
  ['JA', JA, '2つの結果を1つのメモにまとめて', true],
])('%s', (_label, utterance, finalStep, runNow) => {
  const draft = parseAgentNL(utterance);
  const steps = objSteps(draft.orchestrationSteps);

  it('is an agent request, not a capability question, and needs no follow-up question', () => {
    expect(isCapabilityQuestionForAgentFlow(utterance)).toBe(false);
    // Without "right now" the draft has no schedule: like any unscheduled
    // draft it goes through the LLM field extraction first (unchanged).
    if (runNow) expect(isLowConfidenceAgentDraft(draft)).toBe(false);
    expect(nextMissingSlot(draft, { agentVaultPath: '/v' })).toBeNull();
  });

  it('Codex ∥ Claude Code (one group, both pinned), then an unpinned merge step', () => {
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ tool: { type: 'cli', cli: 'codex' }, toolPinned: true, parallelGroup: 'p1' });
    expect(steps[1]).toMatchObject({ tool: { type: 'cli', cli: 'claude' }, toolPinned: true, parallelGroup: 'p1' });
    expect(steps[0].instruction).toMatch(/~\/demo\/src\/task\.ts/);
    expect(steps[1].instruction).toMatch(/~\/demo\/user\.ts/);
    expect(steps[0].instruction).not.toMatch(/codex|right now|今すぐ|同時に|parallel|same time/i);
    expect(steps[1].instruction).not.toMatch(/claude|^and\b/i);
    expect(steps[2]).toEqual({ instruction: finalStep });
  });

  it('schedule: once for "right now" / 今すぐ, otherwise no schedule', () => {
    expect(draft.name).not.toMatch(/right now|今すぐ/i);
    if (runNow) expect(draft.schedule).toBe('once');
    else expect(draft.schedule).not.toBe('once');
  });

  it('agent-level tool is local (the merge step engine, executor-dispatchable plan.tool)', () => {
    expect(draft.tool).toEqual({ type: 'local' });
    expect(draft.toolExplicit).toBe(true);
    expect(draft.action.type).toBe('draft');
  });

  it('confirm summary shows both CLI steps on one parallel line', () => {
    const text = summarizeAgentDraftAsText(draft);
    const line = text.split('\n').find((l) => /^1\. /.test(l)) ?? '';
    expect(line).toMatch(/^1\. (?:In parallel|同時に):/);
    expect(line).toContain('[Codex CLI]');
    expect(line).toContain('[Claude Code]');
    expect(text).toMatch(/^2\. .*(?:combine|まとめ)/m);
    expect(text).not.toMatch(/^3\. /m);
  });

  it('confirm → PlanSpec → attended route: executor with cli=2', () => {
    const { plan, route } = routeFor(draft);
    expect((plan as unknown as { tool: { type: string } }).tool.type).toBe('local');
    const list = (plan.steps as { list: Array<{ parallelGroup?: string; tool?: unknown }> }).list;
    expect(list.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    expect(route).toMatchObject({ route: 'executor', cliSteps: 2, groupCount: 1 });
    expect(route.reason).toMatch(/cli=2$/);
  });
});

describe('capability questions still get an answer', () => {
  it.each([
    'how do I make an agent?',
    'explain how to make an agent',
    'can you tell me how to use the MONITOR pane',
    'show me how to set up Codex',
    'どうやってエージェントを作るの？',
    'こんなことできる？',
    '使い方を説明して',
  ])('%s', (q) => {
    expect(isCapabilityQuestionForAgentFlow(q)).toBe(true);
  });

  it('a how-to that is part of the task is not a question', () => {
    expect(isCapabilityQuestionForAgentFlow('Every morning at 8, research and explain how to keep a sourdough starter alive')).toBe(false);
    expect(isCapabilityQuestionForAgentFlow('毎朝8時に、Codexでgitのやり方を説明して')).toBe(false);
  });
});

describe('isToolOnlyClause: leading "and"', () => {
  it('", and using Claude Code," is a tool-only clause', () => {
    expect(isToolOnlyClause('and using Claude Code')).toBe(true);
    expect(isToolOnlyClause('and with Codex')).toBe(true);
    expect(isToolOnlyClause('and using Claude Code explain the bug')).toBe(false);
  });

  it('with a single tool scope the merge step is still pinned (unchanged)', () => {
    const steps = detectToolPinnedSteps('ローカルLLMで、同時に、春について書いて、夏について書いて、最後に2つの結果を1つにまとめて')!;
    expect(steps.map((s) => s.tool?.type)).toEqual(['local', 'local', 'local']);
  });
});

describe('agent-level local rule (cliFanOutLocalSuggestion)', () => {
  const codex = { instruction: 'a', tool: { type: 'cli' as const, cli: 'codex' as const }, toolPinned: true, parallelGroup: 'p1' };
  const claude = { instruction: 'b', tool: { type: 'cli' as const, cli: 'claude' as const }, toolPinned: true, parallelGroup: 'p1' };
  const localM = { instruction: 'm', tool: { type: 'local', model: 'Qwen3.5-2B-Q4_K_M' } } as AgentOrchestrationStep;

  it('CLI pins in an effective parallel group + unpinned or local final step → local', () => {
    expect(cliFanOutLocalSuggestion([codex, claude, 'merge'])?.tool).toEqual({ type: 'local' });
    expect(cliFanOutLocalSuggestion([codex, claude, localM])?.tool).toEqual({ type: 'local', model: 'Qwen3.5-2B-Q4_K_M' });
  });

  it('a CLI final step, a non-local pin, an unpinned CLI guess or no CLI pin → no change', () => {
    expect(cliFanOutLocalSuggestion([codex, claude])).toBeUndefined();
    expect(cliFanOutLocalSuggestion([codex, { instruction: 'r', tool: { type: 'perplexity' }, parallelGroup: 'p1' } as AgentOrchestrationStep, 'merge'])).toBeUndefined();
    expect(cliFanOutLocalSuggestion([{ ...codex, toolPinned: undefined }, claude, 'merge'])).toBeUndefined();
    expect(cliFanOutLocalSuggestion(['a', 'b'])).toBeUndefined();
  });

  it('a serial chain (no effective parallel group) → no change', () => {
    const { parallelGroup: _a, ...codexSerial } = codex;
    const { parallelGroup: _b, ...claudeSerial } = claude;
    expect(cliFanOutLocalSuggestion([codexSerial, claudeSerial, 'merge'])).toBeUndefined();
    expect(cliFanOutLocalSuggestion([codexSerial, 'summarize'])).toBeUndefined();
    expect(cliFanOutLocalSuggestion([codexSerial, localM])).toBeUndefined();
    // A group that never takes effect (one member, or only the final step) is serial too.
    expect(cliFanOutLocalSuggestion([codex, 'merge'])).toBeUndefined();
    // A parallel group without a CLI member does not count.
    expect(cliFanOutLocalSuggestion([codexSerial, { instruction: 'x', parallelGroup: 'p1' } as AgentOrchestrationStep, { instruction: 'y', parallelGroup: 'p1' } as AgentOrchestrationStep, 'merge'])).toBeUndefined();
  });

  it('serial NL 「Codexで…、要約して」 / "using Codex …, then summarize" keeps keyword scoring (not pinned local)', () => {
    for (const u of [
      'Codexで~/demoのgit logを確認して、要約して',
      'Right now, using Codex, check the git log in ~/demo, then summarize it in 3 lines',
    ]) {
      const d = parseAgentNL(u);
      const steps = objSteps(d.orchestrationSteps);
      expect(steps[0]).toMatchObject({ tool: { type: 'cli', cli: 'codex' } });
      expect(steps.some((s) => s.parallelGroup !== undefined)).toBe(false);
      expect(d.toolExplicit).toBeUndefined();
      expect(cliFanOutLocalSuggestion(d.orchestrationSteps)).toBeUndefined();
    }
  });

  it('the serial on-device demo (Codex, then Claude Code) keeps its scoring', () => {
    const d = parseAgentNL('Right now, using Codex, check the git log and file list in ~/demo, then using Claude Code, summarize this project in 3 lines');
    const steps = objSteps(d.orchestrationSteps);
    expect(steps.map((s) => (s.tool as { cli?: string } | undefined)?.cli)).toEqual(['codex', 'claude']);
    expect(d.schedule).toBe('once');
    expect(isCapabilityQuestionForAgentFlow(d.rawText)).toBe(false);
  });
});

describe('explicit ClosePaw clause is the action, not a step', () => {
  it('JA: 「最後にClosePawで…」 → intent/closepaw, the clause is dropped from the steps', () => {
    const d = parseAgentNL(
      '今すぐ、同時に、Codexで~/demo/src/task.tsの改善案を3つ挙げて、Claude Codeで~/demo/user.tsの型エラーの直し方を説明して、最後に2つの結果を1つのメモにまとめて、ClosePawでLINEのKeepメモに送って',
    );
    expect(d.action).toMatchObject({ type: 'intent', intentMode: 'closepaw', intentShareText: 'LINEのKeepメモに送って' });
    const steps = objSteps(d.orchestrationSteps);
    expect(steps.map((s) => s.instruction)).toEqual([
      '~/demo/src/task.tsの改善案を3つ挙げて',
      '~/demo/user.tsの型エラーの直し方を説明して',
      '2つの結果を1つのメモにまとめて',
    ]);
    expect(steps.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    expect(steps.some((s) => /closepaw/i.test(s.instruction))).toBe(false);
  });

  it('EN: "then have ClosePaw …" → intent/closepaw, the clause is dropped from the steps', () => {
    const d = parseAgentNL(
      'Right now, in parallel, using Codex list 3 improvement ideas for ~/demo/src/task.ts, using Claude Code explain how to fix the type errors in ~/demo/user.ts, then combine the two results into one memo, then have ClosePaw send it to my LINE Keep memo',
    );
    expect(d.action).toMatchObject({ type: 'intent', intentMode: 'closepaw', intentShareText: 'send it to my LINE Keep memo' });
    const steps = objSteps(d.orchestrationSteps);
    expect(steps).toHaveLength(3);
    expect(steps[2].instruction).toBe('combine the two results into one memo');
    expect(steps.some((s) => /closepaw/i.test(s.instruction))).toBe(false);
    expect(routeFor(d).route).toMatchObject({ route: 'executor', cliSteps: 2 });
  });

  it('JA serial: dropping the ClosePaw clause leaves the work steps only', () => {
    const d = parseAgentNL('パープレでAIニュースを集めて、ローカルLLMで3行に要約して、ClosePawでLINEのKeepメモに送って');
    expect(d.action).toMatchObject({ type: 'intent', intentMode: 'closepaw' });
    expect(objSteps(d.orchestrationSteps).map((s) => s.instruction)).toEqual(['AIニュースを集めて', '3行に要約して']);
  });

  it('dropping it below 2 steps falls back to a single-prompt agent', () => {
    const d = parseAgentNL('Codexで~/demo/src/task.tsの改善案を3つ挙げて、ClosePawでLINEのKeepメモに送って');
    expect(d.action).toMatchObject({ type: 'intent', intentMode: 'closepaw' });
    expect(d.orchestrationSteps).toBeUndefined();
  });
});
