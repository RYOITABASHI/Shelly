import type { Agent, AgentApiCallConfig, AgentRouteDecision, AgentSocialPostConfig, ToolChoice } from '@/store/types';
import { getHomePath } from '@/lib/home-path';
import { GROQ_DEFAULT_MODEL } from '@/lib/groq';
import { detectRouteSignals } from './agent-router-scoring';
import { resolveForAutonomous } from './agent-credential-policy';
import { resolveAgentRoute, toolChoiceToLabel } from './agent-tool-router';
import {
  agentUsesStudioContext,
  computeAgentSlug,
  sanitizeOutputTemplate,
  selectAutonomousLocalModel,
} from './agent-executor';
import { evaluateAgentActionCommand } from './agent-action-safety';
import { buildAgentPolicy } from './agent-policy';
import { clampCharLimit } from './agent-pipeline-presets';
import { isOrchestrated, normalizeSteps, resolveBudget, type NormalizedStep, type ResolvedBudget } from './agent-orchestration';
import { resolveEscalationLadder, type LadderEnv } from './agent-escalation-ladder';

// NOT bumped for the `steps` field added below (orchestration schema-plumbing
// increment 1, 2026-07-15). A bump here is load-bearing across THREE
// independently-hardcoded mirrors that must move in lockstep or every agent
// run (not just orchestrated ones) fail-closes:
//   1. scripts/shelly-plan-executor.js's own `const PLAN_SPEC_SCHEMA_VERSION`
//      (plain CommonJS, cannot import this .ts file) — strict `!==` check.
//   2. its byte-identical APK asset mirror under
//      modules/terminal-emulator/android/.../assets/shelly-plan-executor.js.
//   3. AgentRuntime.kt's `CURRENT_PLAN_SPEC_VERSION` — strict `!=` check that
//      writes a "stale PlanSpec" error + notification and refuses to launch.
// __tests__/plan-executor-parity.test.ts asserts all three stay equal to this
// constant. `steps` below is purely additive (existing validators here and in
// the JS/Kotlin mirrors only check specific known fields, never reject unknown
// extra keys), so it needs no version bump. The bump — plus updating all three
// mirrors together — is deferred to the increment that teaches those
// executors to actually walk the chain; see the North-Star orchestration
// investigation (2026-07-15) for the multi-increment plan this is step 1 of.
export const PLAN_SPEC_SCHEMA_VERSION = 1;
export const PLAN_SPEC_KIND = 'shelly.agent.plan';

export type PlanToolType =
  | 'local'
  | 'gemini-api'
  | 'perplexity'
  | 'cerebras'
  | 'groq'
  | 'unsupported';

export type PlanActionType = 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply' | 'api-call' | 'social-post' | 'browser-pane' | '__suppressed__' | 'unsupported';

export interface PlanAction {
  type: PlanActionType;
  webhookUrl?: string;
  command?: string;
  intentMode?: 'launch' | 'share';
  intentTarget?: string;
  intentShareText?: string;
  dmPairingId?: string;
  dmReplyText?: string;
  apiCall?: AgentApiCallConfig;
  /** social-post (2026-07-22): platform/connectorId/text only — the
   *  connector's host/meta + secrets are resolved by the executor at run
   *  time from .env (SOCIAL_CONNECTOR_<ID>_*), never carried in the plan. */
  socialPost?: AgentSocialPostConfig;
  /** browser-pane (2026-08-04): mirrors AgentAction.browserPaneAction /
   *  browserPaneUrlAllowlist verbatim — see store/types.ts's doc comment for
   *  the attended-only rationale. scripts/shelly-plan-executor.js's own
   *  unattendedPreflightFailure refuses this type unattended exactly like
   *  intent/dm-reply, with NO Tier-B allowance. */
  browserPaneAction?:
    | { kind: 'click'; selector: string }
    | { kind: 'fill'; selector: string; value: string }
    | { kind: 'extractText'; selector: string };
  browserPaneUrlAllowlist?: string[];
  safety?: ReturnType<typeof evaluateAgentActionCommand>;
  unsupportedReason?: string;
}

