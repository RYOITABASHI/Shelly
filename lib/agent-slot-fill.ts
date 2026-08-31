/**
 * lib/agent-slot-fill.ts — pure logic for conversational agent-creation
 * slot-filling. When lib/agent-nl-parser.ts's parseAgentNL can't confidently
 * determine schedule/notification-trigger/output-path, the chat asks ONE
 * follow-up question at a time (via hooks/use-ai-pane-dispatch.ts) instead of
 * showing the confirm card with blank/default fields. This module is the
 * pure "what's still missing, and how do I apply an answer" logic — no React
 * Native, no store access, fully unit-testable (mirrors the extraction
 * precedent of lib/agent-card-cron.ts / lib/notification-trigger.ts).
 */
import type { ParsedAgentDraft, ScheduleResult } from './agent-nl-parser';
import { parseSchedule, fmtTime, JP_DOW_LABEL, extractBrowserTargetUrl } from './agent-nl-parser';
import { parseNotificationTriggerPackages } from './notification-trigger';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import en from './i18n/locales/en';
import ja from './i18n/locales/ja';

export type SlotField =
  | 'taskDetail'
  | 'schedule'
  | 'notificationTrigger'
  | 'outputPath'
  | 'socialConnector'
  | 'autonomous'
  // browser-pane (2026-08-05): a page-operation intent was detected
  // (lib/agent-nl-parser.ts's detectBrowserPaneIntent) but the target URL /
  // CSS selector wasn't confidently extractable from the utterance — ask,
  // exactly like the socialConnector precedent, instead of registering a
  // half-filled action the runtime would only refuse fail-closed later.
  | 'browserUrl'
  | 'browserSelector';

/** Runtime cap lib/browser-pane-automation.ts enforces on selectors (its
 *  execute() rejects anything longer); mirrored here so a slot-fill answer
 *  that could never run is re-asked instead of accepted. */
const BROWSER_SELECTOR_MAX_LEN = 2048;

/**
 * Per-message language detection for slot-fill questions — deliberately NOT
 * the app-wide Settings > Language toggle (that governs static UI chrome;
 * see lib/i18n's useI18n store). A user should get slot-fill follow-ups in
 * whatever language THEY just wrote in, not whatever the global toggle
 * happens to be set to (2026-07-09 feedback: a user whose Language setting
 * was EN, but who always writes agent requests in Japanese, correctly
 * started getting English questions once these were routed through the
 * global i18n system — this per-message detector replaces that global
 * lookup for slot-fill specifically). Same coarse heuristic already used
 * throughout agent-nl-parser.ts's JP-detection regexes (Hiragana/Katakana/
 * CJK ideograph presence) rather than full language identification — this
 * only needs to distinguish JA from EN for a bilingual app.
 */
export function detectMessageLocale(text: string): 'en' | 'ja' {
  // Hiragana (U+3040-U+309F), Katakana (U+30A0-U+30FF), CJK Unified
  // Ideographs (U+4E00-U+9FFF).
  return /[぀-ヿ一-鿿]/.test(text) ? 'ja' : 'en';
}

export interface SlotFillContext {
  /** From useSettingsStore().settings — if either is already configured, the
   *  output-path slot is skipped (the existing global default is good enough,
   *  don't interrogate the user for something that's already answered). */
  agentVaultPath?: string;
  agentTopicFolder?: string;
}

/**
 * True when the utterance/draft implies "fire this agent WHEN a notification
 * arrives from some app" (NOTIFY-001's notification-trigger concept) as
 * distinct from "deliver the RESULT via a notification" (the existing,
 * unrelated action.type === 'notify'). Heuristic: look for phrasing in
 * draft.rawText/prompt indicating a notification is the TRIGGER, not just
 * that action is 'notify'. Keep this conservative — false negatives (not
 * asking when we should have) are much safer than false positives (asking
 * an irrelevant question on every ordinary "notify me daily" agent).
 */
