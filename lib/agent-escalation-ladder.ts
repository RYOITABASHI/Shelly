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
 */
export function resolveEscalationLadder(agent: Agent, env: LadderEnv): EscalationLadder {
  const { tool: primary, decision } = resolveAgentRoute(agent);

  // Hard stops — a single attempt, never climb to cloud.
  if (decision.guard === 'secret' || decision.guard === 'manual-pin') {
    return { tools: [primary], noEscalation: true, guard: decision.guard, why: decision.why };
  }

  // Web-mandatory task (collect CURRENT info): only a live web fetch satisfies
  // it. EXCLUDE non-web backends (local / Cerebras / Groq) — they would only
  // hallucinate a plausible template and report a fake success. Web-capable
  // backends only: Gemini(grounded) for general / Perplexity for academic, then
  // Codex (danger-full-access shell) as the net fallback.
  const web = detectRouteSignals(agent.prompt);
  if (web.needsWeb) {
    if (agent.autonomous) {
      // N1: with the user's informed consent, an autonomous web task may use the
      // keyed web backend (Gemini grounded / Perplexity) unattended — the key
      // authenticates the request and never reaches the model. On quota
      // exhaustion (429) the ladder climbs to Codex unless 'stop' is set, which
      // halts at the free tier rather than burning Codex/paid quota.
      if (env.autonomousCloudConsent) {
        const consented = web.webDomain === 'academic' ? PERPLEXITY : GEMINI;
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
            why: `Web-mandatory ${web.webDomain} task; autonomous cloud opt-in → ${web.webDomain === 'academic' ? 'Perplexity' : 'Gemini (grounded)'}${env.autonomousCloudStop ? ' (stop at free tier on 429)' : ' → Codex on 429'}.`,
          };
        }
      }
      // No consent (fail-closed): api-key web backends are excluded, so the only
      // web-capable option is Codex (OAuth shell). Distinguish the keyless
      // consented case in the why — "enable cloud opt-in" would misdiagnose it.
      const why = env.autonomousCloudConsent
        ? `Web-mandatory task; cloud opt-in is on but the ${web.webDomain === 'academic' ? 'Perplexity' : 'Gemini'} key is not configured → Codex only.`
        : 'Web-mandatory task; autonomous policy → Codex only (enable cloud opt-in for Gemini/Perplexity).';
      return { tools: [CODEX], noEscalation: false, guard: decision.guard, why };
    }
    const webPrimary = web.webDomain === 'academic' ? PERPLEXITY : GEMINI;
    // Key preflight: a keyless web primary can't authenticate — go straight to
    // Codex (web-capable via its shell) instead of burning an attempt. Local /
    // Cerebras / Groq stay excluded (they would hallucinate a template).
    if (keyKnownMissing(webPrimary, env)) {
      return {
        tools: [CODEX],
        noEscalation: false,
        guard: decision.guard,
        why: `Web-mandatory ${web.webDomain} task; ${web.webDomain === 'academic' ? 'Perplexity' : 'Gemini'} key not configured → Codex directly; non-web backends excluded.`,
      };
    }
    return {
      tools: dedupe([webPrimary, CODEX]),
      noEscalation: false,
      guard: decision.guard,
      why: `Web-mandatory ${web.webDomain} task → ${web.webDomain === 'academic' ? 'Perplexity' : 'Gemini (grounded)'} → Codex; non-web backends excluded.`,
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
// content, least of all for a public-posting action type like app-act.
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
 * True when a completion is prompt-echo or refusal boilerplate, or a short
 * "honest failure to retrieve the requested data" response — see
 * PROMPT_ECHO_MARKERS / REFUSAL_PATTERNS / DATA_UNAVAILABLE_PATTERNS above.
 * NOTE: this
 * JS copy is the unit-tested source of truth, but it is a SECONDARY signal —
 * it only runs after a step's run log is read back, which for a step that
 * DISPATCHES an action (app-act/webhook/dm-reply) is already after the user
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
export function isLowQualityCompletion(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PROMPT_ECHO_MARKERS.some((pattern) => pattern.test(text))) return true;
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (trimmed.length <= DATA_UNAVAILABLE_MAX_LEN && DATA_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
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
): boolean {
  return (
    status === 'error' ||
    status === 'unavailable' ||
    isLocalFallbackDigest(preview) ||
    isLowQualityCompletion(preview)
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
 * limited to cli/intent/dm-reply — draft/notify/webhook/app-act keep
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
