/**
 * store/agent-store.ts — Zustand store for Background Agents.
 * Loads agent definitions from ~/.shelly/agents/*.json.
 * Persists changes back to filesystem via agent-manager.
 */
import { create } from 'zustand';
import { Agent, AgentRunLog } from './types';
import type { MonitorInput } from '@/lib/monitor-source';
import type { MonitorTeam } from '@/lib/monitor-team';
import type { MonitorRun } from '@/lib/agent-progress';
import type { ContinuousCheckpointView } from '@/lib/agent-continuous';

export type MonitorView = 'grid' | 'single' | 'map';
export type MonitorSpeed = 1 | 2 | 4;
/** auto = LIVE for the most relevant run when one exists, else DEMO.
 *  draft = your own team in the MAP editor, shown still (no playback). */
export type MonitorSourceMode = 'auto' | 'live' | 'demo' | 'draft';

/** Runs kept per agent in `liveRuns` (current + recent history). */
export const MAX_LIVE_RUNS_PER_AGENT = 5;

/** One real run seen by the MONITOR poller (lib/monitor-live-poll.ts). */
export interface LiveRunEntry {
  run: MonitorRun;
  /** Where the run saved its output, from the agent's run log. */
  savedPath?: string;
  /** Run-log lookups that found no savedPath yet (the poller stops after a few). */
  savedPathTries?: number;
}

/** MONITOR pane state — transient like the rest of this store (no persist).
 *  Phase A drives it from the built-in DEMO playback only: `t` is playback
 *  seconds, and the rendered snapshot is derived from (t, inputs) by the pure
 *  engine in lib/monitor-demo.ts, so nothing here duplicates run state. */
export interface MonitorPaneState {
  t: number;
  speed: MonitorSpeed;
  view: MonitorView;
  selectedId: string;
  auto: boolean;
  inputs: MonitorInput[];
  /** Bumped on RESTART so the pane can reset its wall clock. */
  runId: number;
  /** Wiring map being edited; null = the source's own team (the demo team).
   *  Kept as type-only here so this widely imported store does not pull the
   *  monitor/orchestration modules in at load time. */
  team: MonitorTeam | null;
  /** Cost-legend line dismissed by the user (kept across RESTART, not persisted). */
  legendDismissed: boolean;
  /** LIVE / DEMO selector. */
  sourceMode: MonitorSourceMode;
  /** Agent shown in LIVE when sourceMode is 'live'. */
  liveAgentId: string | null;
  /** Set when a MONITOR widget tap had to turn an occupied slot into MONITOR
   *  (no free slot): the slot and its previous tab, for the pane's BACK key. */
  returnTo: { slotId: string; tab: string } | null;
}

const initialMonitor = (): MonitorPaneState => ({
  t: 0,
  speed: 1,
  view: 'grid',
  selectedId: 'ch1',
  auto: false,
  inputs: [],
  runId: 0,
  team: null,
  legendDismissed: false,
  sourceMode: 'auto',
  liveAgentId: null,
  returnTo: null,
});

function runStartMs(run: MonitorRun): number {
  const v = Date.parse(run.startedAt);
  return Number.isFinite(v) ? v : 0;
}

interface AgentState {
  agents: Agent[];
  runHistory: Record<string, AgentRunLog[]>;  // agentId → last 30 logs
  isLoaded: boolean;
  pendingEnvSync: string | null;
  /** Global kill-switch (Phase 0 §2.5). When true, all schedules are uninstalled
   *  and manual runs are blocked. Persisted to a sentinel file via agent-manager. */
  halted: boolean;
  /** Agent IDs currently holding a live lock (~/.shelly/agents/locks/*.pid,
   *  verified via `kill -0`). Live/transient only — this store has no
   *  persist() middleware at all, so nothing here (including this field)
   *  survives an app restart, which is intentional: a stale "running" flag
   *  after relaunch would be worse than none. Populated by a poller — today
   *  Sidebar.tsx's refreshRunningAgents(), which should call
   *  setRunningAgentIds() with its computed id list so other surfaces
   *  (AgentBar, widgets, notifications) can observe run state without each
   *  duplicating the lock-file poll. */
  runningAgentIds: string[];
  /** Agent currently targeted by the Memory Workbench pane. Transient (this
   *  store has no persist middleware) — set by Sidebar's agent detail popup
   *  right before it opens/focuses a 'memory-workbench' pane, read by
   *  components/panes/MemoryWorkbenchPane.tsx. */
  memoryWorkbenchAgentId: string | null;

