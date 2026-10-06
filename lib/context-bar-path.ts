/**
 * Path display helpers for components/layout/ContextBar.tsx.
 *
 * Android bind-mounts app-private storage under two path aliases for the
 * same directory: /data/data/<pkg> and /data/user/0/<pkg>. Different native
 * code paths in this app report cwd/home using different aliases (PTY-reported
 * cwd uses /data/data, TerminalEmulator.getHomeDir() uses /data/user/0), so a
 * plain string comparison between them can spuriously mismatch even when both
 * actually refer to the same directory. Normalize both known prefixes to a
 * common form before comparing.
 */
export function canonicalizeAndroidDataPath(path: string): string {
  return path
    .replace(/^\/data\/user\/0\/dev\.shelly\.terminal(?=\/|$)/, '/__shelly_data__')
    .replace(/^\/data\/data\/dev\.shelly\.terminal(?=\/|$)/, '/__shelly_data__');
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** `~`-relative display form of `path` when it is (inside) `home`, matching
 *  either Android data-dir alias. Otherwise the path unchanged. */
export function tildifyPath(path: string, home: string): string {
  if (!path) return '~';
  if (!home) return path;
  const p = stripTrailingSlash(canonicalizeAndroidDataPath(path));
  const h = stripTrailingSlash(canonicalizeAndroidDataPath(home));
  if (p === h) return '~';
  if (p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return path;
}

/** Display form for the ContextBar cwd segment: `~`-relative, then
 *  left-truncated with a single ellipsis glyph when still too long. */
export function formatContextBarPath(path: string, home: string, maxLen = 30): string {
  const short = tildifyPath(path, home);
  if (short.length <= maxLen) return short;
  return '\u2026' + short.slice(short.length - maxLen + 1);
}
