# Shelly — CLAUDE.md

このファイルはClaude Codeがプロジェクトを理解するためのコンテキストです。
Shelly上のTermuxからClaude Codeを起動した際にも自動で読み込まれます。

---

## プロジェクト概要

**Shelly** はAI搭載のAndroidターミナルIDE。Samsung Galaxy Z Fold6上で、Termux + Claude Codeを使って開発されている。

- **技術スタック**: Expo 54 / React Native 0.81 / TypeScript (strict)
- **UI**: NativeWind (TailwindCSS 3)
- **状態管理**: Zustand
- **API**: tRPC + TanStack React Query
- **パッケージマネージャ**: pnpm 9.12
- **ナビゲーション**: expo-router v6（ファイルベース）
- **アニメーション**: React Native Reanimated v4
- **i18n**: expo-localization + Zustand（日英対応）

詳細な技術仕様は `PRESENTATION.md` を参照。

---

## タブ構成（v5.1）

| 順 | タブ | 役割 |
|----|------|------|
| 1 | **Projects** | プロジェクト一覧 + チャット履歴 |
| 2 | **Chat** | メイン画面。AI/CLI実行をチャット風に描画 |
| 3 | **Terminal** | TTY生ターミナル（日本語入力対応） |
| 4 | **Settings** | 設定 + スニペット + Obsidian + バックアップ |

※ Browser タブは廃止済み（2026-03-19）。URLはシステムブラウザで開く。
※ Workflow Editor/Runner は廃止済み（Snippetsで代替）。

## ディレクトリ構成

```
Shelly/
├── app/
│   ├── _layout.tsx          # ルートレイアウト（GestureHandler, SafeArea）
│   ├── index.tsx             # (tabs)へのリダイレクト
│   └── (tabs)/
│       ├── _layout.tsx       # タブレイアウト（4タブ）
│       ├── index.tsx         # Chatタブ（メイン画面）
│       ├── projects.tsx      # Projectsタブ（プロジェクト + 履歴）
│       ├── terminal.tsx      # Terminalタブ（TTY生ターミナル）
│       └── settings.tsx      # 設定画面
├── components/
│   ├── chat/
│   │   ├── ChatBubble.tsx        # ユーザー/AIバブルコンポーネント
│   │   ├── ChatInput.tsx         # GPT風入力欄（音声入力 + 画像添付）
│   │   ├── CommandExecBubble.tsx  # コマンド実行結果バブル（折りたたみ対応）
│   │   └── ChatHeader.tsx        # ヘッダー（接続状態 + Terminalショートカット）
│   ├── projects/
│   │   ├── ProjectList.tsx       # プロジェクト一覧
│   │   ├── ChatHistory.tsx       # チャット履歴（検索付き）
│   │   └── ProjectCard.tsx       # プロジェクトカード（フォルダ + メッセージ数）
│   ├── terminal/
│   │   ├── TerminalHeader.tsx    # ヘッダー（接続状態）
│   │   ├── ShortcutBar.tsx       # Ctrl/Esc/Tab等のショートカットバー（Terminalタブ専用）
│   │   └── FullscreenTerminal.tsx
│   ├── multi-pane/
│   │   ├── MultiPaneContainer.tsx  # マルチペインのコンテナ（ワイド画面用）
│   │   ├── PaneSlot.tsx            # 各ペイン
│   │   └── pane-registry.ts        # ペインのコンポーネント登録
│   ├── CommandPalette.tsx     # Ctrl+Shift+P コマンドパレット
│   ├── Onboarding.tsx         # 初回起動チュートリアル
│   └── SetupWizard.tsx        # Termuxセットアップウィザード（2択分岐 + 5ステップ）
├── lib/
│   ├── input-router.ts        # 4層+4.5層入力ルーティング（軽量タスク直送）
│   ├── intent-router.ts       # LLMベースインテント分類（ローカルLLM経由）
│   ├── local-llm.ts           # ローカルLLMオーケストレーション（Pro機能）
│   ├── groq.ts                # Groq API統合（チャット + Whisper文字起こし）（Pro機能）
│   ├── gemini.ts              # Gemini API統合（Pro機能）
│   ├── perplexity.ts          # Perplexity API統合（Pro機能）
│   ├── pro.ts                 # Pro/Free機能フラグ（ビルドタイム + ランタイム）
│   ├── secure-store.ts        # APIキー暗号化保存（expo-secure-store）
│   ├── llm-interpreter.ts     # コマンド出力のAI解釈
│   ├── cli-runner.ts          # Claude Code / Gemini CLI実行
│   ├── cli-auth.ts            # CLIツール認証管理
│   ├── project-context.ts     # プロジェクトコンテキスト自動生成
│   ├── user-profile.ts        # ユーザープロファイル自動学習
│   ├── command-safety.ts      # コマンド安全チェック（5段階）+ リカバリ提案
│   ├── git-assistant.ts       # @git 自然言語Gitガイド
│   ├── auto-setup.ts          # SetupWizardオーケストレーター
│   ├── theme-engine.ts        # テーマエンジン（30トークン）
│   ├── sounds.ts              # サウンドシステム（14種）
│   ├── creator-engine.ts      # プロジェクト生成エンジン
│   ├── obsidian-collector.ts  # Obsidian論文/記事収集
│   └── i18n/
│       ├── index.ts           # i18nエンジン（Zustand + expo-localization）
│       └── locales/
│           ├── en.ts          # 英語（ベース）
│           └── ja.ts          # 日本語
├── store/
│   ├── terminal-store.ts      # メインZustandストア（設定 + セッション + LLM設定）
│   └── types.ts               # AppSettings型定義
├── hooks/
│   ├── use-device-layout.ts   # レスポンシブレイアウト（compact/standard/wide）
│   ├── use-termux-bridge.ts   # Termux WebSocket接続
│   ├── use-multi-pane.ts      # マルチペイン状態管理
│   ├── use-command-palette.ts
│   ├── use-quick-terminal.ts
│   ├── use-theme.ts
│   ├── use-motion.ts          # アニメーションプリセット
│   └── use-speech-input.ts    # 音声入力
├── .shelly/                   # 自動生成コンテキスト（gitignore済み）
├── .github/workflows/
│   └── build-android.yml      # GitHub Actions APKビルド
├── PRESENTATION.md            # 詳細技術ドキュメント
└── CLAUDE.md                  # このファイル
```

