// store/sidebar-store.ts
import { create } from 'zustand';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';

export type SidebarMode = 'expanded' | 'icons' | 'hidden';
export type SidebarSection = 'tasks' | 'repos' | 'files' | 'device' | 'cloud' | 'ports' | 'profiles';

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

export const useSidebarStore = create<SidebarState>((set, get) => ({
  mode: 'expanded',
  openSections: { tasks: true, repos: true, files: true, device: false, cloud: false, ports: false, profiles: false },
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

  loadRepos: async () => {
    try {
      const result = await execCommand(
        'find ~/ -maxdepth 2 -name .git -type d 2>/dev/null | head -20 | sed "s/\\.git$//"'
      );
      const paths = result.stdout.trim().split('\n').filter(Boolean).map((p: string) => p.replace(/\/$/, ''));
      logInfo('Sidebar', 'Found ' + paths.length + ' repos');
      if (paths.length > 0) {
        set({ repoPaths: paths, activeRepoPath: paths[0] });
      }
    } catch (e) {
      logError('Sidebar', 'loadRepos failed', e);
    }
  },
}));
