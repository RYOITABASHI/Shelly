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
  BridgeStatus,
  TermuxSettings,
} from './types';
import { executeCommand } from '@/lib/pseudo-shell';
import { saveApiKey, loadApiKeys, isApiKeyField, stripApiKeys } from '@/lib/secure-store';
import { useSoundStore } from '@/lib/sounds';

/** Pending tmux sessions to kill (consumed by useTermuxBridge on next tick) */
export const _pendingTmuxKills: string[] = [];

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 14,
  lineHeight: 1.4,
  themeVariant: 'black',
  cursorShape: 'block',
  hapticFeedback: true,
  autoScroll: true,
  soundEffects: true,
  soundVolume: 0.6,
  snippetRunMode: 'insertAndRun',
  snippetAutoReturn: true,
  // Default ON: ensures stdout/stderr is always readable on OLED displays (Z Fold6)
  highContrastOutput: true,
  // Local LLM (Ollama) — disabled by default until user sets up Ollama in Termux
  localLlmEnabled: false,
  localLlmUrl: 'http://127.0.0.1:8080',
  localLlmModel: 'Qwen2.5-3B-Instruct-Q4_K_M',
  // Groq API — デフォルトはモデル名のみ（APIキーはSecureStoreで管理）
  groqModel: 'llama-3.3-70b-versatile',
  // ガラス背景 — デフォルトは不透明ブラック
  backgroundOpacity: 1.0,
  blurIntensity: 0,
  // @team 首脳会談 — デフォルト設定
  teamMembers: {
    claude: true,
    gemini: true,
    codex: false,
    perplexity: true,
    local: true,
  },
  teamFacilitatorPriority: ['local', 'claude', 'gemini', 'codex', 'perplexity'],
  // コマンド安全システム — デフォルト有効
  enableCommandSafety: true,
  safetyConfirmLevel: 'HIGH' as const,
  experienceMode: 'learning' as const,
  // Obsidian RAG — デフォルト無効（Vaultパス設定後に有効化）
  enableObsidianRag: false,
  obsidianVaultPath: '/storage/emulated/0/ObsidianVault',
  ragMaxChunks: 5,
  ragTargetMentions: ['claude', 'gemini', 'local'] as Array<'claude' | 'gemini' | 'local' | 'perplexity' | 'team'>,
  // CLI Permission Proxy — 読み取りのみ自動承認
  autoApproveLevel: 'safe' as const,
  // ペルソナB向けデフォルトエージェント — Gemini CLI（無料枠・低ハードル）
  defaultAgent: 'gemini-cli' as const,
  realtimeTranslateEnabled: false,
  llmInterpreterEnabled: false,
  externalKeyboardShortcuts: false,
};

const DEFAULT_TERMUX_SETTINGS: TermuxSettings = {
  wsUrl: 'ws://127.0.0.1:8765',
  autoReconnect: true,
  timeoutSeconds: 30,
  ttyUrl: 'http://localhost:7681',
};

// ─── Multi-session port pool ─────────────────────────────────────────────────

const TTYD_PORT_BASE = 7681;
const MAX_SESSIONS = 2;
const TTYD_PORTS = Array.from({ length: MAX_SESSIONS }, (_, i) => TTYD_PORT_BASE + i);

function allocatePort(sessions: TabSession[]): number | null {
  const usedPorts = new Set(sessions.map((s) => s.port));
  for (const port of TTYD_PORTS) {
    if (!usedPorts.has(port)) return port;
  }
  return null;
}

function createSession(id: string, name: string, port: number = TTYD_PORT_BASE): TabSession {
  return {
    id,
    name,
    connectionStatus: 'local',
    currentDir: '/home/user',
    port,
    ttyUrl: `http://localhost:${port}`,
    blocks: [],
    entries: [],
    commandHistory: [],
    historyIndex: -1,
    activeCli: null,
    tmuxSession: `shelly-${port - TTYD_PORT_BASE + 1}`,
  };
}

