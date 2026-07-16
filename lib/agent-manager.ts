/**
 * lib/agent-manager.ts — Agent CRUD, orchestration, and @agent command parsing.
 * Entry point for all agent operations from the chat UI.
 */
import { useAgentStore } from '@/store/agent-store';
import { Agent, AgentRunLog, ToolChoice } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { sanitizeAgentName } from './sanitize-agent-name';
import { resolveForAutonomous } from './agent-credential-policy';
import { resolveEscalationLadder, attemptFailed, isLocalFallbackDigest, LadderEnv, EscalationLadder } from './agent-escalation-ladder';
import { logWarn } from './debug-logger';
import { generateRunScript, generateStopCommand, generateInstallCommands, getScriptPath } from './agent-executor';
import { buildAgentPlanSpec, getPlanSpecPath } from './agent-plan-spec';
import { installSchedule, uninstallSchedule, nextTriggerMs, isScheduleMissed } from './agent-scheduler';
import { t } from '@/lib/i18n';
import { shouldTripCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_THRESHOLD } from './agent-circuit-breaker';
import {
  buildRecallContext,
  extractRunDigest,
  makeMemoryNote,
  readMemoryNotes,
  recallMemoryNotes,
  writeMemoryNote,
} from './agent-memory';
// MEMORY-001 shadow/activation seam (dormant): flag + entry points imported
// from their own modules (not the '@/lib/memory' index) so host memory tests
// that import the index never transitively load expo-file-system via fs-expo.
import { MEMORY_ENABLED } from './memory/wiring';
import { shadowMemoryRecall, activateMemoryRecall, activateMemoryWrite } from './memory/shadow';
import {
  buildSkillInjectionContext,
  bumpSkillUsage,
  readSkillRecipes,
  writeSkillRecipe,
} from './agent-skills';
import {
  buildStepPrompt,
  combineFinalPreview,
  isOrchestrated,
  nextStepGate,
  normalizeSteps,
  reduceStatus,
  resolveBudget,
} from './agent-orchestration';
import type { AgentRunStep } from '@/store/types';
import { getHomePath } from '@/lib/home-path';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';

const agentsDir = () => `${getHomePath()}/.shelly/agents`;
export const DELETED_AGENT_MARKER_DIR = '.deleted';
const deletedAgentsDir = () => `${agentsDir()}/${DELETED_AGENT_MARKER_DIR}`;
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const AGENT_RUN_WAIT_TIMEOUT_MS = 20 * 60_000;
const AGENT_RUN_WAIT_POLL_MS = 1_500;

