/**
 * lib/terminal-link-detector.ts — Detect clickable links in terminal output
 *
 * Finds URLs, file paths, and error locations (file:line:col) in text.
 * Used by use-terminal-output.ts to create actionable links.
 */

// ─── Patterns ──────────────────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g;
const FILE_PATH_PATTERN = /(?:^|\s)((?:\/|\.\/|~\/)[^\s:]+\.[a-zA-Z0-9]+)/g;
const ERROR_LOCATION_PATTERN = /([^\s:]+):(\d+):(\d+)/g;

// ─── Types ─────────────────────────────────────────────────────────────────

export type TerminalLinkType = 'url' | 'file' | 'error-location';

export type TerminalLink = {
  text: string;
  type: TerminalLinkType;
  line?: number;
  col?: number;
};

// ─── Detection ─────────────────────────────────────────────────────────────

export function detectLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  const seen = new Set<string>();

  // URLs
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?)]+$/, ''); // trim trailing punctuation
    if (!seen.has(url) && url.length <= 2048) {
      links.push({ text: url, type: 'url' });
      seen.add(url);
    }
  }

  // File paths (only if not already captured as URL)
  FILE_PATH_PATTERN.lastIndex = 0;
  while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
    const path = match[1];
    if (!seen.has(path)) {
      links.push({ text: path, type: 'file' });
      seen.add(path);
    }
  }

  // Error locations (file:line:col)
  ERROR_LOCATION_PATTERN.lastIndex = 0;
  while ((match = ERROR_LOCATION_PATTERN.exec(text)) !== null) {
    const filePath = match[1];
    const line = parseInt(match[2], 10);
    const col = parseInt(match[3], 10);
    const key = `${filePath}:${line}:${col}`;
    if (!seen.has(key) && !filePath.startsWith('http')) {
      links.push({ text: filePath, type: 'error-location', line, col });
      seen.add(key);
    }
  }

  return links;
}

/**
 * Check if a line contains any URL (not just localhost).
 * More permissive than the localhost detector.
 */
export function containsUrl(text: string): boolean {
  return URL_PATTERN.test(text);
}