  setAgents: (agents: Agent[]) => void;
  setHalted: (halted: boolean) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (id: string, partial: Partial<Agent>) => void;
  removeAgent: (id: string) => void;

  /** Replace the full running-agent id list wholesale — the natural shape
   *  for a polling caller that recomputes the whole set each tick. */
  setRunningAgentIds: (ids: string[]) => void;
  addRunningAgentId: (id: string) => void;
  removeRunningAgentId: (id: string) => void;

  addRunLog: (log: AgentRunLog) => void;
  setRunHistory: (history: Record<string, AgentRunLog[]>) => void;
  getRunHistory: (agentId: string) => AgentRunLog[];

  getAgentByName: (name: string) => Agent | undefined;

  setPendingEnvSync: (cmd: string | null) => void;
  consumePendingEnvSync: () => string | null;

  setMemoryWorkbenchAgentId: (agentId: string | null) => void;

  monitor: MonitorPaneState;
  /** Advance playback by `dtSeconds` of wall time (clamped, scaled by speed). */
  tickMonitor: (dtSeconds: number) => void;
  setMonitor: (partial: Partial<Omit<MonitorPaneState, 't' | 'inputs' | 'runId'>>) => void;
  /** Record a chat line typed by the user at the current playback time. */
  sendMonitorInput: (text: string) => void;
  restartMonitor: () => void;
  setMonitorTeam: (team: MonitorTeam | null) => void;

  /** Real runs per agent, oldest first, at most MAX_LIVE_RUNS_PER_AGENT.
   *  Transient (no persist): rebuilt from progress.jsonl by the MONITOR
   *  poller while the pane is mounted. */
  liveRuns: Record<string, LiveRunEntry[]>;
  /** Insert or replace runs (matched by runId) for one agent. Keeps the same
   *  state object when nothing changed, so idle polls do not re-render. */
  upsertLiveRuns: (agentId: string, runs: MonitorRun[]) => void;
  /** Record a run-log lookup: the saved path, or null = looked, none yet. */
  setLiveRunSavedPath: (agentId: string, runId: string, savedPath: string | null) => void;
  clearLiveRuns: () => void;
  /** Continuous mode: the latest checkpoint.json view per loop agent (iteration
   *  + stop reason), read by the MONITOR poller only when the file changed.
   *  Transient (no persist). */
  liveLoops: Record<string, ContinuousCheckpointView>;
  /** null removes the entry (checkpoint gone / unreadable). Same object when
   *  nothing changed, so idle polls do not re-render. */
  setLiveLoop: (agentId: string, view: ContinuousCheckpointView | null) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  runHistory: {},
  isLoaded: false,
  pendingEnvSync: null,
  halted: false,
  runningAgentIds: [],
  memoryWorkbenchAgentId: null,

  setAgents: (agents) => set({ agents, isLoaded: true }),
  setHalted: (halted) => set({ halted }),

  addAgent: (agent) =>
    set((state) => ({ agents: [...state.agents, agent] })),

