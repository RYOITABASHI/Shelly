/**
 * lib/agent-boundary-policy.ts — the core of Spec A's policy-first gate.
 *
 * Classifies a PROPOSED command (the one codex surfaces at an approval prompt)
 * into a gate decision: allow / deny / gray. The autonomous loop drives
 * interactive codex with `--ask-for-approval`; this classifier auto-answers the
 * existing PTY-approval bridge (allow→`y`, deny→`n`+audit, gray→human), so "no
 * per-step human approval" holds while hard-denies and boundary crossings are
 * still enforced. See specs/2026-06-17-autonomous-mode-A-policy-gate.md §5/§6.
 *
 * Why command-string classification (not a syscall sandbox): on Android codex's
 * native --sandbox does not work (HomeInitializer.kt:1030-1035), so `codex exec`
 * runs danger-full-access with zero gating. The enforceable surface is the
 * command codex shows at each approval prompt — visible, classifiable here.
 *
 * Path extraction starts lexically, then the Node gate resolves the workspace
 * root and each candidate through realpath. Missing leaf paths are resolved via
 * their nearest existing ancestor so commands that create a new file still gate
 * without throwing. Non-Node callers retain the lexical check.
 */
import { checkCommandSafety, DangerLevel } from '@/lib/command-safety';

export type AutonomyLevel = 'L1' | 'L2' | 'L3';
export type GateDecision = 'allow' | 'deny' | 'gray';

export type BoundarySignal =
  | 'destructive'        // command-safety CRITICAL/HIGH
  | 'leaves-root'        // a referenced path escapes the workspace root
  | 'network-send'       // outbound network (curl/wget/nc/ssh/scp …)
  | 'opaque-script-exec' // interpreter invocation (python/node/ruby/…) whose
                          // script contents aren't inspected — may perform
                          // undetectable network I/O (DEFERRED bug #155a)
  | 'indirect-exec'      // command substitution ($(...)/`...`), eval, xargs
                          // with an argument, or `env` invoking a command —
                          // the actual executed command isn't the literal
                          // string we classified, so we can't reason about it
                          // (Fable5 review 2026-08-25, DEFERRED.md 2026-08-10 A-1..A-5 note)
  | 'secret-read'        // reads a protected secret path (auth.json, keystore)
  | 'policy-write'       // writes the policy file / autonomy config (hard-deny)
  | 'write-or-exec';     // mutating/executing op (vs a pure read) — heuristic

export interface GateVerdict {
  decision: GateDecision;
  /** ordered signals that drove the decision (for the audit log) */
  signals: BoundarySignal[];
  /** human-readable reason, surfaced in Scouter/approval UI and the audit log */
  reason: string;
  /** command-safety level, when relevant */
  dangerLevel?: DangerLevel;
}

export interface GateContext {
  /** canonical workspace root resolved at session start */
  workspaceRoot: string;
  level: AutonomyLevel;
  /** protected secret paths an agent-emitted read must not touch (boundary) */
  secretPaths?: string[];
  /** the policy/autonomy config path the agent must never write (hard-deny) */
  policyPath?: string;
}

const DEFAULT_SECRET_PATHS = ['.codex/auth.json', '.shelly/agents/.env'];

