/**
 * lib/mcp-pipeline-refire.ts — the pure half of the MCP typed operation
 * `request_pipeline_refire` (search parity item 4).
 *
 * The caller names one article pipeline id and nothing else: no prompt, no
 * topic, no time, no free text. What it can cause is the S5 re-fire of that
 * pipeline's run today (RunRecovery / scripts/shelly-run-recovery.js): the
 * same intent, dispatch and settling as a recovery re-fire, never a new
 * execution path. So the caller contributes only "which owner-approved
 * pipeline, and when". Native decides everything else, in this order:
 *   1. STOP-ALL                      → halted
 *   2. the pipeline's web-search opt-in is on now (the owner's Settings
 *      toggle, bound to the definition hash) → else unknown_pipeline /
 *      not_opted_in
 *   3. today's newest run of that pipeline ended held / failed / dead, did
 *      not save its draft, has no re-run requested or decided yet, and fewer
 *      than the daily maximum of requests were accepted today
 *      → else no_run_today / run_active / delivered / not_recoverable /
 *        daily_limit; a repeat of today's request is `duplicate` (one re-fire)
 * An accepted request is a line in the agent's own audit, so it outlives an
 * app kill, an update or a reboot; a sweep turns it into the re-fire.
 *
 * Pure: no native module, no store, no timers. lib/mcp-server-bridge.ts does
 * the I/O (validation → refusals → approval ladder → native call → audit).
 */

/** Same form as the article-pipelines.json id (PIPELINE_ID_RE in the recovery script). */
export const PIPELINE_ID_RE = /^[a-z0-9-]{1,32}$/;

/** Accepted outcomes: a new request, or today's request already there (no second re-fire). */
export const PIPELINE_REFIRE_ACCEPT_CODES = ['accepted', 'duplicate'] as const;

/**
 * Refusals native returns (RunRecovery.requestRefire, TerminalEmulatorModule
 * requestPipelineRefire). Keep in step with the recovery script's
 * refireRequestDecision / opRefireRequest and the module.
 */
export const PIPELINE_REFIRE_NATIVE_REFUSALS = [
  'invalid_params',
  'halted',
  'unknown_pipeline',
  'not_opted_in',
  'no_run_today',
  'run_active',
  'delivered',
  'not_recoverable',
  'daily_limit',
  'audit_unreadable',
  'not_recorded',
  'native_error',
] as const;

export type PipelineRefireNativeCode =
  | (typeof PIPELINE_REFIRE_ACCEPT_CODES)[number]
  | (typeof PIPELINE_REFIRE_NATIVE_REFUSALS)[number];

/** Every refusal the bridge can answer for this op (its own and native's). */
export type PipelineRefireErrorCode =
  | 'disabled'
  | 'denied'
  | 'not_attended'
  | 'target_changed'
  | 'revoked'
  | 'timeout'
  | (typeof PIPELINE_REFIRE_NATIVE_REFUSALS)[number];

export type PipelineRefireArgs = { pipelineId: string };

const ARG_KEYS = new Set(['pipelineId']);
const REQUEST_ID_RE = /^rq-[0-9]{1,16}-[0-9a-f]{8}$/;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Strict: exactly {pipelineId}; any other key or form is invalid_params. */
export function validatePipelineRefireArgs(
  args: unknown,
): { ok: true; args: PipelineRefireArgs } | { ok: false; code: 'invalid_params'; message: string } {
  const bad = (message: string) => ({ ok: false as const, code: 'invalid_params' as const, message });
  if (!isPlainRecord(args)) return bad('arguments must be an object');
  const extra = Object.keys(args).find((k) => !ARG_KEYS.has(k));
  if (extra !== undefined) return bad(`unknown argument: ${extra.slice(0, 40)}`);
  const { pipelineId } = args;
  if (typeof pipelineId !== 'string' || !PIPELINE_ID_RE.test(pipelineId)) {
    return bad('pipelineId must be an article pipeline id (a-z, 0-9, -; 1-32 characters)');
  }
  return { ok: true, args: { pipelineId } };
}

export type PipelineRefireResult = { code: PipelineRefireNativeCode; requestId: string | null };

/**
 * Parses what the native `requestPipelineRefire` returns ({code, requestId}).
 * Null when anything is off: the bridge then answers native_error instead of
 * passing an unchecked shape to the client.
 */
export function parsePipelineRefireResult(raw: unknown): PipelineRefireResult | null {
  if (!isPlainRecord(raw)) return null;
  const { code, requestId } = raw;
  const known = [...PIPELINE_REFIRE_ACCEPT_CODES, ...PIPELINE_REFIRE_NATIVE_REFUSALS] as readonly string[];
  if (typeof code !== 'string' || !known.includes(code)) return null;
  if (requestId !== undefined && requestId !== null && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) return null;
  return { code: code as PipelineRefireNativeCode, requestId: typeof requestId === 'string' ? requestId : null };
}

export function isPipelineRefireAccepted(code: PipelineRefireNativeCode): boolean {
  return (PIPELINE_REFIRE_ACCEPT_CODES as readonly string[]).includes(code);
}

// ── Always-allow ───────────────────────────────────────────────────────────
//
// A typed op of lib/mcp-always-allow.ts (TYPED_OPS there and
// McpAlwaysAllowStore.TYPED_OPS). A rule names ONE pipeline. It only skips
// the dialog: native's checks (STOP-ALL, the opt-in, today's run, the daily
// maximum, duplicates) run on every call, rule or not.

export const PIPELINE_REFIRE_TARGET_RE = /^pipeline:[a-z0-9-]{1,32}$/;

/** The canonical always-allow target: `pipeline:<id>`. */
export function pipelineRefireRuleTarget(args: PipelineRefireArgs): string {
  return `pipeline:${args.pipelineId}`;
}

/**
 * v1: the binding names only the target. What a re-fire runs is the
 * pipeline's definition, and native refuses unless the owner's opt-in is
 * bound to that definition's current hash (an edit lapses it), so a rule
 * cannot outlive a definition change in effect. Bump when that changes.
 */
export const PIPELINE_REFIRE_BIND_DOMAIN = 'shelly-pipeline-refire-bind-v1:';

/** sha256 hex of `PIPELINE_REFIRE_BIND_DOMAIN + target` (64 lowercase hex). */
export async function pipelineRefireRuleBind(
  args: PipelineRefireArgs,
  sha256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(`${PIPELINE_REFIRE_BIND_DOMAIN}${pipelineRefireRuleTarget(args)}`));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The rule label shown in Settings / the dialog: `re-run <pipelineId>` (closed alphabet). */
export function pipelineRefireRuleLabel(args: PipelineRefireArgs): string {
  return `re-run ${args.pipelineId}`;
}
