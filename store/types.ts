// Shared TypeScript types for Shelly terminal app

// ─── Connection ───────────────────────────────────────────────────────────────

/** Legacy field kept on TabSession for backward compat */
export type ConnectionStatus = 'local' | 'ssh' | 'disconnected';

/**
 * Active execution mode for the terminal.
 * - 'termux'     : WebSocket → Termux bridge
 * - 'disconnected': bridge configured but not connected
 */
export type ConnectionMode = 'termux' | 'disconnected';

/** WebSocket connection health */
export type BridgeStatus =
  | 'idle'          // never connected
  | 'connecting'    // WS handshake in progress
  | 'connected'     // WS open, ready
  | 'disconnected'  // WS closed cleanly
  | 'error';        // WS error / timeout

export type TermuxSettings = {
  wsUrl: string;             // e.g. "ws://127.0.0.1:8765"
  autoReconnect: boolean;
  timeoutSeconds: number;    // command execution timeout
  ttyUrl?: string;           // ttyd WebView URL (default: "http://localhost:7681")
};

// ─── Output / Blocks ─────────────────────────────────────────────────────────

export type OutputLine = {
  text: string;
  type: 'stdout' | 'stderr' | 'info' | 'prompt';
};

/**
 * Fine-grained execution state for a command block.
 * - 'running'    : command is executing
 * - 'cancelling' : SIGINT sent, waiting for process to exit
 * - 'cancelled'  : process exited due to cancel (exitCode 130)
 * - 'done'       : process exited normally
 * - 'error'      : process exited with error or WS error
 */
export type BlockStatus = 'running' | 'cancelling' | 'cancelled' | 'done' | 'error';

export type CommandBlock = {
  id: string;
  sessionId: string;
  command: string;
  output: OutputLine[];
  timestamp: number;
  exitCode: number | null;
  isRunning: boolean;
  /** Fine-grained status (superset of isRunning) */
  blockStatus?: BlockStatus;
  isSavedSnippet?: boolean;
  /** Which mode was active when this block was created */
  connectionMode?: ConnectionMode;
  // ─── LLM通訳フィールド ─────────────────────────────────────────────────────
  /** Local LLMによる自然言語通訳テキスト（完了後に表示） */
  llmInterpretation?: string;
  /** ストリーミング中の通訳テキスト */
  llmInterpretationStreaming?: string;
  /** 通訳処理中フラグ */
  isInterpreting?: boolean;
  /** LLMが提案する修正コマンド（エラー時） */
  llmSuggestedCommand?: string;
  /** 通訳のタイプ */
  interpretType?: 'progress' | 'error' | 'success';
};

// ─── AI Block ────────────────────────────────────────────────────────────────

/**
 * AI処理の結果を表示するブロック。
 * CommandBlockと区別するためにblockType: 'ai'を持つ。
 *
 * 学習促進型ログ設計:
 * - logSummary: 1行サマリー（常時表示・薄い色）
 * - routingDetail: 詳細（タップで展開）
 * - mentionHint: @mention学習ヒント（3回表示後に消える）
 * - toolSuggestions: ツール提案カード（layer='natural'の場合）
 */
export type AiBlock = {
  id: string;
  sessionId: string;
  blockType: 'ai';
  /** 元のユーザー入力 */
  input: string;
  /** ルーティング先 */
  target: 'claude' | 'gemini' | 'local' | 'termux' | 'suggest' | 'perplexity' | 'team' | 'browser' | 'git';
  /** 入力レイヤー */
  layer: 'mention' | 'nl_with_tool' | 'natural' | 'command';
  /** 1行サマリー（常時表示） */
  logSummary: string;
  /** 詳細テキスト（タップで展開） */
  routingDetail?: string;
  /** AI応答テキスト（Local LLMが直接回答した場合） */
  response?: string;
  /** ツール提案リスト（layer='natural'の場合） */
  toolSuggestions?: Array<{
    target: 'claude' | 'gemini' | 'local' | 'perplexity' | 'team';
    label: string;
    reason: string;
    mentionExample: string;
    confidence: number;
  }>;
  /** @mention学習ヒント */
  mentionHint?: {
    key: string;
    text: string;
    example: string;
  };
  /** ヒントを表示するかどうか（shouldShowHintの結果） */
  showHint: boolean;
  timestamp: number;
  isStreaming?: boolean;
  /** ストリーミング中の累積テキスト */
  streamingText?: string;
  /** 生成済みトークン数 */
  tokenCount?: number;
  /** ストリーミング開始時刻 (Date.now()) */
  streamingStartTime?: number;
  /** Perplexity引用リスト */
  citations?: Array<{ url: string; title?: string }>;
};

