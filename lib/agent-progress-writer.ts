/**
 * Live progress stream WRITER for the attended serial chain
 * (lib/agent-manager.ts runAgentOrchestratedBody).
 *
 * Writes the SAME `$HOME/.shelly/agents/logs/<agentId>/progress.jsonl` schema
 * the unattended PlanSpec executor writes (scripts/shelly-plan-executor.js
 * progressStart / progressEmit / progressState / progressFinish), so the
 * MONITOR pane reads every run — attended serial or executor — through the one
 * reader, lib/agent-progress.ts parseProgressJsonl. Same rules as the
 * executor's writer:
 *  - the file holds the CURRENT run only; the previous run is rotated to
 *    progress.prev.jsonl when a run starts;
 *  - one JSON event per line: {v, runId, agentId, seq, ts, kind, ...};
 *  - a settled branch state (DONE / FAILED / SKIPPED) is final;
 *  - tails are redacted and capped at 240 code points;
 *  - strictly best-effort: the first write failure disables the stream for
 *    the rest of the run, and NOTHING here may throw into, block, or slow the
 *    chain. Events are queued and appended asynchronously (several queued
 *    events coalesce into one shell append); only `finish()` returns a promise
 *    the chain may await, and it is bounded.
 *
 * Paths use the LIVE shell `$HOME` (never the JS getHomePath() cache, which
 * can hold the unresolved /data/user/0 alias — see deleteAgent's history).
 */
import { PROGRESS_SCHEMA_VERSION, type MonitorBranchState, type MonitorProvider, type MonitorRunMode, type MonitorUsage } from './agent-progress';
import { redactSecretsText } from './redact-secrets';
import { logWarn } from './debug-logger';
import type { ToolChoice } from '@/store/types';

