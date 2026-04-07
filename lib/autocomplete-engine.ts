/**
 * Fuzzy matching autocomplete engine for the Shelly terminal.
 * Wraps the static completion database from completions.ts and adds:
 *  - Fuzzy scoring with consecutive-match bonus + word-boundary bonus
 *  - History-aware suggestions
 *  - Deduplication and rank-sorting
 *
 * Path and git-branch completions are intentionally omitted here;
 * they will be wired in async in a later task.
 */

import { getCompletions as getStaticCompletions } from './completions';

// ── Public types ───────────────────────────────────────────────────────────────

export type CompletionItem = {
  label: string;
  detail?: string;
  insertText: string;
  kind: 'command' | 'flag' | 'path' | 'branch' | 'history';
  score: number;
  icon?: string;
};

export type AutocompleteContext = {
  cwd: string;
  history: string[];
  env: Record<string, string>;
};

// ── Fuzzy scorer ───────────────────────────────────────────────────────────────

/**
 * Score `query` against `candidate` using a simple but effective fuzzy algorithm.
 *
 * Scoring bonuses (higher = better match):
 *  +100  prefix match (candidate starts with query)
 *  +10   each consecutive matched character run
 *  +5    match starts at a word boundary (-, _, /, space, or after a digit→alpha transition)
 *  +1    each matched character
 *  0     query characters missing → returns 0 (no match)
 *
 * Returns 0 when not all query characters appear in candidate in order.
 */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1; // empty query matches everything with base score
  if (!candidate) return 0;

  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // Fast-path: exact prefix
  if (c.startsWith(q)) {
    // Extra bonus for exact match
    return 100 + (q.length === c.length ? 50 : 0);
  }

  let score = 0;
  let qi = 0; // index into query
  let prevMatched = false;
  let consecutiveRun = 0;

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      score += 1; // base per-char score

      if (prevMatched) {
        consecutiveRun++;
        score += consecutiveRun * 10; // consecutive bonus grows
      } else {
        consecutiveRun = 0;
      }

      // Word-boundary bonus
      if (ci === 0 || isWordBoundary(c, ci)) {
        score += 5;
      }

      prevMatched = true;
      qi++;
    } else {
      prevMatched = false;
      consecutiveRun = 0;
    }
  }

  // All query chars must be matched
  if (qi < q.length) return 0;

  return score;
}

function isWordBoundary(s: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = s[idx - 1];
  const cur = s[idx];
  // After separator characters
  if ('-_/ '.includes(prev)) return true;
  // Digit → letter transition
  if (/\d/.test(prev) && /[a-z]/i.test(cur)) return true;
  // Lowercase → uppercase (camelCase)
  if (/[a-z]/.test(prev) && /[A-Z]/.test(cur)) return true;
  return false;
}

// ── Icons ──────────────────────────────────────────────────────────────────────

const KIND_ICONS: Record<CompletionItem['kind'], string> = {
  command: '⚡',
  flag: '⚑',
  path: '📁',
  branch: '⎇',
  history: '⏱',
};

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Return up to 8 ranked, deduplicated completion items for the current input.
 *
 * Steps:
 *  1. Parse input to determine the last token being typed.
 *  2. Delegate to the static completion database for command/subcommand/flag matches.
 *  3. Scan history for entries that start with the current input.
 *  4. Fuzzy-score all candidates, sort descending, dedupe by insertText, cap at 8.
 */