  updateAgent: (id, partial) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, ...partial } : a
      ),
    })),

  removeAgent: (id) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
    })),

  setRunningAgentIds: (ids) => set({ runningAgentIds: ids }),

  addRunningAgentId: (id) =>
    set((state) =>
      state.runningAgentIds.includes(id)
        ? state
        : { runningAgentIds: [...state.runningAgentIds, id] }
    ),

  removeRunningAgentId: (id) =>
    set((state) => ({
      runningAgentIds: state.runningAgentIds.filter((a) => a !== id),
    })),

  addRunLog: (log) =>
    set((state) => {
      const history = { ...state.runHistory };
      const logs = [...(history[log.agentId] || []), log];
      history[log.agentId] = logs.slice(-30);
      return { runHistory: history };
    }),

  setRunHistory: (history) => set({ runHistory: history }),

  getRunHistory: (agentId) => get().runHistory[agentId] || [],

  getAgentByName: (name) =>
    get().agents.find(
      (a) => (a.name || '').toLowerCase() === name.toLowerCase()
    ),

  setPendingEnvSync: (cmd) => set({ pendingEnvSync: cmd }),

  consumePendingEnvSync: () => {
    const cmd = get().pendingEnvSync;
    set({ pendingEnvSync: null });
    return cmd;
  },

  setMemoryWorkbenchAgentId: (agentId) => set({ memoryWorkbenchAgentId: agentId }),

  monitor: initialMonitor(),
  tickMonitor: (dtSeconds) =>
    set((state) => ({
      monitor: {
        ...state.monitor,
        t: state.monitor.t + Math.min(0.25, Math.max(0, dtSeconds)) * state.monitor.speed,
      },
    })),
  setMonitor: (partial) => set((state) => ({ monitor: { ...state.monitor, ...partial } })),
  sendMonitorInput: (text) =>
    set((state) => {
      const trimmed = text.trim();
      if (!trimmed) return state;
      return {
        monitor: {
          ...state.monitor,
          inputs: [...state.monitor.inputs, { at: state.monitor.t, text: trimmed }],
        },
      };
    }),
  restartMonitor: () =>
    set((state) => ({
      monitor: { ...state.monitor, t: 0, inputs: [], runId: state.monitor.runId + 1 },
    })),
  setMonitorTeam: (team) => set((state) => ({ monitor: { ...state.monitor, team } })),

  liveRuns: {},
  upsertLiveRuns: (agentId, runs) =>
    set((state) => {
      const prev = state.liveRuns[agentId] ?? [];
      let next = prev;
      for (const run of runs) {
        if (run.agentId !== agentId) continue;
        const i = next.findIndex((e) => e.run.runId === run.runId);
        if (i >= 0) {
          const cur = next[i].run;
          if (cur.lastSeq === run.lastSeq && cur.endedAt === run.endedAt) continue;
          next = next.slice();
          next[i] = { ...next[i], run };
        } else {
          next = [...next, { run }];
        }
      }
      if (next === prev) return state;
      next = next
        .slice()
        .sort((a, b) => runStartMs(a.run) - runStartMs(b.run))
        .slice(-MAX_LIVE_RUNS_PER_AGENT);
      return { liveRuns: { ...state.liveRuns, [agentId]: next } };
    }),
  setLiveRunSavedPath: (agentId, runId, savedPath) =>
    set((state) => {
      const list = state.liveRuns[agentId];
      const i = list ? list.findIndex((e) => e.run.runId === runId) : -1;
      if (!list || i < 0) return state;
      const next = list.slice();
      next[i] = savedPath
        ? { ...next[i], savedPath }
        : { ...next[i], savedPathTries: (next[i].savedPathTries ?? 0) + 1 };
      return { liveRuns: { ...state.liveRuns, [agentId]: next } };
    }),
  clearLiveRuns: () => set({ liveRuns: {} }),
  liveLoops: {},
  setLiveLoop: (agentId, view) =>
    set((state) => {
      const prev = state.liveLoops[agentId];
      if (!view) {
        if (!prev) return state;
        const { [agentId]: _removed, ...rest } = state.liveLoops;
        return { liveLoops: rest };
      }
      if (
        prev &&
        prev.iteration === view.iteration &&
        prev.stoppedReason === view.stoppedReason &&
        prev.stoppedAt === view.stoppedAt &&
        prev.nextAction === view.nextAction &&
        prev.startedAt === view.startedAt
      ) {
        return state;
      }
      return { liveLoops: { ...state.liveLoops, [agentId]: view } };
    }),
}));
