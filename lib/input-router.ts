/**
 * lib/input-router.ts — v2.6
 *
 * Terminal input 4-layer routing parser.
 *
 * Priority:
 *   1. @mention    — @claude / @gemini / @local for direct tool targeting
 *   2. NL + tool   — Natural language containing tool name keywords
 *   3. NL only     — Natural language → AI suggests best tool
 *   4. Shell cmd   — ls / git status etc → Termux direct execution
 */
import { t } from '@/lib/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RouteTarget = 'claude' | 'gemini' | 'local' | 'termux' | 'suggest' | 'perplexity' | 'groq' | 'cerebras' | 'team' | 'browser' | 'git' | 'agent' | 'codex' | 'plan' | 'arena' | 'actions';

export type InputLayer =
  | 'mention'        // @claude / @gemini / @local
  | 'nl_with_tool'   // 自然言語 + ツール名キーワード
  | 'natural'        // 自然言語のみ → ツール提案
  | 'command';       // シェルコマンド → Termux直接実行

export interface ParsedInput {
  layer: InputLayer;
  target: RouteTarget;
  /** ツールに渡す実際のプロンプト/コマンド（@mentionプレフィックスを除いた文字列） */
  prompt: string;
  /** 元の入力テキスト */
  raw: string;
  /** ツール提案（layer === 'natural' の場合に設定） */
  suggestions?: ToolSuggestion[];
  /** 実行ログに表示するサマリー（1行） */
  logSummary: string;
  /** ヒント表示用: 初心者向け @mention 学習ヒント */
  mentionHint?: MentionHint;
}

export interface ToolSuggestion {
  target: RouteTarget;
  label: string;
  reason: string;
  /** タップで入力欄に挿入する @mention コマンド例 */
  mentionExample: string;
  /** 推奨度（0-1） */
  confidence: number;
}

export interface MentionHint {
  /** ヒントのキー（AsyncStorageで表示回数を管理） */
  key: string;
  /** ヒントテキスト */
  text: string;
  /** @mention の例 */
  example: string;
}

// ─── @mention パターン ────────────────────────────────────────────────────────

const MENTION_PATTERNS: Array<{ pattern: RegExp; target: RouteTarget; label: string }> = [
  { pattern: /^@claude\s*/i,  target: 'claude',  label: 'Claude Code' },
  { pattern: /^@gemini\s*/i,  target: 'gemini',  label: 'Gemini CLI' },
  { pattern: /^@local\s*/i,   target: 'local',   label: 'Local LLM' },
  { pattern: /^@llm\s*/i,     target: 'local',   label: 'Local LLM' },
  { pattern: /^@ai\s*/i,      target: 'local',   label: 'Local LLM' },
  { pattern: /^@perplexity\s*/i, target: 'perplexity', label: 'Perplexity' },
  { pattern: /^@pplx\s*/i,       target: 'perplexity', label: 'Perplexity' },
  { pattern: /^@search\s*/i,     target: 'perplexity', label: 'Perplexity' },
  { pattern: /^@open\s*/i,        target: 'browser',    label: 'Browser' },
  { pattern: /^@browse\s*/i,      target: 'browser',    label: 'Browser' },
  { pattern: /^@team\s*/i,         target: 'team',        label: 'Team Table' },
  { pattern: /^@table\s*/i,       target: 'team',        label: 'Team Table' },
  { pattern: /^@git\s*/i,          target: 'git',         label: 'Git Guide' },
  { pattern: /^@codex\s*/i,        target: 'codex',       label: 'Codex CLI' },
  { pattern: /^@cerebras\s*/i,    target: 'cerebras',    label: 'Cerebras' },
  { pattern: /^@agent\s*/i,        target: 'agent',       label: 'AI Agent' },
  { pattern: /^@edit\s*/i,         target: 'agent',       label: 'AI Agent' },
  { pattern: /^@code\s*/i,         target: 'agent',       label: 'AI Agent' },
  { pattern: /^@plan\s*/i,         target: 'plan',        label: 'Plan Mode' },
  { pattern: /^@arena\s*/i,        target: 'arena',       label: 'Arena Mode' },
  { pattern: /^@battle\s*/i,       target: 'arena',       label: 'Arena Mode' },
  { pattern: /^@compare\s*/i,      target: 'arena',       label: 'Arena Mode' },
  { pattern: /^@actions\s*/i,      target: 'actions',     label: 'GitHub Actions' },
  { pattern: /^@ci\s*/i,           target: 'actions',     label: 'GitHub Actions' },
];

