/**
 * store/worktree-store.ts
 *
 * Phase 1 worktree tracking — mirrors `git worktree list` output into a
 * Zustand-persisted store so the Sidebar can render rows, let the user
 * tap into one, and issue `git worktree add / remove` through execCommand.
 *
 * Scope intentionally narrow:
 *   - Create / list / remove only. No merge UI, no diff preview.
 *   - All worktrees live under `~/.shelly-worktrees/<repo>/<branch>/` so
 *     we never touch the user's own repo directory layout.
 *   - Agent binding is informational (label + colour); Phase 2 will wire
 *     it to auto-spawn the right CLI in a new terminal pane.
 *
 * Everything else (active-worktree pinning, immortal session tie-ins,
 * diff review, merge flow) is explicitly deferred to later phases so
 * the Phase 1 surface stays tiny and low-risk.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';

export type WorktreeAgent = 'claude' | 'gemini' | 'codex' | 'none';

export type Worktree = {
  /** Stable uuid — never rewritten so Sidebar rows can key by this. */
  id: string;
  /** Absolute path of the parent repo (the "main" working copy). */
  repoPath: string;
  /** Absolute path of the worktree on disk. */
  worktreePath: string;
  /** Git branch this worktree is checked out on. */
  branch: string;
  /** Which CLI is associated with this worktree — informational only. */
  agent: WorktreeAgent;
  /** ms epoch; used for the "last touched 2h ago" badge in later phases. */
  createdAt: number;
  lastTouchedAt: number;
  /** Phase 3: pinned Immortal tmux session id so reopen resumes the same
   *  shell process with its scrollback. Optional until the session is
   *  actually spawned. */
  sessionId?: string;
  /** Phase 2: opaque marker for "this worktree has had its agent launched
   *  at least once" — used by the CLI resume logic to pick `--continue` /
   *  `resume` flags instead of a cold start. */
  agentStarted?: boolean;
};

export type WorktreeCreateResult =
  | { ok: true; worktree: Worktree }
  | { ok: false; error: string };

type WorktreeState = {
  worktrees: Worktree[];
  /** Hydration flag so UI can defer rendering until AsyncStorage resolves. */
  _hasHydrated: boolean;

  /** CRUD */
  addWorktree: (repoPath: string, branch: string, agent: WorktreeAgent) => Promise<WorktreeCreateResult>;
  removeWorktree: (id: string) => Promise<{ ok: boolean; error?: string }>;
  touch: (id: string) => void;
  /** Phase 2: flag an agent launch so subsequent reopens use --continue */
  markAgentStarted: (id: string) => void;
  /** Phase 3: remember the tmux session id we spawned for this worktree */
  setSession: (id: string, sessionId: string | undefined) => void;

  /** Read helpers */
  byRepo: (repoPath: string) => Worktree[];
};

function uuid(): string {
  return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitiseBranch(branch: string): string {
  // Restrict branch names to git's safe subset so execCommand quoting is
  // trivial. Git itself rejects most of the rest but we pre-filter to
  // avoid sending garbage to the CLI.
  return branch.replace(/[^A-Za-z0-9_./-]/g, '-').replace(/^-+|-+$/g, '');
}

function sanitisePathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'repo';
}

function getWorktreeRoot(): string {
  // HomeInitializer always materialises ~/.shelly-worktrees/ (see Phase 2
  // follow-up); for Phase 1 we resolve HOME lazily at execCommand time via
  // the shell itself, so the path we hand git is a single $HOME-expanded
  // string produced by bash.
  return '$HOME/.shelly-worktrees';
}

