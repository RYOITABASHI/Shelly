/**
 * lib/agent-conversational-registration.ts — Tier 3 "LLM leads the whole
 * conversation" agent-registration core (Phase 0-3, 2026-08-02).
 *
 * See docs/superpowers/specs/2026-08-02-agent-conversational-registration-plan.md.
 *
 * Background. Shelly's agent-registration flow today is deterministic-first:
 * lib/agent-nl-parser.ts's parseAgentNL owns comprehension (Tier 1),
 * lib/agent-slot-fill.ts asks fixed-template questions for whatever is missing
 * (Tier 2), and lib/agent-llm-fallback.ts calls the LLM exactly ONCE to fill a
 * narrow extraction schema. That structure keeps Shelly's own pipeline in the
 * driver's seat and reduces the model to a tool. This module is the core of the
 * opposite arrangement (Tier 3, Hermes-Agent style): the LLM drives the
 * conversation, asks follow-up questions IN ITS OWN WORDS across multiple
 * turns, and only hands back a structured proposal once it believes it has
 * enough. The deterministic parse becomes a HINT it may ignore.
 *
 * What deliberately does NOT change, and is what makes this safe:
 *
 *   - The human Confirm tap stays mandatory. Any draft this module touches is
 *     marked `llmExtracted: true`, which lib/agent-plan-summary.ts's
 *     hasDraftAssumptions already treats as "never auto-registerable".
 *   - "LLM proposes, deterministic code decides" is preserved field by field.
 *     The model may never author a cron string (only a natural-language phrase,
 *     re-validated through parseSchedule()), never a connectorId/platform/host
 *     (only a destination NAME, resolved through resolvePlatformHintConnector()
 *     against connectors the user already registered), and never a privileged
 *     action type — webhook / cli / app-act / api-call / intent / dm-reply are
 *     all rejected, exactly as in lib/agent-llm-fallback.ts. The only action
 *     types the model can CAUSE are `'draft'` and `'notify'`; `'social-post'`
 *     is tolerated as a no-op declaration (Phase 2) but still reachable only
 *     through the existence-checked platformHint path.
 *   - Every step fails closed: a disabled/unreachable LLM, a timeout, an empty
 *     response, a malformed fence, unparseable JSON, or a proposal where every
 *     field is rejected all leave the caller's draft byte-for-byte unchanged,
 *     so the existing Tier 1/Tier 2 flow proceeds as if this module did not
 *     exist.
 *
 * Wiring: hooks/use-ai-pane-dispatch.ts drives the conversation (Phase 1),
 * gated behind the opt-in `agentConversationalRegistrationEnabled` setting.
 * Whenever Tier 3 gives up — LLM unreachable, an unparseable turn, a repeated
 * question, or the per-session turn cap — the dispatcher falls back to the
 * NARROW single-shot extractor (extractAgentFieldsWithLlm in
 * lib/agent-llm-fallback.ts) fed by buildConversationTranscript() below, and
 * from there to Tier 2 deterministic slot-fill. That narrow extractor is not
 * dead code left over from the pre-Tier-3 design: it is Tier 3's official
 * fallback path and stays authoritative for its own (stricter) field set.
 * High-risk action types (webhook / cli / app-act) remain out of scope, behind
 * their own separate flag if they are ever added.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
import { parseSchedule } from './agent-nl-parser';
import type { SocialConnectorMeta } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
// Reused verbatim, NOT re-implemented: this is the one deterministic
// destination resolver in the codebase, and a mirrored copy here would
// silently drift from detectSocialPost()'s own matching rules the first time
// either side changed. See its doc comment in lib/agent-llm-fallback.ts.
import { resolvePlatformHintConnector } from './agent-llm-fallback';
import { ollamaChat, type LocalLlmConfig, type OllamaMessage } from './local-llm';
import { logInfo } from './debug-logger';

const LOG = 'AgentConvRegistration';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ConversationalRegistrationContext {
  locale: 'ja' | 'en';
  /** What parseAgentNL was able to resolve on its own. Supplied to the model as
   *  a HINT only — unlike Tier 1/Tier 2, the model is explicitly told it may
   *  disagree with any of it. */
  deterministicHint: Partial<ParsedAgentDraft>;
  /** Real registered connectors, for existence-checking a destination NAME the
   *  model reports back. Only `platform` and `label` are ever shown to the
   *  model — never `id`, never `host`, never `fields` (see
   *  buildRegistrationSystemPrompt). */
  connectors: SocialConnectorMeta[];
}

export interface AgentConversationalExtraction {
  name?: string;
  /** A natural-language schedule phrase ("毎朝8時" / "every weekday at 9am").
   *  A raw cron string is NEVER accepted from the model — the caller re-runs
   *  this through parseSchedule(), the same whitelisted-cron-shape gate the
   *  deterministic parser uses, and drops it unless that comes back confident. */
  scheduleText?: string;
  /** Typed as a plain string on purpose: the model can emit ANY string here, so
   *  the type must be able to REPRESENT a rejected value in order for
   *  mergeConversationalExtractionIntoDraft to be able to reject it (and record
   *  the rejection). Only 'draft' | 'notify' | 'social-post' are accepted, and
   *  of those only 'draft'/'notify' can actually change the action — see
   *  ALLOWED_ACTION_TYPES. */
  actionType?: string;
  prompt?: string;
  outputPath?: string;
  /** Free-text destination NAME ("ブルースカイ" / a connector's own label).
   *  Never a connectorId, a platform enum value, a host, or a webhook URL —
   *  resolved deterministically by resolvePlatformHintConnector(). */
  platformHint?: string;
  autonomousIntent?: boolean;
}

export type ConversationalTurn =
  | { kind: 'question'; text: string }
  | { kind: 'proposal'; extraction: AgentConversationalExtraction }
  | { kind: 'unparseable' };

