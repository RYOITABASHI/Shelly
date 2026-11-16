/**
 * lib/mcp-typed-ops.ts — the pure half of the MCP typed operations `run_agent`
 * and `get_run_result` (plan "typed MCP operations with always-allow rules",
 * sections (b) and (c); DEFERRED.md「MCP の入口」 item 3).
 *
 * Pure: no native module, no store, no timers. lib/mcp-server-bridge.ts does
 * the I/O and runs the deny order; this file holds
 *  - strict argument validation (unknown keys → invalid_params),
 *  - the agent binding projection + its canonical hash (a rule is bound to the
 *    agent's security-relevant definition: an edit voids it),
 *  - the step 5–7 classifier (STOP-ALL, ingress taint, POLICY-001 deny /
 *    draft_only or a CRITICAL cli action) — a rule is consulted only after it,
 *    so a rule can never rescue any of these,
 *  - the error codes, and
 *  - the ticket → get_run_result response mapping (preview, byte-capped and
 *    redacted output, `untrusted: true`).
 */
import type { Agent, AgentAction } from '@/store/types';
import type { LoadedUserPolicy } from '@/lib/agent-user-policy-store';
import { describeApprovalRequest, evaluateActionPolicy } from '@/lib/agent-action-policy';
import { checkCommandSafety } from '@/lib/command-safety';
import { canonicalJson, MCP_PRINCIPAL_RE, type Sha256 } from '@/lib/mcp-request-auth';

// ── Error codes (plan (c) "Error shape") ──────────────────────────────────

export const TYPED_OP_ERROR_CODES = [
  'disabled',
  'invalid_params',
  'unknown_agent',
  'halted',
  'tainted',
  'policy_denied',
  'not_attended',
  'denied_by_user',
  'approval_timeout',
  'revoked',
  'target_changed',
  'busy',
  'launch_failed',
  'unknown_handle',
] as const;
export type TypedOpErrorCode = (typeof TYPED_OP_ERROR_CODES)[number];

export type TypedOpRefusal = { code: TypedOpErrorCode; message: string };

export const TYPED_OPS_DISABLED_MESSAGE = 'typed operations are disabled (Settings → Agents → MCP: Allow typed operations)';

// ── Arguments ─────────────────────────────────────────────────────────────

export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const RUN_HANDLE_RE = /^mr_[0-9a-f]{32}$/;

export const GET_RUN_RESULT_MAX_WAIT_MS = 20_000;
export const RUN_OUTPUT_DEFAULT_BYTES = 16 * 1024;
export const RUN_OUTPUT_MAX_BYTES = 64 * 1024;
/** Re-read period of the get_run_result long-poll. */
export const RUN_RESULT_POLL_MS = 500;
/** A repeated requestId within this window returns the existing handle. */
export const REQUEST_ID_WINDOW_MS = 10 * 60_000;
/** Live (accepted / running) MCP runs one principal may have at once. */
export const MAX_LIVE_RUNS_PER_PRINCIPAL = 2;
export const PREVIEW_MAX_CHARS = 500;
/**
 * A typed-op request is answered within this long after the server signed it
 * (scripts/shelly-mcp-server.js RESULT_TIMEOUT_MS) or never: the client has
 * given up by then, so it is dropped (both consumers), a dialog never outlives
 * it, and nothing launches after it.
 */
export const TYPED_REQUEST_DEADLINE_MS = 100_000;

const RUN_AGENT_KEYS = new Set(['agentId', 'requestId']);
const GET_RUN_RESULT_KEYS = new Set(['runHandle', 'waitMs', 'maxBytes']);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function unknownKey(args: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(args).find((k) => !allowed.has(k)) ?? null;
}

export type RunAgentArgs = { agentId: string; requestId: string | null };

export function validateRunAgentArgs(args: unknown): { ok: true; args: RunAgentArgs } | { ok: false; refusal: TypedOpRefusal } {
  const bad = (message: string) => ({ ok: false as const, refusal: { code: 'invalid_params' as const, message } });
  if (!isPlainRecord(args)) return bad('arguments must be an object');
  const extra = unknownKey(args, RUN_AGENT_KEYS);
  if (extra !== null) return bad(`unknown argument: ${extra.slice(0, 40)}`);
  const { agentId, requestId } = args;
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return bad('agentId must match ^[A-Za-z0-9_-]{1,128}$');
  if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) {
    return bad('requestId must match ^[A-Za-z0-9_-]{8,64}$');
  }
  return { ok: true, args: { agentId, requestId: typeof requestId === 'string' ? requestId : null } };
}

export type GetRunResultArgs = { runHandle: string; waitMs: number; maxBytes: number };

