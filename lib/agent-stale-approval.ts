/**
 * Stale approval-request screening (2026-11-01 on-device bug).
 *
 * The RN drains in app/_layout.tsx re-read every request file under
 * `~/.shelly/agents/escalations/` and `~/.shelly/agents/action-approvals/` on
 * each launch. A request whose run finished long ago (a `queued` escalation
 * left behind by a driver timeout, an action request the executor gave up on)
 * or whose agent was deleted kept re-notifying the user after every restart.
 *
 * This module decides — before any notification, chat ask or auto-approval —
 * whether such a request is stale, and if so drops it: the request file is
 * deleted and its notification cancelled. It NEVER answers a request: no
 * signed reply is written, nothing is accepted. A dropped request reads to
 * the waiting process (if any were still alive) exactly like an unanswered
 * one, which every executor already treats as a decline.
 */

/** Hard cap on how long any approval request stays askable. */
export const STALE_APPROVAL_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A NON-queued escalation is only answerable while its driver is still
 * waiting. The driver's wait is ESCALATION_TIMEOUT_MS (default 120 s, never
 * overridden by any Shelly caller); on timeout it either deletes the request
 * or rewrites it as `state: "queued"`. A live-state request much older than
 * that means the driver died mid-wait.
 */
export const LIVE_ESCALATION_MAX_WAIT_MS = 30 * 60_000;

/**
 * An action request past its own expiresAt is already ignored by the drain;
 * after this grace (so the executor's own timeout cleanup wins the race) the
 * leftover file is removed.
 */
export const ACTION_APPROVAL_EXPIRY_GRACE_MS = 10 * 60_000;

export type StaleApprovalReason = 'agent-gone' | 'expired' | 'run-not-live';

export function parseRequestTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

export type StaleEscalationInput = {
  state?: string | null;
  ts?: string | null;
  queuedAt?: string | null;
};

export type StaleActionApprovalInput = {
  ts?: string | null;
  expiresAt?: number | null;
};

/**
 * `agentGone` must be true only on a POSITIVE "this agent is deleted" signal
 * (see resolveAgentGone) — never on an unknown / failed lookup.
 */
export function escalationStaleReason(
  request: StaleEscalationInput,
  ctx: { agentGone: boolean; nowMs: number },
): StaleApprovalReason | null {
  if (ctx.agentGone) return 'agent-gone';
  const createdMs = parseRequestTimestampMs(request.ts) ?? parseRequestTimestampMs(request.queuedAt);
  if (createdMs !== null && ctx.nowMs - createdMs > STALE_APPROVAL_MAX_AGE_MS) return 'expired';
  if (request.state !== 'queued' && createdMs !== null && ctx.nowMs - createdMs > LIVE_ESCALATION_MAX_WAIT_MS) {
    return 'run-not-live';
  }
  return null;
}

export function actionApprovalStaleReason(
  request: StaleActionApprovalInput,
  ctx: { agentGone: boolean; nowMs: number },
): StaleApprovalReason | null {
  if (ctx.agentGone) return 'agent-gone';
  const createdMs = parseRequestTimestampMs(request.ts);
  if (createdMs !== null && ctx.nowMs - createdMs > STALE_APPROVAL_MAX_AGE_MS) return 'expired';
  const expiresAt = typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt) ? request.expiresAt : null;
  if (expiresAt !== null && ctx.nowMs - expiresAt > ACTION_APPROVAL_EXPIRY_GRACE_MS) return 'expired';
  return null;
}

/**
 * True only when the agent is positively known to be gone:
 *  - deleteAgent's tombstone (`.shelly/agents/.deleted/<id>`) exists, or
 *  - the agent store has loaded, does not contain the id, AND `<id>.json` is
 *    confirmed absent on disk.
 * A lookup that throws / returns null counts as "not known gone", so a
 * failed disk read (agent-manager falls back to an empty list) never drops
 * a live agent's ask.
 */
export async function resolveAgentGone(
  agentId: string,
  deps: {
    isSafeAgentId: (id: string) => boolean;
    storeLoaded: boolean;
    storeHasAgent: (id: string) => boolean;
    pathExists: (relativeToAgentsDir: string) => Promise<boolean | null>;
  },
): Promise<boolean> {
  if (!deps.isSafeAgentId(agentId)) return false;
  const tombstone = await deps.pathExists(`.deleted/${agentId}`).catch(() => null);
  if (tombstone === true) return true;
  if (!deps.storeLoaded || deps.storeHasAgent(agentId)) return false;
  const json = await deps.pathExists(`${agentId}.json`).catch(() => null);
  return json === false;
}

export type DropStaleDeps = {
  deleteRequestFile: () => Promise<void>;
  cancelNotification: () => Promise<void>;
  noteGone: () => void;
  log: (line: string) => void;
};

/**
 * Drop (never answer) a stale request: delete the file, cancel any
 * notification, withdraw any chat / MONITOR ask, and log one line.
 * Every step is best-effort and independent.
 */
export async function dropStaleApprovalRequest(
  label: string,
  reason: StaleApprovalReason,
  deps: DropStaleDeps,
): Promise<void> {
  await deps.deleteRequestFile().catch(() => undefined);
  await deps.cancelNotification().catch(() => undefined);
  try {
    deps.noteGone();
  } catch {
    // best-effort
  }
  deps.log(`stale request dropped ${label} reason=${reason}`);
}
