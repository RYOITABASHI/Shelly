# Cross-Pane Intelligence Phase 4-5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI応答内のコードブロックをワンタップ実行可能なActionBlockとして分離表示し、CLI実行時のリアルタイム翻訳・セカンドオピニオン・セッションサマリー機能を追加する

**Architecture:** Phase 4ではChatBubbleのマークダウンレンダリングを拡張し、コードブロックを検出して`ActionBlock`コンポーネントに差し替える。Phase 5ではinput-routerにセカンドオピニオン/サマリーパターンを追加し（5-3/5-4）、terminalOutputの変更を監視してLLMフォールバックチェーンで翻訳するオーバーレイUIを構築する（5-1/5-2）。

**Tech Stack:** React Native / Expo / TypeScript / Zustand / react-native-markdown-display

**Spec:** `docs/superpowers/specs/2026-03-23-cross-pane-intelligence-design.md`

**Depends on:** Phase 1-3 完了済み（`execution-log-store.terminalOutput`, `hasTerminalReference()`, `getTerminalContextForPrompt()`）

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `lib/parse-code-blocks.ts` | AI応答テキストからコードブロックを検出・分割するパーサー |
| Create | `components/chat/ActionBlock.tsx` | 実行可能コマンドブロックUI（▶実行 + コピー） |
| Modify | `components/chat/ChatBubble.tsx` | マークダウン→ActionBlock分離レンダリングに変更 |
| Modify | `lib/input-router.ts` | セカンドオピニオン/サマリーパターン + `getTerminalIntent()` 追加 (5-3, 5-4) |
| Modify | `hooks/use-ai-dispatch.ts` | インテント別システムプロンプト分離 (5-3, 5-4) |
| Create | `lib/realtime-translate.ts` | LLMフォールバックチェーン + 承認プロンプト検出 (5-1, 5-2) |
| Create | `components/chat/TranslateOverlay.tsx` | リアルタイム翻訳の半透明オーバーレイUI (5-1) |
| Modify | `store/terminal-store.ts` | `realtimeTranslateEnabled` 設定を追加 |
| Modify | `app/(tabs)/index.tsx` | TranslateOverlay をChat画面に配置 |

---

## Task 1: コードブロックパーサー

**Files:**
- Create: `lib/parse-code-blocks.ts`

- [ ] **Step 1: パーサーを作成**

```typescript
/**
 * lib/parse-code-blocks.ts — AI応答テキストからコードブロックを検出・分割
 */

export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string };

/**
 * マークダウンのfenced code blocks (```) を検出し、
 * テキスト部分とコードブロック部分に分割する。
 */
export function parseCodeBlocks(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  // Match fenced code blocks: ```lang\ncode\n```
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      const textContent = text.slice(lastIndex, match.index).trim();
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
    }
    // The code block itself
    const language = match[1] || undefined;
    const code = match[2].trim();
    if (code) {
      segments.push({ type: 'code', content: code, language });
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', content: remaining });
    }
  }

  return segments;
}

/**
 * テキストにfenced code blocksが含まれるかチェック。
 * コードブロックがない場合は通常のMarkdownレンダリングを使う。
 */
export function hasCodeBlocks(text: string): boolean {
  return /```\w*\n[\s\S]*?```/.test(text);
}
```

- [ ] **Step 2: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | grep parse-code`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add lib/parse-code-blocks.ts
git commit -m "feat: add code block parser for ActionBlock rendering"
```

---

## Task 2: ActionBlockコンポーネント

**Files:**
- Create: `components/chat/ActionBlock.tsx`

- [ ] **Step 1: ActionBlock.tsxを作成**

```typescript
/**
 * components/chat/ActionBlock.tsx — 実行可能コマンドブロック
 *
 * AI応答内のコードブロックをワンタップ実行可能なUIとして表示。
 * ▶実行: Terminalにコマンド送信 / コピー: クリップボードにコピー
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { checkCommandSafety, needsConfirmation } from '@/lib/command-safety';
import { useTranslation } from '@/lib/i18n';

interface ActionBlockProps {
  /** コードブロックの内容 */
  code: string;
  /** 言語ヒント（bash, typescript等） */
  language?: string;
  /** マルチペインか */
  isWide: boolean;
  /** コマンドをTerminalに送信して実行 */
  onExecuteInTerminal?: (command: string) => void;
  /** コマンドをBridge経由で裏で実行（シングルペイン用） */
  onExecuteInBackground?: (command: string) => Promise<{ stdout: string; exitCode: number | null }>;
}

