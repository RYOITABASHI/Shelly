/**
 * lib/ai-pane-scroll-follow.ts
 *
 * Helpers for the AI pane's tail-follow scrolling.
 */
import { logInfo } from '@/lib/debug-logger';

/**
 * Coalesces bursts of `call()` into a single `requestAnimationFrame`
 * invocation of `fn`. Once that frame has fired, a later `call()` schedules
 * again. `cancel()` drops a pending invocation.
 */
export function createRafCoalescer(fn: () => void): { call: () => void; cancel: () => void } {
  let handle: number | null = null;
  return {
    call() {
      if (handle !== null) return;
      handle = requestAnimationFrame(() => {
        handle = null;
        fn();
      });
    },
    cancel() {
      if (handle === null) return;
      cancelAnimationFrame(handle);
      handle = null;
    },
  };
}

// ─── TEMPORARY (2026-11-17) ──────────────────────────────────────────────────
// AI-pane streaming jitter diagnosis. Numbers only — never message text or
// any user content. Remove after the 60fps device gate.
export function logAIPaneJitter(message: string): void {
  logInfo('AIPaneJitter', message);
}