export interface AgentPlanSpecV1 {
  kind: typeof PLAN_SPEC_KIND;
  schemaVersion: typeof PLAN_SPEC_SCHEMA_VERSION;
  generatedAt: number;
  agent: {
    id: string;
    name: string;
    autonomous: boolean;
    autonomyLevel: NonNullable<Agent['autonomyLevel']>;
    /** Per-agent override of AppSettings.defaultRequireActionApproval, baked
     *  at plan-build time (project owner directive 2026-07-14). Absent =
     *  scripts/shelly-plan-executor.js's requireActionApprovalTap falls back
     *  to the live global default (config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL,
     *  read from .env so toggling it doesn't require regenerating every plan). */
    requireActionApproval?: boolean;
  };
  prompt: string;
  tool: {
    type: PlanToolType;
    label: string;
    model?: string;
    authRef?: 'gemini' | 'perplexity' | 'cerebras' | 'groq';
    unsupportedReason?: string;
  };
  /** DEFERRED.md「PlanSpec executor 経由の無人発火は、品質ゲートでlocalが弾かれても
   *  エスカレーションラダーへ進まない」: ordered HTTP-dispatchable retry candidates
   *  AFTER `tool` above, from resolveEscalationLadder — computed ONCE here (the
   *  attended path's own single source of truth) so scripts/shelly-plan-executor.js
   *  never needs its own copy of the routing rules, only a plain array to walk.
   *  Non-HTTP-dispatchable entries (cli/codex — this executor cannot spawn a
   *  process) are already filtered out; when the underlying ladder's true next
   *  candidate was one of those, toolLadderExhaustedNote explains why retrying
   *  stopped instead of silently looking like the ladder was never checked.
   *  Always present (possibly empty) once schemaVersion >= this field's
   *  introduction; absent only on a plan loaded from a PRE-existing on-disk
   *  file written by an older app version — see the executor's own
   *  `plan.toolLadder || []` read for that fallback. */
  toolLadder?: AgentPlanSpecV1['tool'][];
  /** Present only when toolLadder was truncated because the underlying ladder
   *  continues into a tool this executor cannot dispatch (Codex) — appended to
   *  the failure message once toolLadder is exhausted, so the run log honestly
   *  says "needs Codex/attended run" instead of a bare unexplained failure. */
  toolLadderExhaustedNote?: string;
  action: PlanAction;
  /** Multi-action fan-out (2026-07-23, mirrors Agent.actions — see its own
   *  doc comment in store/types.ts): present ONLY when agent.actions has
   *  >= 2 entries; absent for every ordinary single-action agent, so writing
   *  this key is a no-op for their plan/behavior (purely additive, same
   *  precedent as `steps` above — no PLAN_SPEC_SCHEMA_VERSION bump needed).
   *  `action` above is still always populated (built from agent.action, the
   *  legacy single field — 'draft' when unset) purely so every existing
   *  reader that only knows about `action` keeps seeing a valid value; it is
   *  NOT dispatched when `actions` is present — see
   *  scripts/shelly-plan-executor.js's dispatchActionsTrusted, which checks
   *  `actions.length >= 2` before ever consulting `action` for dispatch. */
  actions?: PlanAction[];
  paths: {
    home: string;
    envFile: string;
    tmpDir: string;
    locksDir: string;
    logsDir: string;
    resultFile: string;
    lockFile: string;
    logDir: string;
  };
  output: {
    outputDir: string;
    outputNameTemplate: string;
    slug: string;
    useGlobalOutput: boolean;
    suggestedRoots: string[];
  };
  limits: {
    timeoutSeconds: number;
    maxConcurrent: number;
    charLimit?: number;
  };
  policy: ReturnType<typeof buildAgentPolicy>;
  routeDecision: AgentRouteDecision;
  /** Orchestration schema plumbing (Increment 1, 2026-07-15). Present ONLY
   *  when isOrchestrated(agent.orchestration) is true (≥2 real steps); absent
   *  for every single-step agent, so writing this key is a no-op for their
   *  behavior. `list`/`budget` are exactly what normalizeSteps()/
   *  resolveBudget() (the existing pure helpers agent-orchestration.ts
   *  already exports and runAgentOrchestrated() already uses for the manual
   *  "Run now" path) independently compute for the same agent — no logic is
   *  re-derived here.
   *  Consumed by scripts/shelly-plan-executor.js's runOrchestrationChain
   *  (Increment 2, `ac6a324f2`) whenever this key is present — the executor
   *  walks `list` under `budget` in-process rather than dispatching `prompt`
   *  as a single call. AgentRuntime.kt's shouldRunPlanExecutor() detects this
   *  key's presence on disk to route a scheduled/unattended fire to the plan
   *  executor instead of the legacy single-shot `.sh` script (North Star
   *  P0(c) fix) — see planSpecHasOrchestrationSteps() there. Additive only:
   *  the key's absence still reduces to today's exact single-step behavior,
   *  which is why PLAN_SPEC_SCHEMA_VERSION was never bumped for this field
   *  (see the comment above PLAN_SPEC_SCHEMA_VERSION for why). */
  steps?: {
    list: NormalizedStep[];
    budget: ResolvedBudget;
  };
}

