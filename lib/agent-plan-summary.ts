/**
 * lib/agent-plan-summary.ts
 *
 * Chat-native natural-language rendering of a ParsedAgentDraft (Phase 7).
 *
 * The project owner has repeatedly rejected a structured confirm card/modal for
 * NEW confirmation surfaces ("カードも要らないって。チャットで自然言語で確認すれば
 * いいじゃん。" — no card, confirm via natural-language chat). app-act registration
 * (X-posting etc.) and tool-pinned multi-step orchestration (Phase 6's
 * `detectToolPinnedSteps`) are the first surfaces built chat-native from the start
 * instead of retrofitting `AgentConfirmCard`.
 *
 * `summarizeAgentDraftAsText` is the NL equivalent of what AgentConfirmCard renders
 * as editable form fields: name, schedule, per-step instruction + pinned tool,
 * action-in-plain-language (app-act's recipe/target + resolved content preview when
 * available), and any caveats. It is a PURE function — no store reads, no RN — so it
 * is trivially unit-testable and reuses the exact schedule phrasing AgentConfirmCard
 * uses via `scheduleHuman` (lib/agent-card-cron.ts) and the exact tool labels via
 * `toolChoiceToLabel` (lib/agent-tool-router.ts). Do not duplicate either mapping.
 *
 * `hasFireableSchedule` mirrors AgentConfirmCard's HARD REQUIREMENT ("never register
 * an agent that will never fire"): Confirm must be refused until either (a) the
 * parser produced a confident, valid cron, or (b) the utterance is a genuine one-shot
 * (no recurrence was stated at all — "run now"). An utterance that stated a
 * recurrence but no confirmable time (`suggestedFrequency` set, `schedule` still
 * null) is the exact "would silently never fire (or fire on an unreviewed default)"
 * case the card blocks by forcing a manual time pick — this chat-native flow has no
 * field-editing, so instead of silently defaulting it must refuse and ask the user
 * to restate the schedule with an explicit time.
 */
import { ParsedAgentDraft } from './agent-nl-parser';
import { AgentAction } from '@/store/types';
import { toolChoiceToLabel } from './agent-tool-router';
import { decodeCron, scheduleHuman } from './agent-card-cron';
import { t } from './i18n';
// Type-only: erased at compile time, so importing from the .tsx component this
// pure module otherwise has nothing to do with never pulls React/RN into its
// (or its jest unit-project's) runtime graph.
import type { ConfirmedAgentDraft } from '@/components/panes/AgentConfirmCard';

/**
 * true = the draft carries either a confident recurring schedule or a genuine
 * one-shot (no recurrence stated) — safe to register. false = the parser found a
 * recurrence cue but no confirmable time; the schedule needs to be restated before
 * this draft can be registered (see module doc comment).
 */
export function hasFireableSchedule(draft: ParsedAgentDraft): boolean {
  if (draft.schedule !== null) return true;
  return draft.suggestedFrequency === undefined;
}

/**
 * Project owner directive 2026-07-14 ("デフォは承認なしな。任意で確認" —
 * default is no-approval, confirmation optional): true when a draft that
 * still uses AgentConfirmCard (never called for the chat-native app-act/
 * tool-pinned flow — see shouldUseChatConfirm, an entirely separate,
 * already-merged (#135) surface this function must not affect) should be
 * registered IMMEDIATELY with no human Confirm tap, because the global/
 * per-registration "no approval" default is in effect. Mirrors
 * hasFireableSchedule's own hard requirement: a draft whose schedule still
 * needs to be restated is NEVER auto-registered, regardless of
 * requireRegistrationConfirm — "never register an agent that will never
 * fire" is a content classifier, not an approval-frequency knob.
 */
export function shouldAutoRegisterDraft(draft: ParsedAgentDraft, requireRegistrationConfirm: boolean): boolean {
  return !requireRegistrationConfirm && hasFireableSchedule(draft);
}

/**
 * true when this draft should use the chat-native confirm affordance instead of
 * AgentConfirmCard: an app-act action (the explicit example the project owner
 * named), or a multi-step orchestration where at least one step pins a concrete
 * tool (Phase 6's `detectToolPinnedSteps`, as opposed to Phase 4's plain
 * auto-routed step chain, which keeps using the card unchanged this phase).
 */
export function shouldUseChatConfirm(draft: ParsedAgentDraft): boolean {
  if (draft.action.type === 'app-act') return true;
  return (draft.orchestrationSteps ?? []).some((s) => typeof s !== 'string' && !!s.tool);
}

function scheduleText(draft: ParsedAgentDraft): string {
  if (draft.schedule !== null) {
    const decoded = decodeCron(draft.schedule);
    return scheduleHuman(
      decoded.frequency,
      decoded.hour,
      decoded.minute,
      decoded.weekday,
      decoded.interval,
      t,
      decoded.dowList,
      decoded.hourList
        ? decoded.hourList.split(',').map((h) => parseInt(h, 10)).filter((n) => !Number.isNaN(n))
        : [],
    );
  }
  if (draft.suggestedFrequency !== undefined) {
    // Ambiguous — see hasFireableSchedule. Do not fabricate a time here; the
    // dedicated hint line (schedule_restate_hint) covers this case.
    return t('agentcard.schedule_unset');
  }
  return t('agentcard.sched_once');
}

/** First app-act param value that isn't the raw `{{result}}` placeholder — a
 *  literal, already-resolved preview of what will be posted, when one exists. */
function appActContentPreview(params: Record<string, string> | undefined): string | undefined {
  if (!params) return undefined;
  for (const value of Object.values(params)) {
    const trimmed = value.trim();
    if (trimmed && !trimmed.includes('{{result}}')) return trimmed;
  }
  return undefined;
}

