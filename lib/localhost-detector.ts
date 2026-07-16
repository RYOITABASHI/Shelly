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
      if (isInternalNonPreviewUrl(url)) return null;
      // Normalize to localhost
      url = url.replace('0.0.0.0', 'localhost');
      url = url.replace('[::]', 'localhost');
      url = url.replace('127.0.0.1', 'localhost');
      return url;
    }
  }

  return null;
}

// POST-only JSON API paths (local LLM servers, etc.) that a WebView can never
// successfully GET-load — even when the server behind them is perfectly
// healthy, the server rejects a bare GET with a non-2xx status, and the
// generic preview WebView (components/preview/WebTab.tsx) treats any
// onError/onHttpError identically, showing a misleading "Cannot connect to
// <url>" message. A user or agent manually curl-testing e.g.
// `http://127.0.0.1:8080/v1/chat/completions` in the terminal would have that
// exact URL echoed back into PTY output and auto-offered as a "preview" by
// this detector — which then always "fails" regardless of server health.
// Filter these out at the source instead of only fixing the WebView's error
// copy, since the mismatch (browsable page vs. POST-only API) exists for any
// caller of detectLocalhostUrl, not just WebTab.
const NON_BROWSABLE_API_PATH_PATTERNS = [
  /\/v1\/chat\/completions\b/, // OpenAI-compatible (llama-server, Cerebras, Groq, ...)
  /\/v1\/completions\b/,
  /\/v1\/embeddings\b/,
  /\/api\/chat\b/, // Ollama
  /\/api\/generate\b/, // Ollama
];

function isInternalNonPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/hook/')) return true;
    return NON_BROWSABLE_API_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname));
  } catch {
    if (url.includes('/hook/')) return true;
    return NON_BROWSABLE_API_PATH_PATTERNS.some((pattern) => pattern.test(url));
  }
}
