/**
 * lib/markdown-plain.ts — flatten markdown into a single readable line.
 *
 * Used for short previews (e.g. the AI pane's agent run completion notice)
 * where the raw run output is markdown ("# Title\n\n### 1. Item **bold**")
 * but the bubble renders plain text, so syntax markers leaked verbatim.
 * The full document stays one tap away via the notice's Open link.
 */
export function markdownToPlainPreview(input: string): string {
  if (!input) return '';
  let s = input.replace(/\r\n?/g, '\n');
  // Fenced code markers (keep the code text itself).
  s = s.replace(/^\s*(```|~~~)[^\n]*$/gm, '');
  // Horizontal rules.
  s = s.replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '');
  // Line-leading block markers: headings, blockquotes, bullets.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/\s+#+\s*$/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '');
  // Images / links -> their visible text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Emphasis / strike / inline code markers.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  s = s.replace(/`([^`\n]*)`/g, '$1');
  // Table pipes.
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  s = s.replace(/\s*\|\s*/g, ' ');
  // Collapse all whitespace (newlines included) to single spaces.
  return s.replace(/\s+/g, ' ').trim();
}
