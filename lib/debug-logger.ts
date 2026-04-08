// lib/debug-logger.ts — Centralized debug logger for Shelly
// All logs prefixed with [Shelly] for easy filtering in logcat

const TAG = '[Shelly]';

export function logInfo(module: string, message: string, data?: any) {
  console.log(`${TAG}[${module}] ${message}`, data !== undefined ? data : '');
}

export function logWarn(module: string, message: string, data?: any) {
  console.warn(`${TAG}[${module}] ${message}`, data !== undefined ? data : '');
}

export function logError(module: string, message: string, error?: any) {
  console.error(`${TAG}[${module}] ${message}`, error?.message || error || '');
  if (error?.stack) console.error(`${TAG}[${module}] Stack:`, error.stack);
}

export function logLifecycle(module: string, event: string) {
  console.log(`${TAG}[${module}] ⚡ ${event}`);
}
