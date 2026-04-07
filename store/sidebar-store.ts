// store/sidebar-store.ts
import { create } from 'zustand';

export type SidebarMode = 'expanded' | 'icons' | 'hidden';
export type SidebarSection = 'tasks' | 'repos' | 'files' | 'device' | 'ports' | 'profiles';

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
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  mode: 'hidden',
  openSections: { tasks: false, repos: true, files: false, device: false, ports: false, profiles: false },
  activeRepoPath: null,
  repoPaths: [],

  setMode: (mode) => set({ mode }),

  toggleSection: (section) =>
    set((s) => ({
      openSections: { ...s.openSections, [section]: !s.openSections[section] },
    })),

  setActiveRepo: (path) => set({ activeRepoPath: path }),

  addRepo: (path) =>
    set((s) => ({
      repoPaths: s.repoPaths.includes(path) ? s.repoPaths : [...s.repoPaths, path],
    })),

  removeRepo: (path) =>
    set((s) => ({
      repoPaths: s.repoPaths.filter((p) => p !== path),
      activeRepoPath: s.activeRepoPath === path ? null : s.activeRepoPath,
    })),
}));
