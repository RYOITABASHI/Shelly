// store/sidebar-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';
import { normalizePath } from '@/lib/normalize-path';

export type SidebarMode = 'expanded' | 'icons' | 'hidden';
export type SidebarSection = 'tasks' | 'repos' | 'files' | 'device' | 'ports' | 'profiles' | 'worktrees' | 'quickLaunch';

interface SidebarState {
  mode: SidebarMode;
  /** Which accordion sections are open (Record for Zustand serialization compat) */
  openSections: Record<SidebarSection, boolean>;
  /** Active repository path (drives file tree + cwd) */
  activeRepoPath: string | null;
  /** Known repository paths */
  repoPaths: string[];

  setMode: (mode: SidebarMode) => void;
  toggleSection: (section: SidebarSection) => void;
  setActiveRepo: (path: string) => void;
  addRepo: (path: string) => void;
  removeRepo: (path: string) => void;
  loadRepos: () => Promise<void>;
}

// bug #50: persist sidebar mode / open sections / repo list across lmkd kills
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
  mode: 'expanded',
  openSections: { tasks: true, repos: true, files: true, device: false, ports: false, profiles: false, worktrees: true, quickLaunch: true },
  activeRepoPath: null,
  repoPaths: [],

  setMode: (mode) => set({ mode }),

  toggleSection: (section) =>
    set((s) => ({
      openSections: { ...s.openSections, [section]: !s.openSections[section] },
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
      version: 1,
    }
  )
);
