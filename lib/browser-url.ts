/**
 * lib/browser-url.ts — URL-bar input normalization and "is this URL safe to
 * restore / persist" checks for components/panes/BrowserPane.tsx and
 * store/browser-store.ts.
 *
 * 2026-10-09 on-device finding (build 2495, Case File, Fold6 2x2): a
 * malformed URL (a local markdown path glued onto a host, rendered as
 * `…md%20~/hw/ry_md_test.md/?locale=ja`) got persisted as the Browser
 * Pane's lastOpenedUrl. Every cold start restored it, the load failed with
 * net::ERR_NAME_NOT_RESOLVED, and the pane was wedged on that error page.
 * isRestorableBrowserUrl() is the gate applied both when recording and when
 * restoring, so a broken value can never be written or brought back.
 */

const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
// LDH hostname labels (IDN hosts arrive punycoded from URL()).
const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** True when `host` (URL.hostname) is a plausible, resolvable host name. */
export function isPlausibleHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (host.startsWith('[') && host.endsWith(']')) return true; // IPv6 literal
  if (IPV4_RE.test(host)) return true;
  if (host.includes('%') || host.includes('~')) return false;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => HOST_LABEL_RE.test(l))) return false;
  // TLD must not be all-numeric.
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/**
 * Whether `url` may be persisted as / restored from lastOpenedUrl: an
 * absolute http(s) URL with a plausible host, no whitespace, and no
 * credentials. Anything else (about:, file:, javascript:, a local file path
 * mangled into a URL, a bare search string) is rejected.
 */
export function isRestorableBrowserUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed !== url || /\s/.test(trimmed)) return false;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const parsed = parseUrl(trimmed);
  if (!parsed) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return isPlausibleHost(parsed.hostname);
}

function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Turn URL-bar text into something to load:
 *  - empty → 'about:blank'
 *  - already-schemed http(s)/about/etc. URL → as-is (http(s) only if parseable)
 *  - `host.tld[/path]` / `localhost:3000` / an IP → https:// (http:// for
 *    localhost and IPs, matching what dev servers speak)
 *  - anything else (spaces, local paths like `~/notes.md`, a single word)
 *    → a web search, never a fake host that will just fail DNS.
 */
export function normalizeBrowserInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'about:blank';

  if (/^https?:\/\//i.test(trimmed)) {
    return parseUrl(trimmed) && !/\s/.test(trimmed) ? trimmed : searchUrl(trimmed);
  }
  if (/^about:/i.test(trimmed)) return trimmed;
  // Local filesystem paths are never web hosts.
  if (/^(~|\/|\.\.?\/)/.test(trimmed)) return searchUrl(trimmed);
  if (/\s/.test(trimmed)) return searchUrl(trimmed);

  // `localhost:3000`, `127.0.0.1:8080/x`, `example.com/path`.
  if (SCHEME_RE.test(trimmed) && !/^[^/:]+:\d+(\/|$)/.test(trimmed)) {
    // Some other scheme (mailto:, intent:, javascript:) — don't load it,
    // treat as search text.
    return searchUrl(trimmed);
  }
  const hostPart = trimmed.split(/[/?#]/, 1)[0].replace(/:\d+$/, '').toLowerCase();
  const isLocal = hostPart === 'localhost' || IPV4_RE.test(hostPart);
  if (isLocal || isPlausibleHost(hostPart)) {
    const candidate = `${isLocal ? 'http' : 'https'}://${trimmed}`;
    if (parseUrl(candidate)) return candidate;
  }
  return searchUrl(trimmed);
}