---

## レスポンシブデザイン方針

### ブレークポイント（`hooks/use-device-layout.ts`）

| 区分 | 幅 | 対象デバイス | マルチペイン |
|------|-----|-------------|-------------|
| Compact | < 380dp | Z Fold6カバー、小型スマホ | 無効 |
| Standard | 380-599dp | 一般スマホ | 無効 |
| Wide | >= 600dp | タブレット、Z Fold6展開、デスクトップ | 有効 |

### マルチペイン

- **ワイド画面のみ**で利用可能（コマンドパレット、ヘッダーボタン、キーボードショートカット全て`isWide`でガード）
- ペインが1つ以下になったら自動でシングルペインに戻る
- ペイン追加は各ペインヘッダーの「+」ボタンから（右端の専用カラムは廃止済み）
- ヘッダーの↗ボタンがワイド画面ではマルチペイントグルに変化

### 重要な設計判断
- **サブ画面（Z Fold6カバー ≒ 一般スマホ）をベースUI**として設計
- ワイド画面は追加機能（マルチペイン）を提供するだけで、基本UIは同一
- スプリットレイアウト（自動2画面分割）は廃止済み。マルチペインはユーザーの明示的操作のみ

---

## Architecture Decisions (変更時は必ず更新)

| 判断 | 理由 | 影響範囲 |
|------|------|----------|
| localLlmModel はファイル名ベース | カタログ ID だと llama-server API の model 名と不一致 | terminal-store.ts, settings.tsx |
| 推奨モデル = Gemma 3 4B Q4_K_M | 3-4B で日本語最強、Z Fold6 RAM 12GB で余裕 | llamacpp-setup.ts |
| サウンドは Web Audio + expo-audio WAV | SoundPool 代替、ネイティブ依存なし | sounds.ts |
| セッション復元は AsyncStorage | blocks/entries を JSON、最新 50 件に制限 | terminal-store.ts |
| テーマ 30 種 | 6 種では選択肢不足 | theme-engine.ts |
| Bridge 経由で Termux コマンド実行 | WebSocket で shelly-bridge/server.js に接続 | use-termux-bridge.ts |
| handleSelectModel でファイル名保存 | model.id ではなく filename.replace('.gguf','') を localLlmModel に | settings.tsx |
| 推奨モデルをカタログで初期展開 | ダウンロードボタンがすぐ見えるように | LlamaCppSection.tsx |
| Groq = デフォルトチャットプロバイダ | 1,000回/日無料、爆速、日本語○ | groq.ts, use-ai-dispatch.ts |
| チャットルーティング: Groq > Local LLM > Gemini | Groqが最速。オフライン時はローカルLLMにフォールバック | index.tsx, use-ai-dispatch.ts |
| APIキーはexpo-secure-storeで暗号化保存 | AsyncStorageに平文保存しない | secure-store.ts |
| APIキーはヘッダーで送信（URLパラメータ禁止） | セキュリティ: ログ/キャッシュへの漏洩防止 | gemini.ts, groq.ts |
| Pro/Free = ビルドタイムフラグ（SHELLY_PRO env） | ソース全公開、フラグで制御。アンロック可能でも構わない | pro.ts, app.config.ts |
| Pro機能: API統合, Local LLM, MCP, @team, Obsidian | CLIベースの基本機能は無料 | settings.tsx (ProGate) |
| Browser タブ廃止 | WebViewはシステムブラウザに勝てない | 2026-03-19 削除 |
| Workflow Editor 廃止 | Snippetsで代替可能 | 2026-03-19 削除 |
| クロスペインインテリジェンス: 出力キャプチャ | WebView onMessage + xterm.js buffer観察 (baseY+cursorY) | terminal.tsx, execution-log-store.ts |
| クロスペインインテリジェンス: ターミナル参照検出 | input-router.ts内で正規表現マッチ（日英8パターン） | input-router.ts |
| クロスペインインテリジェンス: 出力注入方式 | Local LLM=customCtx内、外部API=ユーザーメッセージ末尾 | use-ai-dispatch.ts |
| クロスペインインテリジェンス: 有効条件 | Wide=常時注入、Single=パターンマッチ時のみ、空=フォールバック | use-ai-dispatch.ts, index.tsx |
| ActionBlock | ChatBubble内でコードブロック分割レンダリング。ストリーミング中はパース不可のため完了後のみ | ChatBubble.tsx, parse-code-blocks.ts |
| ActionBlock実行方式 | Wide=Terminal送信、Single=Bridge裏実行 | ActionBlock.tsx |
| インテント別プロンプト | reference/second-opinion/session-summaryで異なるAIシステムプロンプト | input-router.ts, use-ai-dispatch.ts |
| リアルタイム翻訳 | Chat上部オーバーレイ（履歴汚さない）。1sデバウンス、10s自動消去 | TranslateOverlay.tsx |
| LLMフォールバック | Cerebras→Groq→Local LLM（速度順）。Gemini CLIはBridge依存のため将来対応 | realtime-translate.ts |

