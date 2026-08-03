/**
 * lib/agent-text-match.ts — offline tokenizer shared by memory recall (G2) and
 * skill matching (G3).
 *
 * Whitespace tokenization works for Latin text but collapses Japanese/Chinese
 * into one giant token (CJK has no word spaces), so JP task↔skill / task↔memory
 * overlap silently scored 0 and reuse/recall never fired for Japanese. We add
 * overlapping CJK character bigrams, which give robust offline similarity for
 * Japanese without a morphological analyzer, while keeping Latin word tokens.
 */

// Hiragana + Katakana (U+3040–30FF), CJK ideographs (U+4E00–9FFF), iteration
// marks. A run of these has no internal delimiter, so we 2-gram it.
const CJK_RUN_RE = /[぀-ヿ㐀-䶿一-鿿々〆]+/g;
const LATIN_TOKEN_RE = /[a-z0-9]{2,}/g;

/**
 * Tokenize text for fuzzy overlap scoring. Returns Latin/digit word tokens
 * (length ≥ 2) plus CJK character bigrams (single CJK chars kept as-is).
 */
export function tokenizeForMatch(text: string): Set<string> {
  return new Set(tokenizeToList(text));
}

/** Same token stream as tokenizeForMatch, but as an ordered list (duplicates
 *  kept) rather than a Set — the raw material BM25-style term-frequency
 *  scoring needs (lib/agent-memory.ts) and tokenizeForMatch's Set return
 *  can't provide, since a Set collapses repeat mentions to one entry. Kept as
 *  a private helper both tokenize functions share, so the token rules
 *  themselves (the two regexes above) stay defined in exactly one place. */
function tokenizeToList(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(LATIN_TOKEN_RE)) {
    tokens.push(m[0]);
  }
  for (const run of text.matchAll(CJK_RUN_RE)) {
    const s = run[0];
    if (s.length === 1) {
      tokens.push(s);
      continue;
    }
    for (let i = 0; i < s.length - 1; i++) {
      tokens.push(s.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Term-frequency map for BM25-style scoring (lib/agent-memory.ts's
 *  recallMemoryNotes). Same token rules as tokenizeForMatch, but counts
 *  repeats instead of collapsing them — BM25's tf(t, D) term needs how many
 *  times a token appears in a document, not just whether it appears. */
export function tokenizeWithCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tok of tokenizeToList(text)) {
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return counts;
}
