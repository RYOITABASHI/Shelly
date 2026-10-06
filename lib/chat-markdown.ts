// lib/chat-markdown.ts
//
// Tiny, dependency-free markdown subset for AI pane assistant prose
// (2026-10-06 on-device QA: `**Fix:**` rendered with literal asterisks).
// Fenced code is split out earlier by CodeBlockWithAction's
// splitFencedCode(); this only handles the prose between fences:
//   - inline: **bold** / __bold__, *italic* / _italic_, `inline code`
//   - lines:  "- " / "* " / "+ " bullets, "1. " / "1) " ordered items,
//             "#".."######" headings (rendered bold)
// Anything that doesn't match stays verbatim, so a stray asterisk in
// ordinary text (e.g. `2 * 3`, snake_case_names) is left alone.

export type ChatSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string };

export type ChatLine =
  | { kind: 'para'; spans: ChatSpan[] }
  | { kind: 'heading'; level: number; spans: ChatSpan[] }
  | { kind: 'bullet'; indent: number; spans: ChatSpan[] }
  | { kind: 'ordered'; indent: number; marker: string; spans: ChatSpan[] };

// Order matters: code first (its contents are never re-parsed), then the
// double-delimiter bold forms before the single-delimiter italic forms.
// Italic requires a non-space char right inside both delimiters, and the
// underscore form additionally requires a non-word char (or edge) outside,
// so `snake_case_name` and `a * b * c` stay plain.
const INLINE_RE =
  /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/g;

export function parseChatInline(text: string): ChatSpan[] {
  const spans: ChatSpan[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    // The underscore-italic alternative captures its leading boundary char
    // (group 5) instead of using a lookbehind; keep that char as text.
    const start = m[6] !== undefined ? m.index + m[5].length : m.index;
    if (start > last) spans.push({ kind: 'text', text: text.slice(last, start) });
    if (m[1] !== undefined) spans.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) spans.push({ kind: 'bold', text: m[2] });
    else if (m[3] !== undefined) spans.push({ kind: 'bold', text: m[3] });
    else if (m[4] !== undefined) spans.push({ kind: 'italic', text: m[4] });
    else if (m[6] !== undefined) spans.push({ kind: 'italic', text: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) });
  return spans;
}

function indentLevel(ws: string): number {
  const width = ws.replace(/\t/g, '  ').length;
  return Math.min(3, Math.floor(width / 2));
}

export function parseChatMarkdown(text: string): ChatLine[] {
  return text.split('\n').map((raw): ChatLine => {
    const line = raw.replace(/\r$/, '');
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      return { kind: 'heading', level: heading[1].length, spans: parseChatInline(heading[2]) };
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      return { kind: 'bullet', indent: indentLevel(bullet[1]), spans: parseChatInline(bullet[2]) };
    }
    const ordered = /^(\s*)(\d{1,3})([.)])\s+(.*)$/.exec(line);
    if (ordered) {
      return {
        kind: 'ordered',
        indent: indentLevel(ordered[1]),
        marker: `${ordered[2]}${ordered[3]}`,
        spans: parseChatInline(ordered[4]),
      };
    }
    return { kind: 'para', spans: parseChatInline(line) };
  });
}
