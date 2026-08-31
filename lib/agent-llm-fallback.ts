/**
 * lib/agent-llm-fallback.ts — Hybrid deterministic→LLM fallback for the
 * `@agent <NL>` creation flow (2026-07-23).
 *
 * Background: lib/agent-nl-parser.ts's parseAgentNL is a fully deterministic
 * regex/keyword parser — no LLM call, ever. That is correct and desirable for
 * the overwhelming majority of agent-creation utterances ("毎日21時に通知し
 * て") and must stay that way for speed/availability/auto-registration
 * safety. But two classes of utterance don't fit that model:
 *
 *   1. A genuinely complex/compound request ("毎朝8時に〇〇についてCodexで
 *      調べて、150文字で要約したものをリンク付きでブルースカイに投稿して")
 *      where the deterministic parser found NEITHER a confident schedule NOR
 *      an explicit action signal at all — see isLowConfidenceAgentDraft.
 *   2. A capability question ("こんなことできる？") that isn't an
 *      agent-creation request in the first place — see
 *      isCapabilityQuestionForAgentFlow.
 *
 * This module is the PURE decision/parsing core for both: what counts as
 * "low confidence" (§1), what counts as "looks like a capability question"
 * (§2), how to build the extraction prompt, how to validate/parse the LLM's
 * JSON response, and how to safely merge validated fields into a
 * ParsedAgentDraft. The one impure piece — extractAgentFieldsWithLlm, which
 * actually calls the local LLM — is isolated at the bottom and is the only
 * function here that needs mocking in tests.
 *
 * Safety design (see each function's own doc comment for specifics):
 *   - The LLM is NEVER trusted to author a schedule directly (no raw cron
 *     string accepted) — it may only propose a natural-language time phrase,
 *     which is then re-validated through parseSchedule(), the SAME
 *     whitelisted-cron-shape gate the deterministic parser itself uses.
 *   - The LLM is NEVER trusted to author a webhook URL, a cli command,
 *     or a social-post connector id — those need structured
 *     fields (a URL, a shell command, a fixed recipe id, a connector id) an
 *     LLM guess could turn into a real security/privacy hazard. The only
 *     action types this module will ever accept DIRECTLY from the LLM are
 *     'draft' and 'notify' — both purely local, T0-risk (see
 *     lib/agent-plan-summary.ts's isAutoRegisterEligibleOnChatConfirm for
 *     the same risk-tier distinction). A 'social-post' action can be reached
 *     one way only (2026-08-01): the LLM hands back a free-text destination
 *     NAME it saw in the utterance (`platformHint`), which
 *     resolvePlatformHintConnector resolves DETERMINISTICALLY against the
 *     connectors the user already registered, and only a unique match is
 *     applied. The model still cannot author a connectorId, a platform, or a
 *     host — it can only disambiguate among destinations that already exist.
 *   - Any draft touched by this fallback is marked `llmExtracted: true`,
 *     which lib/agent-plan-summary.ts's hasDraftAssumptions treats the same
 *     as an assumed schedule: it can never skip the human confirm
 *     round-trip, no matter how complete/explicit the extracted fields look.
 *   - Every step (network call, JSON parse, field validation) fails closed:
 *     on ANY problem, extractAgentFieldsWithLlm returns the ORIGINAL draft
 *     completely untouched, so the caller's existing slot-fill/card flow
 *     proceeds exactly as if this module didn't exist.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
import { parseSchedule } from './agent-nl-parser';
import type { SocialConnectorMeta, SocialPlatform } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { isCapabilityQuestion } from './ask-context';
import { ollamaChat, type LocalLlmConfig, type OllamaMessage } from './local-llm';
import { logInfo } from './debug-logger';
import { detectMessageLocale } from './agent-slot-fill';
import en from './i18n/locales/en';
import ja from './i18n/locales/ja';

// ── §1: low-confidence detection ────────────────────────────────────────

// Same literal draft-keyword check lib/agent-nl-parser.ts's detectAction()
// uses for its own explicit 'draft' branch, and the SAME duplication
// precedent lib/agent-draft-patch.ts's tryPatchAction already established
// (its EXPLICIT_DRAFT_KEYWORD_RE, verbatim) — needed to answer the same
// narrow question that module answers: "did detectAction's 'draft' result
// come from an EXPLICIT keyword, or from its silent default-to-draft
// fallback", which the AgentAction value alone can never distinguish. Kept
// in sync manually with agent-nl-parser.ts's private copy; if that file's
// draft-keyword branch ever changes, update both copies (agent-draft-patch.ts
// and this one).
const EXPLICIT_DRAFT_KEYWORD_RE = /ドラフト|下書き|\bdraft\b/i;

// ── Mirrored social-post vocabulary (2026-08-01) ────────────────────────────
//
// lib/agent-nl-parser.ts keeps SOCIAL_PLATFORM_ALIASES / the posting-verb
// vocabulary PRIVATE (module-local consts, no export) and its one exported
// entry point for them, parseAgentNL, takes a whole utterance plus the live
// connector list — neither shape answers the two questions this module needs
// ("does this utterance mention a posting verb but no platform name" and
// "does this SHORT hint phrase name exactly one registered connector").
// Mirrored here verbatim, following the SAME duplication precedent
// EXPLICIT_DRAFT_KEYWORD_RE above already established (and that
// lib/agent-draft-patch.ts established before it). Kept in sync manually: if
// agent-nl-parser.ts's SOCIAL_PLATFORM_ALIASES / SOCIAL_POST_VERB_JP /
// SOCIAL_POST_VERB_EN ever change, update these copies too.
const SOCIAL_PLATFORM_ALIASES_MIRROR: Record<SocialPlatform, string[]> = {
  discord: ['discord', 'ディスコード'],
  slack: ['slack', 'スラック'],
  telegram: ['telegram', 'テレグラム'],
  mastodon: ['mastodon', 'マストドン'],
  misskey: ['misskey', 'ミスキー'],
  wordpress: ['wordpress', 'ワードプレス'],
  bluesky: ['bluesky', 'ブルースカイ'],
  x: ['x', 'twitter', 'エックス', 'ツイッター'],
};
const SOCIAL_PLATFORMS_MIRROR = Object.keys(SOCIAL_PLATFORM_ALIASES_MIRROR) as SocialPlatform[];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bare posting/sharing verb, no platform bound — mirrors agent-nl-parser.ts's
 *  GENERIC_SOCIAL_POST_VERB_RE (SOCIAL_POST_VERB_JP | SOCIAL_POST_VERB_EN). */