export function getCompletions(
  input: string,
  context: AutocompleteContext,
  limit = 8,
): CompletionItem[] {
  const trimmed = input.trimStart();
  if (!trimmed) return [];

  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1];

  const items: CompletionItem[] = [];

  // ── 1. Static completions (commands, subcommands, flags) ─────────────────────
  const staticResults = getStaticCompletions(trimmed, limit * 2);
  for (const entry of staticResults) {
    const kind = resolveKind(lastToken, tokens);
    const score = fuzzyScore(lastToken, entry.label);
    if (score === 0 && lastToken.length > 0) continue;
    items.push({
      label: entry.label,
      detail: entry.detail,
      insertText: entry.insertText,
      kind,
      score,
      icon: KIND_ICONS[kind],
    });
  }

  // ── 2. History completions ────────────────────────────────────────────────────
  const seenHistory = new Set<string>();
  for (const entry of context.history) {
    if (!entry.startsWith(trimmed) || entry === trimmed) continue;
    if (seenHistory.has(entry)) continue;
    seenHistory.add(entry);

    // For history we score the whole input against the whole entry
    const score = fuzzyScore(trimmed, entry) + 5; // slight history boost
    items.push({
      label: entry,
      detail: 'history',
      insertText: entry,
      kind: 'history',
      score,
      icon: KIND_ICONS.history,
    });
  }

  // ── 3. Fuzzy re-score top-level commands when typing first token ──────────────
  // The static engine only does prefix matching; supplement with fuzzy matches
  // for single-token input so "gt" → "git", "py" → "python3", etc.
  if (tokens.length === 1 && lastToken.length >= 1) {
    const TOP_COMMANDS = getTopCommandLabels();
    for (const { label, detail, insertText } of TOP_COMMANDS) {
      const score = fuzzyScore(lastToken, label);
      if (score === 0) continue;
      // Avoid duplicating entries already added by the static engine
      const alreadyPresent = items.some(
        (i) => i.kind !== 'history' && i.label === label,
      );
      if (!alreadyPresent) {
        items.push({
          label,
          detail,
          insertText,
          kind: 'command',
          score,
          icon: KIND_ICONS.command,
        });
      }
    }
  }

  // ── 4. Sort, dedupe, limit ────────────────────────────────────────────────────
  items.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.insertText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveKind(
  lastToken: string,
  tokens: string[],
): CompletionItem['kind'] {
  if (lastToken.startsWith('-')) return 'flag';
  if (tokens.length <= 1) return 'command';
  return 'command'; // subcommands are still 'command' kind
}

/**
 * Inline list mirroring TOP_COMMANDS from completions.ts.
 * Kept in sync manually; used only for fuzzy fallback on single-token input.
 */
function getTopCommandLabels(): Array<{
  label: string;
  detail?: string;
  insertText: string;
}> {
  return [
    { label: 'git', detail: 'Version control', insertText: 'git ' },
    { label: 'npm', detail: 'Node package manager', insertText: 'npm ' },
    { label: 'npx', detail: 'Node package executor', insertText: 'npx ' },
    { label: 'pnpm', detail: 'Fast package manager', insertText: 'pnpm ' },
    { label: 'node', detail: 'Run JavaScript', insertText: 'node ' },
    { label: 'python3', detail: 'Python interpreter', insertText: 'python3 ' },
    { label: 'pip', detail: 'Python packages', insertText: 'pip ' },
    { label: 'cargo', detail: 'Rust package manager', insertText: 'cargo ' },
    { label: 'docker', detail: 'Container platform', insertText: 'docker ' },
    { label: 'ls', detail: 'List directory', insertText: 'ls ' },
    { label: 'cd', detail: 'Change directory', insertText: 'cd ' },
    { label: 'cat', detail: 'Display file', insertText: 'cat ' },
    { label: 'grep', detail: 'Search text', insertText: 'grep ' },
    { label: 'find', detail: 'Find files', insertText: 'find ' },
    { label: 'mkdir', detail: 'Create directory', insertText: 'mkdir ' },
    { label: 'rm', detail: 'Remove files', insertText: 'rm ' },
    { label: 'cp', detail: 'Copy files', insertText: 'cp ' },
    { label: 'mv', detail: 'Move/rename', insertText: 'mv ' },
    { label: 'chmod', detail: 'Change permissions', insertText: 'chmod ' },
    { label: 'curl', detail: 'HTTP client', insertText: 'curl ' },
    { label: 'wget', detail: 'Download files', insertText: 'wget ' },
    { label: 'ssh', detail: 'Secure shell', insertText: 'ssh ' },
    { label: 'tar', detail: 'Archive tool', insertText: 'tar ' },
    { label: 'pkg', detail: 'Termux packages', insertText: 'pkg ' },
    { label: 'apt', detail: 'Package manager', insertText: 'apt ' },
    { label: 'tmux', detail: 'Terminal multiplexer', insertText: 'tmux ' },
    { label: 'vim', detail: 'Text editor', insertText: 'vim ' },
    { label: 'nano', detail: 'Text editor', insertText: 'nano ' },
    { label: 'htop', detail: 'Process viewer', insertText: 'htop' },
    { label: 'clear', detail: 'Clear terminal', insertText: 'clear' },
    { label: 'echo', detail: 'Print text', insertText: 'echo ' },
    { label: 'export', detail: 'Set env variable', insertText: 'export ' },
    { label: 'which', detail: 'Locate command', insertText: 'which ' },
    { label: 'man', detail: 'Manual pages', insertText: 'man ' },
  ];
}
