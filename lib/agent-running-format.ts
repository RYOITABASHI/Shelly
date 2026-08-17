// Pure formatting helper for the Sidebar RUNNING sub-section (Fable5 UX
// consultation, 2026-07-21). Kept in lib/ (no JSX, no RN/native-module
// imports) specifically so it has direct unit coverage without pulling in
// Sidebar.tsx's full module graph (native TerminalEmulator, stores,
// expo-file-system, etc.) — see __tests__/sidebar-running-elapsed.test.ts.
// An earlier draft exported this straight from Sidebar.tsx, but importing
// even a single named export from a .tsx file still executes that module's
// entire top-level import graph, which requires the native module and is
// not available in the plain 'unit' (ts-jest/node) jest project.

/** Format a millisecond duration as a compact elapsed-time label:
 *  - < 1 min: "Ns"
 *  - < 1 hour: "MmSSs" (seconds zero-padded)
 *  - >= 1 hour: "HhMMm" (minutes zero-padded, seconds dropped)
 *  Negative input clamps to 0 rather than throwing or going negative. */
export function formatElapsedMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}m`;
  }
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Pick the elapsed time shown in Sidebar's RUNNING row. Attended chains
 * expose a chain-lifetime start marker; older and single-attempt runs fall
 * back to the per-invocation PID lock, then the live step marker. */
export function runningDisplayElapsedMs(
  nowMs: number,
  chainStartedAtMs: number | null,
  lockMtimeMs: number | null,
  stepStartedAtMs: number | null,
): number {
  const startedAtMs = chainStartedAtMs ?? lockMtimeMs ?? stepStartedAtMs;
  return startedAtMs == null ? 0 : Math.max(0, nowMs - startedAtMs);
}

/** Decide whether the Sidebar's RUNNING-section poll loop should be active.
 *  docs/superpowers/DEFERRED.md "zombie RUNNING display" bug: an ephemeral
 *  one-shot agent auto-deletes its store entry (agentCount -> 0) while its
 *  lock file may still be momentarily live, or runningAgentCount hasn't
 *  caught up yet. Without runningAgentCount in this condition, polling
 *  stopped the instant agentCount hit 0 and a stale running-id was never
 *  refreshed away — the poll's own refresh always REPLACES its id set with
 *  whatever `kill -0` confirms live, so keeping polling alive until that set
 *  is actually empty is sufficient to self-heal with no extra plumbing. */
export function shouldPollRunningAgents(params: {
  agentCount: number;
  pendingAgentCount: number;
  runningAgentCount: number;
}): boolean {
  return params.agentCount > 0 || params.pendingAgentCount > 0 || params.runningAgentCount > 0;
}