---

## 最近の変更履歴（2026-03-05セッション）

### 実施済み

1. **シンボリックリンク修復**: `app/(tabs)/`, `store/`, `lib/`, `components/`, `hooks/` 配下の54ファイルが旧パス（`~/ghostty-app/`）へのデッドリンクだったのを実ファイルコピーで修復

2. **react-compiler-runtime追加**: Metro bundlerエラー修正。`pnpm add react-compiler-runtime@19.0.0-beta-8a03594-20241020`

3. **i18n Web対応**: `expo-localization`がSSR/Webで動かない問題。`navigator.languages`チェックを追加

4. **SetupWizardにスキップ追加**: ブリッジ未接続でも先に進めるように

5. **レスポンシブ設計の全面改修**:
   - `use-device-layout.ts`: Z Fold6固有判定 → 幅ベースのレスポンシブに変更
   - `isFoldInner`/`isFoldOuter` → `isWide`/`isCompact`（後方互換エイリアスあり）
   - スプリットレイアウト（`index.tsx`の自動2画面分割）を削除
   - FABボタン（右下の緑丸）を廃止 → ヘッダーに統合
   - MultiPaneContainerの右端「+Add」カラムを廃止 → PaneSlotヘッダーに「+」統合
   - ペイン1つ以下で自動マルチペイン解除

