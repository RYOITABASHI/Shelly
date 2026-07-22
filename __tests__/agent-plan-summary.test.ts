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
  hasDraftAssumptions,
  shouldUseChatConfirm,
  shouldAutoRegisterDraft,
  isAutoRegisterEligibleOnChatConfirm,
  summarizeAgentDraftAsText,
  draftToConfirmedAgentDraft,
} from '@/lib/agent-plan-summary';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { AgentOrchestrationStep } from '@/store/types';
import { isEphemeralOneShot } from '@/lib/notification-trigger';

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

// Project owner directive 2026-07-14 ("デフォは承認なしな。任意で確認" —
// default is no-approval, confirmation optional): shouldAutoRegisterDraft is
// the AgentConfirmCard-eligible registration path's default-OFF gate (see
// hooks/use-ai-pane-dispatch.ts, which calls this ONLY when
// !shouldUseChatConfirm — the already-merged #135 chat-native flow is a
// separate surface untouched by this directive).
describe('shouldAutoRegisterDraft', () => {
  it('true by default (requireRegistrationConfirm=false) for a draft with a fireable schedule', () => {
    expect(shouldAutoRegisterDraft(baseDraft(), false)).toBe(true);
  });

  it('true by default for a genuine one-shot too (no recurrence stated)', () => {
    expect(shouldAutoRegisterDraft(baseDraft({ schedule: null, scheduleConfident: false }), false)).toBe(true);
  });

  it('opt-in ON (requireRegistrationConfirm=true) restores the mandatory Confirm tap even with a fireable schedule', () => {
    expect(shouldAutoRegisterDraft(baseDraft(), true)).toBe(false);
  });

  it('NEVER auto-registers a draft that still needs its schedule restated, regardless of requireRegistrationConfirm — not an approval-frequency knob', () => {
    const needsRestatement = baseDraft({ schedule: null, scheduleConfident: false, suggestedFrequency: 'daily' });
    expect(shouldAutoRegisterDraft(needsRestatement, false)).toBe(false);
    expect(shouldAutoRegisterDraft(needsRestatement, true)).toBe(false);
  });

  // Phase B (2026-07-22) hard safety gate: a schedule DEFAULTED from a bare
  // time-of-day word ("朝"→08:00) is fireable (unlike the schedule_restate
  // case above) but must still never skip the human confirm step — same
  // "content classifier, not an approval-frequency knob" reasoning.
  it('NEVER auto-registers a draft with an ASSUMED schedule, regardless of requireRegistrationConfirm, even though the schedule IS fireable', () => {
    const assumed = baseDraft({ scheduleAssumed: true });
    expect(hasFireableSchedule(assumed)).toBe(true); // sanity: not blocked by the OTHER gate
    expect(shouldAutoRegisterDraft(assumed, false)).toBe(false);
    expect(shouldAutoRegisterDraft(assumed, true)).toBe(false);
  });

  // 2026-07-23 hybrid LLM-extraction fallback gate: an LLM-derived field can
  // look just as complete/explicit as a deterministic match (e.g. a
  // fully-formed cron time with an explicit digit), but it must still never
  // skip the human confirm round-trip — same "content classifier, not an
  // approval-frequency knob" reasoning as the scheduleAssumed gate above.
  it('NEVER auto-registers a draft with llmExtracted set, even with an explicit fireable schedule, regardless of requireRegistrationConfirm', () => {
    const llmDerived = baseDraft({ llmExtracted: true });
    expect(hasFireableSchedule(llmDerived)).toBe(true); // sanity: not blocked by the OTHER gate
    expect(shouldAutoRegisterDraft(llmDerived, false)).toBe(false);
    expect(shouldAutoRegisterDraft(llmDerived, true)).toBe(false);
  });

  it('end-to-end: parseAgentNL("毎朝ニュースまとめて") never auto-registers under the no-approval default, but an explicit "毎日8時に" utterance still does', () => {
    const vague = parseAgentNL('毎朝ニュースまとめて');
    expect(vague.scheduleAssumed).toBe(true);
    expect(shouldAutoRegisterDraft(vague, false)).toBe(false);

    const explicit = parseAgentNL('毎日8時にニュースまとめて');
    expect(explicit.scheduleAssumed).toBeUndefined();
    expect(shouldAutoRegisterDraft(explicit, false)).toBe(true);
  });
});

