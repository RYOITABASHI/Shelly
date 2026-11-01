/**
 * lib/agent-run-blocks.ts — "was anything in this run declined or blocked?"
 * for the save-as-skill gate (lib/agent-run-success.ts).
 *
 * 2026-11-01 on-device bug: a 2-step attended run (Codex, then Claude Code)
 * where the user answered NO to the Claude Code step's gate escalation still
 * ended with "Save as skill? … succeeded". The driver answered Claude's
 * can_use_tool with a deny, Claude then wrote a normal answer ("the command
 * was blocked by Shelly's agent gate …") and the turn completed with exit 0,
 * so every step record read 'success'. The run did not do what was asked.
 *
 * Structured signal: the agent driver / PlanSpec executor audit trail
 * (read-only here — owned by scripts/shelly-agent-driver.js and
 * scripts/shelly-plan-executor.js):
 *   ~/.shelly/agents/logs/<id>/agent-driver-audit.jsonl      (driver, .sh runs)
 *   ~/.shelly/agents/logs/<id>/agent-driver-audit-s<N>.jsonl (executor CLI branch)
 *   ~/.shelly/agents/logs/<id>/plan-executor-audit.jsonl     (executor events)
 *   ~/.shelly/agents/audits/<id>-agent-driver-audit.jsonl    (deletion mirror)
 * A line counts as a block when it records a final "no" for something the
 * worker asked to do:
 *   - gate_decision whose protocol decision is decline / deny / denied (a gate
 *     deny, a declined or timed-out human escalation, an unattended
 *     fail-closed decline — every path through gateCommandActions ends in one
 *     gate_decision line per action);
 *   - escalation_resolved with decision 'decline', escalation_timeout,
 *     escalation_denied_unattended, escalation_fail_closed (also covered by
 *     the gate_decision line, kept so a missing gate line cannot hide it);
 *   - claude_tool_outside_allowlist;
 *   - plan.executor cli_branch_refused.
 * Lines are attributed to a run by its [timestamp - durationMs, timestamp]
 * window with the same slack lib/agent-audit-log.ts uses (the files are
 * append-only across runs and carry no id AgentRunLog also records).
 *
 * Fails open to "no block found" on a read error: the skill offer is then
 * decided by the step statuses and the answer-text check as before.
 */

/** Lazy: lib/home-path pulls the native TerminalEmulator module, and this file
 *  is imported by hooks/use-skill-save-offer.ts, which screens import. */
function homePath(): string {
  const { getHomePath } = require('@/lib/home-path') as typeof import('@/lib/home-path');
  return getHomePath();
}
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Same slack as lib/agent-audit-log.ts entriesForRun (whole-second stamps). */
const WINDOW_SLACK_MS = 5_000;

const BLOCKING_GATE_DECISIONS: ReadonlySet<string> = new Set(['decline', 'deny', 'denied']);
const BLOCKING_AUDIT_KINDS: ReadonlySet<string> = new Set([
  'escalation_timeout',
  'escalation_denied_unattended',
  'escalation_fail_closed',
  'claude_tool_outside_allowlist',
]);

export interface RunBlockSignal {
  timestamp: number;
  kind: string;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function blockKind(parsed: Record<string, unknown>): string | null {
  const kind = parsed.kind;
  if (kind === 'gate_decision') {
    const decision = typeof parsed.decision === 'string' ? parsed.decision : '';
    const actionDecision = typeof parsed.actionDecision === 'string' ? parsed.actionDecision : '';
    if (BLOCKING_GATE_DECISIONS.has(decision) || actionDecision === 'decline') return 'gate_decision';
    return null;
  }
  if (kind === 'escalation_resolved') return parsed.decision === 'decline' ? 'escalation_declined' : null;
  if (typeof kind === 'string' && BLOCKING_AUDIT_KINDS.has(kind)) return kind;
  if (kind === 'plan.executor' && parsed.event === 'cli_branch_refused') return 'cli_branch_refused';
  return null;
}

/** Pure: every blocking line in raw JSONL text (any of the files above). */
export function parseRunBlockSignals(text: string): RunBlockSignal[] {
  const out: RunBlockSignal[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const kind = blockKind(record);
    if (!kind) continue;
    const timestamp = Date.parse(String(record.ts));
    if (!Number.isFinite(timestamp)) continue;
    out.push({ timestamp, kind });
  }
  return out;
}

/** Pure: the signals inside one run's window. */
export function blockSignalsForRun(
  signals: ReadonlyArray<RunBlockSignal>,
  run: { timestamp: number; durationMs?: number },
): RunBlockSignal[] {
  if (!Number.isFinite(run.timestamp)) return [];
  const duration = typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) ? Math.max(run.durationMs, 0) : 0;
  const end = run.timestamp + WINDOW_SLACK_MS;
  const start = run.timestamp - duration - WINDOW_SLACK_MS;
  return signals.filter((s) => s.timestamp >= start && s.timestamp <= end);
}

/** Shell command printing every audit file of one agent (live files, plus the
 *  deletion mirror — an ephemeral one-shot agent may already be deleted). */
export function buildRunBlockReadCommand(agentId: string, home: string): string | null {
  if (!SAFE_AGENT_ID_RE.test(agentId)) return null;
  const logDir = `${home}/.shelly/agents/logs/${agentId}`;
  const mirror = `${home}/.shelly/agents/audits/${agentId}-agent-driver-audit.jsonl`;
  return (
    `for f in ${shellQuote(logDir)}/agent-driver-audit*.jsonl ${shellQuote(logDir)}/plan-executor-audit.jsonl ${shellQuote(mirror)}; do ` +
    `[ -f "$f" ] && cat "$f" && echo; done 2>/dev/null; true`
  );
}

/**
 * True when the audit trail shows a declined / denied / refused action inside
 * this run's window. Never throws; a read failure reads as false.
 */
export async function runHadBlockedAction(
  runCommand: (cmd: string) => Promise<string>,
  run: { agentId: string; timestamp?: number; durationMs?: number },
): Promise<boolean> {
  if (typeof run.timestamp !== 'number' || !Number.isFinite(run.timestamp)) return false;
  if (!SAFE_AGENT_ID_RE.test(run.agentId)) return false;
  try {
    const cmd = buildRunBlockReadCommand(run.agentId, homePath());
    if (!cmd) return false;
    const text = await runCommand(cmd);
    return blockSignalsForRun(parseRunBlockSignals(String(text ?? '')), {
      timestamp: run.timestamp,
      durationMs: run.durationMs,
    }).length > 0;
  } catch {
    return false;
  }
}
