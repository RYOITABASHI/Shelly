# Cross-Pane Intelligence Phase 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal出力をAIが参照できるようにし、「右のエラー直して」で完結するクロスペイン開発体験を実現する

**Architecture:** Phase 1でTerminalタブからActivity Log UIを削除しシンプル化。Phase 2でttyd WebViewからターミナル出力をキャプチャしexecution-log-storeに蓄積。Phase 3でinput-routerにターミナル参照パターンを追加し、マッチ時（またはマルチペイン時は常時）キャプチャ済み出力をAIシステムプロンプトに注入する。

**Tech Stack:** React Native / Expo / TypeScript / Zustand / WebView (ttyd/xterm.js) / tRPC

**Spec:** `docs/superpowers/specs/2026-03-23-cross-pane-intelligence-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `app/(tabs)/terminal.tsx` | ExecutionLogPanel削除 + WebView出力キャプチャ追加 |
| Keep | `components/terminal/ExecutionLogPanel.tsx` | 削除しない（将来再利用の可能性） |
| Modify | `store/execution-log-store.ts` | `terminalOutput[]` + ANSI strip + FIFO管理を追加 |
| Create | `lib/strip-ansi.ts` | ANSIエスケープコード除去ユーティリティ |
| Modify | `lib/input-router.ts` | `TERMINAL_REFERENCE_PATTERNS` + `hasTerminalReference()` 追加 |
| Modify | `hooks/use-ai-dispatch.ts` | isWide/ターミナル参照検出 → 出力をAIコンテキストに注入（全プロバイダー） |

---

## Task 1: Phase 1 — TerminalタブからActivity Logを削除

**Files:**
- Modify: `app/(tabs)/terminal.tsx:26,214`

- [ ] **Step 1: ExecutionLogPanelのimportと使用を削除**

`app/(tabs)/terminal.tsx` から以下を削除:

```typescript
// 削除: line 26
import { ExecutionLogPanel } from '@/components/terminal/ExecutionLogPanel';

// 削除: line 214
{status === 'connected' && <ExecutionLogPanel colors={c} />}
```

- [ ] **Step 2: 動作確認**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -30`
Expected: ExecutionLogPanel関連のエラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add app/(tabs)/terminal.tsx
git commit -m "refactor: remove Activity Log panel from Terminal tab (Phase 1)

Terminal tab is now pure TTY: ttyd WebView + StatusBar + JP input.
ExecutionLogPanel component and execution-log-store are kept for Phase 2 reuse."
```

---

## Task 2: Phase 2a — ANSIエスケープコード除去ユーティリティ

**Files:**
- Create: `lib/strip-ansi.ts`

- [ ] **Step 1: strip-ansi.ts を作成**

```typescript
/**
 * lib/strip-ansi.ts — ANSIエスケープコードをプレーンテキストに変換
 */

// CSI sequences (colors, cursor movement, etc.)
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

/**
 * Strip ANSI escape codes from terminal output.
 * Handles CSI (colors, cursor), OSC (title), and simple escape sequences.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_REGEX, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')  // OSC sequences (title etc.)
    .replace(/\u001b[^[]\S/g, '');               // Simple escape sequences
}
```

- [ ] **Step 2: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | grep strip-ansi`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add lib/strip-ansi.ts
git commit -m "feat: add ANSI escape code stripper for terminal output capture"
```

---

## Task 3: Phase 2b — execution-log-storeにターミナル出力キャプチャ機能を追加

**Files:**
- Modify: `store/execution-log-store.ts`

- [ ] **Step 1: terminalOutput関連のstate/actionsを追加**

`store/execution-log-store.ts` の `ExecutionLogStore` 型に追加:

```typescript
/** 直近100行のターミナル出力（ANSIストリップ済み） */
terminalOutput: string[];
/** ターミナル出力を追加（100行超でFIFO破棄） */
addTerminalOutput: (line: string) => void;
/** 直近N行を結合して返す（デフォルト50行） */
getRecentOutput: (lines?: number) => string;
/** ターミナル出力をクリア */
clearTerminalOutput: () => void;
```

create関数内に初期値とimplementation:

```typescript
// 初期値
terminalOutput: [],

// actions
addTerminalOutput: (line) => {
  set((state) => ({
    terminalOutput: [...state.terminalOutput, line].slice(-100),
  }));
},

