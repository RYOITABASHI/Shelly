/**
 * lib/closepaw-queue.ts — `shelly closepaw "<goal>"` shell → RN bridge.
 *
 * A shell process (the user's PTY shell, or Codex's non-interactive
 * `bash -lc` inside it) cannot `am start` an Activity under Knox, so the
 * native `$HOME/bin/shelly` helper shim (HomeInitializer.kt,
 * SHELLY_HELPER_SHIM v7) appends ONE line to `$HOME/.shelly-command-queue`:
 *
 *   closepaw:<reqId>:<tsMs>:<encodeURIComponent(goal)>
 *
 * app/_layout.tsx's drainCommandQueue hands it to processClosePawQueueLine()
 * below, which validates it, fires the SAME native
 * fireAgentIntent('closepaw', '', goal) path agent hand-offs use (same
 * sanitizer, same 2000-code-point cap, only the "goal" extra), and writes
 * `$HOME/.shelly-closepaw-result-<reqId>.json` for the shim to print.
 *
 * Consent: this path does not show Shelly's own Review — the user (or the
 * Codex session they are driving) typed the command, and ClosePaw's
 * release-build "External Goal — An external app wants to run: …" dialog,
 * which only runs on an explicit Run tap, is the consent gate. On top of
 * that, entries older than CLOSEPAW_QUEUE_MAX_AGE_MS are dropped (a stale
 * queue replayed after an app restart never fires) and at most one hand-off
 * fires per CLOSEPAW_QUEUE_MIN_INTERVAL_MS.
 */
import {
  CLOSEPAW_NOT_INSTALLED_MARKER,
  isClosePawNotInstalledError,
  sanitizeClosePawGoal,
} from './agent-intent-review';

export const CLOSEPAW_QUEUE_PREFIX = 'closepaw:';
export const CLOSEPAW_QUEUE_MAX_AGE_MS = 30_000;
/** Allowed clock skew for a timestamp slightly in the future. */
export const CLOSEPAW_QUEUE_MAX_FUTURE_MS = 5_000;
export const CLOSEPAW_QUEUE_MIN_INTERVAL_MS = 5_000;
/** Upper bound on the encoded goal field (pre-decode) — a 2000-code-point
 *  goal percent-encodes to at most 2000 * 12 chars; anything longer is junk. */
export const CLOSEPAW_QUEUE_MAX_ENCODED_CHARS = 24_000;

const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;
const TS_RE = /^[0-9]{10,16}$/;

export const CLOSEPAW_MSG_HANDED_OFF = 'Handed off to ClosePaw — confirm Run in ClosePaw';
export const CLOSEPAW_MSG_NOT_INSTALLED = 'ClosePaw is not installed';

export type ClosePawQueueParse =
  | { ok: true; reqId: string; goal: string }
  | { ok: false; reqId: string | null; reason: 'malformed' | 'stale' | 'empty-goal' };

export function encodeClosePawQueueLine(reqId: string, tsMs: number, goal: string): string {
  return `${CLOSEPAW_QUEUE_PREFIX}${reqId}:${tsMs}:${encodeURIComponent(goal)}`;
}

/** Pure validation of one queue line. Never throws. */
export function parseClosePawQueueLine(line: string, nowMs: number): ClosePawQueueParse {
  if (typeof line !== 'string' || !line.startsWith(CLOSEPAW_QUEUE_PREFIX)) {
    return { ok: false, reqId: null, reason: 'malformed' };
  }
  const parts = line.slice(CLOSEPAW_QUEUE_PREFIX.length).split(':');
  if (parts.length !== 3) return { ok: false, reqId: null, reason: 'malformed' };
  const [reqIdRaw, tsRaw, encoded] = parts;
  const reqId = REQ_ID_RE.test(reqIdRaw) ? reqIdRaw : null;
  if (!reqId || !TS_RE.test(tsRaw) || encoded.length > CLOSEPAW_QUEUE_MAX_ENCODED_CHARS) {
    return { ok: false, reqId, reason: 'malformed' };
  }
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || nowMs - ts > CLOSEPAW_QUEUE_MAX_AGE_MS || ts - nowMs > CLOSEPAW_QUEUE_MAX_FUTURE_MS) {
    return { ok: false, reqId, reason: 'stale' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return { ok: false, reqId, reason: 'malformed' };
  }
  const goal = sanitizeClosePawGoal(decoded);
  if (!goal) return { ok: false, reqId, reason: 'empty-goal' };
  return { ok: true, reqId, goal };
}

