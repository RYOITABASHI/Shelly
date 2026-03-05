/**
 * lib/mcp-manager.ts — v1.0
 *
 * MCP (Model Context Protocol) サーバー管理ライブラリ。
 *
 * Shellyから利用するMCPサーバーの定義・設定・状態管理。
 * Claude Code側の ~/.claude/settings.json への登録とは別に、
 * Termux上のMCPサーバー（Serena等）のライフサイクル管理を担当。
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type McpServerType = 'local' | 'remote' | 'npx';

export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface McpServerDef {
  id: string;
  name: string;
  description: string;
  type: McpServerType;
  /** アイコン名 (MaterialIcons) */
  icon: string;
  iconColor: string;
  /** 機能タグ */
  tags: string[];
  /** セットアップに必要なコマンド（local/npx のみ） */
  installCommand?: string;
  /** 起動コマンド（local のみ） */
  startCommand?: string;
  /** 停止コマンド（local のみ） */
  stopCommand?: string;
  /** 状態確認コマンド（local のみ） */
  statusCommand?: string;
  /** リモートURL（remote のみ） */
  remoteUrl?: string;
  /** npxパッケージ名（npx のみ） */
  npxPackage?: string;
  /** Claude Code settings.json 用の mcpServers エントリ */
  claudeConfig: {
    type: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
  };
  /** 推奨フラグ */
  recommended?: boolean;
  /** Shellyとの相性説明 */
  shellyNote: string;
}

// ─── Server Catalog ───────────────────────────────────────────────────────────

export const MCP_CATALOG: McpServerDef[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'ライブラリの最新ドキュメントをリアルタイム注入。React Native, Expo, NativeWind等に対応。',
    type: 'npx',
    icon: 'menu-book',
    iconColor: '#60A5FA',
    tags: ['docs', 'context', 'libraries'],
    npxPackage: '@upstash/context7-mcp@latest',
    claudeConfig: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
    },
    recommended: true,
    shellyNote: 'Shellyが使うExpo/RN/NativeWind/Zustand/tRPCの最新APIを常にコンテキストに注入。',
  },
  {
    id: 'expo',
    name: 'Expo MCP',
    description: 'Expo公式MCPサーバー。SDK 54対応。ドキュメント検索、パッケージ管理、設定生成。',
    type: 'remote',
    icon: 'phone-android',
    iconColor: '#818CF8',
    tags: ['expo', 'react-native', 'mobile'],
    remoteUrl: 'https://mcp.expo.dev/sse',
    claudeConfig: {
      type: 'http',
      url: 'https://api.expo.dev/mcp',
    },
    recommended: true,
    shellyNote: 'Shellyの技術スタックの中核。Expoの設定・パッケージ・ビルドを直接サポート。',
  },
  {
    id: 'serena',
    name: 'Serena',
    description: 'LSP経由でコードベース構造を解析。シンボル検索・定義ジャンプ・参照検索。',
    type: 'local',
    icon: 'account-tree',
    iconColor: '#34D399',
    tags: ['lsp', 'code-analysis', 'context'],
    installCommand: 'pip install serena-agent',
    startCommand: 'serena start-mcp-server',
    stopCommand: 'pkill -f "serena start-mcp-server"',
    statusCommand: 'pgrep -f "serena start-mcp-server" > /dev/null && echo "running" || echo "stopped"',
    claudeConfig: {
      type: 'stdio',
      command: 'serena',
      args: ['start-mcp-server', '--transport', 'stdio'],
    },
    recommended: true,
    shellyNote: 'TypeScriptのシンボル解析でShellyのコードベースを深く理解。既にインストール済み。',
  },
];

// ─── Shell Command Generators ─────────────────────────────────────────────────

/**
 * MCPサーバーのインストールコマンドを生成する。
 */
export function buildMcpInstallCommand(server: McpServerDef): string | null {
  switch (server.type) {
    case 'npx':
      // npxは自動インストールなので事前インストール不要
      return null;
    case 'local':
      return server.installCommand ?? null;
    case 'remote':
      // リモートはインストール不要
      return null;
  }
}

/**
 * MCPサーバーの起動コマンドを生成する。
 */
export function buildMcpStartCommand(server: McpServerDef): string | null {
  if (server.type === 'local' && server.startCommand) {
    return server.startCommand;
  }
  return null;
}

/**
 * MCPサーバーの停止コマンドを生成する。
 */
export function buildMcpStopCommand(server: McpServerDef): string | null {
  if (server.type === 'local' && server.stopCommand) {
    return server.stopCommand;
  }
  return null;
}

/**
 * MCPサーバーの状態確認コマンドを生成する。
 */
export function buildMcpStatusCommand(server: McpServerDef): string | null {
  if (server.type === 'local' && server.statusCommand) {
    return server.statusCommand;
  }
  return null;
}

/**
 * Claude Code settings.json 用の mcpServers オブジェクトを生成する。
 */
export function buildClaudeSettingsMcpBlock(
  enabledServerIds: string[],
): Record<string, any> {
  const mcpServers: Record<string, any> = {};
  for (const id of enabledServerIds) {
    const server = MCP_CATALOG.find((s) => s.id === id);
    if (!server) continue;
    mcpServers[server.id] = { ...server.claudeConfig };
  }
  return mcpServers;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getMcpServerById(id: string): McpServerDef | undefined {
  return MCP_CATALOG.find((s) => s.id === id);
}

export function getRecommendedMcpServers(): McpServerDef[] {
  return MCP_CATALOG.filter((s) => s.recommended);
}
