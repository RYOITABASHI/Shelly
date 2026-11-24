/**
 * lib/mcp-service-control.ts — the pure half of the MCP operation
 * `service_control` (P1 batch, stage S1): start / stop / status of a
 * long-running on-device process from a CLOSED registry.
 *
 * The caller names an action and a registered service id, nothing else: no
 * command, path or argument ever comes from the MCP client. What each id runs
 * is defined in native code (ManagedServices.kt REGISTRY), and the process
 * runs under the native supervisor (ManagedServiceSupervisor.kt, the same
 * shape as CodexRemoteHost), never from the MCP server's own process.
 *
 * Pure: no native module, no store, no timers. lib/mcp-server-bridge.ts does
 * the I/O (validation → approval → native call → audit).
 */

/** Keep in step with ManagedServices.ACTIONS (Kotlin). */
export const SERVICE_CONTROL_ACTIONS = ['start', 'status', 'stop'] as const;
export type ServiceControlAction = (typeof SERVICE_CONTROL_ACTIONS)[number];

/**
 * Keep in step with ManagedServices.REGISTRY (Kotlin); the parity test reads
 * the Kotlin source. `council-facade` is registered by shape only: its launch
 * spec lives on the device (~/.shelly/services/council-facade/) and is wired
 * in a later stage, so native answers `not_configured` for it today.
 */
export const SERVICE_IDS = ['article-delivery', 'council-facade'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** Keep in step with ManagedServices.State (Kotlin). */
export const SERVICE_STATES = ['running', 'starting', 'unhealthy', 'stopped', 'dead', 'not_configured'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/**
 * Outcome codes the native side returns (and writes to the audit line).
 * Keep in step with ManagedServiceSupervisor (Kotlin).
 */
export const SERVICE_RESULT_CODES = [
  'started',
  'already_running',
  'stopped',
  'not_running',
  'status',
  'halted',
  'not_configured',
  'not_installed',
  'launch_failed',
  'stop_failed',
] as const;
export type ServiceResultCode = (typeof SERVICE_RESULT_CODES)[number];

/** Refusals the bridge itself returns (before or around the native call). */
export type ServiceControlErrorCode =
  | 'disabled'
  | 'invalid_params'
  | 'denied'
  | 'revoked'
  | 'timeout'
  | 'native_error'
  | 'halted'
  | 'not_configured'
  | 'not_installed'
  | 'launch_failed'
  | 'stop_failed';

const ARG_KEYS = new Set(['action', 'serviceId']);

export type ServiceControlArgs = { action: ServiceControlAction; serviceId: ServiceId };

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function isServiceControlAction(v: unknown): v is ServiceControlAction {
  return typeof v === 'string' && (SERVICE_CONTROL_ACTIONS as readonly string[]).includes(v);
}

export function isServiceId(v: unknown): v is ServiceId {
  return typeof v === 'string' && (SERVICE_IDS as readonly string[]).includes(v);
}

/** Strict: exactly {action, serviceId}; anything else is invalid_params. */
export function validateServiceControlArgs(
  args: unknown,
): { ok: true; args: ServiceControlArgs } | { ok: false; code: 'invalid_params'; message: string } {
  const bad = (message: string) => ({ ok: false as const, code: 'invalid_params' as const, message });
  if (!isPlainRecord(args)) return bad('arguments must be an object');
  const extra = Object.keys(args).find((k) => !ARG_KEYS.has(k));
  if (extra !== undefined) return bad(`unknown argument: ${extra.slice(0, 40)}`);
  const { action, serviceId } = args;
  if (!isServiceControlAction(action)) return bad(`action must be one of: ${SERVICE_CONTROL_ACTIONS.join(', ')}`);
  if (!isServiceId(serviceId)) return bad(`serviceId must be one of: ${SERVICE_IDS.join(', ')}`);
  return { ok: true, args: { action, serviceId } };
}

export type ServiceStatus = {
  serviceId: ServiceId;
  state: ServiceState;
  pid: number | null;
  startedAt: number | null;
  lastHeartbeatAt: number | null;
  /** The process runs under Shelly's native supervisor (false: started elsewhere, e.g. a terminal tab). */
  supervised: boolean;
  /** Last recorded exit of a supervised process (present for `dead`). */
  exitCode?: number;
  exitedAt?: number;
};

export type ServiceControlResult = { code: ServiceResultCode; status: ServiceStatus };

function nullableTime(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Parses what the native `serviceControl` returns. Null when anything is off
 * (unknown code / state, wrong id, malformed numbers): the bridge then answers
 * `native_error` instead of passing an unchecked shape to the client.
 */
export function parseServiceControlResult(raw: unknown, expectedId: ServiceId): ServiceControlResult | null {
  if (!isPlainRecord(raw)) return null;
  const { code, serviceId, state, pid, startedAt, lastHeartbeatAt, supervised, exitCode, exitedAt } = raw;
  if (typeof code !== 'string' || !(SERVICE_RESULT_CODES as readonly string[]).includes(code)) return null;
  if (serviceId !== expectedId) return null;
  if (typeof state !== 'string' || !(SERVICE_STATES as readonly string[]).includes(state)) return null;
  const p = pid === null || pid === undefined ? null : (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined);
  if (p === undefined) return null;
  const s = nullableTime(startedAt);
  const hb = nullableTime(lastHeartbeatAt);
  if (s === undefined || hb === undefined) return null;
  if (typeof supervised !== 'boolean') return null;
  const status: ServiceStatus = { serviceId: expectedId, state: state as ServiceState, pid: p, startedAt: s, lastHeartbeatAt: hb, supervised };
  if (exitCode !== undefined && exitCode !== null) {
    if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode)) return null;
    status.exitCode = exitCode;
  }
  if (exitedAt !== undefined && exitedAt !== null) {
    const e = nullableTime(exitedAt);
    if (e === undefined || e === null) return null;
    status.exitedAt = e;
  }
  return { code: code as ServiceResultCode, status };
}

/** Codes that mean the action did not happen; returned as an MCP error (status still attached). */
export const SERVICE_FAILURE_CODES: ReadonlySet<ServiceResultCode> = new Set([
  'halted', 'not_configured', 'not_installed', 'launch_failed', 'stop_failed',
]);

// ── Always-allow readiness (not enabled in v1) ─────────────────────────────
//
// v1 asks for a tap on every call. A later stage may let the owner add an
// always-allow rule for this op through lib/mcp-always-allow.ts. The target a
// rule would name is fixed here so that step is only: add 'service_control'
// to TYPED_OPS (here and McpAlwaysAllowStore.TYPED_OPS), map it to
// SERVICE_CONTROL_TARGET_RE in TARGET_RES, and consult the store in the
// bridge after the halted check. A rule names ONE service and ONE action
// (a `status` rule never covers `start`).

export const SERVICE_CONTROL_TARGET_RE = /^service:(article-delivery|council-facade):(start|status|stop)$/;

/** The canonical always-allow target for these arguments: `service:<id>:<action>`. */
export function serviceControlRuleTarget(args: ServiceControlArgs): string {
  return `service:${args.serviceId}:${args.action}`;
}
