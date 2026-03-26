/**
 * lib/cli-runner.ts — v2.4
 *
 * CLI Runner: Claude Code / Gemini CLI をTermux bridge経由でアプリ内実行する。
 *
 * 設計方針:
 * - 対話型UIを前提にしない（1回実行で完結する形を優先）
 * - APIキー等の秘密情報はShelly内に保存しない
 * - ログに現れたキーらしき文字列は自動マスク
 * - 依存未導入時は自然言語で案内し、セットアップコマンドを提案
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type CliTool = 'claude' | 'gemini' | 'codex' | 'cody' | 'custom';

export interface CliToolConfig {
  id: CliTool;
  label: string;
  description: string;
  checkCommand: string;       // which claude / which gemini
  installGuide: string;       // 自然言語インストール案内
  setupCommands: string[];    // セットアップコマンド列（確認後実行）
  isInteractive: boolean;     // 対話型UIが必要か
  nonInteractiveFlag?: string; // 非対話モードフラグ（例: --print）
}

export interface CliRunRequest {
  tool: CliTool;
  userInput: string;          // 自然言語ユーザー入力
  targetPath: string;         // 作業対象フォルダ（~/Projects/...）
  customCommand?: string;     // カスタムCLI用
}

export interface CliRunPlan {
  tool: CliTool;
  command: string;            // 実際に実行するコマンド
  targetPath: string;
  naturalDescription: string; // 自然言語説明
  isInteractiveFallback: boolean; // 対話型フォールバックが必要か
  fallbackSuggestion?: string;    // フォールバック案内
  requiresConfirmation: boolean;  // 危険操作確認が必要か
  confirmationMessage?: string;
}

export interface CliCheckResult {
  available: boolean;
  needsAuth: boolean;
  message: string;            // 自然言語メッセージ
  setupCommands: string[];    // 案内するセットアップコマンド
}

export interface CliRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  naturalSummary: string;     // 自然言語サマリ
  changedFiles: string[];     // 変更されたファイル一覧
  nextActions: string[];      // 次にできること（最大3つ）
}

// ─── Tool Configs ─────────────────────────────────────────────────────────────

export const CLI_TOOLS: Record<CliTool, CliToolConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropicが作ったAIコーディングアシスタント',
    checkCommand: 'which claude',
    installGuide:
      'Claude Codeがインストールされていないよ。\n' +
      'Termuxで以下を実行してインストールしてね：\n' +
      'npm install -g @anthropic-ai/claude-code',
    setupCommands: ['npm install -g @anthropic-ai/claude-code'],
    isInteractive: true,
    nonInteractiveFlag: '--print',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'GoogleのAI CLIツール',
    checkCommand: 'which gemini',
    installGuide:
      'Gemini CLIがインストールされていないよ。\n' +
      'Termuxで以下を実行してインストールしてね：\n' +
      'npm install -g @google/gemini-cli',
    setupCommands: ['npm install -g @google/gemini-cli'],
    isInteractive: true,
    nonInteractiveFlag: '--prompt',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAIのAI CLIツール',
    checkCommand: 'which codex',
    installGuide:
      'Codex CLIがインストールされていないよ。\n' +
      'Termuxで以下を実行してインストールしてね：\n' +
      'npm install -g @openai/codex',
    setupCommands: ['npm install -g @openai/codex'],
    isInteractive: true,
  },
  cody: {
    id: 'cody',
    label: 'Cody CLI',
    description: 'SourcegraphのAI CLIツール',
    checkCommand: 'which cody',
    installGuide:
      'Cody CLIがインストールされていないよ。\n' +
      'インストール方法はSourcegraphの公式ドキュメントを確認してね。',
    setupCommands: [],
    isInteractive: true,
  },
  custom: {
    id: 'custom',
    label: 'カスタムCLI',
    description: '任意のCLIコマンドを実行',
    checkCommand: '',
    installGuide: '',
    setupCommands: [],
    isInteractive: false,
  },
};

// ─── Secret Masking ───────────────────────────────────────────────────────────

/**
 * ログ出力からAPIキーらしき文字列をマスクする。
 * パターン: sk-*, ANTHROPIC_API_KEY=*, GEMINI_API_KEY=*, Bearer *, AIza*
 */
