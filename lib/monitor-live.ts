/**
 * lib/monitor-live.ts — the LIVE MonitorSource: maps one real agent run
 * (lib/agent-progress.ts MonitorRun, parsed from
 * `$HOME/.shelly/agents/logs/<agentId>/progress.jsonl`) onto the same
 * MonitorSnapshot the DEMO playback produces, so the MONITOR pane renders
 * both through one code path.
 *
 * Rules (DEFERRED.md「マルチエージェント MONITOR ペイン」2026-10-30 UX review):
 *  - one camera per branch (step), channels CH-01.. in step order;
 *  - the provider chip is AUTO until the run's `tool` event says what ran;
 *  - money only when the provider reported it (usage.usd) — an API step with
 *    tokens but no usd shows tokens only, never an estimate;
 *  - mission progress is step-based: DONE / SKIPPED / FAILED / STOPPED count
 *    as settled, a running step counts half, over the run's stepCount;
 *  - a user stop (run status `halted`) is STOPPED, not FAILED.
 *
 * Pure: no I/O, no store access, the clock is injected via snapshot(nowMs).
 */
import type { MonitorBranch, MonitorRun } from './agent-progress';
import type {
  MonitorAgentDef,
  MonitorAgentSnapshot,
  MonitorAgentState,
  MonitorRunInfo,
  MonitorRunOutcome,
  MonitorSnapshot,
  MonitorSource,
} from './monitor-source';
import type { MonitorProvider, MonitorProviderKind, MonitorTeam, MonitorTeamNode } from './monitor-team';
import { MONITOR_PROVIDER_LABEL } from './monitor-team';

/** A RUNNING step with no event for this long gets the stale indicator. */
export const STALE_AFTER_SEC = 30;
/** Lines kept per camera (the progress stream carries only the latest tail). */
export const LIVE_MAX_LINES = 8;
const NAME_MAX_CHARS = 28;

/** What the pane knows about the agent that owns the run (all optional). */
export interface LiveAgentInfo {
  name?: string;
  /** Step instructions in plan order (Agent.orchestration.steps). */
  steps?: string[];
  schedule?: string;
}

const PROVIDER_ALIASES: Record<string, MonitorProvider> = {
  perplexity: 'perplexity',
  'gemini-api': 'gemini-api',
  cerebras: 'cerebras',
  groq: 'groq',
  local: 'local',
  cli: 'codex-cli',
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
};

const EXTRA_PROVIDER_LABEL: Record<string, string> = {
  openrouter: 'OpenRouter',
  'ab-article-eval': 'A/B eval',
};

export function liveProviderLabel(name: string): string {
  const alias = PROVIDER_ALIASES[name];
  if (alias) return MONITOR_PROVIDER_LABEL[alias];
  return EXTRA_PROVIDER_LABEL[name] ?? name;
}

/** Stable small hash (djb2) — operator portraits must not reshuffle between polls. */
function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

/** Operator portrait 1..5 for an agent's step: stable per (agent, step), and
 *  distinct for the first five steps of one agent. */
