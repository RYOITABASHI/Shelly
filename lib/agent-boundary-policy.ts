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
 * Scope note (MVP): path extraction + `..` resolution is LEXICAL. Full symlink
 * resolution needs an fs `realpath` (native exec / bridge) and is a follow-up —
 * a symlink whose target escapes root is NOT yet caught here; flagged below.
 */
import { checkCommandSafety, DangerLevel } from '@/lib/command-safety';

export type AutonomyLevel = 'L1' | 'L2' | 'L3';
export type GateDecision = 'allow' | 'deny' | 'gray';

export type BoundarySignal =
  | 'destructive'        // command-safety CRITICAL/HIGH
  | 'leaves-root'        // a referenced path escapes the workspace root
  | 'network-send'       // outbound network (curl/wget/nc/ssh/scp …)
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

/** True if `target` is inside (or equal to) `root` after lexical normalisation. */
export function isWithinRoot(root: string, target: string): boolean {
  if (target.startsWith('~')) return false; // home-relative = outside the project workspace
  const r = normalizePath(root).replace(/\/$/, '');
  const t = normalizePath(target.startsWith('/') ? target : `${r}/${target}`);
  return t === r || t.startsWith(`${r}/`);
}

/** Best-effort extraction of path-like argument tokens from a shell command. */
export function extractPaths(command: string): string[] {
  return command
    .split(/\s+/)
    .map((t) => t.replace(/^[<>|&]+/, '').replace(/[;,]+$/, '')) // strip redirection ops / trailing punct
    .filter(
      (t) =>
        t.length > 0 &&
        !t.startsWith('-') &&
        (t.includes('/') || t.startsWith('~') || t === '.' || t.startsWith('./') || t.startsWith('../')),
    );
}

const NETWORK_RE = /\b(curl|wget|nc|ncat|netcat|scp|sftp|ssh|rsync|telnet)\b/;
const READ_ONLY_RE = /^\s*(cat|less|more|head|tail|grep|rg|ls|find|stat|file|wc|diff|git\s+(status|log|diff|show))\b/;
const LOOPBACK_HOST_RE = /^(127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)$/i;

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
  if (paths.some((p) => !isWithinRoot(ctx.workspaceRoot, p))) signals.push('leaves-root');
  if (NETWORK_RE.test(command) && !isLoopbackOnlyNetworkCommand(command)) signals.push('network-send');
  const isPureRead = READ_ONLY_RE.test(command) && !signals.includes('network-send');
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
    case 'L3': // full opt-in: auto-allow everything not hard-denied (audited upstream)
      return { decision: 'allow', signals, reason: signals.length ? `L3 (audited): ${reason}` : 'L3', dangerLevel: safety.level };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
