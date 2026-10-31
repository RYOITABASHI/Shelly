/**
 * lib/agent-run-success.ts — "did this run succeed in full?" for offers that
 * must only follow a complete success (save-as-skill).
 *
 * 2026-10-31 on-device bug (agent-mvvx3o28): "Save as skill? … succeeded"
 * appeared after a 2-step run whose step 2 was SKIPPED (its approval timed
 * out). The aggregate run status is reduceStatus(steps)
 * (lib/agent-orchestration.ts), which reads a success + skipped mix as
 * 'success' — fine for the circuit breaker, wrong for "this run succeeded".
 * A run that stopped early (budget, halt) likewise records fewer steps than
 * planned while still reducing to 'success'.
 *
 * Pure, no store / RN imports.
 */
import type { AgentRunLog, AgentRunStep } from '@/store/types';

export interface RunSuccessInput {
  status?: AgentRunLog['status'] | string;
  /** Per-step records of an orchestrated run (absent for a single-step run). */
  steps?: ReadonlyArray<Pick<AgentRunStep, 'status'>> | null;
  /** How many steps the agent's plan has (Agent.orchestration.steps.length). */
  plannedStepCount?: number;
}

export function runSucceededInFull(run: RunSuccessInput): boolean {
  if (run.status !== 'success') return false;
  const steps = run.steps;
  if (!steps || steps.length === 0) return true;
  if (steps.some((s) => s.status !== 'success')) return false;
  const planned = run.plannedStepCount;
  if (typeof planned === 'number' && Number.isFinite(planned) && planned > steps.length) return false;
  return true;
}
