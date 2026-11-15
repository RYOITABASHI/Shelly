/**
 * lib/debug-log-buffer.ts — in-memory ring of Shelly's own log lines.
 *
 * lib/debug-logger.ts appends every line it prints here, AFTER redaction
 * (redactSecrets), so the ring only ever holds what already went to
 * console/logcat. Read by the MCP `read_logs` tool (source "app",
 * lib/mcp-server-bridge.ts, behind settings.mcpDiagnosticsEnabled).
 *
 * Memory only: lost when the JS context restarts, never written to disk.
 * Bounded both in line count and per-line length.
 */

export type DebugLogLevel = 'info' | 'warn' | 'error';

export type DebugLogEntry = {
  /** Epoch ms when the line was logged. */
  ts: number;
  level: DebugLogLevel;
  /** The redacted line as printed, e.g. `[Shelly][MCPBridge] answered call …`. */
  line: string;
};

export const DEBUG_LOG_CAPACITY = 1000;
export const DEBUG_LOG_LINE_MAX = 2000;

const ring: DebugLogEntry[] = [];

export function appendDebugLog(level: DebugLogLevel, line: string, ts: number = Date.now()): void {
  const capped = line.length > DEBUG_LOG_LINE_MAX ? `${line.slice(0, DEBUG_LOG_LINE_MAX)}… [truncated]` : line;
  ring.push({ ts, level, line: capped });
  if (ring.length > DEBUG_LOG_CAPACITY) ring.splice(0, ring.length - DEBUG_LOG_CAPACITY);
}

/** Oldest first; a copy. */
export function getDebugLogEntries(): DebugLogEntry[] {
  return ring.slice();
}

/** Test hook. */
export function __clearDebugLogForTests(): void {
  ring.length = 0;
}
