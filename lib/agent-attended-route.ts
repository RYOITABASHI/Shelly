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
 *  (b) per step, the provider the attended router would pick first
 *      (resolveEscalationLadder on the step's own instruction) is EXACTLY the
 *      executor's effective tool for that step as baked on disk
 *      (shelly-plan-executor.js effectiveStepTool: a dispatchable step.tool,
 *      else plan.tool) — same type and model. This rejects Codex/CLI steps
 *      (the executor silently re-routes them onto plan.tool), `tool: auto`
 *      steps the attended router sends elsewhere than plan.tool, and step pins
 *      buildAgentPlanSpec dropped for an autonomous agent;
 *  (c) a step whose effective tool is local needs plan.tool to be local too:
 *      native only autostarts llama-server when plan.tool.type == 'local'
 *      (AgentRuntime.kt runPlanAgent → ensureLocalLlmServerBeforePlanExecutor);
 *  (d) the ON-DISK PlanSpec is current: it equals a fresh
 *      buildAgentPlanSpec(agent, <the opts materialize would use>) on every
 *      field except generatedAt / prompt / routeDecision (and the isolation
 *      prompt base), which carry the memory recall baked at materialize time.
 *      The plan is NEVER rewritten for this route — alarms read that file, so
 *      widening it here would silently change what every later scheduled fire
 *      does.
 *
 * Pure apart from buildAgentPlanSpec's getHomePath(). The caller reads the
 * plan file and the ladder env.
 */
import type { Agent, ToolChoice } from '@/store/types';
import { normalizeSteps, planParallelGroups, type NormalizedStep } from './agent-orchestration';
import { resolveEscalationLadder, type LadderEnv } from './agent-escalation-ladder';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION, buildAgentPlanSpec, toPlanTool, type BuildAgentPlanSpecOptions } from './agent-plan-spec';

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

function typeOf(v: unknown): string | undefined {
  return isRecord(v) && typeof v.type === 'string' ? v.type : undefined;
}

function modelOf(v: unknown): string | undefined {
  return isRecord(v) && typeof v.model === 'string' && v.model ? v.model : undefined;
}

/** Number of effective (>= 2 member) groups in a planParallelGroups result. */
export function effectiveGroupCount(group: (string | undefined)[]): number {
  const seen = new Set<string>();
  group.forEach((g, i) => {
    if (g !== undefined && group.indexOf(g) !== i) seen.add(g);
  });
  return seen.size;
}

/** The buildAgentPlanSpec opts materializeAgentBody uses for the STORED plan
 *  (install / post-run restore, no runOpts): consent + key flags from disk for
 *  an autonomous agent, nothing otherwise. */
export function storedPlanSpecOpts(agent: Agent, env: LadderEnv): BuildAgentPlanSpecOptions {
  if (!agent.autonomous) return {};
  return {
    autonomousCloudConsent: env.autonomousCloudConsent,
    autonomousCloudStop: env.autonomousCloudStop,
    hasCerebrasKey: env.hasCerebrasKey,
    hasGroqKey: env.hasGroqKey,
  };
}

/** JSON-normalized plan without the fields that legitimately vary between
 *  two materializations of the same agent (time, baked recall text). */
