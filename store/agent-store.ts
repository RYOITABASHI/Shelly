/**
 * store/agent-store.ts — Zustand store for Background Agents.
 * Loads agent definitions from ~/.shelly/agents/*.json.
 * Persists changes back to filesystem via agent-manager.
 */
import { create } from 'zustand';
import { Agent, AgentRunLog } from './types';

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
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  runHistory: {},
  isLoaded: false,
  pendingEnvSync: null,
  halted: false,
  runningAgentIds: [],

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
}));
