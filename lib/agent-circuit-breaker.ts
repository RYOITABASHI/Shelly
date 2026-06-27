/**
 * lib/agent-circuit-breaker.ts — auto-disable a misfiring agent (Phase 0 §2.5).
 *
 * Autonomy without a stop button is not shippable. A self-registered agent that
 * keeps failing (e.g. a bad webhook = self-inflicted DoS, or a backend that's
 * permanently misconfigured) must not loop forever. After N consecutive FAILED
 * runs the agent is auto-disabled and the user is notified.
 *
 * Pure & deterministic (no store/native deps) so it is unit-testable. The store/
 * manager calls `shouldTripCircuitBreaker` after each run-log sync and, when true
 * for a still-enabled agent, disables it + uninstalls its schedule + notifies.
 */
import { AgentRunLog } from '@/store/types';

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Count trailing consecutive FAILED runs in a chronological run-log list
 * (oldest→newest, as the store keeps them). Only a hard 'error' counts. A
 * 'success' OR 'skipped' run breaks the streak ('skipped' is the cli "requires
 * in-app confirmation" outcome — the agent correctly declined). 'unavailable'
 * (a transient 429/5xx/network failure of a web backend after retry) also breaks
 * the streak: an overloaded upstream is not the agent misbehaving, so it must
 * NEVER auto-disable an otherwise-healthy unattended agent.
 */
export function consecutiveFailures(logs: AgentRunLog[] | undefined): number {
  if (!logs || logs.length === 0) return 0;
  let n = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].status === 'error') {
      n++;
    } else {
      // 'success' | 'skipped' | 'unavailable' → streak ends.
      break;
    }
  }
  return n;
}

/**
 * True when the last `threshold` runs are all failures (so the agent should be
 * auto-disabled). Requires at least `threshold` logs — a brand-new agent with
 * fewer runs can't trip the breaker.
 */
export function shouldTripCircuitBreaker(
  logs: AgentRunLog[] | undefined,
  threshold: number = DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
): boolean {
  return consecutiveFailures(logs) >= threshold;
}