6. **プロジェクトコンテキスト自動生成**（`lib/project-context.ts`）: プロジェクトディレクトリの`.shelly/context.md`を自動生成し、LLMシステムプロンプトに注入

7. **ユーザープロファイル自動学習**（`lib/user-profile.ts`）: コマンド使用頻度、AIエージェント使用傾向、スキル検出、事実抽出を自動で学習

### 2026-03-06 マルチエージェントフィードバック反映

1. **軽量タスクルーティング（Layer 4.5）**: `lib/input-router.ts` に `LIGHTWEIGHT_PATTERNS`（10パターン）追加。「ファイル一覧」「今どこ」等の自然言語をAPI不要でシェルコマンドに直送
2. **Git Assistant簡略化**: `lib/git-assistant.ts` の16インテント → 5コア（commit/push/status/diff/help）に集約。それ以外はLLM委譲ガイドを表示
3. **SetupWizard 2択分岐**: `components/SetupWizard.tsx` に「おすすめ構成」vs「カスタム構成」のモード選択画面を追加。おすすめ = Gemini CLIデフォルト + AI選択ステップをスキップ
4. **Creatorタスクテンプレート**: `components/creator/CommandLane.tsx` に4テンプレート（Node API / 静的サイト / CLIツール / Python Script）のワンタップ生成カード追加
5. **コマンド安全リカバリ提案**: `lib/command-safety.ts` に `getRecoverySuggestion()` 追加。rm/git reset --hard/force push/chmod 777/DROP TABLE後の復旧手順を提示
6. **設定画面の上級トグル**: `app/(tabs)/settings.tsx` に「上級設定を表示/閉じる」トグル追加。Termux Bridge / Local LLM / API設定等を折りたたみ
7. **AIエラーブロック**: `components/terminal/AiBlock.tsx` にリトライ/別AIに聞くアクションボタン追加
8. **@team UI改善**: `app/(tabs)/index.tsx` でファシリテーターまとめを先頭表示、個別回答を後に配置

### 2026-03-19 OSS公開準備セッション

1. **セキュリティ修正**: Gemini APIキーをURLクエリパラメータからヘッダー（`x-goog-api-key`）に移行。対象: use-speech-input.ts, use-voice-chat.ts, obsidian-collector.ts
2. **Groq API統合**: `lib/groq.ts` 新規作成。チャット（Llama 3.3 70B, SSEストリーミング）+ Whisper音声文字起こし。APIキーはSecureStoreで暗号化保存
3. **ウィザード改善**: SetupWizard完了画面でCLI検出（bridge WebSocket経由）。未検出時はGemini CLIワンタップインストール+自動AuthWizard起動
4. **Pro/Freeフラグ**: `lib/pro.ts` でビルドタイム判定（`SHELLY_PRO` env）。設定画面のPro機能セクションをProGateでグレーアウト+ロックアイコン
5. **Groqチャットディスパッチ**: `use-ai-dispatch.ts` にGroqブランチ追加。ネットワークエラー時はローカルLLMに自動フォールバック
6. **コード削除（-6,812行）**: Browserタブ, Workflow Editor/Runner, 14テストファイル, パッチスクリプト, 旧server.js, 未使用lib（hint-tracker, log-export, snippet-share, obsidian-rag）
7. **設定画面i18n完全化**: 全セクションヘッダー・ラベル・説明文をt()キーに置き換え。日本語翻訳追加。中高生でも使えるUI
8. **TypeScriptエラー全解消**: AuthWizard（oauthRunning prop）、ExecutionLogPanel（unreadCount）、app.config.ts（usesCleartextTraffic型）

### 2026-03-21 SetupWizard根本修正 + 全体点検

