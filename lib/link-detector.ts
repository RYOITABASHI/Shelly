/**
 * Detects clickable links (URLs and file paths) in terminal output text.
 */

export type DetectedLink = {
  text: string;
  type: 'url' | 'filepath';
  start: number;
  end: number;
};

// URL pattern: http(s)://... or www.... Case-insensitive: a URL echoed back
// in upper/mixed case (common for shell-scripted output, e.g. `echo
// "HTTPS://EXAMPLE.COM/PATH"`) is just as clickable as a lowercase one — the
// scheme/host are case-insensitive per RFC 3986, and this bare pattern-match
// step doesn't care about the path's case either.
const URL_REGEX = /https?:\/\/[^\s<>"')\]},;]+|www\.[^\s<>"')\]},;]+/gi;

// File path pattern: /path/to/file or ./relative/path (with extension)
const PATH_REGEX = /(?:\/[\w.-]+){2,}(?:\.\w{1,10})?|\.\/[\w./-]+/g;

/**
 * Find all URLs and file paths in a text line.
 */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  const seen = new Set<string>();

  // URLs
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const key = `${match.index}-${match[0]}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({
        text: match[0],
        type: 'url',
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // File paths (only if no URL overlap)
  PATH_REGEX.lastIndex = 0;
  while ((match = PATH_REGEX.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const overlaps = links.some((l) => start >= l.start && start < l.end);
    if (!overlaps) {
      const key = `${start}-${match[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({
          text: match[0],
          type: 'filepath',
          start,
          end,
        });
      }
    }
  }

  return links.sort((a, b) => a.start - b.start);
}

/**
 * Split text into segments: plain text and linked text.
 */
export type TextSegment = {
  text: string;
  link?: DetectedLink;
};

export function segmentText(text: string): TextSegment[] {
  const links = detectLinks(text);
  if (links.length === 0) return [{ text }];

  const segments: TextSegment[] = [];
  let pos = 0;

  for (const link of links) {
    if (link.start > pos) {
      segments.push({ text: text.slice(pos, link.start) });
    }
    segments.push({ text: link.text, link });
    pos = link.end;
  }

  if (pos < text.length) {
    segments.push({ text: text.slice(pos) });
  }

  return segments;
}
