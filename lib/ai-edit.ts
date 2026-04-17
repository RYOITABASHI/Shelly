/**
 * lib/ai-edit.ts — "Golden path" for AI-assisted file editing.
 *
 * Flow:
 *   1. CodeTab (or any file viewer) calls `stageAiEdit(path)`.
 *   2. The file is cat'd via execCommand so the caller gets the current
 *      content, and the same content is injected into the first AI
 *      pane's terminalContext so `buildAIPaneSystemPrompt` folds it
 *      into the system message on the next dispatch.
 *   3. The user types "make X do Y" into the AI pane input.
 *   4. The existing use-ai-pane-dispatch sends it to Cerebras/Claude/
 *      Gemini with the file as context and a hint to reply with a
 *      unified diff.
 *   5. The assistant reply containing a unified diff is automatically
 *      picked up by InlineDiff via hasDiffContent() and rendered with
 *      accept / reject buttons.
 *
 * This file deliberately stays UI-free so it can be called from
 * FileTree, CodeTab, or a command-palette action.
 */

import { execCommand, writeFileNative } from '@/hooks/use-native-exec';
import { usePaneStore } from '@/store/pane-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { usePreviewStore } from '@/store/preview-store';

/**
 * Find the first AI pane in the current multi-pane tree, or null if
 * the user hasn't opened one yet. Prefers the focused pane when it's
 * already an AI pane.
 */
function findAiPaneId(): string | null {
  const panes = usePaneStore.getState().paneAgents;
  const focused = usePaneStore.getState().focusedPaneId;
  const multi = useMultiPaneStore.getState();

  // Focused pane first if it's bound to an agent
  if (focused && panes[focused]) return focused;

  // Otherwise walk the tree looking for a pane of type 'ai'
  // `paneTypes` maps leafId → pane kind ('terminal', 'ai', 'browser', ...)
  const types = (multi as unknown as { paneTypes?: Record<string, string> }).paneTypes ?? {};
  for (const [leafId, type] of Object.entries(types)) {
    if (type === 'ai') return leafId;
  }

  // Fallback: any leaf that has an agent bound
  const firstBound = Object.keys(panes)[0];
  return firstBound ?? null;
}

// ── Module-level staged edit ──────────────────────────────────────────
//
// Exactly one file can be "staged" for AI editing at a time. Holding this
// in a module variable (rather than inside a React store) lets InlineDiff
// look it up from anywhere in the render tree without threading props or
// context through the 5+ components between Preview and the diff block.

type StagedEdit = {
  path: string;
  originalContent: string;
};

let stagedEdit: StagedEdit | null = null;

export function getStagedEdit(): StagedEdit | null {
  return stagedEdit;
}

export function clearStagedEdit(): void {
  stagedEdit = null;
}

/**
 * Write new content to the staged file via writeFileNative and refresh
 * the Preview pane so the on-screen Code tab reflects the change. Returns
 * an error message on failure, or null on success.
 */
export async function applyStagedEdit(newContent: string): Promise<string | null> {
  if (!stagedEdit) return 'No file staged';
  const { path } = stagedEdit;
  const result = await writeFileNative(path, newContent);
  if (result.ok === false) return result.error;

  // Refresh the Code tab so the user sees the updated content
  usePreviewStore.getState().notifyFileChange(path);
  stagedEdit = { path, originalContent: newContent };
  return null;
}

// ── Unified diff apply ────────────────────────────────────────────────
//
// Minimal unified-diff applier. Enough to handle the diffs Cerebras /
// Claude / Gemini generate for small file edits, not a full `patch(1)`
// replacement. Supports multiple hunks in a single diff and assumes
// the hunks apply in order against the *original* content.

type ParsedHunk = {
  oldStart: number; // 1-based original line where this hunk starts
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];  // raw lines with leading ' ', '+', '-'
};