export interface MergeConversationalResult {
  draft: ParsedAgentDraft;
  /** Field names the model proposed that were dropped by existence-checking or
   *  validation. Debug/test surface (and useful for a future "I couldn't use
   *  that destination" nudge); the UI is not required to render it. */
  rejectedFields: string[];
}

export interface ConversationalRegistrationTurnResult {
  success: boolean;
  raw?: string;
  error?: string;
}

// ── Field-length caps (same discipline as agent-llm-fallback.ts) ────────────

/** Per-field hard caps. Truncation can only ever make a value match FEWER real
 *  things (a shorter platformHint resolves to fewer connectors, a shorter
 *  scheduleText parses to fewer crons), never more — so capping is always the
 *  safe direction. Mirrors lib/agent-llm-fallback.ts's MAX_FIELD_LEN, plus an
 *  `actionType` cap since that arrives here as an unconstrained string. */
const MAX_FIELD_LEN: Record<
  keyof Omit<AgentConversationalExtraction, 'autonomousIntent'>,
  number
> = {
  name: 60,
  scheduleText: 100,
  actionType: 20,
  prompt: 2000,
  outputPath: 200,
  // Short by design: a destination NAME, never a sentence.
  platformHint: 60,
};

// ── §1: system-prompt construction (pure) ───────────────────────────────────

/** The fenced block the model must use to hand back a final proposal. A
 *  DISTINCT language tag (not ```json) is required deliberately: local models
 *  emit incidental ```json blocks while thinking out loud, and treating those
 *  as a final registration proposal would skip the conversation the user is
 *  still having. Anything that is not this exact tag is read as prose (a
 *  question), which is the recoverable direction — see
 *  parseConversationalTurnResponse. */
const FENCE_TAG = '```shelly-agent-registration';
const FENCE_END = '```';

/** Only `platform` + `label` — deliberately NOT `id` (used in SecureStore keys
 *  and .env variable names), NOT `host`, NOT `fields` (the NAMES of the secret
 *  fields the platform needs). The model needs to recognize a destination the
 *  user names in conversation, and a display label plus its platform is
 *  sufficient for that; everything else is attack surface for a hallucinated
 *  or exfiltrated identifier. */
function describeConnectors(ctx: ConversationalRegistrationContext): string {
  if (ctx.connectors.length === 0) {
    return ctx.locale === 'ja'
      ? '(登録済みの投稿先はありません — 投稿を伴う依頼は、まず設定で投稿先を登録する必要があると伝えてください)'
      : '(no destinations are registered — if the request involves posting, say that a destination must be registered in settings first)';
  }
  return ctx.connectors.map((c) => `- ${c.label} (${c.platform})`).join('\n');
}

/** Compact, human-readable summary of whatever the deterministic parser got.
 *  Only fields that are actually present are listed, so an empty parse produces
 *  an explicit "nothing" line rather than a wall of blanks. */
function describeDeterministicHint(ctx: ConversationalRegistrationContext): string {
  const h = ctx.deterministicHint;
  const ja = ctx.locale === 'ja';
  const lines: string[] = [];
  if (h.name) lines.push(`- ${ja ? '名前' : 'name'}: ${h.name}`);
  if (h.prompt) lines.push(`- ${ja ? 'やること' : 'task'}: ${h.prompt}`);
  if (h.scheduleLabel) {
    const confident = h.scheduleConfident ? (ja ? '確定' : 'confident') : (ja ? '未確定' : 'not confident');
    lines.push(`- ${ja ? 'スケジュール' : 'schedule'}: ${h.scheduleLabel} (${confident})`);
  }
  if (h.action?.type) lines.push(`- ${ja ? '動作' : 'action'}: ${h.action.type}`);
  if (h.outputPath) lines.push(`- ${ja ? '保存先' : 'outputPath'}: ${h.outputPath}`);
  if (h.actionCaveat) lines.push(`- ${ja ? '注意' : 'caveat'}: ${h.actionCaveat}`);
  if (lines.length === 0) {
    return ja ? '(自動解析では何も取れませんでした)' : '(the automatic parse resolved nothing)';
  }
  return lines.join('\n');
}

/**
 * Build the system prompt for one Tier 3 conversational-registration turn.
 *
 * Two design choices carried over from lib/agent-llm-fallback.ts's on-device
 * experience with small local models (Qwen3.5-2B class):
 *
 *  1. STRICT JSON IS DEMANDED ONLY CONDITIONALLY. A prompt that says "always
 *     answer in JSON" makes a small model treat JSON-shape compliance as the
 *     dominant instruction and quietly drop the others — most visibly the
 *     language instruction (the 2026-07-27 repro where a Japanese request got
 *     an English clarifying question back). Here the model is told: when you
 *     need to ask something, answer in ordinary prose in the user's language,
 *     and emit JSON *only* once you are done gathering.
 *  2. AUTHORITY IS SCOPED, NOT ASSUMED. Every field the model must not author
 *     itself (cron, connector id, URL, privileged action type) is named
 *     explicitly with the reason, rather than relying on the schema shape to
 *     imply it.
 */
