// Path normalization for the Plan B Shelly shell. The HOME directory
// itself lives in lib/home-path.ts (single source of truth — bug #73);
// this module just rewrites tilde-prefixed and Termux-legacy paths onto
// it, so the rest of the codebase never has to think about either.

import { getHomePath } from '@/lib/home-path';

// Re-exported so the eager init call in app/_layout.tsx can be written
// as `import { ensureHomeDir } from '@/lib/normalize-path'`.
export { initHomePath as ensureHomeDir } from '@/lib/home-path';

// Termux-era paths that users may paste in from old notes / docs. They
// look like real paths but Plan B has no Termux mount, so rewrite them
// onto the Shelly HOME instead of letting them fail silently.
const TERMUX_HOME_PREFIX = '/data/data/com.termux/files/home';

export function normalizePath(p: string): string {
  const h = getHomePath();
  if (p === '~') return h;
  if (p.startsWith('~/')) return h + p.slice(1);
  if (p === TERMUX_HOME_PREFIX) return h;
  if (p.startsWith(TERMUX_HOME_PREFIX + '/')) return h + p.slice(TERMUX_HOME_PREFIX.length);
  return p;
}