// 2026-07-23 regression, found via on-device testing: Phase B
// (`433bdae93`) moved draft/notify onto the chat-confirm UI surface
// (shouldUseChatConfirm), but hooks/use-ai-pane-dispatch.ts's
// presentDraftForConfirmation still gated its shouldAutoRegisterDraft() call
// on the OLD `!useChatConfirm` condition — silently making every explicit,
// no-assumption draft/notify utterance require a confirm round-trip it never
// needed pre-Phase-B ("毎日21時にバッテリー残量を通知して" showed a
// Cancel/Confirm prompt instead of registering in one message). These tests
// lock in the fix: isAutoRegisterEligibleOnChatConfirm(action.type), and the
// exact `!useChatConfirm || isAutoRegisterEligibleOnChatConfirm(...)` gate
// shape hooks/use-ai-pane-dispatch.ts's presentDraftForConfirmation now uses.
describe('isAutoRegisterEligibleOnChatConfirm', () => {
  it('true for draft and notify — T0/local-only risk, unaffected by which UI surface renders confirmation', () => {
    expect(isAutoRegisterEligibleOnChatConfirm('draft')).toBe(true);
    expect(isAutoRegisterEligibleOnChatConfirm('notify')).toBe(true);
  });

  it('false for every external-posting/multi-step type that must always require an explicit confirm', () => {
    expect(isAutoRegisterEligibleOnChatConfirm('app-act')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('social-post')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('webhook')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('cli')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('intent')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('dm-reply')).toBe(false);
    expect(isAutoRegisterEligibleOnChatConfirm('api-call')).toBe(false);
  });
});

describe('presentDraftForConfirmation auto-register gate (hooks/use-ai-pane-dispatch.ts shape)', () => {
  // Reproduces the exact `autoRegisterEligible` expression from
  // presentDraftForConfirmation so this suite fails if that gate's shape
  // ever regresses back to the pre-fix `!useChatConfirm`-only form.
  function autoRegisterEligible(draft: ParsedAgentDraft): boolean {
    const useChatConfirm = shouldUseChatConfirm(draft);
    return !useChatConfirm || isAutoRegisterEligibleOnChatConfirm(draft.action.type);
  }

  it('the exact reported bug: an explicit notify utterance auto-registers instead of requiring a confirm tap', () => {
    const explicit = parseAgentNL('毎日21時にバッテリー残量を通知して');
    expect(explicit.action.type).toBe('notify');
    expect(shouldUseChatConfirm(explicit)).toBe(true); // Phase B: notify IS chat-confirm
    expect(autoRegisterEligible(explicit)).toBe(true); // …but still auto-register-eligible
    expect(shouldAutoRegisterDraft(explicit, false)).toBe(true);
  });

  it('an explicit draft utterance auto-registers the same way', () => {
    const explicit = parseAgentNL('毎日9時にニュースをまとめてファイルに保存して');
    expect(explicit.action.type).toBe('draft');
    expect(shouldUseChatConfirm(explicit)).toBe(true);
    expect(autoRegisterEligible(explicit)).toBe(true);
    expect(shouldAutoRegisterDraft(explicit, false)).toBe(true);
  });

  it('an assumed-schedule draft/notify still requires confirm (the Phase B safety gate is untouched by this fix)', () => {
    const vague = baseDraft({ action: { type: 'notify' }, scheduleAssumed: true });
    expect(shouldUseChatConfirm(vague)).toBe(true);
    expect(autoRegisterEligible(vague)).toBe(true); // type-eligible…
    expect(shouldAutoRegisterDraft(vague, false)).toBe(false); // …but the assumption gate still blocks it
  });

  it('app-act/social-post remain confirm-only regardless of the no-approval-default setting (unchanged by this fix)', () => {
    const appAct = baseDraft({ action: { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: 'hi' } } });
    expect(shouldUseChatConfirm(appAct)).toBe(true);
    expect(autoRegisterEligible(appAct)).toBe(false);

    const socialPost = baseDraft({
      action: { type: 'social-post', socialPost: { platform: 'bluesky', connectorId: 'x', text: 'hi' } },
    });
    expect(shouldUseChatConfirm(socialPost)).toBe(true);
    expect(autoRegisterEligible(socialPost)).toBe(false);
  });

  it('card-eligible types (e.g. webhook) are unaffected — still gated purely by !useChatConfirm, as before this fix', () => {
    const webhook = baseDraft({ action: { type: 'webhook', webhookUrl: 'https://example.com/hook' } });
    expect(shouldUseChatConfirm(webhook)).toBe(false);
    expect(autoRegisterEligible(webhook)).toBe(true);
    expect(shouldAutoRegisterDraft(webhook, false)).toBe(true);
  });
});

