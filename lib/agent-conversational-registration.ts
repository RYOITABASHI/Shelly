/**
 * lib/agent-conversational-registration.ts — Tier 3 "LLM leads the whole
 * conversation" agent-registration core (Phase 0-4, 2026-08-03).
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
 *     against connectors the user already registered), and — by default —
 *     never a privileged action type: webhook / cli / app-act / api-call /
 *     intent / dm-reply are all rejected, exactly as in
 *     lib/agent-llm-fallback.ts. Out of the box the only action types the model
 *     can CAUSE are `'draft'` and `'notify'`; `'social-post'` is tolerated as a
 *     no-op declaration (Phase 2) but still reachable only through the
 *     existence-checked platformHint path.
 *   - Phase 4 (2026-08-03) adds ONE opt-in exception, behind its own separate
 *     `allowHighRiskActions` flag that is absent/false by default: `'webhook'`
 *     and `'cli'` become LLM-authorable, but the dangerous STRING each one
 *     needs (a destination URL, a shell command) is accepted only when it
 *     appears verbatim — byte for byte, case sensitive — inside the text the
 *     USER themselves typed during this Tier 3 session. See
 *     requireVerbatimSubstringMatch. That gate exists to answer exactly one
 *     question — "did the human really say this string?" — and nothing more.
 *     Whether the string is SAFE TO RUN is not this module's business and is
 *     unchanged by Phase 4: the runtime gates (SHELLY_WEBHOOK_HOST_ALLOWLIST,
 *     lib/command-safety.ts, the capability broker, the per-run approval tap)
 *     all still apply unconditionally to anything registered this way, exactly
 *     as they do to an action authored by hand in the UI. `'app-act'` stays out
 *     of scope entirely — its AgentAction.appActRecipeId is documented in
 *     store/types.ts as schema-only with no dispatch logic reading it yet.
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
 * fallback path and stays authoritative for its own (stricter) field set — it
 * has NO webhook/cli path of its own and gained none in Phase 4, so falling
 * back to it always narrows what can be authored, never widens it.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
// normalizeBrowserPaneUrl: the SAME deterministic URL normalizer/validator the
// Tier 1 parser uses to author a browser-pane allowlist entry — shared, never
// re-implemented, so the two tiers can't drift on what counts as a valid
// allowlist URL. Applied AFTER requireVerbatimSubstringMatch passes (the
// verbatim gate runs on the candidate exactly as the model proposed it;
// normalization is deterministic code's job).
import { normalizeBrowserPaneUrl, parseSchedule } from './agent-nl-parser';
import type { AgentAction, SocialConnectorMeta } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
// Reused verbatim, NOT re-implemented: this is the one deterministic
// destination resolver in the codebase, and a mirrored copy here would
// silently drift from detectSocialPost()'s own matching rules the first time
// either side changed. See its doc comment in lib/agent-llm-fallback.ts.
import { resolvePlatformHintConnector } from './agent-llm-fallback';
// Phase 6 (multi-step). Imported, never re-implemented: detectApiCallSteps and
// tagStepsWithToolMentions are the SAME deterministic upgrades the Tier 1
// parser runs over its own split steps (lib/agent-nl-parser.ts), in the SAME
// order (tag tool mentions, THEN detect api-calls — matches agent-nl-parser.ts
// lines ~1770-1778), and HARD_MAX_STEPS is the same hard ceiling the
// orchestration executor itself enforces — a locally-redeclared copy of any of
// these would drift the moment one side changed.
import { detectApiCallSteps, HARD_MAX_STEPS, isNotifyOnlyClause, isScheduleOnlyClause, tagStepsWithToolMentions } from './agent-orchestration';
// Tier 2's own cross-turn partial-schedule merge (a bare time completing a
// recurrence the draft already knows), shared — NOT re-implemented — so the
// Tier 3 merge can never drift from applySlotAnswer's behavior again. See the
// 2026-08-03 repeated-schedule-question bug in the scheduleText branch below.
import { combinePartialScheduleWithDraft } from './agent-slot-fill';
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
  /** Phase 4 opt-in. When true, the prompt additionally tells the model that
   *  `'webhook'` / `'cli'` are selectable action types AND that the URL/command
   *  they carry is only ever accepted when copied verbatim out of the user's
   *  own words. When false/absent (the default) the prompt is byte-identical to
   *  Phase 0-3's — no mention of the high-risk types beyond the pre-existing
   *  "do not write them" line. This is a PROMPT hint only: the actual
   *  enforcement lives in mergeConversationalExtractionIntoDraft, which has its
   *  own independent copy of the same flag, so a model that ignores this text
   *  changes nothing. */
  allowHighRiskActions?: boolean;
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
  /** Phase 4 (gated): a webhook destination URL, verbatim from the user's own
   *  words only — see requireVerbatimSubstringMatch. Never accepted unless
   *  ctx.allowHighRiskActions is true AND the verbatim check passes. */
  webhookUrl?: string;
  /** Phase 4 (gated): a CLI command template, verbatim from the user's own
   *  words only — same gating as webhookUrl. */
  cliCommand?: string;
  /** browser-pane (2026-08-05): which closed page operation to perform.
   *  Only 'click' | 'extractText' are ever accepted ('fill' is deliberately
   *  not NL-authorable — see mergeConversationalExtractionIntoDraft's
   *  browser-pane branch); any other value rejects the whole browser-pane
   *  proposal, fail-closed. */
  browserActionKind?: string;
  /** browser-pane: the target page URL, verbatim from the user's own words
   *  only — same requireVerbatimSubstringMatch gate as webhookUrl/cliCommand,
   *  but WITHOUT the allowHighRiskActions opt-in: unlike webhook/cli, the
   *  registered action is attended-only, never auto-accepted even when
   *  attended, and allowlist-checked twice more at fire time (see
   *  store/types.ts's browserPaneAction doc comment), so the verbatim gate +
   *  the mandatory registration confirm are the authoring-side controls. */
  browserUrl?: string;
  /** browser-pane: the CSS selector, verbatim from the user's own words only
   *  — same gating as browserUrl. */
  browserSelector?: string;
  /** Phase 6 (2026-08-03): ordered plain-language sub-instructions for a
   *  MULTI-step agent, e.g.
   *  `["Xで最新のAIニュースを調べる", "要約する", "Blueskyに投稿する"]`.
   *
   *  Only meaningful when there are 2+ entries — a 0/1-element array degrades
   *  to the ordinary `prompt` field being used instead (see the merge logic),
   *  because "one step" is exactly the single-run agent Shelly already builds.
   *
   *  Each entry is a plain instruction STRING and nothing else. The model does
   *  NOT author tool pins, connector ids, hosts, or API-call specifics here:
   *  those still resolve deterministically downstream via detectApiCallSteps()
   *  in lib/agent-orchestration.ts, exactly as they do for the Tier 1
   *  deterministic parser (lib/agent-nl-parser.ts). This field therefore
   *  AUTHORIZES nothing — it only lets a multi-step request stay multi-step
   *  instead of being flattened into one prompt. Whether any given step is
   *  allowed to do anything privileged is decided, unchanged, by the existing
   *  orchestration executor gates (per-step boundary policy + command-safety +
   *  capability broker + budget + host allowlist). */
  steps?: string[];
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
  /** Which provider actually answered this turn. Debug/observability only —
   *  nothing branches on this. Added 2026-08-03: without it, a successful
   *  Cerebras/Groq turn was indistinguishable in logs from a local-model turn
   *  (only FAILURE was logged per-provider), which made on-device debugging
   *  of "why is this so fast" genuinely ambiguous. */
  provider?: 'cerebras' | 'groq' | 'local';
}

