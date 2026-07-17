// MODEL-001 model router — shared types.
//
// Pure, dependency-free contract for eligibility-first model routing: given a
// run's DECLARED requirements (enums/booleans, never raw text or secret values),
// filter the candidate registry to the eligible set, THEN rank. The structural
// secret→local rule is an eligibility filter, not a score, so no cost/preference
// weight can ever re-admit a cloud model for a secret-touching run.
//
// Dormant: nothing here is wired into a production path yet (see wiring.ts,
// MODEL_ROUTER_ENABLED). The live selector stays lib/agent-tool-router.ts
// (resolveAgentRoute), byte-preserved. "実装されるが有効化はされない."

import type { ToolChoice } from '@/store/types';
import type { CredentialClass } from '@/lib/agent-credential-policy';

// Bump only alongside a persisted-descriptor shape change. FUTURE LOCKSTEP
// POINT: mirror like PLAN_SPEC_SCHEMA_VERSION only once a native/script consumer
// or a persisted registry reads these descriptors. See wiring.ts §migration.
export const MODEL_ROUTER_SCHEMA_VERSION = 1;

// Mirrors lib/agent-router-scoring.ts TaskCategory (byte-parity keeps the future
// cutover legible).
export type TaskKind = 'code' | 'research' | 'prose' | 'transform' | 'general';

export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type LatencyTier = 'instant' | 'fast' | 'slow';

// The DECLARED requirement descriptor. Booleans/enums only — NO raw prompt text,
// NO secret material. `touchesSecrets` is derived UPSTREAM (via scanForSecrets /
// taint) and passed in; the router never reads secrets itself.
export interface RunRequirements {
  taskKind: TaskKind;
  needsWeb: boolean;
  // Load-bearing: true => only on-device (isLocal) candidates are eligible.
  touchesSecrets: boolean;
  // Signal-only for now (MEMORY-001 Track C, see DEFERRED.md): true when
  // lib/memory/pii-guard.ts flagged the effective run text (which may include
  // recalled memory content injected into agent.prompt). Unlike
  // touchesSecrets, no eligibility predicate consumes this yet — that's an
  // explicit future MODEL-001 routing decision, out of Track C's scope.
  // Optional (not load-bearing like touchesSecrets) so every pre-existing
  // RunRequirements literal in lib/model-router/**/*.test.ts stays valid
  // without a mechanical edit; absent is equivalent to false. The field
  // exists so the signal reaches RunRequirements now, ahead of the policy
  // that will eventually act on it.
  touchesPii?: boolean;
  // Scheduled/event fire => deterministic and no api-key backend.
  unattended: boolean;
  // Hard ceilings only (eligibility, not ranking).
  budget?: { maxCostTier?: CostTier; maxLatencyTier?: LatencyTier };
}

// A registry entry: one selectable model/provider.
export interface ModelCandidate {
  id: string;
  toolType: ToolChoice['type']; // maps back to the live ToolChoice at cutover
  // TRUE ⟺ runs on-device with no egress. Source of truth for the secret bar.
  isLocal: boolean;
  // Authored to match agent-credential-policy credentialClass (parity-tested).
  credentialClass: CredentialClass;
  capabilities: { web: boolean; taskKinds: TaskKind[] };
  cost: CostTier;
  latency: LatencyTier;
  // Static bias/tiebreak weight (on-device-first), NOT a runtime score.
  preference: number;
}

export interface RoutingPolicy {
  // Ranking bias toward on-device candidates; never overrides eligibility.
  onDeviceFirst: boolean;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { onDeviceFirst: true };

export type RejectionReason =
  | 'secret-requires-local' // THE structural bar
  | 'web-required'
  | 'unattended-credential' // api-key backend barred from unattended
  | 'over-budget-cost'
  | 'over-budget-latency'
  | 'task-kind-unsupported';

export interface Rejection {
  id: string;
  reason: RejectionReason;
}

export interface SelectionResult {
  // null = explicit deny. NEVER a silent cloud fallback.
  chosen: ModelCandidate | null;
  eligible: ModelCandidate[]; // ranked, best-first
  rejected: Rejection[];
}
