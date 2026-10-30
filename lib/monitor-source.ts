/**
 * lib/monitor-source.ts — the data interface behind the MONITOR pane.
 *
 * The pane renders a MonitorSnapshot and nothing else. Phase A ships only the
 * built-in DEMO source (lib/monitor-demo.ts); a live source fed by real agent
 * runs implements the same MonitorSource contract later, so the UI does not
 * change when that lands.
 */
import type { MonitorProvider, MonitorProviderKind, MonitorTeam } from './monitor-team';

export type MonitorAgentState = 'STANDBY' | 'RUNNING' | 'WAITING' | 'APPROVAL' | 'DONE' | 'FAILED';

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
  kind: Exclude<MonitorProviderKind, 'AUTO'>;
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
  usd: number;
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
  /** Pure: state of the run at playback time `t` given the user's inputs. */
  snapshot(t: number, inputs: readonly MonitorInput[]): MonitorSnapshot;
}

// ─── Derived numbers (shared by every source) ────────────────────────────────

export function agentProgress(a: MonitorAgentSnapshot): number {
  if (a.state === 'DONE') return 1;
  return Math.min(0.95, a.logs / (a.totalLogs || 1));
}

export interface MonitorSummary {
  running: number;
  done: number;
  total: number;
  /** 0..100 */
  missionPct: number;
  apiUsd: number;
  cliTokens: number;
  localTokens: number;
}

export function summarize(defs: readonly MonitorAgentDef[], snap: MonitorSnapshot): MonitorSummary {
  let running = 0;
  let done = 0;
  let sum = 0;
  let apiUsd = 0;
  let cliTokens = 0;
  let localTokens = 0;
  for (const d of defs) {
    const a = snap.agents[d.id];
    if (!a) continue;
    if (a.state === 'RUNNING') running++;
    if (a.state === 'DONE') done++;
    sum += agentProgress(a);
    if (d.kind === 'API') apiUsd += a.usd;
    else if (d.kind === 'CLI') cliTokens += a.tokens;
    else localTokens += a.tokens;
  }
  const missionPct = snap.complete ? 100 : defs.length ? Math.round((sum / defs.length) * 100) : 0;
  return { running, done, total: defs.length, missionPct, apiUsd, cliTokens, localTokens };
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
