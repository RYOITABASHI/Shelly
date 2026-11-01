/**
 * Pure reader for the PlanSpec executor's live progress stream
 * (`$HOME/.shelly/agents/logs/<agentId>/progress.jsonl`, executor v12 —
 * see progressStart in scripts/shelly-plan-executor.js).
 *
 * The file holds one run (the previous run is rotated to
 * `progress.prev.jsonl`). Each line is one JSON event; the reader is
 * deliberately forgiving because it may read a file mid-write:
 *  - malformed / partial lines and events of an unknown schema version are
 *    dropped;
 *  - per run, an event whose `seq` is not strictly greater than the last
 *    accepted `seq` is dropped as stale/out-of-order;
 *  - a terminal branch state (DONE / FAILED / SKIPPED) is never overwritten.
 *
 * No I/O, no store wiring — the MONITOR pane owns that.
 */

export const PROGRESS_SCHEMA_VERSION = 1;

export type MonitorBranchState = 'STANDBY' | 'RUNNING' | 'WAITING_APPROVAL' | 'DONE' | 'FAILED' | 'SKIPPED';
export type MonitorRunMode = 'SINGLE' | 'SERIAL' | 'PARALLEL';
export type MonitorProviderKind = 'API' | 'CLI' | 'LOCAL';

export interface MonitorProvider {
  kind: MonitorProviderKind;
  name: string;
  model?: string;
}

export interface MonitorUsage {
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
}

export interface MonitorBranch {
  branchId: string;
  stepIndex: number;
  groupId?: string;
  state: MonitorBranchState;
  tool?: string;
  provider?: MonitorProvider;
  tail?: string;
  /** Summed over every usage event of the branch (ladder retries included). */
  usage?: MonitorUsage;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  /** True once the branch reported WAITING_APPROVAL (the user was asked). */
  approvalAsked?: boolean;
  /** Executor v24 CLI heartbeat: when the step's worker last did something —
   *  a heartbeat's ts minus its quietMs (time since the driver's last
   *  output); any later non-heartbeat event of the branch is activity at its
   *  own ts. Unset for a branch that never sent a heartbeat (then updatedAt
   *  is the activity time). */
  lastActivityAt?: string;
  /** True once the branch sent a heartbeat (a CLI worker is running). */
  heartbeat?: boolean;
  /** The last tool / item the CLI worker started (heartbeat `activity`). */
  activity?: string;
}

export interface MonitorRun {
  runId: string;
  agentId: string;
  mode: MonitorRunMode;
  startedAt: string;
  endedAt?: string;
  /** run_end status (success / error / unavailable / skipped / halted = STOP-ALL). */
  status?: string;
  stepCount?: number;
  lastSeq: number;
  /** Sorted by stepIndex. */
  branches: MonitorBranch[];
}

const BRANCH_STATES: ReadonlySet<string> = new Set(['STANDBY', 'RUNNING', 'WAITING_APPROVAL', 'DONE', 'FAILED', 'SKIPPED']);
const TERMINAL_STATES: ReadonlySet<string> = new Set(['DONE', 'FAILED', 'SKIPPED']);
const RUN_MODES: ReadonlySet<string> = new Set(['SINGLE', 'SERIAL', 'PARALLEL']);
const PROVIDER_KINDS: ReadonlySet<string> = new Set(['API', 'CLI', 'LOCAL']);
// `heartbeat` (executor v24) is liveness for a running CLI step; readers
// older than v24 drop it like any unknown kind.
const EVENT_KINDS: ReadonlySet<string> = new Set(['run_start', 'branch_state', 'tool', 'tail', 'usage', 'run_end', 'heartbeat']);
const ACTIVITY_MAX_CHARS = 40;

interface ProgressEvent {
  runId: string;
  agentId: string;
  seq: number;
  ts: string;
  kind: string;
  stepIndex?: number;
  branchId?: string;
  groupId?: string;
  state?: string;
  tool?: string;
  provider?: unknown;
  tail?: string;
  usage?: unknown;
  mode?: string;
  status?: string;
  stepCount?: number;
  quietMs?: unknown;
  activity?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function finiteNonNegative(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Parses one line; returns null for anything malformed. */
export function parseProgressLine(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.v !== PROGRESS_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(e.runId) || !isNonEmptyString(e.agentId) || !isNonEmptyString(e.ts)) return null;
  if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 1) return null;
  if (!isNonEmptyString(e.kind) || !EVENT_KINDS.has(e.kind)) return null;
  const isRunLevel = e.kind === 'run_start' || e.kind === 'run_end';
  if (!isRunLevel && (typeof e.stepIndex !== 'number' || !Number.isInteger(e.stepIndex) || e.stepIndex < 0)) return null;
  if (e.kind === 'branch_state' && (typeof e.state !== 'string' || !BRANCH_STATES.has(e.state))) return null;
  return e as unknown as ProgressEvent;
}

