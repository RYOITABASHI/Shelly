// Unit coverage for Sidebar's "Add Repository" path validation. Lives in
// lib/repo-path-validation.ts (not Sidebar.tsx) so this test can run in the
// plain 'unit' jest project (ts-jest/node) without mocking the native
// TerminalEmulator module and the rest of Sidebar.tsx's import graph — see
// that file's own header comment for why.
//
// Covers the bug #73 follow-up: the old Sidebar.tsx code treated an empty
// readDirEntries() result on the parent directory as "unreadable, fall
// through and accept the add" — but readDirEntries returns [] on ENOENT,
// EACCES, *and* a genuinely empty directory, indistinguishably, so any read
// failure silently created a ghost entry. It also never checked for a
// `.git` entry, so any existing non-git directory was accepted too.
import { validateRepoPath, type DirEntryLike, type ReadDirEntriesFn } from '@/lib/repo-path-validation';

function fakeFs(tree: Record<string, DirEntryLike[]>): ReadDirEntriesFn {
  return async (path: string) => tree[path] ?? [];
}

describe('validateRepoPath', () => {
  it('rejects a nonexistent path as not_found', async () => {
    const readDirEntries = fakeFs({
      '/home': [{ name: 'existing', type: 'd' }],
    });
    const result = await validateRepoPath('/home/ghost1', readDirEntries);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects when the parent is unreadable (empty readdir), never fails open', async () => {
    // readDirEntries('/nonexistent') and readDirEntries('/nonexistent/zzz')
    // both return [] here, simulating ENOENT/EACCES on both the parent and
    // the target — the exact fail-open scenario from the bug report.
    const readDirEntries = fakeFs({});
    const result = await validateRepoPath('/nonexistent/zzz/ghost1', readDirEntries);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('falls back to probing the target directly when only the parent listing is empty', async () => {
    // Parent has no r-bit (readDirEntries('/home') -> []) but the target
    // itself is traversable and readable directly — a real POSIX scenario
    // (chmod 711 parent). Should not reject just because the parent probe
    // came back empty.
    const readDirEntries = fakeFs({
      '/home/repo': [{ name: '.git', type: 'd' }, { name: 'src', type: 'd' }],
    });
    const result = await validateRepoPath('/home/repo', readDirEntries);
    expect(result).toEqual({ ok: true });
  });

  it('rejects an existing non-git directory as not_git', async () => {
    const readDirEntries = fakeFs({
      '/home': [{ name: 'Downloads', type: 'd' }],
      '/home/Downloads': [{ name: 'file.txt', type: 'f' }, { name: 'photos', type: 'd' }],
    });
    const result = await validateRepoPath('/home/Downloads', readDirEntries);
    expect(result).toEqual({ ok: false, reason: 'not_git' });
  });

  it('accepts an existing git directory (happy path)', async () => {
    const readDirEntries = fakeFs({
      '/home': [{ name: 'myrepo', type: 'd' }],
      '/home/myrepo': [{ name: '.git', type: 'd' }, { name: 'README.md', type: 'f' }],
    });
    const result = await validateRepoPath('/home/myrepo', readDirEntries);
    expect(result).toEqual({ ok: true });
  });

  it('accepts a worktree/submodule whose .git is a file, not a directory', async () => {
    const readDirEntries = fakeFs({
      '/home': [{ name: 'worktree1', type: 'd' }],
      '/home/worktree1': [{ name: '.git', type: 'f' }],
    });
    const result = await validateRepoPath('/home/worktree1', readDirEntries);
    expect(result).toEqual({ ok: true });
  });

  it('treats a symlinked directory entry in the parent as eligible for the .git check', async () => {
    const readDirEntries = fakeFs({
      '/home': [{ name: 'linked-repo', type: 'l' }],
      '/home/linked-repo': [{ name: '.git', type: 'd' }],
    });
    const result = await validateRepoPath('/home/linked-repo', readDirEntries);
    expect(result).toEqual({ ok: true });
  });
});
