/**
 * lib/cli-permission-proxy.ts — v1.0
 *
 * CLI Permission Proxy: Claude Code / Gemini CLI のパーミッションプロンプトを
 * 初心者向けに翻訳し、簡易UIで承認/拒否を可能にする。
 *
 * 2つのモード:
 * - Chat mode（初心者向け）: CLIのstdoutをパースし、許可プロンプトを検知したら
 *   ローカルLLMで日本語に翻訳。「実行/実行しない/テキスト入力」のUIを提示。
 * - Terminal mode（上級者向け）: CLIをそのまま表示。ユーザーが直接操作。
 *
 * Gemini CLI は自然言語で質問してくるため、パターンマッチ不要で
 * そのまま翻訳・表示すればよい。
 *
 * Claude Code は Y/N 形式のプロンプトが多いため、パターンマッチで検知する。
 * --dangerouslySkipPermissions フラグで完全自動承認も可能（上級者向けオプション）。
 */

import type { LocalLlmConfig, OllamaMessage } from './local-llm';
import { ollamaChat } from './local-llm';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProxyMode = 'chat' | 'terminal';

export interface PermissionPrompt {
  /** 生のCLI出力テキスト */
  rawText: string;
  /** どのCLIからか */
  source: 'claude-code' | 'gemini-cli' | 'unknown';
  /** 検知されたプロンプトの種類 */
  promptType: 'file_permission' | 'command_execution' | 'network_access' | 'general_question' | 'unknown';
  /** 翻訳された日本語の説明 */
  translatedText?: string;
  /** ユーザーに提示する選択肢 */
  options: PermissionOption[];
}

export interface PermissionOption {
  label: string;       // UI表示テキスト
  value: string;       // CLIに送るレスポンス
  style: 'primary' | 'danger' | 'neutral';
}

// ─── Pattern Detection ────────────────────────────────────────────────────────

