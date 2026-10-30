/**
 * lib/monitor-provider-pick.ts — what the MONITOR provider picker does when
 * the user picks a provider for a step (camera tap in the single view).
 *
 *  - The step's run is still going: merge the pick into
 *    logs/<id>/overrides.json (lib/agent-provider-overrides.ts) — scoped to
 *    this run, or unscoped for a continuous loop so the next iteration picks
 *    it up — and remember to fold it into the agent definition once the run
 *    has ended (foldPendingProviderOverride).
 *  - Nothing is running: fold straight into the definition (updateAgent →
 *    re-materialize), no file.
 *
 * Exec / update are injected so this stays testable without RN.
 */
import type { Agent } from '@/store/types';
import {
  buildClearOverridesCommand,
  buildReadOverridesCommand,
  buildWriteOverridesCommand,
  foldOverridesIntoAgent,
  mergeProviderOverride,
  parseProviderOverrides,
  providerPickToTool,
  type ProviderPick,
} from './agent-provider-overrides';

export type PickExec = (command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>;
export type PickUpdate = (agentId: string, partial: Partial<Agent>) => Promise<unknown>;

const EXEC_TIMEOUT_MS = 5000;

/** Agents whose override must still be folded once their run has ended. */
const pendingFolds = new Set<string>();

export function hasPendingProviderFold(agentId: string): boolean {
  return pendingFolds.has(agentId);
}

export function __resetPendingProviderFoldsForTests(): void {
  pendingFolds.clear();
}

export interface ProviderPickRequest {
  agent: Agent;
  stepIndex: number;
  pick: ProviderPick;
  /** 「今のステップをやり直す」: abort the running step and rerun it. */
  restart: boolean;
  /** The live run (progress runId) and whether it is still going. */
  runId?: string;
  runActive: boolean;
}

export type ProviderPickResult = 'override' | 'saved' | 'unchanged';

export async function applyProviderPick(exec: PickExec, update: PickUpdate, req: ProviderPickRequest): Promise<ProviderPickResult> {
  const tool = providerPickToTool(req.pick);
  const { agent } = req;
  if (!req.runActive) {
    const partial = foldOverridesIntoAgent(agent, { v: 1, steps: { [String(req.stepIndex)]: { tool } } });
    if (!partial) return 'unchanged';
    await update(agent.id, partial);
    return 'saved';
  }
  const readCmd = buildReadOverridesCommand(agent.id);
  if (!readCmd) throw new Error('unsafe agent id');
  const current = await exec(readCmd, EXEC_TIMEOUT_MS);
  const merged = mergeProviderOverride(parseProviderOverrides(current.stdout), {
    // A continuous loop's next iteration has a new runId — leave it unscoped.
    runId: agent.continuous ? undefined : req.runId,
    stepIndex: req.stepIndex,
    tool,
    restart: req.restart,
  });
  const res = await exec(buildWriteOverridesCommand(agent.id, merged), EXEC_TIMEOUT_MS);
  if (res.exitCode !== 0) throw new Error(`write failed (exit ${res.exitCode})`);
  pendingFolds.add(agent.id);
  return 'override';
}

/** After the run: fold overrides.json into the definition and remove it.
 *  Returns true when the agent definition was updated. */
export async function foldPendingProviderOverride(exec: PickExec, update: PickUpdate, agent: Agent): Promise<boolean> {
  if (!pendingFolds.has(agent.id)) return false;
  pendingFolds.delete(agent.id);
  const readCmd = buildReadOverridesCommand(agent.id);
  if (!readCmd) return false;
  const current = await exec(readCmd, EXEC_TIMEOUT_MS);
  const partial = foldOverridesIntoAgent(agent, parseProviderOverrides(current.stdout));
  if (partial) await update(agent.id, partial);
  await exec(buildClearOverridesCommand(agent.id), EXEC_TIMEOUT_MS);
  return !!partial;
}
