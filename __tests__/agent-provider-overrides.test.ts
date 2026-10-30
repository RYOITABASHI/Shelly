/**
 * Provider overrides (DEFERRED.md「タスクごとのプロバイダを自由に指定・途中で変更
 * する」): chat step-provider edits, the explicit paid pin under a ¥0 loop, the
 * overrides.json model + vetting, the fold decision, and the MONITOR picker
 * writing the file.
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import {
  applyCorrectionToJustRegisteredAgent,
  applyDraftPatch,
  detectStepProviderNotice,
  tryPatchStepTools,
} from '@/lib/agent-draft-patch';
import { summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { applyContinuousProviderPolicy, explicitPaidStepPins, normalizeContinuousConfig } from '@/lib/agent-continuous';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import {
  OVERRIDE_FOLD_MAX_AGE_MS,
  __resetAppWrittenOverridesForTests,
  buildWriteOverridesCommand,
  decideOverrideFold,
  foldOverridesIntoAgent,
  isAppWrittenOverrides,
  mergeProviderOverride,
  noteAppWrittenOverrides,
  overrideToolForStep,
  parseOverridesListing,
  parseProviderOverrides,
  vetOverrideToolForAgent,
} from '@/lib/agent-provider-overrides';
import { applyProviderPick } from '@/lib/monitor-provider-pick';
import { touchesProtectedPolicyFiles } from '@/lib/agent-boundary-policy';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

// Summary lines: 1 = 同時に: AIニュース ／ 論文, 2 = 要約して, 3 = [Local LLM] ファイルに保存して
const STEPS: Array<string | AgentOrchestrationStep> = [
  { instruction: 'AIニュースを集めて', parallelGroup: 'g1' },
  { instruction: '論文を集めて', parallelGroup: 'g1' },
  '要約して',
  { instruction: 'ファイルに保存して', tool: { type: 'local' } },
];

function draft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'AI briefing',
    prompt: 'AIニュースと論文を集めて要約して保存',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: '毎日 08:00',
    action: { type: 'draft' },
    tool: { type: 'auto' },
    toolLabel: 'Auto',
    rawText: 'AIニュースと論文を集めて要約して保存',
    orchestrationSteps: STEPS,
    ...overrides,
  };
}

const toolOf = (s: string | AgentOrchestrationStep | undefined) => (s && typeof s !== 'string' ? s.tool : undefined);

describe('chat step-provider edit (tryPatchStepTools / applyDraftPatch)', () => {
  it.each([
    ['2番目をCodexで', 2, { type: 'cli', cli: 'codex' }],
    ['3番目をGeminiにして', 3, { type: 'gemini-api' }],
    ['ステップ2はPerplexityでお願いします', 2, { type: 'perplexity' }],
    ['要約のステップはPerplexityで', 2, { type: 'perplexity' }],
    ['並列の2つ目をセレブラスで', 1, { type: 'cerebras' }],
    ['並列の1つ目をGroqで', 0, { type: 'groq' }],
    ['make step 2 Codex', 2, { type: 'cli', cli: 'codex' }],
    ['switch the third step to Gemini', 3, { type: 'gemini-api' }],
    ['use Perplexity for step 2', 2, { type: 'perplexity' }],
    ['switch the 要約 step to Perplexity', 2, { type: 'perplexity' }],
    ['the second parallel branch on Groq', 1, { type: 'groq' }],
  ])('%s → step index %i (ordinals are summary lines)', (text, index, tool) => {
    const r = applyDraftPatch(draft(), text);
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual([`step:${index}`]);
    expect(toolOf(r!.patchedDraft.orchestrationSteps![index])).toEqual(tool);
    r!.patchedDraft.orchestrationSteps!.forEach((s, i) => {
      if (i !== index) expect(s).toEqual(STEPS[i]);
    });
    if (index <= 1) expect((r!.patchedDraft.orchestrationSteps![index] as AgentOrchestrationStep).parallelGroup).toBe('g1');
  });

  it('a summary line that is a parallel group is ambiguous — ask, change nothing', () => {
    for (const text of ['1番目をCodexで', '最初のステップはGeminiで', 'make step 1 Codex']) {
      expect(applyDraftPatch(draft(), text)).toBeNull();
      expect(detectStepProviderNotice(draft(), text)).toEqual({ kind: 'ambiguous', line: 1 });
    }
  });

  it('already that provider → no patch, and no other detector reads it', () => {
    expect(applyDraftPatch(draft(), '最後のステップはローカルLLMで')).toBeNull();
    expect(applyDraftPatch(draft(), '9番目をCodexで')).toBeNull();
  });

  it('「全部ローカルで」 / "run everything locally" pin every working step', () => {
    for (const text of ['全部ローカルで', 'run everything locally', 'all steps on local']) {
      const r = applyDraftPatch(draft(), text);
      expect(r!.changedFields).toEqual(['step:0', 'step:1', 'step:2']);
      expect(r!.patchedDraft.orchestrationSteps!.every((s) => toolOf(s)?.type === 'local')).toBe(true);
    }
  });

  it('「全部Codexで」 never pins a send / save / notify step', () => {
    const r = applyDraftPatch(draft(), '全部Codexで')!;
    expect(r.changedFields).toEqual(['step:0', 'step:1', 'step:2']);
    expect(toolOf(r.patchedDraft.orchestrationSteps![3])).toEqual({ type: 'local' }); // 「保存して」 untouched
    const notify = applyDraftPatch(draft({ orchestrationSteps: ['ニュースを集めて', 'Slackに送信して'] }), '全部Geminiで')!;
    expect(notify.changedFields).toEqual(['step:0']);
    // An explicit reference to that step still works.
    expect(applyDraftPatch(draft(), '3番目をGeminiにして')!.changedFields).toEqual(['step:3']);
  });

  it('「全部自動で」 clears pins back to plain steps', () => {
    const r = applyDraftPatch(draft(), '全部自動で');
    expect(r!.changedFields).toEqual(['step:3']);
    expect(r!.patchedDraft.orchestrationSteps![3]).toBe('ファイルに保存して');
  });

  it('a single-step agent: 「全部ローカルで」 changes the agent-level tool (toolPatched)', () => {
    const r = applyDraftPatch(draft({ orchestrationSteps: undefined }), '全部ローカルで');
    expect(r!.changedFields).toEqual(['tool']);
    expect(r!.patchedDraft.tool).toEqual({ type: 'local' });
    expect(r!.patchedDraft.toolPatched).toBe(true);
    expect(applyDraftPatch(draft({ orchestrationSteps: undefined }), '2番目をCodexで')).toBeNull();
  });

  it('the single-step tool line shows the engine actually stored (resolver), not the raw pick', () => {
    const d = draft({ orchestrationSteps: undefined, autonomous: true, prompt: '要約して' });
    const r = applyDraftPatch(d, '全部Perplexityで')!;
    const noConsent = summarizeAgentDraftAsText(r.patchedDraft, new Set(r.changedFields), true, { cloudConsent: false });
    const line = noConsent.split('\n').find((l) => l.startsWith('★'))!;
    expect(line).not.toContain('Perplexity');
    expect(line).toContain('Codex');
  });

  it('does not misfire on prompt-like text, bare 「は」 topics or ambiguous keywords', () => {
    for (const text of [
      'Geminiのニュースをまとめて',
      'Perplexityで調べて',
      '今日はローカルでお願い',
      '要約はGroqで', // bare keyword without a step noun
      '集めるのステップはPerplexityで', // matches two steps
      'summarize it with Gemini',
      '並列の3つ目をCodexで',
    ]) {
      const r = tryPatchStepTools(draft(), text);
      expect(r === null || ('changedFields' in r && r.changedFields.length === 0)).toBe(true);
    }
  });

  it('a step-provider edit never also patches schedule / action', () => {
    const r = applyDraftPatch(draft({ action: { type: 'notify' } }), '2番目をCodexで');
    expect(r!.changedFields).toEqual(['step:2']);
    expect(r!.patchedDraft.action).toEqual({ type: 'notify' });
    expect(r!.patchedDraft.schedule).toBe('0 8 * * *');
  });

  it('Claude is recognized but not applied (not available on this device yet)', () => {
    expect(applyDraftPatch(draft(), '並列の2つ目をClaudeで')).toBeNull();
    expect(detectStepProviderNotice(draft(), '並列の2つ目をClaudeで')).toEqual({ kind: 'unsupported', provider: 'Claude Code' });
    expect(detectStepProviderNotice(draft(), 'use Claude for step 2')).toEqual({ kind: 'unsupported', provider: 'Claude Code' });
    expect(detectStepProviderNotice(draft(), '2番目をCodexで')).toBeNull();
  });

  it('the summary stars exactly the changed line (a parallel line holds both members)', () => {
    const r = applyDraftPatch(draft(), '並列の2つ目をCodexで')!;
    const lines = summarizeAgentDraftAsText(r.patchedDraft, new Set(r.changedFields), true).split('\n').filter((l) => /^(★|・) \d\. /.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^★ 1\. .*\[Codex CLI\] 論文を集めて/);
    expect(lines.filter((l) => l.startsWith('★'))).toHaveLength(1);
    const r2 = applyDraftPatch(draft(), '2番目をCodexで')!;
    const t2 = summarizeAgentDraftAsText(r2.patchedDraft, new Set(r2.changedFields), true).split('\n');
    expect(t2.find((l) => l.startsWith('★'))).toMatch(/^★ 2\. \[Codex CLI\] 要約して/);
  });

  it('just-registered correction window: a provider edit needs an edit confirm, nothing persisted', () => {
    const c = applyCorrectionToJustRegisteredAgent(draft(), '3番目をGeminiにして', Date.now(), 60_000);
    expect(c!.confirmEditRequired).toBe(true);
    expect(c!.agentPartial).toEqual({});
    expect(c!.changedFields).toEqual(['step:3']);
  });
});

function agentWith(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-po',
    name: 'Loop',
    description: '',
    prompt: '最新のAI論文を調べて要約して',
    schedule: null,
    tool: { type: 'local' },
    outputPath: '$HOME/.shelly/agents/agent-po/output.md',
    enabled: true,
    createdAt: 1,
    continuous: normalizeContinuousConfig({ loopStartedAt: 1_000 }),
    orchestration: { steps: [{ instruction: '最新のAI論文をパープレで調べて', tool: { type: 'perplexity' } }, '要約して'] },
    ...overrides,
  } as Agent;
}

describe('explicit paid pin under the ¥0 continuous budget', () => {
  it('keeps a user-pinned paid step (that step only) and still drops a paid agent-level tool', () => {
    const agent = applyContinuousProviderPolicy(agentWith({ tool: { type: 'groq' } }));
    expect(agent.tool).toEqual({ type: 'local' });
    expect(toolOf(agent.orchestration!.steps[0])).toEqual({ type: 'perplexity' });
    expect(explicitPaidStepPins(agent, agent.orchestration!.steps)).toEqual([0]);
  });

  it('the PlanSpec marks only that step paidPin; ladder and plan tool stay free', () => {
    const plan = buildAgentPlanSpec(agentWith(), { hasCerebrasKey: true, hasGroqKey: true });
    expect(plan.steps!.list[0]).toMatchObject({ tool: { type: 'perplexity' }, paidPin: true });
    expect((plan.steps!.list[1] as { paidPin?: boolean }).paidPin).toBeUndefined();
    expect(plan.tool.type).toBe('local');
    expect((plan.toolLadder ?? []).some((t) => ['perplexity', 'gemini-api', 'cerebras', 'groq', 'openrouter'].includes(t.type))).toBe(false);
  });

  it('a budget above ¥0 needs no paidPin', () => {
    const plan = buildAgentPlanSpec(agentWith({ continuous: normalizeContinuousConfig({ dailyBudgetJpy: 300, loopStartedAt: 1_000 }) }));
    expect((plan.steps!.list[0] as { paidPin?: boolean }).paidPin).toBeUndefined();
  });

  it('the summary says the step uses a paid API', () => {
    const d = draft({
      continuous: { cooldownMs: 300_000 },
      schedule: null,
      orchestrationSteps: [{ instruction: '最新のAI論文をパープレで調べて', tool: { type: 'perplexity' } }, '要約して'],
    });
    expect(summarizeAgentDraftAsText(d)).toContain('1番目のステップは有料API（Perplexity API）を使います');
    const funded = summarizeAgentDraftAsText({ ...d, continuous: { cooldownMs: 300_000, dailyBudgetJpy: 300 } });
    expect(funded).not.toContain('有料API（Perplexity API）を使います');
  });
});

describe('overrides.json model + vetting', () => {
  it('parses fail-closed, drops bad entries and never keeps a model', () => {
    expect(parseProviderOverrides('nope')).toBeNull();
    expect(parseProviderOverrides('{"v":2,"steps":{}}')).toBeNull();
    const o = parseProviderOverrides(JSON.stringify({
      v: 1,
      runId: 'r1',
      steps: {
        '1': { tool: { type: 'cli', cli: 'codex' } },
        '2': { tool: { type: 'evil' } },
        '3': { tool: { type: 'gemini-api', model: '../../x:generateContent?' } },
        x: { tool: { type: 'local' } },
      },
      restartRunning: [1, 2, 'a'],
    }))!;
    expect(o.steps).toEqual({ '1': { tool: { type: 'cli', cli: 'codex' } }, '3': { tool: { type: 'gemini-api' } } });
    expect(o.restartRunning).toEqual([1]);
    expect(overrideToolForStep(o, 'r1', 1)).toEqual({ type: 'cli', cli: 'codex' });
    expect(overrideToolForStep(o, 'other-run', 1)).toBeUndefined();
  });

  it('the attended chain only accepts auto, local, or a type the definition already uses (its own object)', () => {
    const agent = agentWith({ orchestration: { steps: [{ instruction: 'a', tool: { type: 'perplexity', model: 'sonar' } }, 'b'] } });
    expect(vetOverrideToolForAgent(agent, { type: 'perplexity' })).toEqual({ type: 'perplexity', model: 'sonar' });
    expect(vetOverrideToolForAgent(agent, { type: 'local' })).toEqual({ type: 'local' });
    expect(vetOverrideToolForAgent(agent, { type: 'auto' })).toEqual({ type: 'auto' });
    expect(vetOverrideToolForAgent(agent, { type: 'gemini-api' })).toBeUndefined();
    expect(vetOverrideToolForAgent(agent, { type: 'cli', cli: 'codex' })).toBeUndefined();
  });

  it('merge keeps the same run, resets on a new run, toggles restart', () => {
    const a = mergeProviderOverride(null, { runId: 'r1', stepIndex: 0, tool: { type: 'local' }, restart: true }, 5);
    const b = mergeProviderOverride(a, { runId: 'r1', stepIndex: 2, tool: { type: 'groq' } }, 6);
    expect(b).toEqual({ v: 1, runId: 'r1', steps: { '0': { tool: { type: 'local' } }, '2': { tool: { type: 'groq' } } }, restartRunning: [0], updatedAt: 6 });
    const c = mergeProviderOverride(b, { runId: 'r2', stepIndex: 1, tool: { type: 'local' } }, 7);
    expect(c.steps).toEqual({ '1': { tool: { type: 'local' } } });
  });

  it('folds into the definition (steps, or the agent tool for a single step)', () => {
    const agent = agentWith();
    const partial = foldOverridesIntoAgent(agent, { v: 1, steps: { '1': { tool: { type: 'gemini-api' } }, '0': { tool: { type: 'auto' } } } })!;
    expect(partial.orchestration!.steps).toEqual(['最新のAI論文をパープレで調べて', { instruction: '要約して', tool: { type: 'gemini-api' } }]);
    expect(foldOverridesIntoAgent({ tool: { type: 'local' } }, { v: 1, steps: { '0': { tool: { type: 'cli', cli: 'codex' } } } })).toEqual({ tool: { type: 'cli', cli: 'codex' } });
    expect(foldOverridesIntoAgent({ tool: { type: 'local' } }, { v: 1, steps: { '0': { tool: { type: 'local' } } } })).toBeNull();
  });

  it('write command is atomic and refuses unsafe ids', () => {
    expect(buildWriteOverridesCommand('../x', { v: 1, steps: {} })).toBe('');
    const cmd = buildWriteOverridesCommand('agent-po', { v: 1, steps: { '0': { tool: { type: 'local' } } } });
    expect(cmd).toContain('agents/logs/agent-po"/.overrides.json.tmp');
    expect(cmd).toContain('mv -f');
  });

  it('the agent gate protects overrides.json from agent shells / Codex tool calls', () => {
    expect(touchesProtectedPolicyFiles('echo x > ~/.shelly/agents/logs/a1/overrides.json')).toBe(true);
    expect(touchesProtectedPolicyFiles('cd ~/.shelly/agents/logs/a1 && printf {} > overrides.json')).toBe(true);
    expect(touchesProtectedPolicyFiles("node -e \"require('fs').writeFileSync('/h/.shelly/agents/logs/a1/overrides.json','{}')\"")).toBe(true);
    expect(touchesProtectedPolicyFiles('mv /tmp/x /h/.shelly/agents/logs/a1/.overrides.json.tmp')).toBe(true);
    expect(touchesProtectedPolicyFiles('cat ~/.shelly/agents/logs/a1/progress.jsonl')).toBe(false);
  });

  it('documents the gate limit: a write through a symlinked dir made earlier is NOT caught (reader-side vetting is the control)', () => {
    // String match only: the second command never names the real location.
    expect(touchesProtectedPolicyFiles('ln -s ~/.shelly/agents/logs/a1 /tmp/l')).toBe(false);
    expect(touchesProtectedPolicyFiles('echo x > /tmp/l/overrides.json')).toBe(false);
    // ...which is why a foreign file can never become a definition change
    // (isAppWrittenOverrides) and the executor only accepts vetted types.
    expect(isAppWrittenOverrides('a1', parseProviderOverrides('{"v":1,"steps":{"0":{"tool":{"type":"perplexity"}}}}'))).toBe(false);
  });
});

describe('fold after the run (decision + authenticity + listing)', () => {
  beforeEach(() => __resetAppWrittenOverridesForTests());
  const o = { v: 1 as const, steps: { '1': { tool: { type: 'local' as const } } }, updatedAt: 10_000 };

  it('waits while running / before a newer run log, folds after, clears foreign leftovers', () => {
    const ctx = { agentExists: true, running: false, latestRunAtMs: 20_000, nowMs: 30_000 };
    expect(decideOverrideFold(o, { ...ctx, running: true })).toBe('wait');
    expect(decideOverrideFold(o, { ...ctx, latestRunAtMs: 5_000 })).toBe('wait');
    expect(decideOverrideFold(o, ctx)).toBe('fold');
    expect(decideOverrideFold(o, { ...ctx, running: true, latestRunAtMs: null, nowMs: 10_000 + OVERRIDE_FOLD_MAX_AGE_MS + 1 })).toBe('fold');
    expect(decideOverrideFold(o, { ...ctx, agentExists: false })).toBe('clear');
    expect(decideOverrideFold(null, ctx)).toBe('clear');
  });

  it('only content this app wrote counts as authentic', () => {
    expect(isAppWrittenOverrides('a1', o)).toBe(false);
    noteAppWrittenOverrides('a1', o);
    expect(isAppWrittenOverrides('a1', parseProviderOverrides(JSON.stringify(o)))).toBe(true);
    expect(isAppWrittenOverrides('a1', { ...o, steps: { '1': { tool: { type: 'perplexity' } } } })).toBe(false);
  });

  it('parses the one-exec listing', () => {
    const out = `@@SHELLY_OVERRIDES@@ a1\n${JSON.stringify(o)}\n@@SHELLY_OVERRIDES@@ ../bad\n{}\n@@SHELLY_OVERRIDES@@ a2\nnot json\n`;
    expect(parseOverridesListing(out)).toEqual([
      { agentId: 'a1', overrides: parseProviderOverrides(JSON.stringify(o)) },
      { agentId: 'a2', overrides: null },
    ]);
  });
});

describe('MONITOR provider picker (lib/monitor-provider-pick)', () => {
  beforeEach(() => __resetAppWrittenOverridesForTests());

  function fakeFs(initial: string | null = null) {
    let file: string | null = initial;
    const cmds: string[] = [];
    const exec = jest.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: file ?? '' };
      const m = /printf '%s\\n' '(.*)' > /.exec(cmd);
      if (m) file = m[1];
      return { exitCode: 0, stdout: '' };
    });
    return { exec, cmds, read: () => file };
  }

  it('during a run: writes overrides.json scoped to the run, recorded as app-written, no fold here', async () => {
    const fs = fakeFs();
    const update = jest.fn(async () => undefined);
    const agent = agentWith({ continuous: undefined });
    const r = await applyProviderPick(fs.exec, update, { agent, stepIndex: 1, pick: 'local', restart: true, runId: 'run-1', runActive: true });
    expect(r).toEqual({ result: 'override', appliesNow: true, paidNextRun: false });
    const written = JSON.parse(fs.read()!);
    expect(written).toMatchObject({ v: 1, runId: 'run-1', steps: { '1': { tool: { type: 'local' } } }, restartRunning: [1] });
    expect(isAppWrittenOverrides(agent.id, parseProviderOverrides(fs.read()!))).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('a foreign (planted) file is replaced, never merged: only the user\'s own pick can be folded', async () => {
    const planted = JSON.stringify({ v: 1, runId: 'run-1', steps: { '0': { tool: { type: 'perplexity' } } }, updatedAt: 1 });
    const fs = fakeFs(planted);
    const agent = agentWith({ continuous: undefined });
    await applyProviderPick(fs.exec, jest.fn(), { agent, stepIndex: 1, pick: 'local', restart: false, runId: 'run-1', runActive: true });
    const written = parseProviderOverrides(fs.read())!;
    expect(written.steps).toEqual({ '1': { tool: { type: 'local' } } });
    expect(isAppWrittenOverrides(agent.id, written)).toBe(true);
    // What the post-run fold would apply: the user's step only.
    const partial = foldOverridesIntoAgent(agent, written)!;
    expect(partial.orchestration!.steps).toEqual([agent.orchestration!.steps[0], { instruction: '要約して', tool: { type: 'local' } }]);
    // And the planted content itself is never trusted.
    expect(isAppWrittenOverrides(agent.id, parseProviderOverrides(planted))).toBe(false);
  });

  it('an app-written file is merged (two picks in one run both survive)', async () => {
    const fs = fakeFs();
    const agent = agentWith({ continuous: undefined });
    await applyProviderPick(fs.exec, jest.fn(), { agent, stepIndex: 0, pick: 'local', restart: false, runId: 'run-1', runActive: true });
    await applyProviderPick(fs.exec, jest.fn(), { agent, stepIndex: 1, pick: 'perplexity', restart: false, runId: 'run-1', runActive: true });
    expect(parseProviderOverrides(fs.read())!.steps).toEqual({ '0': { tool: { type: 'local' } }, '1': { tool: { type: 'perplexity' } } });
  });

  it('a provider the definition does not use yet: next run only, never a restart', async () => {
    const fs = fakeFs();
    const r = await applyProviderPick(fs.exec, jest.fn(), { agent: agentWith({ continuous: undefined }), stepIndex: 1, pick: 'groq', restart: true, runId: 'run-1', runActive: true });
    expect(r.appliesNow).toBe(false);
    expect(JSON.parse(fs.read()!).restartRunning).toBeUndefined();
  });

  it('a paid pick in a ¥0 loop is unscoped and flagged next-run (no paid permission from the file)', async () => {
    const fs = fakeFs();
    const r = await applyProviderPick(fs.exec, jest.fn(), { agent: agentWith(), stepIndex: 1, pick: 'perplexity', restart: true, runId: 'run-9', runActive: true });
    expect(r).toEqual({ result: 'override', appliesNow: false, paidNextRun: true });
    const written = JSON.parse(fs.read()!);
    expect(written.runId).toBeUndefined();
    expect(written.restartRunning).toBeUndefined();
  });

  it('no run going: saved straight into the definition, no file', async () => {
    const fs = fakeFs();
    const update = jest.fn(async () => undefined);
    const r = await applyProviderPick(fs.exec, update, { agent: agentWith(), stepIndex: 1, pick: 'codex', restart: false, runActive: false });
    expect(r.result).toBe('saved');
    expect(fs.cmds).toHaveLength(0);
    expect(update).toHaveBeenCalledWith('agent-po', expect.objectContaining({ orchestration: expect.any(Object) }));
  });
});