/** ターミナルに表示するブロックの共用型 */
export type TerminalEntry = CommandBlock | AiBlock;

// ─── Sessions ─────────────────────────────────────────────────────────────────

export type TabSession = {
  id: string;
  name: string;
  connectionStatus: ConnectionStatus;
  currentDir: string;
  blocks: CommandBlock[];
  /** AI応答ブロック（CommandBlockと混在して表示） */
  entries: TerminalEntry[];
  commandHistory: string[];
  historyIndex: number;
};

// ─── Snippets ─────────────────────────────────────────────────────────────────

/**
 * Scope of a snippet:
 * - 'global'  : available in all sessions
 * - 'session' : only in the session it was created in
 */
export type SnippetScope = 'global' | 'session';

/**
 * Sort order for the Snippets list.
 */
export type SnippetSortOrder = 'lastUsed' | 'useCount' | 'createdAt';

export type Snippet = {
  id: string;
  title: string;           // auto-generated from first 20 chars, editable
  command: string;         // the actual command (required)
  tags: string[];          // optional tags for filtering
  createdAt: number;       // Unix ms
  lastUsedAt: number;      // Unix ms (updated on Run)
  useCount: number;        // incremented on Run
  scope: SnippetScope;
};

// ─── Creator Engine ──────────────────────────────────────────────────────────

/**
 * A single step in the build log shown in the Build lane.
 */
export type BuildStep = {
  id: string;
  message: string;          // human-readable log line
  command?: string;         // underlying shell command (optional)
  status: 'pending' | 'running' | 'done' | 'error';
  timestamp: number;
};

/**
 * The AI plan shown before execution.
 */
export type CreatorPlan = {
  summary: string;          // 1-2 sentence natural language description
  steps: string[];          // ordered list of what will be done
  projectType: ProjectType;
  projectName: string;      // slug-style, e.g. "portfolio-site"
  estimatedFiles: number;
};

export type ProjectType =
  | 'web'        // HTML + CSS + JS
  | 'script'     // Node.js or Python script
  | 'document'   // Markdown / JSON
  | 'unknown';

/**
 * A generated project stored in Projects/YYYY-MM-DD_name/
 */
export type CreatorProject = {
  id: string;
  name: string;             // display name
  slug: string;             // folder-safe slug
  projectType: ProjectType;
  createdAt: number;
  /** Last time the project was opened (updated on Open action) */
  lastOpenedAt?: number;
  path: string;             // e.g. "Projects/2026-02-25_portfolio-site"
  files: ProjectFile[];
  status: 'building' | 'done' | 'error';
  userInput: string;        // original natural language request
  plan: CreatorPlan | null;
  buildSteps: BuildStep[];
  /** Next action suggestions shown in Result lane */
  suggestions: string[];
  /** User-defined tags for filtering (e.g. ['school', 'website']) */
  tags?: string[];
  /** Whether files were actually written to Termux filesystem */
  termuxWritten?: boolean;
};

/** Sort order for project history */
export type ProjectSortOrder = 'createdAt' | 'lastOpenedAt' | 'name' | 'tags';

export type ProjectFile = {
  path: string;             // relative to project root, e.g. "src/index.html"
  content: string;
  language: string;         // "html" | "css" | "js" | "md" | "json" | "py" | "ts"
};

/**
 * A Recipe is a Snippet that represents a reusable Creator project template.
 * Stored in the Snippets store with tag "recipe".
 */
export type RecipeSnippet = {
  snippetId: string;        // references Snippet.id
  projectType: ProjectType;
  userInput: string;        // original prompt
  projectPath: string;
};

/**
 * Overall state of the Creator session (one active at a time).
 */
export type CreatorSessionStatus =
  | 'idle'        // waiting for user input
  | 'planning'    // AI generating plan
  | 'confirming'  // showing plan, waiting for user confirm
  | 'building'    // executing build steps
  | 'done'        // project complete
  | 'error';      // something went wrong

// ─── Settings ─────────────────────────────────────────────────────────────────

export type CursorShape = 'block' | 'underline' | 'bar';

