/**
 * store/arena-store.ts — Arena Mode 状態管理
 *
 * 2つのAIに同じプロンプトを匿名で送り、ユーザーが勝者を選ぶ。
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatAgent } from '@/store/chat-store';
import { generateId } from '@/lib/id';

const STORAGE_KEY = 'shelly_arena_history';
const MAX_HISTORY = 30;
const MAX_RESPONSE_LENGTH = 2000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ArenaCandidate = {
  id: string;
  agent: ChatAgent;
  response: string;
  isStreaming: boolean;
  error?: string;
};

export type ArenaEntry = {
  id: string;
  prompt: string;
  candidates: [ArenaCandidate, ArenaCandidate];
  winnerId: string | null;    // candidate id
  revealedAt: number | null;  // timestamp
  createdAt: number;
};

// ─── Store ──────────────────────────────────────────────────────────────────

type ArenaStore = {
  activeArena: ArenaEntry | null;
  arenaHistory: ArenaEntry[];
  isLoaded: boolean;

  load: () => Promise<void>;
  startArena: (prompt: string, agents: [ChatAgent, ChatAgent]) => string;
  updateCandidate: (arenaId: string, candidateId: string, update: Partial<ArenaCandidate>) => void;
  vote: (arenaId: string, winnerId: string) => void;
  clearArena: () => void;
  getWinRate: (agent: ChatAgent) => number;
};

export const useArenaStore = create<ArenaStore>((set, get) => ({
  activeArena: null,
  arenaHistory: [],
  isLoaded: false,

  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const history = JSON.parse(raw) as ArenaEntry[];
        set({ arenaHistory: history.slice(-MAX_HISTORY), isLoaded: true });
      } else {
        set({ isLoaded: true });
      }
    } catch {
      set({ isLoaded: true });
    }
  },

  startArena: (prompt, agents) => {
    const id = generateId();
    const entry: ArenaEntry = {
      id,
      prompt,
      candidates: [
        { id: `${id}-0`, agent: agents[0], response: '', isStreaming: true },
        { id: `${id}-1`, agent: agents[1], response: '', isStreaming: true },
      ],
      winnerId: null,
      revealedAt: null,
      createdAt: Date.now(),
    };
    set({ activeArena: entry });
    return id;
  },

  updateCandidate: (arenaId, candidateId, update) => {
    set((state) => {
      if (!state.activeArena || state.activeArena.id !== arenaId) return state;
      const candidates = state.activeArena.candidates.map((c) =>
        c.id === candidateId ? { ...c, ...update } : c,
      ) as [ArenaCandidate, ArenaCandidate];
      return { activeArena: { ...state.activeArena, candidates } };
    });
  },

  vote: (arenaId, winnerId) => {
    const { activeArena, arenaHistory } = get();
    if (!activeArena || activeArena.id !== arenaId) return;

    const revealed: ArenaEntry = {
      ...activeArena,
      winnerId,
      revealedAt: Date.now(),
    };

    // Trim responses for storage
    const forStorage: ArenaEntry = {
      ...revealed,
      candidates: revealed.candidates.map((c) => ({
        ...c,
        response: c.response.slice(0, MAX_RESPONSE_LENGTH),
      })) as [ArenaCandidate, ArenaCandidate],
    };

    const updated = [...arenaHistory, forStorage].slice(-MAX_HISTORY);
    set({ activeArena: revealed, arenaHistory: updated });
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
  },

  clearArena: () => set({ activeArena: null }),

  getWinRate: (agent) => {
    const { arenaHistory } = get();
    const participations = arenaHistory.filter((e) =>
      e.winnerId && e.candidates.some((c) => c.agent === agent),
    );
    if (participations.length === 0) return 0;
    const wins = participations.filter((e) => {
      const winner = e.candidates.find((c) => c.id === e.winnerId);
      return winner?.agent === agent;
    });
    return Math.round((wins.length / participations.length) * 100);
  },
}));
