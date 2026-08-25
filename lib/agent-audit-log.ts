/**
 * lib/agent-audit-log.ts — reads scripts/shelly-agent-driver.js's boundary-gate
 * audit trail so the Agent Runs pane can show a per-run "flight recorder"
 * timeline (Fable5 product review, 2026-08-25: the boundary gate —
 * lib/agent-boundary-policy.ts's classifyProposedCommand, "the one genuinely
 * novel mechanism" in the product — decides allow/deny/gray on every command
 * an unattended agent proposes, but that decision was completely invisible to
 * the user. This module is the read side that makes it visible).
 *
 * ON-DISK CONTRACT (read-only here — owned by scripts/shelly-agent-driver.js;
 * this file must never write to it):
 *
 *   ~/.shelly/agents/logs/<agentId>/agent-driver-audit.jsonl
 *
 * is a single APPEND-ONLY JSONL file per agent, one line per driver audit
 * event, written by createAuditWriter()/gateLine() via `fs.appendFileSync`
 * (see shelly-agent-driver.js; the capability broker invoked from a PlanSpec
 * run — shelly-capability-broker.js via shelly-plan-executor.js — appends
 * its own event kinds to the SAME file/path convention). It is never per-run
 * and never rotated/truncated by the driver, so it accumulates every gate
 * decision across every run of that agent since creation.
 *
 * `deleteAgent` (lib/agent-manager.ts) removes the whole `logs/<agentId>/`
 * directory, but first `cp`s this file to a mirror that survives deletion:
 *
 *   ~/.shelly/agents/audits/<agentId>-agent-driver-audit.jsonl
 *
 * — the same path already surfaced to the user as plain text in
 * hooks/use-ai-pane-dispatch.ts's agent-creation confirmation ("Audit: …").
 * The generated run script also refreshes this mirror at the end of every
 * run (finish() → mirror_driver_audit_to_app_private), so for a still-live
 * agent it is never more than one run stale.
 *
 * Each line is `{ ts: <ISO string>, kind: <string>, ...redacted payload }`.
 * The lines this module cares about have `kind === 'gate_decision'`
 * (written by shelly-agent-driver.js's gateLine(), once per boundary-gate
 * approval prompt) and additionally carry:
 *   command          — the proposed command, ALREADY redacted by the driver
 *   verdictDecision  — GateVerdict.decision ('allow'|'deny'|'gray'), the
 *                       actual lib/agent-boundary-policy.ts classification
 *   signals          — GateVerdict.signals (BoundarySignal[])
 *   reason           — GateVerdict.reason
 *   level            — the agent's AutonomyLevel at decision time
 * Every other `kind` (thread_started, escalation_*, driver_start, the
 * broker's http.request audit events, …) is lifecycle noise, not a gate
 * decision, and is filtered out here.
 *
 * CORRELATING A LINE TO ONE RUN: the audit file carries no run/thread id
 * that AgentRunLog (store/types.ts) also records, so a line is attributed to
 * the run whose [timestamp - durationMs, timestamp] window (both
 * millisecond fields already on AgentRunLog) contains it, with a few
 * seconds of slack — the generated run script stamps both TS and DURATION
 * at whole-second granularity (`TS=$(date +%s)`), so no finer correlation is
 * available or meaningful.
 */
import type { AutonomyLevel, BoundarySignal, GateDecision } from '@/lib/agent-boundary-policy';
import { getHomePath } from '@/lib/home-path';

/** One boundary-gate decision, ready to render as a flight-recorder row. */
export interface FlightRecorderEntry {
  /** Epoch ms, parsed from the audit line's ISO `ts`. */
  timestamp: number;
  decision: GateDecision;
  /** Already redacted by the driver before it was written — safe to render
   *  as-is; callers should still truncate it for a single-line row (see
   *  lib/agent-runs-view.ts's truncateGateCommand). */
  command: string;
  reason: string;
  signals: BoundarySignal[];
  level?: AutonomyLevel;
}

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Best-effort decision normalisation for a line whose verdictDecision is
 * missing — e.g. the approval handler itself threw before a verdict was
 * ever computed (see shelly-agent-driver.js's catch-block gateLine call,
 * which has no GateVerdict to attach). Falls back to 'gray' (an
 * escalate/uncertain outcome) rather than ever silently painting a
 * no-verdict line green.
 */
