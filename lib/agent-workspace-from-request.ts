/**
 * lib/agent-workspace-from-request.ts — the CLI workspace an NL-created agent
 * runs in, derived from the paths its request names (product owner request
 * 2026-11-01, on-device rehearsal build 2772).
 *
 * Why: an agent without `workspaceRoot` runs its CLI workers (Codex / Claude
 * Code) in the default content project (~/projects/shelly-content-studio).
 * A request like "build ~/demo/codex.html with Codex and ~/demo/claude.html
 * with Claude Code" then makes every touch of ~/demo a `leaves-root`
 * escalation — the user had to approve 7 of them. When the request's paths
 * all live under one directory inside the Shelly home, that directory
 * becomes the agent's workspaceRoot: lib/agent-plan-spec.ts passes it as
 * `cliWorker.cwd` (parallel executor), lib/agent-executor.ts as
 * AGENT_WORKSPACE_ROOT → DRIVER_CWD (serial chain), and the driver re-anchors
 * the gate's AutonomyPolicy.workspaceRoot to that cwd.
 *
 * Rules (pure, deterministic):
 *   - only `~/…`, `$HOME/…` / `${HOME}/…` or absolute paths under the app
 *     home count; every other path (/sdcard, /tmp, URLs) is ignored;
 *   - a path whose last component has a file extension names a file → its
 *     directory; a trailing `/` or no extension names a directory;
 *   - any dot component (~/.shelly*, ~/.ssh, ~/.config, `..` …) or a Shelly
 *     control dir (~/bin) anywhere → no workspace at all (fail closed);
 *   - several paths → their deepest common directory, unless that is the
 *     home itself (then none);
 *   - an explicit "workspace ~/x" / 「ワークスペースは ~/x」 / "project dir ~/x"
 *     wins over the derived one;
 *   - the result must pass validateWorkspaceRoot (never $HOME, /sdcard, a
 *     .shelly / .codex / .ssh ancestor).
 * The result is home-relative (`~/demo`) for display; the dispatcher resolves
 * it to an absolute path (resolveWorkspaceRootForHome) before createAgent,
 * because the generated run script single-quotes AGENT_WORKSPACE_ROOT (no
 * tilde expansion) and both executors fall back to $HOME for a directory
 * that does not exist.
 */
import { validateWorkspaceRoot } from '@/lib/agent-boundary-policy';

/** App-home spellings known without asking native (Android's alias pair). */
export const KNOWN_APP_HOME_PATHS = [
  '/data/user/0/dev.shelly.terminal/files/home',
  '/data/data/dev.shelly.terminal/files/home',
] as const;

/** Non-dot top-level home directories that hold Shelly's own runtime. */
const CONTROL_TOP_DIRS = new Set(['bin']);

const PATH_CHARS = '[A-Za-z0-9._@+\\-/]';
const FILE_EXT_RE = /^[^.].*\.[A-Za-z0-9]{1,10}$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fenced code blocks and blockquoted lines are pasted content, not the
 *  user's own reference to where the work happens. */