export function buildRegistrationSystemPrompt(ctx: ConversationalRegistrationContext): string {
  const connectors = describeConnectors(ctx);
  const hint = describeDeterministicHint(ctx);

  if (ctx.locale === 'ja') {
    return `あなたは Shelly の「自動化エージェント登録アシスタント」です。ユーザーと日本語で会話しながら、定期実行エージェントの登録内容を組み立てます。

【会話の進め方】
- 情報が足りないときは、あなた自身の言葉で自然な日本語の質問を1つだけ返してください。そのときは JSON を一切出力しないでください。
- 一度に複数のことをまとめて聞かないでください。短く、具体的に、1問ずつ聞いてください。
- **直前にあなたが聞いた質問と同じ質問を、二度と繰り返さないでください。** ユーザーの最新の回答を必ず読み、会話を必ず一歩前に進めてください。回答が短くても（「確認なしで」「はい」など）、それは有効な回答です。同じ文面を送り直すのではなく、次に足りない項目を聞くか、情報がそろったなら最終提案を出してください。
- 回答がどうしても曖昧で聞き直すしかないときも、同じ文面のコピーではなく、別の言い方で、何が分からなかったのかを添えて聞いてください。
- ユーザーが言っていないことを勝手に決めつけないでください。分からないことは聞いてください。
- 登録に必要な情報がそろったと判断したときだけ、次の形式のブロックだけを出力してください（前後に説明文を付けないこと）。

【最終提案の出力形式】
${FENCE_TAG}
{"name": "...", "scheduleText": "...", "actionType": "draft", "prompt": "...", "outputPath": "", "platformHint": "", "autonomousIntent": null}
${FENCE_END}

**このフェンスタグ（${FENCE_TAG}）を一字一句そのまま使ってください。 \`\`\`json や、フェンスなしの生JSONでは絶対に返さないでください** — システム側はこの正確なタグだけを「最終提案」として認識します。また、"autonomousIntent" は文字列 "true"/"false" ではなく **真偽値（true/false/null をそのまま）** で書いてください。まだ登録が完了していないのに「登録しました」「完了しました」のような完了を示す文章だけを返すのも禁止です — 完了したと判断したら、必ずこの形式のブロックを出力してください。

【各項目のルール】
- "name": エージェントの短い表示名（20文字以内）。
- "scheduleText": 「毎朝8時」「毎週月曜の9時」のような自然な日本語の表現のみ。**cron 式は絶対に書かないでください**（システム側が変換します）。決まっていなければ空文字。
- "actionType": "draft"（結果をファイルに保存）か "notify"（通知する）のどちらか**だけ**。それ以外の値（webhook, cli, social-post など）は書かないでください。書いても無視されます。
- "prompt": 毎回の実行でエージェントが実際にやること。スケジュールの言い回しは含めないでください。
- "outputPath": 保存先が明示されたときだけ。それ以外は空文字。
- "platformHint": 投稿先の**名前だけ**をそのまま書いてください（例: "ブルースカイ", "会社Bot"）。ID・URL・ホスト名・接続設定を自分で作ってはいけません。システム側が実在の登録済み投稿先と突き合わせます。投稿先の話が出ていなければ空文字。
- "autonomousIntent": 「確認なしで勝手にやっておいて」なら true、「毎回確認して」なら false、どちらとも言っていなければ null。推測しないでください。
  - ただし、**外部への投稿・送信や端末側での実行を伴う動作**（投稿先が決まっている、通知だけでは終わらない、など）で、かつ**実行スケジュールも決まっている**のに、確認の要否をユーザーがまだ一度も言っていないときは、autonomousIntent を null のまま最終提案を出さないでください。その場合は先に「確認なしで実行するか、毎回確認してから実行するか」を1回だけ聞いて、その答えを autonomousIntent に入れてから最終提案を出してください。すでにどちらかを聞き取れているなら、重ねて聞かないでください。

【登録済みの投稿先】
${connectors}

【自動解析のヒント（参考情報 — 間違っていると思ったら従わなくてよい）】
${hint}`;
  }

  return `You are Shelly's automation-agent registration assistant. You talk with the user in English and assemble the definition of a scheduled agent together with them.

【How to run the conversation】
- When something is missing, reply with ONE short follow-up question in your own words, in ordinary prose. Do NOT emit any JSON on such a turn.
- Ask one thing at a time. Keep it short and concrete.
- **Never repeat a question you have already asked.** Always read the user's most recent answer and move the conversation forward by one step. A short answer ("no confirmation", "yes") is still a valid answer — do not re-send the same text; ask for the next missing item instead, or emit the final proposal if you now have everything.
- If an answer really is too ambiguous to use, re-ask in DIFFERENT words and say what was unclear — never resend an identical question.
- Never assume anything the user did not say. If you don't know, ask.
- ONLY once you believe you have everything, output the block below and nothing else (no text before or after it).

【Final proposal format】
${FENCE_TAG}
{"name": "...", "scheduleText": "...", "actionType": "draft", "prompt": "...", "outputPath": "", "platformHint": "", "autonomousIntent": null}
${FENCE_END}

**Use this exact fence tag (${FENCE_TAG}), character for character. Never use \`\`\`json or unfenced raw JSON instead** — the system only recognizes this exact tag as your final proposal. Also write "autonomousIntent" as a real boolean (true/false/null), never the strings "true"/"false". Do not announce that registration is "done" or "complete" in plain text either — if you believe you are done, output the block above instead.

【Field rules】
- "name": a short display label for the agent (<= 20 chars).
- "scheduleText": a plain natural-language phrase only, e.g. "every day at 8am", "every Monday at 9". **Never write a cron expression** — the system converts it. Empty string if no schedule was stated.
- "actionType": either "draft" (save the result to a file) or "notify" (alert the user) and NOTHING else. Do not write webhook, cli, social-post or any other value; they are ignored.
- "prompt": what the agent should actually DO on each run, with the scheduling phrasing removed.
- "outputPath": only when a destination file/folder was explicitly stated. Empty string otherwise.
- "platformHint": the destination NAME only, copied as written (e.g. "Bluesky", "Team Bot"). Never invent an id, a URL, a host, or connection settings — the system matches this against the destinations the user really registered. Empty string if no destination came up.
- "autonomousIntent": true if the user asked for it to run unattended without confirming each time, false if they asked to be asked every time, null if they said nothing either way. Do not guess.
  - However, when the agent **acts outside this device** (posting or sending to a destination, running something) rather than just saving or notifying, **and the schedule is already settled**, do not send the final proposal with autonomousIntent still null. Ask once first whether it should run without confirmation or ask for confirmation every time, then put that answer in autonomousIntent and send the proposal. If the user already told you either way, do not ask again.

【Registered destinations】
${connectors}

【Hint from the automatic parse (reference only — ignore it if you think it is wrong)】
${hint}`;
}

