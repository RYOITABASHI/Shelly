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
import type { ParsedAgentDraft } from './agent-nl-parser';
import { parseSchedule, fmtTime, JP_DOW_LABEL } from './agent-nl-parser';
import { parseNotificationTriggerPackages } from './notification-trigger';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import en from './i18n/locales/en';
import ja from './i18n/locales/ja';

export type SlotField = 'taskDetail' | 'schedule' | 'notificationTrigger' | 'outputPath' | 'socialConnector';

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
  if (!draft.scheduleConfident) {
    return {
      field: 'schedule',
      question: strings['slot_fill.question_schedule'],
    };
  }
  // social-post (2026-07-22): lib/agent-nl-parser.ts's detectSocialPost sets
  // socialPostCandidates when 2+ registered connectors matched the named
  // platform/label — genuinely ambiguous which one to post to. Ask before
  // anything else action-related (notificationTrigger/outputPath don't apply
  // to a social-post agent anyway once resolved). List each candidate so a
  // plain number reply ("1") or its label ("my-mastodon") both work — see
  // applySlotAnswer's socialConnector branch.
  if ((draft.socialPostCandidates?.length ?? 0) > 1) {
    const options = draft.socialPostCandidates!
      .map((c, i) => `${i + 1}. ${c.label} (${strings[`social_connectors.platform_${c.platform}`] ?? c.platform})`)
      .join('\n');
    return {
      field: 'socialConnector',
      question: `${strings['slot_fill.question_social_connector']}\n${options}`,
    };
  }
  if (needsNotificationTrigger(draft)) {
    return {
      field: 'notificationTrigger',
      question: strings['slot_fill.question_notification_trigger'],
    };
  }
  if (draft.action.type === 'draft' && !ctx.agentVaultPath && !ctx.agentTopicFolder) {
    return {
      field: 'outputPath',
      question: strings['slot_fill.question_output_path'],
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
    // us once.
    if (result.suggestedTime) {
      const { hour, minute } = result.suggestedTime;
      if (draft.suggestedDowList) {
        const dowField = draft.suggestedDowList;
        const dayLabel = dowField
          .split(',')
          .map((d) => JP_DOW_LABEL[Number(d)])
          .join('・');
        return {
          draft: {
            ...draft,
            schedule: `${minute} ${hour} * * ${dowField}`,
            scheduleConfident: true,
            scheduleLabel: `毎週${dayLabel} ${fmtTime(result.suggestedTime)}`,
            suggestedTime: result.suggestedTime,
            suggestedDowList: dowField,
          },
          resolved: true,
        };
      }
      if (draft.suggestedFrequency === 'daily') {
        return {
          draft: {
            ...draft,
            schedule: `${minute} ${hour} * * *`,
            scheduleConfident: true,
            scheduleLabel: `毎日 ${fmtTime(result.suggestedTime)}`,
            suggestedTime: result.suggestedTime,
          },
          resolved: true,
        };
      }
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