// ─── 自然言語 + ツール名キーワード ────────────────────────────────────────────

const NL_TOOL_PATTERNS: Array<{ keywords: string[]; target: RouteTarget; label: string }> = [
  {
    keywords: [
      'claudeで', 'claude codeで', 'claudeに', 'claude codeに', 'claudecodeで', 'claudecodeに',
      'クロードで', 'クロードに', 'クロードコードで', 'クロードコードに',
      'claudeを実行', 'claude codeを実行', 'claudecodeを実行', 'クロードを実行', 'クロードコードを実行',
      'claudeを起動', 'claude codeを起動', 'claudecodeを起動', 'クロードを起動', 'クロードコードを起動',
      'claude使って', 'claude code使って', 'claudecode使って', 'クロード使って',
      'claude開いて', 'claudecode開いて', 'クロード開いて',
    ],
    target: 'claude',
    label: 'Claude Code',
  },
  {
    keywords: [
      'geminiで', 'gemini cliで', 'geminiに', 'ジェミニで', 'ジェミニに',
      'geminiを実行', 'gemini cliを実行', 'ジェミニを実行',
      'geminiを起動', 'gemini cliを起動', 'ジェミニを起動',
      'gemini使って', 'gemini cli使って', 'ジェミニ使って',
      'gemini開いて', 'ジェミニ開いて',
    ],
    target: 'gemini',
    label: 'Gemini CLI',
  },
  {
    keywords: [
      'codexで', 'codexに', 'コデックスで', 'コデックスに',
      'codexを実行', 'コデックスを実行', 'codexを起動', 'コデックスを起動',
      'codex使って', 'コデックス使って', 'codex開いて', 'コデックス開いて',
    ],
    target: 'codex',
    label: 'Codex CLI',
  },
  {
    keywords: ['ローカルllmで', 'local llmで', 'ollamaで', 'ローカルで', 'オフラインで'],
    target: 'local',
    label: 'Local LLM',
  },
  {
    keywords: ['論文を調べて', '論文検索', '論文を検索', 'パープレで', 'perplexityで', 'ウェブ検索', '最新研究', 'リアルタイム検索'],
    target: 'perplexity',
    label: 'Perplexity',
  },
];

// ─── シェルコマンド判定 ────────────────────────────────────────────────────────

/**
 * 入力がシェルコマンドかどうかを判定する。
 * 先頭が既知のコマンド名で始まる場合はシェルコマンドとみなす。
 */
const SHELL_COMMAND_PREFIXES = [
  // ファイル操作
  'ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'cat', 'less',
  'head', 'tail', 'find', 'grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'diff',
  // テキスト
  'echo', 'printf', 'read', 'tee',
  // プロセス
  'ps', 'kill', 'top', 'htop', 'jobs', 'fg', 'bg', 'nohup',
  // ネットワーク
  'curl', 'wget', 'ping', 'ssh', 'scp', 'nc', 'netstat', 'ifconfig', 'ip',
  // パッケージ
  'apt', 'apt-get', 'pkg', 'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm',
  // 開発ツール
  'git', 'node', 'python', 'python3', 'ruby', 'go', 'cargo', 'make', 'cmake',
  'gcc', 'g++', 'clang', 'javac', 'java',
  // AI CLI
  'claude', 'gemini', 'codex', 'ollama',
  // シェル制御
  'clear', 'history', 'which', 'whereis', 'type', 'alias', 'export', 'source',
  'chmod', 'chown', 'chgrp', 'sudo', 'su',
  // アーカイブ
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  // その他
  'date', 'time', 'sleep', 'watch', 'xargs', 'env', 'printenv', 'set',
  'df', 'du', 'free', 'uname', 'whoami', 'id', 'hostname',
  // ターミナル制御
  'tmux', 'screen', 'vim', 'vi', 'nano', 'emacs',
];

/**
 * パイプ・リダイレクト・セミコロンなどのシェル構文を含む場合はコマンドとみなす
 */
