/**
 * lib/agent-escalation-ladder.ts — ③b-2 capability-escalation ladder (pure core).
 *
 * When a backend can't actually produce a real answer (local server can't start /
 * model not installed / ctx overflow / API 429 / missing key / run error), the
 * agent ESCALATES to the next allowed backend instead of dead-ending on a
 * local-context digest. This module is pure + offline + unit-tested; the run loop
 * (agent-manager) drives it.
 *
 * SECURITY — the autonomous boundary is never widened here:
 *   - secret-guard match  → ladder is on-device ONLY, no climb (noEscalation).
 *   - manual pin          → the user's explicit choice stands, no climb.
 *   - autonomous (unattended) → ladder is local → Codex(OAuth) ONLY; every
 *     api-key backend (Cerebras/Groq/Perplexity/Gemini) is dropped via
 *     resolveForAutonomous (fail-closed). secret-guard still force-blocks cloud.
 *   - attended (a human is approving) → local → free cloud (Cerebras/Groq, only
 *     if keyed) → Codex(last, quota-preserving). Domain primary (academic→
 *     Perplexity / image→Gemini, chosen upstream) is tried first.
 * Defense in depth: the run loop re-resolves the route per attempt, so even if a
 * cloud tool reached the loop for a secret/autonomous agent, resolveAgentRoute /
 * resolveForAutonomous would still force it back to local / refuse it.
 */
import { Agent, AgentRouteDecision, ToolChoice } from '@/store/types';
import { resolveAgentRoute } from './agent-tool-router';
import { resolveForAutonomous } from './agent-credential-policy';
import { detectRouteSignals } from './agent-router-scoring';

export interface LadderEnv {
  /** Cerebras free-tier key present (Settings → API Keys). */
  hasCerebrasKey: boolean;
  /** Groq free-tier key present. */
  hasGroqKey: boolean;
  /**
   * Perplexity / Gemini key present. Optional: absent means UNKNOWN and is
   * treated as present (conservative — a usable backend is never wrongly
   * skipped; a keyless one just fails-and-escalates as before). When known
   * false, the ladder preflight drops the keyless candidate so the run never
   * wastes an attempt on a backend that cannot authenticate.
   */
  hasPerplexityKey?: boolean;
  hasGeminiKey?: boolean;
  /**
   * N1: the user gave informed consent for autonomous agents to use cloud API
   * keys (Gemini/Perplexity) UNATTENDED on web-mandatory tasks. Default OFF →
   * fail-closed (autonomous web stays Codex-only). secret-guard still wins.
   */
  autonomousCloudConsent?: boolean;
  /**
   * N1: on cloud quota exhaustion (429) for an autonomous web task, 'stop' halts
   * at the free tier instead of climbing to Codex/paid. Default (false) =
   * escalate to Codex.
   */
  autonomousCloudStop?: boolean;
}

export interface EscalationLadder {
  /** Ordered candidates; [0] is the primary, the rest are escalation steps. */
  tools: ToolChoice[];
  /** secret-guard / manual-pin → a single attempt, never climb. */
  noEscalation: boolean;
  guard: AgentRouteDecision['guard'];
  why: string;
}

const LOCAL: ToolChoice = { type: 'local' };
const CODEX: ToolChoice = { type: 'cli', cli: 'codex' };
const GEMINI: ToolChoice = { type: 'gemini-api' };
const PERPLEXITY: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };

/** Identity for dedupe — local is tier-agnostic (the shell does installed-aware). */
function toolKey(t: ToolChoice): string {
  if (t.type === 'cli') return `cli:${t.cli}`;
  if (t.type === 'local') return 'local';
  return t.type;
}

/**
 * Key preflight (G4 P1): is this tool's API key known to be MISSING? Unknown
 * (env field absent) counts as present so we only skip when certain.
 */
function keyKnownMissing(tool: ToolChoice, env: LadderEnv): boolean {
  if (tool.type === 'perplexity') return env.hasPerplexityKey === false;
  if (tool.type === 'gemini-api') return env.hasGeminiKey === false;
  if (tool.type === 'cerebras') return !env.hasCerebrasKey;
  if (tool.type === 'groq') return !env.hasGroqKey;
  return false;
}

