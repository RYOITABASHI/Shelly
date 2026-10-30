/**
 * lib/monitor-provider-pick.ts — what the MONITOR provider picker does when
 * the user picks a provider for a step (camera tap in the single view).
 *
 *  - The step's run is still going: merge the pick into
 *    logs/<id>/overrides.json (lib/agent-provider-overrides.ts) — scoped to
 *    this run, or unscoped for a continuous loop so the next iteration picks
 *    it up — and record it as app-written. The fold into the agent definition
 *    happens on the run-completion path (lib/agent-manager.ts
 *    foldProviderOverridesFromDisk, from the periodic run-log sync), not here,
 *    so it does not depend on MONITOR staying open.
 *  - Nothing is running: save straight into the definition (updateAgent →
 *    re-materialize, which also removes any leftover file).
 *
 * A pick the running executor will not take mid-run — a provider the agent
 * definition does not use yet (the executor only accepts vetted types), or a
 * paid API in a ¥0 continuous loop (only a pin baked into the definition is a
 * paid permission) — is still written so it is folded after the run, but is
 * reported as `appliesNow: false` and never restarts the running step.
 *
 * Exec / update are injected so this stays testable without RN.
 */
import type { Agent } from '@/store/types';
import { continuousExcludesPaidApi, isPaidApiTool } from './agent-continuous';
import {
  buildReadOverridesCommand,
  buildWriteOverridesCommand,
  foldOverridesIntoAgent,
  isAppWrittenOverrides,
  mergeProviderOverride,
  noteAppWrittenOverrides,
  parseProviderOverrides,
  providerPickToTool,
  vetOverrideToolForAgent,
  type ProviderPick,
} from './agent-provider-overrides';

export type PickExec = (command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>;
export type PickUpdate = (agentId: string, partial: Partial<Agent>) => Promise<unknown>;

const EXEC_TIMEOUT_MS = 5000;

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

export interface ProviderPickResult {
  result: 'override' | 'saved' | 'unchanged';
  /** false = takes effect from the next run (see the module comment). */
  appliesNow: boolean;
  /** A paid API picked for a ¥0 continuous loop. */
  paidNextRun: boolean;
}

/** Whether a running executor / serial chain will take this pick mid-run. */
export function pickAppliesMidRun(agent: Agent, pick: ProviderPick): { appliesNow: boolean; paidNextRun: boolean } {
  const tool = providerPickToTool(pick);
  const paidNextRun = continuousExcludesPaidApi(agent) && isPaidApiTool(tool);
  const vetted = vetOverrideToolForAgent(agent, tool) !== undefined;
  return { appliesNow: vetted && !paidNextRun, paidNextRun };
}

export async function applyProviderPick(exec: PickExec, update: PickUpdate, req: ProviderPickRequest): Promise<ProviderPickResult> {
  const tool = providerPickToTool(req.pick);
  const { agent } = req;
  const mid = pickAppliesMidRun(agent, req.pick);
  if (!req.runActive) {
    const partial = foldOverridesIntoAgent(agent, { v: 1, steps: { [String(req.stepIndex)]: { tool } } });
    if (!partial) return { result: 'unchanged', appliesNow: true, paidNextRun: false };
    await update(agent.id, partial);
    return { result: 'saved', appliesNow: true, paidNextRun: false };
  }
  const readCmd = buildReadOverridesCommand(agent.id);
  if (!readCmd) throw new Error('unsafe agent id');
  const current = await exec(readCmd, EXEC_TIMEOUT_MS);
  // Build on the existing file ONLY when this app process wrote it: anything
  // else (a planted step pin) must never be carried into the content we then
  // record as app-written — that record is what makes the post-run fold trust
  // a file. A foreign file is replaced, not merged.
  const existing = parseProviderOverrides(current.stdout);
  const base = isAppWrittenOverrides(agent.id, existing) ? existing : null;
  const merged = mergeProviderOverride(base, {
    // A continuous loop's next iteration has a new runId — leave it unscoped.
    runId: agent.continuous ? undefined : req.runId,
    stepIndex: req.stepIndex,
    tool,
    restart: req.restart && mid.appliesNow,
  });
  const res = await exec(buildWriteOverridesCommand(agent.id, merged), EXEC_TIMEOUT_MS);
  if (res.exitCode !== 0) throw new Error(`write failed (exit ${res.exitCode})`);
  noteAppWrittenOverrides(agent.id, merged);
  return { result: 'override', appliesNow: mid.appliesNow, paidNextRun: mid.paidNextRun };
}
