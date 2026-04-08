/**
 * useAutocomplete — combines sync completions from the autocomplete engine
 * with async path and git-branch completions via JNI execCommand.
 *
 * Async completions are debounced (150 ms) and cached to avoid redundant
 * shell invocations:
 *   - path completions:       5 s TTL, keyed on resolved parent directory
 *   - git branch completions: 10 s TTL, keyed on cwd
 */

import { useState, useEffect, useRef } from 'react';
import {
  getCompletions,
  type CompletionItem,
  type AutocompleteContext,
} from '@/lib/autocomplete-engine';
import { execCommand } from '@/hooks/use-native-exec';

// ── Cache shapes ───────────────────────────────────────────────────────────────

type PathCache = { dir: string; entries: string[]; ts: number } | null;
type BranchCache = { cwd: string; branches: string[]; ts: number } | null;

// ── Path completions ───────────────────────────────────────────────────────────

/**
 * List entries under the parent directory of `token` and return CompletionItems.
 * Results are cached for 5 seconds per resolved directory path.
 *
 * Accepts tokens that start with `.`, `~`, or `/`.
 */
async function getPathCompletions(
  token: string,
  cwd: string,
  cacheRef: React.MutableRefObject<PathCache>,
): Promise<CompletionItem[]> {
  // Split token into dir prefix and partial name for matching
  const lastSlash = token.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? token.slice(0, lastSlash + 1) : '';
  const namePart = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;

  // Resolve the directory to list
  let resolvedDir: string;
  if (dirPart === '') {
    // e.g. token is ".git" or "~rc" — list cwd
    resolvedDir = cwd;
  } else if (dirPart.startsWith('~')) {
    // Replace leading ~ with $HOME via the shell
    resolvedDir = dirPart; // will be passed verbatim to ls; shell expands ~
  } else if (dirPart.startsWith('/')) {
    resolvedDir = dirPart;
  } else {
    // Relative path — combine with cwd
    resolvedDir = `${cwd}/${dirPart}`;
  }

  const now = Date.now();
  const cache = cacheRef.current;
  let entries: string[];

  if (cache && cache.dir === resolvedDir && now - cache.ts < 5_000) {
    entries = cache.entries;
  } else {
    try {
      const result = await execCommand(
        `ls -1 '${resolvedDir}' 2>/dev/null`,
        5_000,
      );
      if (result.exitCode !== 0) return [];
      entries = result.stdout.split('\n').filter(Boolean);
      cacheRef.current = { dir: resolvedDir, entries, ts: now };
    } catch {
      return [];
    }
  }

  const lowerName = namePart.toLowerCase();
  return entries
    .filter((e) => !namePart || e.toLowerCase().startsWith(lowerName))
    .map((entry) => {
      const insertText = dirPart + entry;
      return {
        label: entry,
        detail: dirPart || resolvedDir,
        insertText,
        kind: 'path' as const,
        score: entry.toLowerCase().startsWith(lowerName) ? 80 : 40,
        icon: '📁',
      };
    });
}

// ── Git branch completions ─────────────────────────────────────────────────────

/**
 * List local git branches in `cwd` and return matching CompletionItems.
 * Results are cached for 10 seconds per cwd.
 *
 * The partial `token` is used for prefix filtering.
 */
async function getGitBranchCompletions(
  token: string,
  cwd: string,
  cacheRef: React.MutableRefObject<BranchCache>,
): Promise<CompletionItem[]> {
  const now = Date.now();
  const cache = cacheRef.current;
  let branches: string[];

  if (cache && cache.cwd === cwd && now - cache.ts < 10_000) {
    branches = cache.branches;
  } else {
    try {
      const result = await execCommand(
        `cd '${cwd}' && git branch --list --format="%(refname:short)" 2>/dev/null`,
        5_000,
      );
      if (result.exitCode !== 0) return [];
      branches = result.stdout.split('\n').filter(Boolean);
      cacheRef.current = { cwd, branches, ts: now };
    } catch {
      return [];
    }
  }

  const lowerToken = token.toLowerCase();
  return branches
    .filter((b) => !token || b.toLowerCase().startsWith(lowerToken))
    .map((branch) => ({
      label: branch,
      detail: 'git branch',
      insertText: branch,
      kind: 'branch' as const,
      score: branch.toLowerCase().startsWith(lowerToken) ? 75 : 35,
      icon: '⎇',
    }));
}

// ── Merge helper ───────────────────────────────────────────────────────────────

/**
 * Combine two CompletionItem arrays, deduplicate by label, re-sort by score
 * descending, and cap the result at 8 entries.
 */
function mergeCompletions(
  existing: CompletionItem[],
  incoming: CompletionItem[],
  limit = 8,
): CompletionItem[] {
  const merged = [...existing];
  const seenLabels = new Set(existing.map((i) => i.label));

  for (const item of incoming) {
    if (!seenLabels.has(item.label)) {
      seenLabels.add(item.label);
      merged.push(item);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

// ── Hook ───────────────────────────────────────────────────────────────────────

/**
 * Returns a ranked list of up to 8 CompletionItems for the current `input`.
 *
 * Sync completions (commands, flags, history) are applied immediately;
 * async path / git-branch completions are merged in once the shell returns.
 */
export function useAutocomplete(
  input: string,
  cwd: string,
  history: string[],
): CompletionItem[] {
  const [items, setItems] = useState<CompletionItem[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pathCacheRef = useRef<PathCache>(null);
  const branchCacheRef = useRef<BranchCache>(null);

  useEffect(() => {
    if (!input.trim()) {
      setItems([]);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const ctx: AutocompleteContext = { cwd, history, env: {} };

      // ── Sync completions (immediate) ─────────────────────────────────────
      const sync = getCompletions(input, ctx);
      setItems(sync);

      const lastToken = input.split(/\s+/).pop() ?? '';

      // ── Async: path completions ──────────────────────────────────────────
      if (lastToken.match(/^[.~\/]/)) {
        const pathItems = await getPathCompletions(
          lastToken,
          cwd,
          pathCacheRef,
        );
        if (pathItems.length > 0) {
          setItems((prev) => mergeCompletions(prev, pathItems));
        }
      }

      // ── Async: git branch completions ────────────────────────────────────
      if (input.match(/git\s+(checkout|merge|rebase|branch\s+-d)\s+/)) {
        const branchItems = await getGitBranchCompletions(
          lastToken,
          cwd,
          branchCacheRef,
        );
        if (branchItems.length > 0) {
          setItems((prev) => mergeCompletions(prev, branchItems));
        }
      }
    }, 150);

    return () => clearTimeout(debounceRef.current);
  }, [input, cwd]); // history intentionally omitted — same ref across renders

  return items;
}
