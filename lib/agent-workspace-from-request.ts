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

/**
 * Non-dot top-level home entries that hold Shelly's own runtime / state
 * (HomeInitializer.kt, lib/agent-executor.ts, scripts/shelly-plan-executor.js):
 * `bin` (PATH wrappers), `lib` / `usr` / `etc` (unpacked trees), `models`
 * (local LLM weights), `storage` (shared-storage links), `shelly-*` (runtime
 * canaries), `app-server-control*` (Codex app-server control). Writes there
 * are hard under the "all" level. As a derived WORKSPACE also refused:
 * `tmp` (scratch of every run) and `agent-output` (all agents' results).
 */
const RUNTIME_TOP_DIRS = new Set(['bin', 'lib', 'usr', 'etc', 'models', 'storage', 'node_modules']);
const DERIVE_ONLY_TOP_DIRS = new Set(['tmp', 'agent-output']);
const RUNTIME_TOP_PREFIX_RE = /^(?:shelly-|app-server-control)/;

export function isShellyRuntimeHomeEntry(top: string, mode: 'all' | 'derive'): boolean {
  if (RUNTIME_TOP_DIRS.has(top) || RUNTIME_TOP_PREFIX_RE.test(top)) return true;
  return mode === 'derive' && DERIVE_ONLY_TOP_DIRS.has(top);
}

const CONTROL_TOP_DIRS = { has: (top: string) => isShellyRuntimeHomeEntry(top, 'derive') };

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

function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Security review M3: a shell script (POSIX sh) that refuses the workspace
 * when any EXISTING component from the home down to it is a symlink
 * (`[ -L ]`, i.e. lstat), optionally creates it, and prints the physical
 * paths of the home and the workspace:
 *   `OK <home-realpath> <workspace-realpath>` / `MISSING <home-realpath>` /
 *   `REFUSE <reason>`.
 * `create: false` is the read-only pre-check run before the confirm text is
 * shown; `create: true` runs on confirm (mkdir -p, then the realpath is
 * re-validated by parseWorkspacePrepareOutput).
 */
export function buildWorkspacePrepareCommand(abs: string, home: string, create: boolean): string {
  const h = home.replace(/\/+$/, '');
  const rel = abs.startsWith(`${h}/`) ? abs.slice(h.length + 1) : '';
  return [
    `h=${shQuote(h)}; t=${shQuote(abs)}; rel=${shQuote(rel)}`,
    '[ -n "$rel" ] || { echo "REFUSE not-under-home"; exit 0; }',
    'hr=$(cd "$h" 2>/dev/null && pwd -P) || { echo "REFUSE no-home"; exit 0; }',
    'p="$h"; oldifs=$IFS; IFS=/',
    'for c in $rel; do p="$p/$c"; if [ -L "$p" ]; then IFS=$oldifs; echo "REFUSE symlink"; exit 0; fi; done',
    'IFS=$oldifs',
    create ? 'mkdir -p -- "$t" || { echo "REFUSE mkdir-failed"; exit 0; }' : '[ -d "$t" ] || { echo "MISSING $hr"; exit 0; }',
    'r=$(cd "$t" 2>/dev/null && pwd -P) || { echo "REFUSE unreadable"; exit 0; }',
    'echo "OK $hr $r"',
  ].join('\n');
}

export type WorkspacePrepareResult = { ok: true; realPath: string | null } | { ok: false; reason: string };

/** Parse buildWorkspacePrepareCommand's output: OK only when the physical
 *  workspace is still under the physical home and its home-relative part
 *  passes the same rules as the derivation. */
export function parseWorkspacePrepareOutput(output: string): WorkspacePrepareResult {
  const line = String(output ?? '').trim().split('\n').pop() ?? '';
  const missing = /^MISSING (\/\S*)$/.exec(line);
  if (missing) return { ok: true, realPath: null };
  const m = /^OK (\/\S*) (\/\S*)$/.exec(line);
  if (!m) {
    const refuse = /^REFUSE (\S+)/.exec(line);
    return { ok: false, reason: refuse ? refuse[1] : 'unexpected-output' };
  }
  const [, hr, r] = m;
  if (!r.startsWith(`${hr}/`)) return { ok: false, reason: 'outside-home' };
  const comps = r.slice(hr.length + 1).split('/').filter(Boolean);
  if (comps.length === 0) return { ok: false, reason: 'home-root' };
  if (comps.some((c) => c.startsWith('.')) || CONTROL_TOP_DIRS.has(comps[0])) return { ok: false, reason: 'control-dir' };
  return { ok: true, realPath: r };
}
