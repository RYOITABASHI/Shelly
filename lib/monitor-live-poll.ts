/**
 * lib/monitor-live-poll.ts — feeds agent-store `liveRuns` from the
 * per-agent progress stream (`$HOME/.shelly/agents/logs/<id>/progress.jsonl`,
 * written by the PlanSpec executor and, soon, the attended chain).
 *
 * One exec per poll, whatever the agent count: a single shell script prints,
 * per agent, the stream's `mtime.size` signature and the file body only when
 * the signature changed since the last poll, so an idle poll is one `stat`
 * over the streams that exist (none when no agent has one). `$HOME` is expanded by the live shell (never the JS home cache —
 * see the deleteAgent alias bug in agent-manager). On first sight of an agent
 * the rotated previous run (progress.prev.jsonl) is read once to seed the
 * short history; after a run ends, the newest run log (`<epoch>.json`) is
 * read to find where the output was saved.
 *
 * The pure parts (command, output parsing, target selection) are exported for
 * tests; pollLiveRunsOnce wires them to an injected exec + the store.
 */
import { parseProgressRuns, type MonitorRun } from './agent-progress';
import { agentRunOpenPath } from './agent-run-output';
import { isRunActive } from './monitor-live';
import { parseContinuousCheckpoint, type ContinuousCheckpointView } from './agent-continuous';
import type { Agent } from '@/store/types';
import type { LiveRunEntry } from '@/store/agent-store';

export const POLL_ACTIVE_MS = 1000;
export const POLL_IDLE_MS = 5000;
/** Agents (by most recent lastRun) checked per poll besides running ones. */
export const POLL_MAX_AGENTS = 24;
/** Run-log lookups for a finished run's saved path before giving up. */
export const SAVED_PATH_MAX_TRIES = 3;

const MARK = '@@SHELLY_MON@@';
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function isSafeAgentId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..');
}

export interface PollTarget {
  agentId: string;
  /** Signature from the last poll; the body is skipped when unchanged. */
  knownSig: string | null;
  readPrev: boolean;
  readRunLog: boolean;
  /** Continuous loop agents only: also stat logs/<id>/checkpoint.json and
   *  read it when its signature differs from this one. */
  readCheckpoint?: boolean;
  knownCheckpointSig?: string | null;
}

export interface PollAgentResult {
  agentId: string;
  /** `mtime.size`, or 'none' when the stream does not exist. */
  sig: string | null;
  /** Present only when the signature changed. */
  progress?: string;
  prev?: string;
  runLog?: string;
  /** checkpoint.json `mtime.size` / 'none' (loop agents only). */
  checkpointSig?: string | null;
  /** Present only when the checkpoint signature changed. */
  checkpoint?: string;
}

/** The single shell command for one poll. Agent ids are validated (they are
 *  interpolated into the script); signatures are validated the same way. */
export function buildPollCommand(targets: readonly PollTarget[]): string {
  const safe = targets.filter((t) => isSafeAgentId(t.agentId));
  if (!safe.length) return '';
  // One `stat` for every stream that exists (builtin `[ -f ]` filters first),
  // instead of one fork per agent. Output lines are "|<path> <mtime>.<size>";
  // each agent's signature is then cut out of $S with parameter expansion
  // only (POSIX, no fork).
  const prelude =
    `L="$HOME/.shelly/agents/logs"; set --; ` +
    `for i in ${safe.map((t) => t.agentId).join(' ')}; do ` +
    `[ -f "$L/$i/progress.jsonl" ] && set -- "$@" "$L/$i/progress.jsonl"; done; ` +
    (safe.some((t) => t.readCheckpoint)
      ? `for i in ${safe.filter((t) => t.readCheckpoint).map((t) => t.agentId).join(' ')}; do ` +
        `[ -f "$L/$i/checkpoint.json" ] && set -- "$@" "$L/$i/checkpoint.json"; done; `
      : '') +
    `S=""; [ $# -gt 0 ] && S="$(stat -c '|%n %Y.%s' "$@" 2>/dev/null)"; `;
  const parts: string[] = [prelude];
  for (const t of safe) {
    const known = t.knownSig && /^[0-9.a-z]+$/.test(t.knownSig) ? t.knownSig : '-';
    let s =
      `d="$L/${t.agentId}"; f="$d/progress.jsonl"; ` +
      `case "$S" in *"|$f "*) r="\${S#*"|$f "}"; s="\${r%%[!0-9.]*}";; *) s="";; esac; ` +
      `[ -n "$s" ] || s=none; ` +
      `if [ "$s" = "${known}" ]; then printf '${MARK} P ${t.agentId} %s same\\n' "$s"; ` +
      `else printf '${MARK} P ${t.agentId} %s data\\n' "$s"; [ -f "$f" ] && cat "$f" 2>/dev/null; printf '\\n'; fi; `;
    if (t.readPrev) {
      s += `printf '${MARK} V ${t.agentId}\\n'; cat "$d/progress.prev.jsonl" 2>/dev/null; printf '\\n'; `;
    }
    if (t.readCheckpoint) {
      // Continuous mode: same signature trick as progress.jsonl — the body is
      // read only when checkpoint.json changed since the last poll.
      const knownC = t.knownCheckpointSig && /^[0-9.a-z]+$/.test(t.knownCheckpointSig) ? t.knownCheckpointSig : '-';
      s +=
        `c="$d/checkpoint.json"; ` +
        `case "$S" in *"|$c "*) r="\${S#*"|$c "}"; cs="\${r%%[!0-9.]*}";; *) cs="";; esac; ` +
        `[ -n "$cs" ] || cs=none; ` +
        `if [ "$cs" = "${knownC}" ]; then printf '${MARK} C ${t.agentId} %s same\\n' "$cs"; ` +
        `else printf '${MARK} C ${t.agentId} %s data\\n' "$cs"; [ -f "$c" ] && cat "$c" 2>/dev/null; printf '\\n'; fi; `;
    }
    if (t.readRunLog) {
      // Run logs are named <epoch seconds>.json; the glob sorts them, so the
      // last match is the newest (no ls/sort/tail process per agent).
      s +=
        `l=""; for x in "$d"/[0-9]*.json; do [ -f "$x" ] && l="$x"; done; ` +
        `printf '${MARK} L ${t.agentId}\\n'; [ -n "$l" ] && cat "$l" 2>/dev/null; printf '\\n'; `;
    }
    parts.push(s);
  }
  return `${parts.join('')}true`;
}