export function isSafeAgentId(agentId: string): boolean {
  return SAFE_AGENT_ID_RE.test(agentId);
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
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'run', message: `Running ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'stop': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'stop', message: `Stopping ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'delete': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'delete', message: `Delete ${agent.name}?`, data: { agent } };
    }

    case 'history': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      const logs = store.getRunHistory(agent.id);
      return { type: 'history', message: formatHistory(agent, logs), data: { logs } };
    }

    case 'edit': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
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
  runOn?: Agent['runOn'];
  memory?: Agent['memory'];
  skillId?: Agent['skillId'];
  orchestration?: Agent['orchestration'];
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
    runOn: params.runOn,
    memory: params.memory,
    skillId: params.skillId,
    orchestration: params.orchestration,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: Date.now(),
    version: 1,
  };

  useAgentStore.getState().addAgent(agent);
  return agent;
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
  const agentForRun = await applyMemoryAndSkills(agent);

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
      ? { ...agent, nextExpectedAt: nextTriggerMs(agent.schedule) }
      : agent;
  const commands = [
    `mkdir -p ${shellQuote(agentsDir())}`,
    `mkdir -p ${shellQuote(`${agentsDir()}/plans`)}`,
    `rm -f ${shellQuote(`${deletedAgentsDir()}/${agent.id}`)}`,
    `rm -f "$HOME/.shelly/agents/${DELETED_AGENT_MARKER_DIR}/${agent.id}"`,
    // Metadata stores the ORIGINAL agent (no baked recall) so memory never
    // compounds across materializations; the script gets the effective prompt.
    writeFileCommand(metadataPath, JSON.stringify(metadataAgent, null, 2)),
    writeFileCommand(scriptPath, generateRunScript(agentForRun, effectiveRunOpts)),
    writeFileCommand(planSpecPath, JSON.stringify(planSpec, null, 2)),
    ...generateInstallCommands(agent),
  ];

  await runCommand(`set -e\n${commands.join('\n')}`);
  if (installAlarm) {
    await installSchedule(agent);
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
async function applyMemoryAndSkills(agent: Agent): Promise<Agent> {
  let prompt = agent.prompt;
  // Phase 2a skill reuse: a skill was attached at creation via the gated
  // "use skill X?" confirm. Prepend its recipe.
  if (agent.skillId) {
    try {
      const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId) ?? null;
      const skillContext = buildSkillInjectionContext(recipe);
      if (skillContext) prompt = `${skillContext}\n\n---\n\n${prompt}`;
    } catch {
      // Skill injection is best-effort; never block a run on a read failure.
    }
  }
  // Phase 1 memory recall.
  try {
    const notes = await readMemoryNotes(agent.id);
    // MEMORY-001 Step 3 (strangler, flag-OFF today): while MEMORY_ENABLED is
    // false this whole branch is dead code and the G2 recall below is the ONLY
    // thing that ever runs — byte-identical to pre-Step-3 behavior. When the
    // flag is eventually flipped, activateMemoryRecall's rendered context is
    // injected INSTEAD OF G2's, but a `null` return (any internal MEMORY-001
    // failure) falls back to the G2 result computed below rather than to no
    // recall at all — G2 is the on-device-verified path, so falling back to IT
    // is safer than silently dropping the agent's memory.
    let recallContext: string | null = null;
    if (MEMORY_ENABLED) {
      await shadowMemoryRecall(agent, notes).catch(() => {});
      recallContext = await activateMemoryRecall(agent, notes);
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

/** Write the registering "remember that …" fact as a memory note (idempotent). */
async function persistRememberFact(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const fact = agent.memory?.rememberFact?.trim();
  if (!fact) return;
  // MEMORY-001 Step 4 (strangler, flag-OFF today): while MEMORY_ENABLED is
  // false this branch never runs and G2's writeMemoryNote below is the ONLY
  // write path — byte-identical to pre-Step-4 behavior. When the flag is
  // flipped, activateMemoryWrite (which reuses G2's own makeMemoryNote for
  // normalization) replaces the G2 write; a `false` return (any internal
  // MEMORY-001 failure) falls back to G2's write rather than silently losing
  // the fact.
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

export async function runAgentNow(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>,
  options: {
    waitTimeoutMs?: number;
    pollMs?: number;
    runStartedAtMs?: number;
  } = {}
): Promise<void> {
  assertSafeAgentId(agentId);
  // Global kill-switch: while halted, refuse manual runs too (not just scheduled).
  if (useAgentStore.getState().halted) {
    throw new Error('All agents are stopped (global kill-switch is on). Resume agents to run.');
  }
  // Phase 4: a multi-step agent runs as a linear chain (each step through the
  // SAME gated single-run path below). Single-step agents fall through unchanged.
  const orchestrationAgent = useAgentStore.getState().agents.find((a) => a.id === agentId);
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
  if (orchestrationAgent && isOrchestrated(orchestrationAgent.orchestration)) {
    await runAgentOrchestrated(orchestrationAgent, runCommand, options);
    return;
  }
  const runStartedAtMs = options.runStartedAtMs ?? Date.now() - 5_000;
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (agent) {
    await runEscalatingAttempts(agent, runCommand, options, runStartedAtMs);
  }
  await syncAgentRunLogsFromDisk(runCommand, agentId);
  await captureRunMemory(agentId, runCommand);
  await bumpReusedSkillOnSuccess(agentId, runCommand);
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
  options: { waitTimeoutMs?: number; pollMs?: number },
  runStartedAtMs: number,
): Promise<void> {
  const { ladder } = await runLadderAttempts(agent, agent.id, runCommand, options, runStartedAtMs);

  // Restore the agent's own (un-overridden) script so a later scheduled fire uses
  // the configured tool / fresh route, not the last escalation override. Any
  // non-noEscalation ladder pins the attempt tool into the on-disk script — even
  // a SINGLE-element one (e.g. keyless web-mandatory → [Codex]) — so restore
  // whenever an override could have been written, not only on multi-tool ladders
  // (otherwise adding the missing key later wouldn't reach the alarm path until
  // an unrelated re-materialize).
  if (!ladder.noEscalation) {
    try {
      await materializeAgent(agent, runCommand, false);
    } catch (error) {
      // Best-effort: a later foreground run or startup-repair re-materializes. Log
      // so a stale on-disk override (attended ladders only) is diagnosable.
      logWarn('AgentEscalation', `failed to restore configured script for ${agent.id}`, error);
    }
  }
}

/**
 * Run one logical attempt-with-escalation: resolve the ladder for `runAgent`
 * (its prompt drives the route — so an orchestration STEP escalates by its own
 * step instruction, e.g. a collect-news step climbs Gemini→Codex), then try each
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
  materializeOpts: { suppressAction?: boolean } = {},
): Promise<{ ladder: EscalationLadder; finalLog: AgentRunLog | undefined }> {
  const env = await ladderEnvFromDisk(runCommand);
  const ladder = resolveEscalationLadder(runAgent, env);
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
      // DEFERRED #2 境界: a human drove this run (Run now / @agent) and is
      // in-app to answer escalations — bake unattended:false so the driver
      // keeps the escalation wait for a gray verdict. The post-ladder /
      // post-chain restore (below and in runAgentOrchestrated) re-writes the
      // stored script WITHOUT this flag (unattended:true) for the alarm/
      // native fires.
      attended: true,
    });
    await TerminalEmulator.runAgent(agentId);
    await waitForAgentRunCompletion(runCommand, agentId, {
      runStartedAtMs: i === 0 ? runStartedAtMs : Date.now() - 5_000,
      previousRunCount: before.length,
      previousLatestTimestamp: before.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
      timeoutMs: options.waitTimeoutMs ?? AGENT_RUN_WAIT_TIMEOUT_MS,
      pollMs: options.pollMs ?? AGENT_RUN_WAIT_POLL_MS,
    });

    const after = (await readAgentRunLogs(runCommand, agentId))[agentId] ?? [];
    finalLog = after.at(-1);

    if (ladder.noEscalation || isLast) break;
    // Stop on a real success OR a 'skipped' run: a skip means a concurrent run of
    // THIS agent holds the per-agent lock, so climbing to another tool would just
    // skip again — let the concurrent run produce the result. Only a genuine
    // failure (error / fallback digest) climbs.
    if (!attemptFailed(finalLog?.status, finalLog?.outputPreview)) break;
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
  options: { waitTimeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const agentId = agent.id;
  const steps = normalizeSteps(agent.orchestration);
  const budget = resolveBudget(agent.orchestration);
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
    const stepAgent: Agent = {
      ...agent,
      prompt: buildStepPrompt(agent.prompt, step.instruction, priorResults),
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
      ({ finalLog: log } = await runLadderAttempts(
        stepAgent,
        agentId,
        runCommand,
        { waitTimeoutMs: options.waitTimeoutMs, pollMs: options.pollMs },
        stepStart - 5_000,
        { suppressAction: !isFinalStep },
      ));
    } catch (error) {
      records.push({
        index: i,
        instruction: step.instruction,
        status: 'error',
        durationMs: Date.now() - stepStart,
        outputPreview: error instanceof Error ? error.message.slice(0, 200) : 'step failed',
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
    });
    // A transient step carries no usable result downstream, so it stops the chain
    // just like an error — only success feeds the next step's context.
    if (status === 'success') priorResults.push(log?.outputPreview ?? '');
    else priorFailed = true;
  }

  // Restore the original (orchestration) script after the last step-prompt run.
  try {
    await materializeAgent(agent, runCommand, false);
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
    outputPreview: combineFinalPreview(records),
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
  await bumpReusedSkillOnSuccess(agentId, runCommand);
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
 * Phase 2a: when an agent that reuses a skill completes successfully, bump that
 * skill's success-count + lastUsed so good recipes float to the top. Best-effort.
 */
async function bumpReusedSkillOnSuccess(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (!agent?.skillId) return;
  const latest = useAgentStore.getState().getRunHistory(agentId).at(-1);
  if (!latest || latest.status !== 'success') return;
  try {
    const recipe = (await readSkillRecipes()).find((s) => s.id === agent.skillId);
    if (!recipe) return;
    await writeSkillRecipe(runCommand, bumpSkillUsage(recipe, latest.timestamp));
  } catch (error) {
    console.warn('Failed to bump reused skill for agent', agentId, error);
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
  // MEMORY-001 Step 4 (strangler, flag-OFF today): see persistRememberFact for
  // the fallback rationale — same G2-fallback-on-failure contract applies here.
  if (MEMORY_ENABLED) {
    const ok = await activateMemoryWrite({
      agentId,
      type: 'result',
      text: digest,
      tags: agent.memory?.tags,
    });
    if (ok) return;
  }
  try {
    await writeMemoryNote(
      runCommand,
      makeMemoryNote({ agentId, type: 'result', text: digest, tags: agent.memory?.tags })
    );
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
    if (!agent.memory?.remember) continue;
    // Skip agents deleted since the sync snapshot — writing a note would
    // resurrect their memory/<id>/ dir until the next orphan sweep.
    if (!useAgentStore.getState().agents.some((a) => a.id === agent.id)) continue;
    const latest = (runHistory[agent.id] ?? []).at(-1);
    if (!latest || latest.status !== 'success') continue;
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
    } catch (error) {
      logWarn('AgentMemory', `failed to capture synced run memory for ${agent.id}`, error);
    }
  }
}

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
  try {
    await uninstallSchedule(agentId);
  } catch (error) {
    console.warn('deleteAgent: failed to cancel schedule before file cleanup', agentId, error);
    // Best-effort: deleting the run script below still neutralizes any leftover alarm.
  }
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
    `rm -rf "$d/logs/${agentId}"\n` +
    // Phase 1 memory lives under memory/<id>; drop it with the agent so a deleted
    // agent leaves no orphaned memory behind (the Vault mirror is left in place
    // for human review, like drafts/audits).
    `rm -rf "$d/memory/${agentId}"\n` +
    `[ ! -e "$d/${agentId}.json" ] || { echo "delete failed: ${agentId}.json still present" >&2; exit 1; }\n` +
    `mkdir -p "$d/${DELETED_AGENT_MARKER_DIR}"\n` +
    `printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" > "$d/${DELETED_AGENT_MARKER_DIR}/${agentId}"`;
  const result = await TerminalEmulator.execCommand(command, 30_000);
  if (result.exitCode !== 0) {
    throw new Error(
      `deleteAgent(${agentId}) failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || '').trim()}`
    );
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
  const updated: Agent = { ...agent, enabled };
  store.updateAgent(agentId, { enabled });
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
  for (const a of store.agents) {
    if (a.schedule) {
      try {
        await uninstallSchedule(a.id);
      } catch {
        // best-effort: keep halting the rest even if one uninstall fails
      }
    }
  }
  store.setHalted(true);
  try {
    await runCommand(`set -e\n${writeFileCommand(haltSentinelPath(), 'halted\n')}`);
  } catch {
    // store flag is the source of truth this session; sentinel is for persistence
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
      // G2 follow-up: scheduled (alarm-fired) runs have no TS post-run hook, so
      // their results never entered memory (recall is baked into scripts, but
      // new result digests were only captured by foreground runs). Capture the
      // latest success per remember-enabled agent from the just-synced history.
      void captureRunMemoryFromSyncedLogs(agentsWithStatus, runHistory, runCommand);
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
          const { missed, expectedAt } = isScheduleMissed(agent.schedule, storeAgent.lastRun, agent.createdAt);
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
          await materializeAgent(agent, runCommand, true, false);
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
        const parsed = JSON.parse(content) as Agent;
        if (isSafeAgentId(parsed.id)) {
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
      const parsed = JSON.parse(chunk.trim()) as Agent;
      if (isSafeAgentId(parsed.id)) {
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
    if (next.enabled && shouldTripCircuitBreaker(logs)) {
      next = { ...next, enabled: false };
      tripped.push(next);
    }
    return next;
  });

  store.setRunHistory(mergedHistory);
  store.setAgents(agents);

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
