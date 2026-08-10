/**
 * lib/agent-rollback.ts — savepoint + undo plumbing for the optimistic
 * (rollback-type) agent execution mode.
 *
 * Deliberately built ON TOP of the existing lib/auto-savepoint.ts rather than
 * introducing a second snapshot mechanism: auto-savepoint already owns the
 * git-init/commit/revert lifecycle AND the pre-commit secret scan, and the
 * roadmap entry explicitly asks to reuse it.
 *
 * Lifecycle for one optimistic run:
 *
 *   1. prepareRollbackWorkspace()  — before the run. `git init` the workspace if
 *      needed, then commit any pre-existing dirt so the agent's own writes will
 *      be the ONLY content of the post-run commit. Without this step an undo
 *      would also revert unrelated changes the user made earlier.
 *   2. …the agent runs and writes its draft…
 *   3. captureRollbackPoint()      — after the run. Commits exactly what the run
 *      produced and returns a handle carrying that commit hash.
 *   4. undoAgentRun(handle)        — on "元に戻す". `git revert <hash> --no-edit`,
 *      which is non-destructive (it adds an inverse commit) and targets the run's
 *      own commit rather than blindly reverting HEAD.
 *
 * Failure policy: every step is best-effort and returns null/false rather than
 * throwing. A rollback point that could not be captured must NEVER be reported
 * as available — the UI shows an undo affordance only when a handle exists. The
 * inverse failure (savepoint fails) is handled by the CALLER, which must fall
 * back to the normal pre-approval gate: no snapshot ⇒ no optimistic execution.
 */
import {
  checkAndSave,
  initGitIfNeeded,
  revertSavepoint,
  type SecurityIssue,
} from '@/lib/auto-savepoint';
import { logInfo, logWarn } from '@/lib/debug-logger';

/** Same shape lib/auto-savepoint.ts expects (hooks/use-native-exec's execCommand). */
export type RollbackRunCommand = (cmd: string) => Promise<{ stdout: string; exitCode: number }>;

export interface AgentRollbackHandle {
  agentId: string;
  /** Directory the savepoint repo lives in (the rollback workspace root). */
  workspaceRoot: string;
  /** Commit that contains exactly this run's writes. Reverting it is the undo. */
  commitHash: string;
  /** Human-readable summary of what the run changed ("Auto: Created foo.md"). */
  message: string;
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
  createdAtMs: number;
}

/**
 * Prepare the workspace so the run's writes land in an isolated commit.
 * Returns false when the workspace could not be put in a clean, git-backed
 * state — the caller MUST then refuse optimistic execution and keep the
 * pre-approval gate. Fail-closed by construction.
 */
export async function prepareRollbackWorkspace(
  workspaceRoot: string,
  runCommand: RollbackRunCommand
): Promise<boolean> {
  try {
    // The workspace may not exist yet on a fresh install (nothing has been
    // drafted). Create it so `git init` has somewhere to go.
    const mk = await runCommand(`mkdir -p '${workspaceRoot.replace(/'/g, "'\\''")}'`);
    if (mk.exitCode !== 0) return false;
    // requireRepoAtRoot: the undo repo must live AT workspaceRoot. Without the
    // flag, an ancestor repo (e.g. a $HOME/.git left by other tooling — the
    // exact on-device state that kept Undo from ever appearing, 2026-08-05)
    // satisfies rev-parse's walk-up check, init is skipped, and every later
    // `git -C <root>` step operates on the ancestor repo instead. See
    // initGitIfNeeded's doc comment in lib/auto-savepoint.ts.
    await initGitIfNeeded(workspaceRoot, runCommand, {
      requireRepoAtRoot: true,
      onSecurityIssues: (issues) => logWarn(
        'AgentRollback',
        `initial rollback workspace scan blocked: ${issues.map((issue) => issue.label).join(', ')}`
      ),
    });
    // Baseline commit for any pre-existing dirt. A null result means "nothing to
    // commit", which is the normal, already-clean case — not a failure. A
    // secret-scan block DOES return null too, so verify cleanliness explicitly
    // below instead of inferring it from the return value.
    await checkAndSave(workspaceRoot, runCommand);
    const { stdout: status, exitCode } = await runCommand(
      `git -C '${workspaceRoot.replace(/'/g, "'\\''")}' status --porcelain`
    );
    if (exitCode !== 0) return false;
    if (status.trim()) {
      // Still dirty ⇒ the baseline commit was blocked (secrets) or failed. An
      // optimistic run here would produce a commit mixing the user's uncommitted
      // work with the agent's, so undo could destroy the user's work. Refuse.
      logWarn(
        'AgentRollback',
        `workspace ${workspaceRoot} is still dirty after baseline save — refusing optimistic execution`
      );
      return false;
    }
    return true;
  } catch (error) {
    logWarn('AgentRollback', 'prepareRollbackWorkspace failed', error);
    return false;
  }
}

/**
 * Commit whatever the run just wrote and return an undo handle. Returns null
 * when there is nothing to undo (the run wrote no files) or when the commit was
 * blocked — in both cases no undo affordance may be shown.
 */
export async function captureRollbackPoint(
  agentId: string,
  workspaceRoot: string,
  runCommand: RollbackRunCommand,
  onSecurityIssues?: (issues: SecurityIssue[]) => void
): Promise<AgentRollbackHandle | null> {
  try {
    const saved = await checkAndSave(workspaceRoot, runCommand, onSecurityIssues);
    if (!saved) return null;
    logInfo('AgentRollback', `captured rollback point ${saved.commitHash} for ${agentId}`);
    return {
      agentId,
      workspaceRoot,
      commitHash: saved.commitHash,
      message: saved.message,
      filesChanged: saved.filesChanged,
      filesCreated: saved.filesCreated,
      filesDeleted: saved.filesDeleted,
      createdAtMs: Date.now(),
    };
  } catch (error) {
    logWarn('AgentRollback', 'captureRollbackPoint failed', error);
    return null;
  }
}

/**
 * Undo an optimistic run. Non-destructive: adds an inverse commit for the run's
 * own commit, so unrelated savepoints made after it are preserved and the undo
 * itself stays in history (and is therefore itself undoable via git).
 */
export async function undoAgentRun(
  handle: AgentRollbackHandle,
  runCommand: RollbackRunCommand
): Promise<boolean> {
  try {
    return await revertSavepoint(handle.workspaceRoot, handle.commitHash, runCommand);
  } catch (error) {
    logWarn('AgentRollback', 'undoAgentRun failed', error);
    return false;
  }
}

/** One-line summary for the completion message ("下書き1件を保存しました" etc.). */
export function describeRollbackHandle(handle: AgentRollbackHandle): string {
  const parts: string[] = [];
  if (handle.filesCreated) parts.push(`+${handle.filesCreated}`);
  if (handle.filesChanged) parts.push(`~${handle.filesChanged}`);
  if (handle.filesDeleted) parts.push(`-${handle.filesDeleted}`);
  return parts.length ? `${handle.message} (${parts.join(' ')})` : handle.message;
}
