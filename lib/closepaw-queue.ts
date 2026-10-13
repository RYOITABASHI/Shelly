/**
 * lib/closepaw-queue.ts — `shelly closepaw "<goal>"` shell → native bridge.
 *
 * A shell process (the user's PTY shell, or Codex's non-interactive
 * `bash -lc` inside it) cannot `am start` an Activity under Knox, so the
 * native `$HOME/bin/shelly` helper shim (HomeInitializer.kt,
 * SHELLY_HELPER_SHIM v9) appends ONE line to `$HOME/.shelly-closepaw-queue`:
 *
 *   closepaw:<reqId>:<tsMs>:<encodeURIComponent(goal)>
 *
 * OWNER: native ClosePawHandoff.kt (fix/closepaw-background, 2026-10-13). It
 * drains that file from a FileObserver + 1s poll started by
 * TerminalSessionService and the Expo Module, so the hand-off works while
 * Shelly is backgrounded and the RN JS poll is not running (e.g. the ChatGPT
 * app driving Codex via `codex remote-control` hosted in a Shelly tab). It
 * validates exactly like parseClosePawQueueLine below (this file is the
 * reference spec — the Kotlin port is pinned to it by
 * __tests__/closepaw-native-handoff-invariants.test.ts), rate-limits to one
 * hand-off per CLOSEPAW_QUEUE_MIN_INTERVAL_MS, starts ClosePaw directly when
 * Android allows it or posts a tap-to-continue notification otherwise, and
 * writes `$HOME/.shelly-closepaw-result-<reqId>.json` for the shim to print.
 *
 * RN never fires a ClosePaw queue line itself: a legacy `closepaw:` line that
 * still arrives on the shared `.shelly-command-queue` (shim v8, before the
 * BASHRC v254 rewrite) is forwarded to the native owner by
 * forwardLegacyClosePawLine() — one owner, so no double fire.
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
  CLOSEPAW_BACKGROUND_BLOCKED_MARKER,
  CLOSEPAW_NOT_INSTALLED_MARKER,
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

/** The native-owned queue file (relative to $HOME). */
export const CLOSEPAW_NATIVE_QUEUE_FILE = '.shelly-closepaw-queue';

export const CLOSEPAW_MSG_HANDED_OFF = 'Handed off to ClosePaw — confirm Run in ClosePaw';
export const CLOSEPAW_MSG_NOTIFIED = 'Shelly is in the background — tap the ClosePaw notification to continue';
export const CLOSEPAW_MSG_NOT_INSTALLED = 'ClosePaw is not installed';
export const CLOSEPAW_MSG_BACKGROUND_BLOCKED =
  'shelly closepaw: Shelly is in the background and its notifications are off — open Shelly and run the command again';

/** Result codes the native owner writes into the result file. */
export type ClosePawResultCode =
  | 'handed-off'
  | 'notified'
  | 'not-installed'
  | 'background-blocked'
  | 'rate-limited'
  | 'stale'
  | 'invalid'
  | 'failed';

export type ClosePawQueueResult = {
  ok: boolean;
  code: ClosePawResultCode;
  message: string;
};

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

/**
 * RN side of the single-owner rule: a `closepaw:` line found on the shared
 * command queue is handed to the native owner (which validates, rate-limits,
 * dedupes, launches/notifies and answers the shim). RN never fires it.
 * Returns the native result code, or null when nothing could be done.
 */
export async function forwardLegacyClosePawLine(
  line: string,
  handOff: ((line: string) => Promise<string | null>) | null | undefined,
  log?: (message: string) => void,
): Promise<string | null> {
  if (!line.startsWith(CLOSEPAW_QUEUE_PREFIX)) return null;
  if (!handOff) {
    log?.('closepaw: native hand-off unavailable in this build; legacy line dropped');
    return null;
  }
  const code = await handOff(line);
  log?.(`closepaw: legacy line forwarded to native -> ${code ?? 'unanswered'}`);
  return code;
}

/** Result file name for a validated reqId (relative to $HOME). */
export function closePawResultFileName(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error('invalid closepaw reqId');
  return `.shelly-closepaw-result-${reqId}.json`;
}

// Re-exported so the native invariants test and callers share one marker.
export { CLOSEPAW_BACKGROUND_BLOCKED_MARKER, CLOSEPAW_NOT_INSTALLED_MARKER };
