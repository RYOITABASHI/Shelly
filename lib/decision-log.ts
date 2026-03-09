/**
 * lib/decision-log.ts — v1.0
 *
 * 開発判断ログ（ナレッジグラフ的永続メモリ）。
 *
 * - AI/ユーザーの重要な設計判断を AsyncStorage に保存
 * - セッション跨ぎで永続化（LLM のコンテキストウィンドウに依存しない）
 * - 次回セッション開始時にシステムプロンプトへ自動注入
 * - エントリ数制限 + 古いものは自動削除（トークン節約）
 *
 * 使い方:
 *   shelly log "ComposeViewはfinalなのでsubclass不可"
 *   → appendDecision({ decision: "...", reason: "...", files: [...] })
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DecisionEntry {
  id: string;
  timestamp: number;
  decision: string;      // 何を決めたか
  reason?: string;       // なぜその判断をしたか
  files?: string[];      // 関連ファイル
  project?: string;      // プロジェクト名
  category?: 'architecture' | 'bugfix' | 'config' | 'design' | 'performance' | 'other';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = '@shelly/decision-log';
const MAX_ENTRIES = 50;        // 最大エントリ数（古いものから自動削除）
const MAX_PROMPT_CHARS = 2000; // システムプロンプト注入時の最大文字数

// ─── Cache ──────────────────────────────────────────────────────────────────

let cachedEntries: DecisionEntry[] | null = null;

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * 全エントリを読み込む。
 */
export async function loadDecisionLog(): Promise<DecisionEntry[]> {
  if (cachedEntries) return cachedEntries;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cachedEntries = raw ? JSON.parse(raw) : [];
    return cachedEntries!;
  } catch {
    cachedEntries = [];
    return [];
  }
}

/**
 * 判断を追記する。
 */
export async function appendDecision(entry: Omit<DecisionEntry, 'id' | 'timestamp'>): Promise<void> {
  const entries = await loadDecisionLog();
  const newEntry: DecisionEntry = {
    ...entry,
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
  };
  entries.push(newEntry);

  // 古いものを削除
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  cachedEntries = entries;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * 特定エントリを削除する。
 */
export async function removeDecision(id: string): Promise<void> {
  const entries = await loadDecisionLog();
  const filtered = entries.filter((e) => e.id !== id);
  cachedEntries = filtered;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/**
 * 全エントリをクリアする。
 */
export async function clearDecisionLog(): Promise<void> {
  cachedEntries = [];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([]));
}

/**
 * キーワードでエントリを検索する。
 */
export function searchDecisions(entries: DecisionEntry[], query: string): DecisionEntry[] {
  const lower = query.toLowerCase();
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(lower) ||
    (e.reason?.toLowerCase().includes(lower) ?? false) ||
    (e.files?.some((f) => f.toLowerCase().includes(lower)) ?? false) ||
    (e.project?.toLowerCase().includes(lower) ?? false)
  );
}

// ─── Prompt Formatting ──────────────────────────────────────────────────────

/**
 * 判断ログをシステムプロンプト用のMarkdownに整形する。
 * トークン節約のため MAX_PROMPT_CHARS 以内に収める。
 */
export function formatDecisionLogForPrompt(entries: DecisionEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = [];
  // 新しい順に表示（最新の判断が最も重要）
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  for (const entry of sorted) {
    const date = new Date(entry.timestamp).toISOString().slice(0, 10);
    const files = entry.files?.length ? ` [${entry.files.join(', ')}]` : '';
    const reason = entry.reason ? ` → ${entry.reason}` : '';
    const line = `- ${date}: ${entry.decision}${reason}${files}`;
    lines.push(line);

    // 文字数チェック
    if (lines.join('\n').length > MAX_PROMPT_CHARS) {
      lines.pop();
      lines.push(`- ...他 ${sorted.length - lines.length} 件の判断ログあり`);
      break;
    }
  }

  return lines.join('\n');
}

/**
 * プロジェクト名でフィルタした判断ログをプロンプト用に返す。
 */
export async function getDecisionLogForPrompt(projectName?: string): Promise<string> {
  const entries = await loadDecisionLog();
  const filtered = projectName
    ? entries.filter((e) => !e.project || e.project === projectName)
    : entries;
  return formatDecisionLogForPrompt(filtered);
}

// ─── AI Auto-logging ────────────────────────────────────────────────────────

/**
 * AIの応答から重要な判断を自動抽出してログに追記する。
 * 「〜に変更」「〜に修正」「〜のため〜を採用」等のパターンを検出。
 */
export async function autoLogFromResponse(
  response: string,
  project?: string,
): Promise<number> {
  const patterns = [
    // 日本語パターン
    /(?:^|\n)\s*[-・]\s*(.+(?:に変更|に修正|を追加|を削除|を採用|に統一|を実装).+)/gm,
    /(?:理由|原因)[：:]\s*(.+)/gm,
    // 英語パターン
    /(?:^|\n)\s*[-•]\s*(Changed|Fixed|Added|Removed|Updated|Implemented)\s+(.+)/gim,
  ];

  let count = 0;
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const decision = (match[2] ? `${match[1]} ${match[2]}` : match[1]).trim();
      if (decision.length > 10 && decision.length < 200 && !seen.has(decision)) {
        seen.add(decision);
        await appendDecision({ decision, project, category: 'other' });
        count++;
      }
      if (count >= 5) break; // 1応答あたり最大5件
    }
    if (count >= 5) break;
  }

  return count;
}
