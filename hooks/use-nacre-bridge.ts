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
import { usePaneStore } from '@/store/pane-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import type { TabSession } from '@/store/types';
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

/**
 * Recent command strings for a session, most-recent-first.
 *
 * On-device testing (2026-08-30) found `session.commandHistory` never
 * reflects real usage: it's only ever written by terminal-store's own
 * `runCommand()`, which is the OLD block-terminal UI's (TerminalBlock.tsx /
 * FirstMateOverlay.tsx) choke point. The actual terminal UI in the app today
 * — NativeTerminalView, PTY-direct — writes typed input straight to the PTY
 * fd and never calls `runCommand()` (see TerminalPane.tsx's `onBlockCompleted`
 * handler, which instead appends to `session.entries` via `addEntryBlock()`
 * and calls `learnFromCommand()` as ITS OWN separate choke point — the exact
 * same architectural split lib/agent-suggestion-engine.ts already hit for
 * profile learning). Reading `commandHistory` alone meant `terms` stayed
 * permanently empty and never updated for anyone actually typing in the
 * terminal, which is the common case. Read both: `entries` (real native
 * usage) and `commandHistory` (legacy block-UI, kept for completeness).
 */
function recentCommands(session: TabSession | undefined): string[] {
  if (!session) return [];
  const fromEntries = session.entries
    .filter((e): e is Extract<typeof e, { command: string }> => 'command' in e)
    .slice(-MAX_RECENT_COMMANDS)
    .reverse()
    .map((e) => e.command);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const cmd of [...fromEntries, ...session.commandHistory]) {
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    merged.push(cmd);
    if (merged.length >= MAX_RECENT_COMMANDS) break;
  }
  return merged;
}

/**
 * Resolves the session that real terminal typing is actually landing in
 * right now. terminal-store.ts's own `addEntryBlock` comment documents this
 * exact split: a pane bound to a multi-pane slot (`useMultiPaneStore`'s
 * per-slot `sessionId`) records its blocks to THAT session, which is not
 * always terminal-store's global `activeSessionId` (e.g. after a cold start
 * where the two stores hydrate independently, or after a pane rebinds via
 * `setSlotSessionId` without touching the global active session). Reading
 * only `activeSessionId` reproduced the same "Block History always empty"
 * bug class here: on-device, `terms` stayed at 0 forever despite real
 * commands running, because the write side (TerminalPane.tsx) and this
 * read side were resolving two different sessions.
 *
 * Mirrors TerminalPane.tsx's own resolution (`paneSessionId ? sessions.find
 * (paneSessionId) ?? globalActiveSession : globalActiveSession`, where
 * `globalActiveSession` comes from `useActiveSession()`) rather than trusting
 * the slot's `sessionId` blindly — a stale persisted slot pointing at a
 * since-removed session must fall back too, exactly like the pane itself
 * does (Codex review, 2026-08-30). `focusedPaneId` also isn't always
 * mirrored on cold start / multi-pane init, so fall back through
 * `focusedSlot` (the multi-pane store's own index, which init always sets)
 * before falling back to the global session, and require the resolved slot
 * to actually be a 'terminal' tab — an AI/Browser/Markdown slot's leftover
 * `sessionId` (if any) was never the thing recording terminal commands.
 *
 * On-device DIAG logging (2026-08-30) caught a second staleness this same
 * fix needed to handle: terminal-store's `activeSessionId` starts as the
 * hardcoded `'session-1'` and nothing in the multi-pane session-creation
 * path ever touches it, so it never matches the real session either. The
 * pane's own `useActiveSession()` selector already has exactly this
 * fallback baked in (`sessions.find(...) ?? sessions[0]`) — mirror it here
 * too, or a stale `activeSessionId` resolves to a real-but-wrong (empty)
 * session instead of the one real terminal session actually in use.
 */
function resolveTargetSessionIdFrom(
  focusedPaneId: string | null | undefined,
  slots: readonly ({ id: string; tab: string; sessionId?: string } | null)[],
  focusedSlot: number,
  sessions: readonly { id: string }[],
  globalActiveSessionId: string,
): string {
  const slot =
    slots.find((s) => s && s.id === focusedPaneId) ?? slots[focusedSlot] ?? null;
  if (
    slot &&
    slot.tab === 'terminal' &&
    slot.sessionId &&
    sessions.some((s) => s.id === slot.sessionId)
  ) {
    return slot.sessionId;
  }
  if (sessions.some((s) => s.id === globalActiveSessionId)) {
    return globalActiveSessionId;
  }
  return sessions[0]?.id ?? globalActiveSessionId;
}

function useTargetSessionId(): string {
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const sessions = useTerminalStore((s) => s.sessions);
  const globalActiveSessionId = useTerminalStore((s) => s.activeSessionId);
  return useMultiPaneStore((s) =>
    resolveTargetSessionIdFrom(focusedPaneId, s.slots, s.focusedSlot, sessions, globalActiveSessionId),
  );
}

/** Non-reactive counterpart of useTargetSessionId, for use inside the
 *  debounced/throttled write callback below (which reads fresh store state
 *  via `.getState()` rather than closing over a render-time value). */
function resolveTargetSessionId(): string {
  const { focusedPaneId } = usePaneStore.getState();
  const { slots, focusedSlot } = useMultiPaneStore.getState();
  const { sessions, activeSessionId } = useTerminalStore.getState();
  return resolveTargetSessionIdFrom(focusedPaneId, slots, focusedSlot, sessions, activeSessionId);
}

export function useNacreBridge(): void {
  const enabled = useSettingsStore((s) => s.settings.nacreBridgeEnabled ?? true);
  const targetSessionId = useTargetSessionId();
  const currentDir = useTerminalStore((s) => {
    const session = s.sessions.find((item) => item.id === targetSessionId);
    return session?.currentDir;
  });
  const commandHistoryKey = useTerminalStore((s) => {
    const session = s.sessions.find((item) => item.id === targetSessionId);
    return recentCommands(session).join('\0');
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
      const resolvedId = resolveTargetSessionId();
      const session = state.sessions.find((s) => s.id === resolvedId);
      const home = getHomePath();
      const cwd = session?.currentDir || home;
      const recent = recentCommands(session);
      logInfo(
        'NacreBridge',
        `DIAG resolvedId=${resolvedId} focusedPaneId=${usePaneStore.getState().focusedPaneId} focusedSlot=${useMultiPaneStore.getState().focusedSlot} slots=${JSON.stringify(useMultiPaneStore.getState().slots.map((s) => s && { id: s.id, tab: s.tab, sessionId: s.sessionId }))} entries=${session?.entries.length ?? -1} commandHistory=${session?.commandHistory.length ?? -1}`,
      );
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
        const context = buildNacreBridgeContext({ cwd, repo, branch, recentCommands: recent });
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
  }, [enabled, currentDir, commandHistoryKey, targetSessionId]);
}
