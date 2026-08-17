/**
 * lib/agent-manager.ts — Agent CRUD, orchestration, and @agent command parsing.
 * Entry point for all agent operations from the chat UI.
 */
import { useAgentStore } from '@/store/agent-store';
import { Agent, AgentRunLog, ToolChoice } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { sanitizeAgentName } from './sanitize-agent-name';
import { resolveForAutonomous } from './agent-credential-policy';
import { resolveEscalationLadder, attemptFailed, isDeterministicDispatchFailure, isLocalFallbackDigest, LadderEnv, EscalationLadder } from './agent-escalation-ladder';
import { logInfo, logWarn } from './debug-logger';
import { generateRunScript, generateStopCommand, generateInstallCommands, getScriptPath, getChainLockDir } from './agent-executor';
import { buildAgentPlanSpec, getPlanSpecPath } from './agent-plan-spec';
import { installSchedule, uninstallSchedule, nextTriggerMs, isScheduleMissed, MISSED_RUN_GRACE_MS } from './agent-scheduler';
import { t } from '@/lib/i18n';
import { shouldTripCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_THRESHOLD } from './agent-circuit-breaker';
import {
  buildGlobalRecallContext,
  buildRecallContext,
  extractRunDigest,
  GLOBAL_MEMORY_SCOPE,
  makeGlobalMemoryNote,
  makeMemoryNote,
  readGlobalMemoryNotes,
  readMemoryNotes,
  recallMemoryNotes,
  writeMemoryNote,
  type MemoryNoteType,
} from './agent-memory';
// MEMORY-001 shadow/activation seam (live: MEMORY_ENABLED=true since 2026-08-05,
// see lib/memory/wiring.ts): flag + entry points imported from their own
// modules (not the '@/lib/memory' index) so host memory tests that import the
// index never transitively load expo-file-system via fs-expo.
import { MEMORY_ENABLED } from './memory/wiring';
import { shadowMemoryRecall, activateMemoryRecall, activateMemoryWrite, invalidateMemoryImportCache } from './memory/shadow';
import {
  buildSkillInjectionContext,
  applyExecutableSkillPlan,
  bumpSkillUsage,
  readSkillRecipes,
  writeSkillRecipe,
} from './agent-skills';
import { saveUnattendedSkillWithNotification } from './unattended-skill-save';
import {
  applyUnattendedSkillImprovement,
  clearSkillImprovementProposal,
  proposeSkillImprovement,
  stageSkillImprovementProposal,
} from './skill-self-improve';
import { runSkillCuratorSweep } from './skill-curator';
import {
  buildStepPrompt,
  combineFinalPreview,
  isOrchestrated,
  nextStepGate,
  normalizeSteps,
  planParallelGroups,
  reduceStatus,
  resolveBudget,
} from './agent-orchestration';
import type { AgentRunStep } from '@/store/types';
import { getHomePath } from '@/lib/home-path';
import {
  agentRollbackWorkspaceRoot,
  isRollbackEligibleRun,
  runWouldRequireApprovalTap,
  type ReversibilitySettings,
} from '@/lib/agent-action-reversibility';
import {
  captureRollbackPoint,
  prepareRollbackWorkspace,
  undoAgentRun,
  type AgentRollbackHandle,
  type RollbackRunCommand,
} from '@/lib/agent-rollback';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';

const agentsDir = () => `${getHomePath()}/.shelly/agents`;
export const DELETED_AGENT_MARKER_DIR = '.deleted';
const deletedAgentsDir = () => `${agentsDir()}/${DELETED_AGENT_MARKER_DIR}`;
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
// This is the UNATTENDED default (native alarm fires and other background
// callers that never pass waitTimeoutMs). It intentionally stays generous —
// the ladder-TOCTOU comment on runLadderAttempts's materializeAgent call
// depends on this being the real worst-case window a mid-ladder consent
// revoke has to land in. bug #164 (docs/superpowers/DEFERRED.md): an
// ATTENDED call (chat-triggered "Run Now" / the post-registration
// ephemeral one-shot auto-run in hooks/use-ai-pane-dispatch.ts) that never
// overrides this DOES eventually reject with "Timed out waiting for agent"
// (waitForAgentRunCompletion below is bounded, not an infinite loop — see
// its own doc comment) — but a human staring at an empty/"Running…" chat
// bubble for up to 20 minutes with zero incremental feedback is
// indistinguishable from a genuine hang and burns CPU/battery the whole
// time via AGENT_RUN_WAIT_POLL_MS's 1.5s find-log poll. Attended call sites
// pass ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS instead so a stuck run fails fast
// with a visible chat error.
const AGENT_RUN_WAIT_TIMEOUT_MS = 20 * 60_000;
const AGENT_RUN_WAIT_POLL_MS = 1_500;
/** Bound for a human-attended, chat-visible run (explicit "@agent run" and the
 * post-registration ephemeral one-shot auto-run). Generous enough for a slow
 * cloud API call, on-device LLM inference, or a short Codex-driver turn, but
 * short enough that a stuck run surfaces a visible error well within the
 * time a user will plausibly wait looking at a chat bubble, instead of
 * silently polling for up to the unattended 20-minute ceiling. Raised from 5
 * to 10 minutes (2026-08-04, on-device repro: a single Perplexity
 * sonar-deep-research orchestration step legitimately took 330s and got cut
 * off by the old 300s cap, killing the whole chain before later steps ran —
 * multi-step orchestrated agents with a slow research step need the extra
 * headroom). */
export const ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS = 10 * 60_000;

export function isSafeAgentId(agentId: unknown): agentId is string {
  // typeof guard first: RegExp.test coerces its argument, so a missing id
  // (undefined) would stringify to "undefined" — which MATCHES the id regex —
  // and let arbitrary non-agent JSON pass as an "agent". See isAgentMetadata.
  return typeof agentId === 'string' && SAFE_AGENT_ID_RE.test(agentId);
}

/**
 * Shape guard for metadata loaded from ~/.shelly/agents/*.json. The agents dir
 * also holds NON-agent top-level json files (dm-pairings.json — a JSON array —
 * and the policy.json deny-path), plus whatever future sidecar files land
 * there. Before this guard, any JSON.parse-able chunk slipped through
 * isSafeAgentId(parsed.id) via the "undefined" string coercion above and
 * rendered as a blank ghost row in the Sidebar AGENT list. Require the
 * minimal Agent contract: a plain object with safe string id and string
 * name/prompt (every writer persists the full Agent shape).
 */
export function isAgentMetadata(value: unknown): value is Agent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<Agent>;
  return (
    isSafeAgentId(record.id) &&
    typeof record.name === 'string' &&
    typeof record.prompt === 'string'
  );
}

function assertSafeAgentId(agentId: string): void {
  if (!isSafeAgentId(agentId)) {
    throw new Error(`refusing agent operation with unsafe id: ${agentId}`);
  }
}

export function filterDeletedAgentMetadata(
  agents: Agent[],
  deletedIds: ReadonlySet<string>
): Agent[] {
  const safeAgents = agents.filter((agent) => isSafeAgentId(agent.id));
  if (deletedIds.size === 0) return safeAgents;
  return safeAgents.filter((agent) => !deletedIds.has(agent.id));
}

/**
 * Parse @agent commands from chat input.
 *
 * Supported commands:
 *   @agent list               — List all agents
 *   @agent run <name>         — Manual trigger
 *   @agent stop <name>        — Stop running agent
 *   @agent delete <name>      — Delete agent
 *   @agent edit <name>        — Edit agent (opens creation flow)
 *   @agent history <name>     — Show run history
 *   @agent status             — All agents status summary
 *   @agent <natural language> — Create new agent via wizard
 */
export interface AgentCommandResult {
  type: 'list' | 'run' | 'stop' | 'delete' | 'history' | 'status' | 'create' | 'error';
  message: string;
  data?: any;
}

/**
 * Result of resolveAgentByNameLoose: exactly one of `agent` (a unique
 * resolution — possibly null when nothing matched at all) or `ambiguous`
 * (2+ candidates tied at the same match tier) is populated.
 */
export interface AgentNameResolution {
  agent: Agent | null;
  ambiguous?: Agent[];
}

/** Strip a trailing ellipsis — the real "…" (U+2026) char OR a naive "..."
 *  someone typed in its place — so a name copied verbatim off a UI surface
 *  that itself visually truncates (e.g. Sidebar's `numberOfLines={1}` row)
 *  still prefix-matches the real, un-truncated stored agent.name. */
function stripTrailingEllipsis(s: string): string {
  return s.replace(/(?:…|\.{3})\s*$/, '');
}

/**
 * Resolve `@agent run/stop/delete/history/edit <name>`'s free-text name
 * argument against the registered agents — tolerant of common near-misses
 * instead of requiring a byte-exact match (2026-08-13 on-device QA finding:
 * lib/agent-nl-parser.ts's deriveName used to hard-truncate the PERSISTED
 * agent.name with a trailing "…" for display purposes, so a name copied
 * from the Sidebar and typed back here could easily be a truncated/partial
 * or off-by-a-character version of the real stored name; deriveName no
 * longer truncates at all, but this stays as defense-in-depth for any name
 * a user free-hand retypes, abbreviates, or copies from a UI surface that
 * still elides on its own — e.g. a notification title or Sidebar row).
 *
 * Falls through three tiers, stopping at the FIRST tier that produces any
 * match at all:
 *   1. exact match (case-insensitive, trimmed) — same semantics as
 *      store/agent-store.ts's getAgentByName.
 *   2. case-insensitive PREFIX match, after stripping a trailing ellipsis
 *      from the query (see stripTrailingEllipsis).
 *   3. case-insensitive SUBSTRING match anywhere in the stored name.
 *
 * If a tier produces exactly one match, that agent is returned. If a tier
 * produces MORE THAN ONE, resolution stops there and `ambiguous` is
 * populated instead of silently picking one — running (or worse, deleting)
 * the wrong agent on a guess is exactly the accident this must avoid.
 * Returns `{ agent: null }` when no tier matched anything.
 */
export function resolveAgentByNameLoose(agents: Agent[], rawName: string): AgentNameResolution {
  const query = rawName.trim();
  if (!query) return { agent: null };
  const queryLower = query.toLowerCase();

  const exact = agents.filter((a) => (a.name || '').trim().toLowerCase() === queryLower);
  if (exact.length === 1) return { agent: exact[0] };
  if (exact.length > 1) return { agent: null, ambiguous: exact };

  const queryPrefix = stripTrailingEllipsis(queryLower).trim();
  if (queryPrefix) {
    const prefixMatches = agents.filter((a) => (a.name || '').trim().toLowerCase().startsWith(queryPrefix));
    if (prefixMatches.length === 1) return { agent: prefixMatches[0] };
    if (prefixMatches.length > 1) return { agent: null, ambiguous: prefixMatches };
  }

  const substringMatches = agents.filter((a) => (a.name || '').trim().toLowerCase().includes(queryLower));
  if (substringMatches.length === 1) return { agent: substringMatches[0] };
  if (substringMatches.length > 1) return { agent: null, ambiguous: substringMatches };

  return { agent: null };
}

/** Shared "resolve or produce the right AgentCommandResult error" helper for
 *  every @agent <subcommand> <name> branch below — keeps the not-found vs.
 *  ambiguous messaging consistent across run/stop/delete/history/edit. */
function resolveNamedAgentOrError(agents: Agent[], nameArg: string): { agent: Agent } | { error: AgentCommandResult } {
  const resolution = resolveAgentByNameLoose(agents, nameArg);
  if (resolution.agent) return { agent: resolution.agent };
  if (resolution.ambiguous && resolution.ambiguous.length > 0) {
    const names = resolution.ambiguous.map((a) => `"${a.name}"`).join(', ');
    return {
      error: {
        type: 'error',
        message: `Multiple agents match "${nameArg}": ${names}. Use a more specific (or the full) name.`,
      },
    };
  }
  return { error: { type: 'error', message: `Agent "${nameArg}" not found` } };
}

