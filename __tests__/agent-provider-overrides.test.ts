/**
 * Provider overrides (DEFERRED.md「タスクごとのプロバイダを自由に指定・途中で変更
 * する」): chat step-provider edits, the explicit paid pin under a ¥0 loop, the
 * overrides.json model, folding into the definition, and the MONITOR picker
 * writing the file.
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import {
  applyCorrectionToJustRegisteredAgent,
  applyDraftPatch,
  detectUnsupportedStepProvider,
  tryPatchStepTools,
} from '@/lib/agent-draft-patch';
import { summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { applyContinuousProviderPolicy, explicitPaidStepPins, normalizeContinuousConfig } from '@/lib/agent-continuous';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import {
  buildWriteOverridesCommand,
  foldOverridesIntoAgent,
  mergeProviderOverride,
  overrideToolForStep,
  parseProviderOverrides,
} from '@/lib/agent-provider-overrides';
import {
  __resetPendingProviderFoldsForTests,
  applyProviderPick,
  foldPendingProviderOverride,
  hasPendingProviderFold,
} from '@/lib/monitor-provider-pick';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

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
    ['2番目をCodexで', 1, { type: 'cli', cli: 'codex' }],
    ['3番目をGeminiにして', 2, { type: 'gemini-api' }],
    ['ステップ3はPerplexityでお願いします', 2, { type: 'perplexity' }],
    ['要約のステップはPerplexityで', 2, { type: 'perplexity' }],
    ['要約はGroqで', 2, { type: 'groq' }],
    ['並列の2つ目をセレブラスで', 1, { type: 'cerebras' }],
    ['最後のステップはローカルLLMで', 3, undefined], // already local → no-op handled below
    ['make step 2 Codex', 1, { type: 'cli', cli: 'codex' }],
    ['switch the third step to Gemini', 2, { type: 'gemini-api' }],
    ['use Perplexity for step 3', 2, { type: 'perplexity' }],
    ['switch the 要約 step to Perplexity', 2, { type: 'perplexity' }],
    ['the second parallel branch on Groq', 1, { type: 'groq' }],
  ])('%s → step %i', (text, index, tool) => {
    const r = applyDraftPatch(draft(), text);
    if (tool === undefined) {
      expect(r).toBeNull();
      return;
    }
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual([`step:${index}`]);
    expect(toolOf(r!.patchedDraft.orchestrationSteps![index])).toEqual(tool);
    // Only that step changed.
    r!.patchedDraft.orchestrationSteps!.forEach((s, i) => {
      if (i !== index) expect(s).toEqual(STEPS[i]);
    });
    // The parallel marker survives a pin.
    if (index === 1) expect((r!.patchedDraft.orchestrationSteps![1] as AgentOrchestrationStep).parallelGroup).toBe('g1');
  });

  it('「全部ローカルで」 / "run everything locally" pin every step not already local', () => {
    for (const text of ['全部ローカルで', 'run everything locally', 'all steps on local']) {
      const r = applyDraftPatch(draft(), text);
      expect(r).not.toBeNull();
      expect(r!.changedFields).toEqual(['step:0', 'step:1', 'step:2']);
      expect(r!.patchedDraft.orchestrationSteps!.every((s) => toolOf(s)?.type === 'local')).toBe(true);
    }
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

  it('does not misfire on prompt-like text, ambiguous keywords or out-of-range ordinals', () => {
    for (const text of [
      'Geminiのニュースをまとめて',
      'Perplexityで調べて',
      '集めてはPerplexityで', // matches two steps
      '9番目をCodexで',
      'summarize it with Gemini',
      '並列の3つ目をCodexで',
    ]) {
      const r = tryPatchStepTools(draft(), text);
      expect(r === null || ('changedFields' in r && r.changedFields.length === 0)).toBe(true);
    }
    // A matched-but-unresolved edit stops there (no other detector reads it).
    expect(applyDraftPatch(draft(), '9番目をCodexで')).toBeNull();
  });

  it('a step-provider edit never also patches schedule / action', () => {
    const r = applyDraftPatch(draft({ action: { type: 'notify' } }), '2番目をCodexで');
    expect(r!.changedFields).toEqual(['step:1']);
    expect(r!.patchedDraft.action).toEqual({ type: 'notify' });
    expect(r!.patchedDraft.schedule).toBe('0 8 * * *');
  });

  it('Claude is recognized but not applied (not available on this device yet)', () => {
    expect(applyDraftPatch(draft(), '並列の2つ目をClaudeで')).toBeNull();
    expect(detectUnsupportedStepProvider(draft(), '並列の2つ目をClaudeで')).toBe('Claude Code');
    expect(detectUnsupportedStepProvider(draft(), 'use Claude for step 2')).toBe('Claude Code');
    expect(detectUnsupportedStepProvider(draft(), '2番目をCodexで')).toBeNull();
  });

  it('the summary marks exactly the changed step with ★', () => {
    const r = applyDraftPatch(draft(), '2番目をCodexで')!;
    const text = summarizeAgentDraftAsText(r.patchedDraft, new Set(r.changedFields), true);
    // The two parallel members share one display line; only that line is starred.
    const stepLines = text.split('\n').filter((l) => /^(★|・) \d\. /.test(l));
    expect(stepLines).toHaveLength(3);
    expect(stepLines[0]).toMatch(/^★ 1\. .*\[Codex CLI\] 論文を集めて/);
    expect(stepLines.filter((l) => l.startsWith('★'))).toHaveLength(1);
    const r3 = applyDraftPatch(draft(), '3番目をGeminiにして')!;
    const t3 = summarizeAgentDraftAsText(r3.patchedDraft, new Set(r3.changedFields), true).split('\n');
    expect(t3.find((l) => l.startsWith('★'))).toMatch(/^★ 2\. \[Gemini API\] 要約して/);
  });

  it('just-registered correction window: a provider edit needs an edit confirm, nothing persisted', () => {
    const c = applyCorrectionToJustRegisteredAgent(draft(), '3番目をGeminiにして', Date.now(), 60_000);
    expect(c!.confirmEditRequired).toBe(true);
    expect(c!.agentPartial).toEqual({});
    expect(c!.changedFields).toEqual(['step:2']);
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
    const text = summarizeAgentDraftAsText(d);
    expect(text).toContain('1番目のステップは有料API（Perplexity API）を使います');
    const funded = summarizeAgentDraftAsText({ ...d, continuous: { cooldownMs: 300_000, dailyBudgetJpy: 300 } });
    expect(funded).not.toContain('有料API（Perplexity API）を使います');
  });
});

describe('overrides.json model', () => {
  it('parses fail-closed and drops bad entries', () => {
    expect(parseProviderOverrides('nope')).toBeNull();
    expect(parseProviderOverrides('{"v":2,"steps":{}}')).toBeNull();
    const o = parseProviderOverrides(JSON.stringify({
      v: 1,
      runId: 'r1',
      steps: { '1': { tool: { type: 'cli', cli: 'codex' } }, '2': { tool: { type: 'evil' } }, x: { tool: { type: 'local' } } },
      restartRunning: [1, 2, 'a'],
    }))!;
    expect(o.steps).toEqual({ '1': { tool: { type: 'cli', cli: 'codex' } } });
    expect(o.restartRunning).toEqual([1]);
    expect(overrideToolForStep(o, 'r1', 1)).toEqual({ type: 'cli', cli: 'codex' });
    expect(overrideToolForStep(o, 'other-run', 1)).toBeUndefined();
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
});

describe('MONITOR provider picker (lib/monitor-provider-pick)', () => {
  beforeEach(() => __resetPendingProviderFoldsForTests());

  function fakeFs() {
    let file: string | null = null;
    const cmds: string[] = [];
    const exec = jest.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: file ?? '' };
      if (cmd.startsWith('rm -f')) {
        file = null;
        return { exitCode: 0, stdout: '' };
      }
      const m = /printf '%s\\n' '(.*)' > /.exec(cmd);
      if (m) file = m[1];
      return { exitCode: 0, stdout: '' };
    });
    return { exec, cmds, read: () => file };
  }

  it('during a run: writes overrides.json scoped to the run, then folds after the run', async () => {
    const fs = fakeFs();
    const update = jest.fn(async () => undefined);
    const agent = agentWith({ continuous: undefined });
    const r = await applyProviderPick(fs.exec, update, { agent, stepIndex: 1, pick: 'groq', restart: true, runId: 'run-1', runActive: true });
    expect(r).toBe('override');
    expect(JSON.parse(fs.read()!)).toMatchObject({ v: 1, runId: 'run-1', steps: { '1': { tool: { type: 'groq' } } }, restartRunning: [1] });
    expect(update).not.toHaveBeenCalled();
    expect(hasPendingProviderFold(agent.id)).toBe(true);

    expect(await foldPendingProviderOverride(fs.exec, update, agent)).toBe(true);
    expect(update).toHaveBeenCalledWith(agent.id, {
      orchestration: { steps: [agent.orchestration!.steps[0], { instruction: '要約して', tool: { type: 'groq' } }] },
    });
    expect(fs.read()).toBeNull();
    expect(hasPendingProviderFold(agent.id)).toBe(false);
  });

  it('a continuous loop override is unscoped (next iteration picks it up)', async () => {
    const fs = fakeFs();
    await applyProviderPick(fs.exec, jest.fn(), { agent: agentWith(), stepIndex: 0, pick: 'local', restart: false, runId: 'run-9', runActive: true });
    expect(JSON.parse(fs.read()!).runId).toBeUndefined();
  });

  it('no run going: saved straight into the definition, no file', async () => {
    const fs = fakeFs();
    const update = jest.fn(async () => undefined);
    const r = await applyProviderPick(fs.exec, update, { agent: agentWith(), stepIndex: 1, pick: 'codex', restart: false, runActive: false });
    expect(r).toBe('saved');
    expect(fs.cmds).toHaveLength(0);
    expect(update).toHaveBeenCalledWith('agent-po', expect.objectContaining({ orchestration: expect.any(Object) }));
  });
});
