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
 * True when a completion is prompt-echo or refusal boilerplate rather than a
 * real answer — see PROMPT_ECHO_MARKERS / REFUSAL_PATTERNS above. NOTE: this
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
  if (text.trim().length === 0) return true;
  if (PROMPT_ECHO_MARKERS.some((pattern) => pattern.test(text))) return true;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
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