/** One hand-off per `intervalMs` across the whole app process. */
export function createClosePawRateLimiter(intervalMs: number = CLOSEPAW_QUEUE_MIN_INTERVAL_MS) {
  let lastFireAt = -Infinity;
  return {
    tryAcquire(nowMs: number): boolean {
      if (nowMs - lastFireAt < intervalMs) return false;
      lastFireAt = nowMs;
      return true;
    },
  };
}

export type ClosePawQueueResult = {
  ok: boolean;
  code: 'handed-off' | 'not-installed' | 'rate-limited' | 'stale' | 'invalid' | 'unsupported' | 'failed';
  message: string;
};

export interface ClosePawQueueDeps {
  now: () => number;
  limiter: { tryAcquire(nowMs: number): boolean };
  /** Native fireAgentIntent, or null when this build lacks it. */
  fire: ((mode: 'closepaw', target: string, goal: string) => Promise<void>) | null;
  writeResult: (reqId: string, result: ClosePawQueueResult) => Promise<void>;
  log?: (message: string) => void;
}

/** Validate + rate-limit + fire one queue line, then report back to the shim.
 *  Returns the result (null when the line is too malformed to answer). */
export async function processClosePawQueueLine(
  line: string,
  deps: ClosePawQueueDeps,
): Promise<ClosePawQueueResult | null> {
  const parsed = parseClosePawQueueLine(line, deps.now());
  let result: ClosePawQueueResult;
  if (parsed.ok === false) {
    const reason = (parsed as Extract<ClosePawQueueParse, { ok: false }>).reason;
    if (!parsed.reqId) {
      deps.log?.(`closepaw: rejected malformed queue line`);
      return null;
    }
    result =
      reason === 'stale'
        ? { ok: false, code: 'stale', message: 'ClosePaw hand-off request expired (older than 30s); nothing was sent' }
        : reason === 'empty-goal'
          ? { ok: false, code: 'invalid', message: 'shelly closepaw: the goal is empty' }
          : { ok: false, code: 'invalid', message: 'shelly closepaw: malformed request' };
  } else if (!deps.fire) {
    result = { ok: false, code: 'unsupported', message: 'shelly closepaw: this build of Shelly cannot launch ClosePaw' };
  } else if (!deps.limiter.tryAcquire(deps.now())) {
    result = {
      ok: false,
      code: 'rate-limited',
      message: 'shelly closepaw: rate-limited (at most one hand-off every 5 seconds); try again shortly',
    };
  } else {
    try {
      await deps.fire('closepaw', '', (parsed as Extract<ClosePawQueueParse, { ok: true }>).goal);
      result = { ok: true, code: 'handed-off', message: CLOSEPAW_MSG_HANDED_OFF };
    } catch (e) {
      result = isClosePawNotInstalledError(e)
        ? { ok: false, code: 'not-installed', message: CLOSEPAW_MSG_NOT_INSTALLED }
        : { ok: false, code: 'failed', message: 'shelly closepaw: failed to launch ClosePaw' };
    }
  }
  deps.log?.(`closepaw: ${parsed.reqId ?? '?'} -> ${result.code}`);
  await deps.writeResult(parsed.reqId as string, result);
  return result;
}

/** Result file name for a validated reqId (relative to $HOME). */
export function closePawResultFileName(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error('invalid closepaw reqId');
  return `.shelly-closepaw-result-${reqId}.json`;
}

// Re-exported so the drainer and tests share one marker constant.
export { CLOSEPAW_NOT_INSTALLED_MARKER };
