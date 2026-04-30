// lib/debug-logger.ts — Centralized debug logger for Shelly
// All logs prefixed with [Shelly] for easy filtering in logcat

import { redactSecrets } from './redact-secrets';

const TAG = '[Shelly]';

export function logInfo(module: string, message: string, data?: any) {
  console.log(`${TAG}[${module}] ${redactSecrets(message)}`, data !== undefined ? redactSecrets(data) : '');
}

export function logWarn(module: string, message: string, data?: any) {
  console.warn(`${TAG}[${module}] ${redactSecrets(message)}`, data !== undefined ? redactSecrets(data) : '');
}

export function logError(module: string, message: string, error?: any) {
  console.error(`${TAG}[${module}] ${redactSecrets(message)}`, redactSecrets(error?.message || error || ''));
  if (error?.stack) console.error(`${TAG}[${module}] Stack:`, redactSecrets(error.stack));
}

export function logLifecycle(module: string, event: string) {
  console.log(`${TAG}[${module}] ⚡ ${redactSecrets(event)}`);
}