1. **SetupWizard 2フェーズ分離**: fire-and-forget祈りを排除。Phase 1はRUN_COMMANDで`&&`チェインの一括送信+WebSocket接続ポーリング（最大5分）。Phase 2はbridge WebSocket経由で全残作業を結果確認付きで実行
2. **`ws`パッケージ問題解消**: Phase 1のコマンドに`npm install ws`を含めて確実にインストール
3. **Termux:Tasker依存除去**: RUN_COMMANDはTermux本体のServiceで動作。Taskerをインストール一覧から削除
4. **BridgeRecoveryBanner**: 全タブ上部に切断時の復帰バナー表示（Termux再起動コマンドコピー+再接続+dismiss）
5. **Gemini CLIパッケージ名修正**: `@anthropic-ai/gemini-cli` → `@google/gemini-cli`
6. **AndroidManifest**: `com.termux.permission.RUN_COMMAND` + `<queries>` 追加
7. **全体点検（16件修正）**: AuthWizard正規表現、安全ダイアログPromise未処理、設定ロード/保存、LLMテストnull、APIキーマスク、sedエスケープ、ストリーミング復元、デモモード判定簡素化、コマンド履歴メモリ等
8. **設計書**: `docs/superpowers/specs/2026-03-21-setup-wizard-bridge-fix-design.md`
9. **実装計画**: `docs/superpowers/plans/2026-03-21-setup-wizard-bridge-fix.md`

### 2026-03-25 整理セッション

1. **キーボード修正**: edge-to-edgeモードでKeyboardAvoidingViewが効かない問題を修正。Keyboardイベントで手動paddingBottom適用。windowSoftInputMode=adjustResizeも明示設定。実機確認済み
2. **死コード削除（-3,029行）**: 隠しタブ4つ（creator/snippets/obsidian/search）のファイル削除。_layout.tsx、pane-registry、CommandPaletteからの参照も除去
3. **設定画面整理**: MCP設定削除（Excluded by Designとの矛盾解消）、ガラス背景を高度な設定に移動、テーマ統合（Engine themes 1箇所に）、snippet/creator export/import削除。Obsidian設定は高度な設定内に残した（ユーザー要望）
4. **README修正**: Cross-Pane Intelligence → Coming Soon、Creator engine/Obsidian RAG/Snippets をfeatureから除外
5. **TerminalBlock修正**: Browser廃止に伴いLinkingでシステムブラウザに遷移するよう修正

### 未完了・リマインド

1. **Settings画面から上級者向けCI設定**: ActionsWizardBubbleをSettings内から起動可能にする
2. **OSS用デモスクショ・動画撮影**: 英語UI、全修正ビルドで撮影。台本はClaude別セッションで作成予定
3. **i18n構造の単純化**: en.tsをベース、ja.tsは差分のみに

---

## ★ Cross-Pane Intelligence（実装済み）

**仕様書**: `docs/superpowers/specs/2026-03-23-cross-pane-intelligence-design.md`

### 実装状況（全8フェーズ完了）

| Phase | 内容 | 状態 | 主要ファイル |
|-------|------|------|------------|
| 1 | Terminal整理（純粋TTYのみに） | ✅ | `app/(tabs)/terminal.tsx` |
| 2 | 出力キャプチャ（ttyd WebView → hotBuffer 100行 + sessionBuffer 1000行） | ✅ | `store/execution-log-store.ts`, `terminal.tsx` |
| 3 | クロスペイン参照検出 + 全AIプロバイダー注入 | ✅ | `lib/input-router.ts`, `hooks/use-ai-dispatch.ts` |
| 4 | ActionBlock（コードブロックに[▶ 実行]ボタン） | ✅ | `lib/parse-code-blocks.ts`, `components/chat/ActionBlock.tsx`, `ChatBubble.tsx` |
| 5 | CLI Co-Pilot（リアルタイム翻訳・承認プロンプト） | ✅ | `lib/realtime-translate.ts`, `components/chat/TranslateOverlay.tsx` |
| 6 | 「Terminalで開く」ボタン | ✅ | `components/chat/ChatBubble.tsx` |
| 7 | 機能整理（Quick Terminal非表示、LLM interpreter/ShortcutBarトグル） | ✅ | `app/(tabs)/_layout.tsx`, `settings.tsx` |
| 8 | ドキュメント更新 | ✅ | `README.md`, `CLAUDE.md` |

### GitHub連携（Phase 1-5 実装済み）

| Phase | 内容 | 状態 | 主要ファイル |
|-------|------|------|------------|
| 1 | Git Advisor（push提案ロジック） | ✅ | `lib/git-advisor.ts` |
| 2 | PAT認証（SecureStore保存） | ✅ | `lib/github-auth.ts` |
| 3 | Push処理（リポジトリ作成+push） | ✅ | `lib/github-push.ts` |
| 4 | 自動チェック提案 + 上級者ウィザード | ✅ | 下記参照 |
| 5 | i18n | ✅ | `en.ts`, `ja.ts` |

