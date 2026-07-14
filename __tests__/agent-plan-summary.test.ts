// lib/i18n imports expo-localization (ESM-only) which the plain "unit" ts-jest
// project (no RN/babel transform) cannot parse — mock it exactly like
// __tests__/AgentConfirmCard.test.tsx does, but with real {{param}}
// interpolation so assertions below can check the actually-composed strings
// rather than just raw keys.
// Mirrors AgentConfirmCard.test.tsx's `t: (key) => key` mock, extended to also
// surface the params object in the output (JSON-appended) so assertions below
// can check that the RIGHT interpolated values (times, labels, previews) were
// actually passed through, not just that a key was looked up.
jest.mock('@/lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));

import {
  hasFireableSchedule,
  shouldUseChatConfirm,
  summarizeAgentDraftAsText,
  draftToConfirmedAgentDraft,
} from '@/lib/agent-plan-summary';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { AgentOrchestrationStep } from '@/store/types';

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Daily X digest',
    prompt: 'Summarize today and post it',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: 'Daily at 08:00',
    action: { type: 'draft' },
    tool: { type: 'local' },
    toolLabel: 'Local LLM',
    rawText: 'Every day at 8, summarize today and post it to X',
    ...overrides,
  };
}

describe('hasFireableSchedule', () => {
  it('true for a confident cron', () => {
    expect(hasFireableSchedule(baseDraft())).toBe(true);
  });

  it('true for a genuine one-shot (no recurrence stated at all)', () => {
    expect(hasFireableSchedule(baseDraft({ schedule: null, scheduleConfident: false }))).toBe(true);
  });

  it('false when a recurrence was stated but no confirmable time exists (needs restatement)', () => {
    expect(
      hasFireableSchedule(
        baseDraft({ schedule: null, scheduleConfident: false, suggestedFrequency: 'daily' }),
      ),
    ).toBe(false);
    expect(
      hasFireableSchedule(
        baseDraft({
          schedule: null,
          scheduleConfident: false,
          suggestedFrequency: 'weekly',
          suggestedDowList: '1,5',
        }),
      ),
    ).toBe(false);
  });
});

describe('shouldUseChatConfirm', () => {
  it('true for an app-act action', () => {
    expect(
      shouldUseChatConfirm(
        baseDraft({ action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } } }),
      ),
    ).toBe(true);
  });

  it('true when at least one orchestration step pins a tool', () => {
    const steps: Array<string | AgentOrchestrationStep> = [
      'search for news',
      { instruction: 'summarize with local model', tool: { type: 'local' } },
    ];
    expect(shouldUseChatConfirm(baseDraft({ orchestrationSteps: steps }))).toBe(true);
  });

  it('false for a plain draft action with no orchestration', () => {
    expect(shouldUseChatConfirm(baseDraft())).toBe(false);
  });

  it('false for a plain auto-routed multi-step chain with NO pinned tools (still card-routed)', () => {
    const steps: Array<string | AgentOrchestrationStep> = ['first step', 'second step'];
    expect(shouldUseChatConfirm(baseDraft({ orchestrationSteps: steps }))).toBe(false);
  });
});

describe('summarizeAgentDraftAsText', () => {
  it('single-step app-act (X-posting) with a confident daily schedule', () => {
    const draft = baseDraft({
      action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } },
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('Daily X digest'); // name
    expect(text).toContain('08:00'); // schedule time round-tripped through decodeCron
    expect(text).toContain('agentplan.appact_line|'); // no literal preview -> the no-preview variant
    expect(text).not.toContain('agentplan.schedule_restate_hint');
    expect(text).toContain('agentplan.confirm_prompt');
  });

  it('surfaces a literal content preview when an app-act param is not the {{result}} placeholder', () => {
    const draft = baseDraft({
      action: {
        type: 'app-act',
        appActRecipeId: 'x.post',
        appActParams: { text: 'Good morning from Shelly' },
      },
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('Good morning from Shelly');
    expect(text).toContain('agentplan.appact_line_with_preview|');
  });

  it('multi-step orchestration with MIXED pinned/unpinned steps lists each instruction and pinned-tool label', () => {
    const steps: Array<string | AgentOrchestrationStep> = [
      'search for news on the topic',
      { instruction: 'summarize on the local model', tool: { type: 'local' } },
      { instruction: 'post the digest to X', tool: { type: 'cli', cli: 'codex' } },
    ];
    const draft = baseDraft({
      action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } },
      orchestrationSteps: steps,
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('1. search for news on the topic');
    expect(text).toContain('2. [Local LLM] summarize on the local model');
    expect(text).toContain('3. [Codex CLI] post the digest to X');
  });

  it('invalid-schedule case: ambiguous recurrence surfaces the restatement hint and omits the confirm prompt', () => {
    const draft = baseDraft({
      schedule: null,
      scheduleConfident: false,
      suggestedFrequency: 'daily',
      action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } },
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('agentplan.schedule_restate_hint');
    expect(text).not.toContain('agentplan.confirm_prompt');
  });

  it('includes autonomous, memory, matched-skill, and actionCaveat lines when present', () => {
    const draft = baseDraft({
      autonomous: true,
      memory: { remember: true, rememberFact: 'the user prefers concise summaries' },
      matchedSkill: { id: 'skill-1', name: 'news-digest', successCount: 3 },
      actionCaveat: 'LINEへの投稿にはまだ対応していないため、下書き（ファイル保存）として登録します',
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('agentplan.autonomous_note');
    expect(text).toContain('the user prefers concise summaries');
    expect(text).toContain('news-digest');
    expect(text).toContain('LINEへの投稿にはまだ対応していない');
  });
});

describe('draftToConfirmedAgentDraft', () => {
  it('carries the draft through verbatim with the SAME defaults AgentConfirmCard starts with (runOn auto, matched skill reused by default)', () => {
    const draft = baseDraft({
      matchedSkill: { id: 'skill-1', name: 'news-digest', successCount: 3 },
      orchestrationSteps: ['a', 'b'],
    });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed).toEqual({
      name: draft.name,
      prompt: draft.prompt,
      schedule: draft.schedule,
      tool: draft.tool,
      action: draft.action,
      runOn: 'auto',
      autonomous: false,
      memory: draft.memory,
      skillId: 'skill-1',
      orchestrationSteps: draft.orchestrationSteps,
      notificationTrigger: null,
    });
  });

  it('defaults autonomous to false when the draft never set it', () => {
    const confirmed = draftToConfirmedAgentDraft(baseDraft());
    expect(confirmed.autonomous).toBe(false);
  });
});