export type BuildAgentPlanSpecOptions = {
  suppressAction?: boolean;
  autonomousCloudConsent?: boolean;
  autonomousCloudStop?: boolean;
  /** DEFERRED.md「PlanSpec executor 経由の無人発火は、品質ゲートでlocalが弾かれても
   *  エスカレーションラダーへ進まない」: free-cloud key presence, used ONLY to bake
   *  toolLadder below (whether a Cerebras/Groq retry hop is worth including —
   *  mirrors lib/agent-manager.ts's ladderEnvFromDisk/LadderEnv exactly).
   *  Absent → defaults to true (fail-open to "try it"), matching
   *  ladderEnvFromDisk's own read-failure default. */
  hasCerebrasKey?: boolean;
  hasGroqKey?: boolean;
};

function planPaths(home: string, agentId: string) {
  const shellyDir = `${home}/.shelly`;
  const agentsDir = `${shellyDir}/agents`;
  const tmpDir = `${shellyDir}/tmp`;
  const locksDir = `${agentsDir}/locks`;
  const logsDir = `${agentsDir}/logs`;
  return {
    home,
    shellyDir,
    agentsDir,
    plansDir: `${agentsDir}/plans`,
    envFile: `${agentsDir}/.env`,
    tmpDir,
    locksDir,
    logsDir,
    resultFile: `${tmpDir}/agent-result-${agentId}.md`,
    lockFile: `${locksDir}/${agentId}.pid`,
    logDir: `${logsDir}/${agentId}`,
  };
}

export function getPlanSpecPath(agentId: string): string {
  return `${planPaths(getHomePath(), agentId).plansDir}/plan-agent-${agentId}.json`;
}

