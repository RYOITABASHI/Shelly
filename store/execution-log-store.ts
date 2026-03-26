/**
 * store/execution-log-store.ts — チャット↔ターミナル共有実行ログ
 *
 * チャットタブでBridge経由で実行されたコマンドとAI応答を記録し、
 * ターミナルタブでリアルタイム表示する。
 * 初学者が「裏で何が起きているか」を学べる。
 */

import { create } from 'zustand';

export type ExecutionLogEntry = {
  id: string;
  timestamp: number;
  /** 実行元 */
  source: 'chat' | 'ai-agent';
  /** 実行されたコマンド（シェルコマンドの場合） */
  command?: string;
  /** コマンド出力 */
  output?: string;
  /** 終了コード */
  exitCode?: number | null;
  /** AIエージェント名（AI経由の場合） */
  agent?: string;
  /** ユーザーの元の入力（自然言語） */
  userInput?: string;
  /** AIの応答テキスト（要約） */
  aiResponse?: string;
  /** ストリーミング中か */
  isStreaming?: boolean;
};

/** エラー検出パターン — sessionBufferで優先保持 */
const ERROR_PATTERNS = [
  /error/i, /fail/i, /exception/i, /fatal/i,
  /ENOENT/, /EACCES/, /EPERM/,
  /TypeError/, /SyntaxError/, /ReferenceError/,
  /exit code [1-9]/, /exit status [1-9]/,
  /command not found/i, /permission denied/i,
];

function isErrorLine(text: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(text));
}

/** ターミナル出力行（2層バッファ用） */
export type TerminalOutputLine = {
  text: string;
  timestamp: number;
  isError: boolean;
  /** Which terminal session produced this line */
  sessionId?: string;
};

const HOT_BUFFER_SIZE = 100;
const SESSION_BUFFER_SIZE = 1000;

/**
 * sessionBufferがSESSION_BUFFER_SIZEを超えた場合、
 * エラー行を優先保持し、非エラー行から先にFIFO破棄する。
 */
function pruneSessionBuffer(buffer: TerminalOutputLine[]): TerminalOutputLine[] {
  if (buffer.length <= SESSION_BUFFER_SIZE) return buffer;

  const errorLines = buffer.filter((l) => l.isError);
  const normalLines = buffer.filter((l) => !l.isError);

  if (errorLines.length >= SESSION_BUFFER_SIZE) {
    return errorLines.slice(-SESSION_BUFFER_SIZE);
  }

  const normalKeep = SESSION_BUFFER_SIZE - errorLines.length;
  return [
    ...normalLines.slice(-normalKeep),
    ...errorLines,
  ].sort((a, b) => a.timestamp - b.timestamp);
}

type ExecutionLogStore = {
  entries: ExecutionLogEntry[];
  /** リアルタイムオーバーレイ用（直近100行） */
  hotBuffer: TerminalOutputLine[];
  /** クロスペインインテリジェンス用（直近1000行、エラー優先保持） */
  sessionBuffer: TerminalOutputLine[];
  /** @deprecated hotBufferのtext配列を返す（後方互換） */
  terminalOutput: string[];
  /** ターミナルタブでログパネルが開いているか */
  isLogPanelOpen: boolean;
  /** 未読ログ数（ターミナルタブにいない時に増加） */
  unreadCount: number;

  addEntry: (entry: Omit<ExecutionLogEntry, 'id' | 'timestamp'>) => void;
  updateEntry: (id: string, updates: Partial<ExecutionLogEntry>) => void;
  /** ターミナル出力行を2層バッファに追加 */
  addTerminalOutput: (line: string, sessionId?: string) => void;
  /** エラー行の前後contextLines行を含む直近出力を取得。sessionIdでフィルタ可能 */
  getRecentOutput: (lines?: number, contextLines?: number, sessionId?: string) => string;
  /** ターミナル出力をクリア */
  clearTerminalOutput: () => void;
  clearEntries: () => void;
  toggleLogPanel: () => void;
  resetUnread: () => void;
};

let _logId = 0;

export const useExecutionLogStore = create<ExecutionLogStore>((set, get) => ({
  entries: [],
  hotBuffer: [],
  sessionBuffer: [],
  terminalOutput: [],
  isLogPanelOpen: false,
  unreadCount: 0,

  addEntry: (entry) => {
    const id = `elog-${++_logId}-${Date.now()}`;
    const newEntry: ExecutionLogEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
    };
    set((state) => ({
      entries: [...state.entries.slice(-100), newEntry],
      unreadCount: state.unreadCount + 1,
    }));
    return id;
  },

  updateEntry: (id, updates) => {
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    }));
  },

  addTerminalOutput: (text: string, sessionId?: string) => {
    const line: TerminalOutputLine = {
      text,
      timestamp: Date.now(),
      isError: isErrorLine(text),
      sessionId,
    };
    set((state) => {
      const newHot = [...state.hotBuffer.slice(-(HOT_BUFFER_SIZE - 1)), line];
      return {
        hotBuffer: newHot,
        sessionBuffer: pruneSessionBuffer([...state.sessionBuffer, line]),
        terminalOutput: newHot.map((l) => l.text),
      };
    });
  },

  getRecentOutput: (lines = 50, contextLines = 5, sessionId?: string) => {
    const { sessionBuffer } = get();
    const filtered = sessionId
      ? sessionBuffer.filter((l) => l.sessionId === sessionId)
      : sessionBuffer;
    const recent = filtered.slice(-lines);
    if (contextLines <= 0 || recent.length === 0) {
      return recent.map((l) => l.text).join('\n');
    }

    // エラー行の前後contextLines行もコンテキストとして含める
    const includeSet = new Set<number>();
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].isError) {
        for (let j = Math.max(0, i - contextLines); j <= Math.min(recent.length - 1, i + contextLines); j++) {
          includeSet.add(j);
        }
      }
    }
    if (includeSet.size === 0 || includeSet.size >= recent.length) {
      return recent.map((l) => l.text).join('\n');
    }
    return recent
      .filter((_, i) => includeSet.has(i))
      .map((l) => l.text)
      .join('\n');
  },

  clearTerminalOutput: () => set({ hotBuffer: [], sessionBuffer: [], terminalOutput: [] }),

  clearEntries: () => set({ entries: [], hotBuffer: [], sessionBuffer: [], terminalOutput: [], unreadCount: 0 }),

  toggleLogPanel: () => set((state) => ({ isLogPanelOpen: !state.isLogPanelOpen })),

  resetUnread: () => set({ unreadCount: 0 }),
}));