const GENERIC_POST_VERB_RE =
  /(?:自動)?(?:投稿|ポスト|シェア|アップ|共有)|つぶや(?:く|いて)|呟(?:く|いて)|\b(?:post(?:ing)?|share|tweet)\b/i;

/** Any platform NAME appearing anywhere in the text, with no verb binding —
 *  deliberately looser than agent-nl-parser.ts's SOCIAL_PLATFORM_RE (which
 *  requires "<platform>に投稿"), because this is used only to answer "was a
 *  destination named AT ALL", never to resolve one. Single-character aliases
 *  ('x') get `\b` guards for the same reason buildSocialPlatformRe does: an
 *  unguarded bare "x" matches inside any word ("box"). */
const PLATFORM_NAME_MENTION_RE = new RegExp(
  SOCIAL_PLATFORMS_MIRROR.flatMap((p) => SOCIAL_PLATFORM_ALIASES_MIRROR[p])
    .map((a) => (a.length === 1 ? `\\b${escapeRegExp(a)}\\b` : escapeRegExp(a)))
    .join('|'),
  'i',
);

/** true when the utterance asks to post/share something but names no platform
 *  we recognize — i.e. the deterministic parser had nothing to bind the verb
 *  to and silently defaulted the action to 'draft'. See
 *  isLowConfidenceAgentDraft's bullet (d). */
function looksLikeUnresolvedPostIntent(draft: ParsedAgentDraft): boolean {
  if (draft.action.type !== 'draft') return false;
  if (!GENERIC_POST_VERB_RE.test(draft.rawText)) return false;
  return !PLATFORM_NAME_MENTION_RE.test(draft.rawText);
}

/**
 * true when the deterministic parse of this draft is not trustworthy enough
 * to stand on its own — the gate hooks/use-ai-pane-dispatch.ts uses to decide
 * whether to spend one local-LLM call re-reading the utterance.
 *
 * 2026-08-01 WIDENING (project-owner directive: follow Hermes Agent's
 * Security-and-Command-Approval model). Hermes' actual design is "Manual
 * approval by default; in Smart mode an auxiliary LLM judges risk/ambiguity
 * per command, auto-running only the clearly-low-risk ones and asking
 * otherwise" — the no-confirmation `--yolo` mode is documented as
 * trusted-sandbox-only. Shelly adopts the COMPREHENSION half of that and
 * nothing else: the human Confirm tap stays mandatory exactly as before (see
 * lib/agent-plan-summary.ts's hasDraftAssumptions, which this module's
 * `llmExtracted` flag feeds and which can never be skipped). What changes is
 * how hard we try to UNDERSTAND before asking — the original criterion below
 * was so narrow that the most common real failure mode, "the parser quietly
 * substituted a local draft for what the user actually asked for", never
 * reached the LLM at all.
 *
 * Returns true when ANY of these holds:
 *
 *   (a) LEGACY (unchanged, kept for exact backward compatibility): the parser
 *       found NEITHER a confident schedule NOR any explicit action signal —
 *       i.e. `draft.action` is nothing more than parseAgentNL's unconditional
 *       final default (`{ type: 'draft' }` when nothing matched at all). A
 *       single 'notify'/'webhook'/'cli'/'social-post' action.type is
 *       always treated as explicit — those can only ever come from
 *       detectAction()'s own keyword/URL branches, never its default. A
 *       'draft' action.type needs the extra keyword check, because 'draft' is
 *       BOTH the explicit-request outcome ("下書き/draft") and the silent
 *       nothing-else-matched default.
 *   (b) `draft.actionCaveat` is set. A caveat is precisely the parser SAYING
 *       it silently substituted something (SOCIAL_POST_NO_CONNECTOR_CAVEAT,
 *       the LINE-posting fallback, the X-Articles fallback, an unresolved
 *       multi-target list). Under the old criterion this made the draft look
 *       MORE confident (it counted as "an explicit ask we understood") and
 *       returned false — exactly backwards for a comprehension pass: a caveat
 *       means the user asked for something we could not deliver as asked.
 *   (c) `draft.socialPostCandidates` has 2+ entries — a named destination
 *       matched several registered connectors, so which external account to
 *       post to is genuinely ambiguous. An LLM-extracted platformHint can
 *       often collapse that to one (see mergeLlmExtractionIntoDraft); when it
 *       can't, the existing slot-fill question still asks, unchanged.
 *   (d) the action is still 'draft' and the utterance contains a generic
 *       post/share verb (投稿/シェア/ポスト/共有/つぶやく/post/share/tweet)
 *       but names NO platform we recognize — the "silently became a draft
 *       even though the user clearly wanted something delivered somewhere"
 *       case, which produces no caveat and no candidates at all.
 *
 * Note that (b)/(c)/(d) are evaluated even when `scheduleConfident` is true:
 * a confidently-scheduled agent that posts to the wrong place (or to nowhere)
 * is exactly as wrong as an unscheduled one. Only the LEGACY criterion (a)
 * keeps its original "no confident schedule" precondition.
 *
 * What deliberately still does NOT trigger this: an ordinary utterance merely
 * MISSING a field ("毎朝ニュースまとめて" with no delivery target, or a task
 * with no schedule). Conversational slot-fill (lib/agent-slot-fill.ts) already
 * asks exactly the missing piece, one question at a time, with no LLM
 * involved, and routing every such utterance through the LLM would defeat the
 * "keep the common path LLM-free" requirement this module exists to protect.
 *
 * Known residual gap (documented, not fixed here): a compound utterance where
 * the parser DOES confidently resolve schedule + action but loses OTHER
 * structured detail (a character limit, a multi-condition chain) still never
 * reaches this fallback. Catching that reliably needs a real "does this look
 * under-parsed even though everything came back confident" signal, which is a
 * materially harder problem than this pass scopes to.
 */
