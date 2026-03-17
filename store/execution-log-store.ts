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

type ExecutionLogStore = {
  entries: ExecutionLogEntry[];
  /** ターミナルタブでログパネルが開いているか */
  isLogPanelOpen: boolean;
  /** 未読ログ数（ターミナルタブにいない時に増加） */
  unreadCount: number;

  addEntry: (entry: Omit<ExecutionLogEntry, 'id' | 'timestamp'>) => void;
  updateEntry: (id: string, updates: Partial<ExecutionLogEntry>) => void;
  clearEntries: () => void;
  toggleLogPanel: () => void;
  resetUnread: () => void;
};

let _logId = 0;

export const useExecutionLogStore = create<ExecutionLogStore>((set, get) => ({
  entries: [],
  isLogPanelOpen: true,
  unreadCount: 0,

  addEntry: (entry) => {
    const id = `elog-${++_logId}-${Date.now()}`;
    const newEntry: ExecutionLogEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
    };
    set((state) => ({
      entries: [...state.entries.slice(-100), newEntry], // Keep last 100
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

  clearEntries: () => set({ entries: [], unreadCount: 0 }),

  toggleLogPanel: () => set((state) => ({ isLogPanelOpen: !state.isLogPanelOpen })),

  resetUnread: () => set({ unreadCount: 0 }),
}));