describe('hasDraftAssumptions', () => {
  it('false for an ordinary draft with an explicit schedule', () => {
    expect(hasDraftAssumptions(baseDraft())).toBe(false);
  });

  it('true when scheduleAssumed is set', () => {
    expect(hasDraftAssumptions(baseDraft({ scheduleAssumed: true }))).toBe(true);
  });

  it('true when llmExtracted is set, even with an otherwise fully explicit draft (2026-07-23)', () => {
    expect(hasDraftAssumptions(baseDraft({ llmExtracted: true }))).toBe(true);
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

  // Phase B (2026-07-22): draft/notify joined app-act/social-post/tool-pinned
  // as chat-native — this is the change that makes chat-native confirm the
  // DEFAULT for the everyday single-step agent, not the exception. baseDraft()
  // defaults to action:{type:'draft'}, so plenty of the OTHER describe blocks
  // in this file (which use baseDraft() as-is) now exercise the chat-native
  // path too; see summarizeAgentDraftAsText's own tests below.
  it('true for a plain draft action with no orchestration (Phase B)', () => {
    expect(shouldUseChatConfirm(baseDraft())).toBe(true);
  });

  it('true for a plain notify action with no orchestration (Phase B)', () => {
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'notify' } }))).toBe(true);
  });

  it('false for a plain auto-routed multi-step chain with NO pinned tools, on a non-draft/notify action (still card-routed)', () => {
    // Must use an action type OTHER than draft/notify to isolate the
    // "no pinned tool" invariant from Phase B's separate draft/notify rule —
    // webhook/cli/intent/dm-reply/api-call are unaffected by this phase.
    const steps: Array<string | AgentOrchestrationStep> = ['first step', 'second step'];
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'cli' }, orchestrationSteps: steps }))).toBe(false);
  });

  it('false for a plain webhook/cli/intent/dm-reply action with no orchestration (unaffected by Phase B)', () => {
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'webhook' } }))).toBe(false);
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'cli' } }))).toBe(false);
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'intent', intentMode: 'launch' } }))).toBe(false);
    expect(shouldUseChatConfirm(baseDraft({ action: { type: 'dm-reply' } }))).toBe(false);
  });

  // social-post (2026-07-22): same chat-native reasoning as app-act — an
  // external post is not a local file save, so it gets the same "no card,
  // plain chat confirm" treatment.
  it('true for a social-post action', () => {
    expect(
      shouldUseChatConfirm(
        baseDraft({
          action: { type: 'social-post', socialPost: { platform: 'mastodon', connectorId: 'my-mastodon', text: '{{result}}' } },
        }),
      ),
    ).toBe(true);
  });

  it('true while the connector is still ambiguous too, now that draft itself is chat-native (Phase B)', () => {
    // Before Phase B, action.type stayed 'draft' while ambiguous (see
    // lib/agent-slot-fill.ts's socialConnector slot-fill question, which
    // runs BEFORE this function is ever consulted for such a draft) and that
    // used to fall through to the card-eligible path. Phase B makes 'draft'
    // itself chat-native, so this input now also resolves to chat-native —
    // harmless either way since the caller only ever consults this AFTER
    // slot-filling has resolved (or given up on) the ambiguity.
    const draft = baseDraft({
      action: { type: 'draft' },
      socialPostCandidates: [
        { id: 'a', platform: 'mastodon', label: 'A', host: 'mastodon.social', fields: ['accessToken'], createdAt: 0 },
        { id: 'b', platform: 'mastodon', label: 'B', host: 'mastodon.social', fields: ['accessToken'], createdAt: 0 },
      ],
    });
    expect(shouldUseChatConfirm(draft)).toBe(true);
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

  it('social-post: no literal preview -> the no-preview variant with platform + connector', () => {
    const draft = baseDraft({
      action: { type: 'social-post', socialPost: { platform: 'mastodon', connectorId: 'my-mastodon', text: '{{result}}' } },
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('agentplan.socialpost_line|');
    expect(text).toContain('social_connectors.platform_mastodon');
    expect(text).toContain('my-mastodon');
    expect(text).not.toContain('agentplan.socialpost_line_with_preview');
    expect(text).toContain('agentplan.confirm_prompt');
  });

  it('social-post: surfaces a literal content preview when the post text is not the {{result}} placeholder', () => {
    const draft = baseDraft({
      action: { type: 'social-post', socialPost: { platform: 'bluesky', connectorId: 'me-bsky', text: 'Good morning from Shelly' } },
    });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('agentplan.socialpost_line_with_preview|');
    expect(text).toContain('Good morning from Shelly');
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

  // Phase B (2026-07-22): draft outputPath surfaced as the action's main param.
  it('draft action with an outputPath: surfaces the destination as the main param', () => {
    const draft = baseDraft({ action: { type: 'draft' }, outputPath: 'notes/news' });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('agentplan.draft_line_with_path|');
    expect(text).toContain('notes/news');
  });

  it('draft action with NO outputPath: falls back to the plain label, no fabricated default path', () => {
    const draft = baseDraft({ action: { type: 'draft' }, outputPath: undefined });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).not.toContain('agentplan.draft_line_with_path');
    expect(text).toContain('agentcard.action_draft');
  });

  // Phase B (2026-07-22): a schedule DEFAULTED from a bare time-of-day word
  // declares its interpretation and the concrete next-fire datetime.
  describe('scheduleAssumed annotation', () => {
    it('daily-assumed ("朝"→08:00): declares the interpretation and a next-fire line', () => {
      const draft = baseDraft({ schedule: '0 8 * * *', scheduleAssumed: true, suggestedTime: { hour: 8, minute: 0 } });
      const text = summarizeAgentDraftAsText(draft);
      expect(text).toContain('agentplan.schedule_assumed_note|');
      expect(text).toContain('"word":"朝"');
      expect(text).toContain('"time":"08:00"');
      expect(text).toContain('agentplan.next_fire_note|');
    });

    it('a different default hour (夜→21:00) reverse-maps to the right word', () => {
      const draft = baseDraft({ schedule: '0 21 * * *', scheduleAssumed: true, suggestedTime: { hour: 21, minute: 0 } });
      const text = summarizeAgentDraftAsText(draft);
      expect(text).toContain('"word":"夜"');
      expect(text).toContain('"time":"21:00"');
    });

    it('an ordinary explicit schedule (scheduleAssumed unset) omits both lines', () => {
      const text = summarizeAgentDraftAsText(baseDraft());
      expect(text).not.toContain('agentplan.schedule_assumed_note');
      expect(text).not.toContain('agentplan.next_fire_note');
    });

    it('a weekly-assumed schedule also gets the annotation', () => {
      const draft = baseDraft({
        schedule: '0 8 * * 1,5',
        scheduleAssumed: true,
        suggestedTime: { hour: 8, minute: 0 },
      });
      const text = summarizeAgentDraftAsText(draft);
      expect(text).toContain('agentplan.schedule_assumed_note|');
      expect(text).toContain('"word":"朝"');
      expect(text).toContain('agentplan.next_fire_note|');
    });
  });

  // Phase C (2026-07-22): lib/agent-draft-patch.ts's applyDraftPatch reports
  // which fields a follow-up reply touched; the re-posted summary marks
  // exactly those lines with '★' (and, once ANY field is marked, the other
  // rendered lines get a neutral '・' so a reader isn't left guessing whether
  // an unprefixed line was reviewed or simply not part of the mark scheme).
  describe('changedFields marking', () => {
    it('with no changedFields argument (the default), output is byte-identical to the un-marked call (backward compatible)', () => {
      const draft = baseDraft();
      expect(summarizeAgentDraftAsText(draft)).toBe(summarizeAgentDraftAsText(draft, new Set()));
    });

    it('marks the schedule line with ★ and leaves name/action with the neutral ・ marker', () => {
      const draft = baseDraft();
      const text = summarizeAgentDraftAsText(draft, new Set(['schedule']));
      const lines = text.split('\n');
      const scheduleLine = lines.find((l) => l.includes('agentplan.summary_schedule'));
      const nameLine = lines.find((l) => l.includes('agentplan.summary_name'));
      const actionLine = lines.find((l) => l.includes('agentplan.summary_action'));
      expect(scheduleLine?.startsWith('★ ')).toBe(true);
      expect(nameLine?.startsWith('・ ')).toBe(true);
      expect(actionLine?.startsWith('・ ')).toBe(true);
    });

    it('marks MULTIPLE changed lines independently', () => {
      const draft = baseDraft();
      const text = summarizeAgentDraftAsText(draft, new Set(['schedule', 'name']));
      const lines = text.split('\n');
      const scheduleLine = lines.find((l) => l.includes('agentplan.summary_schedule'));
      const nameLine = lines.find((l) => l.includes('agentplan.summary_name'));
      const actionLine = lines.find((l) => l.includes('agentplan.summary_action'));
      expect(scheduleLine?.startsWith('★ ')).toBe(true);
      expect(nameLine?.startsWith('★ ')).toBe(true);
      expect(actionLine?.startsWith('・ ')).toBe(true);
    });

    it('marks the autonomous_note line with ★ only when "autonomous" is in changedFields', () => {
      const draft = baseDraft({ autonomous: true });
      const marked = summarizeAgentDraftAsText(draft, new Set(['autonomous']));
      const unmarkedButOtherFieldChanged = summarizeAgentDraftAsText(draft, new Set(['schedule']));
      const markedLine = marked.split('\n').find((l) => l.includes('agentplan.autonomous_note'));
      const otherLine = unmarkedButOtherFieldChanged.split('\n').find((l) => l.includes('agentplan.autonomous_note'));
      expect(markedLine?.startsWith('★ ')).toBe(true);
      expect(otherLine?.startsWith('・ ')).toBe(true);
    });

    it('an empty changedFields set (explicit) produces the same un-marked output as omitting the argument', () => {
      const draft = baseDraft();
      const text = summarizeAgentDraftAsText(draft, new Set());
      const scheduleLine = text.split('\n').find((l) => l.includes('agentplan.summary_schedule'));
      expect(scheduleLine?.startsWith('★')).toBe(false);
      expect(scheduleLine?.startsWith('・')).toBe(false);
    });
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

  it('carries a conversationally slot-filled notificationTrigger through instead of dropping it', () => {
    // Regression coverage for the conversational-slot-fill recovery
    // (lib/agent-slot-fill.ts's needsNotificationTrigger/applySlotAnswer can
    // populate draft.notificationTrigger via a follow-up chat question) — this
    // used to be hardcoded to `null` here, silently discarding an answer the
    // user was just asked for on the auto-register/chat-confirm path.
    const draft = baseDraft({ notificationTrigger: { packageNames: ['com.whatsapp'] } });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.notificationTrigger).toEqual({ packageNames: ['com.whatsapp'] });
  });

  it('normalizes the "once" sentinel to null, mirroring AgentConfirmCard.handleConfirm (schedule: isOnce ? null : cron)', () => {
    // Regression coverage: a slot-fill answer like "すぐに"/"now" makes
    // parseSchedule return the 'once' sentinel. The card normalizes this to
    // null before calling onConfirm; this bypass path (used by
    // shouldAutoRegisterDraft/shouldUseChatConfirm) must do the same, or the
    // agent is persisted with a literal 'once' schedule string that
    // isEphemeralOneShot doesn't recognize (only schedule === null) and that
    // cronToIntervalMs can't parse -- a zombie agent that neither
    // runs-and-discards nor ever fires.
    const draft = baseDraft({ schedule: 'once' });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.schedule).toBeNull();
  });

  it('the normalized "once" -> null schedule is recognized as an ephemeral one-shot by isEphemeralOneShot', () => {
    const draft = baseDraft({ schedule: 'once' });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(isEphemeralOneShot(confirmed.schedule, confirmed.notificationTrigger)).toBe(true);
  });

  it('carries a resolved social-post action through verbatim (platform/connectorId/text)', () => {
    const draft = baseDraft({
      action: { type: 'social-post', socialPost: { platform: 'mastodon', connectorId: 'my-mastodon', text: '{{result}}' } },
    });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.action).toEqual({
      type: 'social-post',
      socialPost: { platform: 'mastodon', connectorId: 'my-mastodon', text: '{{result}}' },
    });
  });

  it('does not treat an unrelated cron schedule as ephemeral (sanity check for the isEphemeralOneShot regression test above)', () => {
    const draft = baseDraft({ schedule: '0 8 * * *' });
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.schedule).toBe('0 8 * * *');
    expect(isEphemeralOneShot(confirmed.schedule, confirmed.notificationTrigger)).toBe(false);
  });
});