export function needsNotificationTrigger(draft: ParsedAgentDraft): boolean {
  if (draft.notificationTrigger && draft.notificationTrigger.packageNames.length > 0) return false; // already resolved
  const text = `${draft.rawText} ${draft.prompt}`.toLowerCase();
  // Japanese: "◯◯の通知が来たら/届いたら", "通知をトリガーに". English: "when I get a notification from", "triggered by a notification".
  const triggerPhraseJp = /通知(が来たら|が届いたら|をトリガー|で起動)/.test(text) || /(来たら|届いたら).*通知/.test(draft.rawText);
  const triggerPhraseEn = /when\s+i\s+(get|receive)\s+a\s+notification|notification\s+triggers?|triggered\s+by\s+a\s+notification/.test(text);
  return triggerPhraseJp || triggerPhraseEn;
}

/**
 * Returns the FIRST missing/ambiguous slot in priority order (schedule,
 * then notification-trigger, then output-path), or null when the draft has
 * everything v1 cares about and is ready to show as a confirm card.
 */
export function nextMissingSlot(
  draft: ParsedAgentDraft,
  ctx: SlotFillContext,
): { field: SlotField; question: string } | null {
  // Detected once from the ORIGINAL utterance (draft.rawText, which
  // applySlotAnswer never overwrites), not re-detected per follow-up answer
  // — keeps a whole slot-fill conversation in one consistent language even
  // if a later reply happens to be a bare number/package name with no
  // language-identifying characters of its own.
  const strings = detectMessageLocale(draft.rawText) === 'ja' ? ja : en;
  // 2026-07-24: task-content clarity is checked BEFORE schedule — see
  // ParsedAgentDraft.needsTaskClarification's own doc comment. Asking "いつ
  // 実行しますか？" first, for a request whose actual TASK content is still
  // unclear, reads as a non-sequitur; clarify WHAT before WHEN.
  if (draft.needsTaskClarification) {
    return {
      field: 'taskDetail',
      question: draft.needsTaskClarification,
    };
  }
  // browser-pane (2026-08-05): both halves of the action are REQUIRED before
  // the confirm step — an empty allowlist is refused by the runtime
  // (lib/agent-browser-pane-review.ts throws on it; lib/browser-pane-
  // automation.ts's allowlist check fails closed) and an empty selector can
  // never match an element, so registering either would be registering an
  // agent that can never act. Asked BEFORE the schedule question for the same
  // reason taskDetail is (2026-07-24 precedent above): the page/element is
  // part of WHAT the agent does — "いつ実行しますか？" reads as a non-sequitur
  // while the operation's own target is still unknown. URL first: the
  // selector question reads naturally only once the page is settled.
  if (draft.action.type === 'browser-pane') {
    if ((draft.action.browserPaneUrlAllowlist?.length ?? 0) === 0) {
      return {
        field: 'browserUrl',
        question: strings['slot_fill.question_browser_url'],
      };
    }
    if (!draft.action.browserPaneAction?.selector) {
      return {
        field: 'browserSelector',
        question: strings['slot_fill.question_browser_selector'],
      };
    }
  }
  // NOTIFY-001 (2026-08-12 on-device finding): a notification-triggered
  // request ("when I get a notification from X, do Y") is fired by the
  // notification's ARRIVAL, not a time or frequency — lib/agent-manager.ts
  // registers an agent on `agent.schedule || agent.notificationTrigger`
  // (either suffices), so this shape of agent structurally has no cron
  // schedule at all. This check therefore MUST run, and its slot MUST be
  // resolved (or explicitly declined via applySlotAnswer's give-up path),
  // BEFORE the schedule requirement below: parseSchedule() can never turn
  // "when I get a notification from com.android.systemui" into a confident
  // cron, so when this was checked only AFTER `!draft.scheduleConfident`
  // (unreachable — the schedule check always won first), the schedule
  // question was asked forever for a request that structurally can never
  // satisfy it. See also the matching `hasNotificationTrigger` guard just
  // below, which stops a resolved trigger from being asked to ALSO supply a
  // schedule it doesn't need.
  if (needsNotificationTrigger(draft)) {
    return {
      field: 'notificationTrigger',
      question: strings['slot_fill.question_notification_trigger'],
    };
  }
  const hasNotificationTrigger =
    !!draft.notificationTrigger && draft.notificationTrigger.packageNames.length > 0;
  if (!draft.scheduleConfident && !hasNotificationTrigger) {
    return {
      field: 'schedule',
      question: strings['slot_fill.question_schedule'],
    };
  }
  // social-post (2026-07-22): lib/agent-nl-parser.ts's detectSocialPost sets
  // socialPostCandidates when 2+ registered connectors matched the named
  // platform/label — genuinely ambiguous which one to post to. Ask before
  // anything else action-related (outputPath doesn't apply to a social-post
  // agent anyway once resolved). List each candidate so a plain number reply
  // ("1") or its label ("my-mastodon") both work — see applySlotAnswer's
  // socialConnector branch.
  if ((draft.socialPostCandidates?.length ?? 0) > 1) {
    const options = draft.socialPostCandidates!
      .map((c, i) => `${i + 1}. ${c.label} (${strings[`social_connectors.platform_${c.platform}`] ?? c.platform})`)
      .join('\n');
    return {
      field: 'socialConnector',
      question: `${strings['slot_fill.question_social_connector']}\n${options}`,
    };
  }
  if (draft.action.type === 'draft' && !ctx.agentVaultPath && !ctx.agentTopicFolder) {
    return {
      field: 'outputPath',
      question: strings['slot_fill.question_output_path'],
    };
  }
  const autonomousActionTypes = new Set(['webhook', 'social-post', 'api-call', 'cli', 'dm-reply']);
  if (
    autonomousActionTypes.has(draft.action.type) &&
    draft.scheduleConfident === true &&
    draft.autonomous !== true &&
    draft.llmAutonomousIntent === undefined
  ) {
    return {
      field: 'autonomous',
      question: strings['slot_fill.question_autonomous'],
    };
  }
  return null;
}

