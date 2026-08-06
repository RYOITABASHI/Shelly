/**
 * lib/memory-workbench.ts — pure search/filter helpers for the Memory
 * Workbench pane (components/panes/MemoryWorkbenchPane.tsx).
 *
 * Deliberately dependency-free (structural note type, no expo / agent-memory
 * import) so the plain-node "unit" Jest project can import it without any
 * module mocks — same pattern as lib/agent-data-sync.ts.
 */

/** Structural twin of lib/agent-memory.ts's MemoryNote (kept import-free). */
export interface WorkbenchNote {
  id: string;
  agentId: string;
  type: string;
  created: string;
  tags: string[];
  text: string;
}

/**
 * Case-insensitive filter over note text (substring), tags (substring) and
 * type (exact). An empty/whitespace query returns the input unchanged, and
 * match order always follows the input order (newest-first from the readers).
 */
export function filterMemoryNotes<T extends WorkbenchNote>(notes: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter(
    (note) =>
      note.text.toLowerCase().includes(q) ||
      note.tags.some((tag) => tag.toLowerCase().includes(q)) ||
      note.type.toLowerCase() === q
  );
}

/**
 * Parse the edit form's comma-separated tag input into a raw tag list.
 * Normalization (lowercase, charset, dedupe) is NOT done here — that is
 * makeMemoryNote/normalizeTags' job on the write path, and duplicating it
 * would risk drifting from G2's rules.
 */
export function parseTagsInput(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}
