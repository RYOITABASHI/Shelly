# Shelly v2.0 統合設計書 — Tier 0〜2

> NTV（Native Terminal View）コミット済み、クロスペイン8フェーズ実装済みの状態から、
> v2.0リリースまでの全機能を一貫した設計で定義する。
>
> 作成日: 2026-03-27
> 前提: Expo 54 / RN 0.81 / TypeScript / NativeWind / Zustand / tRPC

## Implementation Status (2026-03-30)

| Section | Feature | Status | Commit |
|---------|---------|--------|--------|
| 3 | Tier 0.5 settings-store分離 | Done | `43f97273` |
| 4.1 | セキュリティゲート | Done | `1122815e` |
| 4.4 | ドキュメント更新 | Done | `c7ff5522` |
| 5.1 | FileChanged フック | Done | `de5ed394` |
| 5.2 | 脆弱性レポート自然言語化 | Done | `37f6fab3` |
| 5.4.1 | 承認プロキシ (ApprovalBubble) | Done | `09df6947` |
| 5.4.2 | セーブポイント通知バブル | Done | `37f6fab3` |
| 5.4.3 | セキュリティ警告バブル | Done | `37f6fab3` |
| 5.4.4 | エラー要約バブル | Done | `09df6947` |
| 6.1 | Plan Mode ステップカード | Done | `73b45802` |
| 6.2 | Click-to-Edit | Done | `319f99d7` |
| 6.3 | Arena Mode | Done | `2512a7a9` |
| 6.4 | Template Gallery | Done | `8d7c8625` |

### Implementation Notes

- **承認プロキシ**: 設計書では `@team` dispatch統合を想定、実装では `onAskTeam` コールバックで外部連携可能な形。実際の `@team` dispatch接続は呼び出し側で行う。
- **エラー要約**: LLM翻訳パイプラインとの接続は `translation` フィールドが空文字で作成→非同期で埋める形。TranslateOverlayとの重複回避のためWide時のみ生成。
- **Plan Mode**: 設計書では `@plan` ルーティング + `use-ai-dispatch.ts` の `plan` ブランチ追加を想定。現実装ではAI応答テキストのパターンマッチ（`isPlanOutput()`）で自動検出。`@plan` ルーティングは未実装（次セッション対応可能）。
- **Click-to-Edit**: `use-ai-dispatch.ts` への editContext 注入は未実装。`onEditSubmit` コールバックでプロンプトが返るので、呼び出し側でdispatch連携する。
- **Arena Mode**: `use-ai-dispatch.ts` の `dispatchArena()` メソッドは未実装。store + UI + selector は完成。dispatch統合は `@arena` ルーティング追加時に接続。
- **Template Gallery**: Creator Engine (`startPlanning()`) への接続は `onSelectTemplate` コールバック経由。呼び出し側での接続が必要。

---

## 目次