export type ThemeVariant = 'black' | 'navy' | 'gray';

/**
 * How running a snippet from the Snippets tab behaves.
 * - 'insertOnly'  : paste command into input field, do NOT auto-submit
 * - 'insertAndRun': paste + submit immediately
 */
export type SnippetRunMode = 'insertOnly' | 'insertAndRun';

export type AppSettings = {
  fontSize: number;
  lineHeight: number;
  themeVariant: ThemeVariant;
  cursorShape: CursorShape;
  hapticFeedback: boolean;
  autoScroll: boolean;
  /** Sound effects (UI feedback sounds) */
  soundEffects: boolean;
  /** Sound volume (0.0 - 1.0) */
  soundVolume: number;
  /** How snippet Run works */
  snippetRunMode: SnippetRunMode;
  /** Auto-navigate to Terminal tab after running a snippet */
  snippetAutoReturn: boolean;
  /**
   * Debug: Force high-contrast colors for stdout/stderr output.
   * ON (default): stdout = #E8E8E8, stderr = #FF7878 — guaranteed readable on OLED.
   * OFF: use theme-dependent colors (may be harder to read on some displays).
   */
  highContrastOutput: boolean;
  // ─── Local LLM (Ollama) ───────────────────────────────────────────────────
  /** Enable local LLM for chat (Ollama-compatible API) */
  localLlmEnabled: boolean;
  /** Ollama API base URL (default: http://127.0.0.1:11434) */
  localLlmUrl: string;
  /** Model name to use (default: llama3.2:3b) */
  localLlmModel: string;
  // ─── Perplexity Sonar API ────────────────────────────────────────────────────────
  /** Perplexity Sonar API キー (https://www.perplexity.ai/settings/api) */
  perplexityApiKey?: string;
  /** Perplexityに使用するモデル (default: sonar-reasoning-pro) */
  perplexityModel?: string;
  // ─── Gemini API ────────────────────────────────────────────────────────────────
  /** Gemini API キー (https://aistudio.google.com/app/apikey) */
  geminiApiKey?: string;
  /** Geminiに使用するモデル (default: gemini-2.0-flash) */
  geminiModel?: string;
  // ─── ガラス背景・壁紙 ────────────────────────────────────────────────────────────
  /** 背景の透明度 (0.0=完全透明 〜 1.0=不透明, default: 1.0) */
  backgroundOpacity: number;
  /** ガラスブラー効果の強度 (0=なし 〜 100, default: 0) */
  blurIntensity: number;
  /** 壁紙画像URI (file:// or null) */
  wallpaperUri?: string;
  // ─── @team Table ────────────────────────────────────────────────────────────
  /** @teamに参加させるエージェントのON/OFF */
  teamMembers: {
    claude: boolean;
    gemini: boolean;
    codex: boolean;
    perplexity: boolean;
    local: boolean;
  };
  /** ファシリテーターの優先順位（先頭が最優先） */
  teamFacilitatorPriority: Array<'local' | 'claude' | 'gemini' | 'codex' | 'perplexity'>;
  /** Codex CLIコマンド名 (default: codex) */
  codexCmd?: string;
  // ─── コマンド安全システム ─────────────────────────────────────────────────────────────────────────────────────
  /** コマンド安全システムを有効にする (default: true) */
  enableCommandSafety: boolean;
  /** 確認ダイアログを表示する最低危険度 (default: 'HIGH') */
  safetyConfirmLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  /** 体験モード: 初心者向け詳細表示 / 経験者向け高速モード */
  experienceMode: 'learning' | 'fast';
  // ─── Obsidian RAG ─────────────────────────────────────────────────────────────
  /** Obsidian RAGを有効にする (default: false) */
  enableObsidianRag: boolean;
  /** Obsidian Vault のパス (例: /storage/emulated/0/ObsidianVault) */
  obsidianVaultPath: string;
  /** RAGで取得する最大ノート数 (default: 5) */
  ragMaxChunks: number;
  /** RAGを適用するAIメンション */
  ragTargetMentions: Array<'claude' | 'gemini' | 'local' | 'perplexity' | 'team'>;
  // ─── CLI Permission Proxy ────────────────────────────────────────────────────
  /** Chatタブ経由でのCLI自動承認レベル (default: 'safe') */
  autoApproveLevel: 'none' | 'safe' | 'all';
};