getRecentOutput: (lines = 50) => {
  const { terminalOutput } = get();
  return terminalOutput.slice(-lines).join('\n');
},

clearTerminalOutput: () => set({ terminalOutput: [] }),
```

- [ ] **Step 2: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | grep execution-log`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add store/execution-log-store.ts
git commit -m "feat: add terminal output capture to execution-log-store (Phase 2)

- terminalOutput[]: last 100 lines FIFO buffer
- getRecentOutput(n): returns last N lines joined
- Ready for WebView output injection in next step"
```

---

## Task 4: Phase 2c — WebViewからターミナル出力をキャプチャ

**Files:**
- Modify: `app/(tabs)/terminal.tsx`

- [ ] **Step 1: 出力キャプチャ用のJavaScript injectionとonMessageハンドラを追加**

`app/(tabs)/terminal.tsx` に以下の変更を加える:

1. importに追加:
```typescript
import { useExecutionLogStore } from '@/store/execution-log-store';
import { stripAnsi } from '@/lib/strip-ansi';
```

2. TerminalScreen コンポーネント内に追加（`useTtydConnection` の後あたり）:
```typescript
const addTerminalOutput = useExecutionLogStore((s) => s.addTerminalOutput);
```

3. onMessage ハンドラを追加:
```typescript
const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
  try {
    const data = JSON.parse(event.nativeEvent.data);
    if (data.type === 'terminal-output' && data.text) {
      const lines = stripAnsi(data.text).split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        addTerminalOutput(line);
      }
    }
  } catch {
    // Ignore parse errors
  }
}, [addTerminalOutput]);
```

4. WebView の `onLoadEnd` 後にJS注入を追加。注入用JS定数を定義:

**重要:** `cursorY` のみではスクロール時に不正確。`baseY + cursorY` で絶対位置を追跡する。

```typescript
const CAPTURE_INJECT_JS = `
(function() {
  if (window.__shellyCaptureActive) return;
  window.__shellyCaptureActive = true;

  function hookXterm() {
    var term = window.term || document.querySelector('.xterm')?.xterm;
    if (!term) {
      setTimeout(hookXterm, 500);
      return;
    }

    var buf = term.buffer;
    if (!buf || !buf.active) {
      setTimeout(hookXterm, 500);
      return;
    }

    // Track absolute line position (baseY + cursorY)
    var lastAbsLine = buf.active.baseY + buf.active.cursorY;

    setInterval(function() {
      try {
        var active = term.buffer.active;
        var currentAbsLine = active.baseY + active.cursorY;
        if (currentAbsLine <= lastAbsLine) return;

        // Read only the new lines since last check
        var lines = [];
        var start = Math.max(0, lastAbsLine);
        var end = Math.min(currentAbsLine, active.length - 1);
        for (var i = start; i <= end; i++) {
          var line = active.getLine(i);
          if (line) {
            var text = line.translateToString(true);
            if (text.trim()) lines.push(text);
          }
        }
        lastAbsLine = currentAbsLine;

        if (lines.length > 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'terminal-output',
            text: lines.join('\\n')
          }));
        }
      } catch(e) {}
    }, 500);
  }
  hookXterm();
})();
true;
`;
```

5. onWebViewLoadのラッパーを作成:
```typescript
const handleWebViewLoad = useCallback(() => {
  onWebViewLoad();
  // Inject terminal output capture after xterm.js initializes
  setTimeout(() => {
    webViewRef.current?.injectJavaScript(CAPTURE_INJECT_JS);
  }, 1000);
}, [onWebViewLoad]);
```

6. WebView コンポーネントを更新:
```tsx
<WebView
  ref={webViewRef}
  source={{ uri: ttyUrl }}
  style={[styles.webView, status !== 'connected' && { height: 0, opacity: 0 }]}
  javaScriptEnabled
  domStorageEnabled
  onLoadEnd={handleWebViewLoad}  // ← 変更
  onError={onWebViewError}
  onHttpError={onWebViewError}
  onMessage={handleWebViewMessage}  // ← 追加
/>
```

- [ ] **Step 2: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add app/(tabs)/terminal.tsx
git commit -m "feat: capture terminal output from ttyd WebView (Phase 2)

- Inject JS into xterm.js to observe buffer via baseY+cursorY tracking
- Strip ANSI codes and store clean lines via execution-log-store
- 500ms polling interval, reads only new lines since last check"
```

---

## Task 5: Phase 3a — input-routerにターミナル参照パターンを追加