export function buildAgentPlanSpec(
  agent: Agent,
  opts: BuildAgentPlanSpecOptions = {},
): AgentPlanSpecV1 {
  const home = getHomePath();
  const paths = planPaths(home, agent.id);
  const routeResolution = resolveAgentRoute(agent);
  const promptSignals = detectRouteSignals(agent.prompt);
  let tool: ToolChoice = routeResolution.tool;
  let unsupportedToolReason: string | undefined;
  // Scoped above the `if (agent.autonomous)` block below so the per-step
  // resolution near `orchestrationSteps` (Phase 7, 2026-08-03) can reuse the
  // EXACT same web-consent exception the agent-level tool already gets —
  // two independently-computed copies of this condition would drift.
  const consentWebTool =
    opts.autonomousCloudConsent === true &&
    promptSignals.needsWeb &&
    (tool.type === 'gemini-api' || tool.type === 'perplexity');

  if (agent.autonomous) {
    if (!consentWebTool) {
      const resolved = resolveForAutonomous(tool);
      if (resolved) {
        tool = resolved;
      } else {
        unsupportedToolReason = `autonomous mode does not allow ${tool.type}`;
      }
    }
  }
  if (agent.autonomous && tool.type === 'local' && !tool.model) {
    tool = { ...tool, model: selectAutonomousLocalModel(agent.prompt) };
  }

  const toolSpec = toPlanTool(tool, unsupportedToolReason);
  const toolLabel = toolSpec.label;
  // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ進まない」:
  // the SAME ladder the attended path already trusts (resolveEscalationLadder),
  // computed once here and serialized as plain data — see AgentPlanSpecV1.toolLadder's
  // doc comment for why the executor gets no logic of its own. hasCerebrasKey/
  // hasGroqKey default true (see BuildAgentPlanSpecOptions doc comment);
  // Perplexity/Gemini key-presence is intentionally left unknown here (the
  // ladder itself treats that as "assume present", LadderEnv's own default).
  const ladderEnv: LadderEnv = {
    hasCerebrasKey: opts.hasCerebrasKey ?? true,
    hasGroqKey: opts.hasGroqKey ?? true,
    autonomousCloudConsent: opts.autonomousCloudConsent,
    autonomousCloudStop: opts.autonomousCloudStop,
  };
  const fullLadder = resolveEscalationLadder(agent, ladderEnv).tools;
  const toolLadder = fullLadder
    .filter((candidate) => candidate.type !== tool.type)
    .map((candidate) => toPlanTool(candidate))
    .filter((planTool) => planTool.type !== 'unsupported');
  const toolLadderExhaustedNote =
    fullLadder.some((candidate) => candidate.type !== tool.type && candidate.type === 'cli')
      ? 'Every HTTP-dispatchable backend in the escalation ladder failed. This agent’s ladder continues to Codex, which the unattended PlanSpec executor cannot dispatch (Codex requires a spawned CLI process) — run this agent attended (Run now / @agent) or resolve it to a Codex tool to reach that step.'
      : undefined;
  const routeDecision: AgentRouteDecision = {
    ...routeResolution.decision,
    toolType: tool.type,
    toolLabel,
    route: tool.type === 'local' ? 'on-device' : tool.type === 'ab-article-eval' ? 'hybrid' : 'cloud',
  };

  const actionType: NonNullable<Agent['action']>['type'] | '__suppressed__' =
    opts.suppressAction ? '__suppressed__' : (agent.action?.type ?? 'draft');
  const action: PlanAction = toPlanAction(actionType, agent.action);
  // Multi-action fan-out (mirrors lib/agent-executor.ts's generateRunScript
  // `useMultiActions` gate exactly): only when NOT a suppressed orchestration
  // step (a non-final step never dispatches any action, single or multi) AND
  // agent.actions has >= 2 entries. `action` above is left untouched either
  // way — see PlanAction's own doc comment for why it stays populated.
  const multiActions: PlanAction[] | undefined =
    !opts.suppressAction && agent.actions && agent.actions.length >= 2
      ? agent.actions.map((a) => toPlanAction(a.type, a))
      : undefined;

  const slug = computeAgentSlug(agent.name, agent.id);
  const outputNameTemplate = sanitizeOutputTemplate(agent.outputTemplate);
  const outputDir = agent.outputPath.replace(/^~/, home).replace(/^\$HOME/, home);
  const useGlobalOutput = !agentUsesStudioContext(agent);
  const charLimit =
    typeof agent.orchestration?.charLimit === 'number'
      ? clampCharLimit(agent.orchestration.charLimit)
      : undefined;
  // Phase 7 (2026-08-03): resolve each step's own tool pin through the SAME
  // resolveForAutonomous gate the agent-level `tool` above already goes
  // through, at this single plan-build chokepoint — never on-device. Before
  // this, a step.tool pin was written into the PlanSpec JSON completely
  // unvetted (a step could name an api-key-class tool like Perplexity/Gemini
  // even when the agent has no Autonomous Cloud consent), and the unattended
  // PlanSpec executor (scripts/shelly-plan-executor.js) simply ignored
  // step.tool outright rather than deal with that — see its own comment at
  // runOrchestrationChain. Now that this function only ever emits an
  // ALREADY-VETTED step.tool (or strips it), the executor can safely start
  // honoring it (see runOrchestrationChain's own comment for the consuming
  // half of this fix). A step whose tool the policy disallows unattended
  // does NOT block the chain or drop the step — it just falls back to the
  // step running with the agent-level `tool` instead, identical to how it
  // behaved before this pin existed.
  const resolveStepToolForPlan = (step: NormalizedStep): NormalizedStep => {
    if (!step.tool || !agent.autonomous) return step;
    if (consentWebTool && (step.tool.type === 'gemini-api' || step.tool.type === 'perplexity')) return step;
    const resolved = resolveForAutonomous(step.tool);
    if (resolved) return { ...step, tool: resolved };
    const { tool: _dropped, ...rest } = step;
    return rest;
  };
  const orchestrationSteps = isOrchestrated(agent.orchestration)
    ? {
        list: normalizeSteps(agent.orchestration).map(resolveStepToolForPlan),
        budget: resolveBudget(agent.orchestration),
      }
    : undefined;

  return {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: Date.now(),
    agent: {
      id: agent.id,
      name: agent.name,
      autonomous: agent.autonomous === true,
      autonomyLevel: agent.autonomyLevel ?? 'L2',
      requireActionApproval: agent.requireActionApproval,
    },
    prompt: buildExecutorPrompt(agent.prompt),
    tool: toolSpec,
    toolLadder,
    ...(toolLadderExhaustedNote ? { toolLadderExhaustedNote } : {}),
    action,
    ...(multiActions ? { actions: multiActions } : {}),
    paths: {
      home: paths.home,
      envFile: paths.envFile,
      tmpDir: paths.tmpDir,
      locksDir: paths.locksDir,
      logsDir: paths.logsDir,
      resultFile: paths.resultFile,
      lockFile: paths.lockFile,
      logDir: paths.logDir,
    },
    output: {
      outputDir,
      outputNameTemplate,
      slug,
      useGlobalOutput,
      suggestedRoots: [
        `${home}/agent-output`,
        paths.tmpDir,
        `${home}/projects/shelly-content-studio`,
        outputDir,
        '/sdcard/Documents/ObsidianVault',
      ],
    },
    limits: {
      timeoutSeconds: 600,
      maxConcurrent: 2,
      ...(charLimit !== undefined ? { charLimit } : {}),
    },
    policy: buildAgentPolicy(agent, agent.workspaceRoot || home),
    routeDecision,
    ...(orchestrationSteps ? { steps: orchestrationSteps } : {}),
  };
}