export function isLowConfidenceAgentDraft(draft: ParsedAgentDraft): boolean {
  // 2026-07-27: this whole module had ZERO logging before that night's
  // on-device repro ("@agent 手伝って" silently skipped the task-clarity
  // question), which made it impossible to tell from logcat whether this gate
  // was the problem, the LLM call was never attempted, the call failed
  // silently, or the model simply judged a vague utterance as clear. Every
  // branch below logs its outcome + the specific reason, so a future repro
  // shows a clear trail.
  const hasActionCaveat = !!draft.actionCaveat;
  const ambiguousSocialTarget = (draft.socialPostCandidates?.length ?? 0) >= 2;
  const unresolvedPostIntent = looksLikeUnresolvedPostIntent(draft);

  const explicitActionType = draft.action.type !== 'draft';
  const hasExplicitDraftKeyword = EXPLICIT_DRAFT_KEYWORD_RE.test(draft.rawText);
  const actionExplicit = explicitActionType || hasActionCaveat || hasExplicitDraftKeyword;
  const legacyLowConfidence = !draft.scheduleConfident && !actionExplicit;

  const result = legacyLowConfidence || hasActionCaveat || ambiguousSocialTarget || unresolvedPostIntent;
  logInfo(
    'AgentLlmFallback',
    `isLowConfidenceAgentDraft=${result} (scheduleConfident=${draft.scheduleConfident}, ` +
      `actionType=${draft.action.type}, legacyLowConfidence=${legacyLowConfidence}, ` +
      `hasActionCaveat=${hasActionCaveat}, ambiguousSocialTarget=${ambiguousSocialTarget}, ` +
      `unresolvedPostIntent=${unresolvedPostIntent}, explicitActionType=${explicitActionType}, ` +
      `hasExplicitDraftKeyword=${hasExplicitDraftKeyword})`,
  );
  return result;
}

// ── §2: capability-question detection ───────────────────────────────────

/**
 * Loose "does this look like a question about what Shelly can do" check for
 * the @agent creation entry point (hooks/use-ai-pane-dispatch.ts). Reuses
 * lib/ask-context.ts's isCapabilityQuestion — the SAME heuristic that
 * already decides whether the main AI Chat pane's system prompt gets the
 * full descriptive feature catalog or just the compact ambient one (see
 * lib/ai-pane-context.ts's buildAIPaneSystemPrompt) — rather than inventing
 * a second, competing definition of "looks like a capability question" that
 * could quietly drift from the first one.
 *
 * This is deliberately NOT an exact-match check the way
 * lib/agent-slot-fill.ts's isCancelPhrase is (a short closed list of literal
 * phrases, matched against the WHOLE trimmed message, e.g. 'cancel' /
 * 'やめて'). A capability question can be phrased in unboundedly many ways
 * ("こんなことできる？" / "Blueskyへの投稿できますか" / "what can you do" /
 * "MIDIキーボード対応してる？"), so any workable detector here has to be a
 * loose, question-shaped pattern match, not a closed phrase list — full
 * exact-match strictness would miss the overwhelming majority of real
 * capability questions and defeat the point of adding this route at all.
 *
 * The asymmetric cost of getting this wrong is why the looseness is
 * acceptable here specifically (unlike, say, a cancel/confirm phrase, where
 * a false positive discards a live draft):
 *   - False positive (an ordinary agent-creation request happens to match a
 *     question-shaped pattern): the user gets a grounded capability answer
 *     instead of a draft — a mild "that's not what I meant" inconvenience,
 *     recoverable by simply asking again without the question-shaped
 *     wording. No draft is created and no pending session is set either
 *     way, so nothing is silently lost.
 *   - False negative (a real capability question doesn't match): the
 *     ordinary parseAgentNL/slot-fill flow runs instead. For a genuine
 *     capability question, that utterance typically carries no
 *     schedule/action words either, so it degrades gracefully into
 *     isLowConfidenceAgentDraft's own LLM-extraction fallback (§1 above)
 *     rather than silently registering a bogus agent — worst case the user
 *     is asked one clarifying slot-fill question instead of getting an
 *     immediate answer.
 */