// ── §2: turn-response parsing (pure) ────────────────────────────────────────

/** Pull the first top-level `{...}` object out of a text span by plain string
 *  search — local models routinely add a stray sentence or a nested fence
 *  despite instructions. Deliberately a character scan, not a regex (a regex
 *  for balanced braces is either wrong or unreadable). Mirrors
 *  lib/agent-llm-fallback.ts's private helper of the same name; duplicated
 *  rather than exported-and-shared to keep that module's public surface
 *  unchanged during a parallel edit window. */
function extractJsonObjectSpan(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/** Type-check → trim → drop-if-empty → cap. Anything that isn't a plain
 *  non-empty string simply doesn't exist as far as the merge is concerned. */
function readValidatedString(
  rec: Record<string, unknown>,
  key: keyof Omit<AgentConversationalExtraction, 'autonomousIntent'>,
): string | undefined {
  const v = rec[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const maxLen = MAX_FIELD_LEN[key];
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** Every field name a genuine final proposal can carry. Used only to judge
 *  "does this JSON object look like a proposal" for the schema-based fallback
 *  below — has no bearing on which fields actually get merged (that gate is
 *  entirely readValidatedString + mergeConversationalExtractionIntoDraft). */
const KNOWN_PROPOSAL_KEYS = [
  'name', 'scheduleText', 'actionType', 'prompt', 'outputPath', 'platformHint', 'autonomousIntent',
] as const;

/** How many recognized proposal keys an object needs before the schema-based
 *  fallback (see parseConversationalTurnResponse) trusts it as a genuine final
 *  answer rather than incidental JSON the model happened to produce mid-
 *  conversation (an echoed example, a fragment of "thinking out loud", etc).
 *  2 is deliberately conservative: a single matching key (e.g. a `"name"`
 *  field inside some unrelated JSON) isn't enough evidence, but the real
 *  proposal schema shares no field names with anything else Shelly's prompts
 *  ask the model to emit, so 2+ matches is a strong signal in practice. */
const MIN_SCHEMA_KEY_MATCHES = 2;

function looksLikeProposalObject(rec: Record<string, unknown>): boolean {
  let matches = 0;
  for (const key of KNOWN_PROPOSAL_KEYS) {
    if (key in rec) matches++;
  }
  return matches >= MIN_SCHEMA_KEY_MATCHES;
}

/** Build an AgentConversationalExtraction from an already-parsed JSON record.
 *  Shared by the canonical-fence path and the schema-based fallback path so
 *  field validation (length caps, autonomousIntent typing) can't drift
 *  between the two. */
function buildExtractionFromRecord(rec: Record<string, unknown>): AgentConversationalExtraction {
  const extraction: AgentConversationalExtraction = {
    name: readValidatedString(rec, 'name'),
    scheduleText: readValidatedString(rec, 'scheduleText'),
    actionType: readValidatedString(rec, 'actionType'),
    prompt: readValidatedString(rec, 'prompt'),
    outputPath: readValidatedString(rec, 'outputPath'),
    platformHint: readValidatedString(rec, 'platformHint'),
  };

  // Primarily strict boolean. The prompt asks for JSON `null` when the user
  // said nothing about unattended execution, and that (like a missing key)
  // must leave this UNSET rather than collapsing to false: "unclear" and "the
  // user said no" are different answers downstream.
  //
  // 2026-08-02 on-device finding (Qwen3.5-2B): the model routinely emits
  // `"autonomousIntent": "true"` — a STRING, not JSON true — despite the
  // prompt's example showing a bare boolean. A strict `typeof === 'boolean'`
  // check silently drops this, discarding a clearly-stated user intent. Only
  // the exact, unambiguous string forms "true"/"false" (trimmed, case
  // -insensitive) are accepted as a stand-in for the boolean; anything else
  // stringly-typed ("yes", "1", "たぶん", ...) still leaves this unset rather
  // than guessing.
  const autonomousIntentRaw = rec['autonomousIntent'];
  if (typeof autonomousIntentRaw === 'boolean') {
    extraction.autonomousIntent = autonomousIntentRaw;
  } else if (typeof autonomousIntentRaw === 'string') {
    const normalized = autonomousIntentRaw.trim().toLowerCase();
    if (normalized === 'true') extraction.autonomousIntent = true;
    else if (normalized === 'false') extraction.autonomousIntent = false;
  }

  return extraction;
}

/**
 * Classify one raw LLM turn. NEVER throws.
 *
 *   - empty / whitespace-only            → 'unparseable' (fail closed: an
 *                                          empty question is not something the
 *                                          caller can show a user, so it must
 *                                          degrade to Tier 2 rather than
 *                                          render a blank turn)
 *   - `${FENCE_TAG}` fence + valid JSON  → 'proposal' (the tag alone is
 *                                          trusted — the model chose it
 *                                          deliberately, see FENCE_TAG's doc)
 *   - `${FENCE_TAG}` fence + bad JSON    → 'unparseable' (the caller's Tier 2
 *                                          signal — an explicit intent to
 *                                          finalize that came out malformed)
 *   - no matching fence, but a JSON      → 'proposal' IF the object's shape
 *     object elsewhere in the text         passes looksLikeProposalObject
 *                                          (see its doc: this is the
 *                                          2026-08-02 on-device fallback for
 *                                          FENCE_TAG non-compliance)
 *   - anything else                      → 'question' with the whole trimmed
 *                                          response
 *
 * A proposal whose every field is empty is still a 'proposal' — that is not an
 * error, and mergeConversationalExtractionIntoDraft handles it correctly by
 * returning the caller's original draft, untouched, with nothing applied.
 *
 * 2026-08-02 on-device finding (Qwen3.5-2B): the model reliably decides WHEN
 * it has enough information, but does NOT reliably reproduce the deliberately
 * unusual ${FENCE_TAG} the prompt asks for — it defaults to a plain ```json
 * fence, or no fence at all, even for a fully-formed final answer. Treating
 * every such response as 'question' (the original behavior) meant the raw
 * JSON got rendered to the user as if it were prose, and Tier 3 essentially
 * never reached its own proposal→confirm handoff on-device, relying entirely
 * on the Tier 2 fallback (5-turn cap / repeat detection) to end every
 * conversation instead. The schema check (looksLikeProposalObject) is what
 * replaces the fence tag as the "this is really a final answer, not the model
 * thinking out loud" trust signal for this fallback path — it does not loosen
 * what fields are ACCEPTED (that is still entirely
 * mergeConversationalExtractionIntoDraft's per-field, existence-checked gate),
 * only what raw text is recognized as worth attempting to parse as one.
 */
export function parseConversationalTurnResponse(raw: string): ConversationalTurn {
  if (!raw || !raw.trim()) return { kind: 'unparseable' };

  const tagIndex = raw.indexOf(FENCE_TAG);
  if (tagIndex !== -1) {
    // Body = everything after the opening tag, up to the closing fence. A
    // missing closing fence (a truncated local-model response) is tolerated:
    // we take the rest of the string and let the JSON scan decide.
    const afterTag = raw.slice(tagIndex + FENCE_TAG.length);
    const closeIndex = afterTag.indexOf(FENCE_END);
    const body = closeIndex === -1 ? afterTag : afterTag.slice(0, closeIndex);

    const span = extractJsonObjectSpan(body);
    if (!span) return { kind: 'unparseable' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(span);
    } catch {
      return { kind: 'unparseable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'unparseable' };
    }
    return { kind: 'proposal', extraction: buildExtractionFromRecord(parsed as Record<string, unknown>) };
  }

  // Schema-based fallback (see doc comment above). Deliberately conservative
  // in the OTHER direction from the tagged path: any failure here (no brace
  // span, bad JSON, wrong shape) falls through to 'question' rather than
  // 'unparseable', because — unlike a present-but-malformed FENCE_TAG block —
  // there was never an explicit signal that this response was meant to be a
  // final answer at all, so the safe default is to keep the conversation
  // going rather than force a Tier 2 handoff.
  const span = extractJsonObjectSpan(raw);
  if (span) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(span);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (looksLikeProposalObject(rec)) {
        return { kind: 'proposal', extraction: buildExtractionFromRecord(rec) };
      }
    }
  }

  return { kind: 'question', text: raw.trim() };
}

// ── §2.5: conversation-progress heuristics (pure) ───────────────────────────

/** Characters removed before comparing two questions for "is this literally the
 *  same ask again". Deliberately ONLY sentence-level punctuation and quoting
 *  marks — never word-internal characters (no `ー`, no `-`, no digits), because
 *  stripping those could make two genuinely DIFFERENT questions normalize to
 *  the same string, which is the one failure direction that actually hurts
 *  (a false "the model is stuck" verdict cuts a working conversation short). */
const QUESTION_PUNCT_RE = /[。、．，・？！?!,.:：;；…‥「」『』【】〔〕（）()［］[\]｛｝{}"'`“”‘’]/g;

/** Whitespace incl. the ideographic space. Removed ENTIRELY rather than
 *  collapsed: a local model re-emitting the same Japanese sentence routinely
 *  inserts or drops an interior space (Japanese has no word separator, so
 *  spacing carries no meaning to compare), and "same words, different
 *  spacing" is never two different questions in any language. */
const QUESTION_SPACE_RE = /[\s　]+/g;

/**
 * Normalize one assistant question for repeat-detection: drop all whitespace →
 * drop sentence punctuation → lowercase (so an English re-ask that only
 * differs in capitalization still counts).
 *
 * Intentionally NOT a similarity metric. See isRepeatedRegistrationQuestion.
 */
export function normalizeRegistrationQuestion(text: string): string {
  return text
    .replace(QUESTION_SPACE_RE, '')
    .replace(QUESTION_PUNCT_RE, '')
    .toLowerCase();
}

/**
 * "The conversation is not progressing": the model just asked, word for word,
 * the question it asked on the previous turn — even though the user answered
 * in between.
 *
 * 2026-08-02 on-device finding (Qwen3.5-2B): after the model asked whether the
 * agent should confirm before each run, the user answered "確認なしで" and then
 * "確認せずに勝手に実行して", and the model re-emitted the IDENTICAL question
 * text three turns running. The 5-turn cap eventually rescued it, so nothing
 * was mis-registered — but the user had to answer the same thing three times
 * first. A repeat is a DIFFERENT signal from a parse failure: the turn was
 * perfectly well-formed, the model simply is not consuming the answer, and no
 * number of additional turns will fix that. The caller therefore treats a
 * repeat as an immediate "fall back to Tier 2 deterministic slot-fill", not as
 * a retry.
 *
 * Deliberately conservative — EXACT equality after normalization, no fuzzy
 * distance, no substring/prefix matching. A slightly reworded re-ask ("What
 * time should it run?" → "Which hour should it run at?") is NOT a repeat: the
 * model is still trying, and cutting the conversation off there would be a
 * regression against a genuinely working Tier 3 dialogue.
 */
export function isRepeatedRegistrationQuestion(
  previous: string | undefined | null,
  next: string,
): boolean {
  if (!previous) return false;
  const a = normalizeRegistrationQuestion(previous);
  const b = normalizeRegistrationQuestion(next);
  // An empty normalization ("？？？") carries no evidence either way — never
  // let it stand in for "same question".
  if (!a || !b) return false;
  return a === b;
}

/** Total character budget for buildConversationTranscript's output. The narrow
 *  extractor (lib/agent-llm-fallback.ts) is a single-shot, 300-token call whose
 *  prompt was sized for ONE utterance; a long conversation must not push the
 *  real content out of the model's attention (or its context) entirely. */
const MAX_TRANSCRIPT_CHARS = 2000;

/**
 * Fold a Tier 3 conversation back into a single utterance for the narrow
 * single-shot extractor.
 *
 * 2026-08-02 on-device finding: when Tier 3 gives up (5-turn cap, or the
 * repeat-detection above), the caller previously handed
 * extractAgentFieldsWithLlm only the user's LATEST message — so anything the
 * user had already stated earlier in the same conversation (an agent name, a
 * time, a destination) was silently dropped on the way down to Tier 2, and
 * they were asked for it again. Passing the whole user side of the session
 * fixes that WITHOUT loosening anything: every field still goes through
 * mergeLlmExtractionIntoDraft's existing per-field gates (cron re-validated by
 * parseSchedule, actionType restricted, connectors existence-checked), so a
 * longer input can only ever change WHICH values are proposed, never which
 * ones are acceptable.
 *
 * Only USER text is included — never assistant turns. Feeding the model's own
 * earlier questions back into an extractor would let a hallucinated
 * suggestion ("shall I post it to X?") be re-read as something the user asked
 * for.
 *
 * When over budget, the OLDEST middle entries are dropped first: the opening
 * utterance (which carries the task itself) and the most recent answers (which
 * carry the corrections) are the two ends worth keeping.
 */
export function buildConversationTranscript(
  openingUtterance: string,
  laterUserTexts: string[],
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const cleaned: string[] = [];
  for (const raw of [openingUtterance, ...laterUserTexts]) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    // Drop an immediate repeat (the opening utterance is often re-recorded as
    // the session's first chat message) — nothing is lost, and it keeps the
    // budget for real content.
    if (cleaned[cleaned.length - 1] === trimmed) continue;
    cleaned.push(trimmed);
  }
  if (cleaned.length === 0) return '';

  const joined = cleaned.join('\n');
  if (joined.length <= maxChars) return joined;

  const head = cleaned[0];
  const kept: string[] = [];
  let used = head.length;
  // Walk backwards from the newest message, keeping whatever fits.
  for (let i = cleaned.length - 1; i >= 1; i--) {
    const cost = cleaned[i].length + 1;
    if (used + cost > maxChars) break;
    used += cost;
    kept.unshift(cleaned[i]);
  }
  if (kept.length === 0) {
    // Even the opening utterance alone is over budget — keep its head, which
    // is where an opening utterance states the task.
    return head.slice(0, maxChars);
  }
  return [head, ...kept].join('\n');
}

// ── §3: proposal → draft merge (pure, existence-checked) ────────────────────

/** The closed set of action-type NAMES the model is allowed to utter without
 *  that being recorded as a rejection. Everything else — the privileged types
 *  (webhook / cli / app-act / api-call / intent / dm-reply) and any
 *  hallucinated name — is dropped and reported in rejectedFields.
 *
 *  'draft' and 'notify' are the two types the model can actually CAUSE (Phase
 *  0). 'social-post' was added in Phase 2 and is deliberately different: it is
 *  tolerated as a no-op declaration, NOT as an authorization. Saying
 *  `"actionType": "social-post"` never promotes the action by itself — the
 *  only path to a social-post action is still the platformHint block below,
 *  where resolvePlatformHintConnector() existence-checks a destination NAME
 *  against connectors the user already registered, so the model can never
 *  author a connectorId / platform / host / secret. The allowlist entry exists
 *  purely so that the extremely common "actionType: social-post +
 *  platformHint: <name>" proposal — which resolves correctly through
 *  platformHint — stops logging a misleading `rejectedFields: ['actionType']`
 *  alongside its own success. */
const ALLOWED_ACTION_TYPES = new Set(['draft', 'notify', 'social-post']);

/**
 * Merge one LLM proposal into `draft` under the same per-field gates
 * lib/agent-llm-fallback.ts's mergeLlmExtractionIntoDraft uses, and in the same
 * ORDER (the order encodes safety decisions, see the platformHint block).
 *
 *   - scheduleText: re-validated through parseSchedule(); applied only when
 *     that comes back `confident`. The model never authors a cron.
 *   - actionType: only 'draft' | 'notify' | 'social-post'. 'notify' is applied
 *     only as an upgrade FROM 'draft'; a redundant 'draft' is a silent no-op
 *     (and never downgrades an already-resolved richer action); 'social-post'
 *     is ALWAYS a no-op here and only ever takes effect via platformHint
 *     below. Anything else is dropped and recorded in rejectedFields.
 *   - platformHint: resolved by resolvePlatformHintConnector() against REAL
 *     registered connectors; applied only on a UNIQUE match, and only while the
 *     action is still 'draft'. Zero or 2+ matches change nothing.
 *   - autonomousIntent: stored as `llmAutonomousIntent` ONLY. It NEVER touches
 *     `draft.autonomous` — only a human answer (or the explicit
 *     `@agent autonomous` alias) ever sets that.
 *   - outputPath: only meaningful while the action is still 'draft'.
 *   - prompt: also re-derives tool/toolLabel via suggestTool(), keeping tool
 *     routing consistent with the (now more accurate) task description.
 *
 * Returns the ORIGINAL `draft` object by reference — not a copy, and without
 * `llmExtracted` — when nothing was both present and valid. Callers rely on
 * that referential identity to detect "the model gave us nothing usable".
 */
export function mergeConversationalExtractionIntoDraft(
  draft: ParsedAgentDraft,
  extraction: AgentConversationalExtraction,
  ctx: { connectors: SocialConnectorMeta[] },
): MergeConversationalResult {
  let merged: ParsedAgentDraft = draft;
  let touched = false;
  const rejectedFields: string[] = [];
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
    } else {
      rejectedFields.push('scheduleText');
      logInfo(
        LOG,
        `scheduleText ${JSON.stringify(extraction.scheduleText)} did not parse to a confident cron — dropped`,
      );
    }
  }

  if (extraction.actionType !== undefined) {
    if (!ALLOWED_ACTION_TYPES.has(extraction.actionType)) {
      // The security-critical branch: a model that proposes 'webhook' / 'cli' /
      // 'app-act' / 'api-call' / 'intent' / 'dm-reply' (or invents a type name)
      // gets it dropped here, never merged. There is still no path by which the
      // model can author a privileged action at all.
      rejectedFields.push('actionType');
      logInfo(
        LOG,
        `actionType ${JSON.stringify(extraction.actionType)} is not LLM-authorable — dropped`,
      );
    } else if (extraction.actionType === 'notify' && draft.action.type === 'draft') {
      const m = next();
      m.action = { type: 'notify' };
      m.actionCaveat = undefined;
      touched = true;
    }
    // Everything else in the allowlist is a deliberate no-op, not a rejection:
    // nothing was refused, nothing changed.
    //   - a redundant 'draft' (or a 'notify' on an already-notify draft);
    //   - 'social-post' (Phase 2). The declaration alone NEVER promotes the
    //     action — that stays the exclusive job of the platformHint block
    //     below, whose resolvePlatformHintConnector() existence-check is the
    //     single safety valve keeping connectorId / platform / host / secret
    //     out of the model's hands. So `actionType: 'social-post'` with no
    //     resolvable platformHint correctly leaves the action as-is.
  }

  // Placed AFTER the notify branch on purpose (same reasoning as
  // mergeLlmExtractionIntoDraft): if the model proposed BOTH notify and a
  // destination, the purely-local notify wins, because escalating a local
  // notification into an external post is the one direction of this merge the
  // user cannot undo. Placed BEFORE outputPath so a resolved destination
  // correctly suppresses the now-meaningless draft file path.
  if (extraction.platformHint) {
    if (merged.action.type !== 'draft') {
      rejectedFields.push('platformHint');
      logInfo(
        LOG,
        `platformHint ${JSON.stringify(extraction.platformHint)} ignored — action is already ` +
          `'${merged.action.type}', not 'draft'`,
      );
    } else {
      const resolved = resolvePlatformHintConnector(extraction.platformHint, ctx.connectors);
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
        m.actionCaveat = undefined;
        m.socialPostCandidates = undefined;
        touched = true;
        logInfo(
          LOG,
          `platformHint ${JSON.stringify(extraction.platformHint)} resolved to connector ` +
            `${resolved.id} (${resolved.platform})`,
        );
      } else {
        rejectedFields.push('platformHint');
        logInfo(
          LOG,
          `platformHint ${JSON.stringify(extraction.platformHint)} did not resolve to exactly one ` +
            `registered connector (pool=${ctx.connectors.length}) — dropped`,
        );
      }
    }
  }

  if (
    typeof extraction.autonomousIntent === 'boolean' &&
    draft.llmAutonomousIntent !== extraction.autonomousIntent
  ) {
    const m = next();
    // NEVER m.autonomous — this is a proposal for lib/agent-slot-fill.ts's
    // 'autonomous' slot to consider, not the decision itself.
    m.llmAutonomousIntent = extraction.autonomousIntent;
    touched = true;
  }

  if (extraction.outputPath) {
    if (merged.action.type === 'draft') {
      const m = next();
      m.outputPath = extraction.outputPath;
      touched = true;
    } else {
      rejectedFields.push('outputPath');
    }
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

  if (!touched) {
    logInfo(LOG, `merge applied nothing (rejected=[${rejectedFields.join(',')}]) — draft unchanged`);
    return { draft, rejectedFields };
  }
  // Forces the human confirm round-trip via lib/agent-plan-summary.ts's
  // hasDraftAssumptions, no matter how complete the merged draft now looks.
  merged.llmExtracted = true;
  logInfo(
    LOG,
    `merge applied -> action=${merged.action.type}, scheduleConfident=${merged.scheduleConfident}, ` +
      `rejected=[${rejectedFields.join(',')}]`,
  );
  return { draft: merged, rejectedFields };
}

