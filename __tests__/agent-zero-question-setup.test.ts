/**
 * "Zero questions" agent setup (2026-10-30). On-device, the utterance below
 * produced 3 questions and a broken 5-step plan. These tests pin each fix:
 *   A. manual-only is a first-class trigger (default when no schedule named)
 *   B. questions are deterministic (Tier 3 prose dropped; two-choice confirm)
 *   C. defaults: name prefix, no confirm-mode question for draft/notify
 *   D. clause-level step splitting (tool scope, name prefix, save absorption)
 *      + local-LLM step pins are not a 'step-tool' risk reason
 */
import { parseAgentNL, parseSchedule, isManualTriggerDraft } from '../lib/agent-nl-parser';
import { applySlotAnswer, nextMissingSlot, parseAutonomousChoice } from '../lib/agent-slot-fill';
import { draftToConfirmedAgentDraft, hasDraftAssumptions, summarizeAgentDraftAsText } from '../lib/agent-plan-summary';
import { isLowConfidenceAgentDraft } from '../lib/agent-llm-fallback';
import { assessAgentDraftRisk } from '../lib/agent-add-approval';
import {
  detectToolPinnedSteps,
  extractNamePrefix,
  isToolOnlyClause,
  saveOnlyClauseLabel,
} from '../lib/agent-orchestration';
import {
  mergeConversationalExtractionIntoDraft,
  parseConversationalTurnForSlotFill,
} from '../lib/agent-conversational-registration';
import { agentToParsedAgentDraft } from '../lib/agent-draft-patch';
import ja from '../lib/i18n/locales/ja';
import type { Agent } from '../store/types';

const EXAMPLE =
  'STOPALLテスト: ローカルLLMで、日本の四季について800字の文章を書き、それを英語に翻訳し、最後に3行で要約して、結果をメモとして保存して';

function instructionOf(step: unknown): string {
  return typeof step === 'string' ? step : (step as { instruction: string }).instruction;
}

describe('end-to-end: the on-device example utterance', () => {
  const draft = parseAgentNL(EXAMPLE, []);

  it('reaches the summary with ZERO questions (no vault configured, too)', () => {
    expect(nextMissingSlot(draft, {})).toBeNull();
    expect(nextMissingSlot(draft, { agentVaultPath: '/sdcard/Vault' })).toBeNull();
    // Deterministic parse is complete — no LLM pass is needed either.
    expect(isLowConfidenceAgentDraft(draft)).toBe(false);
  });

  it('has 3 work steps, each pinned to the local LLM', () => {
    const steps = draft.orchestrationSteps ?? [];
    expect(steps).toHaveLength(3);
    expect(steps.map(instructionOf)).toEqual([
      '日本の四季について800字の文章を書き',
      'それを英語に翻訳し',
      '3行で要約して',
    ]);
    for (const step of steps) {
      expect(typeof step).not.toBe('string');
      expect((step as { tool?: { type: string } }).tool?.type).toBe('local');
    }
  });

  it('final action = save as memo (still a draft action) with a destination path', () => {
    expect(draft.action.type).toBe('draft');
    expect(draft.saveActionLabel).toBe('メモとして保存');
    const summary = summarizeAgentDraftAsText(draft);
    expect(summary).toContain('実行内容: メモとして保存（保存先: ~/agent-output）');
    expect(summary).not.toContain('下書きを作成');
    const withPreview = summarizeAgentDraftAsText({ ...draft, saveDestinationPreview: '/sdcard/Documents/ObsidianVault/AI' });
    expect(withPreview).toContain('メモとして保存（保存先: /sdcard/Documents/ObsidianVault/AI）');
  });

  it('is a manual trigger, named from the prefix, with the prefix stripped from the task', () => {
    expect(draft.name).toBe('STOPALLテスト');
    expect(draft.prompt.startsWith('STOPALL')).toBe(false);
    expect(draft.schedule).toBeNull();
    expect(draft.trigger).toBe('manual');
    expect(isManualTriggerDraft(draft)).toBe(true);
    const summary = summarizeAgentDraftAsText(draft);
    expect(summary).toContain('実行タイミング: 手動（スケジュールなし）');
    expect(summary).toContain(ja['agentplan.manual_trigger_note']);
    expect(summary).not.toContain('今すぐ');
  });

  it('registers as a persistent manual agent (schedule null), not a run-and-discard one-shot', () => {
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.schedule).toBeNull();
    expect(confirmed.manualTrigger).toBe(true);
    // A defaulted manual trigger still gets one human confirm.
    expect(hasDraftAssumptions(draft)).toBe(true);
  });

  it('has no step-tool risk reason (local-LLM pins only)', () => {
    expect(assessAgentDraftRisk(draft)).not.toContain('step-tool');
    expect(assessAgentDraftRisk(draft)).toEqual([]);
  });
});

