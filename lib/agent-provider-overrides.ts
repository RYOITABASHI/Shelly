/**
 * lib/agent-provider-overrides.ts — change which provider runs a step, also
 * while the agent is running (DEFERRED.md「タスクごとのプロバイダを自由に指定・
 * 途中で変更する」).
 *
 * The app writes `$HOME/.shelly/agents/logs/<id>/overrides.json` (the existing
 * per-agent log dir — no new directory):
 *
 *   { "v": 1, "runId"?: "<progress runId>", "steps": { "<index>": { "tool": ToolChoice } },
 *     "restartRunning"?: [<index>], "updatedAt": <ms> }
 *
 * Readers, all fail-closed (a malformed file is ignored, never half-applied):
 *  - scripts/shelly-plan-executor.js (v16) — before each step / group starts it
 *    swaps the tool of a step that has not started yet; a RUNNING step listed in
 *    `restartRunning` has just that branch's in-flight request aborted and is
 *    rerun on the new tool; any other running step finishes as it is.
 *  - the attended serial chain (lib/agent-manager.ts runAgentOrchestratedBody)
 *    — before each step, and reruns a finished step listed in `restartRunning`.
 *
 * `runId` scopes the file to one run (stale files are ignored by later runs);
 * a continuous loop's override has no runId so the next iteration picks it up
 * even when the fold below has not happened yet. After the run the app folds
 * the override into the agent definition (foldOverridesIntoAgent →
 * updateAgent, which re-materializes the PlanSpec / script) and removes the
 * file, so later runs keep the change.
 *
 * Pure, offline — no store / RN imports.
 */
import type { Agent, AgentOrchestrationStep, ToolChoice } from '@/store/types';
import { isAgentCliId, sameProvider } from './agent-cli-workers';

export const PROVIDER_OVERRIDES_FILE = 'overrides.json';
export const PROVIDER_OVERRIDES_VERSION = 1;
/** Same id charset lib/monitor-live-poll.ts interpolates into shell. */
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_STEP_INDEX = 31;

export type ProviderPick = 'auto' | 'local' | 'codex' | 'claude' | 'perplexity' | 'gemini' | 'cerebras' | 'groq';

/** MONITOR picker order. */
export const PROVIDER_PICKS: readonly ProviderPick[] = ['auto', 'local', 'codex', 'claude', 'perplexity', 'gemini', 'cerebras', 'groq'];

const OVERRIDE_TOOL_TYPES: ReadonlySet<string> = new Set(['auto', 'local', 'cli', 'perplexity', 'gemini-api', 'cerebras', 'groq']);

export function providerPickToTool(pick: ProviderPick): ToolChoice {
  switch (pick) {
    case 'local':
      return { type: 'local' };
    case 'codex':
      return { type: 'cli', cli: 'codex' };
    case 'claude':
      return { type: 'cli', cli: 'claude' };
    case 'perplexity':
      return { type: 'perplexity' };
    case 'gemini':
      return { type: 'gemini-api' };
    case 'cerebras':
      return { type: 'cerebras' };
    case 'groq':
      return { type: 'groq' };
    default:
      return { type: 'auto' };
  }
}

export function toolToProviderPick(tool: ToolChoice | null | undefined): ProviderPick {
  switch (tool?.type) {
    case 'local':
      return 'local';
    case 'cli':
      return tool.cli === 'claude' ? 'claude' : 'codex';
    case 'perplexity':
      return 'perplexity';
    case 'gemini-api':
      return 'gemini';
    case 'cerebras':
      return 'cerebras';
    case 'groq':
      return 'groq';
    default:
      return 'auto';
  }
}

/** Short display name (language-neutral product names). */
export function providerPickLabel(pick: ProviderPick): string {
  switch (pick) {
    case 'local':
      return 'Local LLM';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude Code';
    case 'perplexity':
      return 'Perplexity';
    case 'gemini':
      return 'Gemini';
    case 'cerebras':
      return 'Cerebras';
    case 'groq':
      return 'Groq';
    default:
      return 'Auto';
  }
}

export interface ProviderOverrides {
  v: 1;
  runId?: string;
  steps: Record<string, { tool: ToolChoice }>;
  restartRunning?: number[];
  updatedAt?: number;
}