function normalizedPlan(plan: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  delete clone.generatedAt;
  delete clone.prompt;
  delete clone.routeDecision;
  if (isRecord(clone.steps) && Array.isArray(clone.steps.isolation)) {
    clone.steps.isolation = clone.steps.isolation.map((x) => {
      if (!isRecord(x)) return x;
      const { base: _base, ...rest } = x;
      return rest;
    });
  }
  return clone;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** First top-level key whose normalized value differs (for the log line). */
function firstDiffKey(a: unknown, b: unknown): string {
  if (!isRecord(a) || !isRecord(b)) return '(root)';
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys.find((k) => stableStringify(a[k]) !== stableStringify(b[k])) ?? '(none)';
}

/** The tool the ATTENDED serial chain would try first for `step`. */
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
  const groupCount = effectiveGroupCount(planParallelGroups(steps).group);
  if (groupCount === 0) return serial('no effective parallel group');
  if (steps.some((s) => s.apiCall)) return serial('api-call step (attended path refuses it)');

  // ── the on-disk plan must parse, be this agent, and be current ───────────
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
  let fresh: unknown;
  try {
    fresh = buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, env));
  } catch (error) {
    return serial(`could not rebuild the PlanSpec to compare (${error instanceof Error ? error.message : String(error)})`);
  }
  const diskNorm = normalizedPlan(plan);
  const freshNorm = normalizedPlan(fresh);
  if (stableStringify(diskNorm) !== stableStringify(freshNorm)) {
    return serial(`on-disk PlanSpec is stale (differs in "${firstDiffKey(diskNorm, freshNorm)}")`);
  }

  // ── executor-side dispatchability ────────────────────────────────────────
  const planTool = plan.tool;
  const planToolType = typeOf(planTool);
  if (!planToolType || !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(planToolType)) {
    return serial(`on-disk PlanSpec tool ${planToolType ?? 'missing'} is not executor-dispatchable`);
  }
  const action = typeOf(plan.action);
  if (!action || !EXECUTOR_ACTION_TYPES.has(action)) return serial(`on-disk PlanSpec action ${action ?? 'missing'} unsupported by the executor`);
  if (Array.isArray(plan.actions)) {
    for (const a of plan.actions) {
      const t = typeOf(a);
      if (!t || !EXECUTOR_ACTION_TYPES.has(t)) return serial(`on-disk PlanSpec fan-out action ${t ?? 'missing'} unsupported by the executor`);
    }
  }
  const list = isRecord(plan.steps) && Array.isArray(plan.steps.list) ? (plan.steps.list as unknown[]) : null;
  if (!list || list.length !== steps.length) return serial('on-disk PlanSpec steps do not match the agent (stale)');
  // Isolation-blocked steps fail closed in the executor; keep those serial
  // too so the attended run never fails where the serial chain would not.
  const isolation = isRecord(plan.steps) && Array.isArray(plan.steps.isolation) ? (plan.steps.isolation as unknown[]) : [];
  if (isolation.some((x) => isRecord(x) && typeof x.blocked === 'string')) {
    return serial('on-disk PlanSpec isolation blocks a step');
  }

  // ── per step: attended provider == executor effective provider ───────────
  for (let i = 0; i < steps.length; i++) {
    const n = i + 1;
    const disk = list[i];
    if (!isRecord(disk)) return serial(`on-disk PlanSpec step ${n} unreadable`);
    if (disk.apiCall) return serial(`on-disk PlanSpec step ${n} is an api-call step`);
    if (steps[i].tool && !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(steps[i].tool!.type)) {
      return serial(`step ${n} is pinned to ${steps[i].tool!.type} (not executor-dispatchable)`);
    }
    const diskStepType = typeOf(disk.tool);
    if (steps[i].tool && diskStepType === undefined) {
      return serial(`step ${n}'s ${steps[i].tool!.type} pin was dropped from the PlanSpec (autonomous policy) — executor would run plan.tool`);
    }
    if (diskStepType !== undefined && !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(diskStepType)) {
      return serial(`on-disk PlanSpec step ${n} tool ${diskStepType} would be silently re-routed by the executor`);
    }
    const effective = diskStepType !== undefined ? disk.tool : planTool;
    const effectiveType = typeOf(effective)!;
    if (effectiveType === 'local' && planToolType !== 'local') {
      return serial(`step ${n} runs on local but plan.tool is ${planToolType} (native only autostarts llama-server for a local plan.tool)`);
    }
    let primary: ToolChoice | undefined;
    try {
      primary = attendedPrimaryTool(agent, steps[i], env);
    } catch {
      return serial(`step ${n}: route could not be resolved`);
    }
    if (!primary || !EXECUTOR_DISPATCHABLE_TOOL_TYPES.has(primary.type)) {
      return serial(`step ${n} routes to ${primary?.type ?? 'nothing'} attended (not executor-dispatchable)`);
    }
    const attended = toPlanTool(primary);
    const effectiveModel = modelOf(effective) ?? modelOf(toPlanTool({ type: effectiveType } as ToolChoice));
    if (attended.type !== effectiveType || (attended.model ?? undefined) !== effectiveModel) {
      return serial(
        `step ${n} provider drift: attended ${attended.type}${attended.model ? `/${attended.model}` : ''} vs executor ${effectiveType}${effectiveModel ? `/${effectiveModel}` : ''}`,
      );
    }
  }
  return {
    route: 'executor',
    reason: `${groupCount} effective parallel group(s), every step's provider matches the executor, on-disk PlanSpec current`,
    groupCount,
  };
}
