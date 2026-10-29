/**
 * lib/codex-signout.ts — Settings → Codex Login → "Sign out of Codex".
 *
 * Pure logic with injected dependencies (exec + the Codex remote-control
 * native bindings) so it is unit-testable; SettingsDropdown wires the real
 * execCommand() / TerminalEmulator functions.
 *
 * Order of operations:
 *  1. Always disconnect remote control first via
 *     disconnectCodexRemoteForSignOut() — CodexRemoteHost.disconnectForSignOut:
 *     switch OFF + stop the tracked host + sweep every same-uid
 *     `remote-control` process (the notification "Disconnect" path), so an
 *     untracked/orphaned host that status().running can't see doesn't keep
 *     running on credentials it already loaded. It runs even when the status
 *     looks idle, because orphans are exactly what the status misses; the
 *     result's remainingRemoteControlProcesses must be 0 to count as stopped.
 *     Already-running Codex agent / terminal processes keep their in-memory
 *     credentials until they exit; the confirmation text says so.
 *  2. Run the official `codex logout` through the $HOME/bin/codex shim that
 *     HomeInitializer writes (same runtime selection / env as the terminal's
 *     `codex`). execCommand()'s shell does not source ~/.bashrc and does not
 *     have $HOME/bin on PATH, and PATH-visible #! scripts can't be exec'd
 *     under Knox, so the shim (which has no shebang) is *sourced* in a
 *     subshell with `logout` as its positional argument instead of exec'd.
 *  3. Verify $CODEX_HOME/auth.json (default ~/.codex/auth.json) is gone. Only
 *     if `codex logout` was unavailable/failed or left the file behind, delete
 *     the file directly, then verify again. Never report success while the
 *     file still exists.
 */
import type { ExecResult } from '@/hooks/use-native-exec';

export type CodexAuthState = 'signed_in' | 'signed_out' | 'unknown';

export type CodexRemoteStatus = {
  enabled: boolean;
  running: boolean;
  /** Same-uid `remote-control` processes found after a sweep (disconnect result only). */
  remainingRemoteControlProcesses?: number;
} | null;

export interface CodexSignOutDeps {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  getRemoteStatus(): Promise<CodexRemoteStatus>;
  /** Turns "Keep ChatGPT connected" off, stops the host and sweeps orphans. */
  disableRemote(): Promise<CodexRemoteStatus>;
}

const AUTH_FILE = '"${CODEX_HOME:-$HOME/.codex}/auth.json"';

export const CODEX_AUTH_STATE_CMD =
  `if [ -e ${AUTH_FILE} ]; then echo signed_in; else echo signed_out; fi`;

export const CODEX_LOGOUT_CMD = [
  'if [ ! -f "$HOME/bin/codex" ]; then',
  '  echo "codex shim not found at $HOME/bin/codex" >&2',
  '  exit 127',
  'fi',
  '( set -- logout; . "$HOME/bin/codex" ) </dev/null',
].join('\n');

export const CODEX_AUTH_DELETE_CMD = `rm -f -- ${AUTH_FILE}`;

const LOGOUT_TIMEOUT_MS = 30_000;
const SHORT_TIMEOUT_MS = 10_000;

export async function getCodexAuthState(
  exec: CodexSignOutDeps['exec'],
): Promise<CodexAuthState> {
  try {
    const r = await exec(CODEX_AUTH_STATE_CMD, SHORT_TIMEOUT_MS);
    const out = (r.stdout || '').trim();
    if (r.exitCode === 0 && out === 'signed_in') return 'signed_in';
    if (r.exitCode === 0 && out === 'signed_out') return 'signed_out';
  } catch {
    // fall through
  }
  return 'unknown';
}

/** True when the confirmation must warn that remote control will stop. */
export function remoteControlActive(status: CodexRemoteStatus): boolean {
  return !!status && (status.enabled || status.running);
}

export type CodexSignOutResult =
  | {
      ok: true;
      method: 'codex_logout' | 'file_delete' | 'already_signed_out';
      /** Remote control was active and has been turned off. */
      remoteStopped: boolean;
      /** Remote control may still be on/running (or a remote-control process survived the sweep). */
      remoteStillActive: boolean;
      logoutError?: string;
    }
  | {
      ok: false;
      error: string;
      remoteStopped: boolean;
      remoteStillActive: boolean;
    };

function describeFailure(r: ExecResult | null, e?: unknown): string {
  if (e) return String((e as any)?.message || e);
  if (!r) return 'unknown error';
  const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n');
  return `exit ${r.exitCode}${msg ? `: ${msg}` : ''}`;
}

export async function signOutOfCodex(deps: CodexSignOutDeps): Promise<CodexSignOutResult> {
  // 1. Remote control first.
  let remoteStopped = false;
  let remoteStillActive = false;
  let before: CodexRemoteStatus = null;
  try {
    before = await deps.getRemoteStatus();
  } catch {
    before = null;
  }
  try {
    const after = await deps.disableRemote();
    // A missing result or a missing sweep count can't prove nothing is left.
    remoteStillActive =
      !after ||
      remoteControlActive(after) ||
      typeof after.remainingRemoteControlProcesses !== 'number' ||
      after.remainingRemoteControlProcesses > 0;
    remoteStopped = remoteControlActive(before) && !remoteStillActive;
  } catch {
    remoteStillActive = true;
  }

  // 2. Official logout.
  const stateBefore = await getCodexAuthState(deps.exec);
  if (stateBefore === 'signed_out') {
    return { ok: true, method: 'already_signed_out', remoteStopped, remoteStillActive };
  }

  let logoutError: string | undefined;
  try {
    const r = await deps.exec(CODEX_LOGOUT_CMD, LOGOUT_TIMEOUT_MS);
    if (r.exitCode !== 0) logoutError = describeFailure(r);
  } catch (e) {
    logoutError = describeFailure(null, e);
  }

  // 3. Verify; fall back to deleting the file.
  if ((await getCodexAuthState(deps.exec)) === 'signed_out') {
    return { ok: true, method: 'codex_logout', remoteStopped, remoteStillActive, logoutError };
  }
  let deleteError: string | undefined;
  try {
    const r = await deps.exec(CODEX_AUTH_DELETE_CMD, SHORT_TIMEOUT_MS);
    if (r.exitCode !== 0) deleteError = describeFailure(r);
  } catch (e) {
    deleteError = describeFailure(null, e);
  }
  if ((await getCodexAuthState(deps.exec)) === 'signed_out') {
    return { ok: true, method: 'file_delete', remoteStopped, remoteStillActive, logoutError };
  }
  const parts = [
    'auth.json is still present',
    logoutError ? `codex logout: ${logoutError}` : null,
    deleteError ? `rm: ${deleteError}` : null,
  ].filter(Boolean);
  return { ok: false, error: parts.join('\n'), remoteStopped, remoteStillActive };
}