export function isCapabilityQuestionForAgentFlow(text: string | null | undefined): boolean {
  return isCapabilityQuestion(text);
}

// ── §3: LLM structured-field extraction ─────────────────────────────────

/** Fields this module will accept from the LLM. Deliberately narrow — see
 *  this module's own doc comment for why webhook/cli/social-post are
 *  never LLM-authorable here. */
export interface AgentLlmExtraction {
  /** Short display name for the agent. */
  name?: string;
  /** A natural-language schedule phrase (e.g. "毎朝8時" / "every weekday at
   *  9am") — NEVER a raw cron string; re-validated through parseSchedule()
   *  before it can affect the draft (see mergeLlmExtractionIntoDraft). */
  scheduleText?: string;
  /** One of the two LLM-authorable action types. Any other value (including
   *  a hallucinated/unsupported type name) is silently dropped by
   *  parseAgentLlmExtractionResponse — never trusted as-is. */
  actionType?: 'draft' | 'notify';
  /** Free-text output destination hint (only meaningful when actionType
   *  resolves to 'draft'). */
  outputPath?: string;
  /** The core task instruction with schedule/delivery phrasing stripped —
   *  fed to suggestTool() the same way the deterministic parser's own
   *  derivePrompt() output is, so tool routing stays consistent. */
  prompt?: string;
  /** Whether the request describes a concrete, actionable task — i.e.
   *  whether "prompt" above is actually something an agent could DO, not
   *  just a vague topic. false when the request names an outcome without
   *  saying how to get there (e.g. "明日の準備をよろしく" — prepare WHAT?). */
  taskClear?: boolean;
  /** A single clarifying question, in the request's own language, asking
   *  what the task should concretely be. Only meaningful when taskClear is
   *  false. The LLM is only ever trusted to ASK this question — never to
   *  invent an answer to it itself; see mergeLlmExtractionIntoDraft. */
  clarifyingQuestion?: string;
  /** Free-text platform/destination hint (e.g. "X", "twitter", "ブルースカイ",
   *  or a connector label the user seems to be naming) — NEVER a connectorId.
   *  Resolved against real registered connectors by the SAME deterministic
   *  matching logic detectSocialPost() already uses; if it doesn't resolve to
   *  exactly one real connector, it is dropped (never silently registers a
   *  half-guessed destination). */
  platformHint?: string;
  /** Whether the user's utterance expresses intent for UNATTENDED/autonomous
   *  execution — true/false/undefined (undefined = unclear, should ask). LLM
   *  proposes; final autonomous flag is still gated the same way scheduleText
   *  is (this signal alone does not flip draft.autonomous — see the merge
   *  function and the slot-fill autonomous question in
   *  lib/agent-slot-fill.ts). */
  autonomousIntent?: boolean;
}

const MAX_FIELD_LEN: Record<
  keyof Omit<AgentLlmExtraction, 'actionType' | 'taskClear' | 'autonomousIntent'>,
  number
> = {
  name: 60,
  scheduleText: 100,
  outputPath: 200,
  prompt: 2000,
  clarifyingQuestion: 200,
  // Short by design: this is a single destination NAME ("ブルースカイ" / a
  // connector label), never a sentence. A long value is a sign the model
  // dumped prose in here, and truncating it can only make the deterministic
  // resolution below match FEWER connectors, never more.
  platformHint: 60,
};

const EXTRACTION_SYSTEM_PROMPT = `You extract structured fields from a single natural-language request to create a scheduled automation agent (JP or EN). Respond with STRICT JSON ONLY — no prose, no markdown fences, no explanation — matching exactly this shape:
{"name": string, "scheduleText": string, "actionType": "draft" | "notify", "outputPath": string, "prompt": string, "taskClear": boolean, "clarifyingQuestion": string, "platformHint": string, "autonomousIntent": true | false | null}

Rules:
- "name": a short (<= 20 char) human label for the agent, derived from the topic.
- "scheduleText": the schedule phrase VERBATIM or lightly normalized from the request (e.g. "every day at 8am", "毎朝8時"). Do NOT invent a schedule that was not stated. Empty string if none was stated.
- "actionType": "notify" if the request asks to be notified/alerted/reminded; otherwise "draft" (save the result). Never invent any other action type.
- "outputPath": a destination hint (folder/file name) ONLY if one was explicitly stated. Empty string otherwise.
- "prompt": the core task instruction, with the schedule/delivery phrasing removed — what the agent should actually DO each run.
- "taskClear": true only if "prompt" describes a concrete, executable action (what to look up, write, check, or send). false if the request only names a goal/outcome without saying HOW to accomplish it (e.g. "明日の準備をよろしく", "get ready for the trip", "handle the report" — prepare/handle WHAT, exactly?). When in doubt between true and false, prefer false — do NOT guess at what a vague request means.
- "clarifyingQuestion": REQUIRED (non-empty) when taskClear is false — one short, concrete question, written in the SAME language as the request, asking what the task should actually involve. Empty string when taskClear is true.
- "platformHint": the destination/platform/service NAME mentioned in the request, copied as written (e.g. "X", "twitter", "ブルースカイ", "Slack", "会社Bot"). Just extract the word — do NOT judge whether it exists, do NOT map it to an id, do NOT invent one. Empty string if the request names no destination.
- "autonomousIntent": true if the request explicitly asks to run unattended/automatically without asking each time ("勝手にやっておいて", "確認なしで", "fully automatic", "without asking me"); false if it explicitly asks to be asked/confirmed each time ("毎回確認して", "ask me first"); null if the request says nothing either way. Do NOT guess — null is the correct answer whenever it is not stated.
- Every string field must be a plain string (use "" for unknown/absent — never null, never omit a key). "taskClear" must be a plain boolean. "autonomousIntent" must be true, false, or null.
- Output ONLY the JSON object. Nothing before it, nothing after it.`;

