/**
 * session-persistence.ts — Save/restore terminal sessions to .shelly/sessions/
 *
 * Enables session recovery after app crash, device restart, or project re-open.
 * Sessions are saved as JSON files in the project's .shelly/sessions/ directory.
 */

import { useTerminalStore } from '@/store/terminal-store';
import { useExecutionLogStore } from '@/store/execution-log-store';
import type { TabSession } from '@/store/types';
import { AppState, type AppStateStatus } from 'react-native';

type RunCommand = (cmd: string, opts: { timeoutMs: number; reason: string }) => Promise<any>;

/** Serialized session format for .shelly/sessions/ */
type PersistedSession = {
  id: string;
  name: string;
  port: number;
  cwd: string;
  commandHistory: string[];
  outputBuffer: string[];
  createdAt: string;
  lastActiveAt: string;
  activeCli: 'claude' | 'gemini' | 'codex' | 'cody' | null;
  tmuxSession: string;
};

const MAX_OUTPUT_LINES = 200;
const AUTO_SAVE_INTERVAL = 90_000; // 90 seconds (省バッテリー: 30s→90s)

let _autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let _appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

/** Convert a TabSession to a persistable format */
function sessionToJson(session: TabSession, outputLines: string[]): PersistedSession {
  return {
    id: session.id,
    name: session.name,
    port: 0, // Legacy field — no longer used with native PTY
    cwd: session.currentDir || '',
    commandHistory: session.commandHistory.slice(0, 100),
    outputBuffer: outputLines.slice(-MAX_OUTPUT_LINES),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    activeCli: session.activeCli ?? null,
    tmuxSession: session.tmuxSession ?? '',
  };
}

/** Save all sessions to .shelly/sessions/ in the given project path */
export async function saveSessionsToProject(
  projectPath: string,
  runRawCommand: RunCommand,
): Promise<void> {
  if (!projectPath) return;

  const { sessions } = useTerminalStore.getState();
  const { sessionBuffer } = useExecutionLogStore.getState();

  try {
    const escaped = projectPath.replace(/'/g, "'\\''");
    await runRawCommand(
      `mkdir -p '${escaped}/.shelly/sessions'`,
      { timeoutMs: 5000, reason: 'session-save-mkdir' },
    );

    for (const session of sessions) {
      const outputLines = sessionBuffer
        .filter((l) => l.sessionId === session.id)
        .map((l) => l.text);

      const data = sessionToJson(session, outputLines);
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      await runRawCommand(
        `echo '${b64}' | base64 -d > '${escaped}/.shelly/sessions/${session.id}.json'`,
        { timeoutMs: 5000, reason: 'session-save' },
      );
    }
  } catch (e) {
    console.warn('[SessionPersist] save to project failed:', e);
  }
}

/** Load sessions from .shelly/sessions/ in the given project path */
export async function loadSessionsFromProject(
  projectPath: string,
  runRawCommand: RunCommand,
): Promise<PersistedSession[]> {
  if (!projectPath) return [];

  try {
    const escaped = projectPath.replace(/'/g, "'\\''");
    const result = await runRawCommand(
      `ls '${escaped}/.shelly/sessions/'*.json 2>/dev/null | head -6`,
      { timeoutMs: 5000, reason: 'session-list' },
    );

    const output = typeof result === 'string' ? result : result?.output || '';
    const files = output.trim().split('\n').filter(Boolean);
    if (files.length === 0) return [];

    const sessions: PersistedSession[] = [];
    for (const file of files) {
      try {
        const content = await runRawCommand(
          `cat '${file.replace(/'/g, "'\\''")}'`,
          { timeoutMs: 5000, reason: 'session-read' },
        );
        const text = typeof content === 'string' ? content : content?.output || '';
        const parsed = JSON.parse(text.trim());
        sessions.push(parsed);
      } catch {
        // Skip corrupt files
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

/** Start auto-save timer for a project */
export function startAutoSave(projectPath: string, runRawCommand: RunCommand): void {
  stopAutoSave();

  // Periodic save
  _autoSaveTimer = setInterval(() => {
    saveSessionsToProject(projectPath, runRawCommand);
  }, AUTO_SAVE_INTERVAL);

  // Save on app background
  _appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState !== 'active') {
      saveSessionsToProject(projectPath, runRawCommand);
    }
  });
}

/** Stop auto-save timer */
export function stopAutoSave(): void {
  if (_autoSaveTimer) {
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;
  }
  if (_appStateSubscription) {
    _appStateSubscription.remove();
    _appStateSubscription = null;
  }
}