function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = diff.split('\n');
  let current: ParsedHunk | null = null;

  for (const raw of lines) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue;

    const header = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(header[1], 10),
        oldCount: header[2] ? parseInt(header[2], 10) : 1,
        newStart: parseInt(header[3], 10),
        newCount: header[4] ? parseInt(header[4], 10) : 1,
        lines: [],
      };
      continue;
    }

    if (current && (raw.startsWith(' ') || raw.startsWith('+') || raw.startsWith('-'))) {
      current.lines.push(raw);
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

// Extract the first N leading context/removal lines a hunk expects to
// find in the original file. Used by the fuzzy locator to re-anchor a
// hunk whose @@ header is stale (the rest of the file shifted because
// a previous hunk in the same diff was already applied to disk).
function hunkAnchorLines(hunk: ParsedHunk, max = 3): string[] {
  const anchor: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith('+')) continue;
    anchor.push(line.slice(1));
    if (anchor.length >= max) break;
  }
  return anchor;
}

// Walk origLines from the given offset and return the index where the
// anchor sequence next matches, or -1 if it's nowhere to be found.
function findAnchor(origLines: string[], anchor: string[], from: number): number {
  if (anchor.length === 0) return from;
  outer: for (let i = from; i <= origLines.length - anchor.length; i++) {
    for (let j = 0; j < anchor.length; j++) {
      if (origLines[i + j] !== anchor[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Apply a unified diff to the original content. Returns the patched
 * content or null on any apply failure (line count mismatch, context
 * drift, etc). Callers should fall back to showing the raw diff when
 * this returns null.
 *
 * When `fuzzy` is true, each hunk's @@ header is treated as a hint;
 * the applier searches forward from the current cursor for the hunk's
 * leading anchor lines instead of trusting the line number. This lets
 * per-hunk Accept apply successive hunks to an already-edited file
 * even though the original @@ -N counts are now stale.
 */
export function applyUnifiedDiff(original: string, diff: string, fuzzy = false): string | null {
  const origLines = original.split('\n');
  const hunks = parseHunks(diff);
  if (hunks.length === 0) return null;

  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines

  for (const hunk of hunks) {
    let hunkStart = hunk.oldStart - 1; // -> 0-based

    if (fuzzy || hunkStart < cursor || hunkStart >= origLines.length) {
      // Re-anchor by searching for the hunk's leading context/removal
      // block. Covers two cases: explicit fuzzy mode, and strict mode
      // where the @@ header is out of range because the file has
      // already been partially edited.
      const anchor = hunkAnchorLines(hunk);
      const found = findAnchor(origLines, anchor, cursor);
      if (found === -1) return null;
      hunkStart = found;
    }

    if (hunkStart < cursor) return null; // overlapping / out-of-order
    if (hunkStart > origLines.length) return null;

    // Emit untouched lines between previous hunk and this one
    while (cursor < hunkStart) {
      out.push(origLines[cursor++]);
    }

    // Walk hunk lines
    for (const line of hunk.lines) {
      const marker = line[0];
      const body = line.slice(1);
      if (marker === ' ') {
        // Context: must match original
        if (origLines[cursor] !== body) return null;
        out.push(origLines[cursor]);
        cursor++;
      } else if (marker === '-') {
        // Removal: must match, advance original, skip output
        if (origLines[cursor] !== body) return null;
        cursor++;
      } else if (marker === '+') {
        // Addition: emit, don't advance original
        out.push(body);
      }
    }
  }

  // Tail
  while (cursor < origLines.length) {
    out.push(origLines[cursor++]);
  }

  return out.join('\n');
}

/**
 * Convenience: apply diff to the currently-staged file, write it back,
 * and refresh the preview. Returns an error message or null.
 */
export async function acceptStagedDiff(diff: string): Promise<string | null> {
  if (!stagedEdit) return 'No file staged';
  // Try strict (line-number-trusting) first, then fuzzy as a fallback.
  // Strict is slightly safer because it catches hunks that landed at
  // the wrong offset; fuzzy re-anchors per-hunk Accepts after the file
  // has already been partially edited.
  let patched = applyUnifiedDiff(stagedEdit.originalContent, diff);
  if (patched === null) {
    patched = applyUnifiedDiff(stagedEdit.originalContent, diff, true);
  }
  if (patched === null) {
    return 'Could not apply diff — context mismatch. Ask the AI to regenerate against the latest file.';
  }
  return applyStagedEdit(patched);
}

/**
 * Read a file via the native bridge and return its contents, or throw
 * on failure. Single shell-quoted cat — no more than one round-trip.
 */
async function readFileContent(path: string): Promise<string> {
  const esc = path.replace(/'/g, "'\\''");
  const result = await execCommand(`cat '${esc}'`, 30_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr?.trim() || `cat exited ${result.exitCode}`);
  }
  return result.stdout ?? '';
}

/**
 * Stage a file for AI editing. Loads the file and injects it into the
 * first available AI pane's terminalContext so the next user message
 * goes out with the file content in the system prompt.
 *
 * Returns true if an AI pane was found and primed, false if the user
 * needs to open one first.
 */
export async function stageAiEdit(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFileContent(path);
  } catch (err) {
    throw new Error(
      `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Remember the file + snapshot so Accept can write back later.
  stagedEdit = { path, originalContent: content };

  const paneId = findAiPaneId();
  if (!paneId) return false;

  // Inject as terminalContext so buildAIPaneSystemPrompt picks it up.
  // Wrap in a clear marker so the assistant knows it's a file, not
  // terminal output.
  const context =
    `[File: ${path}]\n${content}\n[End File]\n\n` +
    `You are editing the file above. When suggesting changes, respond ` +
    `with a unified diff (--- / +++ / @@ hunks) so the user can accept ` +
    `or reject each hunk inline.`;

  useAIPaneStore.getState().setTerminalContext(paneId, context);

  // Seed a hint message in the conversation so the user sees why the
  // context badge lit up. This is a local 'system' role message — it
  // will not be forwarded to the model (dispatcher filters system
  // messages), it just explains to the user what just happened.
  useAIPaneStore.getState().addMessage(paneId, {
    id: `ai-edit-${Date.now()}`,
    role: 'system',
    content: `Staged ${path} for AI editing. Type what you want changed.`,
    timestamp: Date.now(),
  });

  return true;
}

// ── Auto-stage from terminal output ─────────────────────────────────
//
// Used by the AI pane dispatch layer so the cross-pane-intelligence
// "error on the left → AI fixes it → one-tap apply" loop works without
// the user having to pre-open the file in a Code pane. Looks at the
// terminal snapshot for file:line references, resolves one to an
// absolute path using the active session cwd, reads the file, and
// stages it silently (no conversation-level "Staged X" system line
// because the user never explicitly asked for this — we just want the
// file write-back path wired when Accept eventually fires).

const FILE_REF_RE =
  /([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|sh|bash|zsh|rb|php|cs|swift|md|mdx|json|jsonc|yaml|yml|toml|html|css|scss|sass|less|vue|svelte)):(\d+)(?::(\d+))?/g;

export function extractFileRefsFromOutput(output: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  FILE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF_RE.exec(output)) !== null) {
    const ref = m[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

export function resolveFileRef(cwd: string, ref: string): string {
  if (ref.startsWith('/')) return ref;
  if (ref.startsWith('~')) return ref; // caller substitutes $HOME as needed
  // Normalise away any leading "./" and collapse any "/./" segments.
  const rel = ref.replace(/^\.\/+/, '').replace(/\/\.\//g, '/');
  return `${cwd.replace(/\/+$/, '')}/${rel}`;
}

/**
 * Try to auto-stage the first readable file referenced in the terminal
 * output. Returns the absolute path staged, or null if nothing matched
 * or every candidate failed to read. Does NOT touch the pane store — the
 * caller is responsible for weaving the file content into the system
 * prompt.
 */
export async function tryAutoStageFromTerminal(
  cwd: string,
  terminalOutput: string,
): Promise<{ path: string; content: string } | null> {
  const refs = extractFileRefsFromOutput(terminalOutput);
  if (refs.length === 0) return null;

  for (const ref of refs) {
    const absPath = resolveFileRef(cwd, ref);
    try {
      const content = await readFileContent(absPath);
      stagedEdit = { path: absPath, originalContent: content };
      return { path: absPath, content };
    } catch {
      // Try the next reference — common cause is a build-tool-relative
      // path that doesn't line up with the terminal's cwd.
      continue;
    }
  }
  return null;
}