function parseProvider(v: unknown): MonitorProvider | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Record<string, unknown>;
  if (typeof p.kind !== 'string' || !PROVIDER_KINDS.has(p.kind) || !isNonEmptyString(p.name)) return undefined;
  return { kind: p.kind as MonitorProviderKind, name: p.name, ...(isNonEmptyString(p.model) ? { model: p.model } : {}) };
}

function addUsage(prev: MonitorUsage | undefined, v: unknown): MonitorUsage | undefined {
  if (!v || typeof v !== 'object') return prev;
  const u = v as Record<string, unknown>;
  const next: MonitorUsage = { ...(prev || {}) };
  let any = false;
  for (const key of ['inputTokens', 'outputTokens', 'usd'] as const) {
    const n = finiteNonNegative(u[key]);
    if (n === undefined) continue;
    next[key] = (next[key] || 0) + n;
    any = true;
  }
  return any ? next : prev;
}

function newRun(e: ProgressEvent): MonitorRun {
  return {
    runId: e.runId,
    agentId: e.agentId,
    mode: 'SERIAL',
    startedAt: e.ts,
    lastSeq: 0,
    branches: [],
  };
}

function branchFor(run: MonitorRun, index: Map<number, MonitorBranch>, e: ProgressEvent): MonitorBranch {
  const stepIndex = e.stepIndex as number;
  let branch = index.get(stepIndex);
  if (!branch) {
    branch = {
      branchId: isNonEmptyString(e.branchId) ? e.branchId : `${run.runId}#${stepIndex}`,
      stepIndex,
      state: 'STANDBY',
      updatedAt: e.ts,
    };
    index.set(stepIndex, branch);
  }
  if (isNonEmptyString(e.groupId)) branch.groupId = e.groupId;
  branch.updatedAt = e.ts;
  // A heartbeat sets its own (earlier) activity time; any other event is
  // activity at its ts.
  if (e.kind !== 'heartbeat' && branch.lastActivityAt !== undefined) branch.lastActivityAt = e.ts;
  return branch;
}

function applyEvent(run: MonitorRun, index: Map<number, MonitorBranch>, e: ProgressEvent): void {
  run.lastSeq = e.seq;
  switch (e.kind) {
    case 'run_start':
      run.startedAt = e.ts;
      if (typeof e.mode === 'string' && RUN_MODES.has(e.mode)) run.mode = e.mode as MonitorRunMode;
      if (typeof e.stepCount === 'number' && Number.isInteger(e.stepCount) && e.stepCount >= 0) run.stepCount = e.stepCount;
      return;
    case 'run_end':
      run.endedAt = e.ts;
      if (isNonEmptyString(e.status)) run.status = e.status;
      return;
    case 'branch_state': {
      const branch = branchFor(run, index, e);
      if (TERMINAL_STATES.has(branch.state)) return;
      const state = e.state as MonitorBranchState;
      if (state === 'RUNNING' && !branch.startedAt) branch.startedAt = e.ts;
      if (TERMINAL_STATES.has(state)) branch.endedAt = e.ts;
      if (state === 'WAITING_APPROVAL') branch.approvalAsked = true;
      branch.state = state;
      return;
    }
    case 'tool': {
      const branch = branchFor(run, index, e);
      if (isNonEmptyString(e.tool)) branch.tool = e.tool;
      const provider = parseProvider(e.provider);
      if (provider) branch.provider = provider;
      return;
    }
    case 'tail': {
      const branch = branchFor(run, index, e);
      if (typeof e.tail === 'string') branch.tail = e.tail;
      return;
    }
    case 'usage': {
      const branch = branchFor(run, index, e);
      branch.usage = addUsage(branch.usage, e.usage);
      return;
    }
    case 'heartbeat': {
      // Liveness only, never a visible line: updatedAt moves to the
      // heartbeat, the worker's activity time to ts - quietMs (never back
      // past the branch's previous event).
      const before = index.get(e.stepIndex as number);
      const prevActivity = before ? Date.parse(before.lastActivityAt ?? before.updatedAt) : NaN;
      const branch = branchFor(run, index, e);
      branch.heartbeat = true;
      const ts = Date.parse(e.ts);
      if (Number.isFinite(ts)) {
        const at = ts - (finiteNonNegative(e.quietMs) ?? 0);
        branch.lastActivityAt = new Date(Number.isFinite(prevActivity) ? Math.max(at, prevActivity) : at).toISOString();
      }
      if (isNonEmptyString(e.activity)) branch.activity = Array.from(e.activity).slice(0, ACTIVITY_MAX_CHARS).join('');
      return;
    }
    default:
  }
}

