/**
 * hooks/use-nacre-bridge.ts — Shelly → Nacre bridge (feature B), foreground-only.
 *
 * Mount once near the app root (see app/_layout.tsx). While Shelly is in the
 * foreground, writes a sanitized context.json (lib/nacre-bridge-context.ts —
 * the fixed file-path/JSON-schema/sanitization contract shared with the
 * Nacre IME side) whenever the active session's cwd, git branch, or recent
 * command history changes. Writes are debounced (batch bursty triggers) and
 * throttled to roughly once every MIN_WRITE_INTERVAL_MS, per the contract's
 * "don't write too frequently" requirement. The file is deleted the moment
 * the app leaves the foreground (background/inactive), and is never written
 * at all while backgrounded — its `expiresAt` TTL is the backstop if deletion
 * itself fails for any reason.
 *
 * Gated by settings.nacreBridgeEnabled (default ON). Pure sanitization /
 * JSON-assembly / file I/O live in lib/nacre-bridge-context.ts (unit-tested);
 * this hook only owns wiring: WHEN to call it.
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useSettingsStore } from '@/store/settings-store';
import { useTerminalStore } from '@/store/terminal-store';
import { execCommand } from '@/hooks/use-native-exec';
import { getHomePath } from '@/lib/home-path';
import {
  buildNacreBridgeContext,
  writeNacreBridgeContext,
  invalidateNacreBridgeContext,
} from '@/lib/nacre-bridge-context';
import { logInfo, logError } from '@/lib/debug-logger';

/** Throttle floor: never write more often than this even under a burst of
 *  triggers (contract: "数秒〜十数秒に1回程度にデバウンス/スロットルする"). */
const MIN_WRITE_INTERVAL_MS = 8_000;
/** Debounce window: wait for triggers to go quiet before writing, so a
 *  rapid-fire sequence (e.g. several commands typed in a row) collapses
 *  into one write instead of one per keystroke/command. */
const DEBOUNCE_MS = 1_500;
/** How many recent raw commands to feed into the sanitizer per write — the
 *  sanitizer itself further caps its OUTPUT terms at 20 regardless. */
const MAX_RECENT_COMMANDS = 20;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Mirrors components/layout/ContextBar.tsx's canonicalizeAndroidDataPath:
 *  /data/data/<pkg> and /data/user/0/<pkg> are two OS aliases for the same
 *  app-private directory, so a plain string compare against HOME can
 *  spuriously mismatch. Used here to avoid ever reporting Shelly's own HOME
 *  as if it were a git repo. */
function canonicalizeAndroidDataPath(path: string): string {
  return path
    .replace(/^\/data\/user\/0\/dev\.shelly\.terminal\//, '/__shelly_data__/')
    .replace(/^\/data\/data\/dev\.shelly\.terminal\//, '/__shelly_data__/');
}

async function resolveGitContext(
  cwd: string,
  home: string,
): Promise<{ repo?: string; branch?: string }> {
  if (canonicalizeAndroidDataPath(cwd) === canonicalizeAndroidDataPath(home)) {
    return {};
  }
  try {
    const r = await execCommand(
      `cd ${shellQuote(cwd)} && git rev-parse --show-toplevel 2>/dev/null && git branch --show-current 2>/dev/null`,
    );
    if (r.exitCode !== 0) return {};
    const [toplevel, branch] = r.stdout.split('\n').map((l) => l.trim());
    const repo = toplevel ? toplevel.split('/').filter(Boolean).pop() : undefined;
    return { repo: repo || undefined, branch: branch || undefined };
  } catch {
    return {};
  }
}

export function useNacreBridge(): void {
  const enabled = useSettingsStore((s) => s.settings.nacreBridgeEnabled ?? true);
  const currentDir = useTerminalStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return session?.currentDir;
  });
  const commandHistoryKey = useTerminalStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return session ? session.commandHistory.slice(0, MAX_RECENT_COMMANDS).join('\0') : '';
  });

  const lastWriteAtRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation guard (matches hooks/use-telegram-inbound.ts's pattern): only
  // the newest effect instance's async callbacks are allowed to act, so a
  // rapid cwd/history change can't leave a stale in-flight write racing a
  // fresher one.
  const generationRef = useRef(0);

  useEffect(() => {
    const myGeneration = ++generationRef.current;
    const isCurrent = () => myGeneration === generationRef.current;

    const clearPending = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };

    const performWrite = async () => {
      if (!isCurrent()) return;
      if (!enabled || AppState.currentState !== 'active') return;
      const state = useTerminalStore.getState();
      const session = state.sessions.find((s) => s.id === state.activeSessionId);
      const home = getHomePath();
      const cwd = session?.currentDir || home;
      const recentCommands = (session?.commandHistory || []).slice(0, MAX_RECENT_COMMANDS);
      lastWriteAtRef.current = Date.now();
      try {
        const { repo, branch } = await resolveGitContext(cwd, home);
        // Re-check both generation AND foreground state: resolveGitContext()
        // awaits a subprocess, and the app can background mid-flight. If it
        // does, the AppState listener's invalidateNacreBridgeContext() may
        // already have deleted the file — writing here would silently
        // recreate it, violating "only share while Shelly is foregrounded"
        // (Codex review, 2026-08-30).
        if (!isCurrent() || AppState.currentState !== 'active') return;
        const context = buildNacreBridgeContext({ cwd, repo, branch, recentCommands });
        await writeNacreBridgeContext(context);
        logInfo(
          'NacreBridge',
          `context written (${context.terms.length} terms, repo=${context.repo ?? '-'}, branch=${context.branch ?? '-'})`,
        );
      } catch (e) {
        logError('NacreBridge', 'write failed', e);
      }
    };

    const scheduleWrite = () => {
      if (!enabled) return;
      if (AppState.currentState !== 'active') return;
      clearPending();
      debounceTimerRef.current = setTimeout(() => {
        const elapsed = Date.now() - lastWriteAtRef.current;
        const wait = Math.max(0, MIN_WRITE_INTERVAL_MS - elapsed);
        if (wait > 0) {
          debounceTimerRef.current = setTimeout(() => void performWrite(), wait);
        } else {
          void performWrite();
        }
      }, DEBOUNCE_MS);
    };

    if (enabled) {
      scheduleWrite();
    } else {
      // Setting flipped off (or was already off) — make sure nothing stale
      // lingers on shared storage.
      clearPending();
      void invalidateNacreBridgeContext();
    }

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (!isCurrent()) return;
      if (state === 'active') {
        scheduleWrite();
      } else if (state === 'background' || state === 'inactive') {
        clearPending();
        void invalidateNacreBridgeContext();
      }
    });

    return () => {
      generationRef.current += 1;
      clearPending();
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentDir, commandHistoryKey]);
}