**Files:**
- Modify: `lib/input-router.ts`

- [ ] **Step 1: TERMINAL_REFERENCE_PATTERNS とチェック関数を追加**

`lib/input-router.ts` の `LIGHTWEIGHT_PATTERNS` 定義の後あたりに追加:

```typescript
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
];

/**
 * ユーザー入力がターミナル出力を参照しているかチェック。
 * クロスペインインテリジェンスの起点。
 */
export function hasTerminalReference(input: string): boolean {
  return TERMINAL_REFERENCE_PATTERNS.some((p) => p.test(input));
}
```

- [ ] **Step 2: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | grep input-router`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
cd ~/Shelly
git add lib/input-router.ts
git commit -m "feat: add terminal reference patterns to input-router (Phase 3)

Detects patterns like '右のエラー直して', 'fix the error',
'terminal output', etc. for cross-pane intelligence."
```

---

## Task 6: Phase 3b — use-ai-dispatchでターミナル出力を全プロバイダーに注入

**Files:**
- Modify: `hooks/use-ai-dispatch.ts`

**仕様 (Phase 3 Section 3-3):**
- マルチペイン時（`isWide === true`）: ターミナル出力を**常に**AIコンテキストに注入
- シングルペイン時: `hasTerminalReference()` がマッチし、かつ `terminalOutput` にデータがある場合のみ注入
- `terminalOutput` が空: パターンマッチしても通常応答にフォールバック

- [ ] **Step 1: 共通ヘルパー関数を追加**

`hooks/use-ai-dispatch.ts` のファイル先頭（import群の後）に追加:

