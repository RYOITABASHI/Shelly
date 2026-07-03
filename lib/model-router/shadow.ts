// MODEL-001 model router — Phase A shadow comparator (dormant, read-only).
//
// Runs the LIVE selector (lib/agent-tool-router.ts resolveAgentRoute) and the
// dormant MODEL-001 selector (selectModel over MODEL_REGISTRY) side by side on
// the same Agent and reports agreement — WITHOUT touching any production route.
// MODEL_ROUTER_ENABLED stays false (wiring.ts) and no production call-site
// imports this; it exists so the flag-ON cutover (wiring.ts §MIGRATION step 1)
// is de-risked by corpus parity evidence instead of hope.
//
// Parity scope — the ONE invariant MODEL-001 owns is the secret bar: a
// secret-bearing run must resolve local on BOTH sides (live: guard==='secret'
// && route==='on-device'; shadow: a local/local-credential candidate chosen, or
// chosen===null — the explicit fail-closed deny, wiring §MIGRATION step 2).
// Four live behaviours are INTENTIONALLY divergent and excluded from parity:
//   - manual runOn pins (user override; no MODEL-001 requirement expresses it),
//   - the autonomous+auto policy branch (collapses to the OAuth Codex driver),
//   - configured-tool passthrough (live honours the stored tool verbatim),
//   - affinity-score ranking (live scoreRoutes weighs task affinity; MODEL-001
//     ranks cost→latency→preference — a different ORDER over the SAME eligible
//     set is a ranking preference, not an eligibility bug).
// Only an ELIGIBILITY disagreement — live picked a tool the shadow selector
// says is structurally ineligible, or the shadow denied a run live allowed to
// cloud — surfaces as unexpectedDivergence.
//
// Pure: no fs, no Date.now, no network — a function of the Agent alone.

import type { Agent } from '@/store/types';
import { resolveAgentRoute, AgentRouteResolution } from '@/lib/agent-tool-router';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { scanForSecrets } from '@/lib/secret-guard';
import { credentialClass } from '@/lib/agent-credential-policy';
import { selectModel } from './select';
import { MODEL_REGISTRY } from './registry';
import { toRunRequirements, candidateToToolChoice } from './wiring';
import type { RunRequirements, SelectionResult } from './types';

export interface RouteShadowResult {
  /** The live selector's verdict — the one production actually runs on. */
  live: AgentRouteResolution;
  /** The dormant MODEL-001 verdict over the shipped registry. */
  shadow: SelectionResult;
  /** The declared requirements handed to the shadow selector (booleans/enums only). */
  requirements: RunRequirements;
  /** THE load-bearing check: secret run ⇒ local on both sides (or shadow deny). */
  secretInvariantHolds: boolean;
  /** Set when the disagreement is one of the documented intentional divergences. */
  knownDivergence: string | null;
  /** Set when live and shadow disagree for a reason parity does NOT excuse. */
  unexpectedDivergence: string | null;
}

// MIRRORS lib/agent-tool-router.ts textForSecretScan byte-for-byte. It is
// private there and this increment must leave agent-tool-router untouched, so
// it is replicated instead of exported. Drift is not silent: the invariant
// below also triggers on live guard==='secret', so a replica that misses a
// field live scans fails secretInvariantHolds in the corpus test.
function textForSecretScan(agent: Agent): string {
  return [
    agent.name,
    agent.description,
    agent.prompt,
    agent.outputTemplate,
    agent.action?.webhookUrl,
    agent.action?.command,
  ].filter(Boolean).join('\n');
}

export function compareRouteDecision(agent: Agent): RouteShadowResult {
  // Derive RunRequirements exactly the way the cutover will (wiring.ts
  // toRunRequirements): taskKind/needsWeb from the live route signals (TaskKind
  // mirrors TaskCategory byte-for-byte, types.ts), touchesSecrets from the same
  // scanForSecrets over the same field set the live selector scans, unattended
  // from the autonomous flag (scheduled fires run with no human present).
  const secret = scanForSecrets(textForSecretScan(agent));
  const signals = detectRouteSignals(agent.prompt);
  const requirements = toRunRequirements({
    taskKind: signals.category,
    needsWeb: signals.needsWeb,
    secret,
    unattended: agent.autonomous === true,
  });

  const live = resolveAgentRoute(agent);
  const shadow = selectModel(requirements, MODEL_REGISTRY);

  // Secret invariant. Triggered by EITHER side seeing a secret (belt and
  // braces against textForSecretScan replica drift — see above). Live must be
  // the forced on-device secret route with a local-credential tool; shadow must
  // choose a candidate passing the same conjunction eligibility.ts predicate #0
  // requires (isLocal && credentialClass==='local'), or deny outright.
  const secretSeen = secret.hasSecret || live.decision.guard === 'secret';
  const liveLocal =
    live.decision.guard === 'secret' &&
    live.decision.route === 'on-device' &&
    credentialClass(live.tool) === 'local';
  const shadowLocal =
    shadow.chosen === null ||
    (shadow.chosen.isLocal && shadow.chosen.credentialClass === 'local');
  const secretInvariantHolds = !secretSeen || (liveLocal && shadowLocal);

  const guard = live.decision.guard;
  let knownDivergence: string | null = null;
  let unexpectedDivergence: string | null = null;

  if (guard === 'manual-pin' || guard === 'autonomous-policy' || guard === 'configured-tool') {
    // Live-only branches with no MODEL-001 counterpart — excluded from parity.
    knownDivergence = guard;
  } else {
    const shadowType = shadow.chosen ? candidateToToolChoice(shadow.chosen).type : null;
    if (shadowType === live.tool.type) {
      // Agreement — nothing to record.
    } else if (guard === 'secret' && shadow.chosen === null) {
      // e.g. secret + needsWeb: no candidate is both local and web-capable, so
      // the shadow denies where live falls back to local. Deny-vs-fallback
      // disposition is the documented open cutover decision (wiring §MIGRATION
      // step 2), not a parity failure — the invariant above already verified
      // that neither side let the secret reach a cloud backend.
      knownDivergence = 'secret-fail-closed-deny';
    } else if (shadow.eligible.some((c) => c.toolType === live.tool.type)) {
      // Same eligible set, different winner: the documented ranking divergence.
      knownDivergence = 'affinity-ranking';
    } else {
      unexpectedDivergence =
        `live=${live.tool.type} shadow=${shadowType ?? 'deny'} ` +
        '(live tool is structurally ineligible under MODEL-001)';
    }
  }

  return { live, shadow, requirements, secretInvariantHolds, knownDivergence, unexpectedDivergence };
}