// ── §4: impure orchestrator (the only network-calling functions here) ───────

/** A conversational turn needs more headroom than the 300-token single-shot
 *  extraction budget in lib/agent-llm-fallback.ts — this turn may be a
 *  free-form question plus reasoning — but must stay bounded so a runaway
 *  model can't stall the registration UI. Shared by every provider so a
 *  cloud turn and a local turn are budgeted identically. */
const TURN_MAX_TOKENS = 600;

/** Optional cloud-provider credentials for runConversationalRegistrationTurn.
 *  Every field is optional; a provider is only attempted when its own API key
 *  is present, exactly like lib/agent-capability-answer.ts's
 *  CapabilityAnswerConfig. Deliberately Cerebras + Groq only (no Gemini) —
 *  matches lib/llm-interpreter.ts's interpretWithFallback, the project's
 *  established "fast general-purpose text task" tier ordering; Gemini's
 *  message format (`parts`, not `content`) is a structurally different shape
 *  this module has no other reason to depend on. */
export interface ConversationalCloudConfig {
  cerebrasApiKey?: string;
  cerebrasModel?: string;
  groqApiKey?: string;
  groqModel?: string;
}

/** No-op onChunk — every provider call here wants the FULL response before
 *  handing it to parseConversationalTurnResponse (Tier 3 has no
 *  incremental-render UI to stream into), so accumulate locally instead of
 *  threading a real callback through. */
