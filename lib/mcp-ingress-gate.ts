/**
 * lib/mcp-ingress-gate.ts — the agent gate applied to MCP exec/write calls
 * (lib/mcp-server-bridge.ts run_command / write_file).
 *
 * A request that arrives over MCP is untrusted input: the peer may be acting
 * on mail or a web page it read. So it is judged exactly as a CLI worker's
 * proposed command is (lib/agent-policy.ts decideAutoAnswer →
 * lib/agent-boundary-policy.ts classifyProposedCommand), with the WIDE
 * agents-dir / shared_prefs hard-deny (strictPolicyPaths) and the POLICY-001
 * user rules always on, and with an origin that reads as proactive. Only the
 * DENY half of the verdict is used here: a deny is refused without asking;
 * allow and gray both still need the on-device approval tap (a gate allow
 * never skips it). This is a lexical, best-effort judgement of the command
 * string; the tap remains the control for everything it does not deny.
 * DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」.
 */
import { decideAutoAnswer, DEFAULT_POLICY, type GateOutcome } from '@/lib/agent-policy';
import { normalizePath } from '@/lib/agent-boundary-policy';
import type { LoadedUserPolicy } from '@/lib/agent-user-policy-store';

/** Not a RunOrigin, so normalizeRunOrigin reads it as unknown = proactive. */
export const MCP_RUN_ORIGIN = 'mcp';

/** The MCP queue holds other calls' requests/results and the signed snapshot. */
const MCP_QUEUE_RE = /\.shelly-mcp-queue\b/;

/**
 * The gate sees the app home under a neutral stand-in. The real home,
 * /data/user/0/dev.shelly.terminal/files/home, has ".shelly" in the package
 * name, and the strict agents-dir check (touchesAgentsConfigDir matches
 * `.shelly` as a word) would then refuse every write or cwd that also
 * mentions "agents" or policy.json. Only the prefix is replaced, so the
 * protected names under it (…/.shelly/agents/…) keep their meaning, and
 * paths inside the home stay "in root" for the boundary signals.
 */
export const GATE_HOME = '/home/user';