function actionText(action: AgentAction): string {
  if (action.type === 'app-act') {
    const target = action.appActRecipeId === 'x.post'
      ? t('agentplan.appact_x_target')
      : (action.appActRecipeId ?? t('agentcard.action_app-act'));
    const preview = appActContentPreview(action.appActParams);
    return preview
      ? t('agentplan.appact_line_with_preview', { target, preview })
      : t('agentplan.appact_line', { target });
  }
  const label = t(`agentcard.action_${action.type}`);
  switch (action.type) {
    case 'webhook':
      return action.webhookUrl ? `${label} → ${action.webhookUrl}` : label;
    case 'cli':
      return action.command ? `${label}: ${action.command}` : label;
    case 'intent':
      return action.intentMode === 'launch' && action.intentTarget
        ? `${label} → ${action.intentTarget}`
        : label;
    case 'dm-reply':
      return label;
    default:
      return label;
  }
}

/**
 * Deterministic NL rendering of a ParsedAgentDraft — the chat-native equivalent
 * of AgentConfirmCard's form fields. Covers every field a draft can carry:
 * name, schedule, action (with app-act recipe/target + content preview),
 * orchestration steps (instruction + pinned tool label per Phase 5/6), the
 * autonomous flag, memory intent, a matched reusable skill, and any actionCaveat
 * the parser attached. Ends with the schedule-restatement hint when the schedule
 * is not yet fireable (see hasFireableSchedule) so the chat bubble itself explains
 * why no Confirm affordance is offered.
 */
export function summarizeAgentDraftAsText(draft: ParsedAgentDraft): string {
  const lines: string[] = [];
  lines.push(t('agentplan.summary_name', { name: draft.name }));
  lines.push(t('agentplan.summary_schedule', { schedule: scheduleText(draft) }));
  lines.push(t('agentplan.summary_action', { action: actionText(draft.action) }));

  if (draft.orchestrationSteps && draft.orchestrationSteps.length >= 2) {
    lines.push(t('agentcard.orchestration', { count: draft.orchestrationSteps.length }));
    draft.orchestrationSteps.forEach((s, i) => {
      const instruction = typeof s === 'string' ? s : s.instruction;
      const pinnedTool = typeof s === 'string' ? undefined : s.tool;
      lines.push(
        pinnedTool
          ? `${i + 1}. [${toolChoiceToLabel(pinnedTool)}] ${instruction}`
          : `${i + 1}. ${instruction}`,
      );
    });
  }

  if (draft.autonomous) lines.push(t('agentplan.autonomous_note'));
  if (draft.memory?.remember) {
    lines.push(t('agentplan.memory_note', { fact: draft.memory.rememberFact ?? '' }));
  }
  if (draft.matchedSkill) {
    lines.push(
      t('agentplan.skill_note', {
        name: draft.matchedSkill.name,
        count: draft.matchedSkill.successCount,
      }),
    );
  }
  if (draft.actionCaveat) lines.push(draft.actionCaveat);

  if (!hasFireableSchedule(draft)) {
    lines.push(t('agentplan.schedule_restate_hint'));
  } else {
    lines.push(t('agentplan.confirm_prompt'));
  }

  return lines.join('\n');
}

/**
 * Build the SAME ConfirmedAgentDraft shape AgentConfirmCard's `handleConfirm`
 * emits, but taken verbatim from the parsed draft — no inline editing, per the
 * project owner's stated design ("re-prompt in chat, don't edit fields"). Reuses
 * `confirmAgentDraft`'s EXISTING autonomous-tool resolution (resolveAutonomousFinalTool
 * in hooks/use-ai-pane-dispatch.ts) rather than duplicating it here: `tool` is
 * passed through as the raw scored suggestion and `runOn: 'auto'` matches
 * AgentConfirmCard's own unedited default state, so confirmAgentDraft resolves it
 * identically regardless of whether the draft came from the card or this chat-native
 * path.
 *
 * Callers MUST check `hasFireableSchedule(draft)` first — this function does not
 * re-validate the schedule and will happily pass through a null schedule for the
 * ambiguous (needs-restatement) case, registering a one-shot instead of the
 * recurring agent the user actually asked for.
 *
 * notificationTrigger passes through draft.notificationTrigger rather than being
 * hardcoded null: conversational slot-filling (lib/agent-slot-fill.ts) can
 * populate this field on the draft when the utterance implies a
 * notification-triggered agent, and a draft only ever reaches this function
 * (via presentDraftForConfirmation in hooks/use-ai-pane-dispatch.ts) after
 * slot-filling has finished asking — dropping it here would silently discard
 * a trigger the user was just asked for and answered.
 */
export function draftToConfirmedAgentDraft(draft: ParsedAgentDraft): ConfirmedAgentDraft {
  return {
    name: draft.name,
    prompt: draft.prompt,
    // 'once' is a sentinel meaning "run now and don't schedule" (parseSchedule's
    // encoding for answers like "すぐに"/"now") -- AgentConfirmCard.handleConfirm
    // normalizes this to null (schedule: isOnce ? null : cron) before it ever
    // reaches createAgent; this bypass path must do the same or the agent is
    // persisted with a literal 'once' schedule that isEphemeralOneShot doesn't
    // recognize and cronToIntervalMs can't parse -- a zombie agent that neither
    // runs-and-discards nor ever fires.
    schedule: draft.schedule === 'once' ? null : draft.schedule,
    tool: draft.tool,
    action: draft.action,
    runOn: 'auto',
    autonomous: draft.autonomous ?? false,
    memory: draft.memory,
    skillId: draft.matchedSkill?.id,
    orchestrationSteps: draft.orchestrationSteps,
    notificationTrigger: draft.notificationTrigger ?? null,
  };
}
