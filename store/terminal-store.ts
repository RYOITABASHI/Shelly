import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CommandBlock,
  AiBlock,
  TerminalEntry,
  TabSession,
  AppSettings,
  OutputLine,
  ConnectionMode,
} from './types';
import { executeCommand } from '@/lib/pseudo-shell';
import { execCommand } from '@/hooks/use-native-exec';
import { useSettingsStore } from './settings-store';

// ─── Multi-session pool ────────────────────────────────────────────────

const MAX_SESSIONS = 4;
const SESSION_NAMES = ['shelly-1', 'shelly-2', 'shelly-3', 'shelly-4'];

function allocateSessionName(sessions: TabSession[]): string | null {
  const used = new Set(sessions.map((s) => s.nativeSessionId));
  for (const name of SESSION_NAMES) {
    if (!used.has(name)) return name;
  }
  return null;
}

function createSession(id: string, name: string, sessionName: string = SESSION_NAMES[0]): TabSession {
  return {
    id,
    name,
    currentDir: '/data/data/com.termux/files/home',
    blocks: [],
    entries: [],
    commandHistory: [],
    historyIndex: -1,
    activeCli: null,
    tmuxSession: sessionName,
    nativeSessionId: sessionName,
    sessionStatus: 'starting',
    isAlive: false,
  };
}

// ─── Store type ───────────────────────────────────────────────────────────────

type TerminalState = {
  sessions: TabSession[];
  activeSessionId: string;
  settings: AppSettings;
  isSettingsLoaded: boolean;

  // Connection mode (always 'native' — JNI forkpty, no Termux bridge)
  connectionMode: ConnectionMode;

  /** Snippet insert-only: command to pre-fill in the input field */
  pendingCommand: string | null;

  /** Last input mode: 'shell' for commands, 'natural' for natural language */
  lastInputMode: 'shell' | 'natural';

  /** Active agent session — when set, all natural language input routes to this agent. Cleared by "ログアウト" / "/exit". */
  activeCliSession: string | null;
  setActiveCliSession: (session: string | null) => void;
  /** Set the active CLI for the current session (for recovery) */
  setActiveCli: (cli: TabSession['activeCli']) => void;

  // Actions — sessions
  addSession: () => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  clearSession: (sessionId?: string) => void;
  navigateHistory: (direction: 'up' | 'down') => string;

  // Actions — commands
  runCommand: (command: string) => void;
  /** Append a stdout/stderr line to a running block */
  appendOutputToBlock: (blockId: string, line: OutputLine) => void;
  /** Append multiple lines at once (batched — reduces re-renders) */
  appendOutputBatch: (blockId: string, lines: OutputLine[]) => void;
  /** Mark block as finished with exit code; also updates currentDir */
  finalizeBlock: (blockId: string, exitCode: number, newCwd?: string) => void;
  /** Mark block as errored (connection lost mid-run) */
  errorBlock: (blockId: string, message: string) => void;
  /** Mark block as 'cancelling' (SIGINT sent, waiting for exit) */
  markBlockCancelling: (blockId: string) => void;
  /** Mark block as 'cancelled' (exitCode 130, process killed) */
  cancelBlock: (blockId: string) => void;
  /** Update LLM interpretation fields on a block */
  updateBlockInterpretation: (blockId: string, fields: {
    isInterpreting?: boolean;
    llmInterpretationStreaming?: string;
    llmInterpretation?: string;
    llmSuggestedCommand?: string;
    interpretType?: 'progress' | 'error' | 'success';
  }) => void;

  // Actions — settings
  updateSettings: (settings: Partial<AppSettings>) => void;
  loadSettings: () => Promise<void>;
  saveSnippet: (blockId: string) => void;

  // Actions — connection
  setConnectionMode: (mode: ConnectionMode) => void;

  // Actions — pending command (Creator / Snippet insert)
  /** Pre-fill the Terminal input field without running */
  insertCommand: (command: string) => void;
  /** Clear the pending command after it has been consumed */
  clearPendingCommand: () => void;

  /** Session ID pending reset (consumed by terminal.tsx) */
  pendingResetSessionId: string | null;
  requestResetSession: (sessionId: string) => void;
  clearPendingReset: () => void;

  // Actions — input mode
  setLastInputMode: (mode: 'shell' | 'natural') => void;

  // Actions — session persistence
  saveSessionState: () => Promise<void>;
  loadSessionState: () => Promise<void>;

  // Actions — AI blocks
  /** Add an AI routing/response block to the active session's entries */
  addAiBlock: (block: AiBlock) => void;
  /** Update an existing AI block (e.g., append streaming response) */
  updateAiBlock: (blockId: string, updates: Partial<AiBlock>) => void;
  /** Add a CommandBlock to entries (mirrors blocks for unified display) */
  addEntryBlock: (block: CommandBlock) => void;
};