function dedupe(tools: ToolChoice[]): ToolChoice[] {
  const seen = new Set<string>();
  const out: ToolChoice[] = [];
  for (const t of tools) {
    const k = toolKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Build the ordered escalation ladder for an agent. Pure: the same agent + env
 * always yields the same ladder.
 *
 * `routeTextOverride` (2026-08-03 on-device bug, DEFERRED.md「オーケストレーション
 * のステップ実行が合成プロンプト全文でルーティング判定され偽の成功通知に至る」):
 * an orchestration step's `agent.prompt` is the COMPOSED text buildStepPrompt
 * produced — base prompt + every prior step's full result + this step's
 * instruction. Judging needsWeb / the auto scorer against that composite means
 * a pure transform step ("ローカルLLMで要約する") inherits the freshness/
 * collection keywords of the PREVIOUS step's collected news text, gets
 * misclassified as web-mandatory, and escalates to Perplexity/Gemini — which
 * then misread the composite as a research question and "succeed" with an
 * unrelated essay (a real fake-success notification reached the user on
 * device). Callers running a chained step pass the step's OWN raw instruction
 * here so routing reflects what THIS step is, while `agent.prompt` (what is
 * actually sent to the chosen tool) keeps the full composed context it needs.
 * Absent/blank → falls back to `agent.prompt`, byte-identical to the old
 * behavior for every non-orchestrated caller.
 */
export function resolveEscalationLadder(
  agent: Agent,
  env: LadderEnv,
  routeTextOverride?: string,
): EscalationLadder {
  // NOTE: the override deliberately does NOT weaken any safety gate — the
  // secret-guard scan inside resolveAgentRoute still runs over the FULL agent
  // text (including the composed prompt actually sent to the backend), and the
  // autonomous/manual-pin hard stops below are prompt-independent.
  const routeText = routeTextOverride && routeTextOverride.trim() ? routeTextOverride : agent.prompt;
  const { tool: primary, decision } = resolveAgentRoute(agent, routeText);

  // Hard stops — a single attempt, never climb to cloud.
  if (decision.guard === 'secret' || decision.guard === 'manual-pin') {
    return { tools: [primary], noEscalation: true, guard: decision.guard, why: decision.why };
  }

  // Web-mandatory task (collect CURRENT info): only a live web fetch satisfies
  // it. EXCLUDE non-web backends (local / Cerebras / Groq) — they would only
  // hallucinate a plausible template and report a fake success. Web-capable
  // backends only: Gemini(grounded) for general / Perplexity for academic, then
  // Codex (danger-full-access shell) as the net fallback.
  const web = detectRouteSignals(routeText);
  if (web.needsWeb) {
    // 2026-08-03 on-device bug (「なんでパープレじゃなくてこれ(Gemini)なんだっけ？」):
    // when the agent/step is EXPLICITLY pinned to a web backend (guard
    // 'configured-tool' + perplexity/gemini-api — e.g. an orchestration step 0
    // saying "パープレキシティで最新のAIニュースを集めて" carrying a
    // {type:'perplexity'} pin), resolveAgentRoute already honored that pin as
    // `primary`, but this branch used to IGNORE it and re-pick mechanically by
    // webDomain — a TOPIC classification (ACADEMIC_WEB_KW: 研究/論文/paper/…)
    // that has nothing to do with which tool the user named. "AIニュース" has
    // no academic keyword → webDomain 'general' → Gemini, silently overriding
    // the user's explicit Perplexity choice. Fix: an explicit WEB-tool pin wins
    // over the webDomain heuristic; webDomain remains the fallback for 'auto' /
    // scored / autonomous-policy routes (no explicit pin). A pin to a NON-web
    // backend (local/cerebras/groq/cli) stays excluded exactly as before — it
    // would only hallucinate — so this deliberately does NOT widen what a pin
    // can force onto a web-mandatory task, and the consent/keyKnownMissing
    // safety gates below apply to the pinned tool unchanged.
    const explicitWebToolPin =
      decision.guard === 'configured-tool' && (primary.type === 'perplexity' || primary.type === 'gemini-api')
        ? primary
        : null;
    const chosenWeb = explicitWebToolPin ?? (web.webDomain === 'academic' ? PERPLEXITY : GEMINI);
    const chosenWebName = chosenWeb.type === 'perplexity' ? 'Perplexity' : 'Gemini';
    const chosenWebLabel = chosenWeb.type === 'perplexity' ? 'Perplexity' : 'Gemini (grounded)';
    const pinNote = explicitWebToolPin ? ' (explicitly configured)' : '';
    if (agent.autonomous) {
      // N1: with the user's informed consent, an autonomous web task may use the
      // keyed web backend (Gemini grounded / Perplexity) unattended — the key
      // authenticates the request and never reaches the model. On quota
      // exhaustion (429) the ladder climbs to Codex unless 'stop' is set, which
      // halts at the free tier rather than burning Codex/paid quota.
      if (env.autonomousCloudConsent) {
        const consented = chosenWeb;
        // Key preflight: consent without the backend's key cannot work — fall
        // through to the fail-closed no-consent path (Codex/OAuth only) instead
        // of wasting the run on an unauthenticated request. 'stop' only governs
        // 429 quota exhaustion, not a missing key, so it doesn't keep a dead
        // keyless backend in the ladder.
        if (!keyKnownMissing(consented, env)) {
          const tools = env.autonomousCloudStop ? [consented] : [consented, CODEX];
          return {
            tools,
            noEscalation: false,
            guard: decision.guard,
            why: `Web-mandatory ${web.webDomain} task; autonomous cloud opt-in → ${chosenWebLabel}${pinNote}${env.autonomousCloudStop ? ' (stop at free tier on 429)' : ' → Codex on 429'}.`,
          };
        }
      }
      // No consent (fail-closed): api-key web backends are excluded, so the only
      // web-capable option is Codex (OAuth shell). Distinguish the keyless
      // consented case in the why — "enable cloud opt-in" would misdiagnose it.
      const why = env.autonomousCloudConsent
        ? `Web-mandatory task; cloud opt-in is on but the ${chosenWebName} key is not configured → Codex only.`
        : 'Web-mandatory task; autonomous policy → Codex only (enable cloud opt-in for Gemini/Perplexity).';
      return { tools: [CODEX], noEscalation: false, guard: decision.guard, why };
    }
    const webPrimary = chosenWeb;
    // Key preflight: a keyless web primary can't authenticate — go straight to
    // Codex (web-capable via its shell) instead of burning an attempt. Local /
    // Cerebras / Groq stay excluded (they would hallucinate a template).
    if (keyKnownMissing(webPrimary, env)) {
      return {
        tools: [CODEX],
        noEscalation: false,
        guard: decision.guard,
        why: `Web-mandatory ${web.webDomain} task; ${chosenWebName} key not configured → Codex directly; non-web backends excluded.`,
      };
    }
    return {
      tools: dedupe([webPrimary, CODEX]),
      noEscalation: false,
      guard: decision.guard,
      why: `Web-mandatory ${web.webDomain} task → ${chosenWebLabel}${pinNote} → Codex; non-web backends excluded.`,
    };
  }

  if (agent.autonomous) {
    // Unattended: on-device first, then Codex(OAuth). resolveForAutonomous maps
    // 'auto'→codex and drops every api-key backend, so the ladder can only ever
    // contain local + codex here.
    const tools = dedupe(
      [LOCAL, CODEX]
        .map((t) => resolveForAutonomous(t))
        .filter((t): t is ToolChoice => t !== null),
    );
    return {
      tools: tools.length ? tools : [CODEX],
      noEscalation: false,
      guard: decision.guard,
      why: decision.why,
    };
  }

  // Attended: domain/scorer primary first, then on-device, then the free cloud
  // tier (only when keyed), then Codex last to preserve its quota.
  //
  // Key preflight (G4 P1): when the AUTO scorer picked an api-key backend whose
  // key is known missing, drop it so the run degrades to local upfront instead
  // of failing an attempt on an unauthenticated request. An EXPLICITLY
  // configured tool (guard 'configured-tool') is kept even keyless — its
  // "add <KEY> to .env" error is the legible signal of the misconfiguration,
  // and the ladder still climbs past it.
  const dropKeylessPrimary = agent.tool.type === 'auto' && keyKnownMissing(primary, env);
  const ladder: ToolChoice[] = dropKeylessPrimary ? [LOCAL] : [primary, LOCAL];
  if (env.hasCerebrasKey) ladder.push({ type: 'cerebras' });
  if (env.hasGroqKey) ladder.push({ type: 'groq' });
  ladder.push(CODEX);
  const why = dropKeylessPrimary
    ? `${decision.why} (${primary.type} key not configured → degraded to on-device first.)`
    : decision.why;
  return { tools: dedupe(ladder), noEscalation: false, guard: decision.guard, why };
}

/** First line written by the shell's local_context_fallback (agent-executor.ts). */
export const LOCAL_FALLBACK_DIGEST_MARKER = '# Local Context Fallback';

/**
 * The on-device path writes a "context digest" as a successful run when it can't
 * reach a real model. That is a FAILED attempt for escalation purposes — detect
 * it so the ladder climbs instead of accepting the digest.
 */
export function isLocalFallbackDigest(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(LOCAL_FALLBACK_DIGEST_MARKER);
}

// The step-prompt scaffold (buildStepPrompt, agent-orchestration.ts) always
// opens a chained step's instruction with these headers. A weak local model
// sometimes echoes the whole prompt back instead of answering it — observed
// on-device: Qwen 0.8B/2B regurgitating "# Results from previous steps ...
// # This step ..." verbatim, then tacking on a refusal. That is never usable
// content, least of all for a public-posting action type like social-post.
// Regex (not plain substring) because the shell's clean_result_preview()
// whitespace-collapses the run preview (tr '\n' ' ') before this ever sees
// it, so a literal '\n' in a marker would never match a real preview.
const PROMPT_ECHO_MARKERS = [/#\s*Results from previous steps/, /#\s*This step\b/];

/**
 * Small-model meta-commentary/refusal phrases: the response talks ABOUT the
 * task instead of doing it (e.g. "As an AI, I cannot generate a literal
 * post..."). Matched loosely (EN + JA) since exact phrasing varies by model.
 */
const REFUSAL_PATTERNS = [
  /\bas an ai\b/i,
  /\bi cannot generate\b/i,
  /\bi'm (?:not able|unable) to\b/i,
  /私は\s*ai\s*(なので|として)/i,
  /(生成|投稿)できません/,
];

/**
 * "Honest failure to retrieve the requested data" phrases (2026-07-23
 * on-device finding, DEFERRED.md "バッテリー残量など端末システム情報の取得に
 * ネイティブAPIブリッジが無い" §根本原因(2)): a battery-notify agent's Codex
 * backend correctly explained it had no way to read the device's battery
 * level, rather than echoing the prompt or refusing outright — so neither
 * PROMPT_ECHO_MARKERS nor REFUSAL_PATTERNS caught it, and the run was logged
 * `success` (with a "Save as skill?" offer on top). This is a real failure to
 * deliver the requested information and must escalate the same way.
 *
 * Deliberately narrower than REFUSAL_PATTERNS: "could not retrieve/access …"
 * is common enough phrasing that it CAN legitimately appear once inside an
 * otherwise-substantive answer (e.g. a research summary noting one unrelated
 * sub-detail was unavailable). Gated by DATA_UNAVAILABLE_MAX_LEN below on the
 * whole completion being short — i.e. the phrase plausibly IS the answer,
 * not a passing remark inside a much longer one.
 */
const DATA_UNAVAILABLE_PATTERNS = [
  /取得できません/,
  /アクセスできず/,
  /アクセスできません/,
  /\bcould not (?:retrieve|access|obtain|fetch)\b/i,
  /\bcouldn't (?:retrieve|access|obtain|fetch)\b/i,
  /\bunable to (?:retrieve|access|obtain|fetch)\b/i,
  /\bno access to\b/i,
  /\bcannot access\b/i,
  /\bdoes not have access to\b/i,
];

/**
 * Completions at or under this length are eligible for the
 * DATA_UNAVAILABLE_PATTERNS check — chosen to comfortably cover a single
 * honest-failure sentence (the real on-device repro was ~40 JA chars / a
 * one-sentence EN equivalent) while excluding a multi-paragraph, otherwise
 * substantive answer that merely mentions one of these phrases in passing.
 */
const DATA_UNAVAILABLE_MAX_LEN = 200;

/**
 * "Meta-commentary describing the delivery action itself, instead of
 * delivering real content" (2026-07-25 on-device finding, DEFERRED.md bug
 * #158's follow-up): after fixing needsWeb routing for "notify me about the
 * news"-shaped tasks, a direct comparison test on Qwen3.5-2B (not just the
 * smaller 0.8B) showed a THIRD distinct failure mode neither
 * REFUSAL_PATTERNS nor DATA_UNAVAILABLE_PATTERNS catches: given a task with
 * no real content to report, the model announces the delivery mechanism
 * ("ニュース通知を送信します。" / "ニュース通知を完了しました。" — "I will
 * send the news notification." / "The news notification is complete.")
 * instead of either producing real content or honestly admitting it can't.
 * This reads as a plausible, on-topic completion (it correctly mentions
 * "news notification") while containing zero actual information — status
 * still logs `success`, escalation never fires, the "Save as skill?" offer
 * still appears, exactly like the two failure modes already caught above.
 *
 * Deliberately narrow and JA/EN-specific to the "[delivery-action noun] +
 * [send/complete/execute]" shape — a genuine notification's real content
 * could legitimately use words like 送信/完了/notification as part of its
 * substance, so this is NOT a bare keyword match; it requires the delivery
 * noun to be the grammatical OBJECT of a send/complete/execute verb, which
 * is specifically how a model announces its own action rather than
 * performing it. Length-gated the same way as DATA_UNAVAILABLE_PATTERNS
 * (the phrase plausibly IS the whole answer, not a passing remark).
 */
const ACTION_META_COMMENTARY_PATTERNS = [
  /(?:通知|お知らせ|メッセージ)を(?:送信します|送信しました|お送りします|お送りしました|完了します|完了しました|実行します|実行しました)/,
  /\bnotification (?:has been |is |was )?(?:sent|completed|delivered)\b/i,
  /\b(?:sending|will send|i(?:'ll| will) send) the notification\b/i,
  /\btask (?:has been |is |was )?completed\b/i,
];

/**
 * Fabricated command-execution success report (2026-07-27 on-device finding,
 * DEFERRED.md bug #162): unlike ACTION_META_COMMENTARY_PATTERNS (model
 * announces it WILL/DID send a notification, in vague present/future tense),
 * this catches a model narrating a FULLY-DETAILED FAKE execution transcript
 * in confident past tense — "Command executed: '...' Status: Success File
 * created at '...'" or a fabricated shell-prompt line
 * ("root@docker:~# printf 'test' > /sdcard/probe.txt") — for a `draft` (also
 * `notify`/`webhook`/`dm-reply`, which share this same check) action, which
 * has NO real command-execution capability at all: the model is given a
 * plain "write the content" system prompt with no tool-calling wired up.
 * Confirmed TWICE on-device with two independently-registered agents
 * ("Shell Script", "自律的シェルコマンド..."), one of them a genuinely
 * UNATTENDED scheduled fire: the claimed file was never created at the real
 * target path, only a markdown draft was saved to the app's own
 * agent-output/ sandbox containing this fabricated transcript as its
 * "content". status still logged success, no escalation fired, because
 * neither existing pattern set matches this past-tense-narrative shape.
 *
 * Deliberately requires an execution/creation claim paired closely with an
 * explicit "success" declaration (not length-gated like
 * DATA_UNAVAILABLE_PATTERNS/ACTION_META_COMMENTARY_PATTERNS — this phrase
 * combination is distinctive enough on its own): genuine instructional draft
 * content ("how to write a file: `echo x > file`") does not normally pair a
 * literal "Status: Success"/"ステータス: 成功" declaration with a command.
 */
const FABRICATED_EXECUTION_PATTERNS = [
  /\b(?:command|script)\s+(?:was\s+)?executed\b[\s\S]{0,100}\bstatus:\s*success\b/i,
  /\bstatus:\s*success\b[\s\S]{0,100}\b(?:command|script)\s+(?:was\s+)?executed\b/i,
  /\bfile\s+(?:was\s+|is\s+)?created\s+at\b[\s\S]{0,100}\bstatus:\s*success\b/i,
  /\bstatus:\s*success\b[\s\S]{0,100}\bfile\s+(?:was\s+|is\s+)?created\b/i,
  /(?:コマンド|スクリプト)を実行(?:しました|完了しました)[\s\S]{0,60}(?:成功しました|ステータス[:：]\s*成功)/,
  /(?:成功しました|ステータス[:：]\s*成功)[\s\S]{0,60}(?:コマンド|スクリプト)を実行(?:しました|完了しました)/,
  // A fabricated shell-prompt line (root@host:~# / user@host:~$) with a
  // redirect/pipe — the on-device repro's other observed shape
  // (`root@docker:~# printf 'test' > /sdcard/probe2.txt`).
  /(?:^|\n)\s*(?:root|\w+)@[\w.-]+:[^\n#$]{0,60}[#$]\s+\S[^\n]{0,120}[>|][^\n]{0,80}/,
];

/**
 * A THIRD fabricated-execution shape, found 2026-07-28 re-testing the fix
 * above on the very next build: the model's ENTIRE completion is nothing
 * but one bare shell-command line — no "Command executed"/"Status: Success"
 * narrative wrapper, no fake `user@host:` prompt, just
 * `echo "Test executed" > /sdcard/probe3.txt` verbatim as the whole
 * "content" — which Shelly's draft-save path still logs and notifies as a
 * plain `success` ("「run_shell_test」が完了しました") with zero indication
 * anything was fabricated. Neither pattern set above matches this because
 * there is no success-declaration phrase and no fake prompt prefix to
 * anchor on — it's just the command, alone.
 *
 * Distinguishing signal: a genuine instructional draft that legitimately
 * SHOWS a command as an example always has surrounding prose ("ファイルに
 * 書き込むには `echo ... > file` を使います" — see the explicit negative
 * regression test for this). A completion that, once trimmed, is ONE LINE
 * and NOTHING ELSE, starting with a common shell verb and containing actual
 * command syntax (a redirect/pipe/chain operator) is never a real "note" —
 * whether it's a fabricated execution claim or just an unexplained command
 * dump, it is not useful content for what draft/notify/webhook/dm-reply are
 * meant to produce. Length-capped (a genuinely long single "line" is not
 * this failure shape) and requires BOTH a leading command verb AND shell
 * syntax so an ordinary one-line answer that happens to contain a stray
 * "|" or ">" character is not caught.
 */
const BARE_SHELL_COMMAND_VERB_RE =
  /^(?:sudo\s+)?(?:echo|printf|cat|touch|mkdir|rm|mv|cp|curl|wget|tee|dd|chmod|chown|kill|pkill|git|npm|npx|pip3?|python3?|node|bash|sh)\b/i;
const BARE_SHELL_COMMAND_SYNTAX_RE = /[>|;&]/;

/**
 * A FOURTH fabricated-execution shape, found 2026-07-28 re-testing the v36
 * fix on the very same build: an even more degenerate completion than the
 * bare-command-line case — `> /sdcard/probe4.txt` verbatim, a redirect
 * operator and a path with NO command verb at all — still logged/notified
 * as a plain success. isBareShellCommandLine's verb requirement (echo/
 * printf/...) doesn't match because there is no verb to match. Genuine
 * prose (JA or EN) never opens with a bare `>`/`|` operator, so this is
 * safe to catch unconditionally at the start of the line.
 */
const BARE_REDIRECT_ONLY_RE = /^[>|]\s*\S/;

function isBareShellCommandLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.length > 200) return false;
  if (BARE_REDIRECT_ONLY_RE.test(trimmed)) return true;
  return BARE_SHELL_COMMAND_VERB_RE.test(trimmed) && BARE_SHELL_COMMAND_SYNTAX_RE.test(trimmed);
}

/**
 * A FIFTH fabricated-execution shape, found 2026-07-28 on-device re-testing
 * the v37 fix (bug #162 verification pass): the model wraps a MULTI-LINE
 * shell transcript in a markdown code fence with no surrounding prose at
 * all — e.g. the entire completion is:
 *   ```text
 *   cd /sdcard
 *   echo 'test' > probe_verify.txt
 *   cat probe_verify.txt
 *   ```
 * — presented (with the app's own "✅ <name>" success header) as though the
 * file write actually happened. It did not: the target file was never
 * created. isBareShellCommandLine's single-line requirement
 * (`!trimmed.includes('\n')`) does not match this shape because the fence
 * spans multiple lines, and FABRICATED_EXECUTION_PATTERNS' explicit
 * "Status: Success" / fake-prompt anchors are absent too — there is no
 * narrative wrapper, just the bare fenced commands.
 *
 * Distinguishing signal (same philosophy as isBareShellCommandLine's own
 * comment): a genuine instructional draft that legitimately shows a
 * multi-line snippet as an example always has explanatory prose outside the
 * fence ("以下のコマンドでファイルを作成できます:\n```\n...\n```"). A
 * completion whose ENTIRE trimmed content, start to finish, is nothing but
 * one fenced block is never a valid final answer for draft/notify/webhook/
 * dm-reply — and requiring at least one inner line to itself look like a
 * real shell command (reusing the same verb+syntax / bare-redirect checks
 * above) keeps this from firing on a fenced block of plain data/prose that
 * happens to use a code fence for formatting. The language tag, if present,
 * is restricted to shell-ish values (text/bash/sh/shell/console/plaintext/
 * plain/terminal or none) so a legitimate ```python``` / ```json``` code
 * answer — a normal and valid draft response — is never caught.
 */
const FENCED_BLOCK_RE = /^```(\w*)\r?\n([\s\S]*?)\r?\n?```$/;
const FENCE_SHELL_LANG_RE = /^(?:|text|bash|sh|shell|console|plaintext|plain|terminal)$/i;

function isFencedShellCommandBlock(text: string): boolean {
  const trimmed = text.trim();
  const match = FENCED_BLOCK_RE.exec(trimmed);
  if (!match) return false;
  if (!FENCE_SHELL_LANG_RE.test(match[1])) return false;
  const lines = match[2]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.some(
    (line) => BARE_REDIRECT_ONLY_RE.test(line) || (BARE_SHELL_COMMAND_VERB_RE.test(line) && BARE_SHELL_COMMAND_SYNTAX_RE.test(line)),
  );
}

/**
 * A SIXTH fabricated-execution shape, found 2026-07-28 on-device verifying the
 * FIFTH fix (versionCode 1995 / v43): the model now wraps its fake transcript
 * in a full first-person NARRATIVE — numbered 手順 headings, several fenced
 * shell blocks, and explicit self-announcements ("この依頼を履行するため、
 * 以下の手順で Shell コマンドを実行します" / "タスクを Shell コマンドで
 * 実行します" / a "実行結果の確認" section) — presented under the app's own
 * "✅" success header while the target file (/sdcard/probe_verify2.txt) was
 * never created. This deliberately sails through isFencedShellCommandBlock's
 * entire-text-is-one-fence requirement (there is plenty of surrounding prose)
 * and through ACTION_META_COMMENTARY_PATTERNS (whose JA nouns are limited to
 * 通知/お知らせ/メッセージ and which is length-gated to 200 chars — this
 * response is ~1000+ chars).
 *
 * Distinguishing signal — TWO independent conditions must BOTH hold:
 *  (1) an explicit first-person execution announcement: 「コマンド/
 *      スクリプト(を|で)…実行します/実行しました」(declarative self-claim) or
 *      the EN equivalent ("I will execute the command..."). A genuine
 *      instructional draft addresses the USER imperatively (「このコマンドを
 *      実行してください」「実行すると…」) and never claims to be executing
 *      itself, so してください/すると shapes are NOT matched; and
 *  (2) at least one fenced block (shell-ish language tag or none, ANYWHERE in
 *      the text — not only entire-text) whose inner lines include a real
 *      command line per the same verb+syntax / bare-redirect checks above.
 * Either alone is legitimate: prose announcing 実行します with no commands is
 * handled by the (length-gated) meta-commentary check; a fenced command block
 * with neutral how-to prose around it is the explicitly-protected
 * instructional-draft shape (see the negative regression test). Only the
 * combination — "I am executing this" + a command transcript, from an action
 * type with NO execution capability — is always fabricated.
 */
const EXECUTION_ANNOUNCEMENT_RE =
  /(?:コマンド|スクリプト)(?:を|で)[^\n。]{0,12}実行し(?:ます|ました)|\bi(?:'ll| will) (?:now )?(?:run|execute)\b|\bexecuting the (?:command|script)s?\b/i;
const ANY_FENCED_BLOCK_RE = /```(\w*)[^\S\n]*\r?\n([\s\S]*?)```/g;

function hasFencedShellCommandContent(text: string): boolean {
  ANY_FENCED_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANY_FENCED_BLOCK_RE.exec(text)) !== null) {
    if (!FENCE_SHELL_LANG_RE.test(match[1])) continue;
    const lines = match[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (
      lines.some(
        (line) => BARE_REDIRECT_ONLY_RE.test(line) || (BARE_SHELL_COMMAND_VERB_RE.test(line) && BARE_SHELL_COMMAND_SYNTAX_RE.test(line)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function isFencedShellExecutionNarrative(text: string): boolean {
  if (!EXECUTION_ANNOUNCEMENT_RE.test(text)) return false;
  return hasFencedShellCommandContent(text);
}

/**
 * True when a completion is prompt-echo or refusal boilerplate, a short
 * "honest failure to retrieve the requested data" response, a short
 * "meta-commentary about the delivery action" response, or a fabricated
 * command-execution success report — see PROMPT_ECHO_MARKERS /
 * REFUSAL_PATTERNS / DATA_UNAVAILABLE_PATTERNS /
 * ACTION_META_COMMENTARY_PATTERNS / FABRICATED_EXECUTION_PATTERNS above. NOTE: this
 * JS copy is the unit-tested source of truth, but it is a SECONDARY signal —
 * it only runs after a step's run log is read back, which for a step that
 * DISPATCHES an action (webhook/dm-reply) is already after the user
 * may have seen the confirm card. The primary, EARLIER gate is a hand-synced
 * shell copy (is_low_quality_completion in lib/agent-executor.ts's generated
 * script) that runs BEFORE request_and_wait_approval, so a bad completion for
 * a dispatching action never reaches a human-facing surface at all. This JS
 * copy still matters for non-dispatching / non-final steps in a chain, where
 * escalating to the next ladder tool for the NEXT step is the only signal.
 *
 * Empty/whitespace-only text is ALSO treated as low-quality (2026-07-15,
 * found on-device): a completed run whose real answer got fully stripped by
 * the codex-driver telemetry filter (clean_result_preview in
 * lib/agent-executor.ts) still reports status "success" with an empty
 * preview — an empty string previously matched neither marker set, so it
 * silently reached the confirm card blank instead of being treated as a
 * failed attempt. Since Codex is always the terminal ladder rung, this can't
 * cause an escalation loop; it converts a silent blank card into a clear
 * step-failure error.
 */
/** Below this length (after normalization) a near-duplicate verdict is not
 *  reliable — short acks ("OK", "Done.") legitimately repeat across steps
 *  without being a quality problem. Mirrors the bash-side
 *  is_low_quality_completion()'s duplicate check so the two never disagree. */
const DUPLICATE_CHECK_MIN_LEN = 20;
/** A near-verbatim containment (shorter fully inside longer) below this
 *  length ratio is coincidental overlap, not a repeat. */
const DUPLICATE_CONTAINMENT_MIN_RATIO = 0.6;

function normalizeForDuplicateCheck(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `text` looks like a near-verbatim repeat of `priorStepContent` —
 * DEFERRED.md「重複コンテンツ検知の欠如(P1)」: an orchestration step whose
 * completion is (almost) identical to what the PRIOR step already produced
 * is not a genuine new result, most often a model that ignored its own
 * instruction and echoed the context it was given back. Deliberately coarse
 * (exact match after normalization, or one text near-wholly contained in the
 * other) rather than a fuzzy similarity score — the observed on-device
 * incident was a verbatim repeat, and a stricter check risks false-flagging
 * a later step that legitimately quotes part of an earlier one.
 */
export function isDuplicateOfPriorStep(
  text: string | null | undefined,
  priorStepContent: string | null | undefined,
): boolean {
  if (!text || !priorStepContent) return false;
  const a = normalizeForDuplicateCheck(text);
  const b = normalizeForDuplicateCheck(priorStepContent);
  if (a.length < DUPLICATE_CHECK_MIN_LEN || b.length < DUPLICATE_CHECK_MIN_LEN) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.includes(shorter) && shorter.length / longer.length >= DUPLICATE_CONTAINMENT_MIN_RATIO) {
    return true;
  }
  return false;
}

export function isLowQualityCompletion(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PROMPT_ECHO_MARKERS.some((pattern) => pattern.test(text))) return true;
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (trimmed.length <= DATA_UNAVAILABLE_MAX_LEN && DATA_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (trimmed.length <= DATA_UNAVAILABLE_MAX_LEN && ACTION_META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (FABRICATED_EXECUTION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (isBareShellCommandLine(text)) return true;
  if (isFencedShellCommandBlock(text)) return true;
  if (isFencedShellExecutionNarrative(text)) return true;
  return false;
}

/**
 * An attempt failed (and should escalate) on a hard 'error', a transient
 * 'unavailable' (HTTP 429/5xx/network after retry), a local fallback digest,
 * OR a low-quality completion (prompt echo / refusal boilerplate — see
 * isLowQualityCompletion). 'unavailable' still climbs the ladder — a busy web
 * backend should hand off to the next tool — but it is excluded from the
 * circuit breaker (see shouldTripCircuitBreaker): an overloaded upstream is
 * not the agent misbehaving.
 */
export function attemptFailed(
  status: string | null | undefined,
  preview: string | null | undefined,
  /** The immediately preceding orchestration step's outputPreview — see
   *  isDuplicateOfPriorStep's doc comment. Absent for a non-orchestrated
   *  single run or a chain's first step, in which case this check is a
   *  no-op (byte-identical to the pre-existing 2-argument behavior). */
  priorStepContent?: string | null,
): boolean {
  return (
    status === 'error' ||
    status === 'unavailable' ||
    isLocalFallbackDigest(preview) ||
    isLowQualityCompletion(preview) ||
    isDuplicateOfPriorStep(preview, priorStepContent)
  );
}

/**
 * Action types whose run RESULT *is* the human-facing approval object itself
 * (dispatch_agent_action, lib/agent-executor.ts, requires an in-app approval
 * tap every time): cli runs a fixed, agent-configured shell command; intent /
 * dm-reply dispatch against fixed, agent-configured targets. None of the
 * three depend on which LLM backend generated the preceding content for
 * WHETHER the dispatch itself can succeed.
 */
const APPROVAL_IS_RESULT_ACTION_TYPES = new Set(['cli', 'intent', 'dm-reply']);

/**
 * dispatch_agent_action's own deterministic, config-driven failure messages
 * for cli / intent / dm-reply (lib/agent-executor.ts) — verbatim strings the
 * shell writes BEFORE any model-quality judgment is involved. Every one of
 * these depends only on static agent configuration (the cli action's fixed
 * command, or the intent/dm-reply action's fixed target/mode/pairing) and the
 * OS/environment (PATH, permissions, pairing state) — re-running the exact
 * same dispatch through a DIFFERENT LLM backend replays the identical
 * command/config against the identical environment and reproduces the
 * identical failure. Deliberately does NOT include the "...looks like a
 * prompt echo or AI refusal..." messages emitted by is_low_quality_completion
 * — those genuinely depend on what the model generated, so they must keep
 * escalating exactly as before.
 */
const DETERMINISTIC_DISPATCH_FAILURE_PATTERNS = [
  // cli: cap_workspace_exec ran the agent's fixed action.command and it
  // exited non-zero — e.g. exit 127 (command not found / not on PATH), exit
  // 126 (permission denied / not executable), or any other exit code from
  // that same fixed command.
  /^CLI action failed with exit \d+\.$/,
  /^CLI action was blocked by command safety:/,
  /^CLI action is missing a command\.$/,
  // intent: static mode/target/share-text config is absent or invalid.
  /^Intent action has an invalid mode\.$/,
  /^Intent action is missing a launch target\.$/,
  /^Intent action is missing share text\.$/,
  // dm-reply: static pairing config is absent, revoked, or unverifiable.
  /^DM-reply action is missing a paired conversation\.$/,
  /^DM-reply target is no longer paired\.$/,
  /^Could not verify the DM-reply pairing\.$/,
];

/**
 * True when a FAILED attempt's failure is a deterministic dispatch-time /
 * environment failure for an action type whose result IS the approval object
 * (cli / intent / dm-reply — see APPROVAL_IS_RESULT_ACTION_TYPES) — a class
 * of failure where escalating to a different tool cannot help, because the
 * thing that failed (a fixed shell command, a fixed intent target, a fixed DM
 * pairing) does not change with the backend. Callers should treat a `true`
 * result as a reason to END the run as a single failure rather than climbing
 * the ladder — climbing would just replay the identical dispatch and ask the
 * human to approve the same doomed action a second time.
 *
 * Deliberately narrow and pattern-matched against dispatch_agent_action's own
 * fixed-format strings (see DETERMINISTIC_DISPATCH_FAILURE_PATTERNS) so this
 * can never mistake a genuine model-quality failure for an environment one:
 * a low-quality completion (isLowQualityCompletion) is model-generated free
 * text and essentially never collides with one of these exact script-written
 * sentences, and the "prompt echo or AI refusal" messages are explicitly
 * excluded from the pattern list on top of that. Scope is intentionally
 * limited to cli/intent/dm-reply — draft/notify/webhook keep
 * escalating on ANY failure class exactly as before (their action.command
 * doesn't exist / their dispatch can genuinely vary with backend-generated
 * content, e.g. a webhook payload built from the model's own text).
 */
export function isDeterministicDispatchFailure(
  actionType: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (typeof actionType !== 'string' || !APPROVAL_IS_RESULT_ACTION_TYPES.has(actionType)) return false;
  if (typeof message !== 'string' || message.length === 0) return false;
  return DETERMINISTIC_DISPATCH_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}
