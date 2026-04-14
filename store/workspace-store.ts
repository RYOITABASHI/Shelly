// store/workspace-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'shelly:workspaces';

type WorkspaceConfig = {
  repoPath: string;
  sessionIds: string[];     // terminal session IDs bound to this repo
  boundAgent?: string;       // preferred AI agent for this repo
  lastCwd?: string;
};

type WorkspaceState = {
  /** repoPath → workspace config */
  workspaces: Record<string, WorkspaceConfig>;

  getWorkspace: (repoPath: string) => Omit<WorkspaceConfig, 'repoPath'> | undefined;
  setWorkspace: (repoPath: string, config: Partial<Omit<WorkspaceConfig, 'repoPath'>>) => void;
  loadWorkspaces: () => Promise<void>;
};

// bug #50: use zustand persist middleware for automatic rehydrate on lmkd kill.
// Keeping the legacy STORAGE_KEY name so existing users don't lose their repo list.
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: {},

      getWorkspace: (repoPath) => {
        const ws = get().workspaces[repoPath];
        if (!ws) return undefined;
        const { repoPath: _rp, ...rest } = ws;
        return rest;
      },

      setWorkspace: (repoPath, config) => {
        set((s) => {
          const existing = s.workspaces[repoPath] ?? { repoPath, sessionIds: [] };
          const updated: WorkspaceConfig = { ...existing, ...config, repoPath };
          const next = { ...s.workspaces, [repoPath]: updated };
          return { workspaces: next };
        });
      },

      loadWorkspaces: async () => {
        // Legacy pre-persist format migration (one-shot): prior versions wrote
        // the raw map under the same key without the zustand wrapper. If the
        // value is plain (no `state`/`version` fields) we pull it in here.
        try {
          const raw = await AsyncStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !('state' in parsed) && !('version' in parsed)) {
            set({ workspaces: parsed as Record<string, WorkspaceConfig> });
          }
        } catch {
          // Silent fail — workspaces just start empty
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ workspaces: s.workspaces }),
      version: 1,
    }
  )
);