/** The home dir and its /data/user/0 ↔ /data/data alias, longest first. */
function homeAliases(homeDir: string): string[] {
  const h = homeDir.replace(/\/+$/, '');
  if (!h.startsWith('/') || h === '') return [];
  const out = new Set([h]);
  const user0 = /^\/data\/user\/0\/(.+)$/.exec(h);
  const data = /^\/data\/data\/(.+)$/.exec(h);
  if (user0) out.add(`/data/data/${user0[1]}`);
  if (data) out.add(`/data/user/0/${data[1]}`);
  return [...out].sort((a, b) => b.length - a.length);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace the home prefix (any alias) with GATE_HOME wherever it starts a path. */
export function mapHomeForGate(text: string, homeDir: string): string {
  let out = text;
  for (const alias of homeAliases(homeDir)) {
    out = out.replace(new RegExp(`${escapeRe(alias)}(?=[/'"\\s;&|)]|$)`, 'g'), GATE_HOME);
  }
  return out;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A path as a shell word: bare when it only has plain characters, else quoted.
 *  (A quoted `cd` target reads as an unknown destination to the gate.) */
export function plainOrQuoted(path: string): string {
  return /^[A-Za-z0-9._/+-]+$/.test(path) ? path : shellQuote(path);
}

export interface McpGateResult {
  /** true when the call must be refused without showing the approval modal. */
  refused: boolean;
  /** One line for the error / modal: decision, reason and signals. */
  summary: string;
  outcome: GateOutcome | null;
}

function describe(outcome: GateOutcome): string {
  const v = outcome.verdict;
  const signals = v.signals.length ? ` [${v.signals.join(', ')}]` : '';
  return `${v.decision}: ${v.reason}${signals}`;
}

/**
 * Judge one shell command as the gate would for a CLI worker. `homeDir` is
 * the bare (no file://) app home; inside `command` it is replaced with
 * GATE_HOME, which is the workspace root, so boundary signals (leaves-root,
 * secret-read, …) show up in the modal.
 */
export function evaluateMcpCommand(command: string, homeDir: string, policy: LoadedUserPolicy | null): McpGateResult {
  if (MCP_QUEUE_RE.test(command)) {
    return { refused: true, summary: 'deny: names the MCP request queue (.shelly-mcp-queue)', outcome: null };
  }
  const outcome = decideAutoAnswer(mapHomeForGate(command, homeDir), {
    ...DEFAULT_POLICY,
    level: 'L2',
    workspaceRoot: GATE_HOME,
    unattended: false,
    actionPolicy: {
      enabled: true,
      origin: MCP_RUN_ORIGIN,
      rules: policy?.data.rules ?? [],
      homeDir: GATE_HOME,
      // Cold cache or a policy file that fails its seal: escalate side
      // effects (never a deny on its own, so the tap still decides).
      rulesUnavailable: !policy || policy.unavailable,
    },
  });
  return { refused: outcome.verdict.decision === 'deny', summary: describe(outcome), outcome };
}

/** The gate string for running `command` in `cwd` (as the bridge runs it). */
export function gateCommandWithCwd(command: string, cwd: string | undefined, homeDir: string): string {
  if (!cwd) return command;
  return `cd ${plainOrQuoted(mapHomeForGate(cwd, homeDir))} && ${command}`;
}

/** The gate string for writing `path`: the worker equivalent `tee -- <path>`. */
export function gateWriteCommand(path: string, homeDir: string): string {
  return `tee -- ${plainOrQuoted(mapHomeForGate(path, homeDir))}`;
}

/** Runs a shell snippet and resolves its stdout (execCommand in production). */
export type McpShellRunner = (script: string) => Promise<{ stdout: string; exitCode: number }>;

export type WriteTargetResult = { ok: true; realPath: string } | { ok: false; error: string };

const CONTROL_RE = /[\x00-\x1f\x7f]/;

function within(root: string, target: string): boolean {
  if (!root) return false;
  const r = root === '/' ? '' : root.replace(/\/+$/, '');
  return target === r || target.startsWith(`${r}/`);
}

/** An absolute path from the resolver that we can trust as a real path. */
function cleanRealPath(p: string | null): p is string {
  return !!p && p.startsWith('/') && !CONTROL_RE.test(p) && !p.split('/').some((seg) => seg === '.' || seg === '..');
}

/**
 * Resolve where a write_file call would really land. The leaf must not be a
 * symlink, must be a regular file with one hard link when it exists (a
 * hardlinked file is truncated in place, rewriting its other name); every
 * existing parent directory is resolved with `cd -P` (symlinks followed), and
 * the result plus the not-yet-existing components must sit inside the REAL
 * path of the home dir or of a configured repo. A dangling symlink on the way
 * is refused. Paths with `..`, control characters or no leading `/` are
 * refused before anything runs. Resolved names with control characters are
 * refused in the script (a newline could forge an output line), and each
 * output key must appear exactly once.
 */
export async function resolveWriteTarget(
  rawPath: string,
  allowedRoots: string[],
  run: McpShellRunner,
): Promise<WriteTargetResult> {
  const bare = rawPath.startsWith('file://') ? rawPath.slice('file://'.length) : rawPath;
  if (!bare || !bare.startsWith('/') || CONTROL_RE.test(bare)) {
    return { ok: false, error: 'path must be an absolute path without control characters' };
  }
  if (bare.split('/').includes('..')) {
    return { ok: false, error: 'path must not contain ".."' };
  }
  const target = normalizePath(bare);
  if (target === '/' || target.endsWith('/')) {
    return { ok: false, error: 'path must name a file' };
  }
  const roots = allowedRoots.filter((r) => typeof r === 'string' && r.startsWith('/') && !CONTROL_RE.test(r)).map((r) => normalizePath(r));
  if (!roots.some((root) => within(root, target))) {
    return { ok: false, error: 'path must be under the home dir or a Shelly-configured repo (see list_repos)' };
  }

  const lines = [
    `p=${shellQuote(target)}`,
    'if [ -L "$p" ]; then echo "RP_LEAF_LINK"; exit 0; fi',
    'if [ -e "$p" ] && [ ! -f "$p" ]; then echo "RP_LEAF_NOT_FILE"; exit 0; fi',
    'if [ -e "$p" ] && [ "$(stat -c %h -- "$p" 2>/dev/null)" != "1" ]; then echo "RP_LEAF_HARDLINK"; exit 0; fi',
    'd=$(dirname -- "$p")',
    'while [ ! -e "$d" ] && [ ! -L "$d" ]; do d=$(dirname -- "$d"); done',
    'if [ ! -d "$d" ]; then echo "RP_PARENT_NOT_DIR"; exit 0; fi',
    'r=$(cd -P -- "$d" && pwd -P)',
    ...roots.map((root, i) => `r${i}=$(cd -P -- ${shellQuote(root)} 2>/dev/null && pwd -P)`),
    `for x in "$r"${roots.map((_, i) => ` "$r${i}"`).join('')}; do case "$x" in *[[:cntrl:]]*) echo "RP_BAD"; exit 0;; esac; done`,
    'printf "RP_ANCESTOR:%s\\n" "$d"',
    'printf "RP_REAL:%s\\n" "$r"',
    ...roots.map((_, i) => `printf "RP_ROOT${i}:%s\\n" "$r${i}"`),
  ];
  let stdout = '';
  try {
    const res = await run(lines.join('\n'));
    stdout = res.stdout ?? '';
  } catch (e) {
    return { ok: false, error: `could not resolve the path: ${e instanceof Error ? e.message : String(e)}` };
  }
  const out = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  if (out.includes('RP_LEAF_LINK')) return { ok: false, error: 'refused: the target file is a symlink' };
  if (out.includes('RP_LEAF_NOT_FILE')) return { ok: false, error: 'refused: the target exists and is not a regular file' };
  if (out.includes('RP_LEAF_HARDLINK')) return { ok: false, error: 'refused: the target file has more than one hard link' };
  if (out.includes('RP_BAD')) return { ok: false, error: 'refused: a resolved directory name contains control characters' };
  if (out.includes('RP_PARENT_NOT_DIR')) return { ok: false, error: 'refused: a parent of the target is not a directory (or is a dangling symlink)' };
  const unresolved: WriteTargetResult = { ok: false, error: 'could not resolve the path' };
  // Each key exactly once: a repeated key means the output is not ours.
  const keys = ['RP_ANCESTOR', 'RP_REAL', ...roots.map((_, i) => `RP_ROOT${i}`)];
  const field = (key: string): string | null => {
    const hits = out.filter((l) => l.startsWith(`${key}:`));
    return hits.length === 1 ? hits[0].slice(key.length + 1) : null;
  };
  if (keys.some((key) => out.filter((l) => l.startsWith(`${key}:`)).length !== 1)) return unresolved;
  const ancestor = field('RP_ANCESTOR');
  const real = field('RP_REAL');
  if (!ancestor || !cleanRealPath(real) || !within(ancestor, target)) return unresolved;
  const rest = target.slice(ancestor === '/' ? 1 : ancestor.length + 1);
  const realPath = normalizePath(`${real}/${rest}`);
  const realRoots = roots.map((_, i) => field(`RP_ROOT${i}`)).filter(cleanRealPath);
  if (!realRoots.some((root) => within(root, realPath))) {
    return { ok: false, error: 'refused: the real path (after following symlinks) is outside the home dir and the configured repos' };
  }
  return { ok: true, realPath };
}