/**
 * Parses every run found in the text, in order of first appearance. A run is
 * keyed by runId; events of a run that appear without its run_start (e.g. a
 * truncated head) still build a run, with startedAt = its first event's ts.
 */
export function parseProgressRuns(text: string): MonitorRun[] {
  const runs = new Map<string, { run: MonitorRun; index: Map<number, MonitorBranch> }>();
  for (const line of String(text || '').split('\n')) {
    const e = parseProgressLine(line);
    if (!e) continue;
    let entry = runs.get(e.runId);
    if (!entry) {
      entry = { run: newRun(e), index: new Map() };
      runs.set(e.runId, entry);
    }
    if (e.agentId !== entry.run.agentId) continue;
    if (e.seq <= entry.run.lastSeq) continue; // stale / out-of-order / duplicate
    applyEvent(entry.run, entry.index, e);
  }
  return Array.from(runs.values()).map(({ run, index }) => ({
    ...run,
    branches: Array.from(index.values()).sort((a, b) => a.stepIndex - b.stepIndex),
  }));
}

export interface CliBranchOverlap {
  /** Steps of the run whose provider was a CLI worker (tool event kind CLI). */
  cliBranches: number;
  /** Wall-clock time during which >= 2 of those steps were RUNNING at once. */
  overlapMs: number;
}

/**
 * Parallel CLI steps Inc3 (on-device acceptance: "overlapMs > 0"): how long
 * two or more CLI branches of run `runId` were RUNNING at the same time,
 * from the branch_state events of the progress stream. A RUNNING interval
 * runs from a RUNNING event to the next state event of that step (any other
 * state, WAITING_APPROVAL included), else to the run_end, else to the last
 * event of the run. Same forgiving reader as parseProgressRuns (bad lines,
 * other runs / agents, stale seq are ignored). Pure.
 */
export function cliBranchOverlap(text: string, runId: string): CliBranchOverlap {
  const cli = new Set<number>();
  const open = new Map<number, number>();
  const intervals: Array<{ step: number; from: number; to: number }> = [];
  let agentId: string | null = null;
  let lastSeq = 0;
  let lastTs: number | null = null;
  let endTs: number | null = null;
  for (const line of String(text || '').split('\n')) {
    const e = parseProgressLine(line);
    if (!e || e.runId !== runId) continue;
    if (agentId === null) agentId = e.agentId;
    if (e.agentId !== agentId || e.seq <= lastSeq) continue;
    lastSeq = e.seq;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    lastTs = ts;
    if (e.kind === 'run_end') {
      endTs = ts;
    } else if (e.kind === 'tool') {
      if (parseProvider(e.provider)?.kind === 'CLI') cli.add(e.stepIndex as number);
    } else if (e.kind === 'branch_state') {
      const step = e.stepIndex as number;
      const from = open.get(step);
      if (from !== undefined) {
        intervals.push({ step, from, to: ts });
        open.delete(step);
      }
      if (e.state === 'RUNNING') open.set(step, ts);
    }
  }
  const closeAt = endTs ?? lastTs;
  if (closeAt !== null) for (const [step, from] of open) intervals.push({ step, from, to: closeAt });
  // A step is known to be CLI from its tool event (which may follow its first
  // RUNNING), so filter once everything is read.
  const points: Array<[number, number]> = [];
  for (const iv of intervals) {
    if (cli.has(iv.step) && iv.to > iv.from) points.push([iv.from, 1], [iv.to, -1]);
  }
  // Sweep; an end sorts before a start at the same instant (touching is not
  // overlap).
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let overlapMs = 0;
  let prev = 0;
  for (const [t, d] of points) {
    if (live >= 2) overlapMs += t - prev;
    live += d;
    prev = t;
  }
  return { cliBranches: cli.size, overlapMs };
}

/** The latest run in the text (the last one to start), or null when none parse. */
export function parseProgressJsonl(text: string): MonitorRun | null {
  const runs = parseProgressRuns(text);
  return runs.length ? runs[runs.length - 1] : null;
}
