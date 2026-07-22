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

  it('end-to-end: parseAgentNL("毎朝ニュースまとめて") never auto-registers under the no-approval default, but an explicit "毎日8時に" utterance still does', () => {
    const vague = parseAgentNL('毎朝ニュースまとめて');
    expect(vague.scheduleAssumed).toBe(true);
    expect(shouldAutoRegisterDraft(vague, false)).toBe(false);

    const explicit = parseAgentNL('毎日8時にニュースまとめて');
    expect(explicit.scheduleAssumed).toBeUndefined();
    expect(shouldAutoRegisterDraft(explicit, false)).toBe(true);
  });
});

describe('hasDraftAssumptions', () => {
  it('false for an ordinary draft with an explicit schedule', () => {
    expect(hasDraftAssumptions(baseDraft())).toBe(false);
  });

  it('true when scheduleAssumed is set', () => {
    expect(hasDraftAssumptions(baseDraft({ scheduleAssumed: true }))).toBe(true);
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