export function parsePollOutput(stdout: string): Record<string, PollAgentResult> {
  const out: Record<string, PollAgentResult> = {};
  let cur: { r: PollAgentResult; field: 'progress' | 'prev' | 'runLog' | 'checkpoint' } | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) cur.r[cur.field] = buf.join('\n');
    cur = null;
    buf = [];
  };
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(MARK)) {
      if (cur) buf.push(line);
      continue;
    }
    flush();
    const [, type, agentId, a, b] = line.split(' ');
    if (!agentId) continue;
    const r = (out[agentId] ??= { agentId, sig: null });
    if (type === 'P') {
      r.sig = a && a !== 'none' ? a : 'none';
      if (b === 'data') cur = { r, field: 'progress' };
    } else if (type === 'C') {
      r.checkpointSig = a && a !== 'none' ? a : 'none';
      if (b === 'data') cur = { r, field: 'checkpoint' };
    } else if (type === 'V') cur = { r, field: 'prev' };
    else if (type === 'L') cur = { r, field: 'runLog' };
  }
  flush();
  return out;
}

/** Poller memory across ticks (owned by the hook, reset on unmount). */
export interface PollMemo {
  sigs: Map<string, string>;
  prevRead: Set<string>;
  /** checkpoint.json signatures (continuous loop agents). Optional so memos
   *  built before continuous mode keep working. */
  checkpointSigs?: Map<string, string>;
}

export function createPollMemo(): PollMemo {
  return { sigs: new Map(), prevRead: new Set(), checkpointSigs: new Map() };
}

export interface PollState {
  agents: readonly (Pick<Agent, 'id' | 'lastRun'> & Partial<Pick<Agent, 'continuous'>>)[];
  runningAgentIds: readonly string[];
  liveRuns: Record<string, LiveRunEntry[]>;
}

function latest(list: LiveRunEntry[] | undefined): LiveRunEntry | undefined {
  return list && list.length ? list[list.length - 1] : undefined;
}

export function selectPollTargets(state: PollState, memo: PollMemo): PollTarget[] {
  // Only agents that still exist (a deleted agent's leftover logs / liveRuns
  // are never polled), at most POLL_MAX_AGENTS per poll: running ones first,
  // then ones already on the wall, then by most recent lastRun.
  const known = new Set(state.agents.map((a) => a.id));
  const ids: string[] = [];
  const add = (id: string) => {
    if (ids.length < POLL_MAX_AGENTS && known.has(id) && isSafeAgentId(id) && !ids.includes(id)) ids.push(id);
  };
  state.runningAgentIds.forEach(add);
  Object.keys(state.liveRuns).forEach(add);
  [...state.agents]
    .sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0))
    .forEach((a) => add(a.id));
  const loops = new Set(state.agents.filter((a) => !!a.continuous).map((a) => a.id));
  return ids.map((agentId) => {
    const last = latest(state.liveRuns[agentId]);
    return {
      agentId,
      knownSig: memo.sigs.get(agentId) ?? null,
      readPrev: !memo.prevRead.has(agentId),
      readRunLog:
        !!last && !!last.run.endedAt && !last.savedPath && (last.savedPathTries ?? 0) < SAVED_PATH_MAX_TRIES,
      ...(loops.has(agentId)
        ? { readCheckpoint: true, knownCheckpointSig: memo.checkpointSigs?.get(agentId) ?? null }
        : {}),
    };
  });
}

