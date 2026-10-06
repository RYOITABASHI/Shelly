/**
 * lib/agent-run-origin-registry.ts — POLICY-001 security review M2.
 *
 * The RN approval choke point must not trust the `origin` field of an action
 * approval request file: the executor writes that file, so anything with the
 * agent's uid could write "origin":"user". Instead RN remembers, itself, which
 * agents it is currently running on a human's behalf (lib/agent-manager.ts
 * marks an agent right before TerminalEmulator.runAgent() — the only producer
 * of native origin "user" — and clears it once that run completes). Any
 * request whose agent is not in this registry is PROACTIVE: alarms,
 * notification triggers, widget taps and anything RN did not start itself.
 *
 * Per-agent runs are single-flight (the native per-agent lock skips a
 * concurrent fire), so "this agent is in a user run right now" is equivalent
 * to "this request came from the user's run". In-memory only on purpose: an
 * app restart forgets every mark, which can only make runs MORE proactive.
 */

const userRuns = new Map<string, number>();
/** Ceiling on a mark's life even if a completion is never observed. */
const MAX_USER_RUN_MS = 2 * 60 * 60_000;

export function markUserRunStarted(agentId: string, now: number = Date.now()): void {
  userRuns.set(agentId, now);
}

export function markUserRunFinished(agentId: string): void {
  userRuns.delete(agentId);
}

/** 'user' only while RN itself is running this agent for a human; else 'event'. */
export function registeredRunOrigin(agentId: string | null | undefined, now: number = Date.now()): 'user' | 'event' {
  if (!agentId) return 'event';
  const startedAt = userRuns.get(agentId);
  if (startedAt === undefined) return 'event';
  if (now - startedAt > MAX_USER_RUN_MS) {
    userRuns.delete(agentId);
    return 'event';
  }
  return 'user';
}

/** Test hook. */
export function __resetRunOriginRegistryForTests(): void {
  userRuns.clear();
}
