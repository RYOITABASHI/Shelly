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