/** Numbers are clamped (waitMs to [0, 20000], maxBytes to [1, 65536]); a non-finite one is refused. */
export function validateGetRunResultArgs(args: unknown): { ok: true; args: GetRunResultArgs } | { ok: false; refusal: TypedOpRefusal } {
  const bad = (message: string) => ({ ok: false as const, refusal: { code: 'invalid_params' as const, message } });
  if (!isPlainRecord(args)) return bad('arguments must be an object');
  const extra = unknownKey(args, GET_RUN_RESULT_KEYS);
  if (extra !== null) return bad(`unknown argument: ${extra.slice(0, 40)}`);
  const { runHandle, waitMs, maxBytes } = args;
  if (typeof runHandle !== 'string' || !RUN_HANDLE_RE.test(runHandle)) return bad('runHandle must match ^mr_[0-9a-f]{32}$');
  if (waitMs !== undefined && (typeof waitMs !== 'number' || !Number.isFinite(waitMs))) return bad('waitMs must be a number');
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes))) return bad('maxBytes must be a number');
  return {
    ok: true,
    args: {
      runHandle,
      waitMs: waitMs === undefined ? 0 : Math.min(GET_RUN_RESULT_MAX_WAIT_MS, Math.max(0, Math.floor(waitMs as number))),
      maxBytes: maxBytes === undefined ? RUN_OUTPUT_DEFAULT_BYTES : Math.min(RUN_OUTPUT_MAX_BYTES, Math.max(1, Math.floor(maxBytes as number))),
    },
  };
}

// ── Binding (ASSUMPTION A4, plan (b)) ─────────────────────────────────────

/** Security-relevant Agent fields a rule is bound to. Runtime fields
 *  (lastRun, lastResult, nextExpectedAt, oneShot*, …) are left out, so a rule
 *  survives runs but not edits. McpAgentBinding.BIND_FIELDS (Kotlin) lists the
 *  same fields; the shared fixture test keeps them in step. */
export const AGENT_BIND_FIELDS = [
  'prompt',
  'tool',
  'toolPinned',
  'autonomous',
  'requireActionApproval',
  'autonomyLevel',
  'workspaceRoot',
  'outputPath',
  'action',
  'actions',
  'orchestration',
  'skillId',
  'notificationTrigger',
  'runOn',
  'memory',
] as const;

/**
 * Every bind field, absent ones as null (so absent and undefined hash the same).
 * The values are normalized through a JSON round trip, i.e. to exactly what
 * `~/.shelly/agents/<id>.json` holds (agent-manager writes JSON.stringify of
 * the agent): a nested `undefined` key disappears, a non-finite number becomes
 * null. The native consumer (McpAgentBinding.kt, PR 6) hashes the on-disk JSON,
 * so a rule created from the in-memory agent must hash the same bytes.
 * Fixture: __tests__/fixtures/mcp-agent-binding-cases.json.
 */