// ── Field-length caps (same discipline as agent-llm-fallback.ts) ────────────

/** Per-field hard caps. Truncation can only ever make a value match FEWER real
 *  things (a shorter platformHint resolves to fewer connectors, a shorter
 *  scheduleText parses to fewer crons), never more — so capping is always the
 *  safe direction. Mirrors lib/agent-llm-fallback.ts's MAX_FIELD_LEN, plus an
 *  `actionType` cap since that arrives here as an unconstrained string. */
const MAX_FIELD_LEN: Record<
  // `steps` is excluded because it is an ARRAY, not a scalar string: it needs
  // both a per-entry length cap AND an entry-count cap, which this single-number
  // record cannot express. See MAX_STEP_TEXT_LEN / readValidatedSteps.
  keyof Omit<AgentConversationalExtraction, 'autonomousIntent' | 'steps'>,
  number
> = {
  name: 60,
  scheduleText: 100,
  actionType: 20,
  prompt: 2000,
  outputPath: 200,
  // Short by design: a destination NAME, never a sentence.
  platformHint: 60,
  // Phase 4. Capping stays safe here for a subtler reason than the fields
  // above. Truncation makes requireVerbatimSubstringMatch EASIER to satisfy (a
  // shorter needle is found more often), but the invariant it enforces is
  // untouched: whatever survives the cap is still required to be a literal
  // substring of what the user typed, so an over-long candidate can at worst be
  // registered as a prefix the user really did write — never as a string they
  // did not. Sized to match `prompt`, the other field that can legitimately
  // carry a long payload.
  webhookUrl: 2000,
  cliCommand: 2000,
  // browser-pane (2026-08-05). Same truncation-safety argument as webhookUrl
  // above: whatever survives the cap must still be a literal substring of
  // what the user typed, so an over-long candidate can at worst become a
  // prefix the user really wrote. browserSelector additionally sits under
  // lib/browser-pane-automation.ts's own 2048-char runtime cap.
  browserActionKind: 20,
  browserUrl: 2000,
  browserSelector: 2000,
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
  // Phase 4. Appended (never substituted) right after the existing actionType
  // bullet, so that with the flag off the prompt is byte-for-byte the Phase 0-3
  // string. The first line explicitly overrides the pre-existing "do not write
  // webhook/cli" sentence rather than editing it, keeping that guarantee. The
  // second line is deliberately worded like the platformHint rule right below
  // it — same "the system checks this against reality, inventing one is
  // pointless" framing, because it is the same kind of gate.
  const highRiskRules = ctx.allowHighRiskActions === true
    ? (ctx.locale === 'ja'
        ? `
- **この会話に限り、"actionType" には "webhook"（指定されたURLへHTTP送信する）と "cli"（シェルコマンドを実行する）も選べます。** 直前の行の制限より、こちらの指示が優先されます。
- "webhookUrl" / "cliCommand": **ユーザーがこの会話の中で実際にタイプした文字列を、一字一句そのままコピーした場合にしか採用されません。** システム側がユーザー自身の発言と突き合わせ、一文字でも違えば必ず却下します。URLやコマンドを自分で考えて書いてはいけません（必ず却下されるので無意味です）。ユーザーが明示的に書いていないなら、これらは空文字にしてください。`
        : `
- **In this conversation only, "actionType" may ALSO be "webhook" (send an HTTP request to a URL) or "cli" (run a shell command).** This overrides the restriction on the line above.
- "webhookUrl" / "cliCommand": **only accepted when copied character for character from what the USER actually typed in this conversation.** The system matches the value against the user's own words and rejects it if even one character differs. Never invent a URL or a command yourself (it will always be rejected, so it is pointless). Leave these empty if the user did not explicitly write one.`)
    : '';

  // browser-pane (2026-08-05). Always appended (not gated behind
  // allowHighRiskActions — see ALLOWED_ACTION_TYPES' doc comment for the full
  // rationale). Worded like the highRiskRules block above because it relies
  // on the same gate: the system verbatim-matches browserUrl/browserSelector
  // against the user's own words, so inventing either is pointless.
  const browserPaneRules = ctx.locale === 'ja'
    ? `
- ページ操作の依頼（Browser Paneに開いたページの要素をクリックする / テキストを取得する）のときだけ、"actionType" に "browser-pane" も選べます。その場合は "browserActionKind"（"click" か "extractText"）、"browserUrl"（対象ページのURL）、"browserSelector"（CSSセレクタ）を必ず全部入れてください。
- "browserUrl" / "browserSelector": **ユーザーがこの会話の中で実際にタイプした文字列を、一字一句そのままコピーした場合にしか採用されません。** 一文字でも違えばシステムが必ず却下します。URLやセレクタを自分で考えて書いてはいけません。ユーザーがまだ書いていないなら、先に質問して聞き出してください。この動作は登録後も毎回ユーザーがその場で承認しないと実行されません。`
    : `
- Only for a page-operation request (clicking an element / extracting text on a page open in the Browser Pane), "actionType" may ALSO be "browser-pane". Then you MUST include all of "browserActionKind" ("click" or "extractText"), "browserUrl" (the target page URL) and "browserSelector" (the CSS selector).
- "browserUrl" / "browserSelector": **only accepted when copied character for character from what the USER actually typed in this conversation.** The system rejects them if even one character differs. Never invent a URL or a selector yourself. If the user has not written one yet, ask for it first. Even after registration, this action only ever runs when the user approves it on screen each time.`;

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
{"name": "...", "scheduleText": "...", "actionType": "draft", "prompt": "...", "steps": [], "outputPath": "", "platformHint": "", "autonomousIntent": null}
${FENCE_END}

**このフェンスタグ（${FENCE_TAG}）を一字一句そのまま使ってください。 \`\`\`json や、フェンスなしの生JSONでは絶対に返さないでください** — システム側はこの正確なタグだけを「最終提案」として認識します。また、"autonomousIntent" は文字列 "true"/"false" ではなく **真偽値（true/false/null をそのまま）** で書いてください。まだ登録が完了していないのに「登録しました」「完了しました」のような完了を示す文章だけを返すのも禁止です — 完了したと判断したら、必ずこの形式のブロックを出力してください。

【各項目のルール】
- "name": エージェントの短い表示名（20文字以内）。
- "scheduleText": 「毎朝8時」「毎週月曜の9時」のような自然な日本語の表現のみ。**cron 式は絶対に書かないでください**（システム側が変換します）。決まっていなければ空文字。
- "actionType": "draft"（結果をファイルに保存）か "notify"（通知する）のどちらか**だけ**。それ以外の値（webhook, cli, social-post など）は書かないでください。書いても無視されます。${highRiskRules}${browserPaneRules}
- "prompt": 毎回の実行でエージェントが実際にやること。スケジュールの言い回しは含めないでください。
- "steps": **複数の手順に分かれる依頼（例: 調べる → 要約する → 投稿する）のときだけ**、手順を順番どおりに、自然な指示文の配列として書いてください（最大${MAX_MODEL_AUTHORED_STEPS}個）。手順が1つしかない依頼なら空配列 [] のままにして、やることは "prompt" に書いてください。各要素はただの指示文です — ID・URL・接続設定を自分で考えて書いてはいけません。ただし、**ユーザーがその手順で使うツール（Perplexity、ローカルLLM、Codex、Gemini）を実際に名指ししていた場合は、その名前をそのまま指示文の中に含めてください**（例:「Perplexityで最新ニュースを調べる」）。システム側がその名前を認識してツールを割り当てます。ユーザーが名指ししていないのに自分でツール名を考えて書いてはいけません。
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
{"name": "...", "scheduleText": "...", "actionType": "draft", "prompt": "...", "steps": [], "outputPath": "", "platformHint": "", "autonomousIntent": null}
${FENCE_END}

**Use this exact fence tag (${FENCE_TAG}), character for character. Never use \`\`\`json or unfenced raw JSON instead** — the system only recognizes this exact tag as your final proposal. Also write "autonomousIntent" as a real boolean (true/false/null), never the strings "true"/"false". Do not announce that registration is "done" or "complete" in plain text either — if you believe you are done, output the block above instead.

【Field rules】
- "name": a short display label for the agent (<= 20 chars).
- "scheduleText": a plain natural-language phrase only, e.g. "every day at 8am", "every Monday at 9". **Never write a cron expression** — the system converts it. Empty string if no schedule was stated.
- "actionType": either "draft" (save the result to a file) or "notify" (alert the user) and NOTHING else. Do not write webhook, cli, social-post or any other value; they are ignored.${highRiskRules}${browserPaneRules}
- "prompt": what the agent should actually DO on each run, with the scheduling phrasing removed.
- "steps": **only when the request genuinely breaks into several ordered steps** (e.g. research → summarize → post), list them IN ORDER as an array of plain instruction sentences (${MAX_MODEL_AUTHORED_STEPS} max). If the request is a single step, leave "steps" as an empty array [] and put the task in "prompt" instead. Each entry is just an instruction sentence — never invent an id, a URL, or connection settings. If the user actually named which tool a step should use (Perplexity, the local model, Codex, Gemini), include that name naturally in the step's own sentence (e.g. "look up the latest news with Perplexity") — the system recognizes that name and routes to it. Never invent a tool name the user didn't say.
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

/** Per-ENTRY character cap for `steps`. Sized to match `prompt`, the other
 *  field that carries a task description — a step IS a task description, just a
 *  smaller one. Note the real ceiling downstream is tighter still
 *  (normalizeStep in lib/agent-orchestration.ts truncates every instruction to
 *  500 chars before it can ever run), so this cap only bounds what this module
 *  hands on; it never widens anything. */
const MAX_STEP_TEXT_LEN = 2000;

/** Entry-COUNT cap: the same HARD_MAX_STEPS the orchestration executor enforces
 *  (imported, not redeclared). A runaway model that emits 40 "steps" gets the
 *  first 10 — the executor would refuse the rest anyway (nextStepGate's step
 *  budget), so truncating here just keeps the confirm card honest about what
 *  will actually run. */
const MAX_MODEL_AUTHORED_STEPS = HARD_MAX_STEPS;

/** Below this, "steps" is not a multi-step agent at all. Mirrors
 *  isOrchestrated() in lib/agent-orchestration.ts and the `>= 2` guard in
 *  lib/agent-plan-summary.ts / hooks/use-ai-pane-dispatch.ts: those are the
 *  places that decide whether an agent runs as a chain, and a value they would
 *  ignore must never be written as if it meant something. */
const MIN_ORCHESTRATION_STEPS = 2;

/**
 * The array analogue of readValidatedString: type-check the container →
 * type-check each entry → trim → drop empties → cap each entry's length → cap
 * the entry count. Returns `undefined` for a non-array (the field effectively
 * does not exist), and `[]` for an array that contained nothing usable — the
 * caller distinguishes those two from "a real list" itself.
 *
 * Entries are TRUNCATED, never dropped, when over MAX_STEP_TEXT_LEN. Dropping
 * one would silently delete a link from an ORDERED chain ("research → summarize
 * → post" becoming "research → post"), which changes what the agent does; a
 * truncated instruction is still the user's own step, just shortened, and the
 * human still sees the exact text on the confirm card before anything is
 * registered.
 */
function readValidatedSteps(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.push(trimmed.length > MAX_STEP_TEXT_LEN ? trimmed.slice(0, MAX_STEP_TEXT_LEN) : trimmed);
    if (out.length >= MAX_MODEL_AUTHORED_STEPS) break;
  }
  return out;
}

// ── Step sanitize (2026-08-03, on-device bug agent-msd4bkjt) ────────────────
//
// Tier 3 has no deterministic step splitter of its own — the model authors
// `steps: string[]` freely, and on device it happily copied the user's
// SCHEDULE fragment (「20時00分に」) and the DELIVERY directive (「通知して」)
// into the step list as if they were work steps. Both then ran as real model
// calls: the schedule fragment produced a nonsense "step result" that polluted
// the next step's carried context, and the delivery step duplicated what the
// agent's own action.type already does after the chain. Tier 1's splitter has
// (narrow) schedule-clause dropping (isScheduleOnlyClause /
// parseStepsFromText's raw[0] rule) but none of it ever ran on model-authored
// steps. This sanitizer is the deterministic gate between the two.
//
// Deliberately ANCHORED whole-step matching throughout: a step that merely
// CONTAINS a time or the word 通知 alongside real work (「20:00のログを調べる」,
// 「通知内容を作成する」) must never be dropped — only a step that is a
// schedule/delivery fragment and NOTHING else.

/** A bare clock time and nothing else: 「20時00分に」「朝8時」「20:00」. The
 *  trailing particle set (に/から/の) mirrors SCHEDULE_ONLY_CLAUSE_RE's. */
const JA_BARE_TIME_ONLY_STEP_RE =
  /^(?:午前|午後|朝|夜|夕方|晩|深夜|昼)?\s*\d{1,2}\s*(?:時\s*(?:半|\d{1,2}\s*分)?|[:：]\d{2})\s*(?:に|から|の)?$/;
/** A bare interval and nothing else: 「5分ごとに」「3時間おき」. */
const JA_INTERVAL_ONLY_STEP_RE = /^\d{1,3}\s*(?:分|時間)\s*(?:ごと|おき|毎|間隔)\s*(?:に|で)?$/;
/** A bare frequency word and nothing else: 「毎日」「毎朝」「平日に」. */
const JA_FREQ_ONLY_STEP_RE = /^(?:毎日|毎朝|毎晩|毎夕|毎週|日次|平日|週末)\s*(?:に|の)?$/;
/** EN equivalents: "at 8pm", "every day at 20:00", "daily". */
const EN_SCHEDULE_ONLY_STEP_RE =
  /^(?:(?:every\s?day|everyday|daily|each\s+day|every\s+(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?s?)[\s,]*)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i;
const EN_FREQ_ONLY_STEP_RE = /^(?:every\s?day|everyday|daily|each\s+day)$/i;

/** Strip trailing sentence punctuation before the anchored checks — the model
 *  often writes steps as full sentences (「20時00分に。」). */
function stripTrailingPunct(text: string): string {
  return text.trim().replace(/[。．.、,！!]+$/, '').trim();
}

/** Whitespace/punctuation-insensitive comparison key, for "this step IS the
 *  proposal's own scheduleText, re-listed as a step" detection. */
function normalizeForScheduleComparison(text: string): string {
  return text.replace(/[\s。．.、,！!　]/g, '').toLowerCase();
}

function isScheduleOnlyStepText(step: string): boolean {
  const t = stripTrailingPunct(step);
  if (!t) return false;
  return (
    // Tier 1's shared weekday/daily clause detector first (agent-orchestration.ts)…
    isScheduleOnlyClause(t) ||
    // …then the bare-time/interval/frequency shapes it deliberately does not
    // cover (it requires a weekday or daily marker; a model-authored fragment
    // like 「20時00分に」 has neither).
    JA_BARE_TIME_ONLY_STEP_RE.test(t) ||
    JA_INTERVAL_ONLY_STEP_RE.test(t) ||
    JA_FREQ_ONLY_STEP_RE.test(t) ||
    EN_SCHEDULE_ONLY_STEP_RE.test(t) ||
    EN_FREQ_ONLY_STEP_RE.test(t)
  );
}

function isNotifyOnlyStepText(step: string): boolean {
  // Delegates to the shared detector in lib/agent-orchestration.ts (2026-08-04)
  // — see isNotifyOnlyClause's doc comment for why this moved: Tier 1's own
  // step splitter needed the identical check and a per-tier copy had already
  // drifted (Tier 1 had none at all).
  return isNotifyOnlyClause(step);
}

export interface SanitizedConversationalSteps {
  steps: string[];
  /** The fragments removed (schedule-only / delivery-only), for logging and
   *  tests. Order preserved. */
  dropped: string[];
}

/**
 * Deterministically remove non-work fragments from a model-authored step list
 * BEFORE it can become orchestrationSteps:
 *
 *  - schedule-only steps (「20時00分に」「毎日8時」"at 8pm") — the schedule is
 *    scheduleText's job, never a work step;
 *  - steps that are just the proposal's own scheduleText restated (normalized
 *    comparison), whatever their shape;
 *  - delivery-only steps (「通知して」"notify me") when the resolved action
 *    type is 'notify' — the action already delivers after the chain. Steps
 *    that CREATE deliverable content (「通知内容を作成する」) are real work
 *    and are kept; only the bare directive is dropped. Scoped to 'notify' on
 *    purpose: for any other action type a delivery-ish step may carry intent
 *    this sanitizer cannot judge, and keeping it is the conservative failure.
 *
 * The caller applies MIN_ORCHESTRATION_STEPS to the SANITIZED list, so a list
 * that sanitizes below 2 falls back to the ordinary single-prompt agent —
 * never a 1-step "chain" the runtime/UI don't expect.
 */
export function sanitizeConversationalSteps(
  steps: string[],
  opts: { scheduleText?: string; actionType?: AgentAction['type'] } = {},
): SanitizedConversationalSteps {
  const normalizedSchedule = opts.scheduleText
    ? normalizeForScheduleComparison(stripTrailingPunct(opts.scheduleText))
    : '';
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const step of steps) {
    const matchesProposalSchedule =
      normalizedSchedule.length > 0 &&
      normalizeForScheduleComparison(stripTrailingPunct(step)) === normalizedSchedule;
    const isDeliveryDirective = opts.actionType === 'notify' && isNotifyOnlyStepText(step);
    if (isScheduleOnlyStepText(step) || matchesProposalSchedule || isDeliveryDirective) {
      dropped.push(step);
    } else {
      kept.push(step);
    }
  }
  return { steps: kept, dropped };
}

/** Type-check → trim → drop-if-empty → cap. Anything that isn't a plain
 *  non-empty string simply doesn't exist as far as the merge is concerned. */
function readValidatedString(
  rec: Record<string, unknown>,
  key: keyof Omit<AgentConversationalExtraction, 'autonomousIntent' | 'steps'>,
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
 *  entirely readValidatedString + mergeConversationalExtractionIntoDraft).
 *
 *  Phase 4 deliberately did NOT add `webhookUrl` / `cliCommand` here.
 *  parseConversationalTurnResponse takes no context and therefore cannot see
 *  the allowHighRiskActions flag, so anything added to this list would loosen
 *  proposal-recognition for EVERY user, flag or no flag. A real high-risk
 *  proposal always carries name/prompt/actionType alongside its URL or command
 *  and so already clears MIN_SCHEMA_KEY_MATCHES on the pre-existing keys; a
 *  bare `{"webhookUrl": ...}` blob stays a 'question', which is the harmless
 *  direction (the conversation simply continues).
 *
 *  Phase 6 leaves `steps` out for the same reason. A genuine multi-step
 *  proposal always carries name/prompt/actionType/scheduleText alongside its
 *  step list and so already clears MIN_SCHEMA_KEY_MATCHES on those; adding
 *  `steps` here would only make a mid-conversation `{"steps": [...], "name":
 *  ...}` musing — the exact shape a model produces while thinking out loud
 *  about how to break a task down — get mistaken for a final answer. */
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
    // Phase 4. Read unconditionally — this function has no context and so no
    // notion of the flag. Reading is inert on its own: with
    // allowHighRiskActions off, mergeConversationalExtractionIntoDraft never
    // looks at either field (and rejects the 'webhook'/'cli' actionType that
    // would have carried them) exactly as it did in Phase 0-3.
    webhookUrl: readValidatedString(rec, 'webhookUrl'),
    cliCommand: readValidatedString(rec, 'cliCommand'),
    // browser-pane (2026-08-05). Read unconditionally, same as webhookUrl/
    // cliCommand above: reading is inert — every acceptance decision
    // (verbatim-transcript match, kind whitelist, URL validity) lives in
    // mergeConversationalExtractionIntoDraft's browser-pane branch.
    browserActionKind: readValidatedString(rec, 'browserActionKind'),
    browserUrl: readValidatedString(rec, 'browserUrl'),
    browserSelector: readValidatedString(rec, 'browserSelector'),
    // Phase 6. `undefined` when the key is absent or not an array at all, so a
    // model that answers `"steps": null` / `"steps": "調べて投稿する"` is treated
    // as "said nothing about steps" rather than as a rejected proposal.
    steps: readValidatedSteps(rec['steps']),
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
 *  alongside its own success.
 *
 *  'browser-pane' (2026-08-05) is in the BASE set — not behind Phase 4's
 *  allowHighRiskActions opt-in — on three grounds, none of which is "it is
 *  low risk": (1) both strings it needs (URL, CSS selector) are individually
 *  gated by requireVerbatimSubstringMatch against the user's own transcript,
 *  the same anti-hallucination primitive webhook/cli use, so the model can
 *  only relay, never originate, a target; (2) the registration it produces
 *  can NEVER skip the human confirm reply (shouldUseChatConfirm routes it to
 *  chat-confirm while isAutoRegisterEligibleOnChatConfirm excludes it — see
 *  lib/agent-plan-summary.ts — and this merge always stamps llmExtracted);
 *  (3) at fire time the action type is attended-only with NO unattended
 *  carve-out and is never auto-accepted even when attended, with the
 *  allowlist re-checked before dispatch AND inside the injected page script
 *  (store/types.ts's browserPaneAction doc comment). webhook/cli stay behind
 *  the opt-in because their fire-time surface is categorically wider (any
 *  host / a shell); browser-pane's is a closed 3-op set inside one on-screen
 *  WebView the user is watching. */
const ALLOWED_ACTION_TYPES = new Set(['draft', 'notify', 'social-post', 'browser-pane']);

/** Phase 4's opt-in superset. Built once from ALLOWED_ACTION_TYPES so the two
 *  can never drift, and selected per call — NOT by mutating the base set,
 *  which would leak one caller's opt-in into every other caller's merge. */
const HIGH_RISK_ALLOWED_ACTION_TYPES = new Set([...ALLOWED_ACTION_TYPES, 'webhook', 'cli']);

/**
 * Phase 4's single new safety primitive: "did the user really say this?"
 *
 * Returns true only when `candidate` — after trimming ITS OWN surrounding
 * whitespace and nothing else — occurs as a literal, case-sensitive substring
 * of `userTranscriptText`.
 *
 * The point is structural, not heuristic. A language model asked for a webhook
 * URL or a shell command will happily produce a plausible one out of thin air;
 * `https://example.com/hook` and `curl -X POST ...` are exactly the shapes a
 * model reaches for when it wants to look helpful. Requiring the string to be
 * physically present in what the human typed removes the model's ability to
 * ORIGINATE such a value at all — it can only ever relay one.
 *
 * Deliberately NOT normalized beyond the candidate's own trim:
 *
 *   - Case is significant. `example.COM/Hook` is a different host+path than
 *     `example.com/hook` in the general case, and a matcher that shrugs at case
 *     is a matcher an attacker can steer.
 *   - Interior whitespace is significant. Collapsing runs of spaces would make
 *     `rm  -rf /tmp/x` match a transcript containing `rm -rf /tmp/x` — and, far
 *     worse, would let a model splice a command out of loose words that the
 *     user never wrote as a command.
 *   - `userTranscriptText` is not touched at all. Trimming or normalizing the
 *     haystack can only ever create matches that the raw text did not have.
 *
 * Every relaxation of this function makes hallucination easier, so the bias is
 * to be stricter than necessary: a false negative costs the user one retype, a
 * false positive registers an action they never asked for.
 *
 * The empty candidate is rejected explicitly. JavaScript's
 * `'anything'.includes('')` is `true`, so a model that emitted `"webhookUrl":
 * ""` would otherwise "match" every transcript ever written — the exact
 * fail-OPEN trap this whole gate exists to avoid.
 *
 * Scope note: this answers ONLY "is this the user's own string". It says
 * nothing about whether the string is safe to send or run, and Phase 4 changes
 * none of the machinery that decides that — SHELLY_WEBHOOK_HOST_ALLOWLIST,
 * lib/command-safety.ts, the capability broker and the per-run approval tap all
 * still apply unconditionally to an action registered through Tier 3, exactly
 * as they do to one authored by hand.
 */
export function requireVerbatimSubstringMatch(candidate: string, userTranscriptText: string): boolean {
  if (typeof candidate !== 'string' || typeof userTranscriptText !== 'string') return false;
  const needle = candidate.trim();
  if (!needle) return false;
  // An absent/empty transcript can therefore never satisfy anything: the
  // caller omitting it fails CLOSED, it does not wave the check through.
  if (!userTranscriptText) return false;
  return userTranscriptText.includes(needle);
}

/**
 * Merge one LLM proposal into `draft` under the same per-field gates
 * lib/agent-llm-fallback.ts's mergeLlmExtractionIntoDraft uses, and in the same
 * ORDER (the order encodes safety decisions, see the platformHint block).
 *
 *   - scheduleText: re-validated through parseSchedule(); applied only when
 *     that comes back `confident`. The model never authors a cron.
 *   - actionType: only 'draft' | 'notify' | 'social-post' | 'browser-pane' —
 *     plus 'webhook' | 'cli' when ctx.allowHighRiskActions is explicitly true
 *     (Phase 4). 'browser-pane' (2026-08-05) is applied only when its kind is
 *     'click'/'extractText' AND both browserUrl and browserSelector pass
 *     requireVerbatimSubstringMatch — see applyBrowserPaneAction and
 *     ALLOWED_ACTION_TYPES' doc comment for why it needs no opt-in flag.
 *     'notify' is applied only as an upgrade FROM 'draft'; a redundant 'draft'
 *     is a silent no-op (and never downgrades an already-resolved richer
 *     action); 'social-post' is ALWAYS a no-op here and only ever takes effect
 *     via platformHint below. Anything else is dropped and recorded in
 *     rejectedFields.
 *   - webhookUrl / cliCommand (Phase 4, gated): applied only when the opt-in
 *     flag is on AND requireVerbatimSubstringMatch finds the exact string in
 *     ctx.userTranscriptText AND the action is still 'draft'. Any of those
 *     failing records the FIELD name (not 'actionType' — the type itself was
 *     legitimately declared, only its payload was refused) and changes nothing,
 *     mirroring how an unresolvable platformHint is handled.
 *   - platformHint: resolved by resolvePlatformHintConnector() against REAL
 *     registered connectors; applied only on a UNIQUE match, and only while the
 *     action is still 'draft'. Zero or 2+ matches change nothing.
 *   - autonomousIntent: stored as `llmAutonomousIntent` ONLY. It NEVER touches
 *     `draft.autonomous` — only a human answer (or the explicit
 *     `@agent autonomous` alias) ever sets that.
 *   - outputPath: only meaningful while the action is still 'draft'.
 *   - prompt: also re-derives tool/toolLabel via suggestTool(), keeping tool
 *     routing consistent with the (now more accurate) task description.
 *   - steps (Phase 6): applied only when 2+ entries survive validation, and
 *     only ever as PLAIN instruction strings run through the same
 *     detectApiCallSteps() the deterministic Tier 1 parser uses. 0 entries is a
 *     no-op; 1 entry is recorded as a rejection and leaves any existing
 *     deterministic orchestrationSteps untouched. Grants nothing — see the
 *     field's doc comment on AgentConversationalExtraction.
 *
 * Returns the ORIGINAL `draft` object by reference — not a copy, and without
 * `llmExtracted` — when nothing was both present and valid. Callers rely on
 * that referential identity to detect "the model gave us nothing usable".
 */
export function mergeConversationalExtractionIntoDraft(
  draft: ParsedAgentDraft,
  extraction: AgentConversationalExtraction,
  ctx: {
    connectors: SocialConnectorMeta[];
    /** Phase 4: when true, 'webhook'/'cli' become LLM-authorable action types
     *  (still gated per-field by requireVerbatimSubstringMatch below). When
     *  false/absent (default), behavior is BYTE-IDENTICAL to before this
     *  phase — webhook/cli remain rejected exactly as Phase 0-3 did. */
    allowHighRiskActions?: boolean;
    /** Phase 4: concatenated raw text of every message the USER (never the
     *  LLM) actually typed since this Tier 3 session began, including the
     *  opening "@agent ..." utterance. Required (defaults to '' if omitted)
     *  for the verbatim check to have anything to check against — an empty
     *  string can never satisfy requireVerbatimSubstringMatch for any
     *  non-empty candidate, so an omitted transcript fails closed. */
    userTranscriptText?: string;
  },
): MergeConversationalResult {
  let merged: ParsedAgentDraft = draft;
  let touched = false;
  const rejectedFields: string[] = [];
  const next = () => {
    if (merged === draft) merged = { ...draft };
    return merged;
  };
  // `=== true` on purpose: only an explicit opt-in unlocks anything. Any other
  // value (undefined, a truthy string smuggled in from persisted settings, ...)
  // keeps the Phase 0-3 set.
  const highRiskAllowed = ctx.allowHighRiskActions === true;
  const allowedActionTypes = highRiskAllowed
    ? HIGH_RISK_ALLOWED_ACTION_TYPES
    : ALLOWED_ACTION_TYPES;
  const userTranscriptText = ctx.userTranscriptText ?? '';

  /** Phase 4's promotion path, shared by webhook and cli because the two
   *  differ only in which AgentAction field carries the string. Every refusal
   *  records the FIELD (never 'actionType') and leaves the draft untouched. */
  const applyHighRiskAction = (
    fieldName: 'webhookUrl' | 'cliCommand',
    candidate: string | undefined,
    build: (value: string) => AgentAction,
  ) => {
    // Declaring the type without supplying its payload is a no-op, exactly
    // like a bare 'social-post' declaration: nothing was refused, so nothing
    // is recorded and the conversation can still supply it later.
    if (!candidate) return;
    if (!requireVerbatimSubstringMatch(candidate, userTranscriptText)) {
      // THE hallucination guard. The model produced a URL/command that does
      // not appear in anything the human typed, so it was invented — drop it.
      // Never logged in full: a hallucinated string is still untrusted input.
      rejectedFields.push(fieldName);
      logInfo(
        LOG,
        `${fieldName} (${candidate.trim().length} chars) does not appear verbatim in the user's own ` +
          `messages (transcript=${userTranscriptText.length} chars) — dropped as hallucinated`,
      );
      return;
    }
    if (draft.action.type !== 'draft') {
      // Same one-shot discipline as the platformHint block: an action that has
      // already resolved to something richer is never overwritten.
      rejectedFields.push(fieldName);
      logInfo(
        LOG,
        `${fieldName} ignored — action is already '${draft.action.type}', not 'draft'`,
      );
      return;
    }
    const m = next();
    // The TRIMMED value is what was verified, so the trimmed value is what is
    // stored — never the raw candidate.
    m.action = build(candidate.trim());
    m.actionCaveat = undefined;
    touched = true;
    logInfo(LOG, `${fieldName} matched the user's own words verbatim — action promoted`);
  };

  /** browser-pane (2026-08-05). Same shape as applyHighRiskAction above but
   *  with TWO verbatim-gated strings (URL + selector) and a closed kind
   *  whitelist, and always available (see ALLOWED_ACTION_TYPES' doc comment
   *  for why no allowHighRiskActions opt-in applies here). Every refusal
   *  records the specific FIELD that failed and leaves the draft untouched —
   *  there is deliberately NO partial application: a browser-pane action
   *  either arrives complete (kind + verbatim URL + verbatim selector) or
   *  not at all, so a hallucinated half can never ride along with a real
   *  half. */
  const applyBrowserPaneAction = () => {
    const kind = extraction.browserActionKind;
    const urlCandidate = extraction.browserUrl;
    const selectorCandidate = extraction.browserSelector;
    // Declaring the type with no payload at all is a no-op, exactly like a
    // bare 'social-post' declaration: nothing was refused, and the
    // conversation (or Tier 2 slot-fill) can still supply the halves later.
    if (!kind && !urlCandidate && !selectorCandidate) return;
    if (kind !== 'click' && kind !== 'extractText') {
      // 'fill' included on purpose: its free-form value is not NL-authorable
      // this pass (hand-edited JSON keeps owning it).
      rejectedFields.push('browserActionKind');
      logInfo(LOG, `browserActionKind ${JSON.stringify(kind ?? '(missing)')} is not an NL-authorable browser operation — dropped`);
      return;
    }
    if (!urlCandidate || !requireVerbatimSubstringMatch(urlCandidate, userTranscriptText)) {
      // THE hallucination guard, same as applyHighRiskAction's: a URL the
      // human never typed was invented by the model — drop the whole action.
      rejectedFields.push('browserUrl');
      logInfo(
        LOG,
        `browserUrl (${(urlCandidate ?? '').trim().length} chars) does not appear verbatim in the user's own ` +
          `messages (transcript=${userTranscriptText.length} chars) — dropped as hallucinated`,
      );
      return;
    }
    if (!selectorCandidate || !requireVerbatimSubstringMatch(selectorCandidate, userTranscriptText)) {
      rejectedFields.push('browserSelector');
      logInfo(
        LOG,
        `browserSelector (${(selectorCandidate ?? '').trim().length} chars) does not appear verbatim in the ` +
          `user's own messages (transcript=${userTranscriptText.length} chars) — dropped as hallucinated`,
      );
      return;
    }
    // Verbatim passed — NOW normalize deterministically (https default,
    // http(s)-only, no credentials/hash), the same normalizer Tier 1 uses.
    const normalizedUrl = normalizeBrowserPaneUrl(urlCandidate.trim());
    if (!normalizedUrl) {
      rejectedFields.push('browserUrl');
      logInfo(LOG, 'browserUrl matched the transcript but is not a valid http(s) allowlist entry — dropped');
      return;
    }
    if (draft.action.type !== 'draft') {
      // One-shot discipline, mirroring platformHint/applyHighRiskAction: an
      // action that already resolved to something richer is never overwritten.
      rejectedFields.push('browserUrl');
      logInfo(LOG, `browser-pane ignored — action is already '${draft.action.type}', not 'draft'`);
      return;
    }
    const m = next();
    const selector = selectorCandidate.trim();
    m.action = {
      type: 'browser-pane',
      browserPaneAction:
        kind === 'click' ? { kind: 'click', selector } : { kind: 'extractText', selector },
      browserPaneUrlAllowlist: [normalizedUrl],
    };
    m.actionCaveat = undefined;
    touched = true;
    logInfo(LOG, `browser-pane ${kind} accepted — URL and selector matched the user's own words verbatim`);
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
      // 2026-08-03 on-device bug (「20時00分に」が延々と聞き直される): a bare
      // time can complete a recurrence the draft ALREADY knows — Tier 2's
      // applySlotAnswer has combined the two across turns since day one, but
      // this Tier 3 merge just dropped the whole thing, structurally
      // guaranteeing the schedule question got re-asked for an answer the
      // rest of the pipeline would have accepted. Same shared helper, same
      // conservative contract: NO recurrence context on the draft → no
      // combination (a bare time stays ambiguous between once and daily —
      // never unconditionally converted).
      const combined = combinePartialScheduleWithDraft(draft, sched);
      if (combined) {
        const m = next();
        m.schedule = combined.schedule;
        m.scheduleConfident = true;
        m.scheduleLabel = combined.scheduleLabel;
        m.suggestedTime = combined.suggestedTime;
        if (combined.suggestedDowList) m.suggestedDowList = combined.suggestedDowList;
        m.scheduleAssumed = undefined;
        touched = true;
        logInfo(
          LOG,
          `scheduleText ${JSON.stringify(extraction.scheduleText)} combined with the draft's known ` +
            `recurrence -> ${combined.scheduleLabel}`,
        );
      } else {
        rejectedFields.push('scheduleText');
        // Keep whatever PARTIAL signal the phrase carried (a bare time, a
        // frequency with no time, a weekday list) on the draft — mirrors
        // applySlotAnswer's own not-resolved branch — so a LATER turn's
        // complementary half can complete it instead of starting from zero.
        // Only fields the parse actually produced are written; an existing
        // hint is never clobbered with undefined.
        if (sched.suggestedTime || sched.suggestedFrequency || sched.suggestedDowList) {
          const m = next();
          if (sched.suggestedTime) m.suggestedTime = sched.suggestedTime;
          if (sched.suggestedFrequency) m.suggestedFrequency = sched.suggestedFrequency;
          if (sched.suggestedDowList) m.suggestedDowList = sched.suggestedDowList;
          touched = true;
        }
        logInfo(
          LOG,
          `scheduleText ${JSON.stringify(extraction.scheduleText)} did not parse to a confident cron — dropped`,
        );
      }
    }
  }

  if (extraction.actionType !== undefined) {
    if (!allowedActionTypes.has(extraction.actionType)) {
      // The security-critical branch: a model that proposes 'app-act' /
      // 'api-call' / 'intent' / 'dm-reply' (or invents a type name) gets it
      // dropped here, never merged — and so do 'webhook' / 'cli' unless the
      // caller explicitly opted in via ctx.allowHighRiskActions.
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
    } else if (highRiskAllowed && extraction.actionType === 'webhook') {
      // Phase 4. Reachable ONLY with the opt-in flag on — without it,
      // 'webhook' fails the allowlist check above and never gets here.
      applyHighRiskAction('webhookUrl', extraction.webhookUrl, (webhookUrl) => ({
        type: 'webhook',
        webhookUrl,
      }));
    } else if (highRiskAllowed && extraction.actionType === 'cli') {
      applyHighRiskAction('cliCommand', extraction.cliCommand, (command) => ({
        type: 'cli',
        command,
      }));
    } else if (extraction.actionType === 'browser-pane') {
      // browser-pane (2026-08-05): always reachable (base allowlist, no
      // opt-in flag) — but only ever applied when BOTH payload strings pass
      // the verbatim-transcript gate inside applyBrowserPaneAction.
      applyBrowserPaneAction();
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
    //   - 'webhook'/'cli' when the opt-in flag is OFF never reach here at all
    //     (they fail the allowlist check and are recorded as rejections); when
    //     it is ON with no payload proposed, applyHighRiskAction returns
    //     without touching anything, the same shape of no-op as 'social-post'.
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

  // Phase 6 (2026-08-03): multi-step. Placed last because it is
  // order-independent — it reads nothing this function has already decided and
  // writes only `orchestrationSteps`, a field no other branch here touches.
  //
  // This is the SAME field lib/agent-nl-parser.ts's Tier 1 parser fills, run
  // through the SAME tagStepsWithToolMentions() -> detectApiCallSteps() pipeline
  // (2026-08-03, Phase 7 — previously only detectApiCallSteps ran here, which
  // silently broke the system prompt's own promise that "the system decides"
  // per-step tool routing: a step whose text named a real tool, e.g. "Perplexity
  // で調べて", was never tagged, so it just inherited the agent-level tool like
  // every other step, and a review caught it), so everything downstream (the
  // confirm card's step list, draftToConfirmedAgentDraft, the PlanSpec's
  // additive `steps`, and — once resolveForAutonomous vets it at plan-build
  // time, see lib/agent-plan-spec.ts — the unattended PlanSpec executor) works
  // on a Tier 3 draft exactly as it already does on a Tier 1 one. Nothing new
  // is authorized: matchToolMention() only ever returns one of a fixed set of
  // NAMED tools (Perplexity/local/Codex/Gemini — see TOOL_MENTIONS in
  // lib/agent-orchestration.ts), never an arbitrary value the model invented,
  // and whether a given step may actually USE that tool unattended is still
  // decided — unchanged — by resolveForAutonomous + the orchestration
  // executor's own gates, not by this merge.
  if (Array.isArray(extraction.steps)) {
    const rawValidSteps = readValidatedSteps(extraction.steps) ?? [];
    // 2026-08-03 (agent-msd4bkjt): deterministic sanitize BEFORE the chain
    // gate — the model re-listed the schedule fragment (「20時00分に」) and
    // the delivery directive (「通知して」) as work steps. See
    // sanitizeConversationalSteps' doc comment; MIN_ORCHESTRATION_STEPS below
    // is applied to the SANITIZED list, so a list that shrinks under 2 falls
    // back to the ordinary single-prompt agent instead of a bogus chain.
    const { steps: validSteps, dropped: droppedSteps } = sanitizeConversationalSteps(rawValidSteps, {
      scheduleText: extraction.scheduleText,
      actionType: merged.action.type,
    });
    if (droppedSteps.length > 0) {
      logInfo(
        LOG,
        `steps sanitize dropped ${droppedSteps.length} schedule/delivery fragment(s) out of ` +
          `${rawValidSteps.length} proposed`,
      );
    }
    if (validSteps.length >= MIN_ORCHESTRATION_STEPS) {
      const m = next();
      m.orchestrationSteps = detectApiCallSteps(tagStepsWithToolMentions(validSteps));
      touched = true;
      logInfo(LOG, `steps applied -> ${validSteps.length} orchestration step(s)`);
    } else if (extraction.steps.length > 0) {
      // A 1-entry list (or a list whose entries were all blank/non-strings) is
      // not a chain. Recorded as a rejection because the model DID propose
      // something here and it was refused — but deliberately NOT destructive:
      // any orchestrationSteps the deterministic Tier 1 parse already found
      // stay exactly as they were, and the agent simply remains the ordinary
      // single-prompt agent it was.
      rejectedFields.push('steps');
      logInfo(
        LOG,
        `steps proposed ${extraction.steps.length} entr(y|ies) but only ${validSteps.length} usable ` +
          `(< ${MIN_ORCHESTRATION_STEPS}) — not a multi-step agent, dropped`,
      );
    }
    // An explicitly empty `[]` — what the prompt asks for on a single-step
    // request — is neither applied nor rejected. Nothing was refused.
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
      if (result.success && acc.trim()) {
        logInfo(LOG, 'runConversationalRegistrationTurn: Cerebras turn succeeded');
        return { success: true, raw: acc, provider: 'cerebras' };
      }
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
      if (result.success && acc.trim()) {
        logInfo(LOG, 'runConversationalRegistrationTurn: Groq turn succeeded');
        return { success: true, raw: acc, provider: 'groq' };
      }
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
    return { success: true, raw: result.content, provider: 'local' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logInfo(LOG, `runConversationalRegistrationTurn threw: ${error}`);
    return { success: false, error };
  }
}