/** The confident schedule fields produced by combinePartialScheduleWithDraft
 *  when a bare-time answer completes a recurrence the draft already knew. */
export interface CombinedPartialSchedule {
  schedule: string;
  scheduleLabel: string;
  suggestedTime: NonNullable<ScheduleResult['suggestedTime']>;
  /** Present only on the weekly (dow-list) combination path. */
  suggestedDowList?: string;
}

/**
 * Merge a NOT-confident parseSchedule() result against recurrence context the
 * draft already carries. A bare time ("20時" / "9:30") parses to a
 * suggestedTime with no frequency, which alone can never be a confident cron
 * — but when the ORIGINAL utterance already established the recurrence
 * (draft.suggestedDowList from "月曜と金曜に…", or draft.suggestedFrequency
 * === 'daily' from "毎日…"), the two halves combine into a confident cron.
 *
 * Extracted 2026-08-03 from applySlotAnswer's schedule branch (where this
 * cross-turn merge was born) so lib/agent-conversational-registration.ts's
 * Tier 3 merge can share it: Tier 3 used to DROP a bare-time scheduleText
 * outright even when the draft already knew the frequency, which re-asked
 * "いつ実行しますか？" for an answer Tier 2 would have accepted — the exact
 * structural asymmetry behind the repeated-schedule-question on-device bug.
 *
 * Returns null when nothing can be combined (no time in the answer, or no
 * recurrence context on the draft). DELIBERATELY never invents a frequency:
 * a bare time with no known recurrence stays ambiguous (once-vs-daily), so
 * the caller keeps asking / falls back to the manual picker.
 */
export function combinePartialScheduleWithDraft(
  draft: Pick<ParsedAgentDraft, 'suggestedDowList' | 'suggestedFrequency'>,
  result: Pick<ScheduleResult, 'suggestedTime'>,
): CombinedPartialSchedule | null {
  if (!result.suggestedTime) return null;
  const { hour, minute } = result.suggestedTime;
  if (draft.suggestedDowList) {
    const dowField = draft.suggestedDowList;
    const dayLabel = dowField
      .split(',')
      .map((d) => JP_DOW_LABEL[Number(d)])
      .join('・');
    return {
      schedule: `${minute} ${hour} * * ${dowField}`,
      scheduleLabel: `毎週${dayLabel} ${fmtTime(result.suggestedTime)}`,
      suggestedTime: result.suggestedTime,
      suggestedDowList: dowField,
    };
  }
  if (draft.suggestedFrequency === 'daily') {
    return {
      schedule: `${minute} ${hour} * * *`,
      scheduleLabel: `毎日 ${fmtTime(result.suggestedTime)}`,
      suggestedTime: result.suggestedTime,
    };
  }
  return null;
}

