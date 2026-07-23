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
 *   - The LLM is NEVER trusted to author a webhook URL, a cli command, an
 *     app-act recipe, or a social-post connector — those need structured
 *     fields (a URL, a shell command, a fixed recipe id, a connector id) an
 *     LLM guess could turn into a real security/privacy hazard. The only
 *     action types this module will ever accept from the LLM are 'draft' and
 *     'notify' — both purely local, T0-risk (see
 *     lib/agent-plan-summary.ts's isAutoRegisterEligibleOnChatConfirm for
 *     the same risk-tier distinction).
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
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { isCapabilityQuestion } from './ask-context';
import { ollamaChat, type LocalLlmConfig, type OllamaMessage } from './local-llm';

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

/**
 * true when the deterministic parser found NEITHER a confident schedule NOR
 * any explicit action signal for this draft — i.e. `draft.action` is nothing
 * more than parseAgentNL's unconditional final default (`{ type: 'draft' }`
 * when nothing else matched at all), not an actual "the user asked for a
 * draft/file save" request. This is deliberately a NARROW gate (both
 * conditions, not either): a draft with an explicit action but no schedule
 * (or vice versa) already has a well-defined, safe path — conversational
 * slot-fill (lib/agent-slot-fill.ts) asks exactly the missing piece, one
 * question at a time, with no LLM involved. Widening this to "either" would
 * route the vast majority of ordinary agent-creation utterances through the
 * LLM fallback (almost every one is missing SOMETHING on first parse — that
 * is what slot-fill is FOR), defeating the "keep the common path
 * LLM-free" requirement this whole module exists to protect.
 *
 * A single 'notify'/'webhook'/'cli'/'app-act'/'social-post' action.type is
 * always treated as explicit — those can only ever be produced by
 * detectAction()'s own keyword/URL branches, never its default. A 'draft'
 * action.type needs one more check, because it is BOTH the explicit-request
 * outcome ("下書き/draft" keyword) and the silent do-nothing-else-matched
 * default: `draft.actionCaveat` being set (the LINE-posting / "register a
 * social connector first" fallback notes) or an explicit draft keyword in
 * the raw utterance both count as "the user asked for something we
 * understood", even though the stored action.type ended up 'draft' either
 * way.
 *
 * Known residual gap (documented, not fixed here — see this module's own
 * doc comment): a compound utterance where the deterministic parser DOES
 * confidently resolve both a schedule and an action (e.g. the Bluesky
 * cross-post example in the module doc comment, which resolves a `daily`
 * schedule and a `social-post` action) but loses OTHER structured detail
 * (a character limit, a multi-condition chain) never reaches this fallback
 * at all under this narrow two-bullet criterion. Widening the trigger to
 * catch that class reliably needs a real "does this utterance look
 * under-parsed even though schedule+action both came back confident"
 * signal, which is a materially harder problem than this pass scopes to.
 */
export function isLowConfidenceAgentDraft(draft: ParsedAgentDraft): boolean {
  if (draft.scheduleConfident) return false;
  const actionExplicit =
    draft.action.type !== 'draft' ||
    !!draft.actionCaveat ||
    EXPLICIT_DRAFT_KEYWORD_RE.test(draft.rawText);
  return !actionExplicit;
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
 *  this module's own doc comment for why webhook/cli/app-act/social-post are
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
}

const MAX_FIELD_LEN: Record<keyof Omit<AgentLlmExtraction, 'actionType'>, number> = {
  name: 60,
  scheduleText: 100,
  outputPath: 200,
  prompt: 2000,
};

const EXTRACTION_SYSTEM_PROMPT = `You extract structured fields from a single natural-language request to create a scheduled automation agent (JP or EN). Respond with STRICT JSON ONLY — no prose, no markdown fences, no explanation — matching exactly this shape:
{"name": string, "scheduleText": string, "actionType": "draft" | "notify", "outputPath": string, "prompt": string}

Rules:
- "name": a short (<= 20 char) human label for the agent, derived from the topic.
- "scheduleText": the schedule phrase VERBATIM or lightly normalized from the request (e.g. "every day at 8am", "毎朝8時"). Do NOT invent a schedule that was not stated. Empty string if none was stated.
- "actionType": "notify" if the request asks to be notified/alerted/reminded; otherwise "draft" (save the result). Never invent any other action type.
- "outputPath": a destination hint (folder/file name) ONLY if one was explicitly stated. Empty string otherwise.
- "prompt": the core task instruction, with the schedule/delivery phrasing removed — what the agent should actually DO each run.
- Every field must be a plain string (use "" for unknown/absent — never null, never omit a key).
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
  key: keyof Omit<AgentLlmExtraction, 'actionType'>,
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
 * 'webhook'/'cli'/'app-act', garbage) is silently dropped rather than
 * merged, so a rogue/misbehaving model can never author a privileged action
 * type through this path.
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
  };

  const actionTypeRaw = rec['actionType'];
  if (actionTypeRaw === 'draft' || actionTypeRaw === 'notify') {
    out.actionType = actionTypeRaw;
  }
  // Any other actionType value (webhook/cli/app-act/social-post/hallucinated
  // garbage) is intentionally left unset — see this function's own doc
  // comment. mergeLlmExtractionIntoDraft never changes draft.action when
  // out.actionType is undefined.

  return out;
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
 *   - `outputPath` is only applied while the action is (still) 'draft' —
 *     an output path is meaningless for 'notify'.
 *   - `prompt`, when present, also re-derives `tool`/`toolLabel` via
 *     suggestTool() so tool routing stays consistent with the (possibly
 *     now more accurate) task description, exactly the way the
 *     deterministic parser's own derivePrompt()→suggestTool() pipeline
 *     works.
 *
 * Returns the ORIGINAL `draft`, completely unchanged, when nothing in
 * `extraction` was both present and valid enough to apply — this function
 * never sets `llmExtracted: true` on a draft it didn't actually touch.
 */
export function mergeLlmExtractionIntoDraft(
  draft: ParsedAgentDraft,
  extraction: AgentLlmExtraction,
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
 */
export async function extractAgentFieldsWithLlm(
  utterance: string,
  draft: ParsedAgentDraft,
  llmConfig: LocalLlmConfig,
  timeoutMs = 15_000,
  maxTokens = 300,
): Promise<ParsedAgentDraft> {
  if (!llmConfig.enabled || !llmConfig.baseUrl || !llmConfig.model) return draft;
  try {
    const result = await ollamaChat(
      llmConfig,
      buildAgentExtractionMessages(utterance),
      timeoutMs,
      undefined,
      maxTokens,
    );
    if (!result.success || !result.content) return draft;
    const extraction = parseAgentLlmExtractionResponse(result.content);
    if (!extraction) return draft;
    return mergeLlmExtractionIntoDraft(draft, extraction);
  } catch {
    return draft;
  }
}
