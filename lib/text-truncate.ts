// Small text-truncation helpers. Split out of app/_layout.tsx so the
// surrogate-pair-safety logic can be unit tested directly -- _layout.tsx
// pulls in a large native-module dependency graph that isn't practical to
// import/render in Jest (see __tests__/app-layout-store-boot-init.test.ts).

// DEFERRED.md: "`.slice(0, 1000)`はサロゲートペア分断の可能性
// (絵文字末尾での文字化け、cosmetic)" -- `String.prototype.slice` counts
// UTF-16 code units, not full characters. A character outside the Basic
// Multilingual Plane (emoji, some CJK extension characters) is represented
// as a surrogate pair: a high surrogate (0xD800-0xDBFF) immediately
// followed by a low surrogate (0xDC00-0xDFFF). A naive
// `text.slice(0, maxLength)` can land the cut exactly between the two,
// leaving a lone unpaired surrogate at the end of the result, which
// typically renders as a replacement-character glyph (mojibake) instead of
// failing loudly.
/**
 * Truncates `text` to at most `maxLength` UTF-16 code units, appending an
 * ellipsis, without ever splitting a surrogate pair at the cut boundary.
 * Mirrors the plain
 * `text.length > maxLength ? `${text.slice(0, maxLength)}…` : text`
 * pattern used for preview truncation, but code-point-safe at the boundary.
 */
export function truncateAtCodePointBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  // The cut falls between code units at index `maxLength - 1` (kept) and
  // `maxLength` (dropped). If the kept code unit is a high surrogate, its
  // low-surrogate partner is the one being dropped -- back the cut off by
  // one more code unit so the lone high surrogate isn't kept either.
  const boundaryUnit = text.charCodeAt(maxLength - 1);
  const isHighSurrogate = boundaryUnit >= 0xD800 && boundaryUnit <= 0xDBFF;
  const cut = isHighSurrogate ? maxLength - 1 : maxLength;
  return `${text.slice(0, cut)}…`;
}
