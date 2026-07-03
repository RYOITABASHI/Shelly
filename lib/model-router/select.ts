// MODEL-001 model router — the orchestrator.
//
// selectModel = computeEligible (structural filter, secret→local first) then
// rankEligible (deterministic). chosen is the top-ranked eligible candidate, or
// null when nothing is eligible — an EXPLICIT deny, never a silent cloud
// fallback. Pure: the result is a function only of (requirements, registry, policy).

import { computeEligible } from './eligibility';
import { rankEligible } from './ranking';
import {
  DEFAULT_ROUTING_POLICY,
  ModelCandidate,
  RoutingPolicy,
  RunRequirements,
  SelectionResult,
} from './types';

export function selectModel(
  requirements: RunRequirements,
  registry: readonly ModelCandidate[],
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): SelectionResult {
  const { eligible, rejected } = computeEligible(requirements, registry);
  const ranked = rankEligible(eligible, policy);
  const chosen: ModelCandidate | null = ranked.length > 0 ? ranked[0] : null;
  return { chosen, eligible: ranked, rejected };
}