describe('A. manual-only as a first-class trigger', () => {
  it.each(['手動', '手動で', '手動実行', 'スケジュールなし', 'スケジュールは不要', '自分で実行', 'manual', 'Manually', 'no schedule', 'manual only'])(
    'parseSchedule(%s) is an explicit manual answer',
    (answer) => {
      const r = parseSchedule(answer);
      expect(r.manual).toBe(true);
      expect(r.schedule).toBeNull();
      expect(r.confident).toBe(false);
    },
  );

  it('does not read a task that merely mentions 手動 as manual', () => {
    expect(parseSchedule('手動バックアップの手順をまとめて').manual).toBeUndefined();
  });

  it('defaults to manual only when the utterance names NO schedule at all', () => {
    expect(parseAgentNL('ニュースをまとめて').trigger).toBe('manual');
    expect(parseAgentNL('ニュースをまとめて').triggerAssumed).toBe(true);
    // Any schedule signal keeps the old path: either it parses to a schedule,
    // or the schedule question is still asked.
    for (const u of ['毎日ニュースをまとめて', '9時にニュースをまとめて', '月曜にニュースをまとめて', '朝にニュースをまとめて']) {
      const d = parseAgentNL(u);
      expect(d.trigger).toBeUndefined();
      expect(d.scheduleConfident || nextMissingSlot(d, { agentVaultPath: '/v' })?.field === 'schedule').toBe(true);
    }
    expect(nextMissingSlot(parseAgentNL('毎日ニュースをまとめて'), { agentVaultPath: '/v' })?.field).toBe('schedule');
    // A confident schedule is never manual.
    expect(parseAgentNL('毎朝8時にニュースをまとめて').trigger).toBeUndefined();
    // A notification-triggered request is never manual.
    expect(parseAgentNL('Slackの通知が来たら要約して').trigger).toBeUndefined();
  });

  it('an explicit 手動 answer to the schedule question resolves the slot (no re-ask)', () => {
    const d = parseAgentNL('毎日ニュースをまとめて');
    expect(nextMissingSlot(d, { agentVaultPath: '/v' })?.field).toBe('schedule');
    const { draft, resolved } = applySlotAnswer('schedule', d, '手動で', 0);
    expect(resolved).toBe(true);
    expect(isManualTriggerDraft(draft)).toBe(true);
    expect(draft.triggerAssumed).toBeUndefined();
    expect(nextMissingSlot(draft, { agentVaultPath: '/v' })).toBeNull();
    expect(hasDraftAssumptions(draft)).toBe(false);
  });

  it('a later real schedule supersedes manual', () => {
    const d = parseAgentNL('ニュースをまとめて');
    const { draft } = applySlotAnswer('schedule', d, '毎朝8時', 0);
    expect(draft.schedule).toBe('0 8 * * *');
    expect(isManualTriggerDraft(draft)).toBe(false);
    expect(draftToConfirmedAgentDraft(draft).manualTrigger).toBeUndefined();
  });

  it('"今すぐ" stays the run-now one-shot, distinct from manual', () => {
    const d = parseAgentNL('今すぐニュースをまとめて');
    expect(d.trigger).toBeUndefined();
    expect(draftToConfirmedAgentDraft(d).manualTrigger).toBeUndefined();
  });

  it('Tier 3 scheduleText "手動" / "manual" maps to the manual trigger', () => {
    const base = parseAgentNL('毎日ニュースをまとめて');
    for (const scheduleText of ['手動', 'manual']) {
      const { draft } = mergeConversationalExtractionIntoDraft(base, { scheduleText }, { connectors: [] });
      expect(isManualTriggerDraft(draft)).toBe(true);
    }
    // Never downgrades a schedule the deterministic parse already resolved.
    const scheduled = parseAgentNL('毎朝8時にニュースをまとめて');
    const { draft, rejectedFields } = mergeConversationalExtractionIntoDraft(scheduled, { scheduleText: '手動' }, { connectors: [] });
    expect(draft.schedule).toBe('0 8 * * *');
    expect(rejectedFields).toContain('scheduleText');
  });

  it('an edited registered agent with no schedule stays manual', () => {
    const agent = { id: 'a1', name: 'x', prompt: 'p', schedule: null, tool: { type: 'auto' } } as unknown as Agent;
    expect(isManualTriggerDraft(agentToParsedAgentDraft(agent))).toBe(true);
  });
});