### Phase 4: 自動チェック（GitHub Actions）

**設計思想**: 「CI」「ビルド」「ワークフロー」等の用語は使わない。ゼロ状態ユーザーにも自然に理解できる言葉で案内。

**2層構造:**
- **初心者向け**: `AutoCheckProposalBubble` — push成功後にワンタップ提案（デフォルトbuild+test on push）
- **上級者向け**: `ActionsWizardBubble` — 3ステップウィザード（Settings画面から起動、未統合）

**フロー（ゼロ状態ユーザー）:**
```
git push 成功
  → 800ms後にプロアクティブ提案バブル表示
  → 「コードを自動チェックする機能、つける？」
     [つける]  [あとで]
  → ワンタップでbuild+test workflow生成 → commit+push
  → 「自動チェックをオンにしました！」
  → 以後、push時にGitHub Actionsが実行される
```

**主要ファイル:**
- `components/chat/AutoCheckProposalBubble.tsx` — ワンタップ提案UI
- `components/chat/ActionsWizardBubble.tsx` — 上級者向け3ステップUI
- `lib/github-actions.ts` — `generateWorkflowFromWizard()`, `commitAndPushWorkflow()`, `detectProjectTypeFromDir()`
- `store/chat-store.ts` — `AutoCheckState`, `ActionsWizardData`, `WizardType` 型定義
- `app/(tabs)/index.tsx` — push成功検出、提案挿入、Enable/Dismissハンドラ

**ワークフロー結果通知（v1.0）:**
- push成功後、CI設定済みなら `pollWorkflowResult()` を開始（90秒待機 → 15秒間隔 × 最大10回）
- 完了検知 → 「✅ チェック通りました」/ 「❌ 問題が見つかりました [詳しく見る]」をチャットに表示
- ポーリング中は「コードをチェック中...」ストリーミング表示

### アーキテクチャ（Cross-Pane）
- **出力キャプチャ**: WebView onMessage + xterm.js buffer観察 (baseY+cursorY)、500msポーリング
- **ターミナル参照検出**: `getTerminalIntent()` — reference/second-opinion/session-summary の3インテント
- **注入方式**: `getTerminalContextForPrompt()` — Wide=常時、Single=パターンマッチ時のみ
- **ActionBlock**: ChatBubble内でコードブロック分離レンダリング。ストリーミング完了後のみパース
- **リアルタイム翻訳**: Cerebras→Groq→Local LLMフォールバック。1sデバウンス、10s自動消去

---

## 開発ルール

- **言語**: コード内コメント・変数名は英語、UIテキストはi18nキー経由、コミットメッセージは英語
- **状態管理**: 新しい状態はZustand storeに追加。React stateはコンポーネントローカルのみ
- **テーマ**: ハードコードの色は使わない。`useTheme()`の`colors`オブジェクトを使用
- **アニメーション**: `useReducedMotion()`を尊重。`SPRING_CONFIGS`/`TIMING_CONFIGS`を使用
- **i18n**: 新しいUI文字列は`en.ts`と`ja.ts`の両方にキーを追加
- **安全性**: `lib/command-safety.ts`のパターンを更新する場合はCRITICALレベルのテストを実施

---

## ビルド & デプロイ

```bash
# ローカル開発（Web）
pnpm start --web

# APKビルド（GitHub Actions）
git add . && git commit -m "description" && git push
# → .github/workflows/build-android.yml が自動実行
# → gh run list で確認、gh run download でAPK取得

# EAS Build（代替）
npx eas build --platform android --profile preview
```

**GitHub**: https://github.com/RYOITABASHI/Shelly
**EAS Project ID**: `e0d124cb-e18f-46c4-aca2-e19e48ba04fc`

---

## Termux環境の注意事項

Claude Codeの`cli.js`が`/tmp/claude`をハードコードしているため、Termuxでは以下が必要：

```bash
sed -i "s|/tmp/claude|/data/data/com.termux/files/usr/tmp/claude|g" \
  /data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js
mkdir -p /data/data/com.termux/files/usr/tmp/claude
```

Claude Codeアップデート時に再度実行が必要。