/** Builds the system+user message pair for the extraction call. Exported for
 *  tests; also usable by any future caller that wants the exact same prompt
 *  shape without duplicating it. */
export function buildAgentExtractionMessages(utterance: string): OllamaMessage[] {
  return [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: utterance },
  ];
}

/**
 * JSON Schema handed to ollamaChat's opt-in `jsonSchema` decode-time
 * constraint (lib/local-llm.ts) — a structural safety net UNDER the prompt
 * above, not a replacement for it. This mirrors EXTRACTION_SYSTEM_PROMPT's
 * documented shape field-for-field, so the schema can never disagree with
 * what the prompt already asks for.
 *
 * Deliberately NO `required` array: every field stays independently
 * optional/omittable. Constraining VALUE SHAPE (a string field can't come
 * back as a boolean; actionType can't come back as anything outside the
 * closed union) is exactly the class of small-model failure this exists to
 * prevent — see this file's header comment ("指定フェンスタグを無視、真偽
 * 値を文字列で返す等"). Forcing every field to be PRESENT would do the
 * opposite: an under-informed model would be structurally compelled to
 * invent a value for a field it has nothing to say about, which is worse
 * than the field simply being absent (readValidatedString/the taskClear and
 * autonomousIntent checks below already treat "absent" as "no signal" —
 * exactly what an omitted/omittable field degrades to).
 *
 * `additionalProperties: false` keeps the model from padding the object with
 * extra keys but does not, on its own, make any of the properties above
 * mandatory — that still requires listing them in `required`, which is
 * deliberately omitted here.
 */
const AGENT_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    scheduleText: { type: 'string' },
    actionType: { type: 'string', enum: ['draft', 'notify'] },
    outputPath: { type: 'string' },
    prompt: { type: 'string' },
    taskClear: { type: 'boolean' },
    clarifyingQuestion: { type: 'string' },
    platformHint: { type: 'string' },
    autonomousIntent: { type: ['boolean', 'null'] },
  },
  additionalProperties: false,
};

/** Pull the first top-level `{...}` object out of a raw LLM response — local
 *  models frequently wrap JSON in a code fence or add a leading/trailing
 *  sentence despite instructions not to. Returns null when no plausible
 *  object span is found. */
