import type { Agent, AgentRouteDecision, ToolChoice } from '@/store/types';
import { getHomePath } from '@/lib/home-path';
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

export type PlanActionType = 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply' | 'app-act' | '__suppressed__' | 'unsupported';

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
  action: {
    type: PlanActionType;
    webhookUrl?: string;
    command?: string;
    intentMode?: 'launch' | 'share';
    intentTarget?: string;
    intentShareText?: string;
    dmPairingId?: string;
    dmReplyText?: string;
    appActRecipeId?: string;
    appActParams?: Record<string, string>;
    safety?: ReturnType<typeof evaluateAgentActionCommand>;
    unsupportedReason?: string;
  };
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
  /** Increment 1 orchestration schema plumbing (2026-07-15). Present ONLY when
   *  isOrchestrated(agent.orchestration) is true (≥2 real steps); absent for
   *  every single-step agent, so this is a no-op for today's exact behavior.
   *  `list`/`budget` are exactly what normalizeSteps()/resolveBudget() (the
   *  existing pure helpers agent-orchestration.ts already exports and
   *  runAgentOrchestrated() already uses for the manual "Run now" path)
   *  independently compute for the same agent — no logic is re-derived here.
   *  Zero runtime consumer yet: scripts/shelly-plan-executor.js, its APK asset
   *  mirror, and AgentRuntime.kt all still only ever dispatch `prompt` as a
   *  single call and simply ignore this key. A later increment teaches the
   *  executor to walk `list` under `budget` and bumps PLAN_SPEC_SCHEMA_VERSION
   *  (see the comment above PLAN_SPEC_SCHEMA_VERSION for why that bump is
   *  deliberately NOT done here). */
  steps?: {
    list: NormalizedStep[];
    budget: ResolvedBudget;
  };
}

export type BuildAgentPlanSpecOptions = {
  suppressAction?: boolean;
  autonomousCloudConsent?: boolean;
  autonomousCloudStop?: boolean;
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

  if (agent.autonomous) {
    const consentWebTool =
      opts.autonomousCloudConsent === true &&
      promptSignals.needsWeb &&
      (tool.type === 'gemini-api' || tool.type === 'perplexity');
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
  const routeDecision: AgentRouteDecision = {
    ...routeResolution.decision,
    toolType: tool.type,
    toolLabel,
    route: tool.type === 'local' ? 'on-device' : tool.type === 'ab-article-eval' ? 'hybrid' : 'cloud',
  };

  const actionType: NonNullable<Agent['action']>['type'] | '__suppressed__' =
    opts.suppressAction ? '__suppressed__' : (agent.action?.type ?? 'draft');
  const action: AgentPlanSpecV1['action'] = toPlanAction(actionType, agent.action);

  const slug = computeAgentSlug(agent.name, agent.id);
  const outputNameTemplate = sanitizeOutputTemplate(agent.outputTemplate);
  const outputDir = agent.outputPath.replace(/^~/, home).replace(/^\$HOME/, home);
  const useGlobalOutput = !agentUsesStudioContext(agent);
  const charLimit =
    typeof agent.orchestration?.charLimit === 'number'
      ? clampCharLimit(agent.orchestration.charLimit)
      : undefined;
  const orchestrationSteps = isOrchestrated(agent.orchestration)
    ? { list: normalizeSteps(agent.orchestration), budget: resolveBudget(agent.orchestration) }
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
    action,
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
): AgentPlanSpecV1['action'] {
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
    case 'app-act':
      return {
        type: 'app-act',
        appActRecipeId: action?.appActRecipeId,
        appActParams: action?.appActParams,
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
      return { type: 'cerebras', label: toolChoiceToLabel(tool), model: tool.model || 'qwen-3-235b-a22b-instruct-2507', authRef: 'cerebras' };
    case 'groq':
      return { type: 'groq', label: toolChoiceToLabel(tool), model: tool.model || 'llama-3.3-70b-versatile', authRef: 'groq' };
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