```typescript
import { hasTerminalReference } from '@/lib/input-router';

// ─── Cross-pane terminal context injection ──────────────────────────────────

const TERMINAL_CONTEXT_SUFFIX = `\n---\nThe user is referring to the terminal output shown above. Analyze it and respond to their request.\nIf your response includes commands or code that can fix the issue, format them as fenced code blocks (\`\`\`) so the user can execute them directly.`;

/**
 * Build terminal output context for AI injection.
 * Returns empty string if no context available (= fallback to normal response).
 *
 * @param prompt - User's input text
 * @param isWide - Whether the device is in multi-pane (wide) layout
 */
function getTerminalContextForPrompt(prompt: string, isWide: boolean): string {
  // Wide mode: always inject terminal context
  // Single pane: only when user explicitly references terminal
  const shouldInject = isWide || hasTerminalReference(prompt);
  if (!shouldInject) return '';

  const termOutput = useExecutionLogStore.getState().getRecentOutput(50);
  if (!termOutput) return ''; // Empty output = fallback to normal response

  return `\n\n--- Terminal Output (last 50 lines) ---\n${termOutput}${TERMINAL_CONTEXT_SUFFIX}`;
}
```

- [ ] **Step 2: Local LLM セクションに注入**

`dispatch` 関数内の `if (target === 'local')` セクション（約line 332-430）で、
`Promise.all` の前に `isWide` を取得し、`orchestrateChatStream` の引数に注入:

```typescript
// 既存の Promise.all の前に追加:
const { isWide } = useDeviceLayout.getState?.() ?? { isWide: false };
// ↑ Zustandストアを直接参照。hook外なので getState() を使う。
// 注: useDeviceLayout が hook のみの場合は、dispatch の引数で isWide を受け取る形に変更。
```

**注:** `useDeviceLayout` は `hooks/use-device-layout.ts` にあり、`useWindowDimensions` を使うhookなので、Zustand storeではなくhookである。そのため `dispatch` 関数の引数に `isWide: boolean` を追加する方が安全。

`dispatch` 関数のシグネチャを修正:
```typescript
// dispatch関数の引数に isWide を追加（呼び出し元の index.tsx で渡す）
async function dispatch(
  target: RouteTarget,
  prompt: string,
  // ... existing params ...
  isWide?: boolean,
): Promise<...> {
```

Local LLMセクションのcustomCtx結合部分（約line 395）を修正:
```typescript
[
  customCtx,
  decisionLog ? `\n# Past Design Decisions\n${decisionLog}` : '',
  getTerminalContextForPrompt(prompt, isWide ?? false),
].filter(Boolean).join('\n') || undefined,
```

- [ ] **Step 3: Cerebras セクションに注入 (line 439+)**

`if (target === 'cerebras')` セクションで、`cerebrasChatStream` 呼び出しの前に:

```typescript
// Cross-pane: inject terminal context into prompt
const termCtx = getTerminalContextForPrompt(prompt, isWide ?? false);
const cerebrasPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
```

`cerebrasChatStream` の第2引数を `promptWithFiles` → `cerebrasPrompt` に変更。

- [ ] **Step 4: Groq セクションに注入 (line 558+)**

`if (target === 'groq')` セクションで、`groqChatStream` 呼び出しの前に:

```typescript
// Cross-pane: inject terminal context into prompt
const termCtx = getTerminalContextForPrompt(prompt, isWide ?? false);
const groqPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
```

`groqChatStream` の第2引数を `promptWithFiles` → `groqPrompt` に変更。

- [ ] **Step 5: Gemini API セクションに注入 (line 741+)**

`if (target === 'gemini')` セクションで:

**APIキーあり（Gemini API）の場合:**
`geminiChatStream` 呼び出し前に同様の注入:
```typescript
const termCtx = getTerminalContextForPrompt(prompt, isWide ?? false);
const geminiPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
```

**APIキーなし（Gemini CLI）の場合:**
`bridgeRunCommand` に渡す `contextualPrompt` に追加:
```typescript
const termCtx = getTerminalContextForPrompt(prompt, isWide ?? false);
const contextualPrompt = promptWithFiles + toTextContext(messages) + termCtx;
```

- [ ] **Step 6: Perplexity セクションに注入 (line 691+)**

`if (target === 'perplexity')` セクションで同様:
```typescript
const termCtx = getTerminalContextForPrompt(prompt, isWide ?? false);
const pplxPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
```

- [ ] **Step 7: 呼び出し元（index.tsx）で isWide を dispatch に渡す**

`app/(tabs)/index.tsx` の `handleSend` 関数で `dispatch` を呼び出す箇所を修正:
```typescript
// useDeviceLayout() は既にどこかで使われているはず
const { isWide } = useDeviceLayout();
// ...
await dispatch(target, prompt, ..., isWide);
```

**注:** `dispatch` の引数にisWideを追加する場合、既存の呼び出し箇所すべてにisWideを追加する必要がある。optional引数 (`isWide?: boolean`) としておけば既存コードは壊れない。

- [ ] **Step 8: 型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | head -20`
Expected: エラーなし

- [ ] **Step 9: コミット**

```bash
cd ~/Shelly
git add hooks/use-ai-dispatch.ts app/(tabs)/index.tsx
git commit -m "feat: inject terminal output into all AI providers (Phase 3)

Cross-pane intelligence for Local LLM, Cerebras, Groq, Gemini (API+CLI),
and Perplexity. Wide mode: always inject. Single pane: only on terminal
reference pattern match. Empty output: fallback to normal response."
```

---

## Task 7: 最終確認 — Phase 1-3 統合チェック

- [ ] **Step 1: 全体型チェック**

Run: `cd ~/Shelly && npx tsc --noEmit 2>&1 | tail -10`
Expected: エラーなし（既存エラーは許容）

- [ ] **Step 2: 変更ファイル一覧を確認**

Run: `cd ~/Shelly && git log --oneline HEAD~6..HEAD`
Expected: Phase 1-3の6コミットが確認できる

- [ ] **Step 3: CLAUDE.mdのArchitecture Decisionsを更新**

`CLAUDE.md` の Architecture Decisions テーブルに追加:
```
| クロスペインインテリジェンス | WebView onMessage + xterm.js buffer観察 (baseY+cursorY) | WebSocket傍受はttydサーバー側の変更が必要で侵襲的。xterm.jsのbuffer APIはクライアントサイドで完結する |
| ターミナル参照パターン | input-router.ts内で正規表現マッチ | LLMに頼らず高速・確実に検出。パターンは日英対応 |
| 出力注入方式 | Local LLM=customCtx内、外部API=ユーザーメッセージ末尾 | 外部APIはシステムプロンプトのカスタマイズが制限される場合があるため |
| クロスペイン有効条件 | Wide=常時注入、Single=パターンマッチ時のみ | Wide画面はTerminalが常に見えるため、暗黙的な参照を期待 |
```

- [ ] **Step 4: コミット**

```bash
cd ~/Shelly
git add CLAUDE.md
git commit -m "docs: add cross-pane intelligence architecture decisions to CLAUDE.md"
```