function normalizeDecision(rawDecision: unknown, rawAnswer: unknown): GateDecision {
  if (rawDecision === 'allow' || rawDecision === 'deny' || rawDecision === 'gray') return rawDecision;
  if (rawAnswer === 'n') return 'deny';
  return 'gray';
}

/**
 * Parse raw JSONL text into flight-recorder entries, oldest first. Pure —
 * no I/O — so it is unit-testable without a shell round-trip. Malformed or
 * non-`gate_decision` lines are silently skipped, the same tolerance
 * lib/agent-manager.ts's readAgentRunLogs already applies to the sibling
 * per-run `*.json` logs.
 */
export function parseFlightRecorderLog(text: string): FlightRecorderEntry[] {
  const entries: FlightRecorderEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || parsed.kind !== 'gate_decision') continue;
    const timestamp = Date.parse(String(parsed.ts));
    if (!Number.isFinite(timestamp)) continue;
    entries.push({
      timestamp,
      decision: normalizeDecision(parsed.verdictDecision, parsed.answer),
      command: typeof parsed.command === 'string' ? parsed.command : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      signals: Array.isArray(parsed.signals) ? (parsed.signals as BoundarySignal[]) : [],
      level: typeof parsed.level === 'string' ? (parsed.level as AutonomyLevel) : undefined,
    });
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/** Slack around a run's [timestamp - durationMs, timestamp] window, to
 *  absorb the generated script's whole-second TS/DURATION granularity. */
const WINDOW_SLACK_MS = 5_000;

/**
 * Entries whose ts falls within one run's time window (inclusive, with
 * WINDOW_SLACK_MS slack on both ends). A non-positive `durationMs` (e.g. a
 * malformed or never-timed log) collapses to a zero-width window at
 * `timestamp`, which still works — it just relies entirely on the slack.
 */
export function entriesForRun(
  entries: FlightRecorderEntry[],
  run: { timestamp: number; durationMs: number },
): FlightRecorderEntry[] {
  const end = run.timestamp + WINDOW_SLACK_MS;
  const start = run.timestamp - Math.max(run.durationMs, 0) - WINDOW_SLACK_MS;
  return entries.filter((e) => e.timestamp >= start && e.timestamp <= end);
}

/**
 * Read the full flight-recorder log for one agent (every retained gate
 * decision across every run — callers slice it down to one run's window via
 * entriesForRun). Prefers the live per-agent-logs path, which is always
 * current for a not-yet-deleted agent; falls back to the deletion-surviving
 * `audits/` mirror when the live file is empty or missing (a deleted agent,
 * or one whose logs/ dir was otherwise cleaned up).
 *
 * Never throws — a read failure returns an empty array so a missing or
 * corrupt audit trail can never blank the rest of the run detail this is
 * attached to (the same contract lib/agent-manager.ts's readAgentRunLogs
 * already keeps for the sibling per-run `*.json` logs).
 */
export async function readAgentFlightRecorder(
  runCommand: (cmd: string) => Promise<string>,
  agentId: string,
): Promise<FlightRecorderEntry[]> {
  if (!SAFE_AGENT_ID_RE.test(agentId)) return [];
  const home = getHomePath();
  const livePath = `${home}/.shelly/agents/logs/${agentId}/agent-driver-audit.jsonl`;
  const mirrorPath = `${home}/.shelly/agents/audits/${agentId}-agent-driver-audit.jsonl`;
  const command =
    `if [ -s ${shellQuote(livePath)} ]; then cat ${shellQuote(livePath)}; ` +
    `else cat ${shellQuote(mirrorPath)} 2>/dev/null || true; fi`;
  try {
    const output = await runCommand(command);
    return parseFlightRecorderLog(output);
  } catch {
    return [];
  }
}