/** A tool as it may appear in the file: a known type ONLY — a model is never
 *  read (no path tricks in a request URL, no cheap → expensive upgrade). */
export function sanitizeOverrideTool(raw: unknown): ToolChoice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : '';
  if (!OVERRIDE_TOOL_TYPES.has(type)) return null;
  if (type === 'cli') return isAgentCliId(r.cli) ? { type: 'cli', cli: r.cli } : null;
  if (type === 'auto') return { type: 'auto' };
  return { type } as ToolChoice;
}

function validIndex(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_STEP_INDEX;
}

/** Parse overrides.json; null for anything that is not a v1 file. Entries with
 *  an invalid index or tool are dropped individually. */
export function parseProviderOverrides(text: string | null | undefined): ProviderOverrides | null {
  if (!text || !text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== PROVIDER_OVERRIDES_VERSION) return null;
  const steps: Record<string, { tool: ToolChoice }> = {};
  if (r.steps && typeof r.steps === 'object' && !Array.isArray(r.steps)) {
    for (const [key, value] of Object.entries(r.steps as Record<string, unknown>)) {
      const index = /^\d{1,2}$/.test(key) ? Number(key) : NaN;
      if (!validIndex(index)) continue;
      const tool = sanitizeOverrideTool(value && typeof value === 'object' ? (value as Record<string, unknown>).tool : null);
      if (tool) steps[String(index)] = { tool };
    }
  }
  const out: ProviderOverrides = { v: 1, steps };
  if (typeof r.runId === 'string' && r.runId.length > 0 && r.runId.length <= 200) out.runId = r.runId;
  if (Array.isArray(r.restartRunning)) {
    const restart = Array.from(new Set(r.restartRunning.filter(validIndex))).filter((i) => steps[String(i)]);
    if (restart.length) out.restartRunning = restart;
  }
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)) out.updatedAt = r.updatedAt;
  return out;
}

/** True when `overrides` applies to the run `runId` (unscoped files apply to
 *  every run until folded). */
export function overridesApplyToRun(overrides: ProviderOverrides | null, runId: string | undefined): boolean {
  if (!overrides) return false;
  return !overrides.runId || overrides.runId === runId;
}

export function overrideToolForStep(
  overrides: ProviderOverrides | null,
  runId: string | undefined,
  index: number,
): ToolChoice | undefined {
  if (!overridesApplyToRun(overrides, runId)) return undefined;
  return overrides!.steps[String(index)]?.tool;
}

/** Add / replace one step's override. A different runId starts a fresh file
 *  (the old one belonged to an earlier run). `restart` lists the step in
 *  restartRunning; otherwise it is removed from it. */
export function mergeProviderOverride(
  existing: ProviderOverrides | null,
  change: { runId?: string; stepIndex: number; tool: ToolChoice; restart?: boolean },
  now: number = Date.now(),
): ProviderOverrides {
  const sameRun = !!existing && (existing.runId ?? '') === (change.runId ?? '');
  const base: ProviderOverrides = sameRun ? existing! : { v: 1, steps: {} };
  const steps = { ...base.steps, [String(change.stepIndex)]: { tool: change.tool } };
  const restartSet = new Set((base.restartRunning ?? []).filter((i) => i !== change.stepIndex));
  if (change.restart) restartSet.add(change.stepIndex);
  const restartRunning = Array.from(restartSet).sort((a, b) => a - b);
  return {
    v: 1,
    ...(change.runId ? { runId: change.runId } : {}),
    steps,
    ...(restartRunning.length ? { restartRunning } : {}),
    updatedAt: now,
  };
}

export function isSafeOverrideAgentId(agentId: string): boolean {
  return SAFE_AGENT_ID.test(agentId) && !agentId.includes('..');
}

function overridesShellPath(agentId: string): string {
  return `"$HOME/.shelly/agents/logs/${agentId}/${PROVIDER_OVERRIDES_FILE}"`;
}

/** Atomic write (tmp + mv) into the existing log dir. The JSON is built from
 *  sanitized data only; a single quote can never appear in it, but it is
 *  escaped anyway. '' for an unsafe agent id. */