/** Claude Code の許可プロンプトパターン */
const CLAUDE_PERMISSION_PATTERNS = [
  // ファイル読み書き
  /(?:Allow|Do you want to|May I)\s+(?:read|write|edit|create|delete|modify|access)\s+(?:file|directory|folder|the file)/i,
  /(?:read|write|edit|create|delete)\s+(?:to|from)?\s*['"`]?([^'"`\n]+)['"`]?\s*\?/i,
  // コマンド実行
  /(?:Allow|Do you want to|May I|Execute|Run)\s+(?:this command|the command|bash)/i,
  /\$ .+\n.*(?:Allow|Approve|Execute|Run)\?/i,
  // ネットワーク
  /(?:Allow|Do you want to|May I)\s+(?:make|send)\s+(?:a |an )?(?:HTTP|API|network|web)\s+(?:request|call)/i,
  // Y/N プロンプト
  /\(Y\/n\)/i,
  /\[Y\/n\]/i,
  /\(yes\/no\)/i,
];

/** Gemini CLI は自然言語で質問するのでパターンマッチ不要。
 *  ただし、アクション確認は検知したい。 */
const GEMINI_QUESTION_PATTERNS = [
  /(?:実行|操作|変更|削除|作成)(?:して|します|する)(?:か|？|\?)/,
  /(?:proceed|continue|confirm)\??/i,
  /(?:would you like|do you want|shall I)\s/i,
];

/**
 * CLIの出力からパーミッションプロンプトを検知する。
 */
export function detectPermissionPrompt(
  output: string,
  source: 'claude-code' | 'gemini-cli' | 'unknown' = 'unknown',
): PermissionPrompt | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  // Claude Code パターン
  if (source === 'claude-code' || source === 'unknown') {
    for (const pattern of CLAUDE_PERMISSION_PATTERNS) {
      if (pattern.test(trimmed)) {
        const promptType = detectPromptType(trimmed);
        return {
          rawText: trimmed,
          source: 'claude-code',
          promptType,
          options: buildDefaultOptions(promptType),
        };
      }
    }
  }

  // Gemini CLI パターン（自然言語ベース）
  if (source === 'gemini-cli' || source === 'unknown') {
    for (const pattern of GEMINI_QUESTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          rawText: trimmed,
          source: 'gemini-cli',
          promptType: 'general_question',
          options: buildDefaultOptions('general_question'),
        };
      }
    }
  }

  return null;
}

function detectPromptType(text: string): PermissionPrompt['promptType'] {
  const lower = text.toLowerCase();
  if (/(?:read|write|edit|create|delete|file|directory|folder)/.test(lower)) return 'file_permission';
  if (/(?:command|execute|run|bash|\$\s)/.test(lower)) return 'command_execution';
  if (/(?:http|api|network|web|fetch|request)/.test(lower)) return 'network_access';
  return 'unknown';
}

function buildDefaultOptions(promptType: PermissionPrompt['promptType']): PermissionOption[] {
  switch (promptType) {
    case 'file_permission':
      return [
        { label: '許可する', value: 'Y', style: 'primary' },
        { label: '拒否する', value: 'N', style: 'danger' },
      ];
    case 'command_execution':
      return [
        { label: '実行する', value: 'Y', style: 'primary' },
        { label: '実行しない', value: 'N', style: 'danger' },
      ];
    case 'network_access':
      return [
        { label: '許可する', value: 'Y', style: 'primary' },
        { label: '拒否する', value: 'N', style: 'danger' },
      ];
    case 'general_question':
      return [
        { label: 'はい', value: 'yes', style: 'primary' },
        { label: 'いいえ', value: 'no', style: 'danger' },
      ];
    default:
      return [
        { label: '続行', value: 'Y', style: 'primary' },
        { label: 'キャンセル', value: 'N', style: 'danger' },
      ];
  }
}

// ─── LLM Translation ─────────────────────────────────────────────────────────

const TRANSLATION_SYSTEM_PROMPT =
  'あなたはShellyアプリの翻訳アシスタントです。' +
  'AIコーディングツール（Claude Code, Gemini CLI）が表示する英語の許可プロンプトを、' +
  'プログラミング初心者が理解できる簡単な日本語に翻訳してください。\n\n' +
  'ルール:\n' +
  '- 技術用語を避け、平易な言葉で説明する\n' +
  '- 「〜してもいいですか？」という形式で翻訳する\n' +
  '- ファイルパスやコマンドはそのまま残す\n' +
  '- 2-3文以内で簡潔に\n' +
  '- 危険な操作（削除、上書き等）の場合はその旨を明記する';

/**
 * ローカルLLMを使ってCLIプロンプトを初心者向け日本語に翻訳する。
 * LLM未接続の場合はフォールバック翻訳を返す。
 */
export async function translatePermissionPrompt(
  prompt: PermissionPrompt,
  llmConfig: LocalLlmConfig,
): Promise<string> {
  // LLM無効時はフォールバック
  if (!llmConfig.enabled) {
    return fallbackTranslation(prompt);
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
    { role: 'user', content: `以下のCLIプロンプトを初心者向け日本語に翻訳してください:\n\n${prompt.rawText}` },
  ];

  const result = await ollamaChat(llmConfig, messages, 15000);
  if (result.success && result.content) {
    return result.content;
  }

  return fallbackTranslation(prompt);
}

function fallbackTranslation(prompt: PermissionPrompt): string {
  switch (prompt.promptType) {
    case 'file_permission':
      return 'AIがファイルの読み書きをしようとしています。許可しますか？';
    case 'command_execution':
      return 'AIがコマンドを実行しようとしています。実行を許可しますか？';
    case 'network_access':
      return 'AIがインターネットにアクセスしようとしています。許可しますか？';
    case 'general_question':
      return prompt.rawText; // Geminiの自然言語はそのまま
    default:
      return `AIからの確認: ${prompt.rawText.slice(0, 100)}`;
  }
}

// ─── Auto-Approve Policy ──────────────────────────────────────────────────────

export type AutoApproveLevel = 'none' | 'safe' | 'all';

/**
 * 自動承認ポリシーに基づいて、プロンプトを自動承認するか判定する。
 * - none: 全て手動承認
 * - safe: ファイル読み取り・安全なコマンドのみ自動承認
 * - all: 全て自動承認（--dangerouslySkipPermissions相当）
 */
export function shouldAutoApprove(
  prompt: PermissionPrompt,
  level: AutoApproveLevel,
): boolean {
  if (level === 'all') return true;
  if (level === 'none') return false;

  // safe: 読み取り系のみ自動承認
  if (level === 'safe') {
    const lower = prompt.rawText.toLowerCase();
    // 読み取りは安全
    if (/\bread\b/.test(lower) && !/\bwrite\b/.test(lower) && !/\bdelete\b/.test(lower)) {
      return true;
    }
    // ls, cat, head 等の読み取りコマンドは安全
    if (/\$\s*(ls|cat|head|tail|wc|file|stat)\s/.test(lower)) {
      return true;
    }
  }

  return false;
}

// ─── Claude Code Flags ────────────────────────────────────────────────────────

/**
 * Chat モード用の Claude Code コマンドを構築する。
 * autoApprove: 'all' の場合は --dangerouslySkipPermissions を付与。
 */
export function buildChatModeClaudeCommand(
  userInput: string,
  autoApproveLevel: AutoApproveLevel = 'safe',
): string {
  const escaped = userInput
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  if (autoApproveLevel === 'all') {
    return `claude --dangerouslySkipPermissions --print "${escaped}"`;
  }
  return `claude --print "${escaped}"`;
}