export function parseAgentCommand(input: string): AgentCommandResult {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();
  const nameArg = parts.slice(1).join(' ');

  const store = useAgentStore.getState();

  switch (subcommand) {
    case 'list':
      return listAgents(store.agents);

    case 'run': {
      const resolved = resolveNamedAgentOrError(store.agents, nameArg);
      if ('error' in resolved) return resolved.error;
      const agent = resolved.agent;
      return { type: 'run', message: `Running ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'stop': {
      const resolved = resolveNamedAgentOrError(store.agents, nameArg);
      if ('error' in resolved) return resolved.error;
      const agent = resolved.agent;
      return { type: 'stop', message: `Stopping ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'delete': {
      const resolved = resolveNamedAgentOrError(store.agents, nameArg);
      if ('error' in resolved) return resolved.error;
      const agent = resolved.agent;
      return { type: 'delete', message: `Delete ${agent.name}?`, data: { agent } };
    }

    case 'history': {
      const resolved = resolveNamedAgentOrError(store.agents, nameArg);
      if ('error' in resolved) return resolved.error;
      const agent = resolved.agent;
      const logs = store.getRunHistory(agent.id);
      return { type: 'history', message: formatHistory(agent, logs), data: { logs } };
    }

    case 'edit': {
      const resolved = resolveNamedAgentOrError(store.agents, nameArg);
      if ('error' in resolved) return resolved.error;
      const agent = resolved.agent;
      return { type: 'create', message: nameArg, data: { suggestion: suggestTool(agent.prompt), editAgent: agent } };
    }

    case 'status':
      return statusAll(store.agents);

    default:
      if (isAutonomousCreateCommand(parts[0] ?? '')) {
        const prompt = parts.slice(1).join(' ').trim();
        if (!prompt) {
          return { type: 'error', message: 'Describe the autonomous agent task after "autonomous".' };
        }
        return {
          type: 'create',
          message: prompt,
          data: {
            autonomous: true,
            suggestion: autonomousSuggestion(prompt),
          },
        };
      }

      // Natural language — trigger creation flow
      return {
        type: 'create',
        message: trimmed,
        data: { suggestion: suggestTool(trimmed) },
      };
  }
}

function listAgents(agents: Agent[]): AgentCommandResult {
  if (agents.length === 0) {
    return { type: 'list', message: 'No agents configured. Describe a task to create one.' };
  }
  const lines = agents.map((a) => {
    const status = a.lastResult === 'success' ? '✅' : a.lastResult === 'error' ? '❌' : '⏸️';
    const schedule = a.schedule || 'manual';
    const mode = a.autonomous ? ' — autonomous' : '';
    return `${status} **${a.name}** — ${schedule} — ${toolChoiceToLabel(a.tool)}${mode}`;
  });
  return { type: 'list', message: lines.join('\n') };
}

function statusAll(agents: Agent[]): AgentCommandResult {
  if (agents.length === 0) {
    return { type: 'status', message: 'No agents configured.' };
  }
  const lines = agents.map((a) => {
    const status = a.enabled ? (a.lastResult === 'success' ? '✅' : a.lastResult === 'error' ? '❌' : '⏳') : '⏸️';
    const lastRun = a.lastRun ? new Date(a.lastRun).toLocaleString('ja-JP') : 'never';
    return `${status} **${a.name}** — last: ${lastRun}`;
  });
  return { type: 'status', message: lines.join('\n') };
}

function formatHistory(agent: Agent, logs: any[]): string {
  if (logs.length === 0) return `No run history for ${agent.name}.`;
  const lines = logs.slice(-10).reverse().map((log) => {
    const date = new Date(log.timestamp).toLocaleString('ja-JP');
    const icon =
      log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : log.status === 'unavailable' ? '⏳' : '⏭️';
    const duration = `${(log.durationMs / 1000).toFixed(0)}s`;
    return `${icon} ${date} — ${duration} — ${log.toolUsed}`;
  });
  return `**${agent.name}** — Last ${lines.length} runs:\n${lines.join('\n')}`;
}

/**
 * Create a new agent from parsed creation data.
 */
export function createAgent(params: {
  name: string;
  description: string;
  prompt: string;
  schedule: string | null;
  notificationTrigger?: Agent['notificationTrigger'];
  tool: ToolChoice;
  autonomous?: boolean;
  autonomyLevel?: Agent['autonomyLevel'];
  workspaceRoot?: string;
  outputPath: string;
  outputTemplate?: string;
  action?: Agent['action'];
  /** Multi-destination fan-out (2026-07-28) — see store/types.ts's
   *  Agent.actions doc comment. Undefined for the vast majority of agents
   *  (single-action, existing behavior unaffected); only set by the
   *  chat-native confirm path (hooks/use-ai-pane-dispatch.ts's
   *  confirmAgentDraftInner) when lib/agent-nl-parser.ts's
   *  detectMultiSocialActions confidently resolved 2+ post targets. */
  actions?: Agent['actions'];
  runOn?: Agent['runOn'];
  memory?: Agent['memory'];
  skillId?: Agent['skillId'];
  orchestration?: Agent['orchestration'];
  startNotBefore?: Agent['startNotBefore'];
}): Agent {
  // SECURITY: name sanitized at this single write-boundary so EVERY caller (NL
  // confirm-card free-text, autonomous, terminal @agent) is safe — see
  // sanitize-agent-name.ts for why (shell-comment breakout via interior newline).
  const safeName = sanitizeAgentName(params.name, `agent-${Date.now().toString(36)}`);
  const agent: Agent = {
    id: `agent-${Date.now().toString(36)}`,
    name: safeName,
    description: params.description,
    prompt: params.prompt,
    schedule: params.schedule,
    notificationTrigger: params.notificationTrigger ?? null,
    tool: params.tool,
    autonomous: params.autonomous || undefined,
    autonomyLevel: params.autonomous ? (params.autonomyLevel ?? 'L2') : undefined,
    workspaceRoot: params.workspaceRoot,
    outputPath: params.outputPath,
    outputTemplate: params.outputTemplate || null,
    action: params.action,
    actions: params.actions,
    runOn: params.runOn,
    memory: params.memory,
    skillId: params.skillId,
    orchestration: params.orchestration,
    startNotBefore: params.startNotBefore ?? null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: Date.now(),
    version: 1,
  };

  useAgentStore.getState().addAgent(agent);
  return agent;
}

/**
 * Update fields on an already-registered agent and rematerialize it (disk
 * JSON + generated run script + AlarmManager schedule) so the change takes
 * effect immediately. Added for the chat-native "correct the agent I just
 * registered" flow (hooks/use-ai-pane-dispatch.ts's dispatch(), 2026-07-23)
 * — no `updateAgent`-shaped entry point existed here before; the closest
 * precedent was components/layout/Sidebar.tsx's LOCAL `persistAgentUpdate`
 * callback (same store-update-then-reinstall shape), which a plain hook
 * cannot reach since it lives inside a component. This is that shape
 * promoted to a reusable, non-component-scoped function so both call sites
 * can share it — Sidebar.tsx is left untouched (out of scope for this
 * change) rather than refactored to also call this, to keep the diff
 * minimal on a file with no other reason to change here.
 *
 * Deliberately ALWAYS re-materializes, even for a change that doesn't touch
 * the schedule (e.g. a rename) — a narrower "only reinstall when the
 * schedule actually changed" check was considered and rejected: the
 * generated run script embeds far more than the cron expression (prompt,
 * action, tool, autonomous flag, …), so guessing which fields require a
 * reinstall risks silently leaving a stale script/alarm behind for some
 * future field this function doesn't yet special-case. installAgent is
 * idempotent and cheap enough that reinstalling unconditionally is the
 * safer default (per the task's own "avoid over-optimizing this" note).
 *
 * Returns the updated Agent, or null when `agentId` no longer exists (e.g.
 * the target was an ephemeral one-shot already discarded after running, or
 * was deleted through another surface — Sidebar, `@agent stop`+delete, … —
 * in the gap between registration and this call). Callers must treat null
 * as "nothing to correct", never throw.
 */
export async function updateAgent(
  agentId: string,
  partial: Partial<Agent>,
  runCommand: (cmd: string) => Promise<string>
): Promise<Agent | null> {
  const store = useAgentStore.getState();
  const current = store.agents.find((a) => a.id === agentId);
  if (!current) return null;

  // Same sanitize-at-the-write-boundary rule createAgent enforces (see its
  // own comment above) — a rename must go through the identical shell-safe
  // filter, not just the CREATE path.
  const safePartial: Partial<Agent> = { ...partial };
  if (typeof safePartial.name === 'string') {
    safePartial.name = sanitizeAgentName(safePartial.name, current.name);
  }

  const updated: Agent = { ...current, ...safePartial };
  // createAgent's own invariant ("autonomous:true always carries an
  // autonomyLevel") must keep holding after a partial update too — a caller
  // that only sets `autonomous: true` without touching autonomyLevel (the
  // chat-native autonomous-toggle patch does exactly this) must not end up
  // with an agent that's autonomous but has no level.
  if (updated.autonomous && !updated.autonomyLevel) {
    updated.autonomyLevel = 'L2';
  }
  const finalPartial: Partial<Agent> =
    updated.autonomyLevel !== current.autonomyLevel
      ? { ...safePartial, autonomyLevel: updated.autonomyLevel }
      : safePartial;

  store.updateAgent(agentId, finalPartial);
  await installAgent(updated, runCommand);
  return updated;
}

function isAutonomousCreateCommand(word: string): boolean {
  return ['autonomous', 'auto', '自律', '自律モード'].includes(word.toLowerCase());
}

function autonomousSuggestion(prompt: string) {
  const suggestion = suggestTool(prompt);
  const resolved = resolveForAutonomous(suggestion.tool);
  if (resolved && (resolved.type === 'cli' || resolved.type === 'local')) {
    return {
      ...suggestion,
      tool: resolved,
      label: toolChoiceToLabel(resolved),
    };
  }

  const tool: ToolChoice = { type: 'cli', cli: 'codex' };
  return {
    tool,
    label: toolChoiceToLabel(tool),
    reason: 'Autonomous mode is limited to Codex OAuth or Local LLM; using Codex for this task.',
  };
}

/**
 * Materialize an agent into Shelly HOME so AlarmManager can run it without
 * Termux: JSON metadata, generated bash script, executable bit, and schedule.
 */
export async function installAgent(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  await materializeAgent(agent, runCommand, true);
}

type MaterializeRunOpts = {
  suppressAction?: boolean;
  suppressErrorNotification?: boolean;
  autonomousCloudConsent?: boolean;
  autonomousCloudStop?: boolean;
  suppressWebCodexBake?: boolean;
  // DEFERRED #2 境界: only runLadderAttempts's per-attempt materialize (a human
  // drove this run and is in-app to answer escalations) may set this true. Every
  // OTHER materializeAgent call — install, restore, startup repair, consent
  // re-bake, post-chain/post-ladder restore — leaves it unset, so
  // generateRunScript bakes unattended:true into the STORED script the
  // AlarmManager fire / native one-tap reads (see generateRunScript's comment).
  attended?: boolean;
  // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): the live
  // per-attempt token this agent's chain-locked run (acquireChainLock below)
  // is currently holding, baked into the generated
  // script as CHAIN_LOCK_NONCE so it passes the script's chain-lock check.
  // Only runLadderAttempts's per-attempt materialize (inside a chain-lock
  // scope) sets this; every other materializeAgent call — including the
  // post-chain/post-ladder restore that writes the STORED script — leaves it
  // unset, so the stored script's baked nonce is always empty and can never
  // accidentally match a live chain lock (see generateRunScript's comment).
  chainLockNonce?: string;
  // Optimistic (rollback-type) workspace writes. Threaded from runAgentNowInner's
  // single validated decision down to generateRunScript, which bakes
  // ACTION_APPROVAL_MODE_OVERRIDE='auto' — but ONLY after re-checking the action
  // type against the reversible allowlist itself (see generateRunScript). Never
  // set by install / restore / startup-repair / consent-rebake, so the STORED
  // script an unattended AlarmManager fire reads always keeps the normal gate.
  optimisticWorkspaceWrites?: boolean;
  // DEFERRED.md エージェント二重実行レース ("副産物として見つかった実在する
  // データ消失リスク" follow-up): runLadderAttempts's per-attempt materialize
  // is called with an already-shaped `Agent` — for an orchestration STEP the
  // caller (runAgentOrchestratedBody) has already cleared `.orchestration` to
  // undefined and pinned `.tool` to this one candidate before this function
  // ever sees it. Writing THAT shape to the persistent `<id>.json` metadata
  // file (below) would overwrite the agent's real, saved orchestration config
  // on disk for the duration of the attempt — if the process were killed at
  // exactly that moment, the real multi-step recipe would be permanently lost
  // (confirmed possible, not confirmed to have happened, in the 2026-07-21
  // on-device investigation). The persistent metadata is safe to leave
  // untouched here because every per-attempt materialize is bracketed by an
  // OUTER, non-attempt-scoped materialize call that already wrote the real,
  // full agent object to `<id>.json` before the attempt loop started
  // (installAgent at create/edit time) and rewrites it again immediately
  // after the loop ends (runEscalatingAttempts's / runAgentOrchestratedBody's
  // post-chain "restore" materialize) — so skipping the write here just means
  // "leave the already-correct on-disk file alone", not "write nothing, ever".
  // Nothing reads `<id>.json` mid-attempt that needs the attempt's pinned
  // shape: JS only reloads it from disk at app boot (loadAgentsFromDisk), and
  // the native runtime's own re-read of it (AgentRuntime.kt's isAgentEnabled/
  // trustedPlanLaunch) is gated on `unattended`/the PlanSpec executor route,
  // neither of which a JS-driven attended per-attempt run takes — routing for
  // THIS attempt is driven entirely by the separately-written run script +
  // PlanSpec file, which per-attempt materialize still writes as normal.
  // Only runLadderAttempts's per-attempt materialize sets this; every other
  // materializeAgent call leaves it unset (default false), so `<id>.json` is
  // written exactly as before for every other caller.
  skipMetadataWrite?: boolean;
  // 2026-07-29 on-device finding (docs/superpowers/DEFERRED.md's 2026-07-29
  // "(3) PlanSpecスキル再利用" entry): a skill recipe carrying a PlanSpec
  // (`a8f80a2ca`) is rehydrated back into `.orchestration` by
  // applyExecutableSkillPlan inside applyMemoryAndSkills — i.e. at every
  // materialize. For a per-attempt materialize that is WRONG twice over:
  //   1. the caller (runAgentOrchestratedBody) has deliberately cleared
  //      `.orchestration` so this one step doesn't recurse — re-expanding it
  //      here silently undoes that, and
  //   2. the resulting PlanSpec carries `steps.list` >= 2, which makes the
  //      NATIVE launcher route this attempt through the PlanSpec executor
  //      (AgentRuntime.kt's shouldRunPlanExecutor) instead of the legacy .sh.
  //      runPlanAgent's chain-lock guard is a bare existence check — it
  //      assumes this native path can never be the lock's own owner — so the
  //      attended chain's OWN in-flight lock skipped its OWN attempt with
  //      "previous run still active (chain lock held by an attended run)".
  // Set only by runLadderAttempts's per-attempt materialize; every other
  // caller (install, restore, startup repair, consent re-bake) leaves it unset
  // so the STORED script/PlanSpec still gets the full rehydrated chain, which
  // is what an unattended alarm fire is supposed to run.
  skipSkillPlanRehydration?: boolean;
  // 2026-08-04 on-device finding: a real orchestrated chain's FINAL step is not
  // suppressed (it's the one that performs the agent-level action), so its
  // generation used to fall through to `agent.action?.type`'s delivery-format
  // system prompt — e.g. notify's "keep it to a few words or one sentence".
  // That is correct for a genuinely single-shot notify agent (the whole prompt
  // IS the notification request), but wrong for a chain step, whose OWN
  // instruction (e.g. "ローカルLLMで要約して") already says what to produce; the
  // brevity constraint fought that instruction and produced a shallow,
  // near-content-free bullet list instead of a real summary. Set by
  // runAgentOrchestratedBody for every step (final and non-final alike — a
  // non-final step is already routed to '__suppressed__' regardless, so this
  // is a no-op there) so generateRunScript can use generic 'draft'-style
  // content-generation guidance instead. Never set by any single-run caller.
  isOrchestratedStep?: boolean;
  // 2026-08-04 on-device finding, second half of the same incident:
  // runLadderAttempts already has a `routeTextOverride` (2026-08-03) that
  // makes resolveEscalationLadder judge TOOL ROUTING by a step's own
  // instruction instead of buildStepPrompt's composite — but that value was
  // never forwarded past the ladder into materializeAgent/generateRunScript,
  // so generateRunScript's OWN detectRouteSignals(agent.prompt) call (which
  // decides whether to inject the "You are a research-collection agent...
  // Return ONLY a Markdown bullet list of [title](url) — summary" contract)
  // still ran on the full composite. A summarize step's composite carries the
  // prior collect-step's real result verbatim — full of "最新"/citations/URLs —
  // so needsWeb tripped true for it too, and the local LLM's actual "要約して"
  // instruction got overridden by that bullet-list-of-links contract, producing
  // a shallow entity-name list instead of a real summary. Threaded through
  // exactly like routeTextOverride: set by runLadderAttempts from its own
  // routeTextOverride param, used by generateRunScript ONLY to decide whether
  // to inject the collection contract — the escapedPrompt actually sent to the
  // model is unchanged (still the full composite, which a summarize step
  // genuinely needs for context).
  routeTextOverride?: string;
  // DEFERRED.md「重複コンテンツ検知の欠如(P1)」: the immediately preceding
  // orchestration step's outputPreview, baked into the generated script as
  // PRIOR_STEP_CONTENT so is_low_quality_completion() (bash) can flag a step
  // whose completion is a near-verbatim repeat of what the PRIOR step already
  // produced — the on-device incident this closes was a "notify" step that
  // echoed the "summarize" step's output back verbatim, recorded as success.
  // Set ONLY by runAgentOrchestratedBody, from its own priorResults accumulator
  // (see runLadderAttempts's matching materializeOpts field) — absent for a
  // non-orchestrated single run or a chain's first step, in which case the
  // baked value is empty and the check is a no-op (byte-identical to today).
  priorStepContent?: string;
  // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ進まない」:
  // see BuildAgentPlanSpecOptions's doc comment in lib/agent-plan-spec.ts — set
  // ONLY by this function's own ladderEnvFromDisk read above (autonomous
  // agents only), passed straight through to buildAgentPlanSpec.
  hasCerebrasKey?: boolean;
  hasGroqKey?: boolean;
};

/**
 * round 2 (consent-revocation race, comprehensive fix): EVERY on-disk write for
 * an autonomous agent's script is security-sensitive — an unattended AlarmManager
 * fire reads whatever consent value was last baked in, with no foreground gate.
 * Round 1 only serialized rematerializeAutonomousAgents against ITSELF via
 * autonomousRematerializeQueue (below); an independent Codex review and an
 * independent CC review both found that insufficient, because materializeAgent
 * (this function) has FIVE other call sites that bypass that queue entirely:
 * installAgent (agent create/edit — installAgent/Sidebar persistAgentUpdate/
 * TerminalPane @agent create), runEscalatingAttempts's post-ladder restore,
 * runLadderAttempts's per-attempt materialize (also the site of a separate
 * TOCTOU — see the comment at its call below), runAgentOrchestrated's
 * post-chain restore, and scheduleAgentStartupRepair (fired on every app boot,
 * fully independent of any rematerialize pass). Any two of these racing for the
 * SAME autonomous agent could let an older ON-consent write land after a newer
 * OFF-consent write, silently re-enabling a keyed cloud backend the user just
 * revoked for an agent that can fire unattended.
 *
 * Fix: make materializeAgent ITSELF the single unavoidable choke point. Every
 * call for an autonomous agent — regardless of caller — is routed through this
 * module-level FIFO queue before it does anything, so writes from different
 * callers can never interleave; the queue is a property of the write path, not
 * of any one caller, so a future caller cannot accidentally bypass it (there is
 * only one way to reach the write). Each queued turn re-reads consent from disk
 * only once ITS OWN turn begins (materializeAgentBody's existing "read from
 * disk when runOpts.autonomousCloudConsent is undefined" fallback), so the read
 * and the write it feeds happen back-to-back inside the SAME turn — no other
 * queued turn's write can land in the gap between them. Non-autonomous agents
 * skip the queue (there is no consent to race).
 */
let autonomousMaterializeQueue: Promise<void> = Promise.resolve();

function materializeAgent(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  installAlarm: boolean,
  persistFacts = true,
  runOpts: MaterializeRunOpts = {}
): Promise<void> {
  if (!agent.autonomous) {
    return materializeAgentBody(agent, runCommand, installAlarm, persistFacts, runOpts);
  }
  const turn = autonomousMaterializeQueue.then(() =>
    materializeAgentBody(agent, runCommand, installAlarm, persistFacts, runOpts)
  );
  // A rejected turn must not poison the queue and block later (possibly
  // security-critical, e.g. a revoke's) turns from ever running. Callers still
  // observe their own turn's rejection via the returned/awaited `turn`.
  autonomousMaterializeQueue = turn.catch(() => undefined);
  return turn;
}

async function materializeAgentBody(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  installAlarm: boolean,
  // The startup-repair path re-materializes every scheduled agent on launch; it
  // passes false so we don't re-issue an (idempotent but redundant) fact write
  // for each one. Recall is always re-applied so the baked prompt stays fresh.
  persistFacts = true,
  runOpts: MaterializeRunOpts = {}
): Promise<void> {
  // Phase 1 memory: persist the "remember that …" fact (idempotent) BEFORE recall
  // so it is immediately recallable, then bake recalled notes + a reused skill
  // recipe (Phase 2a) into the run prompt.
  if (persistFacts) {
    await persistRememberFact(agent, runCommand);
  }
  const agentForRun = await applyMemoryAndSkills(agent, {
    rehydrateSkillPlan: !runOpts.skipSkillPlanRehydration,
  });

  // P1: the install + restore paths (which write the script the UNATTENDED alarm
  // later runs) don't carry the consent flags the foreground ladder passes
  // explicitly. For an autonomous agent, read them from disk so the on-disk script
  // keeps its keyed web backend AND bakes the web→Codex ladder (otherwise an
  // autonomous web run on the alarm path refuses the web tool → dead-ends on Codex).
  let effectiveRunOpts = runOpts;
  if (agent.autonomous && runOpts.autonomousCloudConsent === undefined) {
    const env = await ladderEnvFromDisk(runCommand);
    effectiveRunOpts = {
      ...runOpts,
      autonomousCloudConsent: env.autonomousCloudConsent,
      autonomousCloudStop: env.autonomousCloudStop,
      // DEFERRED.md「PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
      // 進まない」: buildAgentPlanSpec's toolLadder needs the same key-presence
      // signal the ladder itself already reads here — piggyback on this same
      // disk read rather than a second one. Only reaches buildAgentPlanSpec
      // (generateRunScript ignores unknown MaterializeRunOpts fields).
      hasCerebrasKey: env.hasCerebrasKey,
      hasGroqKey: env.hasGroqKey,
    };
  }

  const scriptPath = getScriptPath(agent.id);
  const planSpecPath = getPlanSpecPath(agent.id);
  const metadataPath = `${agentsDir()}/${agent.id}.json`;
  const planSpec = buildAgentPlanSpec(agentForRun, effectiveRunOpts);
  // P0-1 reliability: only touch nextExpectedAt when we are ACTUALLY (re-)arming
  // the alarm below — recomputing it unconditionally (e.g. on a ladder-attempt
  // materialize with installAlarm=false) would drift it away from what's really
  // armed. This is an observability/reconciliation field only; the missed-run
  // DETECTION itself (isScheduleMissed) always recomputes fresh from the cron
  // string, so a stale value here can never mask or fabricate a notification.
  const metadataAgent: Agent =
    installAlarm && agent.schedule
      ? { ...agent, nextExpectedAt: nextTriggerMs(agent.schedule, agent.startNotBefore) }
      : agent;
  const commands = [
    `mkdir -p ${shellQuote(agentsDir())}`,
    `mkdir -p ${shellQuote(`${agentsDir()}/plans`)}`,
    `rm -f ${shellQuote(`${deletedAgentsDir()}/${agent.id}`)}`,
    `rm -f "$HOME/.shelly/agents/${DELETED_AGENT_MARKER_DIR}/${agent.id}"`,
    // Metadata stores the ORIGINAL agent (no baked recall) so memory never
    // compounds across materializations; the script gets the effective prompt.
    // skipMetadataWrite (see MaterializeRunOpts's doc comment): a per-attempt
    // ladder materialize omits this write entirely rather than overwrite the
    // persistent `<id>.json` with a transient, single-attempt-shaped `agent`.
    ...(effectiveRunOpts.skipMetadataWrite
      ? []
      : [writeFileCommand(metadataPath, JSON.stringify(metadataAgent, null, 2))]),
    // effectiveRunOpts carries optimisticWorkspaceWrites straight through to
    // generateRunScript's own re-check; the metadata write above deliberately
    // does NOT, so the persisted agent record is never mutated by it.
    writeFileCommand(scriptPath, generateRunScript(agentForRun, effectiveRunOpts)),
    writeFileCommand(planSpecPath, JSON.stringify(planSpec, null, 2)),
    ...generateInstallCommands(agent),
    // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): "arm" the
    // chain lock's live token in the SAME batch that bakes it into the
    // script above, so the two writes can never observably land out of
    // order. Best-effort (`|| true`) — CHAIN_LOCK_DIR only exists while a
    // caller up the stack (runLadderAttempts, inside an acquired chain lock)
    // is actively passing chainLockNonce; every other caller leaves it unset
    // and this line is skipped entirely.
    ...(effectiveRunOpts.chainLockNonce
      ? [`printf '%s' ${shellQuote(effectiveRunOpts.chainLockNonce)} > ${shellQuote(`${getChainLockDir(agent.id)}/token`)} 2>/dev/null || true`]
      : []),
  ];

  // bug #164 diagnostics (2026-07-28 on-device re-repro, versionCode 1987):
  // this write batch (mkdir + script/PlanSpec/metadata write) is the ONLY
  // step confirmed present in every on-device repro's NativeExec log — it
  // always completed (exit=0). Everything after it, up through
  // confirmAgentDraft's final "✅ … registered" message update, produced ZERO
  // further logging in the repro, so the stall's exact location inside that
  // remaining span was unresolved from JS-side reading alone (see
  // DEFERRED.md bug #164). installSchedule()'s TerminalEmulator.scheduleAgent
  // call below is the ONE unlogged native-bridge await in this span — a
  // hung/never-resolving promise there would be invisible on the
  // ReactNativeJS logcat tag entirely. These log lines bracket it so the next
  // repro shows definitively whether the stall is here or genuinely
  // downstream (e.g. back in confirmAgentDraft's own JS-only tail).
  await runCommand(`set -e\n${commands.join('\n')}`);
  logInfo('AgentManager', `materializeAgentBody: write batch ok for ${agent.id} (installAlarm=${installAlarm})`);
  if (installAlarm) {
    await installSchedule(agent);
    logInfo('AgentManager', `materializeAgentBody: installSchedule returned for ${agent.id}`);
  }
  if (metadataAgent !== agent) {
    // Best-effort mirror into the in-memory store so UI reflecting nextExpectedAt
    // doesn't need a full disk reload to see the freshly-armed value.
    useAgentStore.getState().updateAgent(agent.id, { nextExpectedAt: metadataAgent.nextExpectedAt });
  }
}

/**
 * N1 follow-up: the autonomous-cloud consent flags are BAKED into each agent's
 * on-disk run script at materialize time, so a mid-session settings toggle
 * leaves the scripts the UNATTENDED alarm/native fires read stale until the
 * next app-launch startup repair. Call this right AFTER the consent env flush
 * (the .env write must land first — materializeAgent reads consent from disk)
 * so every autonomous agent's script re-bakes with the new consent immediately.
 * Alarms are untouched (the PendingIntent doesn't encode consent). Best-effort:
 * a failed re-bake self-heals on the next startup repair / foreground run.
 *
 * Deliberately includes DISABLED agents: setAgentEnabled(true) re-installs the
 * alarm without re-materializing, so skipping a disabled agent here would let a
 * consent REVOKED while it was disabled survive in its baked script — the next
 * unattended fire after re-enable would still use the keyed web backend. With
 * installAlarm=false a disabled agent's re-bake writes files only (no schedule),
 * and the metadata keeps enabled:false.
 *
 * round 2: this pass-level queue is now a SECOND, coarser layer on top of
 * materializeAgent's own per-call queue (see its comment above). This one still
 * matters on its own: it makes a whole PASS (every autonomous agent's write)
 * atomic relative to another pass, so two rapid toggles can't interleave their
 * writes agent-by-agent (e.g. pass1=ON writes agent A, pass2=OFF writes agent
 * A, pass1=ON writes agent B — the per-call queue alone only orders individual
 * writes, it doesn't guarantee a whole pass finishes before the next starts).
 * materializeAgent's queue additionally covers every OTHER caller this pass
 * doesn't touch (ladder attempts, startup repair, install/edit).
 */
let autonomousRematerializeQueue: Promise<void> = Promise.resolve();

export function rematerializeAutonomousAgents(
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  // Consent is security-sensitive state baked into scripts that can run
  // unattended. Queue the entire pass so an older pass can never finish a
  // stale write after a newer pass. Take the agent snapshot inside the queued
  // turn; materializeAgent likewise reads consent from disk only once that turn
  // starts, after the preceding pass has fully completed.
  const turn = autonomousRematerializeQueue.then(async () => {
    const autonomousAgents = useAgentStore
      .getState()
      .agents.filter((agent) => agent.autonomous);
    for (const agent of autonomousAgents) {
      // Skip agents deleted while iterating — re-materializing a captured
      // snapshot would rewrite its <id>.json and resurrect it (same guard as
      // the startup repair).
      if (!useAgentStore.getState().agents.some((a) => a.id === agent.id)) continue;
      try {
        await materializeAgent(agent, runCommand, false, false);
      } catch (error) {
        logWarn('AgentEnvSync', `failed to re-bake consent into agent ${agent.id}`, error);
      }
    }
  });

  // A rejected turn must not poison the mutex and prevent later revocations
  // from being applied. Callers still observe their own turn's rejection.
  autonomousRematerializeQueue = turn.catch(() => undefined);
  return turn;
}

/**
 * Build the EFFECTIVE agent whose prompt is prefixed with recalled memory (G2)
 * and a reused skill recipe (G3). Both blocks flow through generateRunScript →
 * resolveAgentRoute, which scans agent.prompt with secret-guard, so a secret
 * inside a memory note OR a skill recipe forces the run on-device exactly like a
 * secret in the task text (no silent cloud leak). Returns the agent unchanged
 * when there is nothing to inject.
 */
/**
 * Resolve the EFFECTIVE shape of an agent whose attached skill recipe carries
 * an executable PlanSpec (`a8f80a2ca`): the recipe's steps/tool/budget are
 * restored onto the agent exactly as applyMemoryAndSkills would at materialize
 * time. Used by runAgentNowInner so the orchestrated-vs-single routing
 * decision sees the same shape the on-disk script/PlanSpec will be generated
 * from — see that call site for the skip-loop this divergence caused.
 * Best-effort: any read failure returns the agent untouched (today's behavior).
 */
async function rehydrateSkillPlan(agent: Agent): Promise<Agent> {
  if (!agent.skillId) return agent;
  try {
    const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId) ?? null;
    return applyExecutableSkillPlan(agent, recipe);
  } catch {
    return agent;
  }
}

async function applyMemoryAndSkills(
  agent: Agent,
  opts: { rehydrateSkillPlan?: boolean } = {}
): Promise<Agent> {
  let prompt = agent.prompt;
  // Phase 2a skill reuse: a skill was attached at creation via the gated
  // "use skill X?" confirm. Prepend its recipe.
  if (agent.skillId) {
    try {
      const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId) ?? null;
      // Executable-plan rehydration is suppressed for a per-attempt materialize
      // (see MaterializeRunOpts.skipSkillPlanRehydration) — the caller has
      // already shaped `.orchestration` for exactly this one step/candidate.
      if (opts.rehydrateSkillPlan !== false) agent = applyExecutableSkillPlan(agent, recipe);
      const skillContext = buildSkillInjectionContext(recipe);
      if (skillContext) prompt = `${skillContext}\n\n---\n\n${prompt}`;
    } catch {
      // Skill injection is best-effort; never block a run on a read failure.
    }
  }
  // Phase 1 memory recall. Reads the agent's own notes PLUS the user-scope
  // `_global` namespace (lib/agent-memory.ts's GLOBAL_MEMORY_SCOPE), merged
  // into one pool so ranking can pick the most relevant regardless of scope.
  // The merged prompt still flows through generateRunScript → resolveAgentRoute,
  // so a secret in a GLOBAL note forces the run on-device exactly like a secret
  // in an agent-scoped one — the G2 invariant is unchanged by widening the pool.
  try {
    const ownNotes = await readMemoryNotes(agent.id);
    const globalNotes = await readGlobalMemoryNotes();
    const notes = [...ownNotes, ...globalNotes].sort((a, b) => b.created.localeCompare(a.created));
    // MEMORY-001 Step 3 (strangler; MEMORY_ENABLED=true since 2026-08-05, see
    // lib/memory/wiring.ts): this branch now runs on every call, and
    // activateMemoryRecall's rendered context is injected INSTEAD OF the G2
    // result computed below. A `null` return (any internal MEMORY-001 failure)
    // falls back to that G2 result rather than to no recall at all — G2 is the
    // on-device-verified path, so falling back to IT is safer than silently
    // dropping the agent's memory.
    let recallContext: string | null = null;
    if (MEMORY_ENABLED) {
      // MEMORY-001 has no concept of the `_global` namespace yet, so it is fed
      // the agent-scoped notes only (preserving the existing shadow/parity
      // semantics) and the shared block is appended after whatever it renders.
      // Widening MEMORY-001 itself to user scope belongs to its own rollout
      // gate (encryption / PII classification / corpus tests), not here.
      await shadowMemoryRecall(agent, ownNotes).catch(() => {});
      recallContext = await activateMemoryRecall(agent, ownNotes);
      if (recallContext !== null) {
        const shared = buildGlobalRecallContext(globalNotes);
        if (shared) recallContext = recallContext ? `${recallContext}\n\n${shared}` : shared;
      }
    }
    if (recallContext === null) {
      if (notes.length > 0) {
        const relevant = recallMemoryNotes(notes, `${agent.name}\n${agent.prompt}`);
        recallContext = buildRecallContext(relevant);
      } else {
        recallContext = '';
      }
    }
    if (recallContext) prompt = `${recallContext}\n\n---\n\n${prompt}`;
  } catch {
    // best-effort
  }
  return prompt === agent.prompt ? agent : { ...agent, prompt };
}

