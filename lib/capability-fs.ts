/**
 * FS-001 scoped.fs pure core.
 *
 * This deliberately reuses the existing boundary-policy path primitives so the
 * new brokered filesystem surface and the older autonomy gate agree on the one
 * root-containment rule. Runtime symlink resolution happens in the node broker;
 * this module stays side-effect free for cheap tests and generated-shell gates.
 */
import { isWithinRoot, normalizePath } from '@/lib/agent-boundary-policy';
import { redactSecrets } from '@/lib/redact-secrets';

export type FsOperation = 'read' | 'write' | 'list' | 'search';

export type FsDecision = 'allow' | 'deny';

export type FsSignal =
  | 'inside-root'
  | 'outside-root'
  | 'invalid-path'
  | 'no-roots';

export interface FsVerdict {
  decision: FsDecision;
  reason: string;
  signals: FsSignal[];
  canonicalPath: string | null;
  matchedRoot: string | null;
}

export interface FsAuditEntry {
  ts: string;
  kind: 'scoped.fs';
  op: FsOperation;
  path: string;
  root: string | null;
  decision: FsDecision;
  signals: FsSignal[];
  ok?: boolean;
  reason?: string;
}

function assertUsablePath(value: string, label: string): void {
  if (!value || !value.trim()) throw new Error(`${label} is empty`);
  if (value.includes('\0')) throw new Error(`${label} contains NUL`);
  if (value.startsWith('~')) throw new Error(`${label} must be absolute or workspace-relative, not home-relative`);
}

export function canonicalizePath(value: string, cwd: string): string {
  assertUsablePath(value, 'path');
  assertUsablePath(cwd, 'cwd');
  if (cwd.startsWith('~')) throw new Error('cwd must not be home-relative');
  const base = normalizePath(cwd.startsWith('/') ? cwd : `/${cwd}`);
  const raw = value.startsWith('/') ? value : `${base}/${value}`;
  return normalizePath(raw);
}

export function canonicalizeRoots(roots: readonly string[], cwd = '/'): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !root.trim()) continue;
    const canonical = canonicalizePath(root, cwd);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function classifyFsAccess(opts: {
  op: FsOperation;
  path: string;
  roots: readonly string[];
  cwd?: string;
}): FsVerdict {
  const cwd = opts.cwd || '/';
  let target: string;
  let roots: string[];
  try {
    target = canonicalizePath(opts.path, cwd);
    roots = canonicalizeRoots(opts.roots, cwd);
  } catch (error) {
    return {
      decision: 'deny',
      reason: error instanceof Error ? error.message : 'invalid path',
      signals: ['invalid-path'],
      canonicalPath: null,
      matchedRoot: null,
    };
  }

  if (roots.length === 0) {
    return {
      decision: 'deny',
      reason: 'no scoped filesystem roots were declared',
      signals: ['no-roots'],
      canonicalPath: target,
      matchedRoot: null,
    };
  }

  const matchedRoot = roots.find((root) => isWithinRoot(root, target)) || null;
  if (!matchedRoot) {
    return {
      decision: 'deny',
      reason: `${opts.op} path is outside the declared scoped filesystem roots`,
      signals: ['outside-root'],
      canonicalPath: target,
      matchedRoot: null,
    };
  }

  return {
    decision: 'allow',
    reason: `${opts.op} path is inside scoped filesystem root`,
    signals: ['inside-root'],
    canonicalPath: target,
    matchedRoot,
  };
}

export function buildFsAudit(opts: {
  ts: string;
  op: FsOperation;
  path: string;
  verdict: FsVerdict;
  ok?: boolean;
}): FsAuditEntry {
  return {
    ts: opts.ts,
    kind: 'scoped.fs',
    op: opts.op,
    path: opts.verdict.canonicalPath || '<invalid>',
    root: opts.verdict.matchedRoot,
    decision: opts.verdict.decision,
    signals: opts.verdict.signals,
    ok: opts.ok,
    reason: String(redactSecrets(opts.verdict.reason)),
  };
}