export function maskSecrets(text: string): string {
  return text
    // sk-ant-... / sk-proj-... (Anthropic)
    .replace(/sk-[a-zA-Z0-9\-_]{20,}/g, 'sk-****')
    // AIza... (Google)
    .replace(/AIza[a-zA-Z0-9\-_]{30,}/g, 'AIza****')
    // Bearer <token>
    .replace(/(Bearer\s+)[a-zA-Z0-9\-_.]{20,}/gi, '$1****')
    // KEY=value patterns
    .replace(/(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)=([^\s"']{8,})/gi, '$1=****')
    // Generic long hex/base64 that looks like a secret (40+ chars)
    .replace(/\b[a-f0-9]{40,}\b/g, '****')
    // Long base64-like strings
    .replace(/\b[A-Za-z0-9+/]{50,}={0,2}\b/g, '****');
}

// ─── Command Builder ──────────────────────────────────────────────────────────

/**
 * ユーザーの自然言語入力からCLIコマンドを組み立てる。
 */
export function buildCliCommand(req: CliRunRequest): CliRunPlan {
  const config = CLI_TOOLS[req.tool];

  if (req.tool === 'custom') {
    return {
      tool: 'custom',
      command: req.customCommand ?? req.userInput,
      targetPath: req.targetPath,
      naturalDescription: `カスタムコマンドを実行するよ: ${req.customCommand ?? req.userInput}`,
      isInteractiveFallback: false,
      requiresConfirmation: isDestructiveCommand(req.customCommand ?? req.userInput),
      confirmationMessage: isDestructiveCommand(req.customCommand ?? req.userInput)
        ? `このコマンドは変更を加える可能性があるよ。実行してもいい？\n${req.customCommand ?? req.userInput}`
        : undefined,
    };
  }

  // Detect if the request is destructive (delete, overwrite, network)
  const destructiveKeywords = ['削除', '消して', '上書き', 'rm ', 'delete', 'overwrite', 'curl', 'wget', 'npm install', 'pip install'];
  const isDestructive = destructiveKeywords.some((k) => req.userInput.toLowerCase().includes(k.toLowerCase()));

  // Build the prompt for the CLI
  const prompt = buildPromptFromInput(req.userInput, req.targetPath);

  // Claude Code: use --print for non-interactive
  let command: string;
  let isInteractiveFallback = false;
  let fallbackSuggestion: string | undefined;

  if (req.tool === 'claude') {
    // claude --print "<prompt>" in the target directory
    command = `cd "${req.targetPath}" && echo "" | claude --print "${escapeShellArg(prompt)}"`;

    // Claude Code may still require interactive mode for complex tasks
    if (req.userInput.length > 200 || req.userInput.includes('プロジェクト全体')) {
      isInteractiveFallback = true;
      fallbackSuggestion =
        'この操作はClaude Codeの対話型モードが必要かもしれないよ。\n' +
        'Termuxで直接 `claude` を実行するか、もっとシンプルな指示で試してみて。';
    }
  } else if (req.tool === 'gemini') {
    // gemini --prompt "<prompt>" in the target directory
    command = `cd "${req.targetPath}" && gemini --prompt "${escapeShellArg(prompt)}"`;
    if (req.userInput.length > 300) {
      isInteractiveFallback = true;
      fallbackSuggestion =
        'この操作はGemini CLIの対話型モードが必要かもしれないよ。\n' +
        'Termuxで直接 `gemini` を実行するか、もっとシンプルな指示で試してみて。';
    }
  } else {
    command = req.userInput;
  }

  return {
    tool: req.tool,
    command,
    targetPath: req.targetPath,
    naturalDescription: buildNaturalDescription(req.tool, req.userInput, req.targetPath),
    isInteractiveFallback,
    fallbackSuggestion,
    requiresConfirmation: isDestructive,
    confirmationMessage: isDestructive
      ? `この操作はファイルを変更する可能性があるよ。実行してもいい？\n対象: ${req.targetPath}`
      : undefined,
  };
}

// ─── Dependency Check ─────────────────────────────────────────────────────────

/**
 * CLI依存確認の結果を自然言語メッセージに変換する。
 * 実際のチェックはTermux bridge経由で行い、その結果をここで解釈する。
 */
export function interpretCheckResult(
  tool: CliTool,
  exitCode: number,
  stdout: string,
): CliCheckResult {
  const config = CLI_TOOLS[tool];

  if (tool === 'custom') {
    return { available: true, needsAuth: false, message: '', setupCommands: [] };
  }

  const available = exitCode === 0 && stdout.trim().length > 0;

  if (!available) {
    return {
      available: false,
      needsAuth: false,
      message: config.installGuide,
      setupCommands: config.setupCommands,
    };
  }

  // Check for auth-related errors in stdout/stderr
  const authKeywords = ['not logged in', 'authentication', 'api key', 'unauthorized', 'login required', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
  const needsAuth = authKeywords.some((k) => stdout.toLowerCase().includes(k.toLowerCase()));

  if (needsAuth) {
    const authGuide = tool === 'claude'
      ? 'Claude Codeの認証が必要だよ。\nTermuxで `claude auth login` を実行するか、\n環境変数 ANTHROPIC_API_KEY を設定してね。\n（APIキーはShellyには保存しないよ。Termux側で管理してね。）'
      : 'Gemini CLIの認証が必要だよ。\nTermuxで `gemini auth login` を実行するか、\n環境変数 GEMINI_API_KEY を設定してね。\n（APIキーはShellyには保存しないよ。Termux側で管理してね。）';

    return {
      available: true,
      needsAuth: true,
      message: authGuide,
      setupCommands: tool === 'claude'
        ? ['claude auth login']
        : ['gemini auth login'],
    };
  }

  return {
    available: true,
    needsAuth: false,
    message: `${config.label}が使えるよ！`,
    setupCommands: [],
  };
}

// ─── Result Parser ────────────────────────────────────────────────────────────

/**
 * CLI実行結果を自然言語サマリに変換する。
 */
export function parseCliResult(
  tool: CliTool,
  userInput: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): CliRunResult {
  const maskedStdout = maskSecrets(stdout);
  const maskedStderr = maskSecrets(stderr);
  const success = exitCode === 0;

  // Extract changed files from output (common patterns)
  const changedFiles = extractChangedFiles(maskedStdout + '\n' + maskedStderr);

  // Build natural language summary
  let naturalSummary: string;
  let nextActions: string[];

  if (!success) {
    naturalSummary = buildErrorSummary(tool, maskedStderr || maskedStdout, exitCode);
    nextActions = buildErrorNextActions(tool, maskedStderr);
  } else {
    naturalSummary = buildSuccessSummary(tool, userInput, maskedStdout, changedFiles);
    nextActions = buildSuccessNextActions(userInput, changedFiles);
  }

  return {
    success,
    stdout: maskedStdout,
    stderr: maskedStderr,
    exitCode,
    naturalSummary,
    changedFiles,
    nextActions,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPromptFromInput(userInput: string, targetPath: string): string {
  // Add context about the target directory
  const folderName = targetPath.split('/').pop() ?? targetPath;
  return `${userInput}\n\n作業対象フォルダ: ${folderName} (${targetPath})`;
}

function buildNaturalDescription(tool: CliTool, userInput: string, targetPath: string): string {
  const toolLabel = CLI_TOOLS[tool]?.label ?? tool;
  const folderName = targetPath.split('/').pop() ?? targetPath;
  return `${toolLabel}を使って「${userInput}」を実行するよ。\n対象: ${folderName}`;
}

function escapeShellArg(s: string): string {
  // Escape double quotes and backticks for shell safety
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function isDestructiveCommand(cmd: string): boolean {
  const patterns = ['rm ', 'rmdir', 'del ', 'format', 'mkfs', 'dd ', 'truncate', '> /'];
  return patterns.some((p) => cmd.toLowerCase().includes(p));
}

function extractChangedFiles(output: string): string[] {
  const files: string[] = [];
  const patterns = [
    /(?:created?|wrote?|updated?|modified?|saved?)\s+([^\s\n]+\.[a-zA-Z]{1,10})/gi,
    /(?:Writing|Creating|Updating)\s+([^\s\n]+\.[a-zA-Z]{1,10})/gi,
    /\+{3}\s+b\/([^\s\n]+)/g,  // git diff format
    /File:\s+([^\s\n]+\.[a-zA-Z]{1,10})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1].trim();
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }

  return files.slice(0, 10); // max 10 files
}

function buildSuccessSummary(
  tool: CliTool,
  userInput: string,
  stdout: string,
  changedFiles: string[],
): string {
  const toolLabel = CLI_TOOLS[tool]?.label ?? tool;
  let summary = `${toolLabel}が完了したよ！\n\n`;

  // What was done
  summary += `やったこと: ${userInput}\n`;

  // Changed files
  if (changedFiles.length > 0) {
    summary += `\n変更したファイル:\n`;
    changedFiles.forEach((f) => { summary += `  • ${f}\n`; });
  }

  return summary.trim();
}

function buildErrorSummary(tool: CliTool, errorOutput: string, exitCode: number): string {
  const toolLabel = CLI_TOOLS[tool]?.label ?? tool;

  if (exitCode === 130) {
    return `${toolLabel}の実行をキャンセルしたよ。`;
  }

  // Check for common error patterns
  if (errorOutput.toLowerCase().includes('not found') || errorOutput.toLowerCase().includes('command not found')) {
    return `${toolLabel}が見つからなかったよ。インストールされているか確認してね。`;
  }
  if (errorOutput.toLowerCase().includes('permission denied')) {
    return `権限エラーが発生したよ。フォルダへのアクセス権限を確認してね。`;
  }
  if (errorOutput.toLowerCase().includes('api key') || errorOutput.toLowerCase().includes('authentication')) {
    return `認証エラーが発生したよ。APIキーの設定を確認してね。\n（APIキーはTermux側の環境変数で管理してね。）`;
  }

  return `${toolLabel}の実行中にエラーが発生したよ。\n詳細はログを確認してね。`;
}

function buildErrorNextActions(tool: CliTool, errorOutput: string): string[] {
  const actions: string[] = [];

  if (errorOutput.toLowerCase().includes('not found') || errorOutput.toLowerCase().includes('command not found')) {
    actions.push(`${CLI_TOOLS[tool]?.label ?? tool}をインストールする`);
  }
  if (errorOutput.toLowerCase().includes('api key') || errorOutput.toLowerCase().includes('authentication')) {
    actions.push('APIキーをTermuxの環境変数に設定する');
    actions.push('認証コマンドを実行する');
  }

  actions.push('別の指示で試してみる');
  actions.push('Termuxで直接コマンドを実行する');

  return actions.slice(0, 3);
}

function buildSuccessNextActions(userInput: string, changedFiles: string[]): string[] {
  const actions: string[] = [];

  if (changedFiles.some((f) => f.endsWith('.md'))) {
    actions.push('READMEの内容を確認する');
  }
  if (changedFiles.some((f) => f.match(/\.(ts|tsx|js|jsx|py)$/))) {
    actions.push('変更したコードをテストする');
  }
  if (changedFiles.length > 0) {
    actions.push('変更内容をTerminalで確認する');
  }

  actions.push('別の改善を依頼する');
  actions.push('Recipeに保存して再利用する');

  return actions.slice(0, 3);
}
