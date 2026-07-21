// store/sidebar-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';
import { normalizePath } from '@/lib/normalize-path';

export type SidebarMode = 'expanded' | 'icons' | 'hidden';
export type SidebarSection =
  | 'tasks'
  | 'skills'
  | 'importedSkills'
  | 'repos'
  | 'files'
  | 'device'
  | 'ports'
  | 'profiles'
  | 'worktrees'
  | 'quickLaunch'
  | 'codexSessions';

interface SidebarState {
  mode: SidebarMode;
  /** Which accordion sections are open (Record for Zustand serialization compat) */
  openSections: Record<SidebarSection, boolean>;
  /** Active repository path (drives file tree + cwd) */
  activeRepoPath: string | null;
  /** Known repository paths */
  repoPaths: string[];
  /** Monotonic counter bumped by requestFocusRunningAgents(). Live/transient
   *  UI signal only — deliberately excluded from partialize() below, so it
   *  never persists. Intended consumer: a Sidebar-side effect (not yet
   *  implemented as of this store change) that watches this value and, on
   *  change, scrolls the TASKS section into view and briefly highlights the
   *  currently-running agent rows. Emitted today by the AgentBar
   *  running-count chip (components/layout/AgentBar.tsx) on tap. */
  focusRunningAgentsRequestId: number;

  setMode: (mode: SidebarMode) => void;
  toggleSection: (section: SidebarSection) => void;
  setActiveRepo: (path: string) => void;
  addRepo: (path: string) => void;
  removeRepo: (path: string) => void;
  loadRepos: () => Promise<void>;
  /** Force-opens the TASKS section and bumps focusRunningAgentsRequestId so
   *  a future Sidebar effect can scroll to / flash the running-agent list. */
  requestFocusRunningAgents: () => void;
}

// bug #50: persist sidebar mode / open sections / repo list across lmkd kills
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      mode: 'icons',
      openSections: defaultOpenSections(),
      activeRepoPath: null,
      repoPaths: [],
      focusRunningAgentsRequestId: 0,

      setMode: (mode) => set({ mode }),

      toggleSection: (section) =>
        set((s) => ({
          openSections: { ...s.openSections, [section]: !s.openSections[section] },
        })),

      requestFocusRunningAgents: () =>
        set((s) => ({
          openSections: { ...s.openSections, tasks: true },
          focusRunningAgentsRequestId: s.focusRunningAgentsRequestId + 1,
        })),

      // bug #43: normalize `~/` before storing — Plan B bash doesn't expand
      // tilde, and single-quoted paths in shell commands would break otherwise.
      setActiveRepo: (path) => set({ activeRepoPath: normalizePath(path) }),

      addRepo: (path) =>
        set((s) => {
          const np = normalizePath(path);
          return {
            repoPaths: s.repoPaths.includes(np) ? s.repoPaths : [...s.repoPaths, np],
          };
        }),

      removeRepo: (path) =>
        set((s) => {
          const np = normalizePath(path);
          return {
            repoPaths: s.repoPaths.filter((p) => p !== np),
            activeRepoPath: s.activeRepoPath === np ? null : s.activeRepoPath,
          };
        }),

      loadRepos: async () => {
        try {
          const result = await execCommand(
            'find ~/ -maxdepth 2 -name .git -type d ' +
            '-not -path "*/node_modules/*" -not -path "*/.npm/*" ' +
            '-not -path "*/.cache/*" -not -path "*/.shelly-cli/*" ' +
            '-not -path "*/.shelly-rootfs/*" ' +
            '2>/dev/null | head -20 | sed "s/\\.git$//"'
          );
          const paths = result.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((p: string) => normalizePath(p.replace(/\/$/, '')));
          logInfo('Sidebar', 'Found ' + paths.length + ' repos');
          if (paths.length > 0) {
            set({ repoPaths: paths, activeRepoPath: paths[0] });
          }
        } catch (e) {
          logError('Sidebar', 'loadRepos failed', e);
        }
      },
    }),
    {
      name: 'sidebar-store-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        mode: s.mode,
        openSections: s.openSections,
        activeRepoPath: s.activeRepoPath,
        repoPaths: s.repoPaths,
      }),
      version: 5,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<Pick<
          SidebarState,
          'mode' | 'openSections' | 'activeRepoPath' | 'repoPaths'
        >>;
	        // v5: the AGENT output shortcut (feature D) lives in the DEVICE section,
	        // which older persisted state pinned closed (device:false) — so the
	        // shortcut never appeared. Drop the stale key once so it resolves to the
	        // new default (open) and the draft result is one tap away as intended.
	        const persistedSections = { ...(state.openSections ?? {}) };
	        delete (persistedSections as Partial<Record<SidebarSection, boolean>>).device;
	        return {
	          ...state,
	          mode: isSidebarMode(state.mode) ? state.mode : 'icons',
	          openSections: { ...defaultOpenSections(), ...persistedSections },
	        };
	      },
    }
  )
);

function defaultOpenSections(): Record<SidebarSection, boolean> {
  return {
    tasks: true,
    skills: false,
    importedSkills: false,
    repos: true,
    files: true,
    device: true,
    ports: false,
    profiles: false,
    worktrees: true,
    quickLaunch: true,
    codexSessions: true,
  };
}

function isSidebarMode(value: unknown): value is SidebarMode {
  return value === 'expanded' || value === 'icons' || value === 'hidden';
}