function ownText(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

function pathRegex(homePaths: readonly string[]): RegExp {
  const homes = homePaths.filter(Boolean).map((h) => escapeRe(h.replace(/\/+$/, '')));
  const absolute = homes.length > 0 ? `|(?:${homes.join('|')})(?=/|$|[^A-Za-z0-9._@+\\-])` : '';
  // Not preceded by a path / word char, so `foo~/x`, `https://x/~/y` and
  // `a/b` (relative) do not start a match.
  // Group 1 = the preceding char (no lookbehind, for older JS engines),
  // group 2 = the home anchor, group 3 = the rest of the path.
  return new RegExp(`(^|[^A-Za-z0-9._@+\\-/~$:])((?:~|\\$HOME|\\$\\{HOME\\})(?=/|$|[^A-Za-z0-9._@+\\-])${absolute})(${PATH_CHARS}*)`, 'g');
}

type PathRef = { comps: string[]; isDir: boolean };

/** Home-relative components of one matched path, or 'unsafe'. */
function toRef(rest: string, forceDir: boolean): PathRef | 'unsafe' {
  const trimmed = rest.replace(/[.,]+$/, '');
  if (trimmed && !trimmed.startsWith('/')) return { comps: [], isDir: true };
  const trailingSlash = /\/$/.test(trimmed);
  const comps = trimmed.split('/').filter(Boolean);
  if (comps.some((c) => c.startsWith('.'))) return 'unsafe';
  if (comps.length > 0 && CONTROL_TOP_DIRS.has(comps[0])) return 'unsafe';
  const last = comps[comps.length - 1];
  const isDir = forceDir || trailingSlash || !last || !FILE_EXT_RE.test(last);
  return { comps, isDir };
}

function dirOf(ref: PathRef): string[] {
  return ref.isDir ? ref.comps : ref.comps.slice(0, -1);
}

function commonPrefix(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const c = lists[0][i];
    if (c === undefined || lists.some((l) => l[i] !== c)) return out;
    out.push(c);
  }
}

const EXPLICIT_MARKER_RE =
  /(?:\bworkspace(?:\s+(?:dir(?:ectory)?|folder|root))?|\bproject\s+(?:dir(?:ectory)?|folder|root)|\bwork(?:ing)?\s+(?:dir(?:ectory)?|folder)|ワークスペース|プロジェクト(?:フォルダ|ディレクトリ)|作業(?:フォルダ|ディレクトリ))\s*(?:is|=|:|：|は|を|に)?\s*(?:at\s+|in\s+)?$/i;

/**
 * `~/demo` (home-relative, for display) or null. See the module doc for the
 * rules. `homePaths` are the absolute spellings of the app home accepted as
 * well as `~`.
 */
export function deriveWorkspaceRootFromText(
  text: string | null | undefined,
  homePaths: readonly string[] = KNOWN_APP_HOME_PATHS,
): string | null {
  const src = ownText(String(text ?? ''));
  if (!src.trim()) return null;
  const re = pathRegex(homePaths);
  const refs: PathRef[] = [];
  let explicit: PathRef | null = null;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index + (m[1] ?? '').length;
    const before = src.slice(Math.max(0, start - 40), start);
    const isExplicit = EXPLICIT_MARKER_RE.test(before);
    const ref = toRef(m[3] ?? '', isExplicit);
    if (ref === 'unsafe') return null;
    if (isExplicit && !explicit) explicit = ref;
    refs.push(ref);
  }
  const chosen = explicit ? explicit.comps : commonPrefix(refs.map(dirOf));
  if (refs.length === 0 || chosen.length === 0) return null;
  const rel = `~/${chosen.join('/')}`;
  if (!validateWorkspaceRoot(rel, [...homePaths]).ok) return null;
  return rel;
}

/**
 * `~/demo` → `<home>/demo`, validated against every home spelling; null when
 * it is not a home-relative workspace or fails validateWorkspaceRoot.
 */
export function resolveWorkspaceRootForHome(
  rel: string | null | undefined,
  home: string,
  homePaths: readonly string[] = KNOWN_APP_HOME_PATHS,
): string | null {
  const r = String(rel ?? '').trim();
  const h = String(home ?? '').trim().replace(/\/+$/, '');
  if (!r || !h.startsWith('/')) return null;
  const m = /^~\/(.+)$/.exec(r);
  if (!m) return null;
  const comps = m[1].split('/').filter(Boolean);
  if (comps.length === 0 || comps.some((c) => c.startsWith('.')) || CONTROL_TOP_DIRS.has(comps[0])) return null;
  const abs = `${h}/${comps.join('/')}`;
  if (!validateWorkspaceRoot(abs, [h, ...homePaths]).ok) return null;
  return abs;
}
