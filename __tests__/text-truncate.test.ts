/**
 * lib/text-truncate.ts's truncateAtCodePointBoundary().
 *
 * app/_layout.tsx's extractText alert preview used a plain
 * `text.length > 1000 ? `${text.slice(0, 1000)}…` : text` before this fix.
 * `String.prototype.slice` counts UTF-16 code units, not full characters,
 * so a character outside the Basic Multilingual Plane (emoji, some CJK
 * extension characters -- represented as a surrogate pair: a high
 * surrogate 0xD800-0xDBFF immediately followed by a low surrogate
 * 0xDC00-0xDFFF) landing right at the 1000-boundary could get split,
 * leaving a lone unpaired surrogate at the end of the truncated string.
 * Rendered via Alert.alert, an unpaired surrogate typically shows up as a
 * replacement-character glyph (mojibake) -- cosmetic, but real
 * (docs/superpowers/DEFERRED.md).
 */
import { truncateAtCodePointBoundary } from '@/lib/text-truncate';

// A lone high surrogate (0xD800-0xDBFF) or lone low surrogate
// (0xDC00-0xDFFF) at the very end of a string is the mojibake signature
// this fix exists to prevent.
function endsWithUnpairedSurrogate(s: string): boolean {
  if (s.length === 0) return false;
  const last = s.charCodeAt(s.length - 1);
  const isHigh = last >= 0xD800 && last <= 0xDBFF;
  const isLow = last >= 0xDC00 && last <= 0xDFFF;
  if (!isHigh && !isLow) return false;
  if (isLow) {
    // A low surrogate is only "paired" if immediately preceded by a high
    // surrogate.
    const prev = s.length >= 2 ? s.charCodeAt(s.length - 2) : 0;
    return !(prev >= 0xD800 && prev <= 0xDBFF);
  }
  // A trailing high surrogate is never paired (its partner would have to
  // come after it).
  return true;
}

describe('truncateAtCodePointBoundary', () => {
  it('never splits a surrogate pair that lands exactly at the truncation boundary', () => {
    // 999 ASCII chars + 😀 (U+1F600, a surrogate pair: high 0xD83D, low
    // 0xDE00) straddling indices 999/1000 + more filler past the boundary.
    const emoji = '\u{1F600}'; // 😀
    const text = 'a'.repeat(999) + emoji + 'b'.repeat(50);
    expect(text.length).toBeGreaterThan(1000);
    // Sanity-check the fixture actually exercises the split: the naive
    // slice(0, 1000) would keep only the emoji's high surrogate.
    expect(text.charCodeAt(999)).toBeGreaterThanOrEqual(0xD800);
    expect(text.charCodeAt(999)).toBeLessThanOrEqual(0xDBFF);

    const result = truncateAtCodePointBoundary(text, 1000);

    expect(result.endsWith('…')).toBe(true);
    const withoutEllipsis = result.slice(0, -1);
    expect(endsWithUnpairedSurrogate(withoutEllipsis)).toBe(false);
    // The lone high surrogate must have been dropped along with backing
    // off the cut, not kept dangling.
    expect(withoutEllipsis).toBe('a'.repeat(999));
    // Round-tripping through Array.from confirms every code point in the
    // result is well-formed (a lone surrogate would produce a U+FFFD
    // replacement character here).
    expect(Array.from(withoutEllipsis).join('')).not.toContain('�');
  });

  it('truncates a plain ASCII string over 1000 chars at exactly the same place as before', () => {
    const text = 'x'.repeat(1500);
    const result = truncateAtCodePointBoundary(text, 1000);
    expect(result).toBe(`${text.slice(0, 1000)}…`);
    expect(result).toBe(`${'x'.repeat(1000)}…`);
  });

  it('returns a string under the limit unchanged, with no ellipsis suffix', () => {
    const text = 'hello world';
    const result = truncateAtCodePointBoundary(text, 1000);
    expect(result).toBe(text);
    expect(result.endsWith('…')).toBe(false);
  });

  it('returns a string exactly at the limit unchanged (matches the `> maxLength` guard)', () => {
    const text = 'y'.repeat(1000);
    const result = truncateAtCodePointBoundary(text, 1000);
    expect(result).toBe(text);
  });
});
