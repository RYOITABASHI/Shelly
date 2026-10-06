/**
 * lib/quote-to-ai.ts
 *
 * "Quote to AI" (inspired by Grok's Cmd+L "Add to prompt"): the user selects
 * terminal output, taps the native selection menu's "Ask AI" item, and the
 * text lands — quoted — in an AI composer draft. It is NEVER auto-sent; the
 * user adds their question and presses Send themselves.
 *
 * This file holds the pure pieces (formatting, truncation, draft insertion,
 * target-pane choice) so they are unit-testable without the native view.
 * The side-effectful routing lives in routeQuoteToAI() at the bottom.
 */
import { logInfo } from '@/lib/debug-logger';

/** Selections longer than this keep only their tail (errors/stack traces
 *  usually end at the bottom) plus an omission note. */
export const QUOTE_MAX_CHARS = 4000;

export type QuoteTargetTab = 'ai' | 'agent-chat';

export type FormatQuoteOptions = {
  maxChars?: number;
  /** Builds the omission note (i18n'd by the caller). */
  truncationNote?: (omittedChars: number) => string;
};

const defaultTruncationNote = (omitted: number) => `[… ${omitted} earlier characters omitted]`;

/** Longest run of consecutive backticks in `text`. */
function longestBacktickRun(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return max;
}

/**
 * Normalize a raw terminal selection: CRLF → LF, drop the trailing padding
 * the emulator leaves on each row, and trim leading/trailing blank lines
 * (indentation inside the block is preserved).
 */
export function normalizeSelection(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * Format a terminal selection as a quoted block for a prompt.
 * - single line  → markdown blockquote (`> text`)
 * - multi-line   → fenced ```text block (fence grows past any backtick run
 *                  inside the selection so it can't be closed early)
 * Returns null when the selection is empty/whitespace-only.
 */
export function formatQuoteBlock(raw: string, opts: FormatQuoteOptions = {}): string | null {
  const maxChars = Math.max(1, opts.maxChars ?? QUOTE_MAX_CHARS);
  let body = normalizeSelection(raw);
  if (!body) return null;

  let note: string | null = null;
  if (body.length > maxChars) {
    const fullLength = body.length;
    body = body.slice(fullLength - maxChars);
    // Don't start mid-line when a line break is close to the cut point.
    const firstBreak = body.indexOf('\n');
    if (firstBreak >= 0 && firstBreak < 200 && firstBreak < body.length - 1) {
      body = body.slice(firstBreak + 1);
    }
    note = (opts.truncationNote ?? defaultTruncationNote)(fullLength - body.length);
  }

  const multiline = body.includes('\n') || note !== null;
  if (!multiline) return `> ${body}`;

  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return [note, `${fence}text`, body, fence].filter((x): x is string => x !== null).join('\n');
}

/**
 * Insert `quote` into a composer draft at the cursor (or at the end when no
 * selection is known), separating it from surrounding text with a blank line
 * and leaving the cursor on a fresh line after it so the user can type the
 * question right away. A selected range in the draft is replaced.
 */
export function insertQuoteIntoDraft(
  draft: string,
  quote: string,
  selection?: { start: number; end: number } | null,
): { text: string; cursor: number } {
  const len = draft.length;
  const from = selection ? Math.min(Math.max(selection.start, 0), len) : len;
  const to = selection ? Math.min(Math.max(selection.end, from), len) : len;
  const before = draft.slice(0, from);
  const after = draft.slice(to);

  const lead = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  // Always end with a blank line: it terminates a `>` blockquote and gives
  // the cursor its own line under a fenced block.
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const inserted = lead + quote + trail;
  const text = before + inserted + after;
  // Cursor sits on the empty line right after the quote.
  const cursor = before.length + lead.length + quote.length + 2;
  return { text, cursor: Math.min(cursor, text.length) };
}

export type QuoteSlot = { id: string; tab: string } | null;

/**
 * Pick the composer pane a quote should go to among the currently visible
 * slots: the most-recently-focused AI / Agent Chat pane wins, then the first
 * visible AI pane, then the first visible Agent Chat pane. Returns null when
 * none is visible (the caller then opens/focuses an AI pane).
 */
export function chooseQuoteTarget(
  visibleSlots: readonly QuoteSlot[],
  focusHistory: readonly string[],
): { paneId: string; tab: QuoteTargetTab } | null {
  const composers = visibleSlots.filter(
    (s): s is { id: string; tab: QuoteTargetTab } => !!s && (s.tab === 'ai' || s.tab === 'agent-chat'),
  );
  if (composers.length === 0) return null;
  for (const id of focusHistory) {
    const hit = composers.find((s) => s.id === id);
    if (hit) return { paneId: hit.id, tab: hit.tab };
  }
  const pick = composers.find((s) => s.tab === 'ai') ?? composers[0];
  return { paneId: pick.id, tab: pick.tab };
}

/** Slots actually on screen for a preset (respecting a maximized slot). */
export function visibleSlotsOf(
  slots: readonly QuoteSlot[],
  capacity: number,
  maximizedSlot: number | null,
): QuoteSlot[] {
  if (maximizedSlot !== null) return [slots[maximizedSlot] ?? null];
  return slots.slice(0, capacity);
}

/**
 * Side-effectful entry point used by TerminalPane's onQuoteSelection: formats
 * the selection, picks/focuses the target composer pane, and queues the quote
 * on pane-store for that pane's composer to claim. Returns the target tab, or
 * null when nothing was queued (empty selection / no pane could be opened).
 */
export function routeQuoteToAI(
  raw: string,
  deps: {
    getVisibleSlots: () => QuoteSlot[];
    getFocusHistory: () => readonly string[];
    focusPane: (paneId: string) => void;
    /** Opens/focuses an AI pane; returns its id or null on failure. */
    openAiPane: () => string | null;
    queue: (insert: { paneId: string; tab: QuoteTargetTab; text: string }) => void;
    truncationNote?: (omittedChars: number) => string;
  },
): QuoteTargetTab | null {
  const quote = formatQuoteBlock(raw, { truncationNote: deps.truncationNote });
  if (!quote) {
    logInfo('QuoteToAI', 'empty selection — nothing quoted');
    return null;
  }
  let target = chooseQuoteTarget(deps.getVisibleSlots(), deps.getFocusHistory());
  if (target) {
    deps.focusPane(target.paneId);
  } else {
    const paneId = deps.openAiPane();
    if (!paneId) {
      logInfo('QuoteToAI', 'no AI pane available — quote dropped');
      return null;
    }
    target = { paneId, tab: 'ai' };
  }
  deps.queue({ paneId: target.paneId, tab: target.tab, text: quote });
  logInfo('QuoteToAI', `queued ${quote.length} chars → ${target.tab}:${target.paneId}`);
  return target.tab;
}
