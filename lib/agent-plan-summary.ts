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
import { ParsedAgentDraft, TIME_OF_DAY_ASSUMPTION_LABEL, fmtTime } from './agent-nl-parser';
import { AgentAction } from '@/store/types';
import { toolChoiceToLabel } from './agent-tool-router';
import { decodeCron, scheduleHuman, nextFireDate } from './agent-card-cron';
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
 * true when ANY field on this draft was filled in by an assumption rather
 * than something the user stated explicitly — `draft.scheduleAssumed` (a
 * bare time-of-day word like "朝" defaulted to 08:00 by
 * lib/agent-nl-parser.ts's TIME_OF_DAY_DEFAULTS instead of being asked
 * about), OR (2026-07-23) `draft.llmExtracted` (one or more fields came from
 * the hybrid LLM-extraction fallback instead of the deterministic parser —
 * see lib/agent-llm-fallback.ts's extractAgentFieldsWithLlm). Kept as its
 * own named predicate (rather than inlining the field checks at each call
 * site) so a future assumption source has one place to plug into. Consulted
 * by shouldAutoRegisterDraft's hard safety gate below (Phase B item 7): an
 * assumption must always get a human's eyes on it via one await-confirm
 * round-trip before registering, even under the "no approval needed"
 * default — never silently opaque. This is exactly why llmExtracted belongs
 * here too: an LLM-derived field can look just as complete/explicit as a
 * deterministic match (e.g. a fully-formed cron time), but it is inherently
 * less trustworthy than an actual keyword/digit match, so it must never
 * skip the same human-review gate a defaulted time-of-day word doesn't get
 * to skip either.
 */
export function hasDraftAssumptions(draft: ParsedAgentDraft): boolean {
  return draft.scheduleAssumed === true || draft.llmExtracted === true;
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
 *
 * Phase B (2026-07-22) hard safety gate: a draft carrying an ASSUMED value
 * (hasDraftAssumptions — currently just a defaulted "朝"→08:00-style
 * schedule) is NEVER auto-registered either, regardless of
 * requireRegistrationConfirm — same "content classifier, not an
 * approval-frequency knob" reasoning as the fireable-schedule check right
 * above it. This function is called for TWO groups of draft: (a) every
 * non-chat-confirm (AgentConfirmCard-eligible) draft — webhook/cli/intent/
 * dm-reply/api-call — where this is the only gate protecting an assumption-
 * bearing draft, and (b) as of the 2026-07-23 fix below, draft/notify too,
 * even though they use the chat-confirm UI surface — see
 * isAutoRegisterEligibleOnChatConfirm's doc comment for why app-act/social-
 * post/tool-pinned orchestration do NOT reach this function despite also
 * being chat-confirm.
 */
export function shouldAutoRegisterDraft(draft: ParsedAgentDraft, requireRegistrationConfirm: boolean): boolean {
  if (hasDraftAssumptions(draft)) return false;
  return !requireRegistrationConfirm && hasFireableSchedule(draft);
}

/**
 * Action types eligible for the no-approval-default auto-register fast path
 * even when shouldUseChatConfirm(draft) is true — see that function's own
 * doc comment for the full chat-confirm type list.
 *
 * Found via on-device testing (2026-07-23): Phase B extended
 * shouldUseChatConfirm() to draft/notify, but hooks/use-ai-pane-dispatch.ts's
 * presentDraftForConfirmation still gated its shouldAutoRegisterDraft() call
 * on `!useChatConfirm`, a condition written back when ONLY app-act/social-
 * post/tool-pinned orchestration (external-posting/multi-step, deliberately
 * NEVER auto-registered) used chat confirm. That blanket gate silently made
 * every explicit, no-assumption draft/notify utterance ("毎日21時にバッテ
 * リー残量を通知して") require a confirm round-trip it never needed before
 * Phase B moved their UI surface — losing the "no-approval default" fast
 * path for exactly the two types Fable5's UX design named as the majority
 * case that should register in one message.
 *
 * draft/notify are purely local (T0 risk) — same tier they had before Phase
 * B, so they stay eligible here. app-act/social-post/tool-pinned
 * orchestration are deliberately NOT included: shouldAutoRegisterDraft alone
 * has no action-type awareness, so callers must keep gating those on
 * `!useChatConfirm` (i.e. never call shouldAutoRegisterDraft for them at
 * all) exactly as before this fix.
 */
export function isAutoRegisterEligibleOnChatConfirm(actionType: AgentAction['type']): boolean {
  return actionType === 'draft' || actionType === 'notify';
}

/**
 * true when this draft should use the chat-native confirm affordance instead of
 * AgentConfirmCard: an app-act action (the explicit example the project owner
 * named), a social-post action (2026-07-22 — same "external post, chat-native
 * confirm" reasoning as app-act; AgentConfirmCard's picker UI is kept for the
 * card-eligible path this doesn't touch), or a multi-step orchestration where
 * at least one step pins a concrete tool (Phase 6's `detectToolPinnedSteps`, as
 * opposed to Phase 4's plain auto-routed step chain, which keeps using the card
 * unchanged this phase).
 *
 * Note: a draft whose social-post connector is still AMBIGUOUS (see
 * ParsedAgentDraft.socialPostCandidates) has `action.type === 'draft'` at this
 * point, not 'social-post' — it correctly falls through to card-eligible here.
 * lib/agent-slot-fill.ts's socialConnector slot-fill question runs first and
 * only calls this once the connector is resolved (or has been given up on).
 *
 * Phase B (2026-07-22): `draft` and `notify` join app-act/social-post/
 * tool-pinned-orchestration as chat-native — these two cover the large
 * majority of everyday single-step agents ("毎日ニュースをまとめて" /
 * "毎朝リマインドして"), so this is the change that makes chat-native confirm
 * the DEFAULT experience rather than the exception. webhook/cli/intent/
 * dm-reply/api-call and a plain (no pinned tool) multi-step chain are
 * unchanged and still use AgentConfirmCard — out of scope for this phase.
 */
export function shouldUseChatConfirm(draft: ParsedAgentDraft): boolean {
  if (draft.action.type === 'app-act') return true;
  if (draft.action.type === 'social-post') return true;
  if (draft.action.type === 'draft') return true;
  if (draft.action.type === 'notify') return true;
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

/** Plain, locale-agnostic "YYYY-MM-DD HH:MM" rendering of a next-fire Date
 *  (nextFireDate, lib/agent-card-cron.ts) for the schedule_assumed next-fire
 *  summary line — deliberately not routed through a full date-formatting
 *  library for a single numeric line used in both JA/EN chat bubbles. */
function formatDateTimeForSummary(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date-only ("YYYY-MM-DD") trim of formatDateTimeForSummary, for the
 *  start_not_before_note line — the deferred-start anchor is a day-level
 *  concept ("来週あたりから"), so no HH:MM is shown. */
function formatDateOnlyForSummary(d: Date): string {
  return formatDateTimeForSummary(d).slice(0, 10);
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

/**
 * @param draft Optional — only consulted for the 'draft' action type today,
 *   to surface `draft.outputPath` (a free-text destination hint set either
 *   directly in the utterance or via lib/agent-slot-fill.ts's outputPath
 *   slot-fill question) as the action's main param, same as AgentConfirmCard
 *   shows an editable output-path field for a draft action. Absent/unset =
 *   the caller falls back to Shelly's default output template — this stays
 *   a PURE render with no settings-store lookup, so an unset outputPath
 *   renders as just the plain action label (no fabricated default path).
 *   `notify` carries no additional param on AgentAction today, so it needs
 *   no equivalent branch.
 */
function actionText(action: AgentAction, draft?: ParsedAgentDraft): string {
  if (action.type === 'app-act') {
    const target = action.appActRecipeId === 'x.post'
      ? t('agentplan.appact_x_target')
      : (action.appActRecipeId ?? t('agentcard.action_app-act'));
    const preview = appActContentPreview(action.appActParams);
    return preview
      ? t('agentplan.appact_line_with_preview', { target, preview })
      : t('agentplan.appact_line', { target });
  }
  if (action.type === 'social-post' && action.socialPost) {
    // No connector display-label is carried on AgentAction (only the
    // registration-time `connectorId` slug — see AgentSocialPostConfig's doc
    // comment in store/types.ts) — this function stays a PURE render with no
    // store lookup, so the user-chosen id slug (usually descriptive, e.g.
    // "my-mastodon") stands in for a display label here.
    const platformLabel = t(`social_connectors.platform_${action.socialPost.platform}`);
    const preview = appActContentPreview({ text: action.socialPost.text ?? '{{result}}' });
    return preview
      ? t('agentplan.socialpost_line_with_preview', {
          platform: platformLabel,
          connector: action.socialPost.connectorId,
          preview,
        })
      : t('agentplan.socialpost_line', { platform: platformLabel, connector: action.socialPost.connectorId });
  }
  const label = t(`agentcard.action_${action.type}`);
  switch (action.type) {
    case 'draft': {
      const outputHint = draft?.outputPath?.trim();
      return outputHint ? t('agentplan.draft_line_with_path', { path: outputHint }) : label;
    }
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
 * Prefix a rendered summary line with a change marker: '★ ' when `field` is
 * in `changedFields` (Phase C, 2026-07-22 — a follow-up patch reply touched
 * this field, see lib/agent-draft-patch.ts), '・ ' when `changedFields` is
 * non-empty but this particular field was NOT touched (so the ★ lines stand
 * out against a visibly-marked "unchanged" baseline rather than plain
 * unmarked text — the reader would otherwise have to guess whether an
 * unprefixed line was reviewed at all), or no prefix at all when
 * `changedFields` is empty (the default/original rendering — every existing
 * caller that never passes changedFields sees byte-identical output to
 * before this function gained the parameter).
 */
function markLine(line: string, field: string, changedFields: ReadonlySet<string>): string {
  if (changedFields.size === 0) return line;
  return (changedFields.has(field) ? '★ ' : '・ ') + line;
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
 *
 * @param changedFields Phase C (2026-07-22): the field names a follow-up
 *   patch reply just touched (lib/agent-draft-patch.ts's DraftPatchResult.
 *   changedFields, e.g. `new Set(['schedule'])`) — the corresponding line(s)
 *   below are prefixed with '★' (see markLine) so the re-posted summary makes
 *   obvious exactly what changed, instead of forcing the reader to diff two
 *   full summaries by eye. Optional; the default (empty set) reproduces the
 *   exact pre-Phase-C output for every existing call site.
 */
export function summarizeAgentDraftAsText(
  draft: ParsedAgentDraft,
  changedFields: ReadonlySet<string> = new Set(),
  isEditing: boolean = false,
): string {
  const lines: string[] = [];
  lines.push(markLine(t('agentplan.summary_name', { name: draft.name }), 'name', changedFields));
  lines.push(markLine(t('agentplan.summary_schedule', { schedule: scheduleText(draft) }), 'schedule', changedFields));

  // Deferred-start ("来週あたりから毎朝…"): declare the "don't fire before"
  // anchor right next to the schedule line it modifies, whenever it's still
  // in the future (a past/elapsed anchor is a permanent no-op — see
  // Agent.startNotBefore's doc comment in store/types.ts — and shows nothing
  // here either, same as it's a no-op for the scheduler).
  const startNotBeforeFuture = !!(draft.startNotBefore && draft.startNotBefore > Date.now());
  if (startNotBeforeFuture) {
    lines.push(t('agentplan.start_not_before_note', { date: formatDateOnlyForSummary(new Date(draft.startNotBefore!)) }));
  }

  lines.push(markLine(t('agentplan.summary_action', { action: actionText(draft.action, draft) }), 'action', changedFields));

  // Phase B (2026-07-22): a schedule resolved from a bare time-of-day word
  // ("朝"→08:00, see lib/agent-nl-parser.ts's TIME_OF_DAY_DEFAULTS) is never
  // left as a silent, opaque assumption — declare the interpretation, right
  // where the schedule line itself was just rendered above, so a "that's not
  // what I meant" is easy to catch before confirming.
  if (draft.scheduleAssumed && draft.schedule) {
    const decoded = decodeCron(draft.schedule);
    const assumedHour = draft.suggestedTime?.hour ?? decoded.hour;
    const assumedMinute = draft.suggestedTime?.minute ?? decoded.minute;
    const word = TIME_OF_DAY_ASSUMPTION_LABEL[assumedHour];
    if (word !== undefined) {
      lines.push(t('agentplan.schedule_assumed_note', { word, time: fmtTime({ hour: assumedHour, minute: assumedMinute }) }));
    }
  }

  // Next-run line: shown whenever a schedule is set AND either the time was
  // assumed (existing case — a bare time-of-day word could easily be
  // misread) or a deferred start is pushing the real first fire out past a
  // naive "tomorrow" read (new case — e.g. an explicit "来週あたりから毎朝
  // 9時に" has no assumed time but still needs its real next-fire date shown,
  // not left implied as tomorrow). Uses the SAME anchor formula as
  // lib/agent-scheduler.ts's nextTriggerMs so this line and the runtime's
  // actual first fire never disagree.
  if (draft.schedule && (draft.scheduleAssumed || startNotBeforeFuture)) {
    const decoded = decodeCron(draft.schedule);
    const anchorDate = startNotBeforeFuture ? new Date(draft.startNotBefore!) : new Date();
    const next = nextFireDate(decoded, anchorDate);
    if (next) {
      lines.push(t('agentplan.next_fire_note', { datetime: formatDateTimeForSummary(next) }));
    }
  }

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

  // 2026-07-23: one or more fields above came from the hybrid LLM-extraction
  // fallback (see hasDraftAssumptions's doc comment) rather than the
  // deterministic parser — never leave that opaque, same reasoning as the
  // scheduleAssumed note right above this block.
  if (draft.llmExtracted) lines.push(t('agentplan.llm_extracted_note'));

  if (draft.autonomous) lines.push(markLine(t('agentplan.autonomous_note'), 'autonomous', changedFields));
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
    // 2026-07-23: on-device test of the Sidebar "Edit" entry point found
    // this line reading "Register this agent..." while editing an
    // already-registered agent — misleading (implies a new/duplicate agent
    // is about to be created). isEditing swaps in the "Update"-worded
    // counterpart; every other call site defaults to false, so ordinary
    // creation output is byte-identical to before this param existed.
    lines.push(t(isEditing ? 'agentplan.confirm_prompt_edit' : 'agentplan.confirm_prompt'));
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
    startNotBefore: draft.startNotBefore ?? null,
  };
}
