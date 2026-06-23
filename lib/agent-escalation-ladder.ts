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

export interface LadderEnv {
  /** Cerebras free-tier key present (Settings → API Keys). */
  hasCerebrasKey: boolean;
  /** Groq free-tier key present. */
  hasGroqKey: boolean;
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

/** Identity for dedupe — local is tier-agnostic (the shell does installed-aware). */
function toolKey(t: ToolChoice): string {
  if (t.type === 'cli') return `cli:${t.cli}`;
  if (t.type === 'local') return 'local';
  return t.type;
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
  const ladder: ToolChoice[] = [primary, LOCAL];
  if (env.hasCerebrasKey) ladder.push({ type: 'cerebras' });
  if (env.hasGroqKey) ladder.push({ type: 'groq' });
  ladder.push(CODEX);
  return { tools: dedupe(ladder), noEscalation: false, guard: decision.guard, why: decision.why };
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

/** An attempt failed (and should escalate) on an error status OR a fallback digest. */
export function attemptFailed(
  status: string | null | undefined,
  preview: string | null | undefined,
): boolean {
  return status === 'error' || isLocalFallbackDigest(preview);
}