/**
 * Applies a raw chat reply to the given field, returning an updated draft
 * copy. Per-field parsing failure NEVER blocks — it falls back to a safe
 * default so the conversation can never get stuck in an infinite loop (see
 * attemptCount below, used by the caller to force-fallback after repeated
 * failures on the SAME field).
 */
export function applySlotAnswer(
  field: SlotField,
  draft: ParsedAgentDraft,
  answerText: string,
  attemptCount: number,
): { draft: ParsedAgentDraft; resolved: boolean } {
  if (field === 'taskDetail') {
    // 2026-07-24: the LLM is only ever trusted to ASK the clarifying
    // question (needsTaskClarification, set by extractAgentFieldsWithLlm) —
    // never to invent what the task should be. This branch just folds the
    // user's own follow-up reply into the prompt and re-derives tool/
    // toolLabel via suggestTool(), exactly the way extractAgentFieldsWithLlm
    // itself re-derives them when the `prompt` field changes (see
    // lib/agent-llm-fallback.ts's mergeLlmExtractionIntoDraft) — so a
    // clarified prompt routes to the same tool a fresh, equally-detailed
    // utterance would have from the start. An empty/whitespace-only reply
    // never counts as an answer (there is nothing safe to append), so it
    // re-asks rather than silently accepting a blank clarification.
    const clarification = answerText.trim();
    if (!clarification) {
      return { draft, resolved: false };
    }
    const mergedPrompt = `${draft.prompt} ${clarification}`.trim();
    const suggestion = suggestTool(mergedPrompt);
    return {
      draft: {
        ...draft,
        prompt: mergedPrompt,
        tool: suggestion.tool,
        toolLabel: suggestion.label ?? toolChoiceToLabel(suggestion.tool),
        needsTaskClarification: undefined,
      },
      resolved: true,
    };
  }
  if (field === 'schedule') {
    const result = parseSchedule(answerText);
    if (result.confident) {
      return {
        draft: {
          ...draft,
          schedule: result.schedule,
          scheduleConfident: true,
          scheduleLabel: result.label,
          suggestedTime: result.suggestedTime,
          suggestedFrequency: result.suggestedFrequency,
          suggestedDowList: result.suggestedDowList,
        },
        resolved: true,
      };
    }
    // Merge across turns: the ORIGINAL utterance may already have identified
    // the recurrence (e.g. "月曜と金曜に…" -> draft.suggestedDowList='1,5')
    // without a time, which is exactly why this question was asked. Re-parsing
    // the follow-up answer ("9時") in isolation loses that already-known
    // context -- parseSchedule("9時") alone is just an ambiguous bare time
    // (no frequency word), so it comes back not-confident and the SAME
    // question was being asked again forever. If the answer supplies a time
    // and the draft already knows the days (or a daily marker), combine them
    // into a confident cron instead of discarding what the user already told
    // us once. (Logic lives in combinePartialScheduleWithDraft above, shared
    // with the Tier 3 conversational merge since 2026-08-03.)
    const combined = combinePartialScheduleWithDraft(draft, result);
    if (combined) {
      return {
        draft: {
          ...draft,
          schedule: combined.schedule,
          scheduleConfident: true,
          scheduleLabel: combined.scheduleLabel,
          suggestedTime: combined.suggestedTime,
          ...(combined.suggestedDowList ? { suggestedDowList: combined.suggestedDowList } : {}),
        },
        resolved: true,
      };
    }
    if (attemptCount >= 2) {
      // Give up asking — AgentConfirmCard.tsx's own HARD REQUIREMENT (a
      // manual schedule picker forced when !scheduleConfident) is the
      // ultimate safety net, so it's safe to just stop asking and let the
      // card take over.
      return { draft: { ...draft, scheduleConfident: false }, resolved: true };
    }
    return {
      draft: {
        ...draft,
        suggestedTime: result.suggestedTime,
        suggestedFrequency: result.suggestedFrequency,
        suggestedDowList: result.suggestedDowList,
      },
      resolved: false,
    };
  }
  if (field === 'socialConnector') {
    const candidates = draft.socialPostCandidates ?? [];
    const trimmed = answerText.trim();
    const lower = trimmed.toLowerCase();
    const idx = parseInt(trimmed, 10);
    let matched = !Number.isNaN(idx) && idx >= 1 && idx <= candidates.length ? candidates[idx - 1] : undefined;
    // Guard lower.length > 0 below: an empty/whitespace-only answer must
    // never match via the substring fallback (an empty string is trivially
    // "included in" every label, which would silently pick the first
    // candidate for a blank reply).
    if (!matched && lower.length > 0) {
      matched =
        candidates.find((c) => c.label.trim().toLowerCase() === lower) ??
        candidates.find((c) => lower.includes(c.label.trim().toLowerCase()) || c.label.trim().toLowerCase().includes(lower));
    }
    if (matched) {
      return {
        draft: {
          ...draft,
          action: {
            type: 'social-post',
            socialPost: { platform: matched.platform, connectorId: matched.id, text: draft.action.socialPost?.text ?? '{{result}}' },
          },
          socialPostCandidates: undefined,
        },
        resolved: true,
      };
    }
    if (attemptCount >= 1) {
      // Give up — never guess which external account to post to. Fall back
      // to a safe local draft (same "can't resolve, don't silently do
      // something risky" posture as parseAgentNL's needsSetup caveat).
      const strings = detectMessageLocale(draft.rawText) === 'ja' ? ja : en;
      return {
        draft: {
          ...draft,
          action: { type: 'draft' },
          socialPostCandidates: undefined,
          actionCaveat: strings['slot_fill.social_connector_giveup_caveat'],
        },
        resolved: true,
      };
    }
    return { draft, resolved: false };
  }
  if (field === 'browserUrl' || field === 'browserSelector') {
    // Stale question (the action was patched to something else between the
    // question and the answer) — nothing left to fill, just resolve.
    if (draft.action.type !== 'browser-pane' || !draft.action.browserPaneAction) {
      return { draft, resolved: true };
    }
    const strings = detectMessageLocale(draft.rawText) === 'ja' ? ja : en;
    /** Shared give-up: NEVER register a half-filled browser-pane action —
     *  fall back to a safe local draft with a visible caveat, the exact
     *  socialConnector-giveup posture (and, via actionCaveat,
     *  hasDraftAssumptions forces a human confirm on the downgraded draft). */
    const giveUp = () => ({
      draft: {
        ...draft,
        action: { type: 'draft' as const },
        actionCaveat: strings['slot_fill.browser_pane_giveup_caveat'],
      },
      resolved: true,
    });
    if (field === 'browserUrl') {
      // Same extraction the original utterance went through — a full URL, a
      // bare domain bound to an open-phrase, or an answer that IS just the
      // domain. Never a free-text guess: an answer that doesn't parse to an
      // http(s) URL re-asks once, then downgrades.
      const url = extractBrowserTargetUrl(answerText);
      if (url) {
        return {
          draft: { ...draft, action: { ...draft.action, browserPaneUrlAllowlist: [url] } },
          resolved: true,
        };
      }
      if (attemptCount >= 1) return giveUp();
      return { draft, resolved: false };
    }
    // browserSelector: the user's own answer IS the selector (strip one layer
    // of surrounding quotes/brackets — people quote selectors when asked for
    // one). Cap mirrors the runtime's own hard limit.
    const selector = answerText.trim().replace(/^[「『"'`]|[」』"'`]$/g, '').trim();
    if (selector && selector.length <= BROWSER_SELECTOR_MAX_LEN) {
      return {
        draft: {
          ...draft,
          action: {
            ...draft.action,
            browserPaneAction: { ...draft.action.browserPaneAction, selector },
          },
        },
        resolved: true,
      };
    }
    if (attemptCount >= 1) return giveUp();
    return { draft, resolved: false };
  }
  if (field === 'notificationTrigger') {
    const { valid } = parseNotificationTriggerPackages(answerText);
    if (valid.length > 0 || attemptCount >= 1) {
      // One retry max for this field — after that, accept whatever we have
      // (possibly empty, meaning "not actually a notification-triggered
      // agent after all" — a false-positive needsNotificationTrigger match).
      return { draft: { ...draft, notificationTrigger: valid.length > 0 ? { packageNames: valid } : undefined }, resolved: true };
    }
    return { draft, resolved: false };
  }
  if (field === 'autonomous') {
    const trimmed = answerText.trim();
    const affirmative = /^(?:はい|うん|ok|いい|良い|yes|yeah|sure)[!！。.]?$/i.test(trimmed);
    const negative = /^(?:いいえ|だめ|ダメ|no|nope)[!！。.]?$/i.test(trimmed);
    if (affirmative !== negative) {
      return { draft: { ...draft, autonomous: affirmative }, resolved: true };
    }
    // Mixed yes/no signals are ambiguous, so never grant unattended execution.
    const hasAffirmative = /(?:はい|うん|\bok\b|いい|良い|\byes\b|\byeah\b|\bsure\b)/i.test(trimmed);
    const hasNegative = /(?:いいえ|だめ|ダメ|\bno\b|\bnope\b)/i.test(trimmed);
    if ((hasAffirmative && hasNegative) || attemptCount >= 2) {
      return { draft: { ...draft, autonomous: false }, resolved: true };
    }
    return { draft, resolved: false };
  }
  // outputPath: accept almost anything non-empty as a path/label; a
  // trimmed-empty answer (or an explicit "skip"/"そのままでいい"/"default")
  // just leaves outputPath unset, falling back to the caller's default template.
  const trimmed = answerText.trim();
  const skipPhrase = /^(skip|default|そのままでいい|いいえ|なし|不要)$/i.test(trimmed);
  return { draft: { ...draft, outputPath: trimmed && !skipPhrase ? trimmed : undefined }, resolved: true };
}

/** Explicit cancel phrases — matched case-insensitively against the WHOLE
 *  trimmed message (not a substring match, to avoid accidentally treating a
 *  legitimate answer that happens to CONTAIN "cancel" as a cancellation). */
export function isCancelPhrase(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return ['cancel', 'never mind', 'nevermind', 'やめて', 'キャンセル', '中止'].includes(trimmed);
}

/**
 * true when the truly-latest message in the conversation is itself an
 * unexpired, unanswered message-attached slot-fill question (pendingSlotFill
 * — schedule/notificationTrigger/outputPath/socialConnector/taskDetail).
 *
 * hooks/use-ai-pane-dispatch.ts's pendingAgentSession (session-scoped
 * await-confirm) reply-routing block originally assumed the two pending
 * mechanisms — pendingAgentSession and message-attached pendingSlotFill —
 * "never target the same turn". 2026-07-24 on-device finding: that's false.
 * A fresh "@agent <new command>" deliberately does NOT clear an existing
 * pendingAgentSession (so it survives an interleaved unrelated command) —
 * but that fresh command can itself create a BRAND NEW pendingSlotFill on
 * the latest message. Without this check, a reply meant for that NEWER
 * question (e.g. "今" answering a fresh agent's "いつ実行しますか？") was
 * being swallowed as a patch attempt against the OLDER, unrelated pending
 * draft instead — silently corrupting it while the new agent's own question
 * sat unanswered. The caller gates its pendingAgentSession block on
 * `!hasFresherPendingSlotFillQuestion(...)` so a reply always resolves the
 * most recently asked question first; pendingAgentSession itself is left
 * completely untouched either way, so it's still there once its own turn
 * comes back around.
 */
export function hasFresherPendingSlotFillQuestion(
  latestMessage: { role?: string; pendingSlotFill?: unknown; timestamp?: number } | undefined,
  now: number,
  staleMs: number,
): boolean {
  return (
    latestMessage?.role === 'assistant' &&
    !!latestMessage.pendingSlotFill &&
    now - (latestMessage.timestamp ?? 0) <= staleMs
  );
}
