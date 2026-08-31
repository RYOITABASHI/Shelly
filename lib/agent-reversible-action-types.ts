/**
 * lib/agent-reversible-action-types.ts — the action-type half of the
 * reversible/irreversible boundary, in a dependency-free module.
 *
 * This exists as its own file for exactly one reason: BOTH ends of the
 * optimistic-execution path need it, and they cannot import each other.
 *   - lib/agent-action-reversibility.ts (the full classifier, which also needs
 *     settings + lib/agent-executor's agentUsesStudioContext), and
 *   - lib/agent-executor.ts itself, which re-checks the type before it will
 *     bake an auto-approve override into a generated run script.
 * Putting the shared constant here keeps that second (defense-in-depth) check
 * possible without an agent-executor ⇄ agent-action-reversibility import cycle.
 *
 * The list is ONE entry on purpose. See lib/agent-action-reversibility.ts's
 * module doc comment for the per-type ruling and why every other action type
 * (notify / webhook / cli / intent / dm-reply / api-call /
 * social-post) is irreversible and must keep its pre-approval gate.
 */
import type { AgentActionType } from '@/store/types';

/** Action types that MAY qualify for rollback-type (post-approval) execution. */
export const REVERSIBLE_ACTION_TYPES: readonly AgentActionType[] = ['draft'] as const;

/**
 * Type-level half of the boundary. NOT sufficient on its own — a `draft` also
 * has to land inside the snapshotted workspace (see classifyRunReversibility).
 * Fail-closed for anything not explicitly listed, including a future action
 * type nobody has ruled on yet.
 */
export function isReversibleActionType(type: AgentActionType | undefined): boolean {
  // Absent action = the implicit 'draft' documented on Agent.action.
  return REVERSIBLE_ACTION_TYPES.includes(type ?? 'draft');
}