/**
 * ─── Recall freshness (roadmap item 3, "per-fire 鮮度") ──────────────────────
 *
 * Recall is BAKED into each agent's on-disk run script at materialize time
 * (applyMemoryAndSkills above). An UNATTENDED fire — AlarmManager → the .sh
 * directly, no JS in the loop — therefore reads whatever recall was current
 * when the script was last written, which until now meant "since the last app
 * launch". A note written by a run at 09:00 was invisible to the 10:00 fire.
 *
 * Two ways to fix that were considered:
 *
 *  (a) Read the memory files from inside the generated script at fire time.
 *      This is the literal "per-fire" reading, and it was REJECTED for now:
 *      the recall block would then enter the prompt AFTER resolveAgentRoute has
 *      already chosen a backend, so a secret written into memory since the bake
 *      could ride a cloud route — the exact leak the G2 secret-guard invariant
 *      exists to prevent (see lib/agent-memory.ts's INVARIANTS block). Making
 *      it safe needs either an in-shell secret scan or a local-route-only gate,
 *      plus on-device verification of a large new bash surface and an
 *      AGENT_SCRIPT_VERSION/AgentRuntime.kt lockstep bump.
 *
 *  (b) Re-bake the affected scripts whenever memory CHANGES. Chosen. Recall
 *      selection is a pure function of (notes, agent.name+prompt); the prompt
 *      is fixed between edits, so the only thing that can make a baked block
 *      stale is a new/changed note. Re-baking on write therefore makes the
 *      baked block equal to what a fire-time read would have produced, while
 *      keeping the write on the JS side where resolveAgentRoute still scans the
 *      merged prompt before a backend is chosen. No script change, no version
 *      bump, invariant preserved.
 *
 * Best-effort by design: a failed re-bake self-heals at the next startup repair
 * or foreground run, exactly like the consent re-bake path above.
 */
async function refreshAgentRecall(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (!agent) return;
  try {
    // installAlarm=false (the schedule is untouched), persistFacts=false (the
    // registering fact is already on disk — re-writing it here would be a
    // redundant idempotent write on every single run).
    await materializeAgent(agent, runCommand, false, false);
  } catch (error) {
    logWarn('AgentMemory', `failed to refresh baked recall for ${agentId}`, error);
  }
}

/**
 * Write a user-scope memory note and refresh EVERY agent's baked recall, since
 * a global note is recalled by all of them. Global writes are rare (an explicit
 * "remember this for everything" action), so the full pass is proportionate —
 * unlike per-run result capture, which refreshes only its own agent.
 *
 * NOT unified with MEMORY-001 (gap, not fixed here — tracked in DEFERRED.md's
 * 2026-08-10 audit, item 10): unlike persistRememberFact/captureRunMemory below,
 * this write is unconditional G2 (via writeMemoryNote, which also Vault-copies)
 * — there is no `if (MEMORY_ENABLED) activateMemoryWrite(...)` attempt here at
 * all. This is a real coverage gap, not a technical limitation of the store:
 * activateMemoryWrite's `agentNamespace()` is the identity function, so nothing
 * stops it being called with agentId=GLOBAL_MEMORY_SCOPE, and the read-side CRUD
 * below (activateMemoryList/deleteMemoryNoteById/updateMemoryNoteById) already
 * treats '_global' as an ordinary namespace this way for Memory Workbench.
 * Writing global notes through MEMORY-001 was simply never wired up when Step 4
 * activation landed; it stayed on the pre-existing G2-only path instead.
 */
export async function writeGlobalMemoryNote(
  runCommand: (cmd: string) => Promise<string>,
  params: { type: MemoryNoteType; text: string; tags?: string[] }
): Promise<void> {
  await writeMemoryNote(runCommand, makeGlobalMemoryNote(params));
  // 2026-08-07 on-device QA finding (docs/superpowers/DEFERRED.md): this is
  // a G2-only write — it never touches the MEMORY-001 store — so without
  // this, activateMemoryList('_global', ...)'s one-time-per-session
  // mirror-import (lib/memory/shadow.ts) keeps returning whatever it saw
  // the FIRST time anything read '_global' this session (often an empty
  // list, since global notes are rare), and Memory Workbench's shared-notes
  // section stays permanently empty even right after this write. Evicting
  // the cache entry here means the next read re-syncs from G2.
  invalidateMemoryImportCache(GLOBAL_MEMORY_SCOPE);
  const agents = useAgentStore.getState().agents;
  for (const agent of agents) {
    await refreshAgentRecall(agent.id, runCommand);
  }
}

/** Write the registering "remember that …" fact as a memory note (idempotent). */
async function persistRememberFact(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const fact = agent.memory?.rememberFact?.trim();
  if (!fact) return;
  // MEMORY-001 Step 4 (strangler; MEMORY_ENABLED=true since 2026-08-05, see
  // lib/memory/wiring.ts): activateMemoryWrite (which reuses G2's own
  // makeMemoryNote for normalization) now runs first and, on success, replaces
  // the G2 write below. A `false` return (any internal MEMORY-001 failure)
  // falls back to G2's write rather than silently losing the fact.
  if (MEMORY_ENABLED) {
    const ok = await activateMemoryWrite({
      agentId: agent.id,
      type: 'fact',
      text: fact,
      tags: agent.memory?.tags,
    });
    if (ok) return;
  }
  try {
    await writeMemoryNote(
      runCommand,
      makeMemoryNote({ agentId: agent.id, type: 'fact', text: fact, tags: agent.memory?.tags })
    );
  } catch (error) {
    console.warn('Failed to persist remember-fact for agent', agent.id, error);
  }
}

