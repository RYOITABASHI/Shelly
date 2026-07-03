// MODEL-001 model router — ranking (applied AFTER eligibility).
//
// Pure and deterministic: no Date.now, no Math.random. The comparator is a total
// order over candidates with unique ids (the shipped registry guarantees this,
// asserted by registry.test.ts); for arbitrary caller registries with duplicate
// ids it degrades to a preorder whose ties resolve by the stable Array.sort, so
// selection stays deterministic either way. Ranking only ever sees the already-
// filtered eligible set, so it cannot re-admit a candidate eligibility rejected.

import { costRank, latencyRank } from './eligibility';
import { ModelCandidate, RoutingPolicy } from './types';

// cost asc → latency asc → preference desc → (onDeviceFirst) isLocal first →
// id asc (deterministic terminal tiebreak, mirroring memory compareHits key asc).
export function compareCandidates(
  a: ModelCandidate,
  b: ModelCandidate,
  policy: RoutingPolicy,
): number {
  const cost = costRank(a.cost) - costRank(b.cost);
  if (cost !== 0) return cost;

  const latency = latencyRank(a.latency) - latencyRank(b.latency);
  if (latency !== 0) return latency;

  if (a.preference !== b.preference) return b.preference - a.preference;

  if (policy.onDeviceFirst && a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankEligible(
  eligible: readonly ModelCandidate[],
  policy: RoutingPolicy,
): ModelCandidate[] {
  return [...eligible].sort((a, b) => compareCandidates(a, b, policy));
}
