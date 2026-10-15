/**
 * lib/agent-output-language.ts — the output-language directive every agent
 * prompt leads with (2026-10-15 on-device finding: an ENGLISH agent prompt
 * produced JAPANESE summaries on Perplexity).
 *
 * Two causes, both fixed here:
 *  1. Only a Japanese task ever got a directive; an English task had none, so
 *     the backend followed the strongest language signal in the prompt.
 *  2. The language was judged on the FULL prompt — which, by the time it
 *     reaches the executors, is applyMemoryAndSkills' composite
 *     (`<memory recall><SEP><skill recipe><SEP><task>`, SEP = INJECTED_CONTEXT_SEPARATOR). Japanese
 *     memory / profile notes therefore made an English task "Japanese", and
 *     the injected context steered the answer.
 *
 * The language is now judged on the TASK text only (the segment after the
 * last injected-context separator), and the directive explicitly outranks the
 * language of any context, memory or profile notes that follow it.
 */

/**
 * The separator lib/agent-manager.ts's applyMemoryAndSkills puts between
 * injected context (memory recall / skill recipe) and the user's task.
 * Post-merge review L4: a dedicated sentinel, not the generic "---" rule,
 * which also appears in buildStepPrompt's carried results and in ordinary
 * user/markdown text — splitting on that picked the wrong "task" segment.
 */
export const INJECTED_CONTEXT_SEPARATOR = '\n\n---\n<!-- shelly:end-of-injected-context -->\n\n';

/** The user's own task text, without prepended memory / skill context. */
export function taskTextForLanguage(prompt: string): string {
  const i = prompt.lastIndexOf(INJECTED_CONTEXT_SEPARATOR);
  return i >= 0 ? prompt.slice(i + INJECTED_CONTEXT_SEPARATOR.length) : prompt;
}

export type TaskLanguage = 'ja' | 'en' | 'other';

export function detectTaskLanguage(taskText: string): TaskLanguage {
  if (/[ぁ-んァ-ヶ一-龥]/.test(taskText)) return 'ja';
  // Review M-C: only ASCII letters count as English. Any other letter —
  // accented Latin (French, German, Vietnamese, …) or another script — mirrors
  // the task. Typographic punctuation/symbols (’ “ — … ×) are not letters and
  // do not change the verdict.
  if (/(?![A-Za-z])\p{L}/u.test(taskText)) return 'other';
  if (/[A-Za-z]/.test(taskText)) return 'en';
  return 'other';
}

// Review M-C: the task's OWN explicit output-language request ("… in
// Japanese", 「英語で書いて」) always wins over the inferred language.
const OVERRIDE_NOTE =
  ' This overrides the language of any context, memory, profile notes or source material anywhere in this prompt — unless the Task explicitly requests another output language, in which case follow the Task.';

/**
 * The directive to prepend to the model prompt ('' when the task text carries
 * no usable language signal, e.g. digits only). `prompt` may be the composite
 * prompt; its task segment decides the language.
 */
export function outputLanguageDirective(prompt: string, taskTextOverride?: string): string {
  const task = taskTextOverride && taskTextOverride.trim() ? taskTextOverride : taskTextForLanguage(prompt);
  const lang = detectTaskLanguage(task);
  if (lang === 'ja') {
    return 'OUTPUT LANGUAGE (REQUIRED): Write the ENTIRE response in Japanese (日本語). Any non-Japanese source material MUST be translated into natural Japanese and summarised in Japanese — never leave English paragraphs. Source URLs stay verbatim.' + OVERRIDE_NOTE + '\n\n';
  }
  if (lang === 'en') {
    return 'OUTPUT LANGUAGE (REQUIRED): Write the ENTIRE response in English. Any non-English source material MUST be translated into natural English and summarised in English. Source URLs stay verbatim.' + OVERRIDE_NOTE + '\n\n';
  }
  if (/\S/.test(task) && /[^\d\s\p{P}\p{S}]/u.test(task)) {
    return 'OUTPUT LANGUAGE (REQUIRED): Write the ENTIRE response in the same language as the Task text.' + OVERRIDE_NOTE + '\n\n';
  }
  return '';
}