const SHELL_SYNTAX_PATTERN = /[|>&;$`\\]|\d+>/;

/**
 * 相対/絶対パスで始まる場合はコマンドとみなす
 */
const PATH_COMMAND_PATTERN = /^[./~]/;

export function isShellCommand(input: string): boolean {
  const trimmed = input.trim();

  // パス形式
  if (PATH_COMMAND_PATTERN.test(trimmed)) return true;

  // シェル構文
  if (SHELL_SYNTAX_PATTERN.test(trimmed)) return true;

  // 既知コマンドプレフィックス
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (SHELL_COMMAND_PREFIXES.includes(firstWord)) return true;

  return false;
}

// ─── 軽量タスク判定（API不要、シェル直送） ───────────────────────────────────

type LightweightMatch = { command: string; label: string };

const LIGHTWEIGHT_PATTERNS: Array<{ pattern: RegExp; command: string; label: string; hasCaptureGroup?: boolean }> = [
  { pattern: /^(?:ファイル一覧|ファイルを?見せて|ファイルを?表示|フォルダの中身|list files)/i, command: 'ls -la', label: 'ls -la' },
  { pattern: /^(?:今どこ|現在の?ディレクトリ|カレントディレクトリ|current dir|where am i)/i, command: 'pwd', label: 'pwd' },
  { pattern: /^(?:ディスク容量|ディスク使用|空き容量|disk space|storage)/i, command: 'df -h', label: 'df -h' },
  { pattern: /^(?:メモリ|RAM|memory usage)/i, command: 'free -h 2>/dev/null || cat /proc/meminfo | head -5', label: 'memory check' },
  { pattern: /^(?:日時|今何時|日付|date|time now)/i, command: 'date', label: 'date' },
  { pattern: /^(?:自分は?誰|ユーザー名|whoami|who am i)/i, command: 'whoami', label: 'whoami' },
  { pattern: /^(?:OS情報|システム情報|uname|system info)/i, command: 'uname -a', label: 'uname -a' },
  { pattern: /^(?:プロセス一覧|実行中|running processes)/i, command: 'ps aux 2>/dev/null || ps', label: 'ps' },
  { pattern: /^(?:環境変数|env vars|printenv)/i, command: 'printenv | head -30', label: 'printenv' },
  { pattern: /^(?:IP.*アドレス|ipアドレス|ip address|my ip)/i, command: 'ip addr show 2>/dev/null || ifconfig 2>/dev/null || echo "ip command not found"', label: 'ip addr' },
  // Package management
  { pattern: /^(?:パッケージ|package)(?:を|)(?:更新|アップデート|update)/i, command: 'pkg update -y && pkg upgrade -y', label: 'pkg update' },
  { pattern: /^(?:(?:install|インストール)\s+)(.+)/i, command: 'pkg install -y $1', label: 'pkg install', hasCaptureGroup: true },
  { pattern: /^(?:(?:remove|削除|アンインストール)\s+)(.+)/i, command: 'pkg remove -y $1', label: 'pkg remove', hasCaptureGroup: true },
  { pattern: /^(?:(?:search|検索|探す)\s+(?:package|パッケージ)\s+)(.+)/i, command: 'pkg search $1', label: 'pkg search', hasCaptureGroup: true },
];

/** Shell-safe character set for package names / search terms */
const SAFE_CAPTURE_PATTERN = /^[a-zA-Z0-9._@/+ -]+$/;

function matchLightweightTask(input: string): LightweightMatch | null {
  const trimmed = input.trim();
  for (const { pattern, command, label, hasCaptureGroup } of LIGHTWEIGHT_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      if (hasCaptureGroup && match[1]) {
        const captured = match[1].trim();
        // Reject (not strip) inputs containing shell metacharacters
        if (!captured || !SAFE_CAPTURE_PATTERN.test(captured)) return null;
        return { command: command.replace('$1', captured), label };
      }
      return { command, label };
    }
  }
  return null;
}

// ─── ターミナル参照パターン（クロスペインインテリジェンス） ─────────────────────

const TERMINAL_REFERENCE_PATTERNS = [
  // 日本語
  /右の(画面|エラー|出力)/,
  /ターミナル(の|にある|に出てる)(エラー|出力|結果|ログ)/,
  /さっきの(エラー|出力|結果)/,
  /このエラー(を|)(直して|修正して|説明して|教えて)/,
  // 英語
  /right\s*(panel|screen|side|pane)/i,
  /(fix|explain|what('s| is))\s*(the|this)\s*(error|output|result)/i,
  /terminal\s*(output|error|result|log)/i,
  /(look at|check|see|read)\s*(the\s*)?(terminal|right)/i,
  // セカンドオピニオン (5-3)
  /右で(やってる|やっている)こと(を|)(レビュー|評価|確認|チェック)/,
  /Claudeが(やってる|やっている)こと(どう|どう思う)/,
  /(別の|他の)AI(に|で)(聞|確認|レビュー)/,
  /review what('s| is) (happening|going on) (on the|in the) (right|terminal)/i,
  /second opinion/i,
  /what do you think (about|of) (the|this) (approach|code|change)/i,
  // セッションサマリー (5-4)
  /さっきの作業(を|)(まとめ|要約|サマリ)/,
  /作業(内容|ログ|履歴)(を|)(まとめ|教えて)/,
  /summarize (the|this|my) (session|work|changes)/i,
  /what did (I|we) (do|change|modify)/i,
];

/**
 * ユーザー入力がターミナル出力を参照しているかチェック。
 * クロスペインインテリジェンスの起点。
 */
export function hasTerminalReference(input: string): boolean {
  return TERMINAL_REFERENCE_PATTERNS.some((p) => p.test(input));
}

export type TerminalIntent = 'reference' | 'second-opinion' | 'session-summary';

const SECOND_OPINION_PATTERNS = [
  /右で(やってる|やっている)こと(を|)(レビュー|評価|確認|チェック)/,
  /Claudeが(やってる|やっている)こと(どう|どう思う)/,
  /(別の|他の)AI(に|で)(聞|確認|レビュー)/,
  /review what('s| is) (happening|going on) (on the|in the) (right|terminal)/i,
  /second opinion/i,
  /what do you think (about|of) (the|this) (approach|code|change)/i,
];

const SESSION_SUMMARY_PATTERNS = [
  /さっきの作業(を|)(まとめ|要約|サマリ)/,
  /作業(内容|ログ|履歴)(を|)(まとめ|教えて)/,
  /summarize (the|this|my) (session|work|changes)/i,
  /what did (I|we) (do|change|modify)/i,
];

/**
 * ターミナル参照のインテントを判定する。
 * セカンドオピニオンやサマリーは異なるシステムプロンプトを使うため。
 */
export function getTerminalIntent(input: string): TerminalIntent | null {
  if (SECOND_OPINION_PATTERNS.some((p) => p.test(input))) return 'second-opinion';
  if (SESSION_SUMMARY_PATTERNS.some((p) => p.test(input))) return 'session-summary';
  if (hasTerminalReference(input)) return 'reference';
  return null;
}

// ─── GitHub Actions インテント検出 ────────────────────────────────────────────

const GITHUB_ACTIONS_PATTERNS = [
  /ビルド(して|を実行|走らせて)/,
  /テスト(を|)(実行|走らせて|回して)/,
  /デプロイ(して|を実行)/,
  /CI(を|)(設定|セットアップ)/,
  /build (this|the|my) (app|project)/i,
  /run (the |my )?(tests?|test suite)/i,
  /set ?up CI/i,
];

/**
 * Check if the input expresses intent to use GitHub Actions
 * (build, test, deploy, CI setup).
 */
export function hasGitHubActionsIntent(input: string): boolean {
  return GITHUB_ACTIONS_PATTERNS.some((p) => p.test(input));
}

// ─── 自然言語タスク分類（ツール提案用） ──────────────────────────────────────

/**
 * 自然言語入力から最適ツールの提案を生成する。
 * classifyTask（local-llm.ts）と連携するが、こちらはUI表示用の提案リストを返す。
 */
export function buildToolSuggestions(input: string): ToolSuggestion[] {
  const lower = input.toLowerCase();
  const suggestions: ToolSuggestion[] = [];

  // コード生成・実装系 → Claude Code 推奨
  const codeSignals = [
    'コードを', '実装して', '作って', '書いて', 'プログラム', 'スクリプト',
    'バグ', 'エラー', 'リファクタ', 'テスト', 'デバッグ',
    'typescript', 'javascript', 'python', 'react', 'html', 'css',
    '.ts', '.js', '.py', '.tsx', 'コンポーネント', '関数', 'クラス', 'api',
    'implement', 'create', 'build', 'write', 'fix', 'refactor',
  ];
  const codeScore = codeSignals.filter((k) => lower.includes(k)).length;
  if (codeScore > 0) {
    suggestions.push({
      target: 'claude',
      label: 'Claude Code',
      reason: t('router.code_reason'),
      mentionExample: `@claude ${input}`,
      confidence: Math.min(0.95, 0.5 + codeScore * 0.15),
    });
  }

  // 調査・検索・情報収集系 → Gemini CLI 推奨
  const researchSignals = [
    '調べて', '検索して', '最新', 'ニュース', '情報', 'ドキュメント',
    '説明して', 'とは', 'について', '比較', 'メリット', 'デメリット',
    'search', 'research', 'find', 'explain', 'what is', 'how does',
    'documentation', 'spec', '仕様', '調査',
  ];
  const researchScore = researchSignals.filter((k) => lower.includes(k)).length;
  if (researchScore > 0) {
    suggestions.push({
      target: 'gemini',
      label: 'Gemini CLI',
      reason: t('router.research_reason'),
      mentionExample: `@gemini ${input}`,
      confidence: Math.min(0.9, 0.5 + researchScore * 0.15),
    });
  }

  // 会話・質問・アドバイス系 → Local LLM 推奨
  const chatSignals = [
    'こんにちは', 'ありがとう', '教えて', '質問', '相談', 'どう思う',
    'アドバイス', 'おすすめ', 'hello', 'hi', 'thanks', 'help',
    'どうすれば', 'どうやって', 'なぜ', 'なんで',
  ];
  const chatScore = chatSignals.filter((k) => lower.includes(k)).length;
  if (chatScore > 0) {
    suggestions.push({
      target: 'local',
      label: 'Local LLM',
      reason: t('router.chat_reason'),
      mentionExample: `@local ${input}`,
      confidence: Math.min(0.85, 0.4 + chatScore * 0.15),
    });
  }

  // Default suggestion if nothing matched
  if (suggestions.length === 0) {
    suggestions.push({
      target: 'claude',
      label: 'Claude Code',
      reason: t('router.default_reason'),
      mentionExample: `@claude ${input}`,
      confidence: 0.6,
    });
    suggestions.push({
      target: 'gemini',
      label: 'Gemini CLI',
      reason: t('router.research_fallback'),
      mentionExample: `@gemini ${input}`,
      confidence: 0.4,
    });
  }

  // confidenceで降順ソート
  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

// ─── メインパーサー ───────────────────────────────────────────────────────────

/**
 * ユーザー入力を解析し、ルーティング情報を返す。
 *
 * 優先順位:
 *   1. @mention
 *   2. 自然言語 + ツール名
 *   3. 自然言語のみ
 *   4. シェルコマンド
 */
export function parseInput(input: string): ParsedInput {
  const trimmed = input.trim();

  // ── 1. @mention ──────────────────────────────────────────────────────────────
  for (const { pattern, target, label } of MENTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      const prompt = trimmed.replace(pattern, '').trim();
      return {
        layer: 'mention',
        target,
        prompt,
        raw: trimmed,
        logSummary: `[${label}] ${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`,
      };
    }
  }

  // ── 2. 自然言語 + ツール名 ────────────────────────────────────────────────────
  const lower = trimmed.toLowerCase();
  for (const { keywords, target, label } of NL_TOOL_PATTERNS) {
    if (keywords.some((k) => lower.includes(k))) {
      return {
        layer: 'nl_with_tool',
        target,
        prompt: trimmed,
        raw: trimmed,
        logSummary: `[${label}] ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}`,
        mentionHint: {
          key: `hint_mention_${target}`,
          text: t('router.mention_hint', { target: target === 'claude' ? 'claude' : target === 'gemini' ? 'gemini' : 'local' }),
          example: `@${target === 'claude' ? 'claude' : target === 'gemini' ? 'gemini' : 'local'} ${trimmed.replace(/claudeで|geminiで|ローカルllmで/gi, '').trim()}`,
        },
      };
    }
  }

  // ── 4. シェルコマンド（自然言語判定より先に実行） ──────────────────────────
  if (isShellCommand(trimmed)) {
    return {
      layer: 'command',
      target: 'termux',
      prompt: trimmed,
      raw: trimmed,
      logSummary: `[Termux] ${trimmed}`,
    };
  }

  // ── 4.5 軽量タスク → API不要、シェルコマンドに変換して直送 ─────────────────
  const shellShortcut = matchLightweightTask(trimmed);
  if (shellShortcut) {
    return {
      layer: 'command',
      target: 'termux',
      prompt: shellShortcut.command,
      raw: trimmed,
      logSummary: `[Termux] ${shellShortcut.label}`,
    };
  }

  // ── 3. 自然言語のみ → ツール提案 ─────────────────────────────────────────────
  const suggestions = buildToolSuggestions(trimmed);
  const topSuggestion = suggestions[0];
  return {
    layer: 'natural',
    target: 'suggest',
    prompt: trimmed,
    raw: trimmed,
    suggestions,
    logSummary: t('router.log_suggest', { tool: topSuggestion.label, text: trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '') }),
    mentionHint: {
      key: 'hint_mention_suggest',
      text: t('router.mention_hint', { target: 'mention' }),
      example: topSuggestion.mentionExample,
    },
  };
}

// ─── ログ表示ユーティリティ ───────────────────────────────────────────────────

/**
 * ルーティングログの詳細テキストを生成する。
 * タップで展開される詳細パネルに表示。
 */
export function buildRoutingDetail(parsed: ParsedInput): string {
  const lines: string[] = [];

  switch (parsed.layer) {
    case 'mention':
      lines.push(t('router.detail_mention'));
      lines.push(t('router.detail_target', { target: getTargetLabel(parsed.target) }));
      lines.push(t('router.detail_prompt', { prompt: parsed.prompt }));
      break;

    case 'nl_with_tool':
      lines.push(t('router.detail_nl_tool'));
      lines.push(t('router.detail_detected', { tool: getTargetLabel(parsed.target) }));
      lines.push(t('router.detail_prompt', { prompt: parsed.prompt }));
      if (parsed.mentionHint) {
        lines.push(t('router.detail_hint', { hint: parsed.mentionHint.example }));
      }
      break;

    case 'natural':
      lines.push(t('router.detail_natural'));
      if (parsed.suggestions) {
        parsed.suggestions.slice(0, 3).forEach((s, i) => {
          const pct = Math.round(s.confidence * 100);
          lines.push(`${i + 1}. ${s.label} (${pct}%) — ${s.reason}`);
        });
      }
      break;

    case 'command':
      lines.push(t('router.detail_command'));
      lines.push(t('router.detail_target', { target: 'Termux' }));
      lines.push(t('router.detail_prompt', { prompt: parsed.prompt }));
      break;
  }

  return lines.join('\n');
}

export function getTargetLabel(target: RouteTarget): string {
  const labels: Record<RouteTarget, string> = {
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    local: 'Local LLM',
    termux: 'Termux',
    suggest: t('router.suggest'),
    perplexity: 'Perplexity',
    team: 'Team Table',
    browser: 'Browser',
    git: 'Git Guide',
    agent: 'AI Agent',
    codex: 'Codex CLI',
    groq: 'Groq',
    cerebras: 'Cerebras',
    plan: 'Plan Mode',
    arena: 'Arena Mode',
  };
  return labels[target];
}

export function getTargetColor(target: RouteTarget): string {
  const colors: Record<RouteTarget, string> = {
    claude:     '#F59E0B', // アンバー
    gemini:     '#3B82F6', // ブルー
    local:      '#8B5CF6', // パープル
    termux:     '#00D4AA', // ティール（既存ブランドカラー）
    suggest:    '#6B7280', // グレー
    perplexity: '#20B2AA', // ティールグリーン（Perplexityブランドカラー）
    groq:       '#F97316', // オレンジ（Groqブランドカラー）
    team:       '#EC4899', // ピンク（Team Tableブランドカラー）
    browser:    '#4ADE80', // グリーン
    git:        '#F97316', // オレンジ（Git公式カラー）
    agent:      '#EF4444', // レッド（AI Agent）
    codex:      '#10B981', // グリーン（Codex）
    cerebras:   '#FF6B35', // オレンジレッド（Cerebras）
    plan:       '#06B6D4', // シアン（Plan Mode）
    arena:      '#D946EF', // フューシャ（Arena Mode）
  };
  return colors[target];
}