/**
 * Concurrency-race investigation (2026-07-17/18, agent-mrorpolq): a JS-driven
 * attended run (Sidebar "RUN NOW" / @agent chat / TerminalPane) has NO guard
 * against a second concurrent invocation for the SAME agent. Sidebar.tsx's
 * `pendingAgentIds` state was tracked but never read to disable the RUN NOW
 * controls (components/layout/Sidebar.tsx's play-arrow Pressable and the
 * detail-popup's Alert.alert "Run Now" button both fire unconditionally on
 * every press), so a double-tap/ghost-tap — or any other caller invoking
 * runAgentNow for the same agentId while a prior call is still in flight —
 * could start two overlapping runs. For an orchestrated (>=2 step) agent this
 * is especially damaging: runAgentOrchestrated's per-step loop RELEASES the
 * native per-script lock (agent-executor.ts's LOCK_FILE) between steps while
 * it transiently rewrites the on-disk script to each step's single-step form
 * (materializeAgent inside runLadderAttempts), so a second overlapping
 * runAgentOrchestrated for the same agent can interleave its own materialize/
 * run-log writes with the first's, corrupting the aggregate result the first
 * call was building (see docs/superpowers/DEFERRED.md's 2026-07-18 entry for
 * the full trace).
 *
 * Fix: dedupe concurrent runAgentNow calls for the SAME agentId at the single
 * JS choke point every caller already goes through, regardless of which UI
 * surface triggered them. A second call while one is in flight JOINS the
 * existing in-flight promise instead of starting its own — the run genuinely
 * happens once, and both callers observe the same outcome. This does not (and
 * cannot, from JS alone) close the separate native-alarm-vs-mid-chain-window
 * race also identified during this investigation — that one needs the
 * unattended AlarmManager fire itself to observe an attended chain's
 * in-progress state, which lives outside this process; see DEFERRED.md.
 */
const inFlightAgentRuns = new Map<string, Promise<void>>();

export async function runAgentNow(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>,
  options: {
    waitTimeoutMs?: number;
    pollMs?: number;
    runStartedAtMs?: number;
    /** Exit-code-returning command runner (hooks/use-native-exec's execCommand).
     *  REQUIRED to unlock optimistic (rollback-type) execution: without it there
     *  is no way to drive git, so no savepoint, so no undo, so the normal
     *  pre-approval gate is kept. Fail-closed by omission — a caller that does
     *  not pass it simply never gets the optimistic path. */
    savepointRunner?: RollbackRunCommand;
  } = {}
): Promise<void> {
  const existing = inFlightAgentRuns.get(agentId);
  if (existing) {
    logWarn('AgentRunConcurrency', `runAgentNow(${agentId}) called while a run is already in flight — joining it instead of starting a second one`);
    return existing;
  }
  const turn = runAgentNowInner(agentId, runCommand, options);
  inFlightAgentRuns.set(agentId, turn);
  try {
    await turn;
  } finally {
    // Only clear the map entry if it still points at THIS turn — defensive,
    // though under the guard above no other writer can have replaced it.
    if (inFlightAgentRuns.get(agentId) === turn) {
      inFlightAgentRuns.delete(agentId);
    }
  }
}

async function runAgentNowInner(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>,
  options: {
    waitTimeoutMs?: number;
    pollMs?: number;
    runStartedAtMs?: number;
    savepointRunner?: RollbackRunCommand;
  } = {}
): Promise<void> {
  assertSafeAgentId(agentId);
  // Global kill-switch: while halted, refuse manual runs too (not just scheduled).
  if (useAgentStore.getState().halted) {
    throw new Error('All agents are stopped (global kill-switch is on). Resume agents to run.');
  }
  // 2026-08-04 stray-handle fix: retire any undo handle left over from a
  // PREVIOUS run of this SAME agentId the instant a NEW run starts. Without
  // this, a handle captured by an earlier OPTIMISTIC run (e.g. the agent was
  // a local `draft` at the time) survives untouched through a LATER run that
  // is NOT optimistic (the agent was edited to an irreversible action type
  // like `cli`, the user turned the settings toggle off, or this run took the
  // orchestrated path, which returns before ever reaching the capture/clear
  // logic below) — because that later run's own capture step only fires
  // `pendingRollbackHandles.set/delete` when IT went optimistic. The result
  // would be a handle that still exists in the map after an ineligible run
  // completes, which is exactly the "stray/misapplied handle" shape the UI
  // layer (AIPane's Undo affordance, hooks/use-ai-pane-dispatch.ts) must
  // never trust on presence alone — see rollbackOfferEligible below, which
  // re-derives eligibility from the run's OWN agent snapshot instead of just
  // checking peekAgentRollbackHandle(). This clear is the root-cause fix;
  // rollbackOfferEligible is the defense-in-depth backstop for it.
  pendingRollbackHandles.delete(agentId);
  // Same hygiene for skill-improvement proposals: a NEW run of this agent
  // retires any un-consumed confirm proposal from a previous run, so the
  // foreground offer can never present a stale learning as if it came from
  // the run that just finished.
  clearSkillImprovementProposal(agentId);
  // Phase 4: a multi-step agent runs as a linear chain (each step through the
  // SAME gated single-run path below). Single-step agents fall through unchanged.
  const storedAgent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  // 2026-07-29 on-device fix (docs/superpowers/DEFERRED.md's 2026-07-29 "(3)
  // PlanSpecスキル再利用" entry): a skill recipe carrying an executable
  // PlanSpec (`a8f80a2ca`) restores its steps into `.orchestration` — but that
  // rehydration used to happen ONLY inside materializeAgent, i.e. AFTER this
  // routing decision. The store-shaped agent has just `skillId` and no
  // `.orchestration`, so a reused multi-step plan took the SINGLE-run ladder
  // here while the script/PlanSpec that same run then wrote to disk was
  // multi-step — which flipped the native launcher onto the PlanSpec-executor
  // route and made the chain's own lock skip its own attempt (see
  // MaterializeRunOpts.skipSkillPlanRehydration for the full trace). Resolve
  // the EFFECTIVE shape first so the JS route and the on-disk artifacts agree:
  // a rehydrated multi-step plan runs as a real orchestrated chain, whose
  // per-step materialize clears `.orchestration` again and therefore stays on
  // the legacy .sh path the chain lock's nonce check understands.
  const orchestrationAgent = storedAgent ? await rehydrateSkillPlan(storedAgent) : undefined;
  // api-call (v1) attended-run guard: runAgentOrchestrated's per-step `.sh`
  // generator (generateRunScript) has no concept of an apiCall step — without
  // this check it would silently send the step's synthetic display label
  // (e.g. "GET api.perplexity.ai/...") to a model as a literal prompt, and
  // carry the resulting garbage forward as a fake-successful prior result.
  // api-call is PlanSpec-executor-only in v1 (see scripts/shelly-plan-executor.js's
  // runOrchestrationChain and dispatchActionTrusted) — attended "Run now" is
  // refused here with a clear error instead. Checked for BOTH an orchestration
  // step carrying apiCall AND a terminal action of type 'api-call' (the latter
  // can't currently be authored on a non-orchestrated agent via the UI gate in
  // AgentConfirmCard, but this is a hard safety boundary, not a UI convenience
  // — it must hold regardless of how the agent was constructed).
  if (orchestrationAgent) {
    const hasApiCallStep = normalizeSteps(orchestrationAgent.orchestration).some((s) => !!s.apiCall);
    if (hasApiCallStep || orchestrationAgent.action?.type === 'api-call') {
      throw new Error(t('agents.api_call_attended_unsupported'));
    }
  }
  const orchestrated = isOrchestrated(orchestrationAgent?.orchestration);
  // 2026-07-18 concurrency-bug diagnostic (see DEFERRED.md): logs whether this
  // run took the orchestrated chain path or the single-run fallback, so an
  // on-device repro can confirm/rule out isOrchestrated() itself flipping for
  // this agent, versus the divergence happening downstream (or via a second
  // concurrent invocation racing this one — see inFlightAgentRuns above).
  logWarn(
    'AgentRunDecision',
    `agent ${agentId}: stepCount=${normalizeSteps(orchestrationAgent?.orchestration).length} isOrchestrated=${orchestrated}`
  );
  if (orchestrationAgent && orchestrated) {
    // The post-chain restore materialize deliberately gets the STORED agent,
    // not the rehydrated one: materializeAgentBody writes `<id>.json` from its
    // `agent` argument (the "metadata stores the ORIGINAL agent" rule) while
    // deriving the script/PlanSpec from the rehydrated `agentForRun`. Passing
    // the stored shape keeps the restored on-disk state byte-identical to what
    // install-time materialize produces, instead of silently baking a reused
    // skill's steps into the agent's persistent record.
    await runAgentOrchestrated(orchestrationAgent, runCommand, options, storedAgent);
    return;
  }
  const runStartedAtMs = options.runStartedAtMs ?? Date.now() - 5_000;
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (agent) {
    // ─── Optimistic (rollback-type) execution decision ──────────────────────
    // THE choke point. Every condition below must hold; each one is a separate
    // reason the "run first, undo later" trade would otherwise be unsound:
    //   1. the caller supplied an exit-code-returning runner (else no git, so
    //      no savepoint and no undo),
    //   2. the user opted in AND the run is classified fully reversible
    //      (isRollbackEligibleRun — see lib/agent-action-reversibility.ts; an
    //      irreversible external side effect can never reach here),
    //   3. the run would otherwise block on a pre-approval tap (otherwise this
    //      changes nothing and we would take a pointless snapshot),
    //   4. the workspace snapshot actually succeeded and left a clean tree.
    // Any failure falls through to the normal pre-approval gate — the safe
    // outcome — rather than running optimistically without an undo.
    let optimistic = false;
    const savepointRunner = options.savepointRunner;
    const workspaceRoot = agentRollbackWorkspaceRoot();
    if (savepointRunner) {
      // Dynamic import ON PURPOSE. A static `import { useSettingsStore }` here
      // transitively drags in expo-secure-store (an ESM native module) and
      // breaks EVERY non-RN jest suite that imports agent-manager for its pure
      // helpers — the exact trap already documented in lib/agent-executor.ts's
      // ACTION_APPROVAL_MODE comment, re-hit while implementing this. Reaching
      // it requires a savepointRunner, which only the RN attended path passes,
      // so the module is never loaded in a unit-test context.
      const { useSettingsStore } = await import('@/store/settings-store');
      const { settings } = useSettingsStore.getState();
      if (isRollbackEligibleRun(agent, settings) && runWouldRequireApprovalTap(agent, settings)) {
        optimistic = await prepareRollbackWorkspace(workspaceRoot, savepointRunner);
        if (!optimistic) {
          logWarn(
            'AgentRollback',
            `${agentId}: could not snapshot ${workspaceRoot} — keeping the pre-approval gate`
          );
        }
      }
    }
    await runEscalatingAttempts(agent, runCommand, { ...options, optimisticWorkspaceWrites: optimistic }, runStartedAtMs);
    if (optimistic && savepointRunner) {
      // Commit exactly what the run wrote and publish the undo handle. A null
      // handle (nothing written, or the secret scan blocked the commit) means
      // no undo affordance may be offered — see consumeAgentRollbackHandle.
      const handle = await captureRollbackPoint(agentId, workspaceRoot, savepointRunner);
      if (handle) pendingRollbackHandles.set(agentId, handle);
      else pendingRollbackHandles.delete(agentId);
    }
  }
  await syncAgentRunLogsFromDisk(runCommand, agentId);
  await captureRunMemory(agentId, runCommand);
  await updateReusedSkillFromRun(agentId, runCommand);
}

/**
 * Undo handles produced by the most recent optimistic run of each agent.
 * Deliberately in-memory and single-slot: an undo offer is a fresh-result
 * affordance, not a history feature (git history is the history feature), and
 * keeping it out of any store avoids persisting a stale "元に戻す" that would
 * revert a commit the user has since built on top of.
 */
const pendingRollbackHandles = new Map<string, AgentRollbackHandle>();

/** Take (and clear) the undo handle for an agent's last optimistic run, if any. */
export function consumeAgentRollbackHandle(agentId: string): AgentRollbackHandle | null {
  const handle = pendingRollbackHandles.get(agentId) ?? null;
  if (handle) pendingRollbackHandles.delete(agentId);
  return handle;
}

/** Peek without consuming (UI wanting to decide whether to render the offer). */
export function peekAgentRollbackHandle(agentId: string): AgentRollbackHandle | null {
  return pendingRollbackHandles.get(agentId) ?? null;
}

/** Undo an agent's last optimistic run. Returns false when nothing was undone. */
export async function rollbackAgentRun(
  agentId: string,
  savepointRunner: RollbackRunCommand
): Promise<boolean> {
  const handle = consumeAgentRollbackHandle(agentId);
  if (!handle) return false;
  return undoAgentRun(handle, savepointRunner);
}

/**
 * Whether an "元に戻す" (Undo) affordance may be offered for a run that just
 * completed. This is the single choke point every UI surface (currently
 * hooks/use-ai-pane-dispatch.ts's attended run-result bubbles, rendered by
 * components/panes/AIPane.tsx) MUST call — never render Undo off
 * peekAgentRollbackHandle()/consumeAgentRollbackHandle() alone.
 *
 * Trusting handle-presence alone would be unsound in isolation: neither
 * consumeAgentRollbackHandle() nor rollbackAgentRun() re-derives eligibility
 * from the agent's current shape before undoing — they only check whether a
 * handle object exists. That is safe TODAY only because runAgentNowInner's
 * capture step (above) is the sole writer of pendingRollbackHandles and never
 * sets one for a run classifyRunReversibility() would reject, AND because the
 * 2026-08-04 fix at the top of runAgentNowInner now clears any stale handle
 * from an EARLIER run the instant a new run of the same agentId starts (so an
 * intervening non-optimistic run — e.g. the agent was edited to an
 * irreversible action type, or the settings toggle got turned off — can never
 * leave a stray handle sitting behind for a later message to pick up).
 *
 * This function is the independent second signal on top of that invariant:
 * it re-runs classifyRunReversibility()-backed isRollbackEligibleRun() against
 * the SAME agent snapshot the caller just ran, using CURRENT settings, and
 * only says yes when that verdict AND a live handle both agree. A caller
 * should snapshot the boolean this returns onto the completed run's message
 * (see ChatMessage.agentRollbackOffer) rather than re-deriving eligibility
 * later from a possibly-deleted agent (ephemeral one-shot runs delete their
 * agent right after reporting the result) — but should call
 * peekAgentRollbackHandle(agentId) again, live, immediately before rendering
 * or acting on the Undo button, since only handle-liveness (not eligibility)
 * can change after this snapshot (consumed by a prior tap, invalidated by a
 * newer run, or lost to an app restart — pendingRollbackHandles is in-memory
 * only, see its doc comment above).
 */
export function rollbackOfferEligible(
  agentId: string,
  agentSnapshot: Pick<Agent, 'action' | 'actions' | 'orchestration' | 'prompt' | 'name'> & Partial<Agent>,
  settings: ReversibilitySettings
): boolean {
  return isRollbackEligibleRun(agentSnapshot, settings) && peekAgentRollbackHandle(agentId) !== null;
}

/** Read which free-cloud-tier keys are configured (authoritative source: the
 * agent .env the run script sources). Best-effort; on failure both default true
 * so a usable backend is never wrongly skipped (it would just fail-and-escalate). */
