/**
 * EXEC-001 workspace.exec pure core.
 *
 * The runtime broker performs the actual spawn; this module owns the
 * deterministic allow/deny decision so tests can cover command safety and cwd
 * jail behaviour without executing shell.
 */
import { isWithinRoot, normalizePath } from '@/lib/agent-boundary-policy';
import { checkCommandSafety, DangerLevel } from '@/lib/command-safety';
import { redactSecrets } from '@/lib/redact-secrets';

export type ExecDecision = 'allow' | 'deny';

export type ExecSignal =
  | 'inside-root'
  | 'outside-root'
  | 'invalid-cwd'
  | 'critical-command'
  | 'unsupported-command'
  | 'unsafe-shell-syntax'
  | 'no-roots';

export type ExecTemplate = 'env' | 'printenv' | 'pwd' | 'printf' | 'sleep' | 'cat' | 'ls' | 'grep' | 'true' | 'false';

export interface CuratedExecCommand {
  template: ExecTemplate;
  argv: string[];
  pathArgs: string[];
}

type CuratedExecParseResult =
  | { ok: true; command: CuratedExecCommand }
  | { ok: false; reason: string; signal: 'unsupported-command' | 'unsafe-shell-syntax' };

export interface ExecVerdict {
  decision: ExecDecision;
  reason: string;
  signals: ExecSignal[];
  cwd: string | null;
  matchedRoot: string | null;
  dangerLevel: DangerLevel;
  command: CuratedExecCommand | null;
}

export interface ExecAuditEntry {
  ts: string;
  kind: 'workspace.exec';
  cwd: string;
  root: string | null;
  decision: ExecDecision;
  signals: ExecSignal[];
  dangerLevel: DangerLevel;
  timeoutSeconds: number;
  ok?: boolean;
  exitCode?: number;
  reason?: string;
}

function canonicalizeCwd(value: string, fallbackRoot: string): string {
  if (!value || !value.trim() || value.includes('\0')) throw new Error('cwd is invalid');
  if (value.startsWith('~')) throw new Error('cwd must not be home-relative');
  const base = fallbackRoot && fallbackRoot.startsWith('/') ? fallbackRoot : '/';
  return normalizePath(value.startsWith('/') ? value : `${base}/${value}`);
}

function canonicalizeRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !root.trim() || root.includes('\0') || root.startsWith('~')) continue;
    const canonical = normalizePath(root.startsWith('/') ? root : `/${root}`);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function splitCuratedCommand(command: string): { argv: string[] } | { error: string; signal: 'unsupported-command' | 'unsafe-shell-syntax' } {
  const text = String(command || '').trim();
  if (!text) return { error: 'command is empty', signal: 'unsupported-command' };
  if (/[\0\r\n]/.test(text)) return { error: 'multi-line shell commands are not supported by workspace.exec', signal: 'unsafe-shell-syntax' };
  if (/[|&;()<>`$\\*?\[\]{}!~]/.test(text)) return { error: 'shell expansion and control operators are not supported by workspace.exec', signal: 'unsafe-shell-syntax' };

  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return { error: 'unterminated quote in workspace.exec command', signal: 'unsafe-shell-syntax' };
  if (current) argv.push(current);
  if (!argv.length) return { error: 'command is empty', signal: 'unsupported-command' };
  return { argv };
}

function parseCuratedExecCommand(command: string): CuratedExecParseResult {
  const split = splitCuratedCommand(command);
  if ('error' in split) return { ok: false, reason: split.error, signal: split.signal };
  const argv = split.argv;
  const name = argv[0];
  const pathArgs: string[] = [];

  if (name === 'env') {
    if (argv.length !== 1) return { ok: false, reason: 'env template does not accept arguments', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'env', argv, pathArgs } };
  }
  if (name === 'printenv') {
    if (argv.length > 2 || (argv[1] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[1]))) {
      return { ok: false, reason: 'printenv template accepts at most one variable name', signal: 'unsupported-command' };
    }
    return { ok: true, command: { template: 'printenv', argv, pathArgs } };
  }
  if (name === 'pwd' || name === 'true' || name === 'false') {
    if (argv.length !== 1) return { ok: false, reason: `${name} template does not accept arguments`, signal: 'unsupported-command' };
    return { ok: true, command: { template: name, argv, pathArgs } };
  }
  if (name === 'printf') {
    if (argv.length < 2 || argv.length > 8) return { ok: false, reason: 'printf template requires 1-7 literal arguments', signal: 'unsupported-command' };
    if (argv.slice(1).some((arg) => arg.startsWith('-'))) return { ok: false, reason: 'printf template only accepts literal arguments', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'printf', argv, pathArgs } };
  }
  if (name === 'sleep') {
    if (argv.length !== 2 || !/^\d+(?:\.\d+)?$/.test(argv[1])) return { ok: false, reason: 'sleep template requires one numeric duration', signal: 'unsupported-command' };
    return { ok: true, command: { template: 'sleep', argv, pathArgs } };
  }
  if (name === 'cat') {
    const args = argv.slice(1).filter((arg) => arg !== '--');
    if (!args.length || args.some((arg) => arg.startsWith('-'))) return { ok: false, reason: 'cat template requires one or more file paths', signal: 'unsupported-command' };
    pathArgs.push(...args);
    return { ok: true, command: { template: 'cat', argv, pathArgs } };
  }
  if (name === 'ls') {
    const args = argv.slice(1);
    for (const arg of args) {
      if (arg.startsWith('-')) {
        if (!['-a', '-l', '-la', '-al'].includes(arg)) return { ok: false, reason: 'ls template only supports -a/-l/-la/-al', signal: 'unsupported-command' };
      } else {
        pathArgs.push(arg);
      }
    }
    return { ok: true, command: { template: 'ls', argv, pathArgs } };
  }
  if (name === 'grep') {
    const args = argv.slice(1);
    const rest: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-')) {
        if (!['-n', '-i', '-r', '-R'].includes(arg)) return { ok: false, reason: 'grep template only supports -n/-i/-r/-R', signal: 'unsupported-command' };
      } else {
        rest.push(arg);
      }
    }
    if (rest.length < 2) return { ok: false, reason: 'grep template requires a literal query and at least one path', signal: 'unsupported-command' };
    pathArgs.push(...rest.slice(1));
    return { ok: true, command: { template: 'grep', argv, pathArgs } };
  }
  return { ok: false, reason: `workspace.exec command is not in the curated template allowlist: ${name}`, signal: 'unsupported-command' };
}

export function classifyWorkspaceExec(opts: {
  command: string;
  cwd: string;
  roots: readonly string[];
}): ExecVerdict {
  const safety = checkCommandSafety(opts.command);
  const roots = canonicalizeRoots(opts.roots);
  const curated = parseCuratedExecCommand(opts.command);
  let cwd: string;
  try {
    cwd = canonicalizeCwd(opts.cwd, roots[0] || '/');
  } catch (error) {
    return {
      decision: 'deny',
      reason: error instanceof Error ? error.message : 'cwd is invalid',
      signals: ['invalid-cwd'],
      cwd: null,
      matchedRoot: null,
      dangerLevel: safety.level,
      command: null,
    };
  }

  if (safety.level === 'CRITICAL') {
    return {
      decision: 'deny',
      reason: safety.reason || 'critical command denied',
      signals: ['critical-command'],
      cwd,
      matchedRoot: null,
      dangerLevel: safety.level,
      command: null,
    };
  }

  if (roots.length === 0) {
    return {
      decision: 'deny',
      reason: 'no workspace exec roots were declared',
      signals: ['no-roots'],
      cwd,
      matchedRoot: null,
      dangerLevel: safety.level,
      command: null,
    };
  }

  const matchedRoot = roots.find((root) => isWithinRoot(root, cwd)) || null;
  if (!matchedRoot) {
    return {
      decision: 'deny',
      reason: 'cwd is outside the declared workspace exec roots',
      signals: ['outside-root'],
      cwd,
      matchedRoot: null,
      dangerLevel: safety.level,
      command: null,
    };
  }

  if (curated.ok === false) {
    return {
      decision: 'deny',
      reason: curated.reason,
      signals: [curated.signal],
      cwd,
      matchedRoot,
      dangerLevel: safety.level,
      command: null,
    };
  }

  for (const rawPath of curated.command.pathArgs) {
    let resolved: string;
    try {
      resolved = canonicalizeCwd(rawPath, cwd);
    } catch (error) {
      return {
        decision: 'deny',
        reason: error instanceof Error ? error.message : 'path argument is invalid',
        signals: ['invalid-cwd'],
        cwd,
        matchedRoot,
        dangerLevel: safety.level,
        command: null,
      };
    }
    if (!roots.some((root) => isWithinRoot(root, resolved))) {
      return {
        decision: 'deny',
        reason: 'workspace.exec path argument is outside the declared roots',
        signals: ['outside-root'],
        cwd,
        matchedRoot,
        dangerLevel: safety.level,
        command: null,
      };
    }
  }

  return {
    decision: 'allow',
    reason: safety.reason || 'curated command allowed inside workspace root',
    signals: ['inside-root'],
    cwd,
    matchedRoot,
    dangerLevel: safety.level,
    command: curated.command,
  };
}

export function buildExecAudit(opts: {
  ts: string;
  verdict: ExecVerdict;
  timeoutSeconds: number;
  ok?: boolean;
  exitCode?: number;
}): ExecAuditEntry {
  return {
    ts: opts.ts,
    kind: 'workspace.exec',
    cwd: opts.verdict.cwd || '<invalid>',
    root: opts.verdict.matchedRoot,
    decision: opts.verdict.decision,
    signals: opts.verdict.signals,
    dangerLevel: opts.verdict.dangerLevel,
    timeoutSeconds: opts.timeoutSeconds,
    ok: opts.ok,
    exitCode: opts.exitCode,
    reason: String(redactSecrets(opts.verdict.reason)),
  };
}