export function agentBindingProjection(agent: Partial<Agent>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = agent as Record<string, unknown>;
  for (const f of AGENT_BIND_FIELDS) out[f] = src[f] === undefined ? null : src[f];
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** bind = sha256(canonicalJson(projection)), 64 lowercase hex. */
export async function agentBindingHash(agent: Partial<Agent>, sha256: Sha256): Promise<string> {
  return hex(await sha256(new TextEncoder().encode(canonicalJson(agentBindingProjection(agent)))));
}

// ── Steps 5–7: deny classes a rule never rescues ──────────────────────────

/** The agent's declared actions (`action` and `actions`), without duplicates by reference. */
export function declaredActions(agent: Pick<Agent, 'action' | 'actions'>): AgentAction[] {
  const out: AgentAction[] = [];
  if (agent.action && typeof agent.action === 'object') out.push(agent.action);
  if (Array.isArray(agent.actions)) for (const a of agent.actions) if (a && typeof a === 'object' && !out.includes(a)) out.push(a);
  return out;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]*@)?([^/?#:\s]+)/i.exec(url.trim());
  return m ? m[2].toLowerCase() : null;
}

export type RunAgentDenyInput = {
  agentId: string;
  agent: Pick<Agent, 'action' | 'actions'>;
  /** STOP-ALL: the store's `halted` or the `.halted` sentinel. */
  halted: boolean;
  /** isAgentIngressTainted (true when the taint store is unreadable / overflows). */
  tainted: boolean;
  /** POLICY-001 user rules; null = could not be loaded. */
  policy: LoadedUserPolicy | null;
  /** Bare app home, for `~` in path rules. */
  homeDir: string;
};

/** `refusal` null = not refused. `ruleEligible` false: the user's policy rules
 *  could not be read / verified and the agent declares ANY action, so an
 *  always-allow rule must not skip the tap (fail closed; the owner still
 *  decides). Mirrors native step 7 (McpTypedOpPolicy): only an agent with no
 *  declared action at all is clearable without a readable policy — a deny or
 *  draft_only rule the unreadable policy may hold can match any action type.
 *  Always false with a refusal. */
export type RunAgentDenyResult = { refusal: TypedOpRefusal | null; ruleEligible: boolean };

/**
 * Steps 5–7 of the deny order, in that order. A deny here is final: the
 * bridge consults the always-allow store only after this returns no refusal.
 * CRITICAL (ASSUMPTION A2): a POLICY-001 user deny / draft_only rule matching
 * a declared side-effecting action, or a cli action whose command
 * checkCommandSafety rates CRITICAL.
 */
export function classifyRunAgentDeny(input: RunAgentDenyInput): RunAgentDenyResult {
  if (input.halted) return { refusal: { code: 'halted', message: 'all agents are stopped (STOP-ALL is on)' }, ruleEligible: false };
  if (input.tainted) {
    return { refusal: { code: 'tainted', message: 'this agent was created or changed over MCP (or the ingress-mark store is unreadable); it is not started over MCP' }, ruleEligible: false };
  }
  const policyUnavailable = !input.policy || input.policy.unavailable;
  const actions = declaredActions(input.agent);
  for (const action of actions) {
    const type = typeof action.type === 'string' ? action.type : 'unknown';
    const command = type === 'cli' && typeof action.command === 'string' ? action.command : '';
    if (type === 'cli' && command && checkCommandSafety(command).level === 'CRITICAL') {
      return { refusal: { code: 'policy_denied', message: 'a cli action of this agent is rated CRITICAL' }, ruleEligible: false };
    }
    const desc = describeApprovalRequest({
      agentId: input.agentId,
      actionType: type,
      command,
      intentMode: action.intentMode ?? null,
      intentTarget: action.intentTarget ?? null,
      intentShareText: action.intentShareText ?? null,
      dmReplyText: action.dmReplyText ?? null,
      destinationHost: hostOf(action.webhookUrl),
      preview: '',
      origin: 'event',
    });
    if (!input.policy) continue;
    const verdict = evaluateActionPolicy(desc, {
      enabled: true,
      rules: input.policy.data.rules,
      homeDir: input.homeDir,
      rulesUnavailable: input.policy.unavailable,
    });
    if (verdict.decision === 'deny' || verdict.decision === 'draft_only') {
      return { refusal: { code: 'policy_denied', message: `refused by your agent safety rules (${verdict.decision}) for a ${type} action` }, ruleEligible: false };
    }
  }
  return { refusal: null, ruleEligible: !(policyUnavailable && actions.length > 0) };
}

// ── Tickets → get_run_result ──────────────────────────────────────────────

export const RUN_STATES = ['accepted', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'lost'] as const;
export type RunState = (typeof RUN_STATES)[number];
const TERMINAL_STATES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'skipped', 'cancelled', 'lost']);
const LIVE_STATES: ReadonlySet<string> = new Set(['accepted', 'running']);
const REASON_RE = /^[a-z_]{1,32}$/;

export type McpRunTicket = {
  handle: string;
  principal: string;
  requestId?: string;
  agentId: string;
  state: RunState;
  reason?: string;
  acceptedAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  runLog?: { timestamp: number; status: string; outputPreview: string; errorMessage: string; savedPath?: string };
  outputFile?: string;
};

export function isTerminalRunState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Parses one ticket object (native encode()). Null when malformed. Untrusted: fields are checked, not believed. */
export function parseRunTicket(raw: unknown): McpRunTicket | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainRecord(o)) return null;
  const { handle, principal, requestId, agentId, state, reason, acceptedAt, startedAt, finishedAt, exitCode, runLog, outputFile } = o;
  if (o.v !== 1 || typeof handle !== 'string' || !RUN_HANDLE_RE.test(handle)) return null;
  if (typeof principal !== 'string' || !MCP_PRINCIPAL_RE.test(principal)) return null;
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
  if (typeof state !== 'string' || !(RUN_STATES as readonly string[]).includes(state)) return null;
  if (!isNum(acceptedAt)) return null;
  if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) return null;
  if (reason !== undefined && (typeof reason !== 'string' || !REASON_RE.test(reason))) return null;
  if (startedAt !== undefined && !isNum(startedAt)) return null;
  if (finishedAt !== undefined && !isNum(finishedAt)) return null;
  if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) return null;
  if (outputFile !== undefined && outputFile !== `${handle}.out`) return null;
  const t: McpRunTicket = { handle, principal, agentId, state: state as RunState, acceptedAt };
  if (requestId !== undefined) t.requestId = requestId as string;
  if (reason !== undefined) t.reason = reason as string;
  if (startedAt !== undefined) t.startedAt = startedAt as number;
  if (finishedAt !== undefined) t.finishedAt = finishedAt as number;
  if (exitCode !== undefined) t.exitCode = exitCode as number;
  if (outputFile !== undefined) t.outputFile = outputFile as string;
  if (runLog !== undefined) {
    if (!isPlainRecord(runLog)) return null;
    const { timestamp, status, outputPreview, errorMessage, savedPath } = runLog;
    if (!isNum(timestamp) || typeof status !== 'string' || typeof outputPreview !== 'string' || typeof errorMessage !== 'string') return null;
    if (savedPath !== undefined && typeof savedPath !== 'string') return null;
    t.runLog = { timestamp, status, outputPreview, errorMessage };
    if (typeof savedPath === 'string') t.runLog.savedPath = savedPath;
  }
  return t;
}

