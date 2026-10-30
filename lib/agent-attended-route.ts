/**
 * Attended "Run now" route decision (DEFERRED.md「マルチエージェント MONITOR
 * ペイン…」 stage (4), design option B).
 *
 * The attended TS chain (lib/agent-manager.ts runAgentOrchestratedBody) is
 * serial by design. The unattended PlanSpec executor
 * (scripts/shelly-plan-executor.js runOrchestrationChain) already dispatches a
 * parallel group's branches for real (withBranchPermit + Promise.allSettled,
 * MAX_PARALLEL_BRANCHES), writes progress.jsonl and honors STOP-ALL in flight.
 * An attended run is handed to the executor ONLY when it would do the same
 * thing the serial chain would, just concurrently:
 *
 *  (a) planParallelGroups gives at least one EFFECTIVE group (>= 2 members) —
 *      otherwise there is nothing to parallelize and the serial chain (with
 *      its per-step escalation ladder and Codex reach) is strictly better;
 *  (b) every step runs on a tool the executor can dispatch
 *      (STEP_TOOL_DISPATCHABLE_TYPES) — both as baked on disk AND as the
 *      attended router would pick it. The executor silently re-routes a `cli`
 *      (Codex) step onto plan.tool, so a chain with any Codex/CLI step stays
 *      serial instead of quietly changing what runs. All steps are checked,
 *      not only the branches, for that reason;
 *  (c) the agent's ON-DISK PlanSpec already describes exactly this chain
 *      (same id, schema, step instructions and group markers, a dispatchable
 *      tool and action). The plan is NEVER rewritten for this route —
 *      alarms read that file, so widening it here would silently change what
 *      every later scheduled fire does.
 *
 * Pure: no I/O. The caller reads the plan file and the ladder env.
 */
import type { Agent, ToolChoice } from '@/store/types';
import { normalizeSteps, planParallelGroups, type NormalizedStep } from './agent-orchestration';
import { resolveEscalationLadder, type LadderEnv } from './agent-escalation-ladder';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from './agent-plan-spec';

/** Mirror of scripts/shelly-plan-executor.js STEP_TOOL_DISPATCHABLE_TYPES. */
export const EXECUTOR_DISPATCHABLE_TOOL_TYPES: ReadonlySet<string> = new Set(['local', 'gemini-api', 'perplexity', 'cerebras', 'groq']);
/** Mirror of AgentRuntime.kt PLAN_EXECUTOR_ACTIONS (native refuses anything else). */
export const EXECUTOR_ACTION_TYPES: ReadonlySet<string> = new Set([
  'draft', 'notify', 'webhook', 'cli', 'intent', 'dm-reply', 'api-call', 'social-post', 'browser-pane', '__suppressed__',
]);

export type AttendedRoute =
  | { route: 'executor'; reason: string; groupCount: number }
  | { route: 'serial'; reason: string };

