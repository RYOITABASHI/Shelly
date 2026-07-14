/**
 * lib/agent-policy.ts — declarative autonomy policy (DATA, not code) + the gate
 * engine that turns a proposed command into an auto-answer for the approval
 * bridge. Spec A §3/§6.
 *
 * The human sets the level + rule toggles out-of-band (ConfigTUI); the running
 * agent must NEVER mutate the policy — that is enforced as a boundary hard-deny
 * (classifyProposedCommand → 'policy-write'), not here. This module only reads it.
 *
 * decideAutoAnswer() maps the boundary classifier's verdict to how Shelly should
 * answer codex's `--ask-for-approval` prompt: allow→'y', deny→'n', gray→'escalate'
 * (route to the human via the existing notification approval). This delivers "no
 * per-step HUMAN approval" while keeping hard-denies and boundary gates intact.
 */
import type { Agent } from '@/store/types';
import { redactSecrets } from '@/lib/redact-secrets';
import {
  AutonomyLevel,
  GateContext,
  GateVerdict,
  classifyProposedCommand,
} from '@/lib/agent-boundary-policy';

/** The declarative policy the gate consumes. Persisted/edited only via the human UI. */
export interface AutonomyPolicy {
  level: AutonomyLevel;
  /** canonical workspace root resolved at session start */
  workspaceRoot: string;
  /** secret paths an agent-emitted read must not touch (boundary) */
  secretPaths: string[];
  /** the policy/autonomy file the agent must never write (hard-deny) */
  policyPath: string;
  /** extra command patterns (regex source) that always hard-deny */
  denyPatterns: string[];
  /** patterns the operator pre-approved: upgrade gray→allow (never overrides a deny) */
  allowPatterns: string[];
  /**
   * True when this run has NO approver present (a scheduled/alarm fire or a
   * native one-tap run of the stored script — anything not driven by the
   * foreground ladder). The driver turns a gray verdict into an IMMEDIATE
   * decline instead of waiting on the escalation timeout, so out-of-workspace
   * writes are fail-closed by one explicit invariant rather than the
   * coincidence of "nobody answers" + "the wait expires" (DEFERRED #2 境界).
   * Signed pre-approval grants are still consumed before the decline, so the
   * attended escalate→approve→grant→scheduled-run loop keeps working.
   */
  unattended?: boolean;
}

export const DEFAULT_POLICY: Omit<AutonomyPolicy, 'workspaceRoot'> = {
  level: 'L2',
  secretPaths: ['.codex/auth.json', '.shelly/agents/.env'],
  policyPath: '.shelly/agents/policy.json',
  denyPatterns: [],
  allowPatterns: [],
};

const LEVELS: readonly AutonomyLevel[] = ['L1', 'L2', 'L3'];

/** Validate + normalise raw policy data (e.g. parsed JSON). Unknown/invalid fields fall back to defaults. */
export function parseAutonomyPolicy(raw: unknown, workspaceRoot: string): AutonomyPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strArr = (v: unknown, d: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : d;
  return {
    level: LEVELS.includes(r.level as AutonomyLevel) ? (r.level as AutonomyLevel) : DEFAULT_POLICY.level,
    workspaceRoot,
    secretPaths: strArr(r.secretPaths, DEFAULT_POLICY.secretPaths),
    policyPath: typeof r.policyPath === 'string' ? r.policyPath : DEFAULT_POLICY.policyPath,
    denyPatterns: strArr(r.denyPatterns, DEFAULT_POLICY.denyPatterns),
    allowPatterns: strArr(r.allowPatterns, DEFAULT_POLICY.allowPatterns),
    // Strict `=== true`: a malformed value never opts a run INTO the unattended
    // fast-decline (absent/invalid ⇒ attended behavior — the escalation wait +
    // timeout, i.e. today's semantics).
    unattended: r.unattended === true,
  };
}

/**
 * Build the AutonomyPolicy the B2 driver feeds to the gate for an autonomous
 * agent run. Level comes from the agent's stored config (human-set; default L2);
 * `canonicalRoot` is the workspace root resolved at run start; the rest are the
 * global defaults. The driver holds this object — it is NEVER written to codex's
 * workspace, so the running agent cannot read or tamper with it (the §6 invariant).
 */
export function buildAgentPolicy(
  agent: Agent,
  canonicalRoot: string,
  opts: { unattended?: boolean } = {},
): AutonomyPolicy {
  return parseAutonomyPolicy({ level: agent.autonomyLevel, unattended: opts.unattended === true }, canonicalRoot);
}

export type AutoAnswer = 'y' | 'n' | 'escalate';

export interface AuditEntry {
  /** redacted command (secrets stripped via redact-secrets) */
  command: string;
  decision: GateVerdict['decision'];
  answer: AutoAnswer;
  signals: GateVerdict['signals'];
  reason: string;
  level: AutonomyLevel;
}

export interface GateOutcome {
  answer: AutoAnswer;
  verdict: GateVerdict;
  audit: AuditEntry;
}

/**
 * Decide how the approval bridge should answer codex's prompt for `command`.
 * Operator denyPatterns hard-deny (any level); allowPatterns upgrade a gray to
 * allow but NEVER override a hard-deny — the §2 invariant.
 */
export function decideAutoAnswer(command: string, policy: AutonomyPolicy): GateOutcome {
  const ctx: GateContext = {
    workspaceRoot: policy.workspaceRoot,
    level: policy.level,
    secretPaths: policy.secretPaths,
    policyPath: policy.policyPath,
  };
  let verdict = classifyProposedCommand(command, ctx);

  if (policy.denyPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: 'deny', reason: `operator deny-pattern · ${verdict.reason}` };
  } else if (verdict.decision === 'gray' && policy.allowPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: 'allow', reason: `operator allow-pattern · ${verdict.reason}` };
  }

  const answer: AutoAnswer =
    verdict.decision === 'allow' ? 'y' : verdict.decision === 'deny' ? 'n' : 'escalate';
  const audit: AuditEntry = {
    command: String(redactSecrets(command)),
    decision: verdict.decision,
    answer,
    signals: verdict.signals,
    reason: verdict.reason,
    level: policy.level,
  };
  return { answer, verdict, audit };
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}
