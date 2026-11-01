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
 * 2026-11-01 on-device bug: the same offer followed a run whose Claude Code
 * step had its gate escalation DECLINED by the user. Claude Code then answered
 * normally ("the command was blocked by Shelly's agent gate …") and the step
 * read 'success'. These now also fail a full success:
 *   - `blocked`: the caller found a declined / denied / refused action in the
 *     run's driver / executor audit trail (lib/agent-run-blocks.ts — the
 *     structured signal);
 *   - a step / run answer that itself says Shelly's agent gate blocked it
 *     (answerReportsGateBlock — narrow text fallback for when the audit trail
 *     is unreadable or not consulted);
 *   - a multi-action fan-out run where any action was skipped / failed
 *     (that run reduces to 'success' when at least one action succeeded).
 *
 * Pure, no store / RN imports.
 */
import type { AgentActionResult, AgentRunLog, AgentRunStep } from '@/store/types';

export interface RunSuccessInput {
  status?: AgentRunLog['status'] | string;
  /** Per-step records of an orchestrated run (absent for a single-step run). */
  steps?: ReadonlyArray<Pick<AgentRunStep, 'status'> & Partial<Pick<AgentRunStep, 'outputPreview'>>> | null;
  /** How many steps the agent's plan has (Agent.orchestration.steps.length). */
  plannedStepCount?: number;
  /** The run's own output preview (a single-step run carries its answer here). */
  outputPreview?: string;
  /** Multi-action fan-out results (AgentRunLog.actionResults). */
  actionResults?: ReadonlyArray<Pick<AgentActionResult, 'status'>> | null;
  /** True when the audit trail shows a declined / denied / refused action in
   *  this run (lib/agent-run-blocks.ts runHadBlockedAction). */
  blocked?: boolean;
}

// "Shelly's agent gate" / "Shelly agent gate" / "Shellyのエージェントゲート" / "Shellyのゲート".
const GATE_PHRASE_RE = /Shelly(?:['’]s)?\s*(?:の\s*)?(?:agent\s+gate|エージェント\s*ゲート|ゲート)/gi;
const BLOCK_WORD_RE = /block|declin|denied|deny|refus|reject|not\s+allowed|拒否|ブロック|却下|許可されな|止められ/i;
const BLOCK_CONTEXT_CHARS = 120;

/**
 * True when an answer says Shelly's agent gate blocked / declined something.
 * Narrow on purpose: it needs the literal gate phrase (the driver's deny
 * message to the worker is "Shelly agent gate declined this action …") AND a
 * block word near it, so an answer that merely mentions the gate does not
 * suppress the offer.
 */
export function answerReportsGateBlock(text: string | undefined | null): boolean {
  if (!text) return false;
  const re = new RegExp(GATE_PHRASE_RE.source, GATE_PHRASE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const from = Math.max(0, match.index - BLOCK_CONTEXT_CHARS);
    const to = Math.min(text.length, match.index + match[0].length + BLOCK_CONTEXT_CHARS);
    if (BLOCK_WORD_RE.test(text.slice(from, to))) return true;
  }
  return false;
}

export function runSucceededInFull(run: RunSuccessInput): boolean {
  if (run.status !== 'success') return false;
  if (run.blocked === true) return false;
  if (run.actionResults && run.actionResults.some((a) => a.status !== 'success')) return false;
  if (answerReportsGateBlock(run.outputPreview)) return false;
  const steps = run.steps;
  if (!steps || steps.length === 0) return true;
  if (steps.some((s) => s.status !== 'success')) return false;
  if (steps.some((s) => answerReportsGateBlock(s.outputPreview))) return false;
  const planned = run.plannedStepCount;
  if (typeof planned === 'number' && Number.isFinite(planned) && planned > steps.length) return false;
  return true;
}