describe('B. deterministic questions', () => {
  it('a Tier 3 prose question is read as an empty proposal (never shown)', () => {
    const turn = parseConversationalTurnForSlotFill('エージェントの名前は何にしますか？');
    expect(turn).toEqual({ kind: 'proposal', extraction: {} });
    const proposal = parseConversationalTurnForSlotFill('```shelly-agent-registration\n{"name":"x","scheduleText":"手動"}\n```');
    expect(proposal.kind).toBe('proposal');
    expect(parseConversationalTurnForSlotFill('   ').kind).toBe('unparseable');
  });

  it('the confirm-mode question is an explicit two-choice, not はい/いいえ', () => {
    expect(ja['slot_fill.question_autonomous']).toContain('確認なしで自動実行');
    expect(ja['slot_fill.question_autonomous']).toContain('毎回確認してから実行');
    expect(ja['slot_fill.question_autonomous']).not.toContain('「はい」');
  });

  it.each([
    ['確認なしで自動実行', true],
    ['確認なしで', true],
    ['自動実行', true],
    ['勝手にやって', true],
    ['はい', true],
    ['run automatically', true],
    ['毎回確認してから実行', false],
    ['毎回確認', false],
    ['確認して', false],
    ['いいえ', false],
    ['ask each time', false],
  ] as const)('parses %s → %s', (answer, expected) => {
    expect(parseAutonomousChoice(answer)).toBe(expected);
    const d = { ...parseAgentNL('毎朝8時にAPIを叩いて'), action: { type: 'webhook' as const, webhookUrl: 'https://x' } };
    const { draft, resolved } = applySlotAnswer('autonomous', d, answer, 0);
    expect(resolved).toBe(true);
    expect(draft.autonomous).toBe(expected);
  });

  it('copy-pasting both choices is ambiguous and never grants unattended', () => {
    expect(parseAutonomousChoice('確認なしで自動実行 / 毎回確認してから実行')).toBeNull();
    const d = { ...parseAgentNL('毎朝8時にAPIを叩いて'), action: { type: 'webhook' as const, webhookUrl: 'https://x' } };
    const { draft, resolved } = applySlotAnswer('autonomous', d, '確認なしで自動実行 / 毎回確認してから実行', 0);
    expect(resolved).toBe(true);
    expect(draft.autonomous).toBe(false);
  });
});

describe('C. defaults that remove questions', () => {
  it('name from 「名前: X、」 and 「X: 」 prefixes', () => {
    expect(parseAgentNL('名前: 朝の要約、ニュースをまとめて').name).toBe('朝の要約');
    expect(parseAgentNL('Name: Morning digest, summarize the news').name).toBe('Morning digest');
    expect(extractNamePrefix('STOPALLテスト: 作業して')).toEqual({ name: 'STOPALLテスト', rest: '作業して' });
  });

  it('never reads a URL, a time, a tool or a key/value as a name prefix', () => {
    expect(extractNamePrefix('https://example.com を開いて')).toBeNull();
    expect(extractNamePrefix('9:30にニュースをまとめて')).toBeNull();
    expect(extractNamePrefix('Perplexity: 最新ニュースを調べて')).toBeNull();
    expect(extractNamePrefix('API key: sk-test')).toBeNull();
  });

  it('draft/notify actions never ask the confirm-mode question (safe default: confirm each run)', () => {
    const d = parseAgentNL('毎朝8時にニュースを通知して');
    expect(d.action.type).toBe('notify');
    expect(nextMissingSlot(d, { agentVaultPath: '/v' })).toBeNull();
    expect(draftToConfirmedAgentDraft(d).autonomous).toBe(false);
  });
});

describe('D. clause-level step splitting', () => {
  it('a tool-only clause is not a step; it pins the clauses it scopes', () => {
    expect(isToolOnlyClause('ローカルLLMで')).toBe(true);
    expect(isToolOnlyClause('ローカルLLMで要約して')).toBe(false);
    const steps = detectToolPinnedSteps('ローカルLLMで、記事を書いて、英訳して')!;
    expect(steps.map((s) => s.instruction)).toEqual(['記事を書いて', '英訳して']);
    expect(steps.every((s) => s.tool?.type === 'local')).toBe(true);
  });

  it('a clause naming its own tool keeps per-clause semantics (no carry-forward)', () => {
    const steps = detectToolPinnedSteps('パープレで論文を集めて、ローカルLLMで要約して、Xに投稿して')!;
    expect(steps.map((s) => s.tool?.type)).toEqual(['perplexity', 'local', undefined]);
  });

  it('a scope switches when a later tool-only clause names another tool', () => {
    const steps = detectToolPinnedSteps('パープレで、ニュースを集めて、ローカルLLMで、要約して')!;
    expect(steps.map((s) => [s.instruction, s.tool?.type])).toEqual([
      ['ニュースを集めて', 'perplexity'],
      ['要約して', 'local'],
    ]);
  });

  it('save-only clause labels', () => {
    expect(saveOnlyClauseLabel('結果をメモとして保存して')).toBe('メモとして保存');
    expect(saveOnlyClauseLabel('ファイルに保存して')).toBe('ファイルに保存');
    expect(saveOnlyClauseLabel('save it as a note')).toBe('save as a note');
    // A bare save (no destination noun) is not absorbed.
    expect(saveOnlyClauseLabel('保存して')).toBeNull();
    expect(saveOnlyClauseLabel('メモの内容を要約して')).toBeNull();
  });

  it('a trailing 通知して is still absorbed into a notify action (unchanged)', () => {
    const d = parseAgentNL('ローカルLLMで、ニュースを集めて、要約して、通知して');
    expect(d.action.type).toBe('notify');
    expect((d.orchestrationSteps ?? []).map(instructionOf)).toEqual(['ニュースを集めて', '要約して']);
  });

  it('a non-local step pin still counts as step-tool risk', () => {
    const d = parseAgentNL('パープレで、ニュースを集めて、要約して、結果をメモとして保存して');
    expect(assessAgentDraftRisk(d)).toContain('step-tool');
  });
});