function serial(reason: string): AttendedRoute {
  return { route: 'serial', reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toolType(v: unknown): string | undefined {
  return isRecord(v) && typeof v.type === 'string' ? v.type : undefined;
}

/** Number of effective (>= 2 member) groups in a planParallelGroups result. */
export function effectiveGroupCount(group: (string | undefined)[]): number {
  const seen = new Set<string>();
  group.forEach((g, i) => {
    if (g !== undefined && group.indexOf(g) !== i) seen.add(g);
  });
  return seen.size;
}

/** The tool the ATTENDED serial chain would try first for step `step`. */
function attendedPrimaryTool(agent: Agent, step: NormalizedStep, env: LadderEnv): ToolChoice | undefined {
  const stepAgent: Agent = { ...agent, orchestration: undefined, tool: step.tool ?? agent.tool };
  return resolveEscalationLadder(stepAgent, env, step.instruction).tools[0];
}

export function decideAttendedRoute(args: {
  /** The EFFECTIVE agent for this run (skill steps already rehydrated). */
  agent: Agent;
  /** Raw text of `.shelly/agents/plans/plan-agent-<id>.json` ('' when absent). */
  planText: string;
  env: LadderEnv;
}): AttendedRoute {
  const { agent, planText, env } = args;
  const steps = normalizeSteps(agent.orchestration);
  if (steps.length < 2) return serial('not a multi-step chain');
  const groups = planParallelGroups(steps).group;
  const groupCount = effectiveGroupCount(groups);
  if (groupCount === 0) return serial('no effective parallel group');
  if (steps.some((s) => s.apiCall)) return serial('api-call step (attended path refuses it)');

  // (b) attended routing: a step the serial chain would hand to Codex/CLI.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].tool && !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(steps[i].tool!.type)) {
      return serial(`step ${i + 1} is pinned to ${steps[i].tool!.type} (not executor-dispatchable)`);
    }
    let primary: ToolChoice | undefined;
    try {
      primary = attendedPrimaryTool(agent, steps[i], env);
    } catch {
      return serial(`step ${i + 1}: route could not be resolved`);
    }
    if (!primary || !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(primary.type)) {
      return serial(`step ${i + 1} routes to ${primary?.type ?? 'nothing'} attended (not executor-dispatchable)`);
    }
  }

  // (c) on-disk PlanSpec must already be this chain.
  let plan: unknown;
  try {
    plan = JSON.parse(String(planText || '').trim());
  } catch {
    return serial('on-disk PlanSpec missing or unreadable');
  }
  if (!isRecord(plan)) return serial('on-disk PlanSpec missing or unreadable');
  if (plan.kind !== PLAN_SPEC_KIND || plan.schemaVersion !== PLAN_SPEC_SCHEMA_VERSION) {
    return serial('on-disk PlanSpec has a different kind/schema');
  }
  if (!isRecord(plan.agent) || plan.agent.id !== agent.id) return serial('on-disk PlanSpec agent id mismatch');
  const planTool = toolType(plan.tool);
  if (!planTool || !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(planTool)) {
    return serial(`on-disk PlanSpec tool ${planTool ?? 'missing'} is not executor-dispatchable`);
  }
  const action = toolType(plan.action);
  if (!action || !EXECUTOR_ACTION_TYPES.has(action)) return serial(`on-disk PlanSpec action ${action ?? 'missing'} unsupported by the executor`);
  if (Array.isArray(plan.actions)) {
    for (const a of plan.actions) {
      const t = toolType(a);
      if (!t || !EXECUTOR_ACTION_TYPES.has(t)) return serial(`on-disk PlanSpec fan-out action ${t ?? 'missing'} unsupported by the executor`);
    }
  }
  const list = isRecord(plan.steps) && Array.isArray(plan.steps.list) ? (plan.steps.list as unknown[]) : null;
  if (!list) return serial('on-disk PlanSpec has no steps (stale)');
  if (list.length !== steps.length) return serial(`on-disk PlanSpec has ${list.length} steps, agent has ${steps.length} (stale)`);
  for (let i = 0; i < steps.length; i++) {
    const disk = list[i];
    if (!isRecord(disk) || disk.instruction !== steps[i].instruction) return serial(`on-disk PlanSpec step ${i + 1} differs (stale)`);
    if ((disk.parallelGroup ?? undefined) !== steps[i].parallelGroup) return serial(`on-disk PlanSpec step ${i + 1} group differs (stale)`);
    if (disk.apiCall) return serial(`on-disk PlanSpec step ${i + 1} is an api-call step`);
    const diskTool = toolType(disk.tool);
    if (diskTool !== undefined && !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(diskTool)) {
      return serial(`on-disk PlanSpec step ${i + 1} tool ${diskTool} would be silently re-routed by the executor`);
    }
  }
  // Isolation-blocked steps fail closed in the executor; keep those serial
  // too so the attended run never fails where the serial chain would not.
  const isolation = isRecord(plan.steps) && Array.isArray(plan.steps.isolation) ? (plan.steps.isolation as unknown[]) : [];
  if (isolation.some((x) => isRecord(x) && typeof x.blocked === 'string')) {
    return serial('on-disk PlanSpec isolation blocks a step');
  }
  return { route: 'executor', reason: `${groupCount} effective parallel group(s), all steps executor-dispatchable, on-disk PlanSpec current`, groupCount };
}
