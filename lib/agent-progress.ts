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
const EVENT_KINDS: ReadonlySet<string> = new Set(['run_start', 'branch_state', 'tool', 'tail', 'usage', 'run_end']);

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

/** The latest run in the text (the last one to start), or null when none parse. */
export function parseProgressJsonl(text: string): MonitorRun | null {
  const runs = parseProgressRuns(text);
  return runs.length ? runs[runs.length - 1] : null;
}