export const PROGRESS_TAIL_MAX_CHARS = 240;
/** Same runaway guard as the executor's PROGRESS_MAX_BYTES. */
const PROGRESS_MAX_BYTES = 256 * 1024;
/** Upper bound on how long finish() may hold up the end of a chain. */
const PROGRESS_FINISH_TIMEOUT_MS = 3_000;
const TERMINAL: ReadonlySet<string> = new Set(['DONE', 'FAILED', 'SKIPPED']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

type RunCommand = (cmd: string) => Promise<string>;

/** Redact + collapse whitespace + cap at PROGRESS_TAIL_MAX_CHARS code points
 *  (mirror of the executor's progressTail / previewText). */
export function progressTailText(text: string | undefined | null): string {
  const cleaned = redactSecretsText(String(text ?? '')).replace(/\s+/g, ' ').trim();
  const cps = Array.from(cleaned);
  return cps.length <= PROGRESS_TAIL_MAX_CHARS ? cleaned : cps.slice(0, PROGRESS_TAIL_MAX_CHARS).join('');
}

/** Run-step status → branch state (mirror of the executor's progressStatusState).
 *  'pending' = the final dispatch outlived the wait and is still finishing in
 *  the background (DISPATCH_PENDING_MESSAGE) — the chain's own work is done. */
export function progressStateForStatus(status: string | undefined): MonitorBranchState {
  if (status === 'success' || status === 'pending') return 'DONE';
  if (status === 'skipped' || status === 'halted') return 'SKIPPED';
  return 'FAILED';
}

/** Provider descriptor for a ToolChoice (mirror of the executor's progressProvider). */
export function progressProviderForTool(tool: ToolChoice | undefined | null, modelHint?: string): MonitorProvider | undefined {
  if (!tool || typeof tool.type !== 'string') return undefined;
  const type = tool.type === 'cli' ? `cli:${(tool as { cli?: string }).cli ?? 'cli'}` : tool.type;
  const kind = tool.type === 'local' ? 'LOCAL' : tool.type === 'cli' ? 'CLI' : 'API';
  const rawModel = (tool as { model?: unknown }).model;
  const model = typeof rawModel === 'string' && rawModel ? rawModel : modelHint;
  return { kind, name: type, ...(model ? { model: String(model).slice(0, 80) } : {}) };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Process-lifetime registry of the attended serial writers currently live,
 *  keyed by agentId — lets the RN approval drain (app/_layout.tsx) flag the
 *  running step WAITING_APPROVAL without threading a handle through. */
const activeWriters = new Map<string, AttendedProgressWriter>();

/**
 * The RN action-approval drain is about to ask the human (an approval
 * notification / prompt for `agentId`). If an attended SERIAL chain of that
 * agent is live, its current step becomes WAITING_APPROVAL; its next terminal
 * state settles it. A no-op for every other run (the executor writes its own).
 * Never throws.
 */
export function noteAttendedApprovalWaiting(agentId: string | null | undefined): void {
  if (!agentId) return;
  try {
    activeWriters.get(agentId)?.approvalWaiting();
  } catch {
    // best-effort
  }
}

/** The approval the drain asked about is gone (answered / expired). Never throws. */
export function noteAttendedApprovalResolved(agentId: string | null | undefined): void {
  if (!agentId) return;
  try {
    activeWriters.get(agentId)?.approvalResolved();
  } catch {
    // best-effort
  }
}

export interface AttendedProgressStart {
  agentId: string;
  stepCount: number;
  /** Index-aligned effective group ids (planParallelGroups(...).group). */
  groups?: (string | undefined)[];
  /** Which attended route produced this run (diagnostic only). */
  route?: string;
}

export class AttendedProgressWriter {
  readonly runId: string;
  private readonly agentId: string;
  private readonly stepCount: number;
  private readonly groups: (string | undefined)[];
  private readonly startedAt = Date.now();
  private readonly states = new Map<number, MonitorBranchState>();
  private seq = 0;
  private bytes = 0;
  private disabled = false;
  private finished = false;
  private currentStep = -1;
  private pending: string[] = [];
  private rotatePending = true;
  private flushing: Promise<void> | null = null;

  private constructor(
    private readonly runCommand: RunCommand,
    opts: AttendedProgressStart,
  ) {
    this.agentId = opts.agentId;
    this.stepCount = Math.max(0, Math.floor(opts.stepCount));
    this.groups = opts.groups ?? [];
    this.runId = `${opts.agentId}-${this.startedAt}-attended-${Math.random().toString(36).slice(2, 8) || 'run'}`;
  }

  /**
   * Opens a run: rotate the previous run away, run_start + one STANDBY per
   * step. Returns null (and writes nothing) for an unsafe agent id. Never throws.
   */
  static start(runCommand: RunCommand, opts: AttendedProgressStart): AttendedProgressWriter | null {
    try {
      if (!SAFE_ID_RE.test(opts.agentId)) return null;
      const writer = new AttendedProgressWriter(runCommand, opts);
      const parallel = writer.groups.some((g, i) => g !== undefined && writer.groups.indexOf(g) !== i);
      const mode: MonitorRunMode = writer.stepCount <= 1 && !parallel ? 'SINGLE' : parallel ? 'PARALLEL' : 'SERIAL';
      // The attended chain dispatches serially even when steps are grouped
      // (context isolation only) — report SERIAL so MONITOR never claims
      // concurrency this route does not have.
      writer.emit('run_start', {
        mode: mode === 'PARALLEL' ? 'SERIAL' : mode,
        stepCount: writer.stepCount,
        route: opts.route ?? 'attended-serial',
      });
      for (let i = 0; i < writer.stepCount; i += 1) writer.state(i, 'STANDBY');
      activeWriters.set(opts.agentId, writer);
      return writer;
    } catch (error) {
      logWarn('AgentProgress', 'progress start failed', error);
      return null;
    }
  }

  /** Step i dispatched (RUNNING). */
  stepStarted(i: number): void {
    this.currentStep = i;
    this.state(i, 'RUNNING');
  }

  /** A ladder attempt for step i is about to run on `tool`. */
  stepTool(i: number, tool: ToolChoice | undefined, label?: string): void {
    const provider = progressProviderForTool(tool);
    if (!provider) return;
    this.stepEvent(i, 'tool', { tool: label || provider.name, provider });
  }

  stepUsage(i: number, usage: MonitorUsage | undefined): void {
    if (!usage) return;
    const clean: MonitorUsage = {};
    for (const key of ['inputTokens', 'outputTokens', 'usd'] as const) {
      const n = usage[key];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) clean[key] = n;
    }
    if (Object.keys(clean).length) this.stepEvent(i, 'usage', { usage: clean });
  }

  /** Step i settled with a run-step status (success / error / skipped / …). */
  stepFinished(i: number, status: string | undefined, preview?: string): void {
    this.state(i, progressStateForStatus(status), preview);
  }

  /** The RN approval drain is asking the human about the current step. */
  approvalWaiting(): void {
    if (this.currentStep < 0) return;
    const current = this.states.get(this.currentStep);
    if (current !== 'RUNNING') return;
    this.state(this.currentStep, 'WAITING_APPROVAL');
  }

  /** The human answered: the waiting step is RUNNING again until it settles. */
  approvalResolved(): void {
    if (this.currentStep < 0) return;
    if (this.states.get(this.currentStep) !== 'WAITING_APPROVAL') return;
    this.state(this.currentStep, 'RUNNING');
  }

  /**
   * Settles every unsettled step (mirror of the executor's progressFinish),
   * then run_end. `status` is the run status ('halted' = STOP-ALL). Returns a
   * promise bounded by PROGRESS_FINISH_TIMEOUT_MS that never rejects.
   */
  finish(status: string, reason?: string): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.finished = true;
    if (activeWriters.get(this.agentId) === this) activeWriters.delete(this.agentId);
    try {
      for (let i = 0; i < this.stepCount; i += 1) {
        const current = this.states.get(i);
        if (current && TERMINAL.has(current)) continue;
        const live = current === 'RUNNING' || current === 'WAITING_APPROVAL';
        const state = live ? progressStateForStatus(status === 'success' ? 'error' : status) : 'SKIPPED';
        this.state(i, state, live ? reason : '');
      }
      this.emit('run_end', { status: String(status || 'error'), durationMs: Date.now() - this.startedAt });
    } catch {
      // best-effort
    }
    const drained = this.drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // Past the cap: drop whatever is still queued so a late append can
        // never land in the NEXT run's freshly rotated file.
        this.disabled = true;
        this.pending = [];
        resolve();
      }, PROGRESS_FINISH_TIMEOUT_MS);
    });
    return Promise.race([drained, capped]).finally(() => {
      if (timer) clearTimeout(timer);
      // The run is over either way: nothing may be appended after this.
      this.disabled = true;
      this.pending = [];
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private state(i: number, state: MonitorBranchState, tail?: string): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.stepCount) return;
    const prev = this.states.get(i);
    if (prev === state) return;
    if (prev && TERMINAL.has(prev)) return; // settled is final
    this.states.set(i, state);
    if (tail) {
      const text = progressTailText(tail);
      if (text) this.stepEvent(i, 'tail', { tail: text });
    }
    this.stepEvent(i, 'branch_state', { state });
  }

  private stepEvent(i: number, kind: string, fields: Record<string, unknown>): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.stepCount) return;
    const groupId = this.groups[i];
    this.emit(kind, {
      stepIndex: i,
      branchId: `${this.runId}#${i}`,
      ...(groupId !== undefined ? { groupId } : {}),
      ...fields,
    });
  }

  private emit(kind: string, fields: Record<string, unknown>): void {
    if (this.disabled) return;
    try {
      const seq = this.seq + 1;
      const line = JSON.stringify({
        v: PROGRESS_SCHEMA_VERSION,
        runId: this.runId,
        agentId: this.agentId,
        seq,
        ts: new Date().toISOString(),
        ...fields,
        kind,
      });
      const len = line.length + 1;
      const over = this.bytes + len;
      if (kind !== 'run_end' && (over > PROGRESS_MAX_BYTES * 2 || (over > PROGRESS_MAX_BYTES && kind !== 'branch_state'))) return;
      this.seq = seq;
      this.bytes = over;
      this.pending.push(line);
      void this.drain();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.pending = [];
    logWarn('AgentProgress', `progress write failed for ${this.agentId} — disabled for this run`, error);
  }

  /** Serialized async appender: one in-flight shell write at a time; events
   *  queued meanwhile go out together in the next write. Never rejects. */
  private drain(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.disabled || this.pending.length === 0) return Promise.resolve();
    const run = async () => {
      while (!this.disabled && this.pending.length > 0) {
        const lines = this.pending;
        this.pending = [];
        const dir = `"$HOME/.shelly/agents/logs/${this.agentId}"`;
        const file = `"$HOME/.shelly/agents/logs/${this.agentId}/progress.jsonl"`;
        const prev = `"$HOME/.shelly/agents/logs/${this.agentId}/progress.prev.jsonl"`;
        const rotate = this.rotatePending
          ? `{ [ -f ${file} ] && mv -f ${file} ${prev}; } 2>/dev/null; : > ${file}\n`
          : '';
        const cmd =
          `# SHELLY_PROGRESS_APPEND\n` +
          `mkdir -p ${dir} 2>/dev/null\n` +
          rotate +
          `printf '%s\\n' ${lines.map(shellSingleQuote).join(' ')} >> ${file} && echo SHELLY_PROGRESS_OK`;
        try {
          const out = await this.runCommand(cmd);
          this.rotatePending = false;
          // An unrecognized response (e.g. a test runner that models nothing)
          // is not treated as a failure — only a thrown error disables.
          void out;
        } catch (error) {
          this.fail(error);
        }
      }
    };
    const turn: Promise<void> = run()
      .finally(() => {
        if (this.flushing === turn) this.flushing = null;
      })
      // An event queued after the loop drained but before this turn settled
      // (e.g. run_end) gets its own follow-up write instead of being stranded.
      .then(() => (this.pending.length > 0 && !this.disabled ? this.drain() : undefined));
    this.flushing = turn;
    return turn;
  }
}

/** Test-only. */
export function __resetAttendedProgressWritersForTests(): void {
  activeWriters.clear();
}