function collectChunks(onText: (text: string) => void): (text: string, done: boolean) => void {
  return (text) => { if (text) onText(text); };
}

/** Split a full conversational history into the three shapes the cloud
 *  provider clients (groqChatStream/cerebrasChatStream) expect: a system
 *  prompt string, prior turns as `history`, and the final user message as
 *  `prompt`. Returns null when there is no user turn to send (should not
 *  happen in practice — the caller always appends the latest user message
 *  before calling — but this keeps the orchestrator itself total). */
function splitHistoryForCloud(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
): { systemPrompt: string; priorTurns: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; lastUserContent: string } | null {
  const systemPrompt = history.find((m) => m.role === 'system')?.content ?? '';
  const nonSystem = history.filter((m) => m.role !== 'system');
  const last = nonSystem[nonSystem.length - 1];
  if (!last) return null;
  return { systemPrompt, priorTurns: nonSystem.slice(0, -1), lastUserContent: last.content };
}

/**
 * Run one conversational-registration turn, trying each configured cloud
 * provider before falling back to the local model. Never throws; every
 * failure mode (nothing configured, network error, timeout, empty response)
 * returns `success: false`, which the caller treats as "fall back to Tier 2
 * slot-fill" — the same fail-closed discipline as extractAgentFieldsWithLlm.
 *
 * 2026-08-02: Phase 1 shipped local-only; on-device testing then showed
 * Qwen3.5-2B's real ceiling (repeated questions, ignored formatting
 * instructions) directly degrading the "LLM converses in its own words"
 * experience Tier 3 exists to provide — even though every failure mode was
 * already handled safely by the fallback machinery elsewhere in this module
 * and hooks/use-ai-pane-dispatch.ts. This is Phase 1.5: order matches
 * lib/llm-interpreter.ts's interpretWithFallback (Cerebras -> Groq -> local),
 * the codebase's established "fast general-purpose text task" tier — the
 * on-device local model remains the OFFLINE FLOOR, tried last and always
 * available, never removed. A provider is skipped (not treated as failure)
 * when its API key is absent, and any provider's own exception/HTTP failure
 * falls through to the next one rather than propagating.
 */
