/**
 * lib/agent-credential-policy.ts — SINGLE SOURCE OF TRUTH for "how does this
 * tool authenticate, and may it run in autonomous mode?".
 *
 * Both of the parallel work-streams MUST import from here so their judgements
 * cannot diverge:
 *   - Tier-1 (conditional `.env` sourcing in agent-executor) → `requiresApiKeyEnv()`
 *   - Spec A tool-set allowlist (autonomous mode) → `isAutonomousAllowed()` / `resolveForAutonomous()`
 *
 * Grounded facts (verified 2026-06-17):
 *   - `cli` (codex) authenticates via ChatGPT-subscription device-code OAuth
 *     (~/.codex/auth.json, OPENAI_API_KEY:null) — NO API key in env.
 *   - `local` hits a loopback llama-server — NO API key.
 *   - `ab-article-eval` = local Qwen + codex (OAuth) — NO API key.
 *   - `perplexity` / `gemini-api` inject PERPLEXITY_API_KEY / GEMINI_API_KEY into
 *     the run env (agent-executor.ts:907,1099) — these are the API-key backends.
 *   - `auto` resolves at runtime and PREFERS the GEMINI_API_KEY branch before
 *     OAuth-codex (agent-executor.ts:928), so as-written it may bear an API key.
 *
 * Policy (autonomous mode = agent runs multi-step WITHOUT per-step approval):
 * autonomous execution is OAuth/local only. API-key backends are excluded from
 * the autonomous path (their key would sit in an LLM-readable env — the exact
 * OpenClaw leak surface). They remain available in manual/foreground runs where
 * a human is present. See specs/2026-06-17-autonomous-mode-A-policy-gate.md §4, §7a.
 */
import { ToolChoice } from '@/store/types';

export type CredentialClass = 'oauth' | 'local' | 'api-key';

/**
 * How a CONCRETE tool authenticates. `auto` is classified conservatively as
 * `api-key` because it may resolve to gemini-api; callers that care about the
 * autonomous path should `resolveForAutonomous()` first so `auto` never reaches
 * here unresolved.
 */
export function credentialClass(tool: ToolChoice): CredentialClass {
  switch (tool.type) {
    case 'cli':
      return 'oauth';
    case 'ab-article-eval':
      return 'oauth'; // local Qwen + codex OAuth; no API key
    case 'local':
      return 'local';
    case 'perplexity':
    case 'gemini-api':
      return 'api-key';
    case 'auto':
      return 'api-key'; // conservative: may resolve to gemini-api (key-bearing)
  }
}

/**
 * TIER-1 predicate. Should the run script `source ~/.shelly/agents/.env`
 * (which holds PERPLEXITY_API_KEY / GEMINI_API_KEY) for this tool?
 *
 * Only the API-key backends need it. A codex/local agent sourcing it pulls keys
 * into an env it never uses — the leak surface Tier-1 closes. In autonomous mode
 * the tool is `resolveForAutonomous()`-ed first, so this returns false there.
 */
export function requiresApiKeyEnv(tool: ToolChoice): boolean {
  return credentialClass(tool) === 'api-key';
}

/**
 * SPEC-A predicate. May this tool run in autonomous mode (no human in the loop)?
 * OAuth/local only. `auto` is allowed but MUST be `resolveForAutonomous()`-ed to
 * a concrete OAuth/local tool before execution.
 */
export function isAutonomousAllowed(tool: ToolChoice): boolean {
  if (tool.type === 'auto') return true; // allowed via resolution below
  return credentialClass(tool) !== 'api-key';
}

/**
 * SPEC-A resolver. Map a tool to the concrete tool that should run in autonomous
 * mode. `auto` collapses to OAuth-codex (drops the GEMINI_API_KEY-first branch).
 * API-key backends have no autonomous form WITHOUT a credential broker
 * (Spec A §7a Tier-2) and return null — caller must reject or route to the broker.
 */
export function resolveForAutonomous(tool: ToolChoice): ToolChoice | null {
  if (tool.type === 'auto') {
    return { type: 'cli', cli: 'codex' };
  }
  return isAutonomousAllowed(tool) ? tool : null;
}