function toPlanAction(
  actionType: NonNullable<Agent['action']>['type'] | '__suppressed__',
  action?: Agent['action'],
): PlanAction {
  switch (actionType) {
    case 'draft':
    case 'notify':
    case '__suppressed__':
      return { type: actionType };
    case 'webhook':
      return { type: 'webhook', webhookUrl: action?.webhookUrl };
    case 'cli':
      return {
        type: 'cli',
        command: action?.command,
        safety: evaluateAgentActionCommand(action?.command ?? ''),
      };
    case 'intent':
      return {
        type: 'intent',
        intentMode: action?.intentMode,
        intentTarget: action?.intentTarget,
        intentShareText: action?.intentShareText,
      };
    case 'dm-reply':
      return {
        type: 'dm-reply',
        dmPairingId: action?.dmPairingId,
        dmReplyText: action?.dmReplyText,
      };
    case 'api-call':
      return { type: 'api-call', apiCall: action?.apiCall };
    case 'social-post':
      return { type: 'social-post', socialPost: action?.socialPost };
    case 'browser-pane':
      return {
        type: 'browser-pane',
        browserPaneAction: action?.browserPaneAction,
        browserPaneUrlAllowlist: action?.browserPaneUrlAllowlist,
      };
    default:
      return {
        type: 'unsupported',
        webhookUrl: action?.webhookUrl,
        command: action?.command,
        safety: evaluateAgentActionCommand(action?.command ?? ''),
        unsupportedReason: `PlanSpec executor does not support ${actionType} actions yet`,
      };
  }
}

