// MODEL-001 model router — eligibility (the structural filter).
//
// Pure. Each candidate is tested against an ORDERED predicate list; the first
// failing predicate rejects it with a reason, and a candidate passing all
// predicates is eligible. The secret→local rule is predicate #0, so it decides
// before anything else — and because eligibility is set membership (not a
// score), a rejected cloud candidate is simply absent from the set that ranking
// later sees. No cost/latency/preference weight can re-admit it.

import {
  CostTier,
  LatencyTier,
  ModelCandidate,
  Rejection,
  RejectionReason,
  RunRequirements,
} from './types';

const COST_ORDER: CostTier[] = ['free', 'low', 'medium', 'high'];
const LATENCY_ORDER: LatencyTier[] = ['instant', 'fast', 'slow'];

export function costRank(tier: CostTier): number {
  return COST_ORDER.indexOf(tier);
}
export function latencyRank(tier: LatencyTier): number {
  return LATENCY_ORDER.indexOf(tier);
}

type Predicate = (c: ModelCandidate, r: RunRequirements) => RejectionReason | null;

// ORDER MATTERS: secret bar is first and structural. The remaining predicates
// are independent; a candidate is rejected by the first one it fails.
const PREDICATES: Predicate[] = [
  // #0 STRUCTURAL: a secret-touching run may only use on-device models. Require
  // BOTH corroborating signals — isLocal AND credentialClass==='local' — so a
  // single mislabeled field (isLocal:true on an egressing backend) cannot smuggle
  // a cloud model past the bar. Defense in depth: the gate is only as trustworthy
  // as its weakest label, so it trusts the conjunction, not one boolean.
  (c, r) =>
    r.touchesSecrets && !(c.isLocal && c.credentialClass === 'local')
      ? 'secret-requires-local'
      : null,
  (c, r) => (r.needsWeb && !c.capabilities.web ? 'web-required' : null),
  // Unattended fires must not depend on an interactive api-key backend.
  (c, r) => (r.unattended && c.credentialClass === 'api-key' ? 'unattended-credential' : null),
  (c, r) =>
    r.budget?.maxCostTier && costRank(c.cost) > costRank(r.budget.maxCostTier)
      ? 'over-budget-cost'
      : null,
  (c, r) =>
    r.budget?.maxLatencyTier && latencyRank(c.latency) > latencyRank(r.budget.maxLatencyTier)
      ? 'over-budget-latency'
      : null,
  (c, r) => (!c.capabilities.taskKinds.includes(r.taskKind) ? 'task-kind-unsupported' : null),
];

// First failing predicate's reason, or null when the candidate is eligible.
export function rejectionFor(c: ModelCandidate, r: RunRequirements): RejectionReason | null {
  for (const predicate of PREDICATES) {
    const reason = predicate(c, r);
    if (reason) return reason;
  }
  return null;
}

export function computeEligible(
  requirements: RunRequirements,
  registry: readonly ModelCandidate[],
): { eligible: ModelCandidate[]; rejected: Rejection[] } {
  const eligible: ModelCandidate[] = [];
  const rejected: Rejection[] = [];
  for (const candidate of registry) {
    const reason = rejectionFor(candidate, requirements);
    if (reason) rejected.push({ id: candidate.id, reason });
    else eligible.push(candidate);
  }
  return { eligible, rejected };
}
