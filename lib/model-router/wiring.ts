// MODEL-001 model router — dormant wiring seam + cutover mappers.
//
// Documents the future cutover from the live selector (lib/agent-tool-router.ts
// resolveAgentRoute) WITHOUT enabling it. The router is implemented (pure core +
// registry + tests) but wired into no production path: MODEL_ROUTER_ENABLED
// stays false and resolveAgentRoute remains the byte-preserved live selector.
// "実装されるが有効化はされない."
//
// MIGRATION (deferred, flag-ON step, out of scope until the floor is verified):
//   1. resolveAgentRoute's imperative guard chain (secret → manual-pin →
//      autonomous-policy → scoreRoutes → configured) is re-expressed as MODEL-001
//      eligibility predicates + rankEligible, emitting a byte-identical
//      AgentRouteDecision derived from the SelectionResult.
//   2. Disposition when chosen===null (no eligible model, e.g. secret run with no
//      local model installed) — deny vs enqueue (EVENT-001) vs error — is a
//      product decision made at cutover, not here.
//   3. provider-invoke.ts is wired behind the CAP-001 broker; egress mediated.
//   4. Registry vs agent-credential-policy source-of-truth ownership is decided
//      at cutover; until then registry.test.ts keeps them in lockstep.

import type { Agent, ToolChoice } from '@/store/types';
import type { SecretGuardResult } from '@/lib/secret-guard';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { scanForSecrets } from '@/lib/secret-guard';
import { CostTier, LatencyTier, ModelCandidate, RunRequirements, TaskKind } from './types';

// Master dormancy switch. Never flipped by this work.
export const MODEL_ROUTER_ENABLED = false;

// Build the DECLARED requirement descriptor from upstream-computed signals. The
// secret bit comes from scanForSecrets' result (booleans only reach the router —
// RunRequirements carries no prompt/secret text), needsWeb/taskKind from the
// route signals. This is the trust boundary: touchesSecrets === secret.hasSecret.
export function toRunRequirements(input: {
  taskKind: TaskKind;
  needsWeb: boolean;
  secret: SecretGuardResult;
  unattended: boolean;
  budget?: { maxCostTier?: CostTier; maxLatencyTier?: LatencyTier };
}): RunRequirements {
  return {
    taskKind: input.taskKind,
    needsWeb: input.needsWeb,
    touchesSecrets: input.secret.hasSecret,
    unattended: input.unattended,
    budget: input.budget,
  };
}

// MIRRORS lib/agent-tool-router.ts textForSecretScan byte-for-byte. It is
// private there; replicated here (not imported) so this module stays a leaf
// with no dependency back onto agent-tool-router.ts — Phase B's live call-site
// (resolveAgentRoute) already computes its own `secret` locally and does not
// need this field list, but shadow.ts (Phase A) and any FUTURE caller building
// RunRequirements from a bare Agent (no already-computed SecretGuardResult) do.
// Drift risk is bounded the same way Phase A already accepted it: a missed
// field here would surface as a shadow secretInvariantHolds failure, not a
// silent live-path gap, because Phase B's live call-site never calls this.
function textForSecretScan(agent: Agent): string {
  return [
    agent.name,
    agent.description,
    agent.prompt,
    agent.outputTemplate,
    agent.action?.webhookUrl,
    agent.action?.command,
    agent.action?.intentTarget,
    agent.action?.intentShareText,
    agent.action?.dmPairingId,
    agent.action?.dmReplyText,
    agent.action?.appActParams ? Object.values(agent.action.appActParams).join('\n') : undefined,
  ].filter(Boolean).join('\n');
}

// SHARED single derivation of RunRequirements from a bare Agent — used by BOTH
// the Phase A shadow comparator (shadow.ts) and the Phase B live cutover
// attempt (agent-tool-router.ts resolveAgentRoute secret branch), so the two
// can never drift on how taskKind/needsWeb/touchesSecrets/unattended are read
// off an Agent. taskKind/needsWeb come from detectRouteSignals(agent.prompt)
// (mirrors TaskCategory byte-for-byte, types.ts), touchesSecrets from
// scanForSecrets over the same field set the live secret-guard branch scans,
// unattended from the autonomous flag (scheduled fires run with no human
// present). Pure: no fs, no Date.now, no network — a function of the Agent alone.
export function toRunRequirementsFromAgent(agent: Agent): RunRequirements {
  const secret = scanForSecrets(textForSecretScan(agent));
  const signals = detectRouteSignals(agent.prompt);
  return toRunRequirements({
    taskKind: signals.category,
    needsWeb: signals.needsWeb,
    secret,
    unattended: agent.autonomous === true,
  });
}

// Round-trip a chosen candidate back to the live ToolChoice for the cutover.
export function candidateToToolChoice(candidate: ModelCandidate): ToolChoice {
  switch (candidate.toolType) {
    case 'cli':
      return { type: 'cli', cli: 'codex' };
    case 'local':
      return { type: 'local' };
    case 'gemini-api':
      return { type: 'gemini-api' };
    case 'cerebras':
      return { type: 'cerebras' };
    case 'groq':
      return { type: 'groq' };
    case 'perplexity':
      return { type: 'perplexity' };
    case 'ab-article-eval':
      return { type: 'ab-article-eval' };
    case 'auto':
      return { type: 'auto' };
  }
}
