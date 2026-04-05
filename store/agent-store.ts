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

  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (id: string, partial: Partial<Agent>) => void;
  removeAgent: (id: string) => void;

  addRunLog: (log: AgentRunLog) => void;
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

  setAgents: (agents) => set({ agents, isLoaded: true }),

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

  addRunLog: (log) =>
    set((state) => {
      const history = { ...state.runHistory };
      const logs = [...(history[log.agentId] || []), log];
      history[log.agentId] = logs.slice(-30);
      return { runHistory: history };
    }),

  getRunHistory: (agentId) => get().runHistory[agentId] || [],

  getAgentByName: (name) =>
    get().agents.find(
      (a) => a.name.toLowerCase() === name.toLowerCase()
    ),

  setPendingEnvSync: (cmd) => set({ pendingEnvSync: cmd }),

  consumePendingEnvSync: () => {
    const cmd = get().pendingEnvSync;
    set({ pendingEnvSync: null });
    return cmd;
  },
}));