export function buildWriteOverridesCommand(agentId: string, overrides: ProviderOverrides): string {
  if (!isSafeOverrideAgentId(agentId)) return '';
  const json = JSON.stringify(overrides).replace(/'/g, `'\\''`);
  const dir = `"$HOME/.shelly/agents/logs/${agentId}"`;
  return `mkdir -p ${dir} && printf '%s\\n' '${json}' > ${dir}/.${PROVIDER_OVERRIDES_FILE}.tmp && mv -f ${dir}/.${PROVIDER_OVERRIDES_FILE}.tmp ${overridesShellPath(agentId)}`;
}

export function buildReadOverridesCommand(agentId: string): string {
  if (!isSafeOverrideAgentId(agentId)) return '';
  return `cat ${overridesShellPath(agentId)} 2>/dev/null || true`;
}

export function buildClearOverridesCommand(agentId: string): string {
  if (!isSafeOverrideAgentId(agentId)) return '';
  return `rm -f ${overridesShellPath(agentId)}`;
}

/**
 * The tool a reader may actually use for an override read from the file
 * (writable by anything running as the app uid): 'auto' (back to the plan's
 * own routing), the local LLM, or a provider type the agent definition
 * ALREADY uses (agent tool or a step pin) — returned as the definition's own
 * tool object, so its model is the vetted one. Anything else → undefined
 * (the override is ignored; the app folds a new provider into the definition
 * through updateAgent instead, which re-runs every plan-build gate).
 */
export function vetOverrideToolForAgent(
  agent: Pick<Agent, 'tool' | 'orchestration'>,
  tool: ToolChoice | undefined,
): ToolChoice | undefined {
  if (!tool) return undefined;
  if (tool.type === 'auto') return { type: 'auto' };
  const pool: ToolChoice[] = [agent.tool, ...(agent.orchestration?.steps ?? []).map((s) => (typeof s === 'string' ? undefined : s.tool))].filter(
    (t): t is ToolChoice => !!t && t.type !== 'auto',
  );
  // Same provider = same type AND, for a CLI, the same CLI (a Claude pick
  // must never resolve to the agent's Codex tool or vice versa).
  const own = pool.find((t) => sameProvider(t, tool));
  if (own) return own;
  return tool.type === 'local' ? { type: 'local' } : undefined;
}

/** Stable identity of a tool for "did the provider change" checks ('auto' and
 *  absent are the same: no pin). */
export function overrideToolKey(tool: ToolChoice | null | undefined): string {
  return tool && tool.type !== 'auto' ? JSON.stringify(tool) : '';
}

/** Read + parse the agent's overrides.json through `runCommand`; null on any
 *  failure (never throws — an override is best-effort, the run goes on). */
export async function readProviderOverrides(
  runCommand: (cmd: string) => Promise<string>,
  agentId: string,
): Promise<ProviderOverrides | null> {
  const cmd = buildReadOverridesCommand(agentId);
  if (!cmd) return null;
  try {
    const out = await runCommand(cmd);
    return parseProviderOverrides(typeof out === 'string' ? out : '');
  } catch {
    return null;
  }
}

function sameTool(a: ToolChoice | undefined, b: ToolChoice | undefined): boolean {
  const ka = a && a.type !== 'auto' ? JSON.stringify(a) : '';
  const kb = b && b.type !== 'auto' ? JSON.stringify(b) : '';
  return ka === kb;
}

/** Set (or, for 'auto', clear) one step's pin. */
export function withStepTool(step: string | AgentOrchestrationStep, tool: ToolChoice): string | AgentOrchestrationStep {
  const obj: AgentOrchestrationStep = typeof step === 'string' ? { instruction: step } : { ...step };
  if (tool.type === 'auto') {
    delete obj.tool;
    // Back to the legacy plain-string shape when nothing else is on the step.
    return Object.keys(obj).length === 1 ? obj.instruction : obj;
  }
  // A model call and an api-call step are mutually exclusive (store/types.ts).
  delete obj.apiCall;
  obj.tool = tool;
  return obj;
}

/**
 * The agent-definition change an override implies, or null when it changes
 * nothing. Orchestrated agents: the step pins (index-aligned with
 * agent.orchestration.steps). A single-step agent: index 0 is the agent-level
 * tool.
 */
export function foldOverridesIntoAgent(
  agent: Pick<Agent, 'tool' | 'orchestration'>,
  overrides: ProviderOverrides | null,
): Partial<Agent> | null {
  if (!overrides) return null;
  const entries = Object.entries(overrides.steps);
  if (!entries.length) return null;
  const steps = agent.orchestration?.steps;
  if (steps && steps.length >= 2) {
    let changed = false;
    const next = steps.map((step, i) => {
      const o = overrides.steps[String(i)];
      if (!o) return step;
      const current = typeof step === 'string' ? undefined : step.tool;
      if (sameTool(current, o.tool)) return step;
      changed = true;
      return withStepTool(step, o.tool);
    });
    return changed ? { orchestration: { ...agent.orchestration!, steps: next } } : null;
  }
  const o = overrides.steps['0'];
  if (!o || sameTool(agent.tool, o.tool)) return null;
  return { tool: o.tool };
}

// ── Folding after the run (agent-manager syncAgentRunLogsFromDisk) ──────────

/** How long an override may wait for a run to finish before it is folded
 *  anyway (an abandoned file must never linger and override later edits). */
export const OVERRIDE_FOLD_MAX_AGE_MS = 60 * 60 * 1000;
const LISTING_MARK = '@@SHELLY_OVERRIDES@@';

/** One exec listing every agent's overrides.json (the periodic run-log sync
 *  doubles as the startup sweep). */
export function buildListOverridesCommand(): string {
  return (
    `for f in "$HOME/.shelly/agents/logs"/*/${PROVIDER_OVERRIDES_FILE}; do ` +
    `[ -f "$f" ] || continue; d="\${f%/*}"; printf '${LISTING_MARK} %s\\n' "\${d##*/}"; ` +
    `head -c 16384 "$f" 2>/dev/null; printf '\\n'; done; true`
  );
}