export async function runConversationalRegistrationTurn(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  localLlmConfig: { baseUrl?: string; model?: string; enabled: boolean },
  timeoutMs = 30_000,
  cloudConfig: ConversationalCloudConfig = {},
): Promise<ConversationalRegistrationTurnResult> {
  const split = splitHistoryForCloud(history);

  if (split && cloudConfig.cerebrasApiKey) {
    try {
      const { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } = await import('./cerebras');
      let acc = '';
      const result = await cerebrasChatStream(
        cloudConfig.cerebrasApiKey,
        split.lastUserContent,
        collectChunks((t) => { acc += t; }),
        cloudConfig.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
        split.priorTurns,
        undefined,
        split.systemPrompt,
      );
      if (result.success && acc.trim()) return { success: true, raw: acc };
      logInfo(LOG, `runConversationalRegistrationTurn: Cerebras turn unusable (${result.error ?? 'empty response'}), trying next provider`);
    } catch (err) {
      logInfo(LOG, `runConversationalRegistrationTurn: Cerebras turn threw (${err instanceof Error ? err.message : String(err)}), trying next provider`);
    }
  }

  if (split && cloudConfig.groqApiKey) {
    try {
      const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('./groq');
      let acc = '';
      const result = await groqChatStream(
        cloudConfig.groqApiKey,
        split.lastUserContent,
        collectChunks((t) => { acc += t; }),
        cloudConfig.groqModel ?? GROQ_DEFAULT_MODEL,
        split.priorTurns,
        undefined,
        split.systemPrompt,
      );
      if (result.success && acc.trim()) return { success: true, raw: acc };
      logInfo(LOG, `runConversationalRegistrationTurn: Groq turn unusable (${result.error ?? 'empty response'}), trying next provider`);
    } catch (err) {
      logInfo(LOG, `runConversationalRegistrationTurn: Groq turn threw (${err instanceof Error ? err.message : String(err)}), trying next provider`);
    }
  }

  return runConversationalRegistrationTurnLocal(history, localLlmConfig, timeoutMs);
}