// ─── Store ────────────────────────────────────────────────────────────────────

const initialSession = createSession('session-1', 'Terminal 1');

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [initialSession],
  activeSessionId: 'session-1',
  // Settings synced from settings-store (backward compat)
  settings: useSettingsStore.getState().settings,
  isSettingsLoaded: false,

  // Native terminal (Plan B: JNI forkpty + linker64)
  connectionMode: 'native',
  pendingCommand: null,
  lastInputMode: 'shell',
  activeCliSession: null,
  setActiveCliSession: (session) => set({ activeCliSession: session }),

  setActiveCli: (cli) => {
    const { sessions, activeSessionId } = get();
    const prev = sessions.find((s) => s.id === activeSessionId)?.activeCli;
    console.log('[ActiveCli] change:', prev, '→', cli, 'session=', activeSessionId);
    set({
      sessions: sessions.map((s) =>
        s.id === activeSessionId ? { ...s, activeCli: cli } : s
      ),
    });
    get().saveSessionState();
  },

  // ── Session management ──────────────────────────────────────────────────────

  addSession: () => {
    const { sessions } = get();
    if (sessions.length >= MAX_SESSIONS) return;
    const sessionName = allocateSessionName(sessions);
    if (!sessionName) return;
    const id = `session-${Date.now()}`;
    const name = `Terminal ${sessions.length + 1}`;
    set((state) => ({
      sessions: [...state.sessions, createSession(id, name, sessionName)],
      activeSessionId: id,
    }));
    get().saveSessionState();
  },

  removeSession: (id: string) => {
    const { sessions, activeSessionId } = get();
    if (sessions.length <= 1) return;
    const newSessions = sessions.filter((s) => s.id !== id);
    const newActive = activeSessionId === id ? newSessions[0].id : activeSessionId;
    set({ sessions: newSessions, activeSessionId: newActive });
    get().saveSessionState();
  },

  setActiveSession: (id: string) => {
    set({ activeSessionId: id });
  },

  clearSession: (sessionId?: string) => {
    const targetId = sessionId ?? get().activeSessionId;
    const session = get().sessions.find((s) => s.id === targetId);
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === targetId ? { ...s, blocks: [], entries: [], commandHistory: [], currentDir: '/data/data/com.termux/files/home', sessionStatus: 'starting' as const, isAlive: false } : s
      ),
    }));
    // Also clear the execution log buffers so stale output doesn't reappear
    try {
      const { useExecutionLogStore } = require('@/store/execution-log-store');
      useExecutionLogStore.getState().clearTerminalOutput();
    } catch {}
    get().saveSessionState();
  },

  navigateHistory: (direction: 'up' | 'down') => {
    const { sessions, activeSessionId } = get();
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session || session.commandHistory.length === 0) return '';

    let newIndex = session.historyIndex;
    if (direction === 'up') {
      newIndex = Math.min(newIndex + 1, session.commandHistory.length - 1);
    } else {
      newIndex = Math.max(newIndex - 1, -1);
    }

    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId ? { ...s, historyIndex: newIndex } : s
      ),
    }));

    return newIndex === -1 ? '' : session.commandHistory[newIndex];
  },

  // ── Command execution (mock) ────────────────────────────────────────────────

  runCommand: (command: string) => {
    const { sessions, activeSessionId, connectionMode } = get();
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    const blockId = `block-${Date.now()}`;

    const newBlock: CommandBlock = {
      id: blockId,
      sessionId: activeSessionId,
      command,
      output: [],
      timestamp: Date.now(),
      exitCode: null,
      isRunning: true,
      connectionMode,
    };

    // Truncate overly long commands in history (keep first 500 chars)
    const historyCmd = command.length > 500 ? command.slice(0, 500) + '…' : command;
    const newHistory = command.trim()
      ? [historyCmd, ...session.commandHistory.filter((c) => c !== command && c !== historyCmd)].slice(0, 100)
      : session.commandHistory;

    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId
          ? { ...s, blocks: [...s.blocks, newBlock], commandHistory: newHistory, historyIndex: -1 }
          : s
      ),
    }));

    // Route: shelly <subcommand> → pseudo-shell (app-internal), everything else → JNI exec
    if (command.startsWith('shelly ') || command === 'shelly') {
      // Pseudo-shell handles shelly config / shelly workflow / shelly voice
      setTimeout(async () => {
        const currentSession = get().sessions.find((s) => s.id === activeSessionId);
        if (!currentSession) return;

        const result = await executeCommand(command, {
          cwd: currentSession.currentDir,
          env: {},
          history: currentSession.commandHistory,
        });

        if (result.lines.some((l) => l.text === '__CLEAR__')) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === activeSessionId ? { ...s, blocks: [] } : s
            ),
          }));
          return;
        }

        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  currentDir: result.newState.cwd ?? s.currentDir,
                  blocks: s.blocks.map((b) =>
                    b.id === blockId
                      ? {
                          ...b,
                          output: result.lines,
                          exitCode: result.lines.some((l) => l.type === 'stderr') ? 1 : 0,
                          isRunning: false,
                        }
                      : b
                  ),
                }
              : s
          ),
        }));
      }, 150);
    } else {
      // Real execution via JNI forkpty
      const currentSession = get().sessions.find((s) => s.id === activeSessionId);
      const cwd = currentSession?.currentDir;
      const fullCmd = cwd ? `cd '${cwd}' && ${command}` : command;
      execCommand(fullCmd).then((result) => {
        if (result.stdout) {
          get().appendOutputToBlock(blockId, { text: result.stdout, type: 'stdout' });
        }
        if (result.stderr) {
          get().appendOutputToBlock(blockId, { text: result.stderr, type: 'stderr' });
        }
        get().finalizeBlock(blockId, result.exitCode);
      }).catch((err: any) => {
        get().errorBlock(blockId, err?.message || 'Execution failed');
      });
    }
  },

  appendOutputToBlock: (blockId: string, line: OutputLine) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const block = sessions[sIdx].blocks[bIdx];
    const updatedBlock = { ...block, output: [...block.output, line] };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  appendOutputBatch: (blockId: string, lines: OutputLine[]) => {
    if (lines.length === 0) return;
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const block = sessions[sIdx].blocks[bIdx];
    const updatedBlock = { ...block, output: [...block.output, ...lines] };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  finalizeBlock: (blockId: string, exitCode: number, newCwd?: string) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const session = sessions[sIdx];
    const bIdx = session.blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const updatedBlock = { ...session.blocks[bIdx], exitCode, isRunning: false };
    const updatedBlocks = [...session.blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = {
      ...session,
      blocks: updatedBlocks,
      ...(newCwd ? { currentDir: newCwd } : {}),
    };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
    // Auto-save session state after command completes
    get().saveSessionState();
  },

  errorBlock: (blockId: string, message: string) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const block = sessions[sIdx].blocks[bIdx];
    const updatedBlock = {
      ...block,
      output: [...block.output, { text: `[ERROR] ${message}`, type: 'stderr' as const }],
      exitCode: -1,
      isRunning: false,
      blockStatus: 'error' as const,
    };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  markBlockCancelling: (blockId: string) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const updatedBlock = { ...sessions[sIdx].blocks[bIdx], blockStatus: 'cancelling' as const };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  cancelBlock: (blockId: string) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const updatedBlock = {
      ...sessions[sIdx].blocks[bIdx],
      exitCode: 130,
      isRunning: false,
      blockStatus: 'cancelled' as const,
    };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  updateBlockInterpretation: (blockId, fields) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const updatedBlock = { ...sessions[sIdx].blocks[bIdx], ...fields };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  // ── Settings (deprecated — use useSettingsStore directly) ────────────────

  updateSettings: (newSettings: Partial<AppSettings>) => {
    useSettingsStore.getState().updateSettings(newSettings);
  },

  saveSnippet: (blockId: string) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const bIdx = sessions[sIdx].blocks.findIndex((b) => b.id === blockId);
    if (bIdx === -1) return;
    const block = sessions[sIdx].blocks[bIdx];
    const updatedBlock = { ...block, isSavedSnippet: !block.isSavedSnippet };
    const updatedBlocks = [...sessions[sIdx].blocks];
    updatedBlocks[bIdx] = updatedBlock;
    const updatedSession = { ...sessions[sIdx], blocks: updatedBlocks };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  loadSettings: async () => {
    await useSettingsStore.getState().loadSettings();
    // Sync loaded values to terminal-store for backward compat
    const { settings, isSettingsLoaded } = useSettingsStore.getState();
    set({ settings, isSettingsLoaded });
    // Restore terminal sessions
    await get().loadSessionState();
  },

  // ── Connection ──────────────────────────────────────────────────────────────

  setConnectionMode: (mode: ConnectionMode) => {
    set({ connectionMode: mode });
  },

  // ── Pending command (Creator / Snippet insert) ─────────────────────────────────────────

  insertCommand: (command: string) => {
    set({ pendingCommand: command });
  },

  clearPendingCommand: () => {
    set({ pendingCommand: null });
  },

  // ── Session reset (consumed by terminal.tsx) ────────────────────────────────
  pendingResetSessionId: null,
  requestResetSession: (sessionId) => set({ pendingResetSessionId: sessionId }),
  clearPendingReset: () => set({ pendingResetSessionId: null }),

  // ── Input mode ─────────────────────────────────────────────────────────────

  setLastInputMode: (mode: 'shell' | 'natural') => {
    set({ lastInputMode: mode });
  },

  // ── Session persistence ─────────────────────────────────────────────────────

  saveSessionState: async () => {
    try {
      const { sessions, activeSessionId } = get();
      // Serialize sessions: keep last 50 blocks per session, strip running state
      const serializable = sessions.map((s) => ({
        id: s.id,
        name: s.name,
        currentDir: s.currentDir,
        commandHistory: s.commandHistory.slice(0, 100),
        blocks: s.blocks
          .filter((b) => !b.isRunning) // skip running blocks
          .slice(-50) // keep last 50
          .map((b) => ({
            ...b,
            isRunning: false,
            isInterpreting: false,
            llmInterpretationStreaming: undefined,
            blockStatus: b.exitCode === 0 ? 'done' : b.exitCode !== null ? 'error' : undefined,
          })),
        entries: s.entries
          .filter((e: any) => !e.isStreaming) // skip streaming AI blocks
          .slice(-50)
          .map((e: any) => ({
            ...e,
            isStreaming: false,
            streamingText: undefined, // clear partial streaming text
          })),
        activeCli: s.activeCli ?? null,
        tmuxSession: s.tmuxSession ?? 'shelly-1',
        nativeSessionId: s.nativeSessionId ?? s.tmuxSession ?? 'shelly-1',
        sessionStatus: 'starting',
        isAlive: false,
      }));
      await AsyncStorage.setItem('shelly_terminal_sessions', JSON.stringify({
        sessions: serializable,
        activeSessionId,
      }));
    } catch (e) {
      console.warn('[SessionPersist] save failed:', e);
    }
  },

  loadSessionState: async () => {
    try {
      const raw = await AsyncStorage.getItem('shelly_terminal_sessions');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed.sessions || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return;

      // Migration: detect old format by presence of ttyUrl field
      if (parsed.sessions[0]?.ttyUrl !== undefined) {
        parsed.sessions = parsed.sessions.map((s: any) => {
          const { port, ttyUrl, connectionStatus, ...rest } = s;
          return {
            ...rest,
            nativeSessionId: rest.tmuxSession || 'shelly-1',
            sessionStatus: 'starting' as const,
            isAlive: false,
          };
        });
      }

      // Restore sessions with defaults for missing fields
      const restored: TabSession[] = parsed.sessions.map((s: any, index: number) => ({
        ...createSession(s.id, s.name, s.tmuxSession || TMUX_NAMES[index] || 'shelly-1'),
        currentDir: s.currentDir || '/data/data/com.termux/files/home',
        commandHistory: s.commandHistory || [],
        blocks: (s.blocks || []).map((b: any) => ({ ...b, isRunning: false })),
        entries: (s.entries || []).map((e: any) => ({ ...e, isStreaming: false })),
        activeCli: s.activeCli ?? null,
        tmuxSession: s.tmuxSession || TMUX_NAMES[index] || 'shelly-1',
        nativeSessionId: s.nativeSessionId || s.tmuxSession || TMUX_NAMES[index] || 'shelly-1',
        sessionStatus: 'starting' as const,
        isAlive: false,
      }));
      const activeId = parsed.activeSessionId && restored.some((s: TabSession) => s.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : restored[0].id;
      set({ sessions: restored, activeSessionId: activeId });
    } catch (e) {
      console.warn('[SessionPersist] load failed:', e);
    }
  },

  // ── AI blocks ──────────────────────────────────────────────────────────────

  addAiBlock: (block: AiBlock) => {
    const { activeSessionId } = get();
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId
          ? { ...s, entries: [...s.entries, block] }
          : s
      ),
    }));
  },

  updateAiBlock: (blockId: string, updates: Partial<AiBlock>) => {
    const { sessions, activeSessionId } = get();
    const sIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (sIdx === -1) return;
    const eIdx = sessions[sIdx].entries.findIndex((e) => e.id === blockId);
    if (eIdx === -1) return;
    const updatedEntry = { ...sessions[sIdx].entries[eIdx], ...updates };
    const updatedEntries = [...sessions[sIdx].entries];
    updatedEntries[eIdx] = updatedEntry;
    const updatedSession = { ...sessions[sIdx], entries: updatedEntries };
    const updatedSessions = [...sessions];
    updatedSessions[sIdx] = updatedSession;
    set({ sessions: updatedSessions });
  },

  addEntryBlock: (block: CommandBlock) => {
    const { activeSessionId } = get();
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId
          ? { ...s, entries: [...s.entries, block] }
          : s
      ),
    }));
  },
}));

// ─── Selectors ────────────────────────────────────────────────────────────────

export const useActiveSession = () =>
  useTerminalStore(
    (s) => s.sessions.find((sess) => sess.id === s.activeSessionId) ?? s.sessions[0],
  );

// ─── Sync settings-store → terminal-store (backward compat) ────────────────
useSettingsStore.subscribe((state) => {
  useTerminalStore.setState({
    settings: state.settings,
    isSettingsLoaded: state.isSettingsLoaded,
  });
});