1. [設計原則](#1-設計原則)
2. [現状アーキテクチャ](#2-現状アーキテクチャ)
3. [Tier 0.5: Store リファクタ（前準備）](#3-tier-05-store-リファクタ前準備)
4. [Tier 0: 即時改善（ドキュメント+軽微変更）](#4-tier-0-即時改善)
5. [Tier 1: クロスペイン強化](#5-tier-1-クロスペイン強化)
6. [Tier 2: コア新機能](#6-tier-2-コア新機能)
7. [Store 新設・変更マップ](#7-store-新設変更マップ)
8. [ファイル変更マトリクス](#8-ファイル変更マトリクス)
9. [セッション計画](#9-セッション計画)
10. [リスクと緩和策](#10-リスクと緩和策)

---

## 1. 設計原則

Shellyの設計思想から逸脱しない。全Tierで以下を守る。

| 原則 | 意味 | 違反例 |
|------|------|--------|
| **非エンジニアファースト** | 専門用語を見せない。操作は自然言語 or ワンタップ | CVE番号をそのまま表示 |
| **Termuxの存在を消す** | ユーザーはTermuxを意識しない | tmuxコマンドを手動入力させる |
| **5分セットアップ** | 初回起動から価値提供まで5分以内 | API設定を3個以上要求 |
| **壊さない** | 既存機能を壊す変更はしない | terminal-storeのAPIを破壊的変更 |
| **落ちても復帰** | Termuxが落ちても途中から再開できる | 状態をメモリのみに保持 |
| **Wide = 自動、Single = 明示** | Wide画面は自動連携、Phone画面は手動トリガー | Phone画面で常に全情報を表示 |

---

## 2. 現状アーキテクチャ

### 2.1 タブ構成

```
[Projects] [Chat ★] [Terminal] [Settings]
```

- Chat (index.tsx, 1268行): メインインターフェース、AI dispatch、クロスペイン注入
- Terminal (terminal.tsx, 575行): NTV + PreviewPanel + tmux

### 2.2 データフロー（クロスペイン）

```
PTY出力 → useTerminalOutput() hook
    → execution-log-store
        ├── hotBuffer (100行)
        └── sessionBuffer (1000行、エラー優先)
    → buildTerminalContext() [Chat側]
    → getTerminalContextForPrompt() [AI Dispatch]
    → AIプロンプトに注入
```

### 2.3 AI Dispatch パイプライン

```
ユーザー入力
    → input-router.ts（4層パース: @mention → NL+tool → NL→tool → shell検出）
    → use-ai-dispatch.ts（ルーティング + コンテキスト注入 + ストリーミング）
        ├── Claude CLI (bridgeRunCommand)
        ├── Gemini API/CLI
        ├── Local LLM (Ollama)
        ├── Cerebras / Groq (fast)
        ├── Perplexity (citations)
        ├── Team (multi-agent roundtable)
        └── Git (git-advisor)
    → ChatBubble.tsx（Markdown + ActionBlock + CommandExec）
```

### 2.4 Creator Engine

```
CommandLane（入力 + テンプレート選択）
    → creator-store.ts（planning → confirming → building → done）
    → creator-engine.ts + project-templates.ts（3テンプレート: Web/Script/Document）
    → PlanLane → BuildLane → ResultLane
```

### 2.5 Store健全性

| Store | 行数 | 状態 |
|-------|------|------|
| terminal-store.ts | 796 | **要分割** |
| types.ts | 381 | 良好 |
| creator-store.ts | 310 | 良好 |
| chat-store.ts | 270 | 注意 |
| execution-log-store.ts | 211 | 模範的 |
| その他5つ | 65-215 | 良好 |

---

## 3. Tier 0.5: Store リファクタ（前準備）

> **目的**: Tier 1-2の新機能を安全に追加するための基盤整備。
> **原則**: APIの破壊的変更なし。importパスの変更のみ。

### 3.1 settings-store.ts の抽出

**現状**: `terminal-store.ts` に `AppSettings` 型 + 36個の設定フィールド + `loadSettings()` / `updateSettings()` が同居。

**変更**:

```typescript
// store/settings-store.ts（新規、約200行）
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

// types.ts から AppSettings, TermuxSettings を参照（移動不要）

interface SettingsState {
  settings: AppSettings;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loadSettings: async () => { /* AsyncStorageから読み込み */ },
  updateSettings: (partial) => {
    set((s) => ({ settings: { ...s.settings, ...partial } }));
    // AsyncStorageに永続化
  },
  resetSettings: () => set({ settings: DEFAULT_SETTINGS }),
}));
```

**terminal-store.ts からの削除対象**:
- `settings` フィールド
- `loadSettings()` / `updateSettings()` アクション
- `DEFAULT_SETTINGS` 定数
- `SETTINGS_STORAGE_KEY` 定数

**後方互換**: `terminal-store.ts` に薄いプロキシを残す（deprecated警告付き）。
Zustand の `create()` 内では ES `get` アクセサが使えないため、通常のフィールド + subscribe で同期する:

```typescript
// terminal-store.ts 内（一時的な互換層、Tier 2完了後に削除）

// 初期値を settings-store から取得
settings: useSettingsStore.getState().settings,

// settings-store の変更を terminal-store に同期（subscribe パターン）
// ※ store定義の外で実行:
useSettingsStore.subscribe(
  (state) => state.settings,
  (newSettings) => {
    useTerminalStore.setState({ settings: newSettings });
  }
);

// deprecated: 互換用ラッパー関数（直接 useSettingsStore を使うこと）
updateSettings: (p: Partial<AppSettings>) => {
  console.warn('[DEPRECATED] useTerminalStore.updateSettings → use useSettingsStore.updateSettings');
  useSettingsStore.getState().updateSettings(p);
},
```

**影響ファイル**:
- `app/(tabs)/settings.tsx` — import先を `useSettingsStore` に変更
- `app/(tabs)/index.tsx` — 設定参照箇所を `useSettingsStore` に変更
- `hooks/use-ai-dispatch.ts` — API キー参照を `useSettingsStore` に変更
- `lib/realtime-translate.ts` — 翻訳ON/OFF判定
- その他設定を参照する箇所（`useTerminalStore().settings.xxx` → `useSettingsStore().settings.xxx`）

**行数変化**: terminal-store.ts 796行 → 約550行（-250行）

### 3.2 types.ts への型集約

Tier 2で追加する新型を事前に定義:

```typescript
// store/types.ts に追加

/** Plan Step Card (Tier 2: X22) */
export interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  command?: string;        // ActionBlock用
  output?: string;         // 実行結果
  estimatedFiles?: number;
}

export interface PlanMessage {
  planId: string;
  summary: string;
  steps: PlanStep[];
  source: 'gemini-plan-mode' | 'claude' | 'local';
}

/** Arena Mode (Tier 2: B4) */
export interface ArenaEntry {
  arenaId: string;
  prompt: string;
  candidates: ArenaCandidate[];
  winnerId?: string;
  createdAt: number;
}

// NOTE: ChatAgent 型は chat-store.ts で定義されている。
// Tier 0.5 で ChatAgent を types.ts に移動すること（AiBlock.target も ChatAgent を使用しており、
// types.ts に置くのが本来の正しい場所）。
export interface ArenaCandidate {
  id: string;
  agent: ChatAgent;  // ← types.ts に移動後はローカル参照になる
  response: string;
  isStreaming: boolean;
  streamingText: string;
  tokenCount: number;
  streamingStartTime?: number;
  revealed: boolean;  // false = 匿名
}

/** Security Scanner (Tier 2: A1) */
export interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;        // 技術的説明
  plainDescription: string;   // 非エンジニア向け自然言語
  file?: string;
  line?: number;
  fix?: string;               // 修正コマンド or diff
}

/** Template Gallery (Tier 2: H19) */
// NOTE: lib/project-templates.ts に既存の ProjectTemplate 型（オブジェクト型）があるため
// union型は ProjectTemplateType として定義し、名前衝突を回避する
export type ProjectTemplateType = 'web' | 'api' | 'cli' | 'mobile' | 'static' | 'script' | 'document';

export interface TemplateDefinition {
  type: ProjectTemplateType;
  icon: string;
  labelKey: string;           // i18n key
  descriptionKey: string;     // i18n key
  keywords: { en: string[]; ja: string[] };
  wizardSteps: WizardStep[];  // 対話ウィザードの質問
}

export interface WizardStep {
  questionKey: string;         // i18n key
  inputType: 'text' | 'select' | 'multi-select';
  options?: { labelKey: string; value: string }[];
  required: boolean;
}
```

---

## 4. Tier 0: 即時改善

> ドキュメント更新 + 1行変更レベル。Shelly本体のロジック変更なし or 最小限。

### 4.1 D17: Superpowers × Chat UX

**変更**: Termux側の Claude Code に Superpowers プラグインをインストール。
**Shelly変更**: なし。
**効果**: ユーザーが「アプリ作りたい」と言ったら Claude Code が自動でブレスト対話を開始。Chat側にはその対話が自然に表示される。

### 4.2 D18: 翻訳モデル更新

**変更**: `lib/realtime-translate.ts`

```typescript
// 変更前
model: 'llama-3.3-70b'
// 変更後
model: 'llama-4-maverick-17b-128e'
```

**効果**: Cerebras経由の翻訳速度・品質が向上（2,522 tok/s）。

### 4.3 A2(sec): コミット前セキュリティゲート

**変更**: `lib/auto-savepoint.ts` の `createSavepoint()` 内、commit直前にパターンマッチ追加。

```typescript
// lib/auto-savepoint.ts に追加

const SECURITY_PATTERNS = [
  { pattern: /\.(env|env\.local|env\.production)$/,     label: '.env file' },
  { pattern: /\b(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}/i, label: 'hardcoded secret' },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/,  label: 'private key' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,               label: 'Google API key' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/,                 label: 'OpenAI/Anthropic key' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/,                 label: 'GitHub PAT' },
];

async function scanForSecrets(projectPath: string): Promise<SecurityIssue[]> {
  // git diff --cached --name-only でステージングされたファイルを取得
  // 各ファイルの内容に対してパターンマッチ
  // マッチしたら SecurityIssue[] を返す
  // 空なら問題なし
}
```

**統合ポイント**: `createSavepoint()` 内でcommit前に `scanForSecrets()` を呼ぶ。
問題があれば commit をスキップし、`savepoint-store` にwarningを記録。
Chat側に「⚠️ APIキーがコードに含まれています。コミットをスキップしました。」と通知。

**影響ファイル**:
- `lib/auto-savepoint.ts` — scanForSecrets追加 + createSavepoint修正
- `store/savepoint-store.ts` — warnings フィールド追加（optional）

### 4.4 ドキュメント更新（C7, H18, A1ボイスモード）

**README.md** に追加するセクション:

- **Vibe Coding ポジショニング**: 「Who is this for?」に「Vibe Coders — if you've used Lovable or Replit, imagine that on your phone with a real terminal」
- **Cowork 比較**: 「Unlike Claude Cowork (desktop only), Shelly runs on your phone with multi-AI support」
- **Voice Mode**: 「Tips: Run `claude /voice` in Terminal tab for hands-free development」

---

## 5. Tier 1: クロスペイン強化

> NTVのネイティブ出力バッファを活用した精度向上。

### 5.1 FileChanged フック × セーブポイント精度向上

**問題**: 現在の auto-savepoint は30秒アイドルタイマーで発火。AI応答直後のファイル変更を正確に捕捉できない。

**解決**: PTY出力からファイル変更コマンドを検出し、即時発火。

**変更**: `hooks/use-terminal-output.ts`

```typescript
// 現在 (32行)
export function useTerminalOutput(activeSessionId: string | null) {
  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionOutput', (event) => {
      addTerminalOutput(event.data, event.sessionId);
      // localhost検出
    });
    return () => sub.remove();
  }, [activeSessionId]);
}

// 拡張後 (~60行)
// NOTE: プロンプト文字($, #, %)の後に出現するコマンドのみマッチさせる。
// ヘルプテキストやエラーメッセージ内の偶発的マッチを防ぐ。
// PTY出力にはプロンプト文字が含まれるため、行頭 or プロンプト後をアンカーにする。
const PROMPT_PREFIX = /(?:^|\$\s+|#\s+|%\s+)/;
const FILE_CHANGE_PATTERNS = [
  /(?:wrote|created|saved|modified|updated)\s+(\S+)/i,   // AIツール出力（プロンプト不要）
  /(?:^|\$\s+|#\s+)(?:vim|nano|code)\s+(\S+)/,           // エディタ起動
  /(?:^|\$\s+|#\s+)(?:mv|cp|rm)\s+/,                     // ファイル操作
  /(?:^|\$\s+|#\s+)git\s+(?:checkout|reset|merge|rebase)/, // git操作
  /(?:^|\$\s+|#\s+)(?:npm|pnpm|yarn)\s+(?:install|add|remove)/, // パッケージ操作
];

export function useTerminalOutput(activeSessionId: string | null) {
  const triggerSavepoint = useSavepointStore((s) => s.triggerIfNeeded);

  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionOutput', (event) => {
      addTerminalOutput(event.data, event.sessionId);

      // localhost検出（既存）

      // ファイル変更検出（新規）
      for (const pattern of FILE_CHANGE_PATTERNS) {
        if (pattern.test(event.data)) {
          // 5秒デバウンスで発火（連続変更をバッチ化）
          triggerSavepoint({ reason: 'file-change-detected', delay: 5000 });
          break;
        }
      }
    });
    return () => sub.remove();
  }, [activeSessionId, triggerSavepoint]);
}
```

**影響ファイル**:
- `hooks/use-terminal-output.ts` — パターン追加 + savepoint連携
- `store/savepoint-store.ts` — `triggerIfNeeded()` にデバウンスロジック追加

### 5.2 脆弱性レポート自然言語化

**変更**: `lib/realtime-translate.ts` に専用プロンプト追加。

```typescript
// セキュリティ出力検出パターン
const SECURITY_OUTPUT_PATTERNS = [
  /CVE-\d{4}-\d+/,
  /\b(vulnerability|exploit|injection|XSS|CSRF|SQL injection)\b/i,
  /\b(critical|high|medium|low)\s+severity\b/i,
  /\bnpm audit\b/,
  /\bsecurity advisory\b/i,
];

// 既存の translateTerminalOutput() 内で分岐
const isSecurityOutput = SECURITY_OUTPUT_PATTERNS.some(p => p.test(output));

const securityPrompt = `Translate this security report for a non-engineer.
Rules:
- No CVE numbers or technical jargon
- Use emoji for severity: 🔴critical 🟠high 🟡medium 🟢low
- Explain what's at risk in plain Japanese
- End with [修正する] if a fix is available
Output: 1-3 sentences in Japanese.`;
```

**影響ファイル**:
- `lib/realtime-translate.ts` — セキュリティパターン + 専用プロンプト追加

### 5.3 Gemini サブエージェント並列表示

**変更**: なし（Gemini CLI v0.35の機能に依存）。
`use-terminal-output.ts` の既存出力キャプチャでサブエージェントの並列出力を自動追跡。
クロスペイン注入でChat側に自動表示される。

### 5.4 スプリットビュー自動アシスト ★★★

**コンセプト**: スプリットビューにした瞬間、チャットが「ターミナルの自然言語インターフェース」として
自動的に機能する。ユーザーは「スプリットにしたらチャットが賢くなった」と体感し、
教えなくても「右のエラー直して」という操作を自然に発見できる。

**設計思想**: 個別機能ではなく、スプリットビュー時にチャットがターミナルの出来事を
自動的にバブルとして表示する**統一的な仕組み**。既存のクロスペイン（Phase 2-5）の
出力を、TranslateOverlay（一時的なオーバーレイ）からChatバブル（永続的な記録）に昇格させる。

#### 5.4.1 承認プロキシ

ターミナルの `[Y/n]` プロンプトをChat側のネイティブボタンに変換。

```typescript
// ApprovalBubble — 新規コンポーネント
// components/chat/ApprovalBubble.tsx (~120行)

interface ApprovalBubbleProps {
  sessionId: string;
  command: string;           // 承認対象のコマンド
  translation: string;       // 自然言語翻訳（既存の realtime-translate から）
  dangerLevel: DangerLevel;  // command-safety.ts の判定結果
  onApprove: () => void;     // → TerminalEmulator.writeToSession(sessionId, 'Y\n')
  onDeny: () => void;        // → TerminalEmulator.writeToSession(sessionId, 'n\n')
  onAskTeam: () => void;     // → @team dispatch でセカンドオピニオン取得
}

// 表示例:
// ┌─────────────────────────────────────┐
// │ ⚠️ Claudeが許可を求めています        │
// │                                     │
// │ 「node_modulesを削除して再インストール │
// │  します。問題ないですか？」           │
// │                                     │
// │ [許可]  [拒否]  [@teamに聞く]        │
// └─────────────────────────────────────┘
```

**フロー**:
```
PTY出力 → 承認パターン検出（既存 realtime-translate.ts）
    → Wide時: Chat に ApprovalBubble 追加（新規）
    → Single時: TranslateOverlay のまま（既存、変更なし）

[許可] → TerminalEmulator.writeToSession(sessionId, 'Y\n')
[拒否] → TerminalEmulator.writeToSession(sessionId, 'n\n')
[@teamに聞く] → @team dispatch（既存パイプライン）
    → 各AIの意見がChatバブルとして表示
    → ユーザーが判断してから [許可] or [拒否]
```

**セカンドオピニオン**: `[@teamに聞く]` ボタンは既存の `@team` dispatch に乗せるだけ。
ターミナルコンテキスト（クロスペインPhase 3）が自動注入されるので、各AIは
承認対象のコマンドとその前後の文脈を理解した上で意見を返す。

#### 5.4.2 セーブポイント通知バブル

ファイル変更を検出してセーブポイントが発火したとき、Chatにバブルを追加。

```
// 表示例:
// ┌──────────────────────────────────┐
// │ 💾 自動保存しました               │
// │ 3ファイル変更 (app.tsx, style.css, │
// │ package.json)                    │
// │                                  │
// │ [元に戻す]  [差分を見る]          │
// └──────────────────────────────────┘
```

**統合**: `auto-savepoint.ts` の `createSavepoint()` 完了後に
`chat-store.addMessage()` でシステムバブルを追加。
[元に戻す] → 既存の `revertToSavepoint()`、[差分を見る] → 既存の `DiffViewerModal`。

#### 5.4.3 セキュリティ警告バブル

Tier 0 のコミット前スキャンで問題が見つかったとき、Chatバブルとして表示。

```
// 表示例:
// ┌──────────────────────────────────┐
// │ 🔒 コミットをスキップしました      │
// │                                  │
// │ APIキーがコードに含まれています    │
// │ src/config.ts:23                 │
// │                                  │
// │ [修正する]  [無視して保存]         │
// └──────────────────────────────────┘
```

#### 5.4.4 エラー要約バブル

既存の TranslateOverlay（一時的オーバーレイ、10秒で消える）を、
Wide時はChatバブル（永続的記録）に昇格。

```
// 表示例:
// ┌──────────────────────────────────┐
// │ ❌ エラーを検出しました            │
// │                                  │
// │ 「モジュールが見つかりません。      │
// │  react-nativeのバージョンが        │
// │  合っていない可能性があります」     │
// │                                  │
// │ [修正を提案]  [@teamに聞く]       │
// └──────────────────────────────────┘
```

[修正を提案] → 既存のAI dispatch（エラーコンテキスト付き）
[@teamに聞く] → 承認プロキシと同じく @team dispatch

#### 5.4.5 実装まとめ

**新規ファイル**:
- `components/chat/ApprovalBubble.tsx` (~120行)
- `components/chat/SavepointNotifyBubble.tsx` (~80行)

**変更ファイル**:
- `hooks/use-terminal-output.ts` — 承認検出時にchat-storeへバブル追加（Wide時のみ）
- `lib/auto-savepoint.ts` — セーブポイント完了時にchat-storeへ通知
- `lib/realtime-translate.ts` — エラー検出時、Wide時はバブル昇格
- `store/chat-store.ts` — `ChatMessage` に `systemType` フィールド追加
  (`'approval' | 'savepoint' | 'security' | 'error-summary'`)

**既存活用**（新規実装不要）:
- 承認パターン検出 → `realtime-translate.ts` (6パターン)
- ターミナルコンテキスト注入 → `terminal-context.ts` + `use-ai-dispatch.ts`
- @team dispatch → `use-ai-dispatch.ts` の team ブランチ
- PTY書き込み → `TerminalEmulator.writeToSession()`
- 安全チェック → `command-safety.ts`
- セーブポイントrevert/diff → `auto-savepoint.ts` + `DiffViewerModal`

**Wide/Single切り替え**:
- Wide（スプリットビュー）: 全バブル自動表示
- Single（Phone）: 従来通りTranslateOverlay + SaveBadge（変更なし）

**Tier配置**: Session Bの後、Session Cの前（Tier 1.5）。
クロスペインの出力パイプラインが整った後、ChatBubble拡張の前に実装。

---

## 6. Tier 2: コア新機能

### 6.1 X22: Plan Mode ステップカード ★★★

**コンセプト**: AIが生成した計画をステップカードとして表示。各ステップに[実行]ボタン。非エンジニアが「何が起きるか」を事前に確認できる。

#### 6.1.1 Plan Mode 出力のパース

Gemini CLI の Plan Mode 出力形式:

```
## Plan
1. Create project structure
   - src/index.html
   - src/style.css
2. Add navigation component
   ```bash
   mkdir -p src/components
   ```
3. Configure build system
```

**新規ファイル**: `lib/parse-plan.ts` (~80行)

```typescript
import { PlanStep, PlanMessage } from '@/store/types';

const STEP_PATTERN = /^(\d+)\.\s+(.+)$/gm;
const SUBSTEP_PATTERN = /^\s+[-*]\s+(.+)$/gm;
const CODE_BLOCK_PATTERN = /```(\w*)\n([\s\S]*?)```/g;

export function parsePlanOutput(text: string, source: PlanMessage['source']): PlanMessage | null {
  // 1. "## Plan" or "計画:" ヘッダーを検出
  // 2. 番号付きステップを抽出
  // 3. 各ステップ内のコードブロックを command として抽出
  // 4. PlanMessage を返す（検出できなければ null）
}

export function isPlanOutput(text: string): boolean {
  // Plan Mode出力かどうかの判定
  // "## Plan" ヘッダー + 3つ以上の番号付きステップ
}
```

#### 6.1.2 ChatBubble への統合 — 汎用バブルルーター

**変更**: `components/chat/ChatBubble.tsx`

Session C で**汎用の特殊バブルルーター**を定義し、Session E (Arena), Session G (Security) が
同じ拡張ポイントにケースを追加するだけで済むようにする。これによりChatBubbleの多重変更によるコンフリクトを防ぐ。

```typescript
// ChatBubble.tsx 内 — 汎用特殊バブルルーター（Session C で追加）
function renderSpecialContent(message: ChatMessage, isWide: boolean): React.ReactNode | null {
  // 1. Arena Mode バブル（Session E で追加）
  if (message.arenaId) {
    return <ArenaBubble arenaId={message.arenaId} isWide={isWide} />;
  }
  // 2. Security Report バブル（Session G で追加）
  if (message.securityIssues?.length) {
    return <SecurityReportBubble issues={message.securityIssues} />;
  }
  // 3. Plan Mode ステップカード
  if (!message.isStreaming && message.content && isPlanOutput(message.content)) {
    return (
      <PlanCardList
        plan={parsePlanOutput(message.content, message.agent)}
        onExecuteStep={handleExecuteStep}
        onSkipStep={handleSkipStep}
        isWide={isWide}
      />
    );
  }
  return null;  // 通常のMarkdown + ActionBlock レンダリングにフォールバック
}

// レンダリング部分:
const specialContent = renderSpecialContent(message, isWide);
{specialContent ?? (
  // 既存のMarkdown + ActionBlock レンダリング
)}
```

#### 6.1.3 PlanCardList コンポーネント

**新規ファイル**: `components/chat/PlanCardList.tsx` (~200行)

```typescript
interface PlanCardListProps {
  plan: PlanMessage;
  onExecuteStep: (step: PlanStep) => void;
  onSkipStep: (step: PlanStep) => void;
  isWide: boolean;
}

// 各ステップをカードとして表示
// ステータスに応じたアイコン:
//   pending: ○  running: ◉（回転アニメーション）  done: ✓  error: ✗  skipped: —
// [実行] ボタン → command があれば ActionBlock と同じ安全チェック → 実行
// [スキップ] ボタン → status を 'skipped' に
// 実行結果は output フィールドに表示（折りたたみ）
// 全ステップ完了時に「🎉 完了！」バナー
```

**デザイン**:
- カード背景: `colors.surface` + 左ボーダー（ステータス色）
- pending: `colors.textSecondary`
- running: `colors.primary` (#00D4AA)
- done: `#22C55E` (green)
- error: `#EF4444` (red)
- skipped: `colors.textSecondary` + opacity 0.5

#### 6.1.4 Plan Store

**新規ファイル**: `store/plan-store.ts` (~80行)

```typescript
interface PlanState {
  activePlan: PlanMessage | null;
  planHistory: PlanMessage[];  // 最大20件
  setActivePlan: (plan: PlanMessage) => void;
  updateStepStatus: (planId: string, stepId: string, status: PlanStep['status'], output?: string) => void;
  clearActivePlan: () => void;
}
```

永続化: AsyncStorage（プラン履歴のみ）。activePlanはメモリのみ（セッション内で完結）。

#### 6.1.5 input-router.ts + use-ai-dispatch.ts 変更

`@plan` ルーティングとdispatchブランチを追加:

```typescript
// input-router.ts
// @plan → target: 'plan' としてルーティング
// 例: "@plan ポートフォリオサイト作って"

// use-ai-dispatch.ts — 'plan' dispatchブランチ（新規追加）
case 'plan': {
  // 1. Gemini CLI が利用可能なら "--plan" フラグ付きで実行
  //    bridgeRunCommand(`gemini --plan "${prompt}"`)
  // 2. Gemini API のみなら system prompt に "Respond in Plan format: ..." を追加
  // 3. Claude fallback: system prompt に plan format指示を追加
  // 4. 応答を parsePlanOutput() でパースし、planData があれば plan-store に保存
  // 5. ChatMessage に通常通り保存（renderSpecialContent が PlanCardList として描画）
}
```

---

### 6.2 X21: Click-to-Edit ★★★

**コンセプト**: WebPreviewModal / PreviewPanel 内のWebViewで、UI要素をタップして「もっと大きくして」と指示 → AIがCSS/HTML修正 → プレビュー即更新。

#### 6.2.1 要素選択JS注入

**新規ファイル**: `lib/click-to-edit.ts` (~120行)

```typescript
/**
 * WebViewに注入するJavaScript。
 * DOM要素のタップを検出し、セレクター情報をReact Nativeに送る。
 */
export function getClickToEditScript(): string {
  return `
    (function() {
      let isEditMode = false;
      let highlightEl = null;

      // React Nativeからのメッセージで editMode を切り替え
      window.addEventListener('message', (e) => {
        if (e.data.type === 'SET_EDIT_MODE') {
          isEditMode = e.data.enabled;
          document.body.style.cursor = isEditMode ? 'crosshair' : 'default';
        }
      });

      document.addEventListener('click', (e) => {
        if (!isEditMode) return;
        e.preventDefault();
        e.stopPropagation();

        const el = e.target;
        const selector = buildUniqueSelector(el);
        const computedStyle = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ELEMENT_SELECTED',
          selector,
          tagName: el.tagName.toLowerCase(),
          text: el.textContent?.slice(0, 100),
          currentStyles: {
            color: computedStyle.color,
            fontSize: computedStyle.fontSize,
            backgroundColor: computedStyle.backgroundColor,
            padding: computedStyle.padding,
            margin: computedStyle.margin,
          },
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }));
      }, true);

      function buildUniqueSelector(el) {
        // id > class > nth-child のフォールバックでユニークセレクター生成
        if (el.id) return '#' + el.id;
        const path = [];
        while (el && el !== document.body) {
          let selector = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            selector += '.' + el.className.trim().split(/\\s+/).join('.');
          }
          path.unshift(selector);
          el = el.parentElement;
        }
        return path.join(' > ');
      }
    })();
  `;
}
```

#### 6.2.2 EditSheet コンポーネント

**新規ファイル**: `components/chat/EditSheet.tsx` (~150行)

```typescript
interface EditSheetProps {
  visible: boolean;
  element: SelectedElement | null;  // click-to-edit.ts から受け取る
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}

// BottomSheet として表示:
// - 選択された要素のプレビュー（タグ名、テキスト抜粋、現在のスタイル）
// - テキスト入力: 「どう変えたい？」
// - プリセットボタン: [大きく] [小さく] [色変更] [削除] [移動]
// - [送信] → onSubmit("h1.headerのfont-sizeを2emにして")
```

#### 6.2.3 AI プロンプト構築

`use-ai-dispatch.ts` 内で Click-to-Edit コンテキストを注入:

```typescript
// EditSheet の onSubmit が呼ばれたとき:
const editPrompt = `
[Click-to-Edit Context]
Selected element: ${element.selector}
Current tag: ${element.tagName}
Current text: "${element.text}"
Current styles: ${JSON.stringify(element.currentStyles)}

[User instruction]
${userInstruction}

Respond with ONLY the modified HTML/CSS. Use a single fenced code block.
Do not explain. Do not add comments.`;
```

#### 6.2.4 プレビュー即更新

AIがコードブロックを返す → `parseCodeBlocks()` で抽出 → WebViewの `injectJavaScript()` で即適用:

```typescript
// PreviewPanel.tsx or WebPreviewModal.tsx 内
function applyEdit(code: string) {
  webViewRef.current?.injectJavaScript(`
    (function() {
      // CSS変更の場合
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(code)};
      document.head.appendChild(style);
      // HTML変更の場合は innerHTML 置換
    })();
  `);
}
```

#### 6.2.5 統合先の選択

| 統合先 | メリット | デメリット |
|--------|---------|-----------|
| WebPreviewModal (Chat側) | セーブポイントのHTML表示と統合 | 79行で薄い、モーダルなので操作性△ |
| **PreviewPanel (Terminal側)** | **localhost検出と統合、常時表示、スプリットビュー** | Terminal側なのでChat入力との距離 |

**決定**: **PreviewPanel に統合**。理由:
1. PreviewPanel は常時表示でモーダルではない → 編集→確認のループが速い
2. localhost の開発サーバーに対して使うのが主要ユースケース
3. Wide画面ではChat + Terminal(Preview含む) が並ぶので、Chat入力との距離は問題にならない
4. WebPreviewModal はセーブポイントのdiff表示用として残す（責務分離）

**影響ファイル**:
- `components/terminal/PreviewPanel.tsx` — JS注入 + EditSheet連携
- `lib/click-to-edit.ts` — 新規
- `components/chat/EditSheet.tsx` — 新規
- `hooks/use-ai-dispatch.ts` — editContext注入ロジック追加

---

### 6.3 B4: Arena Mode（AI対決）★★★

**コンセプト**: 同じプロンプトを2つのAIに匿名で投げ、結果を並べて表示。ユーザーが「こっちが良い」を選ぶと、そのAIが明かされる。

#### 6.3.1 Arena Store

**新規ファイル**: `store/arena-store.ts` (~100行)

```typescript
interface ArenaState {
  activeArena: ArenaEntry | null;
  arenaHistory: ArenaEntry[];  // 最大30件
  startArena: (prompt: string, agents: [ChatAgent, ChatAgent]) => string;  // returns arenaId
  updateCandidate: (arenaId: string, candidateId: string, update: Partial<ArenaCandidate>) => void;
  vote: (arenaId: string, winnerId: string) => void;
  clearArena: () => void;
}
```

永続化: arenaHistory のみ AsyncStorage。
**サイズ制限**: 永続化時に各 `ArenaCandidate.response` を2000文字に切り詰め。
30エントリ × 2候補 × 2000字 = 最大約120KB（AsyncStorage安全圏内）。

#### 6.3.2 エージェント選択ロジック

```typescript
// lib/arena-selector.ts (~40行)

export function selectArenaAgents(
  availableAgents: ChatAgent[],
  settings: AppSettings
): [ChatAgent, ChatAgent] {
  // 1. 利用可能なエージェントからAPIキーが設定済みのものをフィルタ
  // 2. ランダムに2つ選択
  // 3. 同じエージェントが選ばれないようにする
  // 4. フォールバック: claude + gemini（最も一般的な組み合わせ）
}
```

#### 6.3.3 input-router.ts 変更

```typescript
// @arena ルーティング追加
// 例: "@arena このコードをリファクタして"
// → ArenaMode起動 → 2つのAIに同じプロンプトを送信
```

#### 6.3.4 ArenaBubble コンポーネント

**新規ファイル**: `components/chat/ArenaBubble.tsx` (~250行)

```
┌──────────────────────────────────────┐
│  ⚔️ Arena Mode                       │
│  "このコードをリファクタして"          │
├──────────┬───────────────────────────┤
│  🅰️       │  🅱️                       │
│  Response │  Response                │
│  ...      │  ...                     │
│           │                          │
│  [選ぶ]   │  [選ぶ]                  │
├──────────┴───────────────────────────┤
│  ⓘ 投票後にどのAIか表示されます       │
└──────────────────────────────────────┘
```

投票後:

```
┌──────────────────────────────────────┐
│  ⚔️ Arena Mode — 結果                │
├──────────┬───────────────────────────┤
│  🅰️ Claude│  🅱️ Gemini  ★ Winner    │
│  ...      │  ...                     │
├──────────┴───────────────────────────┤
│  Gemini が選ばれました (67% の勝率)   │
└──────────────────────────────────────┘
```

**レイアウト**:
- Wide (≥600dp): 左右に並列表示
- Compact (<600dp): スワイプで切り替え（Indicator dots）

#### 6.3.5 use-ai-dispatch.ts 変更

`dispatchArena()` メソッド追加:

```typescript
async function dispatchArena(params: {
  prompt: string;
  agents: [ChatAgent, ChatAgent];
  chatSessionId: string;
}): Promise<void> {
  const arenaId = startArena(params.prompt, params.agents);

  // OOMリスク緩和: Compact画面ではデフォルト逐次実行
  // Wide画面ではデフォルト並列実行
  // settings.arenaParallelMode で上書き可能 ('auto' | 'parallel' | 'sequential')
  const isWide = params.isWide ?? false;
  const mode = settings.arenaParallelMode ?? 'auto';
  const runParallel = mode === 'parallel' || (mode === 'auto' && isWide);

  if (runParallel) {
    // 並列: 2つのエージェントに同時dispatch
    await Promise.all(params.agents.map(async (agent, i) => {
      const candidateId = `${arenaId}-${i}`;
      // 各エージェントのストリーミングをarena-storeのupdateCandidateに流す
    }));
  } else {
    // 逐次: 1つ目完了後に2つ目を開始（Termux OOM回避）
    for (let i = 0; i < params.agents.length; i++) {
      const candidateId = `${arenaId}-${i}`;
      // ストリーミング完了を待ってから次へ
    }
  }
  // ChatBubbleの代わりにArenaBubbleがレンダリング
}
```

---

### 6.4 H19: テンプレートギャラリー ★★★

**コンセプト**: 「何か作りたい」→ テンプレート選択 → 対話ウィザード → プロジェクト生成 → AutoCheck設定まで一気通貫。

#### 6.4.1 既存資産の活用

既に存在するもの:
- `lib/project-templates.ts` (508行) — 3テンプレート (Web/Script/Document)
- `store/creator-store.ts` (310行) — Creator Engine ライフサイクル
- `lib/creator-engine.ts` — プロジェクト生成ロジック
- `components/creator/CommandLane.tsx` — 4つのクイックテンプレート (Node API, Static Site, CLI Tool, Python Script)

**戦略**: 既存を破壊せず、テンプレートを7種に拡張 + ウィザードUIを追加。

#### 6.4.2 テンプレート拡張

**変更**: `lib/project-templates.ts`

既存3種 → 7種に拡張:

| テンプレート | 既存 | 追加内容 |
|-------------|------|---------|
| Web | ✅ | — |
| Script | ✅ | — |
| Document | ✅ | — |
| **API** | **新規** | Express/Fastify スターター |
| **CLI** | **新規** | Node.js CLI (commander.js) スターター |
| **Mobile** | **新規** | Expo スターター（Shelly自身の構造を参考） |
| **Static** | **新規** | Astro/Hugo スターター |

各テンプレートに `wizardSteps` を追加（TemplateDefinition型）:

```typescript
// 例: Web テンプレートのウィザード
wizardSteps: [
  { questionKey: 'wizard.who_uses', inputType: 'text', required: true },
  { questionKey: 'wizard.main_feature', inputType: 'text', required: true },
  { questionKey: 'wizard.style', inputType: 'select', options: [
    { labelKey: 'wizard.style_modern', value: 'modern' },
    { labelKey: 'wizard.style_minimal', value: 'minimal' },
    { labelKey: 'wizard.style_playful', value: 'playful' },
  ], required: false },
]
```

#### 6.4.3 TemplateGallery コンポーネント

**新規ファイル**: `components/chat/TemplateGallery.tsx` (~180行)

ChatOnboarding完了後、または空のChat画面で表示:

```
┌──────────────────────────────────────┐
│  何を作りますか？                     │
│                                      │
│  [🌐 Web]  [⚡ API]  [🖥️ CLI]       │
│  [📱 Mobile] [📄 Static] [🐍 Script] │
│  [📝 Document]                       │
│                                      │
│  または自由に説明してください...       │
│  ┌──────────────────────────────┐    │
│  │ ポートフォリオサイトを...     │    │
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

タップ → WizardFlow開始:

```
┌──────────────────────────────────────┐
│  🌐 Webアプリ — Step 1/3             │
│                                      │
│  誰が使いますか？                    │
│  ┌──────────────────────────────┐    │
│  │ デザインに興味がある人        │    │
│  └──────────────────────────────┘    │
│                                      │
│        [戻る]        [次へ →]        │
└──────────────────────────────────────┘
```

#### 6.4.4 ウィザード → Creator Engine 連携

ウィザード完了後、回答を Creator Engine に渡す:

```typescript
// TemplateGallery → creator-store.startPlanning()
const wizardContext = {
  template: 'web',
  answers: {
    who_uses: 'デザインに興味がある人',
    main_feature: 'ポートフォリオ',
    style: 'modern',
  },
};

// AI に渡すプロンプトを構築
const prompt = `Create a ${wizardContext.template} project.
Target users: ${wizardContext.answers.who_uses}
Main feature: ${wizardContext.answers.main_feature}
Style: ${wizardContext.answers.style}
Use the project template and generate all files.`;

// 既存のCreator Engineフローに乗せる
creatorStore.startPlanning(prompt, wizardContext.template);
```

#### 6.4.5 AutoCheck 自動提案

プロジェクト生成完了後、`AutoCheckProposalBubble`（既存）を自動表示:

```typescript
// creator-store の finishProject() 後
// chat-store にAutoCheck提案メッセージを追加
addMessage(chatSessionId, {
  role: 'assistant',
  agent: 'git',
  content: '',
  wizardType: 'autocheck',
  wizardData: { projectPath: project.path },
});
```

**影響ファイル**:
- `lib/project-templates.ts` — 4テンプレート追加 + wizardSteps定義
- `components/chat/TemplateGallery.tsx` — 新規
- `components/chat/ChatMessageList.tsx` — 空状態でTemplateGallery表示
- `store/creator-store.ts` — wizardContext受け取り対応

---

### 6.5 A1(sec): 自動セキュリティスキャン ★★☆

**コンセプト**: push後にセキュリティスキャンを実行し、結果をChat表示。ワンタップ修正。

#### 6.5.1 Security Scanner

**新規ファイル**: `lib/security-scanner.ts` (~150行)

2層構成:
1. **ローカルスキャン**（API不要、即時）: パターンマッチ
2. **AIスキャン**（API使用、詳細）: diff をAIに送って分析

```typescript
export async function scanLocal(projectPath: string): Promise<SecurityIssue[]> {
  // npm audit --json (あれば)
  // パターンマッチ（Tier 0のscanForSecretsを再利用）
  // .env ファイルのgit追跡チェック
}

export async function scanWithAI(
  diff: string,
  agent: ChatAgent
): Promise<SecurityIssue[]> {
  // diff をAIに送信
  // プロンプト: "Analyze this diff for security issues. Return JSON array of {severity, title, description, file, line, fix}"
  // 結果を SecurityIssue[] にパース
  // plainDescription は realtime-translate のパイプラインで自然言語化
}
```

#### 6.5.2 Push後の自動トリガー

**変更**: `lib/github-push.ts`（既存）

```typescript
// pushProcessing() の最後に追加
const issues = await scanLocal(projectPath);
if (settings.aiSecurityScan) {
  const diff = await execGit('diff HEAD~1', projectPath);
  const aiIssues = await scanWithAI(diff, 'cerebras');
  issues.push(...aiIssues);
}

if (issues.length > 0) {
  // Chat に SecurityReportBubble を追加
  addMessage(chatSessionId, {
    role: 'assistant',
    agent: 'git',
    content: formatSecurityReport(issues),
    securityIssues: issues,
  });
}
```

#### 6.5.3 SecurityReportBubble

**新規ファイル**: `components/chat/SecurityReportBubble.tsx` (~120行)

```
┌──────────────────────────────────────┐
│  🛡️ セキュリティチェック              │
│                                      │
│  🔴 APIキーがコードに含まれています    │
│     src/config.ts:23                 │
│     [修正する]                        │
│                                      │
│  🟡 npm パッケージに既知の脆弱性       │
│     lodash@4.17.20                   │
│     [アップデート]                    │
│                                      │
│  🟢 その他の問題はありません           │
└──────────────────────────────────────┘
```

[修正する] → ActionBlock と同じ安全チェック → コマンド実行。

---

## 7. Store 新設・変更マップ

### 新規 Store

| Store | 行数(予想) | Tier | 永続化 |
|-------|-----------|------|--------|
| `settings-store.ts` | ~200 | 0.5 | AsyncStorage |
| `plan-store.ts` | ~80 | 2 | AsyncStorage (履歴のみ) |
| `arena-store.ts` | ~100 | 2 | AsyncStorage (履歴のみ) |

### 変更 Store

| Store | 変更内容 | Tier |
|-------|---------|------|
| `terminal-store.ts` | settings抽出で-250行 | 0.5 |
| `types.ts` | PlanStep, ArenaEntry, SecurityIssue等の型追加 | 0.5 |
| `chat-store.ts` | planData, arenaId フィールド追加 (ChatMessage型) | 2 |
| `savepoint-store.ts` | warnings + triggerIfNeeded追加 | 0-1 |
| `creator-store.ts` | wizardContext受け取り対応 | 2 |

### 変更なし Store

| Store | 理由 |
|-------|------|
| `execution-log-store.ts` | 既に模範的。触らない |
| `snippet-store.ts` | 無関係 |
| `mcp-store.ts` | 無関係 |
| `obsidian-store.ts` | 無関係 |
| `preview-store.ts` | Click-to-EditはPreviewPanel側で処理 |

---

## 8. ファイル変更マトリクス

### 新規ファイル（13ファイル）

| ファイル | Tier | 行数(予想) |
|---------|------|-----------|
| `store/settings-store.ts` | 0.5 | ~200 |
| `store/plan-store.ts` | 2 | ~80 |
| `store/arena-store.ts` | 2 | ~100 |
| `lib/parse-plan.ts` | 2 | ~80 |
| `lib/click-to-edit.ts` | 2 | ~120 |
| `lib/arena-selector.ts` | 2 | ~40 |
| `lib/security-scanner.ts` | 2 | ~150 |
| `components/chat/PlanCardList.tsx` | 2 | ~200 |
| `components/chat/EditSheet.tsx` | 2 | ~150 |
| `components/chat/ArenaBubble.tsx` | 2 | ~250 |
| `components/chat/TemplateGallery.tsx` | 2 | ~180 |
| `components/chat/SecurityReportBubble.tsx` | 2 | ~120 |
| 合計 | | ~1,670 |

### 変更ファイル（15ファイル）

| ファイル | Tier | 変更内容 | 影響度 |
|---------|------|---------|--------|
| `store/terminal-store.ts` | 0.5 | settings抽出 | 大（-250行） |
| `store/types.ts` | 0.5 | 型追加 | 中（+80行） |
| `lib/realtime-translate.ts` | 0-1 | モデル名+セキュリティプロンプト | 小 |
| `lib/auto-savepoint.ts` | 0 | scanForSecrets追加 | 中 |
| `store/savepoint-store.ts` | 0-1 | warnings+trigger追加 | 小 |
| `hooks/use-terminal-output.ts` | 1 | ファイル変更検出追加 | 中（+30行） |
| `lib/input-router.ts` | 2 | @plan, @arena追加 | 小（+20行） |
| `hooks/use-ai-dispatch.ts` | 2 | dispatchArena+editContext | 中（+80行） |
| `components/chat/ChatBubble.tsx` | 2 | PlanCardList統合 | 中 |
| `components/chat/ChatMessageList.tsx` | 2 | 空状態にTemplateGallery | 小 |
| `components/terminal/PreviewPanel.tsx` | 2 | click-to-edit JS注入 | 中 |
| `lib/project-templates.ts` | 2 | 4テンプレート追加 | 中（+200行） |
| `store/creator-store.ts` | 2 | wizardContext対応 | 小 |
| `store/chat-store.ts` | 2 | planData, arenaId追加 | 小 |
| `lib/github-push.ts` | 2 | セキュリティスキャン連携 | 小 |

---

## 9. セッション計画

> Termux環境の安定性を考慮し、各セッションは2-3時間、独立してコミット可能な単位で区切る。

### Session A1: Store リファクタ (1セッション)
> リファクタと機能追加を分離。A1が壊れてもA2に影響しない。
1. `ChatAgent` 型を `chat-store.ts` → `types.ts` に移動
2. `settings-store.ts` 抽出
3. `terminal-store.ts` からsettings削除 + subscribe互換層
4. import先の一括変更
5. `types.ts` にTier 2用の型追加（PlanStep, ArenaEntry, SecurityIssue, ProjectTemplateType等）
6. **コミット1**: `refactor: extract settings-store from terminal-store`
7. 動作確認（設定画面、AI dispatch、翻訳トグルが動くことを確認）

### Session A2: Tier 0 改善 (Session A1直後 or 別セッション)
1. Tier 0: realtime-translate モデル名変更
2. Tier 0: auto-savepoint にscanForSecrets追加
3. Tier 0: README更新（Vibe Coding, Cowork比較, Voice Mode）
4. **コミット2**: `feat: add commit security gate + update translation model`

### Session B: Tier 1 (1セッション)
1. use-terminal-output にファイル変更検出追加（プロンプト先頭のみマッチ）
2. savepoint-store にtrigger + debounce追加
3. realtime-translate にセキュリティプロンプト追加
4. **コミット**: `feat: improve savepoint accuracy + security output translation`

### Session B2: スプリットビュー自動アシスト (1セッション)
> クロスペインの出力を Chat バブルに昇格。承認プロキシ + セカンドオピニオン。
1. `components/chat/ApprovalBubble.tsx` 新規（承認プロキシ + @teamに聞く）
2. `components/chat/SavepointNotifyBubble.tsx` 新規
3. `store/chat-store.ts` に `systemType` フィールド追加
4. `hooks/use-terminal-output.ts` — 承認検出時にWideならバブル追加
5. `lib/auto-savepoint.ts` — 完了時にChat通知
6. `lib/realtime-translate.ts` — エラー検出時、Wideならバブル昇格
7. i18n: `en.ts` / `ja.ts` にキー追加
8. **コミット**: `feat: split-view auto-assist — approval proxy, savepoint notify, error summary`

### Session C: Plan Mode ステップカード (1セッション) ★ ChatBubble拡張ポイント定義
> **重要**: ここで汎用バブルルーター `renderSpecialContent()` を定義。
> Session E, G はこのルーターにケースを追加するだけ。
1. `lib/parse-plan.ts` 新規
2. `store/plan-store.ts` 新規
3. `components/chat/PlanCardList.tsx` 新規
4. `ChatBubble.tsx` に `renderSpecialContent()` 汎用ルーター追加 + PlanCardList統合
5. `input-router.ts` に @plan 追加
6. `use-ai-dispatch.ts` に 'plan' dispatchブランチ追加
7. i18n: `en.ts` / `ja.ts` にキー追加（後述の i18n セクション参照）
8. **コミット**: `feat: Plan Mode step cards for guided project building`

### Session D: Click-to-Edit (1セッション)
> use-ai-dispatch.ts の変更領域: editContext注入（dispatchArenaとは別領域、コンフリクトなし）
1. `lib/click-to-edit.ts` 新規
2. `components/chat/EditSheet.tsx` 新規
3. `PreviewPanel.tsx` にJS注入 + EditSheet連携 + CSP回避注記
4. `use-ai-dispatch.ts` にeditContext追加（`getTerminalContextForPrompt` の隣に配置）
5. i18n: `en.ts` / `ja.ts` にキー追加
6. **コミット**: `feat: Click-to-Edit visual editing in preview panel`

### Session E: Arena Mode (1セッション)
> use-ai-dispatch.ts の変更領域: dispatchArena()メソッド追加（ファイル末尾に追加、Dとは別領域）
> ChatBubble.tsx: renderSpecialContent() に arenaId ケース追加のみ（Session C で定義済み）
1. `store/arena-store.ts` 新規 + `arenaParallelMode` を AppSettings に追加
2. `lib/arena-selector.ts` 新規
3. `components/chat/ArenaBubble.tsx` 新規
4. `use-ai-dispatch.ts` にdispatchArena追加（ファイル末尾）
5. `input-router.ts` に @arena 追加
6. `ChatBubble.tsx` の `renderSpecialContent()` にarenaIdケース追加
7. i18n: `en.ts` / `ja.ts` にキー追加
8. **コミット**: `feat: Arena Mode — blind AI comparison voting`

### Session F: テンプレートギャラリー (1セッション)
> Session D, E と独立。任意の順序で実行可能。
1. `lib/project-templates.ts` に4テンプレート追加（ProjectTemplateType使用）
2. `components/chat/TemplateGallery.tsx` 新規
3. `ChatMessageList.tsx` に空状態表示
4. `creator-store.ts` にwizardContext対応
5. i18n: `en.ts` / `ja.ts` にキー追加（ウィザード質問含む）
6. **コミット**: `feat: Template Gallery with guided wizard`

### Session G: セキュリティスキャン (1セッション)
> ChatBubble.tsx: renderSpecialContent() に securityIssues ケース追加のみ
1. `lib/security-scanner.ts` 新規
2. `components/chat/SecurityReportBubble.tsx` 新規
3. `lib/github-push.ts` に連携追加
4. `ChatBubble.tsx` の `renderSpecialContent()` にsecurityIssuesケース追加
5. i18n: `en.ts` / `ja.ts` にキー追加
6. **コミット**: `feat: auto security scan on push with natural language reports`

### Session H: 統合テスト + 仕上げ (1セッション)
1. 全機能の結合テスト
2. README大幅更新
3. CLAUDE.md更新（新機能、アーキテクチャ決定テーブル追加）
4. **コミット**: `docs: update README and CLAUDE.md for v2.0`

### セッション依存関係

```
A1 (Store refactor) ─必須→ A2 (Tier 0) ─必須→ B (Tier 1)
                                                    │
                                                    ▼
                                              B2 (自動アシスト) ─必須→ C (Plan + バブルルーター)
                                                                          │
                                                              ┌───────────┼───────────┐
                                                              ▼           ▼           ▼
                                                         D (Click)   E (Arena)   F (Template)
                                                              │           │           │
                                                              └───────────┼───────────┘
                                                                          ▼
                                                                     G (Security)
                                                                          │
                                                                          ▼
                                                                     H (統合テスト)
```

**B2 は B の直後**（クロスペイン出力パイプラインが必要）。
**D, E, F は任意の順序で実行可能**（use-ai-dispatch.ts の編集領域を分離済み）。
**G は C の後ならいつでも可能**（renderSpecialContent が必要）。
**合計: 10セッション** (A1, A2, B, B2, C, D, E, F, G, H)

---

## 10. リスクと緩和策

| リスク | 影響 | 緩和策 |
|--------|------|--------|
| **terminal-store リファクタで既存機能が壊れる** | 高 | 互換層を残す。Session A終了後にAPKビルドして実機確認 |
| **Chat画面 (1268行) がさらに肥大化** | 中 | 新機能は全てコンポーネントとして切り出し、index.tsxは統合のみ |
| **Arena Mode の並列ストリーミングでTermuxが落ちる** | 高 | Compact画面はデフォルト逐次実行。`arenaParallelMode: 'auto'|'parallel'|'sequential'` をAppSettingsに追加。Wide画面のみデフォルト並列 |
| **Click-to-Edit の JS 注入が WebView で動かない** | 中 | injectedJavaScript ではなく injectJavaScript(run-time) を使用。onMessage でハンドシェイク確認。**CSP注意**: Vite/Next.js等のdevサーバーがCSPヘッダーでインジェクションをブロックする可能性あり。PreviewPanel側で `<meta http-equiv="Content-Security-Policy">` を上書きするか、ユーザーにdevサーバーのCSP無効化を案内 |
| **Plan Mode の出力フォーマットがAIモデルごとに異なる** | 中 | parse-plan.ts に複数パーサー（Gemini形式、Claude形式、汎用マークダウン形式）を用意 |
| **テンプレートの質が低いとユーザー離脱** | 中 | 最初は3テンプレートに絞る（Web/API/CLI）。残り4つはv2.1で追加 |
| **セッション計画通りに進まない（Termux OOM）** | 高 | 各セッションは独立してコミット可能。WIPコミット活用。CLAUDE.mdに進捗記録 |
| **Arena履歴のAsyncStorageサイズ肥大** | 中 | ArenaCandidate.response を永続化時に2000文字に切り詰め。30エントリ × 2候補 × 2000字 = 最大120KB |
| **ChatBubble.tsx の多重変更でコンフリクト** | 中 | Session C で `renderSpecialContent()` 汎用ルーターを定義。E, G はケース追加のみ |

---

## 付録A: i18n キー一覧（新規コンポーネント用）

> CLAUDE.md ルール: "New UI strings must be added to both en.ts and ja.ts."
> 以下は各Tier 2コンポーネントに必要なi18nキーの一覧。

### スプリットビュー自動アシスト (Session B2)
```
approval.title: "Permission requested" / "許可を求めています"
approval.approve: "Allow" / "許可"
approval.deny: "Deny" / "拒否"
approval.ask_team: "Ask @team" / "@teamに聞く"
savepoint.notify: "Auto-saved" / "自動保存しました"
savepoint.files_changed: "%{count} files changed" / "%{count}ファイル変更"
savepoint.revert: "Undo" / "元に戻す"
savepoint.view_diff: "View changes" / "差分を見る"
security.commit_skipped: "Commit skipped" / "コミットをスキップしました"
security.ignore_save: "Ignore and save" / "無視して保存"
error.detected: "Error detected" / "エラーを検出しました"
error.suggest_fix: "Suggest fix" / "修正を提案"
error.ask_team: "Ask @team" / "@teamに聞く"
```

### Plan Mode ステップカード (Session C)
```
plan.title: "Plan" / "計画"
plan.step_pending: "Pending" / "待機中"
plan.step_running: "Running..." / "実行中..."
plan.step_done: "Done" / "完了"
plan.step_error: "Error" / "エラー"
plan.step_skipped: "Skipped" / "スキップ"
plan.execute: "Run" / "実行"
plan.skip: "Skip" / "スキップ"
plan.all_done: "All steps complete!" / "全ステップ完了！"
```

### Click-to-Edit (Session D)
```
edit.mode_on: "Edit Mode: Tap an element" / "編集モード: 要素をタップ"
edit.mode_off: "Exit Edit Mode" / "編集モード終了"
edit.what_to_change: "How would you like to change it?" / "どう変えたい？"
edit.preset_bigger: "Bigger" / "大きく"
edit.preset_smaller: "Smaller" / "小さく"
edit.preset_color: "Change color" / "色変更"
edit.preset_delete: "Delete" / "削除"
edit.submit: "Apply" / "適用"
```

### Arena Mode (Session E)
```
arena.title: "Arena Mode" / "アリーナモード"
arena.candidate_a: "A" / "A"
arena.candidate_b: "B" / "B"
arena.vote: "Choose" / "選ぶ"
arena.vote_hint: "AI names revealed after voting" / "投票後にAI名が表示されます"
arena.result: "Result" / "結果"
arena.winner: "Winner" / "勝者"
arena.win_rate: "%{agent} was chosen (%{rate}% win rate)" / "%{agent}が選ばれました（勝率%{rate}%）"
```

### Template Gallery (Session F)
```
template.title: "What do you want to build?" / "何を作りますか？"
template.or_describe: "Or describe freely..." / "または自由に説明してください..."
template.web: "Web App" / "Webアプリ"
template.api: "API Server" / "APIサーバー"
template.cli: "CLI Tool" / "CLIツール"
template.mobile: "Mobile App" / "モバイルアプリ"
template.static: "Static Site" / "静的サイト"
template.script: "Script" / "スクリプト"
template.document: "Document" / "ドキュメント"
wizard.who_uses: "Who will use this?" / "誰が使いますか？"
wizard.main_feature: "What's the main feature?" / "メインの機能は？"
wizard.style: "Choose a style" / "スタイルを選択"
wizard.style_modern: "Modern" / "モダン"
wizard.style_minimal: "Minimal" / "ミニマル"
wizard.style_playful: "Playful" / "ポップ"
wizard.back: "Back" / "戻る"
wizard.next: "Next" / "次へ"
wizard.create: "Create!" / "作成！"
```

### Security Report (Session G)
```
security.title: "Security Check" / "セキュリティチェック"
security.fix: "Fix" / "修正する"
security.update: "Update" / "アップデート"
security.no_issues: "No issues found" / "問題はありません"
security.severity_critical: "Critical" / "重大"
security.severity_high: "High" / "高"
security.severity_medium: "Medium" / "中"
security.severity_low: "Low" / "低"
```

---

## 付録B: 設計思想との整合性チェック

| 設計原則 | Tier 0 | Tier 1 | Tier 2 |
|---------|--------|--------|--------|
| 非エンジニアファースト | README更新で明示 | 脆弱性を自然言語化 | ステップカード、テンプレートウィザード |
| Termuxの存在を消す | — | — | Click-to-Editはビジュアル操作のみ |
| 5分セットアップ | — | — | テンプレートGalleryで即開始 |
| 壊さない | 互換層付きリファクタ | 既存フック拡張のみ | 新コンポーネント追加のみ |
| 落ちても復帰 | — | savepoint精度向上 | plan-store永続化 |
| Wide=自動、Single=明示 | — | — | Arena: Wideは並列、Singleはスワイプ |