/** The offline floor: the original Phase 1 local-only implementation,
 *  unchanged, now the last link in runConversationalRegistrationTurn's
 *  chain rather than the whole function. Exported separately so tests (and
 *  any future caller that deliberately wants to skip the cloud chain — e.g.
 *  an explicit "force local" setting) can call it directly. */
export async function runConversationalRegistrationTurnLocal(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  localLlmConfig: { baseUrl?: string; model?: string; enabled: boolean },
  timeoutMs = 30_000,
): Promise<ConversationalRegistrationTurnResult> {
  if (!localLlmConfig.enabled || !localLlmConfig.baseUrl || !localLlmConfig.model) {
    const error = `local LLM not usable (enabled=${localLlmConfig.enabled}, baseUrl=${
      localLlmConfig.baseUrl || '(empty)'
    }, model=${localLlmConfig.model || '(empty)'})`;
    logInfo(LOG, `runConversationalRegistrationTurn skipped: ${error}`);
    return { success: false, error };
  }

  // Narrowed above, so these are real strings — LocalLlmConfig requires them
  // non-optional.
  const cfg: LocalLlmConfig = {
    baseUrl: localLlmConfig.baseUrl,
    model: localLlmConfig.model,
    enabled: true,
  };

  try {
    const result = await ollamaChat(
      cfg,
      history as OllamaMessage[],
      timeoutMs,
      undefined,
      TURN_MAX_TOKENS,
    );
    if (!result.success || !result.content || !result.content.trim()) {
      const error = result.error ?? 'empty response';
      logInfo(
        LOG,
        `runConversationalRegistrationTurn failed (success=${result.success}, error=${error})`,
      );
      return { success: false, error };
    }
    return { success: true, raw: result.content };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logInfo(LOG, `runConversationalRegistrationTurn threw: ${error}`);
    return { success: false, error };
  }
}