export function ActionBlock({ code, language, isWide, onExecuteInTerminal, onExecuteInBackground }: ActionBlockProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ output: string; exitCode: number | null } | null>(null);

  // コードが実行可能なコマンドかどうか（bash/sh/shell/zsh/空）
  const isExecutable = !language || ['bash', 'sh', 'shell', 'zsh', ''].includes(language);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleExecute = useCallback(async () => {
    if (!isExecutable || executing) return;

    // Safety check
    const safety = checkCommandSafety(code);
    if (needsConfirmation(safety)) {
      Alert.alert(
        t('safety.confirm_title'),
        `${safety.message}\n\n$ ${code}`,
        [
          { text: t('chat.cancel'), style: 'cancel' },
          {
            text: t('safety.execute_anyway'),
            style: 'destructive',
            onPress: () => executeCommand(),
          },
        ],
      );
      return;
    }

    executeCommand();
  }, [code, isExecutable, executing, isWide]);

  const executeCommand = useCallback(async () => {
    setExecuting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (isWide && onExecuteInTerminal) {
      // Wide mode: send to terminal pane
      onExecuteInTerminal(code + '\n');
      setExecuting(false);
    } else if (onExecuteInBackground) {
      // Single pane: execute in background, show result
      try {
        const res = await onExecuteInBackground(code);
        setResult({ output: res.stdout, exitCode: res.exitCode });
      } catch (err) {
        setResult({ output: String(err), exitCode: 1 });
      }
      setExecuting(false);
    }
  }, [code, isWide, onExecuteInTerminal, onExecuteInBackground]);

  return (
    <View style={[styles.container, { backgroundColor: colors.surface ?? '#111', borderLeftColor: colors.accent }]}>
      {/* Language label */}
      {language ? (
        <Text style={[styles.langLabel, { color: colors.muted }]}>{language}</Text>
      ) : null}

      {/* Code content */}
      <Text style={[styles.code, { color: '#E8E8E8' }]} selectable>
        {code}
      </Text>

      {/* Action buttons */}
      <View style={styles.actions}>
        {isExecutable && (onExecuteInTerminal || onExecuteInBackground) && (
          <TouchableOpacity
            onPress={handleExecute}
            style={[styles.actionBtn, { opacity: executing ? 0.5 : 1 }]}
            disabled={executing}
          >
            <MaterialIcons name="play-arrow" size={14} color={colors.accent} />
            <Text style={[styles.actionText, { color: colors.accent }]}>
              {executing ? t('action.executing') : t('action.execute')}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={handleCopy} style={styles.actionBtn}>
          <MaterialIcons name={copied ? 'check' : 'content-copy'} size={14} color={copied ? '#4ADE80' : colors.muted} />
          <Text style={[styles.actionText, { color: copied ? '#4ADE80' : colors.muted }]}>
            {copied ? t('ai.copied') : t('ai.copy')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Execution result (single pane only) */}
      {result && (
        <View style={[styles.resultContainer, { borderTopColor: colors.border }]}>
          <View style={styles.resultHeader}>
            <MaterialIcons
              name={result.exitCode === 0 ? 'check-circle' : 'error'}
              size={12}
              color={result.exitCode === 0 ? '#4ADE80' : '#F87171'}
            />
            <Text style={[styles.resultLabel, { color: result.exitCode === 0 ? '#4ADE80' : '#F87171' }]}>
              exit {result.exitCode ?? '?'}
            </Text>
          </View>
          {result.output ? (
            <Text style={[styles.resultText, { color: colors.muted }]} numberOfLines={10}>
              {result.output.slice(0, 500)}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderLeftWidth: 2,
    borderRadius: 6,
    padding: 10,
    marginVertical: 4,
  },
  langLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionText: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  resultContainer: {
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 8,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  resultLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  resultText: {
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
});
```

- [ ] **Step 2: i18nキーを両ロケールに追加**

**重要:** `lib/i18n/locales/ja.ts` と `lib/i18n/locales/en.ts` の**両方**に追加すること。

`lib/i18n/locales/ja.ts` に追加:
```typescript
'action.execute': '▶ 実行',
'action.executing': '実行中...',
'safety.confirm_title': '⚠ コマンド確認',
'safety.execute_anyway': '実行する',
```

`lib/i18n/locales/en.ts` に追加:
```typescript
'action.execute': '▶ Run',
'action.executing': 'Running...',
'safety.confirm_title': '⚠ Confirm Command',
'safety.execute_anyway': 'Execute Anyway',
```

**注:** 既存キー `t('ai.copy')`, `t('ai.copied')`, `t('chat.cancel')` を再利用。`useTranslation()` hookを使用（bare `t` importは使わない）。

- [ ] **Step 3: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
cd ~/Shelly
git add components/chat/ActionBlock.tsx
git commit -m "feat: add ActionBlock component for executable code blocks (Phase 4)"
```

---

## Task 3: ChatBubbleにActionBlockを統合

**Files:**
- Modify: `components/chat/ChatBubble.tsx`

- [ ] **Step 1: import追加**

```typescript
import { parseCodeBlocks, hasCodeBlocks, type ContentSegment } from '@/lib/parse-code-blocks';
import { ActionBlock } from '@/components/chat/ActionBlock';
import { useDeviceLayout } from '@/hooks/use-device-layout';
```

- [ ] **Step 2: ChatBubbleコンポーネント内にisWideとコールバックを追加**

props型の確認が必要。`ChatBubble` が受け取る `runCommand` prop を確認し、それを `ActionBlock` の `onExecuteInTerminal` / `onExecuteInBackground` に変換する。

ChatBubbleコンポーネント内に追加:
```typescript
const { isWide } = useDeviceLayout();
```

- [ ] **Step 3: マークダウンレンダリングを条件分岐**

現在のChatBubbleのメッセージ表示部分（約line 177-206）を修正。
`displayText` にコードブロックがある場合は分割レンダリング、ない場合は従来のMarkdownレンダリングを維持。

現在:
```tsx
{displayText ? (
  <View style={styles.markdownWrap}>
    <Markdown style={...}>
      {displayText}
    </Markdown>
    ...
  </View>
) : ...}
```

変更後:
```tsx
{displayText ? (
  <View style={styles.markdownWrap}>
    {hasCodeBlocks(displayText) && !message.isStreaming ? (
      // ActionBlock分離レンダリング
      <>
        {parseCodeBlocks(displayText).map((seg, i) =>
          seg.type === 'text' ? (
            <Markdown key={i} style={markdownStyles}>
              {seg.content}
            </Markdown>
          ) : (
            <ActionBlock
              key={i}
              code={seg.content}
              language={seg.language}
              isWide={isWide}
              onExecuteInTerminal={isWide ? sendToTerminal : undefined}
              onExecuteInBackground={!isWide ? runCommandInBackground : undefined}
            />
          )
        )}
      </>
    ) : (
      // 通常のMarkdownレンダリング（ストリーミング中含む）
      <Markdown style={markdownStyles}>
        {displayText}
      </Markdown>
    )}
    {message.isStreaming && (
      <Text style={{ color: agentColor, fontSize: 14, fontFamily: 'monospace' }}>{'\u258B'}</Text>
    )}
  </View>
) : ...}
```

**重要:**
- `markdownStyles` はMarkdownコンポーネントのstyle propを変数に切り出す（DRY化）
- `sendToTerminal` はTerminalのWebViewにコマンドを送信する関数。ChatBubbleの props に追加が必要
- `runCommandInBackground` はBridge経由でバックグラウンド実行する関数。ChatBubbleの props に追加が必要
- ストリーミング中はパースしない（テキストが不完全でパースが壊れるため）

- [ ] **Step 4: ChatBubbleのpropsに実行コールバックを追加**

ChatBubbleProps（またはChatBubbleが受け取る型）に追加:
```typescript
/** Terminal WebViewにコマンドを送信（Wide mode用） */
sendToTerminal?: (text: string) => void;
/** Bridge経由でバックグラウンド実行（Single pane用） */
runCommandInBackground?: (command: string) => Promise<{ stdout: string; exitCode: number | null }>;
```

- [ ] **Step 5: ChatMessageListからコールバックを伝達**

`components/chat/ChatMessageList.tsx` で `ChatBubble` に渡すpropsに `sendToTerminal` と `runCommandInBackground` を追加。
これらは `app/(tabs)/index.tsx` から `ChatMessageList` 経由で渡す。

`index.tsx` で:
```typescript
const { sendCommand: sendToTerminal, runCommand: bridgeRunCommand } = useTermuxBridge();

// runCommandInBackground wrapper
const runCommandInBackground = useCallback(async (command: string) => {
  const result = await bridgeRunCommand(command, {});
  return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? null };
}, [bridgeRunCommand]);
```

これを `ChatMessageList` → `ChatBubble` → `ActionBlock` の props chain で渡す。

- [ ] **Step 6: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
cd ~/Shelly
git add components/chat/ChatBubble.tsx components/chat/ChatMessageList.tsx app/(tabs)/index.tsx
git commit -m "feat: integrate ActionBlock into ChatBubble for executable code blocks (Phase 4)

AI responses with code blocks now show ActionBlock with:
- ▶ Execute button (wide: send to terminal, single: background exec)
- Copy button
- command-safety.ts danger check before execution
- Streaming messages use normal Markdown (no parse during stream)"
```

---

## Task 4: Phase 5-3/5-4 — セカンドオピニオン & セッションサマリーパターン + 分離プロンプト

**Files:**
- Modify: `lib/input-router.ts`
- Modify: `hooks/use-ai-dispatch.ts`

Phase 3の `hasTerminalReference()` + `getTerminalContextForPrompt()` を拡張。パターン追加に加え、セカンドオピニオンとサマリーにはそれぞれ異なるシステムプロンプトを注入する。

- [ ] **Step 1: input-router.tsにパターンとインテント検出関数を追加**

`lib/input-router.ts` の `TERMINAL_REFERENCE_PATTERNS` 配列にパターンを追加し、インテント判定用の関数も追加する:

```typescript
const TERMINAL_REFERENCE_PATTERNS = [
  // 日本語（既存）
  /右の(画面|エラー|出力)/,
  /ターミナル(の|にある|に出てる)(エラー|出力|結果|ログ)/,
  /さっきの(エラー|出力|結果)/,
  /このエラー(を|)(直して|修正して|説明して|教えて)/,
  // 英語（既存）
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
```

- [ ] **Step 2: インテント判定関数を追加**

`hasTerminalReference()` の下に追加:

```typescript
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
```

- [ ] **Step 3: use-ai-dispatch.tsのgetTerminalContextForPromptを拡張**

`hooks/use-ai-dispatch.ts` の `TERMINAL_CONTEXT_SUFFIX` とヘルパー関数を修正:

```typescript
import { hasTerminalReference, getTerminalIntent, type TerminalIntent } from '@/lib/input-router';

const TERMINAL_CONTEXT_SUFFIXES: Record<TerminalIntent, string> = {
  'reference': '\n---\nThe user is referring to the terminal output shown above. Analyze it and respond to their request.\nIf your response includes commands or code that can fix the issue, format them as fenced code blocks (```) so the user can execute them directly.',
  'second-opinion': '\n---\nThe user wants a second opinion on what is happening in the terminal. Review the approach, code, or process shown above. Point out potential issues, suggest improvements, or confirm the approach is sound. Be objective and constructive.',
  'session-summary': '\n---\nThe user wants a summary of their terminal session. Based on the output above, summarize: what commands were run, what was accomplished, and what the current state is. Be concise and organized.',
};

function getTerminalContextForPrompt(prompt: string, isWide: boolean): string {
  const intent = getTerminalIntent(prompt);
  const shouldInject = isWide || intent !== null;
  if (!shouldInject) return '';

  const termOutput = useExecutionLogStore.getState().getRecentOutput(50);
  if (!termOutput) return '';

  const suffix = TERMINAL_CONTEXT_SUFFIXES[intent ?? 'reference'];
  return `\n\n--- Terminal Output (last 50 lines) ---\n${termOutput}${suffix}`;
}
```

- [ ] **Step 4: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
cd ~/Shelly
git add lib/input-router.ts hooks/use-ai-dispatch.ts
git commit -m "feat: add second opinion & session summary with distinct prompts (Phase 5-3/5-4)

Each intent type uses a different AI system prompt:
- reference: fix/explain the error
- second-opinion: review the approach objectively
- session-summary: summarize what was done"
```

---

## Task 5: Phase 5-1/5-2 — リアルタイム翻訳エンジン

**Files:**
- Create: `lib/realtime-translate.ts`
- Modify: `store/terminal-store.ts` (設定追加)

- [ ] **Step 1: terminal-storeに設定を追加**

`store/terminal-store.ts` の `AppSettings` 型（またはそれが定義されている場所）に追加:
```typescript
/** リアルタイム翻訳ON/OFF（デフォルト: false） */
realtimeTranslateEnabled?: boolean;
```

デフォルト値設定にも追加:
```typescript
realtimeTranslateEnabled: false,
```

- [ ] **Step 2: リアルタイム翻訳エンジンを作成**

```typescript
/**
 * lib/realtime-translate.ts — CLI出力のリアルタイム翻訳・解説
 *
 * LLMフォールバックチェーン:
 * 1. Cerebras API（高速推論）
 * 2. Groq API
 * 3. Gemini CLI (gemini -p "...")
 * 4. ローカルLLM
 *
 * 承認プロンプト検出（5-2）も含む。
 */

import { useTerminalStore } from '@/store/terminal-store';

// ─── 承認プロンプト検出 (5-2) ────────────────────────────────────────────────

const CLI_APPROVAL_PATTERNS = [
  /Allow.*\?\s*\(Y\/n\)/i,
  /Do you want to (proceed|continue)\?/i,
  /Confirm.*\(y\/N\)/i,
  /Press (y|enter) to continue/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
];

export function detectApprovalPrompt(text: string): boolean {
  return CLI_APPROVAL_PATTERNS.some((p) => p.test(text));
}

// ─── 翻訳リクエスト ─────────────────────────────────────────────────────────

export type TranslateResult = {
  translated: string;
  provider: string;
  isApprovalAlert?: boolean;
};

/**
 * LLMフォールバックチェーンでCLI出力を翻訳・解説する。
 * 利用可能なプロバイダーを順番に試す。
 */
export async function translateTerminalOutput(
  text: string,
  contextLines: string[],
  signal?: AbortSignal,
): Promise<TranslateResult | null> {
  const settings = useTerminalStore.getState().settings;

  const isApproval = detectApprovalPrompt(text);
  const systemPrompt = isApproval
    ? '以下はCLIツールの承認プロンプトです。何をしようとしているか、リスクは何かを日本語で簡潔に説明してください。'
    : 'ターミナル出力を日本語で簡潔に説明してください。専門用語は噛み砕いて。1-2文で。';

  const fullPrompt = contextLines.length > 0
    ? `${systemPrompt}\n\nContext:\n${contextLines.join('\n')}\n\nCurrent output:\n${text}`
    : `${systemPrompt}\n\n${text}`;

  // 1. Cerebras
  if (settings.cerebrasApiKey) {
    try {
      const { cerebrasChatStream } = await import('@/lib/cerebras');
      let result = '';
      const res = await cerebrasChatStream(
        settings.cerebrasApiKey, fullPrompt,
        (chunk, done) => { if (chunk) result += chunk; },
        undefined, undefined, signal,
      );
      if (res.success && result) {
        return { translated: result, provider: 'Cerebras', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  // 2. Groq
  if (settings.groqApiKey) {
    try {
      const { groqChatStream } = await import('@/lib/groq');
      let result = '';
      const res = await groqChatStream(
        settings.groqApiKey, fullPrompt,
        (chunk, done) => { if (chunk) result += chunk; },
        undefined, undefined, signal,
      );
      if (res.success && result) {
        return { translated: result, provider: 'Groq', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  // 3. Gemini CLI (APIキー不要)
  // Phase 5の実装ではGemini CLIはTermux Bridge経由で実行が必要。
  // ここでは将来の拡張ポイントとして空けておく。
  // TODO: bridgeRunCommand('gemini -p "..."') を追加

  // 4. ローカルLLM
  if (settings.localLlmEnabled) {
    try {
      const { ollamaChatStream } = await import('@/lib/local-llm');
      let result = '';
      const res = await ollamaChatStream(
        { baseUrl: settings.localLlmUrl, model: settings.localLlmModel },
        [{ role: 'user', content: fullPrompt }],
        (chunk) => { if (chunk) result += chunk; },
        undefined, // timeoutMs (use default)
        signal,    // externalSignal
      );
      if (result) {
        return { translated: result, provider: 'Local LLM', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  return null; // 全フォールバック失敗
}
```

**注:** `ollamaChatStream` のシグネチャは実際のコードに合わせて調整が必要。実装者はまず `lib/local-llm.ts` を読んで正確なAPIを確認すること。

- [ ] **Step 3: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし（ollamaChatStreamの型が合わない場合は調整）

- [ ] **Step 4: コミット**

```bash
cd ~/Shelly
git add lib/realtime-translate.ts store/terminal-store.ts
git commit -m "feat: add realtime translate engine with LLM fallback chain (Phase 5-1/5-2)

Fallback: Cerebras → Groq → Local LLM (Gemini CLI reserved for future).
Includes CLI approval prompt detection (Y/n, y/N patterns)."
```

---

## Task 6: Phase 5-1 — リアルタイム翻訳オーバーレイUI

**Files:**
- Create: `components/chat/TranslateOverlay.tsx`
- Modify: `app/(tabs)/index.tsx`

- [ ] **Step 1: TranslateOverlayコンポーネントを作成**

```typescript
/**
 * components/chat/TranslateOverlay.tsx — リアルタイム翻訳オーバーレイ
 *
 * Chat画面上部に半透明で表示。チャット履歴を汚さない。
 * 新しい翻訳が来たら前の翻訳を上書き（常に最新1ブロック）。
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useTerminalStore } from '@/store/terminal-store';
import { translateTerminalOutput, type TranslateResult } from '@/lib/realtime-translate';

export function TranslateOverlay() {
  const { colors } = useTheme();
  const enabled = useTerminalStore((s) => s.settings.realtimeTranslateEnabled);
  const terminalOutput = useExecutionLogStore((s) => s.terminalOutput);
  const [translation, setTranslation] = useState<TranslateResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastLineCountRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || terminalOutput.length === 0) return;
    if (terminalOutput.length === lastLineCountRef.current) return;
    lastLineCountRef.current = terminalOutput.length;

    // Debounce: wait 1s after last output line before translating
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      // Cancel previous translation
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const recentLines = terminalOutput.slice(-10);
      const currentLine = recentLines[recentLines.length - 1];
      const contextLines = recentLines.slice(0, -1);

      const result = await translateTerminalOutput(
        currentLine,
        contextLines,
        abortRef.current.signal,
      );
      if (result) {
        setTranslation(result);
        // Auto-hide after 10 seconds
        setTimeout(() => setTranslation(null), 10000);
      }
    }, 1000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [enabled, terminalOutput]);

  if (!enabled || !translation) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      style={[styles.container, {
        backgroundColor: withAlpha(colors.surface ?? '#111', 0.92),
        borderBottomColor: translation.isApprovalAlert ? '#F59E0B' : colors.border,
      }]}
    >
      <View style={styles.header}>
        <MaterialIcons
          name={translation.isApprovalAlert ? 'warning' : 'translate'}
          size={14}
          color={translation.isApprovalAlert ? '#F59E0B' : colors.accent}
        />
        <Text style={[styles.providerLabel, { color: colors.muted }]}>
          {translation.provider}
        </Text>
      </View>
      <Text style={[styles.text, { color: colors.foreground }]} numberOfLines={3}>
        {translation.translated}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  providerLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  text: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 19,
  },
});
```

- [ ] **Step 2: Chat画面にTranslateOverlayを配置**

`app/(tabs)/index.tsx` に追加:

```typescript
import { TranslateOverlay } from '@/components/chat/TranslateOverlay';
```

Chat画面のレイアウト内（`ChatMessageList` の上あたり）に配置:
```tsx
<View style={{ flex: 1, position: 'relative' }}>
  <TranslateOverlay />
  <ChatMessageList ... />
</View>
```

**注:** `position: 'relative'` の親が必要なのは `TranslateOverlay` が `position: 'absolute'` を使うため。実装者はindex.tsxの現在のレイアウト構造を確認して適切な位置に挿入すること。

- [ ] **Step 3: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
cd ~/Shelly
git add components/chat/TranslateOverlay.tsx app/(tabs)/index.tsx
git commit -m "feat: add realtime translate overlay for terminal output (Phase 5-1)

Semi-transparent overlay on top of chat, auto-updates with latest
terminal output translation. Shows warning icon for approval prompts.
1s debounce, 10s auto-hide. Uses LLM fallback chain."
```

---

## Task 7: CLAUDE.md更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Architecture Decisionsに追加**

```
| ActionBlock | ChatBubble内でコードブロック分割レンダリング | ストリーミング中はパース不可のため完了後のみ分離表示。react-native-markdown-displayのカスタムレンダラーは制約が多いためパーサー分離方式を採用 |
| ActionBlock実行方式 | Wide=Terminal送信、Single=Bridge裏実行 | マルチペインではTerminalで実行が見える方が直感的。シングルではChat内に結果表示 |
| リアルタイム翻訳 | Chat上部オーバーレイ（履歴汚さない） | バブルで表示するとチャット履歴が翻訳で埋まる。オーバーレイは最新1件のみ上書き |
| LLMフォールバック | Cerebras→Groq→Local LLM | APIキー不要順ではなく速度順。Gemini CLIはBridge依存のため将来対応 |
```

- [ ] **Step 2: コミット**

```bash
cd ~/Shelly
git add CLAUDE.md
git commit -m "docs: add Phase 4-5 architecture decisions to CLAUDE.md"
```