async function ladderEnvFromDisk(runCommand: (cmd: string) => Promise<string>): Promise<LadderEnv> {
  try {
    const out = await runCommand(
      // Key-present check must reject a CLEARED key: settings-store writes values
      // via dotenvValue() (always single-quoted), so an emptied key remains in the
      // file as KEY=''. Require a non-quote char after the optional opening quote —
      // `.+` would match the two bare quotes and misreport the key as present.
      `for k in CEREBRAS_API_KEY GROQ_API_KEY PERPLEXITY_API_KEY GEMINI_API_KEY; do ` +
        `grep -qE "^$k=['\\"]?[^'\\"]" "$HOME/.shelly/agents/.env" 2>/dev/null && echo "$k=1" || echo "$k=0"; done; ` +
        // N1: the autonomous-cloud consent flags are written by settings-store as
        // explicit 0/1 (not "key present"), so read their VALUE, defaulting to 0.
        `for k in SHELLY_AUTONOMOUS_CLOUD SHELLY_AUTONOMOUS_CLOUD_STOP; do ` +
        `v=$(grep -E "^$k=" "$HOME/.shelly/agents/.env" 2>/dev/null | tail -n1 | cut -d= -f2); echo "$k=\${v:-0}"; done`,
    );
    return {
      hasCerebrasKey: /CEREBRAS_API_KEY=1/.test(out),
      hasGroqKey: /GROQ_API_KEY=1/.test(out),
      // G4 P1 key preflight: known-missing Perplexity/Gemini keys let the
      // ladder skip a backend that cannot authenticate (auto-scorer picks only).
      hasPerplexityKey: /PERPLEXITY_API_KEY=1/.test(out),
      hasGeminiKey: /GEMINI_API_KEY=1/.test(out),
      // Consent defaults OFF (fail-closed) when the flag is absent/unreadable.
      // Anchor to an exact `1` (optionally quoted — settings-store writes the
      // value via dotenvValue() which wraps it as '1', so the .env line is
      // SHELLY_AUTONOMOUS_CLOUD='1'). Still strict: a malformed value (=10,
      // =1foo, ='1foo') reads as OFF, never fail-open into cloud opt-in.
      autonomousCloudConsent: /(^|\n)SHELLY_AUTONOMOUS_CLOUD=['"]?1['"]?(\n|$)/.test(out),
      autonomousCloudStop: /(^|\n)SHELLY_AUTONOMOUS_CLOUD_STOP=['"]?1['"]?(\n|$)/.test(out),
    };
  } catch {
    // Conservative on read failure: free-cloud keys assumed present (attended
    // ladder hop is cheap), but autonomous cloud stays fail-closed (no consent).
    return { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: false, autonomousCloudStop: false };
  }
}

/**
 * DEFERRED.md エージェント二重実行レース (chain-lock follow-up, 2026-07-18):
 * inFlightAgentRuns above closes the SAME-PROCESS double-run window, but a
 * native AlarmManager fire runs an agent's on-disk .sh directly — never
 * through runAgentNow — so it cannot be caught there. runAgentOrchestrated's
 * per-step loop and runLadderAttempts's per-candidate loop each RELEASE the
 * generated script's own per-invocation LOCK_FILE between iterations while
 * transiently rewriting the on-disk script to that one step/candidate's
 * single-shot form (materializeAgent), so a same-agent alarm firing in that
 * gap can run whatever transient content happens to be on disk, racing the
 * chain's own next materialize/run — see the DEFERRED.md entry for the full
 * trace of how that corrupts the chain's aggregate result.
 *
 * This chain-scoped lock closes that gap from the outside: acquired BEFORE a
 * chain's first step/candidate and held (see runEscalatingAttempts /
 * runAgentOrchestrated below) until the chain's FINAL restore-to-original-
 * config materialize completes. It mirrors agent-executor.ts's REGISTRY_LOCK
 * mkdir-based atomic directory lock exactly (mkdir succeeds for exactly one
 * caller), but — unlike REGISTRY_LOCK, which lives entirely inside ONE bash
 * process — this lock spans MULTIPLE separate native script invocations, so
 * it is acquired/released from here (JS/native orchestration layer, via
 * runCommand) rather than from inside the generated bash.
 *
 * Token design: a single nonce constant for the whole chain, baked into every
 * step's script, would ALSO match a native alarm that happens to fire while a
 * JUST-FINISHED step's stale content still sits on disk (LOCK_FILE released,
 * the next materialize not yet written) — the alarm's invocation reads
 * byte-identical script content to the chain's own next intended launch, so a
 * static per-chain value cannot tell them apart. Instead the LIVE token is
 * rotated per attempt: materializeAgentBody's own write batch "arms" the live
 * token to the SAME value it just baked into that attempt's script (see
 * MaterializeRunOpts.chainLockNonce above — folded into that batch so the two
 * writes can never land out of order), and disarmChainLockToken invalidates it the
 * instant that attempt's run is observed complete, before any other work — so
 * a stale script sitting in the inter-step gap always reads a now-mismatched
 * live token and is skipped by the generated script's chain-lock check
 * exactly like a genuinely foreign holder. `seed` is a separate, never-rotated
 * value written once at acquisition, used only to verify lock OWNERSHIP at
 * release/disarm time (so a chain that outlives its own staleness window can
 * never tear down or mutate a DIFFERENT, later chain's lock).
 */
const CHAIN_LOCK_STALE_MS = 2 * 60 * 60_000; // 2h — comfortably above agent-orchestration.ts's HARD_TOTAL_TIMEOUT_MS (1h ceiling), so a live chain's own long tail is never mistaken for an orphan, but a chain whose process was killed before its `finally` ran (app killed mid-run) self-heals instead of permanently blocking that agent's future scheduled fires.

function chainLockToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Acquire the chain-scoped lock for `agentId`. Throws when a DIFFERENT,
 * still-live chain attempt already holds it — callers (runEscalatingAttempts /
 * runAgentOrchestrated) should let that propagate as a run failure; under
 * normal operation inFlightAgentRuns already prevents a same-process second
 * attempt, so reaching a genuine busy signal here means either a cross-process
 * race or an app-restart-while-mid-chain edge case, both rare enough that
 * surfacing an explicit error is preferable to silently starting a second
 * chain. Only an EXPLICIT "CHAIN_LOCK_BUSY" signal from the device is treated
 * as busy — any other output (including an unrecognized/empty response, e.g.
 * from a test's mocked runCommand that doesn't model this lock at all) is
 * treated as acquired, so this new lock can never itself brick a run whose
 * test harness predates it.
 */
export async function acquireChainLock(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<string> {
  const dir = getChainLockDir(agentId);
  const seed = chainLockToken();
  const nowSec = Math.floor(Date.now() / 1000);
  const staleSec = Math.floor(CHAIN_LOCK_STALE_MS / 1000);
  const out = await runCommand(
    `# CHAIN_LOCK_ACQUIRE\n` +
      `mkdir -p ${shellQuote(`${agentsDir()}/locks`)}\n` +
      `LOCK_DIR=${shellQuote(dir)}\n` +
      `shelly_try_acquire_chain_lock() {\n` +
      `  if mkdir "$LOCK_DIR" 2>/dev/null; then\n` +
      `    printf '%s' ${shellQuote(seed)} > "$LOCK_DIR/seed"\n` +
      `    printf '' > "$LOCK_DIR/token"\n` +
      `    printf '%s' "$1" > "$LOCK_DIR/acquired-at"\n` +
      `    echo CHAIN_LOCK_OK\n` +
      `    return 0\n` +
      `  fi\n` +
      `  return 1\n` +
      `}\n` +
      `if ! shelly_try_acquire_chain_lock ${nowSec}; then\n` +
      `  ACQUIRED_AT=$(cat "$LOCK_DIR/acquired-at" 2>/dev/null || echo 0)\n` +
      `  case "$ACQUIRED_AT" in ''|*[!0-9]*) ACQUIRED_AT=0 ;; esac\n` +
      `  AGE=$(( ${nowSec} - ACQUIRED_AT ))\n` +
      `  if [ "$AGE" -ge ${staleSec} ]; then\n` +
      `    rm -rf "$LOCK_DIR"\n` +
      `    shelly_try_acquire_chain_lock ${nowSec} || echo CHAIN_LOCK_BUSY\n` +
      `  else\n` +
      `    echo CHAIN_LOCK_BUSY\n` +
      `  fi\n` +
      `fi`
  );
  if (out.includes('CHAIN_LOCK_BUSY')) {
    throw new Error(`agent ${agentId}: another run of this agent is already holding the chain lock`);
  }
  return seed;
}

/** Release the chain-scoped lock, but only if it is still the SAME lock this
 * call originally acquired (seed match) — see the module doc comment above.
 * Best-effort: never throws, since a failed release must not abort the rest
 * of the chain's own bookkeeping (aggregate log persist, memory capture,
 * etc.) that happens after it in a `finally`. */
export async function releaseChainLock(
  agentId: string,
  seed: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const dir = getChainLockDir(agentId);
  try {
    await runCommand(
      `# CHAIN_LOCK_RELEASE\n` +
        `HELD=$(cat ${shellQuote(`${dir}/seed`)} 2>/dev/null || true); ` +
        `if [ "$HELD" = ${shellQuote(seed)} ]; then rm -rf ${shellQuote(dir)}; fi`
    );
  } catch (error) {
    logWarn('AgentChainLock', `failed to release chain lock for ${agentId}`, error);
  }
}

/** Invalidate the chain lock's live token immediately after a step/candidate's
 * run is observed complete (before any other JS work in that loop iteration)
 * so a stale on-disk script sitting in the inter-step gap — LOCK_FILE
 * released, the next materialize not yet written — no longer matches the
 * (now-cleared) live token if a native alarm happens to fire in that exact
 * window. Re-armed for the NEXT attempt by materializeAgent's own write (see
 * MaterializeRunOpts.chainLockNonce). Best-effort, same reasoning as
 * releaseChainLock. */
async function disarmChainLockToken(
  agentId: string,
  seed: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const dir = getChainLockDir(agentId);
  try {
    await runCommand(
      `# CHAIN_LOCK_DISARM\n` +
        `HELD=$(cat ${shellQuote(`${dir}/seed`)} 2>/dev/null || true); ` +
        `if [ "$HELD" = ${shellQuote(seed)} ]; then printf '' > ${shellQuote(`${dir}/token`)}; fi`
    );
  } catch (error) {
    logWarn('AgentChainLock', `failed to disarm chain lock token for ${agentId}`, error);
  }
}

/**
 * ③b-2: run an agent through its escalation ladder. Try the primary backend; if
 * the attempt failed (error status OR a local-context fallback digest), climb to
 * the next allowed tool and re-run, until one succeeds or the ladder is exhausted.
 * Every attempt goes through the SAME single-run path (materialize → gated run),
 * so the boundary + command-safety + secret-guard re-check on each attempt — the
 * autonomous boundary is never widened. Non-final attempts suppress the error
 * notification so the user sees only the final outcome (next tool's success, or
 * the last tool's failure). The first success performs the action exactly once.
 */
async function runEscalatingAttempts(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  options: { waitTimeoutMs?: number; pollMs?: number; optimisticWorkspaceWrites?: boolean },
  runStartedAtMs: number,
): Promise<void> {
  // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): this
  // single-run ladder has the exact same "materialize+run per candidate,
  // release LOCK_FILE between candidates" shape runAgentOrchestrated's
  // multi-step loop has — see the module doc comment above acquireChainLock.
  // Held across the WHOLE attempt sequence, released only after the final
  // restore-to-original-config materialize below (in `finally`, so an early
  // throw from runLadderAttempts still releases it).
  const chainLockSeed = await acquireChainLock(agent.id, runCommand);
  try {
    const { ladder } = await runLadderAttempts(agent, agent.id, runCommand, options, runStartedAtMs, {
      chainLockSeed,
      optimisticWorkspaceWrites: options.optimisticWorkspaceWrites,
    });

    // Restore the agent's own (un-overridden) script so a later scheduled fire uses
    // the configured tool / fresh route, not the last escalation override. Any
    // non-noEscalation ladder pins the attempt tool into the on-disk script — even
    // a SINGLE-element one (e.g. keyless web-mandatory → [Codex]) — so restore
    // whenever an override could have been written, not only on multi-tool ladders
    // (otherwise adding the missing key later wouldn't reach the alarm path until
    // an unrelated re-materialize).
    // An optimistic run ALSO forces the restore even on a noEscalation ladder:
    // the per-attempt script on disk carries ACTION_APPROVAL_MODE_OVERRIDE='auto'
    // baked by the optimistic path, and that transient loosening must not
    // survive as the STORED script a later unattended AlarmManager fire reads
    // (an unattended fire has no savepoint and no one to press "元に戻す").
    if (!ladder.noEscalation || options.optimisticWorkspaceWrites) {
      try {
        // Deliberately no chainLockNonce here — this is the STORED script a
        // later native alarm fire reads directly, so it must bake an empty
        // nonce (see MaterializeRunOpts.chainLockNonce's doc comment).
        // Deliberately no optimisticWorkspaceWrites either, for the same reason.
        await materializeAgent(agent, runCommand, false);
      } catch (error) {
        // Best-effort: a later foreground run or startup-repair re-materializes. Log
        // so a stale on-disk override (attended ladders only) is diagnosable.
        logWarn('AgentEscalation', `failed to restore configured script for ${agent.id}`, error);
      }
    }
  } finally {
    await releaseChainLock(agent.id, chainLockSeed, runCommand);
  }
}

/**
 * Run one logical attempt-with-escalation: resolve the ladder for `runAgent`
 * (its prompt — or, on the orchestration path, materializeOpts.routeTextOverride,
 * the step's own raw instruction — drives the route, so an orchestration STEP
 * escalates by what IT is: a collect-news step climbs Gemini→Codex, a summarize
 * step stays on the local→free-cloud→Codex ladder), then try each
 * candidate tool until one produces a real result (not error / fallback digest).
 * Shared by the single-run path and each orchestration step. Does NOT restore the
 * on-disk script — the caller owns that (single-run restores; orchestration
 * re-materializes the orchestration agent after the whole chain).
 */
async function runLadderAttempts(
  runAgent: Agent,
  agentId: string,
  runCommand: (cmd: string) => Promise<string>,
  options: { waitTimeoutMs?: number; pollMs?: number },
  runStartedAtMs: number,
  materializeOpts: {
    suppressAction?: boolean;
    // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): the seed
    // returned by the caller's acquireChainLock, threaded down so each
    // candidate's materialize call can bake + arm a fresh live token (see
    // MaterializeRunOpts.chainLockNonce's doc comment).
    // Absent for a caller that isn't chain-lock-scoped (none today — both
    // runEscalatingAttempts and runAgentOrchestrated always pass it — but
    // kept optional defensively rather than assumed non-null).
    chainLockSeed?: string;
    /** Set ONLY by runEscalatingAttempts for a validated optimistic run (see
     *  runAgentNowInner). Never set on the orchestration path — multi-step runs
     *  are not rollback-eligible. */
    optimisticWorkspaceWrites?: boolean;
    /**
     * 2026-08-03 on-device fix (DEFERRED.md「オーケストレーションのステップ実行が
     * 合成プロンプト全文でルーティング判定され偽の成功通知に至る」): the text the
     * ladder/scorer judge the route by. Set ONLY by runAgentOrchestratedBody to
     * the step's OWN raw instruction — runAgent.prompt there is buildStepPrompt's
     * composite (base prompt + prior step results + instruction), and routing on
     * that let a prior collect-news step's time-sensitive result text misclassify
     * a pure summarize step as web-mandatory (Perplexity then answered the
     * composite with an unrelated essay logged as success). The composite prompt
     * itself is UNCHANGED — it is still what the chosen tool receives, since a
     * summarize step needs the prior results to summarize. Absent → the ladder
     * routes on runAgent.prompt exactly as before (single-run path unchanged).
     */
    routeTextOverride?: string;
    /** See MaterializeRunOpts.isOrchestratedStep's doc comment. Set ONLY by
     *  runAgentOrchestratedBody, for every step (final and non-final alike). */
    isOrchestratedStep?: boolean;
    /** See MaterializeRunOpts.priorStepContent's doc comment. */
    priorStepContent?: string;
  } = {},
): Promise<{ ladder: EscalationLadder; finalLog: AgentRunLog | undefined }> {
  const env = await ladderEnvFromDisk(runCommand);
  const ladder = resolveEscalationLadder(runAgent, env, materializeOpts.routeTextOverride);
  let finalLog: AgentRunLog | undefined;

  for (let i = 0; i < ladder.tools.length; i++) {
    const isLast = i === ladder.tools.length - 1;
    // For an escalating ladder, force the configured-tool branch to pick exactly
    // this candidate (pins/secret already shaped the ladder; resolveAgentRoute
    // STILL re-checks secret-guard per attempt as defense in depth). For a
    // no-escalation ladder, run the agent unchanged.
    const attemptAgent: Agent = ladder.noEscalation
      ? runAgent
      : { ...runAgent, tool: ladder.tools[i], runOn: 'auto' };

    let before: AgentRunLog[] = [];
    try {
      before = (await readAgentRunLogs(runCommand, agentId))[agentId] ?? [];
    } catch {
      // fall back to timestamp gating below
    }

    await materializeAgent(attemptAgent, runCommand, false, true, {
      suppressErrorNotification: !isLast,
      suppressAction: materializeOpts.suppressAction,
      routeTextOverride: materializeOpts.routeTextOverride,
      isOrchestratedStep: materializeOpts.isOrchestratedStep,
      priorStepContent: materializeOpts.priorStepContent,
      // round 2 TOCTOU fix: deliberately do NOT pass env.autonomousCloudConsent
      // (read once, before this loop started) as the BAKED script value. A
      // multi-candidate ladder can span a full agent run — up to
      // AGENT_RUN_WAIT_TIMEOUT_MS (20 minutes) — between attempts via the
      // waitForAgentRunCompletion await below; that is a real window in which
      // the user can revoke consent in Settings. Baking the stale `env` value
      // here for attempt i>0 would re-write a script claiming consent that is
      // no longer current — the exact fail-closed violation round 1 missed
      // (it only serialized rematerializeAutonomousAgents against itself, not
      // against this loop). Leaving autonomousCloudConsent undefined lets
      // materializeAgent's own queued turn read consent from disk immediately
      // before ITS write (see materializeAgent's comment), inside the same
      // queue turn as the write — no other queued write can land between that
      // read and this attempt's write. `env.autonomousCloudConsent` above is
      // still used to build `ladder` (line ~676): which tool to TRY next is an
      // attended/foreground routing choice, not the unattended-safety property
      // this fixes. If consent is revoked mid-ladder, this attempt's freshly
      // re-read false value makes generateRunScript refuse/fall back the
      // now-unauthorized keyed tool and the ladder escalates — the safe
      // outcome, not a stale ON write surviving to disk.
      suppressWebCodexBake: true,
      // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): fresh
      // per-attempt token, not a chain-lifetime constant — see the module doc
      // comment above acquireChainLock for why a constant nonce wouldn't
      // actually close the inter-step gap. Absent (undefined) when this
      // caller isn't chain-lock-scoped, which bakes an empty nonce — a script
      // with an empty baked nonce can never match a live chain lock either.
      chainLockNonce: materializeOpts.chainLockSeed ? chainLockToken() : undefined,
      // DEFERRED #2 境界: a human drove this run (Run now / @agent) and is
      // in-app to answer escalations — bake unattended:false so the driver
      // keeps the escalation wait for a gray verdict. The post-ladder /
      // post-chain restore (below and in runAgentOrchestrated) re-writes the
      // stored script WITHOUT this flag (unattended:true) for the alarm/
      // native fires.
      attended: true,
      // DEFERRED.md エージェント二重実行レース ("副産物として見つかった実在する
      // データ消失リスク" fix): `attemptAgent` may have `.orchestration`
      // already cleared and `.tool` pinned by the caller (an orchestration
      // step) — never let this attempt's materialize overwrite the persistent
      // `<id>.json` with that transient shape. See MaterializeRunOpts's doc
      // comment for why leaving the on-disk metadata untouched here is safe.
      skipMetadataWrite: true,
      // 2026-07-29 on-device fix (see MaterializeRunOpts.skipSkillPlanRehydration):
      // this attempt's `.orchestration` is already exactly what the caller
      // wants run (cleared for an orchestration step, untouched for a
      // single-run ladder). Re-expanding a skill recipe's stored PlanSpec into
      // it here would both undo that shaping AND flip this attempt's native
      // launch onto the PlanSpec-executor route, where the chain lock THIS
      // chain is holding reads as a foreign holder and skips the attempt.
      skipSkillPlanRehydration: true,
      // Rollback-type execution: only reaches here for a run runAgentNowInner
      // already validated as fully reversible AND successfully snapshotted.
      // generateRunScript re-checks the action type before honouring it.
      optimisticWorkspaceWrites: materializeOpts.optimisticWorkspaceWrites,
    });
    await TerminalEmulator.runAgent(agentId);
    await waitForAgentRunCompletion(runCommand, agentId, {
      runStartedAtMs: i === 0 ? runStartedAtMs : Date.now() - 5_000,
      previousRunCount: before.length,
      previousLatestTimestamp: before.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
      timeoutMs: options.waitTimeoutMs ?? AGENT_RUN_WAIT_TIMEOUT_MS,
      pollMs: options.pollMs ?? AGENT_RUN_WAIT_POLL_MS,
    });
    // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): disarm
    // BEFORE any other work in this iteration — this attempt's run is done,
    // so its now-stale on-disk script must stop matching the live chain lock
    // the instant it's safe to (see the module doc comment above
    // acquireChainLock). Re-armed by the NEXT attempt's own materialize call.
    if (materializeOpts.chainLockSeed) {
      await disarmChainLockToken(agentId, materializeOpts.chainLockSeed, runCommand);
    }

    const after = (await readAgentRunLogs(runCommand, agentId))[agentId] ?? [];
    finalLog = after.at(-1);

    if (ladder.noEscalation || isLast) break;
    // Stop on a real success OR a 'skipped' run: a skip means a concurrent run of
    // THIS agent holds the per-agent lock, so climbing to another tool would just
    // skip again — let the concurrent run produce the result. Only a genuine
    // failure (error / fallback digest) climbs.
    if (!attemptFailed(finalLog?.status, finalLog?.outputPreview, materializeOpts.priorStepContent)) break;
    // P3 UX fix (docs/superpowers/DEFERRED.md "エスカレーションラダーが「毎回
    // 人間承認」アクションで人間に多重リクエストする"): cli/intent/dm-reply
    // require an in-app approval tap on EVERY attempt because the run result
    // IS the approval object. When this attempt's failure is a deterministic
    // dispatch-time/environment failure (e.g. the cli action's fixed command
    // exits 127 because it isn't on Shelly's PATH), switching to the next
    // ladder tool re-runs generation but replays the exact same dispatch
    // (same fixed command / intent target / dm pairing) against the same
    // environment — it cannot succeed differently, so climbing would only ask
    // the human to approve the identical doomed action a second time. End as
    // a single failure instead. A genuine model-quality failure (prompt echo,
    // refusal, empty completion — isLowQualityCompletion) is NOT this class
    // and keeps escalating exactly as before.
    if (isDeterministicDispatchFailure(runAgent.action?.type, finalLog?.outputPreview)) break;
    // else: escalate to the next tool
  }

  return { ladder, finalLog };
}

/**
 * Phase 4: run an agent as an ordered LINEAR chain. Each step is executed through
 * the EXISTING single-run path (materialize → B2 driver), so every command still
 * passes the same boundary + command-safety gate — chaining adds no privilege.
 * The budget (hard step + time caps) REFUSES further steps rather than hanging
 * (Android phantom-process ceiling). A failed step stops the chain and makes the
 * whole run one 'error' for the circuit breaker. Result surfaces as a single run
 * log carrying per-step detail.
 */
async function runAgentOrchestrated(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  options: { waitTimeoutMs?: number; pollMs?: number } = {},
  /** Agent used for the post-chain restore materialize. Differs from `agent`
   *  only on the skill-reuse path, where `agent` carries steps rehydrated from
   *  a skill recipe and the persistent record should keep its stored shape —
   *  see runAgentNowInner's call site. */
  restoreAgent: Agent = agent,
): Promise<void> {
  const agentId = agent.id;
  // DEFERRED.md エージェント二重実行レース (chain-lock follow-up): held across
  // the ENTIRE chain — every step's runLadderAttempts call below AND the
  // final restore-to-original-config materialize — released only in
  // `finally` so an early `break`/thrown error still releases it. See the
  // module doc comment above acquireChainLock for the full design.
  const chainLockSeed = await acquireChainLock(agentId, runCommand);
  try {
    await runAgentOrchestratedBody(agent, runCommand, options, chainLockSeed, restoreAgent);
  } finally {
    await releaseChainLock(agentId, chainLockSeed, runCommand);
  }
}

async function runAgentOrchestratedBody(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  options: { waitTimeoutMs?: number; pollMs?: number },
  chainLockSeed: string,
  restoreAgent: Agent = agent,
): Promise<void> {
  const agentId = agent.id;
  const steps = normalizeSteps(agent.orchestration);
  const budget = resolveBudget(agent.orchestration);
  // Fan-out subtasks (2026-08-13): resolve which steps run as isolated
  // branches of a parallel group (see AgentOrchestrationStep.parallelGroup's
  // doc comment in store/types.ts for the full contract). DISPATCH BELOW
  // STAYS SERIAL — this attended path is per-agent single-flight by hard
  // design (the chain lock's single rotating live nonce, the shared per-agent
  // script/result-file/log-dir paths every per-step materialize writes, the
  // run-log-count completion detection, and the global MAX_CONCURRENT=2
  // guard baked into every generated .sh for the Android phantom-process
  // ceiling), so concurrent branch dispatch is structurally unsafe here and
  // deferred — see DEFERRED.md's 2026-08-13 fan-out entry for the blocker
  // list. What a group changes TODAY is context flow only: each branch's
  // prompt and duplicate-of-prior-step check use the PRE-group results
  // snapshot (contextBase) instead of the running carry, so sibling branches
  // never contaminate (or false-positive the duplicate detector against)
  // each other, and the first post-group step aggregates every branch's
  // result in declared order. Grouping never widens privilege: branches run
  // through the IDENTICAL runLadderAttempts path (same boundary policy, same
  // credential vetting, same quality gates) an unmarked step uses.
  const parallelPlan = planParallelGroups(steps);
  const startedAtMs = Date.now();
  const priorResults: string[] = [];
  const records: AgentRunStep[] = [];
  let priorFailed = false;
  // Snapshot existing log files so we can remove the per-step logs this chain
  // writes and replace them with ONE aggregate (so the circuit breaker counts a
  // failed chain as one run, and the per-step detail survives a reload).
  const beforeFiles = await listAgentLogFiles(runCommand, agentId);

  for (let i = 0; i < steps.length; i++) {
    const gate = nextStepGate({ stepIndex: i, budget, startedAtMs, now: Date.now(), priorFailed });
    if (!gate.proceed) break;

    // Each step is a normal single run with a step-specific prompt; orchestration
    // is cleared so the step itself doesn't recurse. Phase 5: a step may pin a
    // concrete tool (steps[i].tool) — when present it REPLACES agent.tool for
    // this attempt, which routes it through resolveAgentRoute's existing
    // 'configured-tool' path (same one a top-level non-auto Agent.tool already
    // uses) and skips keyword-based auto-selection for this step only. Absent
    // tool = agent.tool unchanged = today's exact auto-routing behavior.
    const step = steps[i];
    // Only the FINAL step performs the agent action (draft/notify/webhook/cli) —
    // non-final steps suppress it so the chain fires ONE approval/notification,
    // not one per step.
    const isFinalStep = i === steps.length - 1;
    // Fan-out subtasks: a branch of a parallel group sees only the results
    // produced BEFORE the group (its group's start index); a serial step's
    // slice is a no-op (contextBase[i] === i === priorResults.length under
    // the fail-fast invariant — every earlier step succeeded or we never got
    // here). See the parallelPlan comment above.
    const contextResults = priorResults.slice(0, parallelPlan.contextBase[i]);
    const stepAgent: Agent = {
      ...agent,
      prompt: buildStepPrompt(agent.prompt, step.instruction, contextResults),
      // Orchestration is otherwise cleared so a step's own script generation
      // doesn't recurse into runAgentOrchestrated again — isOrchestrated()
      // only keys off .steps.length >= 2 (via normalizeSteps), so an object
      // carrying an EMPTY steps array plus charLimit is safe: it does not
      // re-trigger multi-step routing, it only survives long enough for
      // generateRunScript to read .charLimit. The G6 charLimit guarantee
      // applies to the FINAL step's dispatched content only (an intermediate
      // "collect"/"summarize" step must keep its full text for the next
      // step's context, not get truncated to an X-post budget) — see
      // generateRunScript's RESULT_CHAR_LIMIT wiring in lib/agent-executor.ts
      // (2026-07-15 P1 audit fix: this field previously had no path from
      // agent.orchestration.charLimit into the actual dispatch at all).
      orchestration: isFinalStep && agent.orchestration?.charLimit ? { steps: [], charLimit: agent.orchestration.charLimit } : undefined,
      tool: step.tool ?? agent.tool,
    };
    const stepStart = Date.now();
    let log: AgentRunLog | undefined;
    try {
      // Each step escalates through the ladder by its OWN instruction — so a
      // collect-news step climbs Gemini(grounded)→Codex instead of dead-ending
      // on a non-web local digest. Non-final steps suppress the action.
      // routeTextOverride (2026-08-03 on-device fix): route on step.instruction,
      // NOT stepAgent.prompt — that composite carries the prior steps' results,
      // whose time-sensitive content misclassified a pure summarize step as
      // web-mandatory and escalated it to Perplexity, which "succeeded" with an
      // off-task essay and fired a fake completion notification. The composite
      // prompt still goes to the chosen tool unchanged.
      ({ finalLog: log } = await runLadderAttempts(
        stepAgent,
        agentId,
        runCommand,
        { waitTimeoutMs: options.waitTimeoutMs, pollMs: options.pollMs },
        stepStart - 5_000,
        {
          suppressAction: !isFinalStep,
          chainLockSeed,
          routeTextOverride: step.instruction,
          isOrchestratedStep: true,
          // DEFERRED.md「重複コンテンツ検知の欠如(P1)」: the immediately
          // preceding step's result (undefined for step 0, matching
          // priorResults' own empty-at-start state) — see
          // MaterializeRunOpts.priorStepContent's doc comment. Fan-out
          // subtasks: taken from the SAME pre-group snapshot the prompt uses,
          // so two branches of one group legitimately producing similar
          // results are never compared against each other (only against the
          // last PRE-group result) — a sibling comparison would false-positive
          // the duplicate detector on exactly the similar-parallel-research
          // outputs fan-out exists to produce.
          priorStepContent: contextResults.at(-1),
        },
      ));
    } catch (error) {
      records.push({
        index: i,
        instruction: step.instruction,
        status: 'error',
        durationMs: Date.now() - stepStart,
        outputPreview: error instanceof Error ? error.message.slice(0, 200) : 'step failed',
        ...(parallelPlan.group[i] ? { parallelGroup: parallelPlan.group[i] } : {}),
      });
      priorFailed = true;
      continue;
    }
    // Preserve a transient 'unavailable' as its own step status (do NOT collapse
    // to 'error'): the chain still stops (priorFailed below), but reduceStatus
    // folds it to an 'unavailable' run that the circuit breaker EXCLUDES — so a
    // multi-step agent isn't auto-disabled by a transient web outage either.
    const status: AgentRunStep['status'] = log?.status ?? 'error';
    records.push({
      index: i,
      instruction: step.instruction,
      status,
      durationMs: Date.now() - stepStart,
      outputPreview: log?.outputPreview ?? '',
      routeDecision: log?.routeDecision,
      ...(parallelPlan.group[i] ? { parallelGroup: parallelPlan.group[i] } : {}),
    });
    // A transient step carries no usable result downstream, so it stops the chain
    // just like an error — only success feeds the next step's context.
    if (status === 'success') priorResults.push(log?.outputPreview ?? '');
    else priorFailed = true;
  }

  // Restore the original (orchestration) script after the last step-prompt run.
  // Deliberately no chainLockNonce here — this is the STORED script a later
  // native alarm fire reads directly, so it must bake an empty nonce (see
  // MaterializeRunOpts.chainLockNonce's doc comment).
  try {
    await materializeAgent(restoreAgent, runCommand, false);
  } catch {
    // best-effort
  }

  // Aggregate the chain into a SINGLE on-disk run log (carrying per-step detail),
  // replacing the per-step logs this chain wrote. Disk and store then agree, the
  // circuit breaker counts one run, and the steps survive a reload.
  const aggregate: AgentRunLog = {
    agentId,
    timestamp: Date.now(),
    status: reduceStatus(records),
    outputPreview: combineFinalPreview(records, steps.length),
    durationMs: Date.now() - startedAtMs,
    toolUsed: records.at(-1)?.routeDecision?.toolLabel ?? 'orchestration',
    routeDecision: records.at(-1)?.routeDecision,
    steps: records,
  };
  try {
    const afterFiles = await listAgentLogFiles(runCommand, agentId);
    const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));
    const logDir = `${agentsDir()}/logs/${agentId}`;
    const aggFile = `${logDir}/${aggregate.timestamp}.json`;
    const cmd =
      `set -e\n` +
      `mkdir -p ${shellQuote(logDir)}\n` +
      newFiles.map((f) => `rm -f ${shellQuote(f)}`).join('\n') +
      (newFiles.length ? '\n' : '') +
      writeFileCommand(aggFile, JSON.stringify(aggregate));
    await runCommand(cmd);
  } catch (error) {
    console.warn('orchestration: failed to persist aggregate log', agentId, error);
  }
  // Load the aggregate (+ prior logs) into the store — one run for the breaker —
  // and run the same post-run hooks the single-run path uses.
  await syncAgentRunLogsFromDisk(runCommand, agentId);
  await captureRunMemory(agentId, runCommand);
  await updateReusedSkillFromRun(agentId, runCommand);
}

/** List the agent's run-log file paths on disk (best-effort). */
async function listAgentLogFiles(
  runCommand: (cmd: string) => Promise<string>,
  agentId: string
): Promise<string[]> {
  try {
    const out = await runCommand(
      `ls -1 ${shellQuote(`${agentsDir()}/logs/${agentId}`)}/*.json 2>/dev/null || true`
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Phase 2a + learning loop (2026-08-03) + self-improvement (2026-08-13): after
 * a run of an agent that reuses a skill, feed the outcome back into the recipe
 * via lib/skill-self-improve.ts's ONE decision function. Success bumps
 * success-count + lastUsed (clearing any stored failure hint); a real failure
 * records a one-line, secret-scanned hint that buildSkillInjectionContext
 * surfaces as a caution on the NEXT matched run. NEW: a success that resolves
 * a pending failure hint additionally proposes promoting that hint into a
 * persistent body learning — this JS-driven path is ATTENDED (every
 * runAgentNow caller is a human-driven UI flow; see runLadderAttempts'
 * `attended: true` bake), so per skillImproveMode the body change is only
 * STAGED here and applied after the user confirms in the foreground offer
 * (hooks/use-skill-save-offer.ts). 'unavailable' (transient web outage) and
 * 'skipped' are deliberately ignored — the same statuses the circuit breaker
 * excludes — so a flaky network never poisons a recipe with a bogus caution.
 * Best-effort, same persistence path (crash-safe writeSkillRecipe + Vault
 * mirror) in both directions.
 */
async function updateReusedSkillFromRun(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (!agent?.skillId) return;
  const latest = useAgentStore.getState().getRunHistory(agentId).at(-1);
  if (!latest) return;
  if (latest.status !== 'success' && latest.status !== 'error') return;
  try {
    const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId);
    if (!recipe) return;
    const proposal = proposeSkillImprovement({
      recipe,
      status: latest.status,
      outputPreview: latest.outputPreview,
      timestamp: latest.timestamp,
    });
    if (proposal.kind === 'noop') return;
    if (proposal.kind === 'bump-with-learning') {
      // Attended discipline: persist the metadata bump now (exactly what this
      // function always did on success) and stage the BODY change for the
      // foreground confirm. Declining (or never answering) simply keeps
      // today's behavior — the bump below already cleared the failure hint.
      await writeSkillRecipe(runCommand, bumpSkillUsage(recipe, latest.timestamp));
      stageSkillImprovementProposal(agentId, { ...proposal, agentName: agent.name });
      return;
    }
    await writeSkillRecipe(runCommand, proposal.improved);
  } catch (error) {
    console.warn('Failed to update reused skill for agent', agentId, error);
  }
}

/**
 * Phase 1 memory-write: after a successful TS-driven run, save the result digest
 * as a memory note when the agent opted in (memory.remember). Best-effort — a
 * memory failure never fails the run. (Scheduled/alarm-fired runs have no TS
 * runtime alive to call this directly — see captureRunMemoryFromSyncedLogs,
 * which captures the same digest at the next app-launch log sync instead.)
 */
async function captureRunMemory(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (!agent?.memory?.remember) return;
  const latest = useAgentStore.getState().getRunHistory(agentId).at(-1);
  if (!latest || latest.status !== 'success') return;
  const digest = extractRunDigest(latest.outputPreview || '');
  if (!digest) return;
  // MEMORY-001 Step 4 (strangler; MEMORY_ENABLED=true since 2026-08-05): see
  // persistRememberFact for the fallback rationale — same G2-fallback-on-failure
  // contract applies here.
  if (MEMORY_ENABLED) {
    const ok = await activateMemoryWrite({
      agentId,
      type: 'result',
      text: digest,
      tags: agent.memory?.tags,
    });
    if (ok) {
      await refreshAgentRecall(agentId, runCommand);
      return;
    }
  }
  try {
    const note = makeMemoryNote({ agentId, type: 'result', text: digest, tags: agent.memory?.tags });
    // Idempotent id: an unchanged digest re-writes the same file, so there is
    // nothing new to recall and no reason to pay for a re-bake.
    const existing = await readMemoryNotes(agentId);
    const isNew = !existing.some((n) => n.id === note.id);
    await writeMemoryNote(runCommand, note);
    invalidateMemoryImportCache(agentId);
    // Recall freshness (see refreshAgentRecall): re-bake so the NEXT unattended
    // fire recalls what this run just learned, instead of waiting for the next
    // app launch's startup repair.
    if (isNew) await refreshAgentRecall(agentId, runCommand);
  } catch (error) {
    console.warn('Failed to capture run memory for agent', agentId, error);
  }
}

/**
 * G2 follow-up: after an app-launch log sync, capture the LATEST success digest
 * of every remember-enabled agent into memory — this is the only hook scheduled
 * (alarm-fired) runs get, since they finish with no TS runtime alive. Note ids
 * are content-derived (memoryNoteId), so repeated syncs are idempotent; an
 * already-present note is skipped without a shell write. Mirrors
 * captureRunMemory's semantics (latest success only — no historical backfill).
 */
async function captureRunMemoryFromSyncedLogs(
  agents: Agent[],
  runHistory: Record<string, AgentRunLog[]>,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  for (const agent of agents) {
    // Skip agents deleted since the sync snapshot — writing a note (or saving
    // a skill) would resurrect their memory/<id>/ dir or skill state until
    // the next orphan sweep.
    if (!useAgentStore.getState().agents.some((a) => a.id === agent.id)) continue;
    const latest = (runHistory[agent.id] ?? []).at(-1);
    if (!latest || latest.status !== 'success') continue;

    // --- Skill auto-save (G3, unattended-only) -------------------------
    // On-device QA bug: a genuinely successful, secret-free, correctly
    // remember+schedule-configured unattended run never triggered an
    // auto-save. Root cause was here — this call used to live INSIDE the
    // memory-write try block below, downstream of three gates
    // (`!agent.memory?.remember`, `!digest`, and the memory-note dedup
    // check) that exist for the MEMORY feature and have nothing to do with
    // skill-save eligibility. A real run whose outputPreview happens to be
    // entirely a fenced code block collapses to an empty digest
    // (extractRunDigest strips ``` fences before collapsing whitespace),
    // silently skipping BOTH memory-write and skill-save; an agent that
    // never opted into memory.remember could never get an auto-saved skill
    // either, even with a real, non-empty digest. Skill-save now runs
    // unconditionally on every synced success (still gated on being an
    // unattended trigger — schedule or notificationTrigger — and on not
    // already reusing a skill), independent of the memory gates below.
    // Ephemeral/attended @agent runs are manual-only and use the foreground
    // offer (hooks/use-skill-save-offer.ts) instead of this path.
    // A scheduled agent can also produce an attended log through Sidebar's
    // explicit Run Now path. While runAgentNow owns that foreground turn, its
    // caller supplies the confirm-mode save offer; do not misclassify the same
    // log as an unattended alarm fire during the run's internal log sync.
    if ((agent.schedule || agent.notificationTrigger) && !inFlightAgentRuns.has(agent.id)) {
      try {
        // saveUnattendedSkillWithNotification is itself idempotent (skips a
        // recipe whose content-derived id already exists on disk), so a
        // recurring schedule's repeat log-sync polls of the same latest
        // success don't re-notify or clobber a curator-promoted recipe.
        await saveUnattendedSkillWithNotification(runCommand, {
          name: agent.name,
          prompt: agent.prompt,
          routeDecision: latest.routeDecision,
          timestamp: latest.timestamp,
          status: latest.status,
          alreadySkillId: agent.skillId,
          unattended: true,
        }, {
          title: t('sidebar.skill_saved_title'),
          body: t('sidebar.skill_saved_body', { name: agent.name }),
          deleteButton: t('sidebar.skill_save_delete'),
        });
      } catch (error) {
        logWarn('AgentSkills', `failed to save synced unattended run for ${agent.id}`, error);
      }
    }

    // --- Memory-write (G2 follow-up) ------------------------------------
    // Unrelated to skill-save above: an agent that hasn't opted into
    // memory.remember, or whose output has no extractable digest, simply
    // gets no memory note — skill-save above already ran regardless.
    if (!agent.memory?.remember) continue;
    // Defense in depth: current scripts mark a local-context fallback as an
    // error, but a log written by an OLDER script version could carry
    // success + the fallback digest — never let that poison recall.
    if (isLocalFallbackDigest(latest.outputPreview)) continue;
    const digest = extractRunDigest(latest.outputPreview || '');
    if (!digest) continue;
    try {
      const note = makeMemoryNote({ agentId: agent.id, type: 'result', text: digest, tags: agent.memory?.tags });
      const existing = await readMemoryNotes(agent.id);
      if (existing.some((n) => n.id === note.id)) continue;
      await writeMemoryNote(runCommand, note);
      invalidateMemoryImportCache(agent.id);
      // Recall freshness: this is the UNATTENDED capture path (results synced
      // from scheduled fires that never touched JS), so it is precisely the
      // case that used to stay stale until the next app launch.
      await refreshAgentRecall(agent.id, runCommand);
    } catch (error) {
      logWarn('AgentMemory', `failed to capture synced run memory for ${agent.id}`, error);
    }
  }
}

/**
 * Skill self-improvement, UNATTENDED side (2026-08-13): scheduled/alarm-fired
 * runs finish with no TS runtime alive, so — exactly like memory capture and
 * skill auto-save above — their outcome feedback for a REUSED skill happens at
 * the next log sync. Per skillImproveMode's 'auto' mode, everything applies
 * without a confirm; a BODY change (learning promoted) additionally posts a
 * notification with a one-tap revert action, mirroring the auto-save's
 * post-hoc delete. Gated to unattended-trigger agents (schedule /
 * notificationTrigger — the same gate the auto-save uses): a manual-only
 * agent's improvements go through updateReusedSkillFromRun's attended confirm
 * instead. Repeat polls of the same latest run are no-ops —
 * proposeSkillImprovement compares the run timestamp against the recipe's
 * lastUsed/lastFailure.at, which the previous application already advanced.
 */
async function improveReusedSkillsFromSyncedLogs(
  agents: Agent[],
  runHistory: Record<string, AgentRunLog[]>,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  for (const agent of agents) {
    if (!agent.skillId) continue;
    if (!agent.schedule && !agent.notificationTrigger) continue;
    // Skip agents deleted since the sync snapshot (same rule as memory/save).
    if (!useAgentStore.getState().agents.some((a) => a.id === agent.id)) continue;
    const latest = (runHistory[agent.id] ?? []).at(-1);
    if (!latest) continue;
    if (latest.status !== 'success' && latest.status !== 'error') continue;
    try {
      // Re-read inside the loop: two agents can share one skill, and each
      // application must build on the previous write, not a stale snapshot.
      const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId);
      if (!recipe) continue;
      const proposal = proposeSkillImprovement({
        recipe,
        status: latest.status,
        outputPreview: latest.outputPreview,
        timestamp: latest.timestamp,
      });
      if (proposal.kind === 'noop') continue;
      await applyUnattendedSkillImprovement(
        runCommand,
        { ...proposal, agentName: agent.name },
        {
          title: t('sidebar.skill_improved_title'),
          body: t('sidebar.skill_improved_body', { name: agent.name }),
          revertButton: t('sidebar.skill_improve_revert'),
        }
      );
    } catch (error) {
      logWarn('AgentSkills', `failed to improve reused skill for ${agent.id}`, error);
    }
  }
}

/**
 * Poll for a fresh run-log JSON under ~/.shelly/agents/logs/<agentId>/ (a
 * `find … -name '*.json'` shell round-trip every `options.pollMs`, see
 * readAgentRunLogs) until one appears whose timestamp is both newer than the
 * pre-run snapshot AND >= runStartedAtMs, or `options.timeoutMs` elapses —
 * whichever comes first. This loop is BOUNDED: the `while (Date.now() <=
 * deadline)` guard always terminates and rejects with "Timed out waiting for
 * agent …" once the deadline passes (see the throw below), it does not spin
 * forever. bug #164 (docs/superpowers/DEFERRED.md): what looked like an
 * infinite busy-poll on-device was this loop legitimately bounded but called
 * with the 20-minute unattended default from an ATTENDED (chat-visible)
 * call site with zero incremental UI feedback — see
 * ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS's doc comment above.
 */
async function waitForAgentRunCompletion(
  runCommand: (cmd: string) => Promise<string>,
  agentId: string,
  options: {
    runStartedAtMs: number;
    previousRunCount: number;
    previousLatestTimestamp: number;
    timeoutMs: number;
    pollMs: number;
  }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const grouped = await readAgentRunLogs(runCommand, agentId);
      const logs = grouped[agentId] ?? [];
      const latest = logs.at(-1);
      const hasNewRun =
        logs.length > options.previousRunCount ||
        (latest?.timestamp ?? Number.NEGATIVE_INFINITY) > options.previousLatestTimestamp;
      if (latest && hasNewRun && latest.timestamp >= options.runStartedAtMs) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(options.pollMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for agent "${agentId}" to finish${detail}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopAgent(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  await runCommand(generateStopCommand(agentId));
}

/**
 * Delete an agent and clean up.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  // ids are generated slugs (`agent-<ts>`) or sanitized names; refuse anything
  // with shell metacharacters so the $HOME-relative rm below is injection-safe.
  assertSafeAgentId(agentId);
  // bug #164 diagnostics (2026-07-28 on-device re-repro, versionCode 1987):
  // deleteAgent is what confirmAgentDraft's ephemeral-one-shot branch runs in
  // its `finally`, AFTER runAgentNow either succeeds or throws (e.g. the
  // ATTENDED_AGENT_RUN_WAIT_TIMEOUT_MS timeout) — so the user-visible
  // "[@agent] failed: …" message can never render until THIS resolves too. It
  // makes two more unlogged native-bridge calls of its own
  // (uninstallSchedule → TerminalEmulator.cancelAgent, then
  // TerminalEmulator.execCommand below) — if either hangs, a correctly-
  // detected timeout upstream would still leave the chat bubble looking
  // permanently stuck with no error ever surfacing. Bracket both so a repro
  // shows whether cleanup — not just the run itself — is where time (or the
  // hang) is actually going.
  logInfo('AgentManager', `deleteAgent: calling uninstallSchedule for ${agentId}`);
  try {
    await uninstallSchedule(agentId);
  } catch (error) {
    console.warn('deleteAgent: failed to cancel schedule before file cleanup', agentId, error);
    // Best-effort: deleting the run script below still neutralizes any leftover alarm.
  }
  logInfo('AgentManager', `deleteAgent: uninstallSchedule settled for ${agentId}, starting file cleanup`);
  // Delete via the live shell $HOME — NOT the JS getHomePath() cache. The cache
  // can hold an unresolved /data/user/0 alias that doesn't resolve to the real
  // files dir on some OEM builds, so `rm -f <alias>` silently exits 0 while the
  // real <id>.json survives and the agent resurrects on next loadAgentsFromDisk
  // (bug: deleted agents reappear after restart). `$HOME` is the same home the
  // interactive shell uses, so it always hits the real files. `set -e` + a
  // post-rm existence check + an exitCode assertion make a failed delete LOUD
  // instead of swallowed, so the store entry is only dropped on confirmed removal.
  const command =
    `set -e\n` +
    `d="$HOME/.shelly/agents"\n` +
    `if [ -s "$d/logs/${agentId}/agent-driver-audit.jsonl" ]; then\n` +
    `  mkdir -p "$d/audits"\n` +
    `  cp "$d/logs/${agentId}/agent-driver-audit.jsonl" "$d/audits/${agentId}-agent-driver-audit.jsonl"\n` +
    `fi\n` +
    `rm -f "$d/${agentId}.json" "$d/run-agent-${agentId}.sh" "$d/plans/plan-agent-${agentId}.json" "$d/locks/${agentId}.pid"\n` +
    `rm -rf "$d/locks/${agentId}.pid.lockdir" "$d/locks/${agentId}.chain.lock"\n` +
    `rm -rf "$d/logs/${agentId}"\n` +
    // Phase 1 memory lives under memory/<id>; drop it with the agent so a deleted
    // agent leaves no orphaned memory behind (the Vault mirror is left in place
    // for human review, like drafts/audits).
    `rm -rf "$d/memory/${agentId}"\n` +
    `[ ! -e "$d/${agentId}.json" ] || { echo "delete failed: ${agentId}.json still present" >&2; exit 1; }\n` +
    `mkdir -p "$d/${DELETED_AGENT_MARKER_DIR}"\n` +
    `printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" > "$d/${DELETED_AGENT_MARKER_DIR}/${agentId}"`;
  logInfo('AgentManager', `deleteAgent: calling execCommand for ${agentId}`);
  const result = await TerminalEmulator.execCommand(command, 30_000);
  logInfo('AgentManager', `deleteAgent: execCommand returned for ${agentId} (exitCode=${result.exitCode})`);
  if (result.exitCode !== 0) {
    throw new Error(
      `deleteAgent(${agentId}) failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || '').trim()}`
    );
  }
  // An in-flight native run can finish after the cancellation above and re-arm
  // from its captured cron extras. Cancel once more after metadata deletion is
  // confirmed so every ordering of delete vs completion ends with no live or
  // boot-persisted schedule. Native post-run validation is the second fence.
  try {
    await uninstallSchedule(agentId);
  } catch (error) {
    console.warn('deleteAgent: failed to cancel schedule after file cleanup', agentId, error);
  }
  useAgentStore.getState().removeAgent(agentId);
}

/**
 * Remove orphan agent artifacts — run scripts (`run-agent-<id>.sh`) and log dirs
 * whose `<id>.json` no longer exists (e.g. left by an interrupted deleteAgent whose
 * rm threw and was swallowed). Best-effort; called on load so a stray script can't
 * accumulate or zombie-fire. The schedule is already cancelled at delete time, but
 * removing the script also neutralises any leftover alarm (missing-script no-op).
 */
export async function cleanupOrphanAgentFiles(
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const dir = agentsDir();
  const cmd =
    `cd ${shellQuote(dir)} 2>/dev/null || exit 0\n` +
    `for s in run-agent-*.sh; do [ -e "\$s" ] || continue; id="\${s#run-agent-}"; id="\${id%.sh}"; [ -f "\$id.json" ] || rm -f "\$s"; done\n` +
    `for p in plans/plan-agent-*.json; do [ -e "\$p" ] || continue; id="\${p#plans/plan-agent-}"; id="\${id%.json}"; [ -f "\$id.json" ] || rm -f "\$p"; done\n` +
    `for d in logs/*/; do [ -e "\$d" ] || continue; id="\$(basename "\$d")"; [ -f "\$id.json" ] || rm -rf "\$d"; done`;
  try {
    await runCommand(cmd);
  } catch {
    // best-effort cleanup; never block startup
  }
}

const haltSentinelPath = () => `${agentsDir()}/.halted`;

/**
 * Pause / resume a single agent (Phase 0 §2.5). Persists `enabled` to the agent's
 * JSON metadata (survives restart) and installs/uninstalls its AlarmManager
 * schedule accordingly. Manual-only agents (schedule === null) just flip the flag.
 */
export async function setAgentEnabled(
  agentId: string,
  enabled: boolean,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const store = useAgentStore.getState();
  const agent = store.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const changes: Partial<Agent> = enabled
    ? { enabled, circuitBreakerResetAt: Date.now() }
    : { enabled };
  const updated: Agent = { ...agent, ...changes };
  store.updateAgent(agentId, changes);
  // Persist the flag so a restart doesn't silently re-enable a paused agent.
  await runCommand(
    `set -e\n${writeFileCommand(`${agentsDir()}/${agentId}.json`, JSON.stringify(updated, null, 2))}`
  );
  if (!agent.schedule) return; // manual-only: nothing to (un)install
  if (enabled && !store.halted) {
    await installSchedule(updated);
  } else {
    await uninstallSchedule(agentId);
  }
}

/**
 * Global kill-switch ON (Phase 0 §2.5): uninstall every agent's schedule so
 * nothing fires, and drop a sentinel so the halt survives a restart and manual
 * runs stay blocked. Per-agent `enabled` is preserved so resume can restore it.
 */
export async function haltAllAgents(
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const store = useAgentStore.getState();
  const failures: string[] = [];
  for (const a of store.agents) {
    if (a.schedule) {
      try {
        await uninstallSchedule(a.id);
      } catch (error) {
        // Keep halting the rest, but fail loudly after every cancellation has
        // been attempted so the UI cannot report an unqualified success.
        failures.push(`alarm cancellation failed for ${a.id}: ${String(error)}`);
      }
    }
  }
  store.setHalted(true);
  try {
    await runCommand(`set -e\n${writeFileCommand(haltSentinelPath(), 'halted\n')}`);
  } catch (error) {
    failures.push(`halt sentinel write failed: ${String(error)}`);
  }
  if (failures.length > 0) {
    throw new Error(`STOP-ALL could not be fully applied: ${failures.join('; ')}`);
  }
}

/** Global kill-switch OFF: clear the sentinel and re-install schedules for every
 *  still-enabled, scheduled agent. */
export async function resumeAllAgents(
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const store = useAgentStore.getState();
  store.setHalted(false);
  try {
    await runCommand(`rm -f ${shellQuote(haltSentinelPath())}`);
  } catch {
    // ignore
  }
  for (const a of store.agents) {
    if (a.enabled && a.schedule) {
      try {
        await installSchedule(a);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Send notification for agent result.
 */
export async function notifyAgentResult(
  agent: Agent,
  status: 'success' | 'error' | 'skipped' | 'unavailable',
  summary: string
): Promise<void> {
  // 'unavailable' (transient web outage) gets its own ⏳ glyph so the user reads it
  // as "will retry", not a hard ❌ failure they need to act on.
  const icon =
    status === 'success' ? '✅' : status === 'error' ? '❌' : status === 'unavailable' ? '⏳' : '⏭️';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${icon} ${agent.name}`,
      body: summary,
      data: { agentId: agent.id },
    },
    trigger: null,
  });
}

/** `expectedAtMs` → "M/D HH:MM" in the device's local time zone, for the
 *  missed-schedule notification body. Deliberately minimal (no relative-time
 *  suffix, unlike Sidebar's formatWhen) since this is a one-shot notification,
 *  not a live-updating detail popup. */
function formatMissedWhen(expectedAtMs: number): string {
  const d = new Date(expectedAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * P0-1 reliability: notify the user that a scheduled fire was due but never
 * recorded a run — the alarm was silently lost (Doze / OEM battery management
 * / a foreground-service start failure) with no other user-visible signal
 * unless they happen to open the agent's detail popup. Called from
 * scheduleAgentStartupRepair AFTER the re-arm attempt (materializeAgent) for
 * this same pass has already resolved — `repaired` reflects whether that
 * attempt actually succeeded, so the notification never claims a re-arm that
 * didn't happen. Best-effort: a failure to post must not block the repair
 * pass itself.
 */
async function notifyMissedSchedule(agent: Agent, expectedAtMs: number, repaired: boolean): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `⚠ ${t('agents.missed_schedule_title')}`,
        body: t(repaired ? 'agents.missed_schedule_body' : 'agents.missed_schedule_body_repair_failed', {
          name: agent.name,
          when: formatMissedWhen(expectedAtMs),
        }),
        data: { agentId: agent.id, missedAt: expectedAtMs, repaired },
      },
      trigger: null,
    });
  } catch (error) {
    logWarn('AgentStartupRepair', `failed to post missed-schedule notification for ${agent.id}`, error);
  }
}

/**
 * Load agents from filesystem on app startup.
 * Called from app initialization.
 */
export async function loadAgentsFromDisk(
  runCommand: (cmd: string) => Promise<string>,
  options: {
    syncLogs?: boolean;
    repairSchedules?: boolean;
    repairDelayMs?: number;
    shouldRepair?: () => boolean;
  } = {}
): Promise<void> {
  const {
    syncLogs = true,
    repairSchedules = true,
    repairDelayMs,
    shouldRepair,
  } = options;

  try {
    // Restore the global kill-switch (§2.5) from its sentinel so a halt survives restart.
    try {
      const haltedOut = await runCommand(
        `[ -f ${shellQuote(haltSentinelPath())} ] && echo HALTED_YES || echo HALTED_NO`
      );
      useAgentStore.getState().setHalted(haltedOut.includes('HALTED_YES'));
    } catch {
      // ignore — default not halted
    }

    const agents = syncLogs
      ? await readAgentMetadataViaShell(runCommand)
      : await readAgentMetadataLightweight(runCommand);

    if (agents.length === 0) {
      useAgentStore.getState().setAgents([]);
      // Still sweep — "deleted every agent" can leave orphan scripts/logs.
      if (syncLogs) void cleanupOrphanAgentFiles(runCommand);
      return;
    }
    const runHistory = syncLogs
      ? await readAgentRunLogs(runCommand)
      : useAgentStore.getState().runHistory;
    const agentsWithStatus = agents.map((agent) => {
      const latest = runHistory[agent.id]?.at(-1);
      return latest
        ? {
            ...agent,
            lastRun: latest.timestamp,
            // 'skipped'/'unavailable' intentionally keep the prior lastResult: the
            // badge shouldn't flip to a hard verdict for a declined or transient
            // run. The truthful per-run status still lives in the run-log history.
            lastResult: latest.status === 'success' ? 'success' as const : latest.status === 'error' ? 'error' as const : agent.lastResult,
          }
        : agent;
    });

    if (syncLogs) {
      useAgentStore.getState().setRunHistory(runHistory);
    }
    useAgentStore.getState().setAgents(agentsWithStatus);
    if (syncLogs) {
      // Sweep orphan scripts/logs left by past deletes (best-effort, non-blocking).
      void cleanupOrphanAgentFiles(runCommand);
      // Skill curator (2026-08-05): best-effort registry sweep — promotes
      // proven recipes, archives never-reused stale ones (reversible flag,
      // never deletes), and only LOGS near-duplicate merge proposals. Same
      // fire-and-forget contract as the cleanup above: it catches everything
      // internally and can never block or break startup.
      void runSkillCuratorSweep(runCommand);
      // G2 follow-up: scheduled (alarm-fired) runs have no TS post-run hook, so
      // their results never entered memory (recall is baked into scripts, but
      // new result digests were only captured by foreground runs). Capture the
      // latest success per remember-enabled agent from the just-synced history.
      void captureRunMemoryFromSyncedLogs(agentsWithStatus, runHistory, runCommand);
      // Self-improvement: same fire-and-forget contract, same synced history —
      // feed unattended run outcomes back into REUSED skill recipes.
      void improveReusedSkillsFromSyncedLogs(agentsWithStatus, runHistory, runCommand);
    }
    if (repairSchedules) {
      scheduleAgentStartupRepair(agentsWithStatus, runCommand, repairDelayMs, shouldRepair);
    }
  } catch {
    useAgentStore.getState().setAgents([]);
  }
}

function scheduleAgentStartupRepair(
  agents: Agent[],
  runCommand: (cmd: string) => Promise<string>,
  delayMs = 60_000,
  shouldRun: (() => boolean) | undefined
): void {
  const scheduledAgents = agents.filter((agent) => agent.enabled && agent.schedule);
  if (scheduledAgents.length === 0) return;

  setTimeout(() => {
    if (shouldRun && !shouldRun()) return;
    // Don't re-install schedules while the global kill-switch is on.
    if (useAgentStore.getState().halted) return;
    void (async () => {
      for (const agent of scheduledAgents) {
        if (shouldRun && !shouldRun()) return;
        if (useAgentStore.getState().halted) return;
        // Skip agents deleted during the repair-delay window — re-materializing a
        // captured snapshot would rewrite its <id>.json + alarm and resurrect it.
        const storeAgent = useAgentStore.getState().agents.find((a) => a.id === agent.id);
        if (!storeAgent) continue;
        // The agent may have been paused during the repair delay. Never use the
        // captured enabled snapshot to resurrect it; also remove any stale native
        // or boot-persisted schedule left by an earlier build/startup pass.
        if (!storeAgent.enabled) {
          try {
            await uninstallSchedule(agent.id);
          } catch (error) {
            console.warn('Failed to remove disabled agent schedule during startup repair', agent.id, error);
          }
          continue;
        }
        // P0-1: a single lost alarm (Doze / OEM battery kill / FGS start
        // failure) otherwise leaves this schedule permanently and silently
        // dead — the only existing signal was the Sidebar detail popup, which
        // is passive (only checked if/when the user taps the agent). Detect it
        // HERE, independent of any UI interaction, and surface it via a local
        // notification. Dedup against the store's lastMissedNotifiedAt so
        // re-opening the app before the next successful fire doesn't re-notify
        // the same missed window on every launch.
        //
        // Read lastRun from storeAgent (the CURRENT store state), not the
        // captured `agent` snapshot — logs sync in the background during the
        // startup-repair delay, so `agent.lastRun` can be stale by the time
        // this runs and would otherwise report an already-completed run as
        // missed.
        let pendingMissedNotify: number | null = null;
        if (agent.schedule) {
          const { missed, expectedAt } = isScheduleMissed(agent.schedule, storeAgent.lastRun, agent.createdAt, Date.now(), MISSED_RUN_GRACE_MS, agent.startNotBefore);
          if (missed && expectedAt != null && storeAgent.lastMissedNotifiedAt !== expectedAt) {
            useAgentStore.getState().updateAgent(agent.id, { lastMissedNotifiedAt: expectedAt });
            // Mutate the local snapshot too, BEFORE the materialize call below,
            // so this SAME pass's metadata write persists the dedup marker to
            // disk immediately. Without this, loadAgentsFromDisk's own
            // useAgentStore.getState().setAgents(agentsWithStatus) on the NEXT
            // call (every app launch) would overwrite the whole store — wiping
            // the in-memory-only update above — before this loop ever runs
            // again, and the notification would repeat every launch.
            agent.lastMissedNotifiedAt = expectedAt;
            pendingMissedNotify = expectedAt;
          }
        }
        let repaired = false;
        try {
          // Re-arm regardless of whether a miss was just detected — this IS the
          // repair: every enabled scheduled agent gets a fresh native alarm for
          // its next legitimate occurrence on every app launch, independent of
          // whatever state AlarmManager silently ended up in.
          await materializeAgent(storeAgent, runCommand, true, false);
          repaired = true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch (error) {
          console.warn('Failed to repair scheduled agent on startup', agent.id, error);
        }
        // Notify AFTER the re-arm attempt has resolved, wording it according to
        // whether repair actually succeeded — never claim a re-arm that didn't
        // happen. The dedup marker above is set unconditionally (before this
        // point) so a repair failure still gets one notification, not a retry
        // storm on every subsequent launch.
        if (pendingMissedNotify != null) {
          await notifyMissedSchedule(agent, pendingMissedNotify, repaired);
        }
      }
    })();
  }, delayMs);
}

async function readAgentMetadataLightweight(
  runCommand: (cmd: string) => Promise<string>
): Promise<Agent[]> {
  const agents = await readAgentMetadataViaFileSystem();
  if (agents) return agents;
  return readAgentMetadataViaShell(runCommand);
}

async function readAgentMetadataViaFileSystem(): Promise<Agent[] | null> {
  try {
    const dirUri = toFileUri(agentsDir());
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dirUri);
    const deletedIds = await readDeletedAgentIdsViaFileSystem(dirUri);
    const agents: Agent[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const content = await FileSystem.readAsStringAsync(`${dirUri}/${name}`);
        const parsed: unknown = JSON.parse(content);
        if (isAgentMetadata(parsed)) {
          agents.push(parsed);
        }
      } catch {
        // Skip malformed or concurrently-written metadata files.
      }
    }
    return filterDeletedAgentMetadata(agents, deletedIds);
  } catch {
    return null;
  }
}

async function readDeletedAgentIdsViaFileSystem(dirUri: string): Promise<Set<string>> {
  try {
    const deletedUri = `${dirUri}/${DELETED_AGENT_MARKER_DIR}`;
    const info = await FileSystem.getInfoAsync(deletedUri);
    if (!info.exists || !info.isDirectory) return new Set();
    const names = await FileSystem.readDirectoryAsync(deletedUri);
    return new Set(names.filter((name) => isSafeAgentId(name)));
  } catch {
    return new Set();
  }
}

async function readAgentMetadataViaShell(
  runCommand: (cmd: string) => Promise<string>
): Promise<Agent[]> {
  const output = await runCommand(
    `d=${shellQuote(agentsDir())}\n` +
      `[ -d "$d" ] || exit 0\n` +
      `deleted="$d/${DELETED_AGENT_MARKER_DIR}"\n` +
      `for f in "$d"/*.json; do\n` +
      `  [ -f "$f" ] || continue\n` +
      `  id="\${f##*/}"\n` +
      `  id="\${id%.json}"\n` +
      `  [ -e "$deleted/$id" ] && continue\n` +
      `  cat "$f"\n` +
      `  echo "---SEPARATOR---"\n` +
      `done`
  );
  if (!output.trim()) return [];
  const agents: Agent[] = [];
  const chunks = output.split('---SEPARATOR---').filter((c) => c.trim());
  for (const chunk of chunks) {
    try {
      const parsed: unknown = JSON.parse(chunk.trim());
      if (isAgentMetadata(parsed)) {
        agents.push(parsed);
      }
    } catch {
      // Skip malformed agent files.
    }
  }
  return agents;
}

export async function syncAgentRunLogsFromDisk(
  runCommand: (cmd: string) => Promise<string>,
  agentId?: string
): Promise<void> {
  const runHistory = await readAgentRunLogs(runCommand, agentId);
  const store = useAgentStore.getState();
  const mergedHistory = agentId
    ? { ...store.runHistory, [agentId]: runHistory[agentId] || [] }
    : runHistory;

  // Agents auto-disabled by the circuit breaker this sync — side effects fire below.
  const tripped: Agent[] = [];
  const agents = store.agents.map((agent) => {
    const logs = mergedHistory[agent.id];
    const latest = logs?.at(-1);
    let next: Agent = latest
      ? {
          ...agent,
          lastRun: latest.timestamp,
          // 'skipped'/'unavailable' intentionally keep the prior lastResult: the
          // badge shouldn't flip to a hard verdict for a declined or transient run.
          lastResult:
            latest.status === 'success'
              ? ('success' as const)
              : latest.status === 'error'
              ? ('error' as const)
              : agent.lastResult,
        }
      : agent;
    // Circuit breaker (§2.5): auto-disable a still-enabled agent after N
    // consecutive failed runs so a misfiring agent can't loop forever.
    const resetAt = agent.circuitBreakerResetAt;
    const circuitBreakerLogs = resetAt
      ? logs?.filter((log) => log.timestamp > resetAt)
      : logs;
    if (next.enabled && shouldTripCircuitBreaker(circuitBreakerLogs)) {
      next = { ...next, enabled: false };
      tripped.push(next);
    }
    return next;
  });

  store.setRunHistory(mergedHistory);
  store.setAgents(agents);

  // G2 follow-up: this is the actual production-live periodic/foreground-resume
  // sync path (app/_layout.tsx's initial loadAgentsFromDisk call intentionally
  // passes syncLogs:false for a fast startup, deferring heavy sync to here) --
  // so the scheduled/alarm-fired-run memory+skill capture hook has to live in
  // THIS function to ever run in production, not in loadAgentsFromDisk's own
  // (currently unreachable) syncLogs:true branch.
  void captureRunMemoryFromSyncedLogs(agents, mergedHistory, runCommand);
  // Self-improvement: the production-live periodic/foreground-resume sync is
  // the hook unattended (alarm-fired) runs of a skill-reusing agent get.
  void improveReusedSkillsFromSyncedLogs(agents, mergedHistory, runCommand);

  for (const a of tripped) {
    if (a.schedule) {
      try {
        await uninstallSchedule(a.id);
      } catch {
        // best-effort
      }
    }
    try {
      // Persist enabled=false so the disable survives a restart.
      await runCommand(
        `set -e\n${writeFileCommand(`${agentsDir()}/${a.id}.json`, JSON.stringify(a, null, 2))}`
      );
    } catch {
      // ignore
    }
    try {
      await notifyAgentResult(
        a,
        'error',
        `Auto-disabled after ${DEFAULT_CIRCUIT_BREAKER_THRESHOLD} consecutive failures. Fix the issue, then re-enable it.`
      );
    } catch {
      // ignore
    }
  }
}

async function readAgentRunLogs(
  runCommand: (cmd: string) => Promise<string>,
  agentId?: string
): Promise<Record<string, AgentRunLog[]>> {
  const logsRoot = `${agentsDir()}/logs`;
  const command = agentId
    ? `find ${shellQuote(`${logsRoot}/${agentId}`)} -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort | tail -n 30 | while IFS= read -r f; do cat "$f"; printf '\\n---SHELLY_AGENT_LOG---\\n'; done`
    : `for d in ${shellQuote(logsRoot)}/*; do [ -d "$d" ] || continue; find "$d" -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort | tail -n 30 | while IFS= read -r f; do cat "$f"; printf '\\n---SHELLY_AGENT_LOG---\\n'; done; done 2>/dev/null`;
  const output = await runCommand(command);
  const logs: AgentRunLog[] = [];
  for (const chunk of output.split('---SHELLY_AGENT_LOG---')) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      const log = JSON.parse(text) as AgentRunLog;
      if (
        typeof log.agentId === 'string' &&
        typeof log.timestamp === 'number' &&
        (log.status === 'success' ||
          log.status === 'error' ||
          log.status === 'skipped' ||
          log.status === 'unavailable')
      ) {
        logs.push(log);
      }
    } catch {
      // Ignore partially written or malformed logs.
    }
  }

  const grouped: Record<string, AgentRunLog[]> = {};
  for (const log of logs.sort((a, b) => a.timestamp - b.timestamp)) {
    grouped[log.agentId] = [...(grouped[log.agentId] || []), log].slice(-30);
  }
  return grouped;
}

/**
 * Persist a single agent to disk.
 */
export function generateSaveCommand(agent: Agent): string {
  const json = JSON.stringify(agent, null, 2);
  const escaped = json.replace(/'/g, "'\\''");
  const dir = agentsDir();
  return `mkdir -p ${shellQuote(dir)} && echo '${escaped}' > ${shellQuote(`${dir}/${agent.id}.json`)}`;
}

/**
 * Atomic write: `cat > path` would TRUNCATE in place, so an alarm-fired run
 * already reading the script (bash reads scripts incrementally) could execute
 * a garbled tail — consent re-bake / startup repair / ladder overrides all
 * rewrite live scripts. Write to a unique tmp in the same dir and rename
 * (atomic on the same filesystem). A rename replaces the inode, dropping the
 * exec bit `cat >` used to preserve — carry it over from the existing file
 * before the mv so a fire between mv and the caller's chmod +x still runs.
 */
function writeFileCommand(path: string, content: string): string {
  const marker = `SHELLY_AGENT_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const target = shellQuote(path);
  const tmp = shellQuote(`${path}.${marker}.tmp`);
  return `mkdir -p "$(dirname ${target})" && cat > ${tmp} <<'${marker}' && { [ ! -x ${target} ] || chmod +x ${tmp}; } && mv -f ${tmp} ${target}
${content}
${marker}`;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}