/** Saved output path from a run-log body, when that log belongs to `run`
 *  (written at or after the run started). undefined = not this run / none. */
export function savedPathForRun(runLogText: string | undefined, run: MonitorRun): string | undefined {
  if (!runLogText || !runLogText.trim()) return undefined;
  let log: { timestamp?: unknown; savedPath?: unknown } | null = null;
  try {
    log = JSON.parse(runLogText.trim());
  } catch {
    return undefined;
  }
  if (!log || typeof log.timestamp !== 'number') return undefined;
  const start = Date.parse(run.startedAt);
  // Run logs are written by the same process just before run_end; allow a
  // little clock slack around run start.
  if (Number.isFinite(start) && log.timestamp < start - 5000) return undefined;
  return agentRunOpenPath({ savedPath: typeof log.savedPath === 'string' ? log.savedPath : undefined });
}

export interface PollStore {
  upsertLiveRuns: (agentId: string, runs: MonitorRun[]) => void;
  setLiveRunSavedPath: (agentId: string, runId: string, savedPath: string | null) => void;
  getLiveRuns: () => Record<string, LiveRunEntry[]>;
  /** Continuous mode (optional): checkpoint view per loop agent; null clears. */
  setLiveLoop?: (agentId: string, view: ContinuousCheckpointView | null) => void;
}

export function applyPollResults(
  results: Record<string, PollAgentResult>,
  targets: readonly PollTarget[],
  memo: PollMemo,
  store: PollStore,
): void {
  for (const t of targets) {
    const r = results[t.agentId];
    if (!r) continue; // the shell loop died before this agent: retry next poll
    if (t.readPrev) memo.prevRead.add(t.agentId);
    if (r.prev) {
      const runs = parseProgressRuns(r.prev);
      if (runs.length) store.upsertLiveRuns(t.agentId, runs);
    }
    if (r.sig) memo.sigs.set(t.agentId, r.sig);
    if (t.readCheckpoint && r.checkpointSig) {
      (memo.checkpointSigs ??= new Map()).set(t.agentId, r.checkpointSig);
      if (r.checkpointSig === 'none') store.setLiveLoop?.(t.agentId, null);
      else if (r.checkpoint !== undefined) store.setLiveLoop?.(t.agentId, parseContinuousCheckpoint(r.checkpoint));
    }
    if (r.progress !== undefined) {
      const runs = parseProgressRuns(r.progress);
      if (runs.length) store.upsertLiveRuns(t.agentId, runs);
    }
    if (t.readRunLog && r.runLog !== undefined) {
      const last = latest(store.getLiveRuns()[t.agentId]);
      if (last && last.run.endedAt && !last.savedPath) {
        store.setLiveRunSavedPath(t.agentId, last.run.runId, savedPathForRun(r.runLog, last.run) ?? null);
      }
    }
  }
}

/** True only while some agent's latest known run has no run_end and is not
 *  silently dead (isRunActive). A held lock alone does not count — attended
 *  chains that write no progress.jsonl, or a stale runningAgentIds (only the
 *  Sidebar poll refreshes it), must not pin the poll at 1 Hz; each exec is
 *  expensive natively. */
export function anyRunActive(state: Pick<PollState, 'runningAgentIds' | 'liveRuns'>, nowMs: number): boolean {
  for (const list of Object.values(state.liveRuns)) {
    const last = latest(list);
    if (last && isRunActive(last.run, state.runningAgentIds, nowMs)) return true;
  }
  return false;
}

export type PollExec = (command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>;

/** One poll. Never throws; returns whether a run is active afterwards. */
export async function pollLiveRunsOnce(
  exec: PollExec,
  memo: PollMemo,
  getState: () => PollState,
  store: PollStore,
  nowMs: () => number = Date.now,
): Promise<boolean> {
  const targets = selectPollTargets(getState(), memo);
  const command = buildPollCommand(targets);
  if (command) {
    try {
      const res = await exec(command, 8000);
      // A non-zero exit can still carry complete sections (the last command's
      // status leaks out); parse whatever arrived.
      applyPollResults(parsePollOutput(res.stdout || ''), targets, memo, store);
    } catch {
      // Exec unavailable / timed out: try again next tick.
    }
  }
  return anyRunActive(getState(), nowMs());
}
