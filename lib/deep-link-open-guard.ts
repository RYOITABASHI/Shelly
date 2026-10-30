/**
 * lib/deep-link-open-guard.ts — loop/burst safety for the `$HOME/.shelly-deep-link-queue`
 * drain in app/_layout.tsx.
 *
 * Claude Code glibc S2 on-device finding (build 2687): during `setup-token`
 * Chrome Custom Tabs re-opened every time Shelly regained focus, until the app
 * was force-stopped. Each external open backgrounds Shelly; coming back makes a
 * TUI re-render; a re-render that re-emits a URL must never turn into another
 * open. The emitters dedupe on their side (OAuthHyperlinkBridge.kt), and the
 * output-driven auto-open in TerminalPane.tsx was removed, but the drain is the
 * single choke point every opener goes through, so it enforces the invariant:
 *
 *   1. the same URL is opened at most once per `dedupeWindowMs` (default 30 s);
 *   2. at most `maxPerMinute` opens of any URL per rolling minute — a burst
 *      beyond that is dropped (with a log line from the caller), never queued;
 *   3. the guard is pure + clock-injected so it is unit-testable.
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
  check(url: string, now?: number): OpenGuardDecision;
}

export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
export const DEFAULT_MAX_OPENS_PER_MINUTE = 5;

export function createOpenGuard(opts: OpenGuardOptions = {}): OpenGuard {
  const dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const maxPerMinute = opts.maxPerMinute ?? DEFAULT_MAX_OPENS_PER_MINUTE;
  const lastOpened = new Map<string, number>();
  let recent: number[] = [];

  return {
    check(url: string, now: number = Date.now()): OpenGuardDecision {
      for (const [u, t] of lastOpened) {
        if (now - t >= dedupeWindowMs) lastOpened.delete(u);
      }
      recent = recent.filter((t) => now - t < 60_000);

      const prev = lastOpened.get(url);
      if (prev !== undefined && now - prev < dedupeWindowMs) {
        return { ok: false, reason: 'duplicate' };
      }
      if (recent.length >= maxPerMinute) {
        return { ok: false, reason: 'rate-limited' };
      }
      lastOpened.set(url, now);
      recent.push(now);
      return { ok: true };
    },
  };
}