/** Parses the native list (listMcpRunTickets); malformed entries are skipped. Null when the list itself is unusable. */
export function parseRunTicketList(raw: unknown): McpRunTicket[] | null {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const out: McpRunTicket[] = [];
  for (const item of arr) {
    const t = parseRunTicket(item);
    if (t) out.push(t);
  }
  return out;
}

/** The ticket a repeated requestId refers to: same principal, same requestId, accepted within the window. */
export function findIdempotentTicket(
  tickets: readonly McpRunTicket[],
  principal: string,
  requestId: string,
  now: number,
): McpRunTicket | null {
  let best: McpRunTicket | null = null;
  for (const t of tickets) {
    if (t.principal !== principal || t.requestId !== requestId) continue;
    if (now - t.acceptedAt > REQUEST_ID_WINDOW_MS || t.acceptedAt - now > 60_000) continue;
    if (!best || t.acceptedAt > best.acceptedAt) best = t;
  }
  return best;
}

export function liveRunCount(tickets: readonly McpRunTicket[], principal: string): number {
  return tickets.filter((t) => t.principal === principal && LIVE_STATES.has(t.state)).length;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes (never splits a character). */
export function cutToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  // Binary search on code-point boundaries.
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(cps.slice(0, mid).join('')) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join('');
}

function clipChars(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join('');
}

export type RunResultResponse = {
  runHandle: string;
  agentId: string;
  state: RunState;
  reason?: string;
  acceptedAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number;
  result?: {
    status: string;
    preview: string;
    savedPath?: string;
    output?: string;
    outputBytes: number;
    truncated: boolean;
  };
  untrusted: true;
};

/**
 * The get_run_result body for a ticket. `rawOutput` is the run's output
 * snapshot (or null); it is redacted FIRST and then cut to `maxBytes`, so a
 * cut never exposes half a redacted secret's surroundings in a new shape.
 * `outputBytes` is the redacted output's full size. Everything text-shaped
 * goes through `redact`. Always `untrusted: true`.
 */
export function buildRunResultResponse(
  ticket: McpRunTicket,
  rawOutput: string | null,
  maxBytes: number,
  redact: (text: string) => string,
): RunResultResponse {
  const out: RunResultResponse = {
    runHandle: ticket.handle,
    agentId: ticket.agentId,
    state: ticket.state,
    acceptedAt: ticket.acceptedAt,
    untrusted: true,
  };
  if (ticket.reason !== undefined) out.reason = ticket.reason;
  if (ticket.startedAt !== undefined) out.startedAt = ticket.startedAt;
  if (ticket.finishedAt !== undefined) out.finishedAt = ticket.finishedAt;
  if (ticket.startedAt !== undefined && ticket.finishedAt !== undefined && ticket.finishedAt >= ticket.startedAt) {
    out.durationMs = ticket.finishedAt - ticket.startedAt;
  }
  if (ticket.exitCode !== undefined) out.exitCode = ticket.exitCode;
  if (ticket.runLog || rawOutput !== null) {
    const cap = Math.min(RUN_OUTPUT_MAX_BYTES, Math.max(1, Math.floor(maxBytes)));
    const redacted = rawOutput === null ? null : redact(rawOutput);
    const cut = redacted === null ? null : cutToBytes(redacted, cap);
    out.result = {
      status: ticket.runLog ? clipChars(ticket.runLog.status, 32) : ticket.state,
      preview: ticket.runLog ? clipChars(redact(ticket.runLog.outputPreview), PREVIEW_MAX_CHARS) : '',
      outputBytes: redacted === null ? 0 : utf8Bytes(redacted),
      truncated: redacted !== null && cut !== redacted,
    };
    if (ticket.runLog?.savedPath) out.result.savedPath = redact(ticket.runLog.savedPath);
    if (cut !== null) out.result.output = cut;
  }
  return out;
}
