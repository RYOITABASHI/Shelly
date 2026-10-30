/**
 * lib/monitor-source.ts — the data interface behind the MONITOR pane.
 *
 * The pane renders a MonitorSnapshot and nothing else. Two sources implement
 * the contract: the built-in DEMO playback (lib/monitor-demo.ts) and the LIVE
 * source fed by a real agent run's progress.jsonl (lib/monitor-live.ts).
 */
import type { MonitorProvider, MonitorProviderKind, MonitorTeam } from './monitor-team';

/** SKIPPED = did not run to the end without the user stopping it (an earlier
 *  step failed, the plan skipped it, or an approval timed out);
 *  STOPPED = the user stopped it: STOP-ALL while it was running, or "no" to
 *  its approval (LIVE reads both from progress.jsonl, where the executor
 *  records them as SKIPPED — see lib/monitor-live.ts liveState). Distinct
 *  from FAILED, which is an error. */
export type MonitorAgentState =
  | 'STANDBY'
  | 'RUNNING'
  | 'WAITING'
  | 'APPROVAL'
  | 'DONE'
  | 'FAILED'
  | 'SKIPPED'
  | 'STOPPED';

export const ACTIVE_STATES: ReadonlySet<MonitorAgentState> = new Set(['RUNNING', 'WAITING', 'APPROVAL']);

/** i18n key + params, translated by the pane. */
export interface MonitorText {
  key: string;
  params?: Record<string, string | number>;
}

export interface MonitorAgentDef {
  /** Same id as the matching node in the team. */
  id: string;
  channel: string;
  name: string;
  /** AUTO only on LIVE, until the run reports which provider it picked. */
  kind: MonitorProviderKind;
  provider: MonitorProvider;
  providerName: string;
  model: string;
  parentId?: string;
  /** Operator portrait index, 1..5. */
  operator: 1 | 2 | 3 | 4 | 5;
}

export interface MonitorAgentSnapshot {
  state: MonitorAgentState;
  /** Most recent log lines (oldest first). */
  lines: string[];
  note: MonitorText | null;
  /** Log lines seen so far. */
  logs: number;
  /** Total log lines this agent will produce on the success path. */
  totalLogs: number;
  tokens: number;
  /** null = the provider reported no cost (LIVE): show tokens only, never
   *  an invented amount. */
  usd: number | null;
  /** LIVE only: seconds since this step started (frozen once it ended). */
  elapsedSec?: number;
  /** LIVE only: seconds since this step's last event. */
  updatedAgoSec?: number;
  /** LIVE only: RUNNING with no event for a while (see STALE_AFTER_SEC). */
  stale?: boolean;
}

export interface MonitorChatLine {
  who: 'shelly' | 'you';
  /** Literal text (user input) or a translated message. */
  text?: string;
  message?: MonitorText;
  ask?: boolean;
}

export interface MonitorSnapshot {
  t: number;
  agents: Record<string, MonitorAgentSnapshot>;
  approvalPending: boolean;
  /** Agent waiting for the user's ok, when approvalPending. */
  approvalAgentId: string | null;
  complete: boolean;
  chat: MonitorChatLine[];
  /** Overrides the per-agent average (LIVE: step-based, see monitor-live). */
  missionPct?: number;
  /** LIVE only: run-level facts. */
  run?: MonitorRunInfo;
}

export type MonitorRunOutcome = 'running' | 'success' | 'failed' | 'stopped' | 'skipped';

export interface MonitorRunInfo {
  outcome: MonitorRunOutcome;
  /** Seconds since run start (frozen at run end). */
  elapsedSec: number;
  /** Failed step's last line, when the run failed. */
  failureReason?: string;
  /** Channel of the failed step, when the run failed. */
  failedChannel?: string;
}

/** A line the user typed into the chat strip, at playback time `at`. */
export interface MonitorInput {
  at: number;
  text: string;
}