export function parseOverridesListing(stdout: string): Array<{ agentId: string; overrides: ProviderOverrides | null }> {
  const out: Array<{ agentId: string; overrides: ProviderOverrides | null }> = [];
  const parts = String(stdout ?? '').split(`${LISTING_MARK} `).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const agentId = (nl >= 0 ? part.slice(0, nl) : part).trim();
    if (!isSafeOverrideAgentId(agentId)) continue;
    out.push({ agentId, overrides: parseProviderOverrides(nl >= 0 ? part.slice(nl + 1) : '') });
  }
  return out;
}

/**
 * 'fold' once the run the override was written for has ended — a run log at
 * or after the override exists and the agent is not running — or once the
 * file is older than OVERRIDE_FOLD_MAX_AGE_MS; 'clear' for an unreadable file
 * or a deleted agent; otherwise 'wait'.
 */
export function decideOverrideFold(
  overrides: ProviderOverrides | null,
  ctx: { agentExists: boolean; running: boolean; latestRunAtMs: number | null; nowMs: number },
): 'fold' | 'clear' | 'wait' {
  if (!ctx.agentExists || !overrides) return 'clear';
  const writtenAt = overrides.updatedAt ?? 0;
  if (ctx.nowMs - writtenAt > OVERRIDE_FOLD_MAX_AGE_MS) return 'fold';
  if (ctx.running) return 'wait';
  return ctx.latestRunAtMs !== null && ctx.latestRunAtMs >= writtenAt ? 'fold' : 'wait';
}

// ── App-written files (fold authenticity) ──────────────────────────────────

/** overrides.json is writable by anything running as the app uid, so the
 *  fold into the agent definition only trusts content this app process
 *  wrote itself (in-memory: after an app restart a leftover file is cleared,
 *  never folded). */
const appWritten = new Map<string, string>();

function canonical(overrides: ProviderOverrides | null): string {
  return overrides ? JSON.stringify(parseProviderOverrides(JSON.stringify(overrides))) : '';
}

export function noteAppWrittenOverrides(agentId: string, overrides: ProviderOverrides): void {
  appWritten.set(agentId, canonical(overrides));
}

export function isAppWrittenOverrides(agentId: string, overrides: ProviderOverrides | null): boolean {
  const known = appWritten.get(agentId);
  return !!known && !!overrides && known === canonical(overrides);
}

export function forgetAppWrittenOverrides(agentId: string): void {
  appWritten.delete(agentId);
}

export function __resetAppWrittenOverridesForTests(): void {
  appWritten.clear();
}