function extractJsonObjectSpan(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function readValidatedString(
  rec: Record<string, unknown>,
  key: keyof Omit<AgentLlmExtraction, 'actionType' | 'taskClear' | 'autonomousIntent'>,
): string | undefined {
  const v = rec[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const maxLen = MAX_FIELD_LEN[key];
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Parse + validate a raw LLM response into an AgentLlmExtraction. NEVER
 * throws — malformed JSON, a non-object payload, or fields of the wrong
 * shape all resolve to `null` (nothing usable) or to that one field simply
 * being absent from the result, exactly per this module's "fail closed, LLM
 * output is never trusted blind" design. `actionType` in particular is
 * validated against a closed union (`'draft' | 'notify'`) — any other
 * string (a hallucinated type name, a real-but-dangerous type like
 * 'webhook'/'cli', garbage) is silently dropped rather than
 * merged, so a rogue/misbehaving model can never author a privileged action
 * type through this path. "taskClear" is validated as a strict boolean (any
 * other type — string "true", number, missing — leaves it unset, which
 * mergeLlmExtractionIntoDraft treats as "no clarity signal", not as false).
 */
export function parseAgentLlmExtractionResponse(raw: string): AgentLlmExtraction | null {
  if (!raw || !raw.trim()) return null;
  const span = extractJsonObjectSpan(raw);
  if (!span) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(span);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const out: AgentLlmExtraction = {
    name: readValidatedString(rec, 'name'),
    scheduleText: readValidatedString(rec, 'scheduleText'),
    outputPath: readValidatedString(rec, 'outputPath'),
    prompt: readValidatedString(rec, 'prompt'),
    clarifyingQuestion: readValidatedString(rec, 'clarifyingQuestion'),
    platformHint: readValidatedString(rec, 'platformHint'),
  };

  const actionTypeRaw = rec['actionType'];
  if (actionTypeRaw === 'draft' || actionTypeRaw === 'notify') {
    out.actionType = actionTypeRaw;
  }
  // Any other actionType value (webhook/cli/social-post/hallucinated
  // garbage) is intentionally left unset — see this function's own doc
  // comment. mergeLlmExtractionIntoDraft never changes draft.action when
  // out.actionType is undefined.

  const taskClearRaw = rec['taskClear'];
  if (typeof taskClearRaw === 'boolean') {
    out.taskClear = taskClearRaw;
  }

  // Strict boolean only — the prompt asks for null when the utterance says
  // nothing about unattended execution, and JSON null (like a missing key, or
  // a stringly-typed "true") must leave this UNSET rather than collapsing to
  // false. "Unclear" and "the user said no" are different answers: the former
  // means slot-fill should ask, the latter means it already has its answer.
  const autonomousIntentRaw = rec['autonomousIntent'];
  if (typeof autonomousIntentRaw === 'boolean') {
    out.autonomousIntent = autonomousIntentRaw;
  }

  return out;
}

// ── platformHint resolution (deterministic, LLM output never trusted) ───────

/**
 * Resolve a SHORT free-text destination hint from the LLM against a pool of
 * REAL registered connectors, returning a connector only when exactly one
 * matches. This is the "LLM proposes, deterministic code decides" rule applied
 * to destinations: the model is only ever allowed to hand us a NAME it saw in
 * the utterance — never a connectorId, never a platform enum value, never a
 * host — and that name only ever selects from connectors the user already
 * registered themselves. A hint that matches zero connectors (nothing
 * registered for it) or two or more (genuinely ambiguous) resolves to null and
 * changes nothing, leaving the existing needsSetup caveat / socialPostCandidates
 * slot-fill question to handle it exactly as before.
 *
 * Matching mirrors detectSocialPost()'s own two-way resolution — platform
 * ALIAS match plus registered-connector LABEL match, unioned by connector id —
 * with two extra guards appropriate to a short hint rather than a full
 * utterance:
 *   - a single-character alias ('x') must match the hint EXACTLY, never as a
 *     substring (the same collision buildSocialPlatformRe's `\b` guards avoid);
 *   - a label/alias is only allowed to match as a SUBSTRING when it is at
 *     least 3 characters long, so a 1–2 char label can't sweep up every hint.
 */
export function resolvePlatformHintConnector(
  hint: string,
  connectors: SocialConnectorMeta[],
): SocialConnectorMeta | null {
  const h = hint.trim().toLowerCase();
  if (!h || connectors.length === 0) return null;

  const aliasMatches = (alias: string): boolean =>
    alias === h || (alias.length >= 3 && h.includes(alias));
  const platforms = SOCIAL_PLATFORMS_MIRROR.filter((p) =>
    SOCIAL_PLATFORM_ALIASES_MIRROR[p].some(aliasMatches),
  );

  const matched: SocialConnectorMeta[] = connectors.filter((c) => platforms.includes(c.platform));
  for (const c of connectors) {
    const label = c.label.trim().toLowerCase();
    if (!label) continue;
    const labelMatch =
      label === h ||
      (label.length >= 3 && h.includes(label)) ||
      (h.length >= 3 && label.includes(h));
    if (labelMatch && !matched.some((m) => m.id === c.id)) matched.push(c);
  }

  return matched.length === 1 ? matched[0] : null;
}

/**
 * Safely merge a validated AgentLlmExtraction into `draft`. Every field is
 * independently gated:
 *   - `scheduleText` is NEVER applied directly — it is re-run through
 *     parseSchedule() (the exact same whitelisted-cron-shape validator the
 *     deterministic parser itself uses) and only merged when THAT call comes
 *     back confident. An LLM that "extracts" a schedule phrase parseSchedule
 *     itself can't confidently resolve contributes nothing here — same as
 *     if the deterministic parser alone had seen that phrase.
 *   - `actionType` only ever moves the draft from 'draft' to 'notify' (never
 *     the reverse, and never to any other type) — see AgentLlmExtraction's
 *     doc comment for why those are the only two action types this module
 *     will ever accept from the LLM at all.
 *   - `platformHint` is NEVER applied as given — it is resolved through
 *     resolvePlatformHintConnector() against REAL registered connectors, and
 *     only a UNIQUE match (exactly one) is applied, and only while the action
 *     is still 'draft'. The LLM therefore cannot author a connectorId, a
 *     platform, or a host; it can only pick out a name the user already said,
 *     which can only ever select among connectors the user already registered.
 *     Zero or 2+ matches change nothing — the existing needsSetup caveat /
 *     socialPostCandidates slot-fill question handles those exactly as before.
 *   - `autonomousIntent` is stored as `llmAutonomousIntent` ONLY — a proposal
 *     for lib/agent-slot-fill.ts's 'autonomous' slot to consider. It never
 *     touches `draft.autonomous`; only a human answer (or the explicit
 *     `@agent autonomous` alias) ever sets that.
 *   - `outputPath` is only applied while the action is (still) 'draft' —
 *     an output path is meaningless for 'notify' (or for a resolved
 *     social-post destination).
 *   - `prompt`, when present, also re-derives `tool`/`toolLabel` via
 *     suggestTool() so tool routing stays consistent with the (possibly
 *     now more accurate) task description, exactly the way the
 *     deterministic parser's own derivePrompt()→suggestTool() pipeline
 *     works.
 *   - `taskClear`/`clarifyingQuestion` only ever set `draft.needsTaskClarification`
 *     to the LLM's OWN question text — the LLM is trusted to ask, never to
 *     invent what the task should be (see ParsedAgentDraft's doc comment).
 *     Requires BOTH `taskClear === false` AND a non-empty
 *     `clarifyingQuestion` (a false taskClear with no question, or a
 *     malformed/missing taskClear, sets nothing). Conversely, an explicit
 *     `taskClear === true` clears any stale `needsTaskClarification` left
 *     over from an earlier round, so a since-clarified draft doesn't keep
 *     re-asking.
 *
 * Returns the ORIGINAL `draft`, completely unchanged, when nothing in
 * `extraction` was both present and valid enough to apply — this function
 * never sets `llmExtracted: true` on a draft it didn't actually touch.
 */
export function mergeLlmExtractionIntoDraft(
  draft: ParsedAgentDraft,
  extraction: AgentLlmExtraction,
  /** Live registered social connectors, for `platformHint` resolution only.
   *  Optional and additive: when omitted, the pool falls back to
   *  `draft.socialPostCandidates` — the connectors the deterministic parser
   *  itself already matched but couldn't disambiguate, which is precisely the
   *  case a hint is most useful for. Passing an empty/absent list simply means
   *  no hint can ever resolve, i.e. the pre-2026-08-01 behavior. */
  connectors?: SocialConnectorMeta[],
): ParsedAgentDraft {
  let merged: ParsedAgentDraft = draft;
  let touched = false;
  const next = () => {
    if (merged === draft) merged = { ...draft };
    return merged;
  };

  if (extraction.scheduleText) {
    const sched = parseSchedule(extraction.scheduleText);
    if (sched.confident) {
      const m = next();
      m.schedule = sched.schedule;
      m.scheduleConfident = true;
      m.scheduleLabel = sched.label;
      m.suggestedTime = sched.suggestedTime;
      m.suggestedFrequency = sched.suggestedFrequency;
      m.suggestedDowList = sched.suggestedDowList;
      m.scheduleAssumed = sched.assumedTimeOfDay || undefined;
      touched = true;
    }
  }

  if (extraction.actionType === 'notify' && draft.action.type === 'draft') {
    const m = next();
    m.action = { type: 'notify' };
    m.actionCaveat = undefined;
    touched = true;
  }

  // platformHint — resolved deterministically, applied only on a UNIQUE match
  // and only while the action is still 'draft'. Placed AFTER the notify branch
  // deliberately: if the LLM proposed BOTH 'notify' and a destination, the
  // purely-local notify wins, because escalating a local notification into an
  // external post is the one direction of this merge that could surprise the
  // user in a way they can't undo. Placed BEFORE outputPath so a resolved
  // destination correctly suppresses the (now meaningless) draft file path.
  if (extraction.platformHint && merged.action.type === 'draft') {
    const pool = connectors && connectors.length > 0 ? connectors : (draft.socialPostCandidates ?? []);
    const resolved = resolvePlatformHintConnector(extraction.platformHint, pool);
    if (resolved) {
      const m = next();
      m.action = {
        type: 'social-post',
        socialPost: {
          platform: resolved.platform,
          connectorId: resolved.id,
          text: draft.action.socialPost?.text ?? '{{result}}',
        },
      };
      // The caveat/ambiguity that made this draft low-confidence in the first
      // place is now genuinely resolved to a real registered connector, so
      // neither should keep being surfaced. `llmExtracted` below still forces
      // the human confirm round-trip (lib/agent-plan-summary.ts's
      // hasDraftAssumptions), so clearing them cannot make this draft
      // auto-registerable.
      m.actionCaveat = undefined;
      m.socialPostCandidates = undefined;
      touched = true;
      logInfo(
        'AgentLlmFallback',
        `platformHint ${JSON.stringify(extraction.platformHint)} resolved to connector ` +
          `${resolved.id} (${resolved.platform})`,
      );
    } else {
      logInfo(
        'AgentLlmFallback',
        `platformHint ${JSON.stringify(extraction.platformHint)} did not resolve to exactly one ` +
          `registered connector (pool=${pool.length}) — dropped, draft destination unchanged`,
      );
    }
  }

  if (typeof extraction.autonomousIntent === 'boolean' && draft.llmAutonomousIntent !== extraction.autonomousIntent) {
    const m = next();
    m.llmAutonomousIntent = extraction.autonomousIntent;
    touched = true;
  }

  if (extraction.outputPath && (merged.action.type === 'draft')) {
    const m = next();
    m.outputPath = extraction.outputPath;
    touched = true;
  }

  if (extraction.name) {
    const m = next();
    m.name = extraction.name;
    touched = true;
  }

  if (extraction.prompt) {
    const m = next();
    const suggestion = suggestTool(extraction.prompt);
    m.prompt = extraction.prompt;
    m.tool = suggestion.tool;
    m.toolLabel = suggestion.label ?? toolChoiceToLabel(suggestion.tool);
    touched = true;
  }

  if (extraction.taskClear === false && extraction.clarifyingQuestion) {
    const m = next();
    // 2026-07-27 on-device finding: the extraction prompt already instructs
    // "written in the SAME language as the request" (see EXTRACTION_PROMPT
    // above), but small local models don't reliably follow that instruction
    // — a live repro asked "手伝って" and got the clarifying question back in
    // English. The LLM is trusted to ask a question, but never trusted to
    // pick the right language for it (same "LLM proposes, deterministic code
    // decides" pattern this whole module already uses for schedule/action —
    // see the module doc comment). detectMessageLocale is the SAME per-
    // message heuristic lib/agent-slot-fill.ts's nextMissingSlot already
    // uses to pick a question language independent of the device's global
    // i18n setting, so a mismatch here would have shown the same question in
    // the wrong language regardless of this fix. On a mismatch, fall back to
    // a fixed, correctly-localized generic question rather than the LLM's
    // own (wrong-language) text.
    const requestLocale = detectMessageLocale(draft.rawText);
    const questionLocale = detectMessageLocale(extraction.clarifyingQuestion);
    if (requestLocale === questionLocale) {
      m.needsTaskClarification = extraction.clarifyingQuestion;
    } else {
      const fallback = (requestLocale === 'ja' ? ja : en)['slot_fill.question_task_detail_fallback'];
      logInfo(
        'AgentLlmFallback',
        `clarifyingQuestion language mismatch (request=${requestLocale}, question=${questionLocale}) — ` +
          `using localized fallback instead of: ${JSON.stringify(extraction.clarifyingQuestion)}`,
      );
      m.needsTaskClarification = fallback;
    }
    touched = true;
  } else if (extraction.taskClear === true && draft.needsTaskClarification) {
    const m = next();
    m.needsTaskClarification = undefined;
    touched = true;
  }

  if (!touched) return draft;
  merged.llmExtracted = true;
  return merged;
}

// ── §4: impure orchestrator (the only network-calling function here) ────

/**
 * Attempts the LLM extraction fallback and returns a MERGED draft — or the
 * original `draft`, byte-for-byte, on any failure (local LLM disabled/
 * unreachable, timeout, malformed response, nothing usable extracted). Never
 * throws. Deliberately lightweight/single-shot: a short timeout and a small
 * max-token budget (this is a structured-extraction task, not open-ended
 * generation), and it calls the LOCAL model directly via lib/local-llm.ts's
 * non-streaming `ollamaChat` rather than any CLI/agent-runner path — per the
 * task's own "軽量な単発LLM呼び出しに留める" requirement, this must stay a
 * quick best-effort call, not a heavyweight tool invocation.
 *
 * Callers (hooks/use-ai-pane-dispatch.ts) are expected to gate this behind
 * isLowConfidenceAgentDraft(draft) themselves — this function does not
 * re-check that condition, so it will attempt extraction whenever asked
 * regardless of the input draft's confidence.
 *
 * 2026-08-02: passes AGENT_EXTRACTION_JSON_SCHEMA to ollamaChat's opt-in
 * `jsonSchema` decode-time constraint (lib/local-llm.ts), so a small local
 * model (Qwen3.5-2B) is structurally prevented from returning e.g. a
 * stringly-typed boolean or an out-of-union actionType, on top of (not
 * instead of) the prompt wording + extractJsonObjectSpan/
 * parseAgentLlmExtractionResponse validation below, which stay exactly as
 * they were: the schema only tightens what decode-time is ALLOWED to
 * produce, it does not replace the parse/validate/fail-closed pipeline that
 * already treats the response as untrusted input. If the local server
 * doesn't understand response_format/format at all, ollamaChat itself
 * retries once with the schema dropped, so this call degrades to its
 * pre-2026-08-02 behavior rather than failing outright.
 */
export async function extractAgentFieldsWithLlm(
  utterance: string,
  draft: ParsedAgentDraft,
  llmConfig: LocalLlmConfig,
  timeoutMs = 15_000,
  maxTokens = 300,
  /** Optional live connector list, forwarded verbatim to
   *  mergeLlmExtractionIntoDraft for `platformHint` resolution — see that
   *  function's own parameter doc for the fallback when it is omitted. */
  connectors?: SocialConnectorMeta[],
): Promise<ParsedAgentDraft> {
  if (!llmConfig.enabled || !llmConfig.baseUrl || !llmConfig.model) {
    logInfo(
      'AgentLlmFallback',
      `extractAgentFieldsWithLlm skipped: config not usable (enabled=${llmConfig.enabled}, ` +
        `baseUrl=${llmConfig.baseUrl || '(empty)'}, model=${llmConfig.model || '(empty)'})`,
    );
    return draft;
  }
  logInfo(
    'AgentLlmFallback',
    `extractAgentFieldsWithLlm calling ollamaChat (baseUrl=${llmConfig.baseUrl}, model=${llmConfig.model}, ` +
      `timeoutMs=${timeoutMs}, maxTokens=${maxTokens})`,
  );
  try {
    const result = await ollamaChat(
      llmConfig,
      buildAgentExtractionMessages(utterance),
      timeoutMs,
      undefined,
      maxTokens,
      AGENT_EXTRACTION_JSON_SCHEMA,
    );
    if (!result.success || !result.content) {
      logInfo(
        'AgentLlmFallback',
        `extractAgentFieldsWithLlm: ollamaChat failed or empty (success=${result.success}, ` +
          `error=${result.error ?? '(none)'}) — draft unchanged`,
      );
      return draft;
    }
    const extraction = parseAgentLlmExtractionResponse(result.content);
    if (!extraction) {
      logInfo(
        'AgentLlmFallback',
        `extractAgentFieldsWithLlm: response failed to parse as valid extraction JSON — draft unchanged. ` +
          `raw (first 300 chars): ${result.content.slice(0, 300)}`,
      );
      return draft;
    }
    const merged = mergeLlmExtractionIntoDraft(draft, extraction, connectors);
    logInfo(
      'AgentLlmFallback',
      `extractAgentFieldsWithLlm: extracted taskClear=${extraction.taskClear ?? '(unset)'}, ` +
        `clarifyingQuestion=${extraction.clarifyingQuestion ? JSON.stringify(extraction.clarifyingQuestion) : '(none)'}, ` +
        `scheduleText=${extraction.scheduleText ? JSON.stringify(extraction.scheduleText) : '(none)'}, ` +
        `actionType=${extraction.actionType ?? '(unset)'}, ` +
        `platformHint=${extraction.platformHint ? JSON.stringify(extraction.platformHint) : '(none)'}, ` +
        `autonomousIntent=${extraction.autonomousIntent ?? '(unset)'} -> action=${merged.action.type}, ` +
        `needsTaskClarification=` +
        `${merged.needsTaskClarification ? JSON.stringify(merged.needsTaskClarification) : '(unset)'}`,
    );
    return merged;
  } catch (err) {
    logInfo(
      'AgentLlmFallback',
      `extractAgentFieldsWithLlm: threw (${err instanceof Error ? err.message : String(err)}) — draft unchanged`,
    );
    return draft;
  }
}
