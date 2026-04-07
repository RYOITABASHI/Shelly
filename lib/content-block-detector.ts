export type ContentType = 'plain' | 'markdown' | 'json' | 'image' | 'table' | 'diff';

export function detectContentType(command: string, output: string): ContentType {
  const trimmed = output.trim();
  if (!trimmed) return 'plain';

  // Diff: starts with --- or diff --git
  if (/^(---|\+\+\+|diff --git|@@)/m.test(trimmed)) return 'diff';

  // JSON: starts with { or [, validate with try/catch
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {}
  }

  // Image: command outputs image paths
  if (/\.(png|jpe?g|gif|svg|webp|bmp|ico)(\s|$)/im.test(trimmed)) return 'image';

  // Markdown: cat *.md, or contains headings + formatting
  if (/\.md$/i.test(command.split(/\s+/).pop() ?? '')) return 'markdown';
  const mdSignals = [/^#{1,3}\s/m, /\*\*\w/, /^[-*]\s/m, /^\d+\.\s/m].filter(
    (r) => r.test(trimmed)
  );
  if (mdSignals.length >= 2) return 'markdown';

  // Table: lines with consistent pipe separators
  const lines = trimmed.split('\n').filter((l) => l.trim());
  if (lines.length >= 3) {
    const pipeCounts = lines.map((l) => (l.match(/\|/g) || []).length);
    if (pipeCounts[0] >= 2 && pipeCounts.every((c) => c === pipeCounts[0]))
      return 'table';
  }

  return 'plain';
}
