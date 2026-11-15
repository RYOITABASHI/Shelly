// lib/debug-logger.ts — Centralized debug logger for Shelly
// All logs prefixed with [Shelly] for easy filtering in logcat.
// Every (redacted) line is also kept in a small in-memory ring
// (lib/debug-log-buffer.ts) for the MCP read_logs tool.

import { redactSecrets } from './redact-secrets';
import { appendDebugLog, type DebugLogLevel } from './debug-log-buffer';

const TAG = '[Shelly]';

function remember(level: DebugLogLevel, line: string, extra: unknown): void {
  try {
    let tail = '';
    if (extra instanceof Error) tail = extra.message;
    else if (typeof extra === 'string') tail = extra;
    else if (extra !== undefined && extra !== null) tail = String(extra);
    appendDebugLog(level, tail ? `${line} ${tail}` : line);
  } catch {
    // Logging must never throw.
  }
}

export function logInfo(module: string, message: string, data?: any) {
  const line = `${TAG}[${module}] ${redactSecrets(message)}`;
  const extra = data !== undefined ? redactSecrets(data) : '';
  console.log(line, extra);
  remember('info', line, extra);
}

export function logWarn(module: string, message: string, data?: any) {
  const line = `${TAG}[${module}] ${redactSecrets(message)}`;
  const extra = data !== undefined ? redactSecrets(data) : '';
  console.warn(line, extra);
  remember('warn', line, extra);
}

export function logError(module: string, message: string, error?: any) {
  const line = `${TAG}[${module}] ${redactSecrets(message)}`;
  const extra = redactSecrets(error?.message || error || '');
  console.error(line, extra);
  remember('error', line, extra);
  if (error?.stack) {
    const stack = redactSecrets(error.stack);
    console.error(`${TAG}[${module}] Stack:`, stack);
    remember('error', `${TAG}[${module}] Stack:`, stack);
  }
}

export function logLifecycle(module: string, event: string) {
  const line = `${TAG}[${module}] ⚡ ${redactSecrets(event)}`;
  console.log(line);
  remember('info', line, undefined);
}