export interface MonitorSource {
  readonly isDemo: boolean;
  readonly agents: readonly MonitorAgentDef[];
  readonly team: MonitorTeam;
  /** Pure: state of the run at time `t` given the user's inputs. DEMO: `t` is
   *  playback seconds. LIVE: `t` is the wall clock (epoch ms); inputs unused. */
  snapshot(t: number, inputs: readonly MonitorInput[]): MonitorSnapshot;
}

// ─── Derived numbers (shared by every source) ────────────────────────────────

export function agentProgress(a: MonitorAgentSnapshot): number {
  if (a.state === 'DONE') return 1;
  // SKIPPED / STOPPED keep the progress they really made: a step stopped
  // before it did any work is 0%, not "complete" (a run stopped at 0/3 must
  // not read 100%).
  return Math.min(0.95, a.logs / (a.totalLogs || 1));
}

export interface MonitorSummary {
  running: number;
  done: number;
  total: number;
  /** 0..100 */
  missionPct: number;
  apiUsd: number;
  /** False when some API step reported tokens but no cost (LIVE): the pane
   *  then shows API tokens instead of a money figure. */
  apiUsdKnown: boolean;
  apiTokens: number;
  cliTokens: number;
  localTokens: number;
}

export function summarize(defs: readonly MonitorAgentDef[], snap: MonitorSnapshot): MonitorSummary {
  let running = 0;
  let done = 0;
  let sum = 0;
  let apiUsd = 0;
  let apiUsdKnown = true;
  let apiTokens = 0;
  let cliTokens = 0;
  let localTokens = 0;
  for (const d of defs) {
    const a = snap.agents[d.id];
    if (!a) continue;
    if (a.state === 'RUNNING') running++;
    if (a.state === 'DONE') done++;
    sum += agentProgress(a);
    if (d.kind === 'API') {
      apiTokens += a.tokens;
      if (a.usd === null) {
        if (a.tokens > 0) apiUsdKnown = false;
      } else apiUsd += a.usd;
    } else if (d.kind === 'CLI') cliTokens += a.tokens;
    else if (d.kind === 'LOCAL') localTokens += a.tokens;
    // AUTO: no provider reported yet, so there is nothing to attribute.
  }
  const missionPct = snap.complete
    ? 100
    : snap.missionPct !== undefined
      ? snap.missionPct
      : defs.length
        ? Math.round((sum / defs.length) * 100)
        : 0;
  return { running, done, total: defs.length, missionPct, apiUsd, apiUsdKnown, apiTokens, cliTokens, localTokens };
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

export const USD_TO_YEN = 150;

/** Money in the viewer's currency: yen for Japanese, dollars otherwise. */
export function formatMoney(usd: number, locale: string): string {
  if (locale === 'ja') {
    const yen = usd * USD_TO_YEN;
    return `¥${yen < 10 ? yen.toFixed(2) : Math.round(yen).toLocaleString('ja-JP')}`;
  }
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** Elapsed seconds as mm:ss (h:mm:ss past an hour). */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}:${p(m)}:${p(sec % 60)}` : `${p(m)}:${p(sec % 60)}`;
}

// ─── Map edge state (ported from the prototype's edgeClass) ─────────────────

export type MonitorEdgeState = 'idle' | 'flow' | 'held' | 'done' | 'pending';

/**
 * State of one derived edge given live node states. Nodes without a snapshot
 * (e.g. added in the editor, not part of the playback) count as STANDBY.
 */
export function edgeState(
  edge: { from: string; to: string; sub?: boolean },
  agents: Record<string, MonitorAgentSnapshot | undefined>,
): MonitorEdgeState {
  const f = agents[edge.from]?.state ?? 'STANDBY';
  if (edge.to === 'goal') {
    return f === 'DONE' ? 'done' : f === 'APPROVAL' ? 'pending' : f === 'RUNNING' ? 'held' : 'idle';
  }
  const t = agents[edge.to]?.state ?? 'STANDBY';
  if (edge.sub) return t === 'RUNNING' ? 'flow' : t === 'DONE' ? 'done' : 'idle';
  if (f !== 'DONE') return 'idle';
  if (t === 'DONE') return 'done';
  return ACTIVE_STATES.has(t) ? 'flow' : 'held';
}