// ─── Store type ───────────────────────────────────────────────────────────────

type TerminalState = {
  sessions: TabSession[];
  activeSessionId: string;
  settings: AppSettings;
  isSettingsLoaded: boolean;

  // Termux bridge state
  connectionMode: ConnectionMode;
  bridgeStatus: BridgeStatus;
  termuxSettings: TermuxSettings;

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
  /**
   * Called by useTermuxBridge when a real command starts streaming.
   * Creates the block in 'running' state and returns its id.
   */
  startTermuxBlock: (command: string) => string;
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
  setBridgeStatus: (status: BridgeStatus) => void;
  updateTermuxSettings: (s: Partial<TermuxSettings>) => void;

  // Actions — pending command (Creator / Snippet insert)
  /** Pre-fill the Terminal input field without running */
  insertCommand: (command: string) => void;
  /** Clear the pending command after it has been consumed */
  clearPendingCommand: () => void;

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
  settings: DEFAULT_SETTINGS,
  isSettingsLoaded: false,

  // Termux bridge
  connectionMode: 'termux',
  bridgeStatus: 'idle',
  termuxSettings: DEFAULT_TERMUX_SETTINGS,
  pendingCommand: null,
  lastInputMode: 'shell',
  activeCliSession: null,
  setActiveCliSession: (session) => set({ activeCliSession: session }),

  setActiveCli: (cli) => {
    const { sessions, activeSessionId } = get();
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
    const port = allocatePort(sessions);
    if (!port) return;
    const id = `session-${Date.now()}`;
    const name = `Terminal ${sessions.length + 1}`;
    set((state) => ({
      sessions: [...state.sessions, createSession(id, name, port)],
      activeSessionId: id,
    }));
    get().saveSessionState();
  },

  removeSession: (id: string) => {
    const { sessions, activeSessionId } = get();
    if (sessions.length <= 1) return;
    const removed = sessions.find((s) => s.id === id);
    if (removed?.tmuxSession) {
      _pendingTmuxKills.push(removed.tmuxSession);
    }
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
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === targetId ? { ...s, blocks: [], entries: [] } : s
      ),
    }));
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

    // Execute via pseudo-shell (mock mode)
    setTimeout(() => {
      const currentSession = get().sessions.find((s) => s.id === activeSessionId);
      if (!currentSession) return;

      const result = executeCommand(command, {
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
  },

  // ── Termux streaming block management ──────────────────────────────────────

  startTermuxBlock: (command: string) => {
    const { sessions, activeSessionId } = get();
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return '';

    const blockId = `block-${Date.now()}-tx`;

    const newBlock: CommandBlock = {
      id: blockId,
      sessionId: activeSessionId,
      command,
      output: [],
      timestamp: Date.now(),
      exitCode: null,
      isRunning: true,
      connectionMode: 'termux',
    };

    const newHistory = command.trim()
      ? [command, ...session.commandHistory.filter((c) => c !== command)].slice(0, 100)
      : session.commandHistory;

    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId
          ? { ...s, blocks: [...s.blocks, newBlock], commandHistory: newHistory, historyIndex: -1 }
          : s
      ),
    }));

    return blockId;
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

  // ── Settings ────────────────────────────────────────────────────────────────

  updateSettings: (newSettings: Partial<AppSettings>) => {
    set((state) => {
      const updated = { ...state.settings, ...newSettings };
      // Save API keys to SecureStore, strip them from AsyncStorage
      for (const [key, value] of Object.entries(newSettings)) {
        if (isApiKeyField(key) && typeof value === 'string') {
          saveApiKey(key, value);
        }
      }
      // Sync sound store with settings
      if ('soundEffects' in newSettings) {
        useSoundStore.getState().setEnabled(newSettings.soundEffects ?? true);
      }
      if ('soundVolume' in newSettings) {
        useSoundStore.getState().setVolume(newSettings.soundVolume ?? 0.6);
      }
      const forStorage = stripApiKeys(updated);
      AsyncStorage.setItem('shelly_settings', JSON.stringify(forStorage)).catch((e) => {
        console.error('[Settings] persist failed — settings may be lost on restart:', e);
      });
      return { settings: updated };
    });
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
    try {
      const [settingsRaw, termuxRaw, secureKeys] = await Promise.all([
        AsyncStorage.getItem('shelly_settings'),
        AsyncStorage.getItem('shelly_termux_settings'),
        loadApiKeys(),
      ]);
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsRaw ? JSON.parse(settingsRaw) : {}),
        ...secureKeys, // API keys from SecureStore override AsyncStorage
      };
      const termuxSettings = termuxRaw
        ? { ...DEFAULT_TERMUX_SETTINGS, ...JSON.parse(termuxRaw) }
        : DEFAULT_TERMUX_SETTINGS;
      // Sync sound store on load
      useSoundStore.getState().setEnabled(settings.soundEffects ?? true);
      useSoundStore.getState().setVolume(settings.soundVolume ?? 0.6);
      set({ settings, termuxSettings, isSettingsLoaded: true });
      // Restore terminal sessions
      await get().loadSessionState();
    } catch (err) {
      console.error('[Settings] loadSettings failed, using defaults:', err);
      set({ settings: DEFAULT_SETTINGS, termuxSettings: DEFAULT_TERMUX_SETTINGS, isSettingsLoaded: true });
    }
  },

  // ── Connection ──────────────────────────────────────────────────────────────

  setConnectionMode: (mode: ConnectionMode) => {
    set({ connectionMode: mode });
  },

  setBridgeStatus: (status: BridgeStatus) => {
    set({ bridgeStatus: status });
  },

  updateTermuxSettings: (s: Partial<TermuxSettings>) => {
    set((state) => {
      const updated = { ...state.termuxSettings, ...s };
      // Warn if non-local WebSocket URL is configured (security risk)
      if (updated.wsUrl && !/^wss?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(updated.wsUrl)) {
        console.warn('[Security] Non-local WebSocket URL detected:', updated.wsUrl, '— Consider using wss:// for remote connections.');
      }
      AsyncStorage.setItem('shelly_termux_settings', JSON.stringify(updated)).catch((e) => {
        console.warn('[TermuxSettings] persist failed:', e);
      });
      return { termuxSettings: updated };
    });
  },

  // ── Pending command (Creator / Snippet insert) ─────────────────────────────────────────

  insertCommand: (command: string) => {
    set({ pendingCommand: command });
  },

  clearPendingCommand: () => {
    set({ pendingCommand: null });
  },

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
        port: s.port,
        ttyUrl: s.ttyUrl,
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
        tmuxSession: s.tmuxSession ?? `shelly-${s.port - TTYD_PORT_BASE + 1}`,
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
      const data = JSON.parse(raw);
      if (!data.sessions || !Array.isArray(data.sessions) || data.sessions.length === 0) return;
      // Restore sessions with defaults for missing fields
      const restored: TabSession[] = data.sessions.map((s: any, index: number) => ({
        ...createSession(s.id, s.name, s.port || TTYD_PORT_BASE + index),
        currentDir: s.currentDir || '/home/user',
        commandHistory: s.commandHistory || [],
        blocks: (s.blocks || []).map((b: any) => ({ ...b, isRunning: false })),
        entries: (s.entries || []).map((e: any) => ({ ...e, isStreaming: false })),
        activeCli: s.activeCli ?? null,
        tmuxSession: s.tmuxSession ?? `shelly-${(s.port || TTYD_PORT_BASE + index) - TTYD_PORT_BASE + 1}`,
      }));
      const activeId = data.activeSessionId && restored.some((s: TabSession) => s.id === data.activeSessionId)
        ? data.activeSessionId
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
