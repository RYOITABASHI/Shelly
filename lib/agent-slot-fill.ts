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
import { parseSchedule } from './agent-nl-parser';
import { parseNotificationTriggerPackages } from './notification-trigger';
import en from './i18n/locales/en';
import ja from './i18n/locales/ja';

export type SlotField = 'schedule' | 'notificationTrigger' | 'outputPath';

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
  if (!draft.scheduleConfident) {
    return {
      field: 'schedule',
      question: strings['slot_fill.question_schedule'],
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
