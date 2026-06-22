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
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(LATIN_TOKEN_RE)) {
    tokens.add(m[0]);
  }
  for (const run of text.matchAll(CJK_RUN_RE)) {
    const s = run[0];
    if (s.length === 1) {
      tokens.add(s);
      continue;
    }
    for (let i = 0; i < s.length - 1; i++) {
      tokens.add(s.slice(i, i + 2));
    }
  }
  return tokens;
}
