// Expand `~` and `~/` prefixes to the Plan B home directory so shell
// commands that single-quote the path still work. Plan B is Termux-
// free and bash doesn't get a login shell, so ~ is never expanded.
const HOME = '/data/data/dev.shelly.terminal/files/home';

export function normalizePath(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return HOME + p.slice(1);
  return p;
}
