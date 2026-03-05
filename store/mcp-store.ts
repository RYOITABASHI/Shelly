/**
 * store/mcp-store.ts
 *
 * MCP (Model Context Protocol) サーバーの状態管理 Zustand Store。
 * - 有効/無効の切り替え
 * - サーバーステータス監視
 * - Claude Code settings.json への自動反映
 * - AsyncStorage永続化
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  McpServerStatus,
  MCP_CATALOG,
  buildClaudeSettingsMcpBlock,
} from '@/lib/mcp-manager';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpServerState {
  enabled: boolean;
  status: McpServerStatus;
  lastError?: string;
  installedAt?: number;
}

interface McpStore {
  servers: Record<string, McpServerState>;
  isLoaded: boolean;
  /** 初期化フラグ（推奨サーバー自動有効化を1回だけ実行） */
  initialized: boolean;

  // Actions
  loadState: () => Promise<void>;
  toggleServer: (id: string) => void;
  setServerStatus: (id: string, status: McpServerStatus, error?: string) => void;
  markInstalled: (id: string) => void;
  enableRecommended: () => void;
  getEnabledIds: () => string[];
  generateClaudeConfig: () => Record<string, any>;
}

const STORAGE_KEY = '@shelly/mcp-servers';

// ─── Store ────────────────────────────────────────────────────────────────────

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: {},
  isLoaded: false,
  initialized: false,

  loadState: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        set({ servers: data.servers ?? {}, initialized: data.initialized ?? false, isLoaded: true });
      } else {
        set({ isLoaded: true });
      }
    } catch {
      set({ isLoaded: true });
    }
  },

  toggleServer: (id: string) => {
    const { servers } = get();
    const current = servers[id] ?? { enabled: false, status: 'stopped' as const };
    const updated = {
      ...servers,
      [id]: { ...current, enabled: !current.enabled },
    };
    set({ servers: updated });
    _persist(get());
  },

  setServerStatus: (id: string, status: McpServerStatus, error?: string) => {
    const { servers } = get();
    const current = servers[id] ?? { enabled: false, status: 'stopped' as const };
    const updated = {
      ...servers,
      [id]: { ...current, status, lastError: error },
    };
    set({ servers: updated });
    _persist(get());
  },

  markInstalled: (id: string) => {
    const { servers } = get();
    const current = servers[id] ?? { enabled: false, status: 'stopped' as const };
    const updated = {
      ...servers,
      [id]: { ...current, installedAt: Date.now() },
    };
    set({ servers: updated });
    _persist(get());
  },

  enableRecommended: () => {
    const { servers, initialized } = get();
    if (initialized) return;
    const updated = { ...servers };
    for (const def of MCP_CATALOG) {
      if (def.recommended) {
        updated[def.id] = {
          enabled: true,
          status: def.type === 'remote' || def.type === 'npx' ? 'running' : 'stopped',
          ...(updated[def.id] ?? {}),
        };
      }
    }
    set({ servers: updated, initialized: true });
    _persist(get());
  },

  getEnabledIds: () => {
    const { servers } = get();
    return Object.entries(servers)
      .filter(([, s]) => s.enabled)
      .map(([id]) => id);
  },

  generateClaudeConfig: () => {
    return buildClaudeSettingsMcpBlock(get().getEnabledIds());
  },
}));

// ─── Persistence ──────────────────────────────────────────────────────────────

async function _persist(state: McpStore) {
  try {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ servers: state.servers, initialized: state.initialized }),
    );
  } catch {
    // ignore
  }
}