/** Shell-escape a single argument for use inside single-quoted contexts. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string, timeoutMs = 45_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await execCommand(cmd, timeoutMs);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export const useWorktreeStore = create<WorktreeState>()(
  persist(
    (set, get) => ({
      worktrees: [],
      _hasHydrated: false,

      byRepo: (repoPath) => get().worktrees.filter((w) => w.repoPath === repoPath),

      addWorktree: async (repoPath, branchInput, agent) => {
        const branch = sanitiseBranch(branchInput);
        if (!branch) return { ok: false, error: 'Branch name is empty or contains only invalid characters' };
        if (!repoPath) return { ok: false, error: 'Repository path is empty' };

        // Avoid dup — we key on (repoPath, branch). Git would reject the
        // second add anyway but pre-flight gives a friendlier error.
        const existing = get().worktrees.find(
          (w) => w.repoPath === repoPath && w.branch === branch,
        );
        if (existing) {
          return { ok: false, error: `Worktree for branch "${branch}" already exists in this repo` };
        }

        const repoName = sanitisePathSegment(basename(repoPath));
        const dirName = `${agent === 'none' ? 'wt' : agent}-${sanitisePathSegment(branch)}`;
        // Using bash $HOME expansion so we don't have to ask Kotlin for HOME.
        // mkdir -p creates parent dirs; git worktree add will fail later if
        // the target already exists, so we don't pre-create the leaf.
        const parentDir = `${getWorktreeRoot()}/${repoName}`;
        const worktreePath = `${parentDir}/${dirName}`;

        // Ensure parent dir exists — git worktree add requires the immediate
        // parent to exist when creating a new branch.
        await runGit(`mkdir -p ${shq(parentDir)}`, 10_000);

        // Branch may already exist on this repo (e.g. if the user previously
        // removed the worktree but kept the branch). Detect it and use the
        // appropriate `git worktree add` form to avoid "branch already exists".
        const branchCheck = await runGit(
          `git -C ${shq(repoPath)} show-ref --verify --quiet ${shq(`refs/heads/${branch}`)}`,
          10_000,
        );
        const branchExists = branchCheck.ok; // exit 0 == ref exists

        const addCmd = branchExists
          ? `git -C ${shq(repoPath)} worktree add ${shq(worktreePath)} ${shq(branch)}`
          : `git -C ${shq(repoPath)} worktree add ${shq(worktreePath)} -b ${shq(branch)}`;

        const result = await runGit(addCmd);
        if (!result.ok) {
          logError('WorktreeStore', `add failed (${branch}): ${result.stderr}`);
          return { ok: false, error: result.stderr.trim() || `git worktree add exited non-zero` };
        }

        const wt: Worktree = {
          id: uuid(),
          repoPath,
          worktreePath,
          branch,
          agent,
          createdAt: Date.now(),
          lastTouchedAt: Date.now(),
        };
        set((s) => ({ worktrees: [...s.worktrees, wt] }));
        logInfo('WorktreeStore', `add ok: ${branch} @ ${worktreePath}`);
        return { ok: true, worktree: wt };
      },

      removeWorktree: async (id) => {
        const wt = get().worktrees.find((w) => w.id === id);
        if (!wt) return { ok: false, error: 'Worktree not found in store' };

        // git worktree remove is safer than rm -rf — it refuses if the
        // worktree has uncommitted changes unless --force. We pass --force
        // because the user explicitly asked to remove; a dialog upstream
        // already confirmed intent.
        const result = await runGit(
          `git -C ${shq(wt.repoPath)} worktree remove --force ${shq(wt.worktreePath)}`,
        );
        // Even on failure (e.g. directory already deleted) we still prune
        // the store entry so the UI doesn't show a stale row. The error is
        // surfaced for the user but doesn't block cleanup.
        set((s) => ({ worktrees: s.worktrees.filter((w) => w.id !== id) }));
        if (!result.ok) {
          logError('WorktreeStore', `remove stderr: ${result.stderr}`);
          // Best-effort prune of orphaned worktree entries git still tracks.
          await runGit(`git -C ${shq(wt.repoPath)} worktree prune`, 10_000);
          return { ok: true, error: result.stderr.trim() };
        }
        logInfo('WorktreeStore', `remove ok: ${wt.branch}`);
        return { ok: true };
      },

      touch: (id) => {
        set((s) => ({
          worktrees: s.worktrees.map((w) =>
            w.id === id ? { ...w, lastTouchedAt: Date.now() } : w,
          ),
        }));
      },

      markAgentStarted: (id) => {
        set((s) => ({
          worktrees: s.worktrees.map((w) =>
            w.id === id ? { ...w, agentStarted: true, lastTouchedAt: Date.now() } : w,
          ),
        }));
      },

      setSession: (id, sessionId) => {
        set((s) => ({
          worktrees: s.worktrees.map((w) =>
            w.id === id ? { ...w, sessionId, lastTouchedAt: Date.now() } : w,
          ),
        }));
      },
    }),
    {
      name: 'shelly-worktrees',
      storage: createJSONStorage(() => AsyncStorage),
      // Phase 1 schema is flat so we skip a version / migration map.
      partialize: (state) => ({ worktrees: state.worktrees }),
      onRehydrateStorage: () => (state) => {
        if (state) state._hasHydrated = true;
      },
    },
  ),
);