/** Lexically normalise a path: collapse `.`/`..`, dedupe slashes. NOT symlink-resolved. */
export function normalizePath(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else out.push(seg);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

interface NodeFsLike {
  realpathSync(path: string): string;
}

function nodeFs(): NodeFsLike | null {
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  try {
    // This module is also imported by the React Native app. Keep the Node-only
    // dependency out of Metro's static module graph; the production gate is an
    // esbuild-generated Node bundle and supplies `require` at runtime.
    const runtimeModule = typeof module === 'undefined' ? null : module;
    if (!runtimeModule || typeof runtimeModule.require !== 'function') return null;
    return runtimeModule.require('fs') as NodeFsLike;
  } catch {
    return null;
  }
}

function realpathAllowMissing(path: string, fs: NodeFsLike): string | null {
  const missing: string[] = [];
  let candidate = path;
  while (true) {
    try {
      const resolved = normalizePath(fs.realpathSync(candidate).replace(/\\/g, '/'));
      return normalizePath(`${resolved}/${missing.reverse().join('/')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const slash = candidate.lastIndexOf('/');
      if (slash < 0) return null;
      missing.push(candidate.slice(slash + 1));
      const parent = candidate.slice(0, slash) || '/';
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

/** True if `target` is inside (or equal to) `root`, including symlink resolution in Node. */
export function isWithinRoot(root: string, target: string): boolean {
  if (target.startsWith('~')) return false; // home-relative = outside the project workspace
  // Fable5 review 2026-08-25: `$HOME/.ssh/id_rsa` isn't recognized as
  // absolute below (it doesn't start with `/` or a drive letter), so it fell
  // through to being joined onto `root` and declared in-root — a one-token
  // bypass of the exact same shape the `~` guard above exists to close. We
  // can't resolve the variable's value statically, so treat any `$`-led
  // token the same way: outside the workspace, fail-closed.
  if (target.startsWith('$')) return false;
  const r = normalizePath(root).replace(/\/$/, '');
  const targetIsAbsolute = target.startsWith('/') || /^[A-Za-z]:\//.test(target);
  const t = normalizePath(targetIsAbsolute ? target : `${r}/${target}`);
  if (t !== r && !t.startsWith(`${r}/`)) return false;

  const fs = nodeFs();
  if (!fs) return true;
  // The production gate receives an existing canonical workspace root. Some
  // callers (including policy validation/tests) use a prospective or synthetic
  // root, however. Do not walk above that boundary: on Linux an inaccessible
  // ancestor (for example `/root`) makes realpathSync report EACCES, while the
  // equivalent missing path on Windows can be reconstructed from the drive
  // root. With no resolvable workspace there cannot be an inspectable symlink
  // below it, so retain the already-completed lexical containment result.
  let realRoot: string;
  try {
    realRoot = normalizePath(fs.realpathSync(r).replace(/\\/g, '/'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return true;
    return false;
  }
  const realTarget = realpathAllowMissing(t, fs);
  if (!realTarget) return false;
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`);
}

/**
 * Adversarial review 2026-08-25 (second pass): the new bare-`$`-token guard
 * below flagged shell SPECIAL parameters too — `$$` (own PID), `$?` (last
 * exit code), `$#` (arg count), `$@`/`$*` (all args), `$0`-`$9` (positional/
 * script name) — as if they were unresolvable path variables. `echo $?` has
 * no path semantics at all; treating it as "leaves root" is a pure
 * false-positive that would gray/deny routine commands for no security
 * benefit. Excluded from the path-candidate filter, NOT from isWithinRoot's
 * general `$`-guard (a real named variable like `$HOME` or `$PROJECT_DIR`
 * must still be treated as unresolvable).
 */
const SHELL_SPECIAL_PARAM_RE = /^\$(?:\$|\?|#|@|\*|[0-9])$/;

/** Best-effort extraction of path-like argument tokens from a shell command. */
export function extractPaths(command: string): string[] {
  return command
    .split(/\s+/)
    .map((t) =>
      t
        .replace(/^[<>|&]+/, '')
        .replace(/[;,]+$/, '') // strip redirection ops / trailing punct
        // Adversarial review 2026-07-28: a QUOTED argument kept its quotes, so
        // `cp src/a.ts "/sdcard/Download/a.ts"` produced the token
        // `"/sdcard/Download/a.ts"` — which does not start with `/`, so
        // isWithinRoot() treated it as workspace-relative, joined it to the
        // root and declared it in-root. Quoting was therefore a
        // one-character bypass of BOTH `leaves-root` and the `~` guard
        // (`"~/x"` likewise). Strip surrounding quotes lexically.
        .replace(/^['"`]+/, '')
        .replace(/['"`]+$/, ''),
    )
    .filter(
      (t) =>
        t.length > 0 &&
        !t.startsWith('-') &&
        (t.includes('/') ||
          t.startsWith('~') ||
          t === '.' ||
          t === '..' || // Fable5 review 2026-08-25: a bare `..` (no `/`) matched
                        // none of the conditions below, so `cd ..` was invisible
                        // to isWithinRoot entirely — see hasUnsafeCd() for the
                        // companion fix (a `cd` outside root taints every
                        // relative path after it, which this filter alone can't).
          (t.startsWith('$') && !SHELL_SPECIAL_PARAM_RE.test(t)) || // bare `$HOME` (no `/`) — see isWithinRoot's `$` guard
          t.startsWith('./') ||
          t.startsWith('../')),
    );
}

/**
 * A `cd` to somewhere we can't prove is in-root taints every *relative* path
 * token later in the command: `cd ..; cat other/.env` — `other/.env` alone
 * looks in-root when checked against `workspaceRoot`, but the shell actually
 * resolves it against the post-`cd` cwd (the workspace's PARENT), so it reads
 * a real path this classifier has no way to reconstruct. We don't track cwd
 * across `;`/`&&`/`||`/`|`/`&` (that needs a real shell parser), so this is a
 * deliberately conservative rule: any `cd` argument that isn't itself
 * provably within `root` marks the WHOLE command `leaves-root`, even though
 * only the *subsequent* segments are actually affected. Accepted
 * false-positive — same tradeoff this file already makes for
 * OPAQUE_SCRIPT_RE. Fable5 review 2026-08-25.
 *
 * Finds `cd` at the start of a shell statement WHEREVER one begins in the
 * string — not only at the very start of `command` itself. The file header's
 * own SHELL_SCRIPT_FILE_RE comment explains why that distinction matters:
 * the driver flattens codex's argv (`["bash","-lc","<script>"]`) into the
 * string this function receives, so "essentially EVERY proposed command
 * starts with `bash -lc …`" — meaning a real `cd` is always buried inside
 * that quoted payload, e.g. `bash -lc 'cd ..; cat other/.env'`, never at
 * true string-index 0. A naive top-level split (this function's first
 * version) only ever found `cd` as segment zero and missed every realistic
 * wrapped case. This scans for `cd` immediately after a statement-start
 * character INCLUDING an opening quote (`'`/`"`/backtick), so the `-lc`
 * payload's own first statement is reachable too.
 *
 * Adversarial review 2026-08-25 (second pass, same day): the first version's
 * boundary set (`;&|(\n` + quotes) missed `{ cd; cat .env; }`,
 * `if true; then cd; cat .env; fi`, and `for i in 1; do cd; cat .env; done`
 * — none of `{`/`then`/`do`/`else`/`elif`/`until` were in the set, so a BARE
 * `cd` (the exact "no argument → $HOME" case this function's own top
 * comment calls out as the primary motivating case) sailed through
 * undetected in all three, because a bare `cd` produces no token
 * `extractPaths()` independently catches either. Rather than enumerate every
 * shell keyword (an open-ended list), any whitespace-preceded `cd` is now
 * also a candidate — broader than a real shell parser would allow (e.g.
 * `mkdir cd` false-positives), but that's the same accepted tradeoff this
 * file already makes elsewhere (OPAQUE_SCRIPT_RE, `$`-prefix guard).
 */
const CD_START_RE = /(?:^|[;&|(\n'"`\s])\s*cd(?=[\s;&|)'"`]|$)/g;

export function hasUnsafeCd(command: string, root: string): boolean {
  CD_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CD_START_RE.exec(command))) {
    const afterCd = command.slice(match.index + match[0].length);
    // The rest of THIS statement: up to the next unescaped statement/quote
    // boundary. Best-effort, same lexical (not real shell-parse) limitation
    // as the rest of this file.
    const restMatch = afterCd.match(/^[^;&|)'"`\n]*/);
    const rest = (restMatch ? restMatch[0] : '').trim();
    if (!rest) return true; // bare `cd` → $HOME, always outside the workspace root
    const tokens = rest.split(/\s+/);
    // `cd -L /foo` / `cd -P /foo`: skip leading option flags to find the target.
    const argToken = tokens.find((t) => !t.startsWith('-'));
    if (!argToken || argToken === '-') return true; // `cd -` → $OLDPWD, unprovable
    const arg = argToken.replace(/^['"`]+/, '').replace(/['"`]+$/, '');
    if (!isWithinRoot(root, arg)) return true;
  }
  return false;
}

const NETWORK_RE = /\b(curl|wget|nc|ncat|netcat|scp|sftp|ssh|rsync|telnet)\b/;
/**
 * bash/ksh's BUILT-IN network primitive. `exec 3<>/dev/tcp/host/port` opens a
 * TCP socket with no external tool name anywhere on the command line, so it
 * evaded NETWORK_RE entirely; and because the token does not start with `/`
 * (it starts with the fd number, e.g. `3<>/dev/tcp/...`) it did not trip
 * `leaves-root` either. Adversarial review 2026-07-28.
 */
const SHELL_NET_DEVICE_RE = /\/dev\/(?:tcp|udp)\//;
const READ_ONLY_RE = /^\s*(cat|less|more|head|tail|grep|rg|ls|find|stat|file|wc|diff|git\s+(status|log|diff|show))\b/;
const LOOPBACK_HOST_RE = /^(127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)$/i;

/**
 * Interpreter invocations (with an argument — a script file, `-c`/`-e` inline
 * code, etc.) whose contents we do NOT inspect at gate-decision time. codex
 * can trivially route around NETWORK_RE by writing `script.py` with an
 * embedded `requests.get(...)` / `fetch(...)` call and proposing
 * `python3 script.py` — no network-tool name ever appears in the top-level
 * command line. We can't read the referenced file here (out of MVP scope —
 * see the file-level "Scope note" above), so this is a conservative SHAPE
 * heuristic, not detected network activity: flag it and let the boundary
 * gate treat it with the same caution as network-send. This intentionally
 * also flags non-networking scripts (a formatter, a build step) — accepted
 * false-positive / UX tradeoff, see docs/superpowers/DEFERRED.md bug #155(a).
 * `python3?` tolerates a `\d+(?:\.\d+)*` version suffix (`python3.11`,
 * `python3.9`) — a real, common invocation shape on Debian-derived bundles
 * like this project's, not just the bare `python3` this list started with.
 */
const OPAQUE_SCRIPT_RE =
  /\b(?:python\d?(?:\.\d+)*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun|lua(?:jit)?|Rscript|julia|tclsh)\b\s+\S/;

/**
 * Adversarial review 2026-07-28 — gap 1 of 2 that OPAQUE_SCRIPT_RE alone left.
 *
 * A shell script file is exactly as opaque as a `.py`, and `bash` additionally
 * has a *built-in* network primitive (`exec 3<>/dev/tcp/host/port`) that needs
 * no external tool name at all, so `bash exfil.sh` was previously an
 * unsignalled in-root `write-or-exec` (auto-allow at L2, including unattended
 * scheduled runs).
 *
 * We can NOT simply add `sh|bash` to OPAQUE_SCRIPT_RE: the codex driver
 * flattens codex's argv array (`["bash","-lc","<script>"]`, see
 * scripts/shelly-agent-driver.js) into the classified string, so essentially
 * EVERY proposed command starts with `bash -lc …`. Flagging that shape would
 * gray every single command and, under `unattended` (fail-closed), deny the
 * whole autonomous surface.
 *
 * So this matches only a shell followed by a script FILE argument — flags may
 * precede it, but the first non-flag token must itself be the `.sh`/`.bash`
 * file. `bash -lc '…'` and `bash -lc 'cat run.sh'` do not match; `bash x.sh`,
 * `sh -e ./deploy.sh` and `bash -lc './run.sh'` do.
 */
const SHELL_SCRIPT_FILE_RE =
  /(?:^|[\s;&|(])(?:ba|z|k|da)?sh\s+(?:-[A-Za-z]+\s+)*(?!-)[^\s;&|]*\.(?:sh|bash|zsh|ksh)\b/;

/**
 * Adversarial review 2026-07-28 — gap 2 of 2.
 *
 * OPAQUE_SCRIPT_RE requires an argument AFTER the interpreter (`\s+\S`), so
 * feeding the script in over a pipe defeated it: `cat exfil.py | python3` has
 * no token after `python3`. Worse, the OLD `isPureRead` looked only at the
 * FIRST token, so `cat …` made the whole pipeline count as a "pure read" —
 * i.e. that command auto-allowed even at **L1**, the read-only level.
 *
 * An interpreter (or shell) on the receiving end of a pipe is unambiguously
 * script execution, so this has no meaningful false-positive surface. `awk` is
 * deliberately excluded: `… | awk '{print $1}'` is a routine read-pipeline
 * idiom and gating it would be pure noise.
 */
const PIPED_INTERPRETER_RE =
  /\|\s*(?:sudo\s+)?(?:[^\s|;&]*\/)?(?:python\d?(?:\.\d+)*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun|lua(?:jit)?|Rscript|julia|tclsh|sh|bash|zsh|ksh|dash)\b/;

/**
 * Fable5 review 2026-08-25 — `eval`, command substitution (`$(...)`/backticks),
 * `xargs <cmd>`, and `env <cmd>` all run a command that is NOT the literal
 * string classifyProposedCommand() inspected: `bash -lc 'eval "$X"'` matches
 * neither OPAQUE_SCRIPT_RE (no interpreter name) nor a network/path signal,
 * so it fell through as plain `write-or-exec` — auto-allow at L2. We can't
 * know what these actually run, so — same shape-not-content heuristic as
 * OPAQUE_SCRIPT_RE — flag the shape and let the boundary gate treat it with
 * the same caution as an opaque script. `env` alone (list env vars, a common
 * read-only idiom) must NOT match; only `env` immediately followed by
 * flags/assignments/a command does.
 */
const INDIRECT_EXEC_RE =
  /\$\(|`|\beval\b|\bxargs\b\s+\S|\benv\b\s+(?:-\S+\s+)*(?:\w+=\S*\s+)*\S/;

/**
 * A command is a PURE READ only when every pipeline/list segment is a
 * read-only tool AND nothing redirects into a file.
 *
 * The previous definition was `READ_ONLY_RE.test(command)`, which is anchored
 * at `^` and therefore only ever inspected the FIRST segment. Everything after
 * a `|`, `;`, `&&` or `>` was invisible to it, so `cat a > b`,
 * `cat a | tee /sdcard/x` and `cat a | python3` all claimed "pure read" — and
 * L1, whose entire contract is "reads auto-allow, anything else escalates",
 * auto-allowed them.
 */
function isPureReadCommand(command: string): boolean {
  if (command.includes('>')) return false; // any redirection ⇒ not a read
  const segments = command
    .split(/\|\||&&|[|;&]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((s) => READ_ONLY_RE.test(s));
}

/**
 * True when every network-tool target in `command` is a loopback host
 * (127.0.0.0/8, localhost, ::1) — e.g. an agent's own local-LLM
 * availability probe (`curl 127.0.0.1:8080/v1/models`). Such a command
 * still matches NETWORK_RE but never actually leaves the device, so it
 * should not force the same human-approval gate as a real outbound
 * request. Best-effort / conservative: any command whose host can't be
 * parsed out of a URL (e.g. bare `nc host port`) is treated as NOT
 * loopback-only, so it still gets gated — this only narrows the signal
 * for the parseable, common curl/wget-URL case.
 */
function isLoopbackOnlyNetworkCommand(command: string): boolean {
  // Bracketed IPv6 literal (e.g. [::1]) first, else a bare host up to the
  // next `:` (port) or `/` (path).
  const hosts = [...command.matchAll(/\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^/\s:]+)/gi)].map((m) => m[1]);
  if (hosts.length === 0) return false;
  return hosts.every((h) => LOOPBACK_HOST_RE.test(h));
}

/**
 * Classify a proposed command into a gate decision under the given context.
 * The autonomous gate calls this for every approval prompt codex raises.
 */
export function classifyProposedCommand(command: string, ctx: GateContext): GateVerdict {
  const signals: BoundarySignal[] = [];
  const secretPaths = ctx.secretPaths ?? DEFAULT_SECRET_PATHS;
  const safety = checkCommandSafety(command);

  // 1. Hard-deny: policy/autonomy self-mutation (no level may override — §6).
  if (ctx.policyPath && new RegExp(`>\\s*\\S*${escapeRe(ctx.policyPath)}|\\b(tee|cp|mv)\\b[^|]*${escapeRe(ctx.policyPath)}`).test(command)) {
    return { decision: 'deny', signals: ['policy-write'], reason: 'agent attempted to write the policy/autonomy file', dangerLevel: safety.level };
  }

  // 2. Hard-deny: CRITICAL destructive — denied at EVERY level (the §2 invariant:
  //    L3 relaxes prompt frequency, never command-safety hard-denies).
  if (safety.level === 'CRITICAL') {
    return { decision: 'deny', signals: ['destructive'], reason: safety.reason, dangerLevel: safety.level };
  }
  if (safety.level === 'HIGH') signals.push('destructive');

  // 3. Boundary signals.
  const paths = extractPaths(command);
  if (paths.some((p) => secretPaths.some((s) => normalizePath(p).includes(s)))) signals.push('secret-read');
  if (
    paths.some((p) => !isWithinRoot(ctx.workspaceRoot, p)) ||
    hasUnsafeCd(command, ctx.workspaceRoot)
  ) {
    signals.push('leaves-root');
  }
  if (
    (NETWORK_RE.test(command) && !isLoopbackOnlyNetworkCommand(command)) ||
    SHELL_NET_DEVICE_RE.test(command)
  ) {
    signals.push('network-send');
  }
  if (
    OPAQUE_SCRIPT_RE.test(command) ||
    SHELL_SCRIPT_FILE_RE.test(command) ||
    PIPED_INTERPRETER_RE.test(command)
  ) {
    signals.push('opaque-script-exec');
  }
  if (INDIRECT_EXEC_RE.test(command)) signals.push('indirect-exec');
  const isPureRead =
    isPureReadCommand(command) &&
    !signals.includes('network-send') &&
    !signals.includes('opaque-script-exec');
  if (!isPureRead) signals.push('write-or-exec');

  // 4. Decide by autonomy level. `write-or-exec` is a descriptor, not a boundary:
  //    an in-root mutating op is exactly what L2 permits. Boundary signals are
  //    the ones that force a human gate (leaves-root / secret-read / network /
  //    HIGH-destructive).
  const boundarySignals = signals.filter((s) => s !== 'write-or-exec');
  const reason = signals.length ? `boundary: ${signals.join(', ')}` : 'within policy';
  switch (ctx.level) {
    case 'L1': // read-only: reads auto, anything mutating/leaving/secret → human
      if (isPureRead && boundarySignals.length === 0) {
        return { decision: 'allow', signals, reason: 'L1 read', dangerLevel: safety.level };
      }
      return { decision: 'gray', signals, reason, dangerLevel: safety.level };
    case 'L2': // workspace: in-root r/w/exec auto; boundary → human
      if (boundarySignals.length === 0) {
        return { decision: 'allow', signals, reason: 'L2 in-workspace', dangerLevel: safety.level };
      }
      return { decision: 'gray', signals, reason, dangerLevel: safety.level };
    case 'L3': { // silent opt-in relaxes prompts, never safety boundaries
      const hardDenySignals: BoundarySignal[] = ['secret-read', 'leaves-root', 'network-send'];
      if (safety.level === 'HIGH' || hardDenySignals.some((s) => signals.includes(s))) {
        return { decision: 'deny', signals, reason: `L3 safety boundary: ${reason}`, dangerLevel: safety.level };
      }
      if (boundarySignals.length > 0) {
        return { decision: 'gray', signals, reason, dangerLevel: safety.level };
      }
      return { decision: 'allow', signals, reason: 'L3 in-workspace', dangerLevel: safety.level };
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface WorkspaceRootVerdict {
  ok: boolean;
  /** human-readable reason, present only when ok is false */
  reason?: string;
}

/**
 * Reject a workspace root that would make the boundary gate meaningless —
 * every in-root check in this file is only as strong as the root itself.
 * Registering an agent with `workspaceRoot` set to `$HOME` (or the app's own
 * home dir) means the "jail" contains the agent's own generated run scripts
 * (`~/.shelly/agents/*.sh`), Codex auth, and `.ssh` — the agent could rewrite
 * its own script and the gate would never see it, since everything it
 * touches is "in-root" by definition. Fable5 review 2026-08-25; see
 * DEFERRED.md's 2026-08-10 Hermes dual-review entry, A-1..A-5 note.
 *
 * `homePaths` should include both the JS-visible home path and any known
 * real/alias equivalents (Android's app-private home resolves through more
 * than one string depending on caller — see CLAUDE.md's adb `$HOME` note).
 */
export function validateWorkspaceRoot(root: string, homePaths: string[] = []): WorkspaceRootVerdict {
  const trimmed = (root ?? '').trim();
  if (!trimmed || trimmed === '~' || trimmed === '$HOME') {
    return { ok: false, reason: 'workspace root cannot be empty or the home directory itself' };
  }
  const normalized = normalizePath(trimmed).replace(/\/$/, '');
  if (!normalized || normalized === '/') {
    return { ok: false, reason: 'workspace root cannot be the filesystem root' };
  }
  for (const home of homePaths) {
    const normHome = normalizePath(home).replace(/\/$/, '');
    if (normHome && normalized === normHome) {
      return { ok: false, reason: 'workspace root cannot be the app home directory' };
    }
  }
  // Adversarial review 2026-08-25: `/storage/self/primary` is Android's
  // standard per-uid symlink alias to the same location as `/sdcard` and
  // `/storage/emulated/<uid>` — without it, registering that exact string
  // would defeat this whole check.
  if (
    normalized === '/sdcard' ||
    normalized === '/storage/self/primary' ||
    /^\/storage\/emulated\/\d+$/.test(normalized)
  ) {
    return { ok: false, reason: 'workspace root cannot be the entire external storage root' };
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '.shelly' || seg === '.codex' || seg === '.ssh')) {
    return { ok: false, reason: 'workspace root cannot be inside .shelly, .codex, or .ssh' };
  }
  return { ok: true };
}
