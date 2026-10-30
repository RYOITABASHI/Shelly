/**
 * lib/deep-link-open-guard.ts — loop/burst safety for EXTERNAL-browser entries of
 * the `$HOME/.shelly-deep-link-queue` drain in app/_layout.tsx.
 *
 * Claude Code glibc S2 on-device finding (build 2687): during `setup-token`
 * Chrome Custom Tabs re-opened every time Shelly regained focus, until the app
 * was force-stopped. Each external open backgrounds Shelly; coming back makes a
 * TUI re-render; a re-render that re-emits a URL must never turn into another
 * open (or another sign-in prompt). The drain is the single choke point every
 * external opener goes through, so it enforces:
 *
 *   1. the same key (callers use provider + URL) at most once per
 *      `dedupeWindowMs` (default 30 s) — scoped to one drain lifetime (one app
 *      session); `forget(key)` lets a deliberate retry through (e.g. the user
 *      cancelled the sign-in prompt);
 *   2. at most `maxPerMinute` external opens per rolling minute — a burst
 *      beyond that is dropped (the caller logs + toasts), never queued;
 *   3. pure + clock-injected so it is unit-testable.
 *
 * In-app (Browser Pane) entries are not subject to this guard.
 *
 * "Never re-open the same queue line twice" is structural in the drain: the
 * queue file is atomically renamed to a unique spool and the spool is deleted
 * BEFORE any line is dispatched, so a crash mid-dispatch can lose lines but can
 * never replay them (see drainQueue).
 */

export interface OpenGuardOptions {
  dedupeWindowMs?: number;
  maxPerMinute?: number;
}

export type OpenGuardDecision =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: 'duplicate' | 'rate-limited' };

export interface OpenGuard {
  check(key: string, now?: number): OpenGuardDecision;
  /** Drop the dedupe record for `key` so an intentional retry is not swallowed. */
  forget(key: string): void;
}

export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
export const DEFAULT_MAX_OPENS_PER_MINUTE = 5;

export function openGuardKey(provider: string | null, url: string): string {
  return `${provider ?? 'unknown'}\n${url}`;
}

export function createOpenGuard(opts: OpenGuardOptions = {}): OpenGuard {
  const dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const maxPerMinute = opts.maxPerMinute ?? DEFAULT_MAX_OPENS_PER_MINUTE;
  const lastOpened = new Map<string, number>();
  let recent: number[] = [];

  return {
    check(key: string, now: number = Date.now()): OpenGuardDecision {
      for (const [k, t] of lastOpened) {
        if (now - t >= dedupeWindowMs) lastOpened.delete(k);
      }
      recent = recent.filter((t) => now - t < 60_000);

      const prev = lastOpened.get(key);
      if (prev !== undefined && now - prev < dedupeWindowMs) {
        return { ok: false, reason: 'duplicate' };
      }
      if (recent.length >= maxPerMinute) {
        return { ok: false, reason: 'rate-limited' };
      }
      lastOpened.set(key, now);
      recent.push(now);
      return { ok: true };
    },
    forget(key: string): void {
      lastOpened.delete(key);
    },
  };
}