export function liveOperator(agentId: string, stepIndex: number): 1 | 2 | 3 | 4 | 5 {
  return (((hash(agentId) + stepIndex) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

export function liveChannel(stepIndex: number): string {
  const n = stepIndex + 1;
  return `CH-${n < 10 ? `0${n}` : n}`;
}

export function liveDefId(stepIndex: number): string {
  return `s${stepIndex}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length <= max ? flat : `${cps.slice(0, max - 1).join('')}…`;
}

function stepName(run: MonitorRun, b: MonitorBranch, info: LiveAgentInfo): string {
  const instruction = info.steps?.[b.stepIndex];
  if (instruction && instruction.trim()) return oneLine(instruction, NAME_MAX_CHARS);
  if (run.mode === 'SINGLE' && info.name) return oneLine(info.name, NAME_MAX_CHARS);
  return `STEP ${b.stepIndex + 1}`;
}

function defFor(run: MonitorRun, b: MonitorBranch, info: LiveAgentInfo): MonitorAgentDef {
  const p = b.provider;
  const kind: MonitorProviderKind = p ? p.kind : 'AUTO';
  return {
    id: liveDefId(b.stepIndex),
    channel: liveChannel(b.stepIndex),
    name: stepName(run, b, info),
    kind,
    provider: p ? PROVIDER_ALIASES[p.name] ?? 'auto' : 'auto',
    providerName: p ? liveProviderLabel(p.name) : MONITOR_PROVIDER_LABEL.auto,
    model: p?.model ?? '',
    operator: liveOperator(run.agentId, b.stepIndex),
  };
}

export function liveState(run: MonitorRun, b: MonitorBranch): MonitorAgentState {
  switch (b.state) {
    case 'RUNNING':
      return 'RUNNING';
    case 'WAITING_APPROVAL':
      return 'APPROVAL';
    case 'DONE':
      return 'DONE';
    case 'FAILED':
      return 'FAILED';
    case 'SKIPPED':
      // STOP-ALL settles every unfinished step as SKIPPED; the ones that had
      // already started were stopped by the user, not skipped by the plan.
      return run.status === 'halted' && b.startedAt ? 'STOPPED' : 'SKIPPED';
    default:
      return 'STANDBY';
  }
}

const SETTLED: ReadonlySet<MonitorAgentState> = new Set(['DONE', 'SKIPPED', 'FAILED', 'STOPPED']);

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

function secondsBetween(from: number | null, to: number): number | undefined {
  if (from === null) return undefined;
  return Math.max(0, Math.floor((to - from) / 1000));
}

export function liveOutcome(run: MonitorRun): MonitorRunOutcome {
  if (!run.endedAt) return 'running';
  switch (run.status) {
    case 'success':
      return 'success';
    case 'halted':
      return 'stopped';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

function snapshotFor(
  run: MonitorRun,
  defs: readonly MonitorAgentDef[],
  nowMs: number,
): MonitorSnapshot {
  const agents: Record<string, MonitorAgentSnapshot> = {};
  let approvalAgentId: string | null = null;
  let settled = 0;
  let running = 0;
  const ended = !!run.endedAt;
  for (const b of run.branches) {
    const id = liveDefId(b.stepIndex);
    const state = liveState(run, b);
    const start = ms(b.startedAt);
    const end = ms(b.endedAt) ?? (ended ? ms(run.endedAt) : null);
    const updated = ms(b.updatedAt);
    const elapsedSec = start === null ? undefined : secondsBetween(start, end ?? nowMs);
    const updatedAgoSec = updated === null ? undefined : secondsBetween(updated, nowMs);
    const usage = b.usage;
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    const lines = b.tail ? [b.tail] : [];
    const isActive = state === 'RUNNING' || state === 'APPROVAL';
    agents[id] = {
      state,
      lines: lines.slice(-LIVE_MAX_LINES),
      note: null,
      // Step-based camera bar: a started step shows half, a settled one full.
      logs: SETTLED.has(state) ? 2 : isActive ? 1 : 0,
      totalLogs: 2,
      tokens,
      usd: usage?.usd !== undefined ? usage.usd : null,
      ...(elapsedSec !== undefined ? { elapsedSec } : {}),
      ...(updatedAgoSec !== undefined ? { updatedAgoSec } : {}),
      stale: state === 'RUNNING' && !ended && updatedAgoSec !== undefined && updatedAgoSec >= STALE_AFTER_SEC,
    };
    if (state === 'APPROVAL' && approvalAgentId === null) approvalAgentId = id;
    if (SETTLED.has(state)) settled++;
    else if (isActive) running++;
  }
  const total = Math.max(run.stepCount ?? 0, defs.length, 1);
  const outcome = liveOutcome(run);
  const complete = outcome === 'success';
  const missionPct = complete ? 100 : Math.min(100, Math.round(((settled + running * 0.5) / total) * 100));

  const runStart = ms(run.startedAt);
  const runEnd = ms(run.endedAt);
  const info: MonitorRunInfo = {
    outcome,
    elapsedSec: secondsBetween(runStart, runEnd ?? nowMs) ?? 0,
  };
  if (outcome === 'failed') {
    const failed = run.branches.find((b) => b.state === 'FAILED');
    if (failed) {
      info.failedChannel = liveChannel(failed.stepIndex);
      if (failed.tail) info.failureReason = failed.tail;
    }
  }

  return {
    t: nowMs,
    agents,
    approvalPending: approvalAgentId !== null,
    approvalAgentId,
    complete,
    chat: [],
    missionPct,
    run: info,
  };
}

/** Wiring view of the run: steps left → right, a parallel group (same
 *  groupId, consecutive steps) stacked in one column. */
export function liveTeam(run: MonitorRun, defs: readonly MonitorAgentDef[], info: LiveAgentInfo): MonitorTeam {
  const columns: MonitorTeamNode[][] = [];
  let lastGroup: string | undefined;
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const b of run.branches) {
    const def = byId.get(liveDefId(b.stepIndex));
    if (!def) continue;
    const node: MonitorTeamNode = {
      id: def.id,
      name: def.name,
      role: info.steps?.[b.stepIndex] ? oneLine(info.steps[b.stepIndex], 140) : def.name,
      provider: def.provider,
      askBeforeWrite: false,
    };
    if (b.groupId && b.groupId === lastGroup && columns.length) columns[columns.length - 1].push(node);
    else columns.push([node]);
    lastGroup = b.groupId;
  }
  return {
    title: info.name ?? run.agentId,
    ...(info.schedule ? { schedule: info.schedule } : {}),
    columns: columns.length ? columns : [[{ id: 's0', role: info.name ?? run.agentId, provider: 'auto', askBeforeWrite: false }]],
    subAgents: [],
  };
}

export interface LiveSource extends MonitorSource {
  readonly agentId: string;
  readonly runId: string;
}

export function createLiveSource(run: MonitorRun, info: LiveAgentInfo = {}): LiveSource {
  const defs = run.branches.map((b) => defFor(run, b, info));
  const team = liveTeam(run, defs, info);
  return {
    isDemo: false,
    agentId: run.agentId,
    runId: run.runId,
    agents: defs,
    team,
    snapshot: (nowMs) => snapshotFor(run, defs, nowMs),
  };
}

/** True while the run has not ended. A run whose agent no longer holds its
 *  lock and that has been silent for `deadAfterMs` (a crash without run_end)
 *  no longer counts as running for the default LIVE pick. */
export function isRunActive(
  run: MonitorRun,
  runningAgentIds: readonly string[],
  nowMs: number,
  deadAfterMs = 120_000,
): boolean {
  if (run.endedAt) return false;
  if (runningAgentIds.includes(run.agentId)) return true;
  let last = ms(run.startedAt) ?? 0;
  for (const b of run.branches) last = Math.max(last, ms(b.updatedAt) ?? 0);
  return nowMs - last < deadAfterMs;
}

/** Default LIVE pick: the most recently started active run, else the most
 *  recently started finished run; null when there is no run at all. */
export function pickDefaultLiveRun(
  runs: readonly MonitorRun[],
  runningAgentIds: readonly string[],
  nowMs: number,
): MonitorRun | null {
  let bestActive: MonitorRun | null = null;
  let bestAny: MonitorRun | null = null;
  const start = (r: MonitorRun) => ms(r.startedAt) ?? 0;
  for (const r of runs) {
    if (!bestAny || start(r) > start(bestAny)) bestAny = r;
    if (isRunActive(r, runningAgentIds, nowMs) && (!bestActive || start(r) > start(bestActive))) bestActive = r;
  }
  return bestActive ?? bestAny;
}
