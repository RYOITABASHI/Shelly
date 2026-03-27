/**
 * Detects localhost URLs in terminal output (with ANSI codes stripped).
 * Used by use-terminal-output to trigger preview offers.
 */

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

const LOCALHOST_PATTERNS = [
  /https?:\/\/localhost:\d{2,5}\b[^\s)}\]'"<]*/,
  /https?:\/\/127\.0\.0\.1:\d{2,5}\b[^\s)}\]'"<]*/,
  /https?:\/\/0\.0\.0\.0:\d{2,5}\b[^\s)}\]'"<]*/,
  /https?:\/\/\[::\]:\d{2,5}\b[^\s)}\]'"<]*/,
];

/**
 * Detect a localhost URL in raw terminal output text.
 * Strips ANSI escape codes before matching.
 * Normalizes 0.0.0.0 and [::] to localhost.
 * Returns the first matched URL or null.
 */
export function detectLocalhostUrl(rawText: string): string | null {
  const text = rawText.replace(ANSI_REGEX, '');

  for (const pattern of LOCALHOST_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      let url = match[0];
      // Normalize to localhost
      url = url.replace('0.0.0.0', 'localhost');
      url = url.replace('[::]', 'localhost');
      url = url.replace('127.0.0.1', 'localhost');
      return url;
    }
  }

  return null;
}
