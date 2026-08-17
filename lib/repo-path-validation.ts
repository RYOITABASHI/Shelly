// Pure repo-path validation for Sidebar's "Add Repository" modal. Kept in
// lib/ (no JSX, no RN/native-module imports) so it has direct unit coverage
// without pulling in Sidebar.tsx's full import graph — same reasoning as
// lib/agent-running-format.ts (see its header comment).
//
// bug #73 follow-up: the original Sidebar.tsx implementation probed only the
// PARENT directory via readDirEntries() and treated an empty result as
// "parent unreadable, fall through and accept the add" — but readDirEntries
// returns [] on ENOENT/EACCES/IO-error indistinguishably from a genuinely
// empty directory (see lib/fs-native.ts's own doc comment), so any read
// failure silently accepted the add, reproducing exactly the ghost-entry bug
// #73 was meant to fix. Separately, the old code never checked for a `.git`
// entry at all, so any existing non-git directory (e.g. a Downloads folder)
// was accepted as a "repository".
//
// This version fixes both: it never fails open on a read error, and it
// requires an actual `.git` entry (directory OR file, since worktrees and
// submodules use a `.git` file containing a `gitdir:` pointer rather than a
// `.git` directory — those are legitimate repos a user would want to add).

export interface DirEntryLike {
  name: string;
  type: 'd' | 'f' | 'l' | '?';
}

export type ReadDirEntriesFn = (path: string) => Promise<DirEntryLike[]>;

export type RepoPathValidation =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_git' };

function hasGitEntry(entries: DirEntryLike[]): boolean {
  return entries.some((e) => e.name === '.git' && (e.type === 'd' || e.type === 'f'));
}

/** Validate that `normalizedPath` is a readable directory containing a
 *  `.git` entry. Never fails open: every path through this function ends in
 *  either `{ ok: true }` or a distinct rejection reason.
 *
 *  Strategy: probe the parent directory first (so a `not_git` rejection can
 *  name the offending basename without an extra round-trip). If the parent
 *  listing is empty — which readDirEntries returns on ENOENT, EACCES, *and*
 *  a genuinely empty directory, indistinguishably — fall back to probing the
 *  target path directly. That fallback also covers the case where the
 *  parent lacks list (r) permission but still has traverse (x) permission,
 *  a real POSIX scenario where the parent probe alone would wrongly reject.
 *  If the target probe is *also* empty, the path cannot be confirmed to
 *  exist and is certainly not a non-empty git repo either way, so reject
 *  as `not_found` rather than accepting. */
export async function validateRepoPath(
  normalizedPath: string,
  readDirEntries: ReadDirEntriesFn,
): Promise<RepoPathValidation> {
  const slash = normalizedPath.lastIndexOf('/');
  const parent = slash > 0 ? normalizedPath.slice(0, slash) : '/';
  const basename = slash >= 0 ? normalizedPath.slice(slash + 1) : normalizedPath;

  const parentEntries = await readDirEntries(parent);
  const foundInParent = parentEntries.some(
    (e) => e.name === basename && (e.type === 'd' || e.type === 'l'),
  );

  if (foundInParent) {
    const targetEntries = await readDirEntries(normalizedPath);
    return hasGitEntry(targetEntries) ? { ok: true } : { ok: false, reason: 'not_git' };
  }

  // Parent read failed, or basename wasn't listed there — don't fail open.
  // Fall back to probing the target path itself before giving up.
  const targetEntries = await readDirEntries(normalizedPath);
  if (targetEntries.length === 0) {
    return { ok: false, reason: 'not_found' };
  }
  return hasGitEntry(targetEntries) ? { ok: true } : { ok: false, reason: 'not_git' };
}