function toPlanTool(tool: ToolChoice, unsupportedReason?: string): AgentPlanSpecV1['tool'] {
  if (unsupportedReason) {
    return { type: 'unsupported', label: toolChoiceToLabel(tool), unsupportedReason };
  }
  switch (tool.type) {
    case 'local':
      return { type: 'local', label: toolChoiceToLabel(tool), model: tool.model || 'Qwen3.5-0.8B-Q4_K_M' };
    case 'gemini-api':
      return { type: 'gemini-api', label: toolChoiceToLabel(tool), model: tool.model || 'gemini-2.5-flash', authRef: 'gemini' };
    case 'perplexity':
      return { type: 'perplexity', label: toolChoiceToLabel(tool), model: tool.model || 'sonar', authRef: 'perplexity' };
    case 'cerebras':
      return { type: 'cerebras', label: toolChoiceToLabel(tool), model: tool.model || 'gpt-oss-120b', authRef: 'cerebras' };
    case 'groq':
      return { type: 'groq', label: toolChoiceToLabel(tool), model: tool.model || GROQ_DEFAULT_MODEL, authRef: 'groq' };
    default:
      return {
        type: 'unsupported',
        label: toolChoiceToLabel(tool),
        unsupportedReason: `PlanSpec executor does not support ${tool.type} tools yet`,
      };
  }
}

function buildExecutorPrompt(prompt: string): string {
  const signals = detectRouteSignals(prompt);
  if (!signals.needsWeb) return prompt;
  return [
    'You are a research-collection agent. Execute this task now.',
    'Return only a Markdown bullet list with real primary-source URLs.',
    '',
    'Task:',
    prompt,
  ].join('\n');
}

export function validateAgentPlanSpec(value: unknown): { ok: true; spec: AgentPlanSpecV1 } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'plan is not an object' };
  const spec = value as Partial<AgentPlanSpecV1>;
  if (spec.kind !== PLAN_SPEC_KIND) return { ok: false, reason: 'plan kind mismatch' };
  if (spec.schemaVersion !== PLAN_SPEC_SCHEMA_VERSION) return { ok: false, reason: 'plan schema version mismatch' };
  if (!spec.agent || typeof spec.agent.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(spec.agent.id)) {
    return { ok: false, reason: 'plan agent id is invalid' };
  }
  if (typeof spec.prompt !== 'string') return { ok: false, reason: 'plan prompt is invalid' };
  if (!spec.tool || typeof spec.tool.type !== 'string') return { ok: false, reason: 'plan tool is invalid' };
  if (!spec.action || typeof spec.action.type !== 'string') return { ok: false, reason: 'plan action is invalid' };
  if (!spec.paths || typeof spec.paths.home !== 'string') return { ok: false, reason: 'plan paths are invalid' };
  if (
    spec.limits &&
    spec.limits.charLimit !== undefined &&
    (typeof spec.limits.charLimit !== 'number' || !Number.isFinite(spec.limits.charLimit))
  ) {
    return { ok: false, reason: 'plan char limit is invalid' };
  }
  return { ok: true, spec: spec as AgentPlanSpecV1 };
}
