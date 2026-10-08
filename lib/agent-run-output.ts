/**
 * lib/agent-run-output.ts — where an agent run's saved output lives.
 *
 * Pure helpers (no store / native imports) shared by the attended chain
 * (lib/agent-manager.ts runAgentOrchestratedBody), the Sidebar agent detail
 * popup's "Open" button, and the completion notices, so all three agree on
 * which run-log field names the saved draft.
 */
import type { AgentRunLog } from '@/store/types';

export type AgentRunOutputFields = Pick<AgentRunLog, 'savedPath' | 'savedPathMirror' | 'actionResults'>;

/**
 * Pick the fields of an orchestrated chain's FINAL step log that the
 * aggregate run log must carry forward (the per-step log itself is deleted
 * when the aggregate replaces it): the saved draft path(s) and the
 * multi-action fan-out detail. Only non-empty values are copied so the
 * aggregate JSON is unchanged for runs that saved nothing.
 */
export function pickFinalStepOutput(log: AgentRunOutputFields | undefined): AgentRunOutputFields {
  if (!log) return {};
  return {
    ...(log.savedPath ? { savedPath: log.savedPath } : {}),
    ...(log.savedPathMirror ? { savedPathMirror: log.savedPathMirror } : {}),
    ...(log.actionResults && log.actionResults.length ? { actionResults: log.actionResults } : {}),
  };
}

/** The file an "Open" affordance should open for this run, if any. */
export function agentRunOpenPath(log: Pick<AgentRunLog, 'savedPath'> | undefined): string | undefined {
  const p = log?.savedPath?.trim();
  return p ? p : undefined;
}
