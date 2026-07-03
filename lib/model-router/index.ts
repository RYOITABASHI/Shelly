// MODEL-001 model router — public surface.
//
// Dormant Phase 1 primitive: eligibility-first model routing with a structural
// secret→local bar. Flag-OFF (see wiring.ts); no production path imports it yet.
// The deferred provider-invoke skeleton is intentionally NOT re-exported until
// the flag-ON cutover.

export * from './types';
export { computeEligible, rejectionFor, costRank, latencyRank } from './eligibility';
export { compareCandidates, rankEligible } from './ranking';
export { selectModel } from './select';
export { MODEL_REGISTRY } from './registry';
export {
  MODEL_ROUTER_ENABLED,
  toRunRequirements,
  candidateToToolChoice,
} from './wiring';
