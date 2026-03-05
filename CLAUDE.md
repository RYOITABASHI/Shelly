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

## ディレクトリ構成

```
Shelly/
├── app/
│   ├── _layout.tsx          # ルートレイアウト（GestureHandler, SafeArea）
│   ├── index.tsx             # (tabs)へのリダイレクト
│   └── (tabs)/
│       ├── _layout.tsx       # タブレイアウト（8タブ + マルチペイン + コマンドパレット）
│       ├── index.tsx         # メインターミナル画面（600行超）
│       ├── tty.tsx           # ttyd WebViewターミナル
│       ├── snippets.tsx      # スニペット管理
│       ├── creator.tsx       # AIプロジェクト生成
│       ├── browser.tsx       # 内蔵ブラウザ
│       ├── obsidian.tsx      # ナレッジベース
│       ├── search.tsx        # 履歴検索
│       └── settings.tsx      # 設定画面
├── components/
│   ├── terminal/
│   │   ├── TerminalHeader.tsx    # ヘッダー（セッション管理 + 接続状態 + マルチペイン切り替え）
│   │   ├── BlockList.tsx         # ブロック一覧表示
│   │   └── FullscreenTerminal.tsx
│   ├── input/
│   │   ├── CommandInput.tsx      # コマンド入力（音声入力 + 画像添付 + オートコンプリート）
│   │   ├── ShortcutBar.tsx       # Ctrl/Esc/Tab等のショートカットバー
│   │   └── AutocompleteDropdown.tsx
│   ├── multi-pane/
│   │   ├── MultiPaneContainer.tsx  # マルチペインのコンテナ
│   │   ├── PaneSlot.tsx            # 各ペイン（ヘッダー + コンテンツ + セレクタ）
│   │   ├── PaneSelector.tsx        # タブ切り替えモーダル
│   │   └── pane-registry.ts        # ペインのコンポーネント登録
│   ├── CommandPalette.tsx     # Ctrl+Shift+P コマンドパレット
│   ├── QuickTerminal.tsx      # ドロップダウンターミナル
│   ├── Onboarding.tsx         # 初回起動チュートリアル
│   └── SetupWizard.tsx        # Termuxセットアップウィザード（スキップ可能）
├── lib/
│   ├── input-router.ts        # 4層入力ルーティング
│   ├── local-llm.ts           # ローカルLLMオーケストレーション
│   ├── llm-interpreter.ts     # コマンド出力のAI解釈
│   ├── project-context.ts     # プロジェクトコンテキスト自動生成（.shelly/context.md）
│   ├── user-profile.ts        # ユーザープロファイル自動学習
│   ├── command-safety.ts      # コマンド安全チェック（5段階）
│   ├── git-assistant.ts       # @git 自然言語Gitガイド
│   ├── gemini.ts              # Gemini API統合
│   ├── perplexity.ts          # Perplexity API統合
│   ├── team-roundtable.ts     # @team マルチAI並列実行
│   ├── theme-engine.ts        # テーマエンジン（30トークン）
│   ├── sounds.ts              # サウンドシステム（14種）
│   ├── keybindings.ts         # キーバインド設定
│   ├── accessibility.ts       # アクセシビリティ
│   ├── obsidian-rag.ts        # Obsidian RAG
│   ├── plugin-api.ts          # プラグインシステム
│   ├── creator-engine.ts      # プロジェクト生成エンジン
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

### 未完了・リマインド

1. **⚠️ OSS公開前に必ず戻す**: `lib/i18n/index.ts` の `detectLocale()` catchブロックで SSRフォールバックを `'ja'` → `'en'` に変更する必要あり（一時的に日本語デフォルトにしている）

2. **APKビルド確認**: GitHub Actionsワークフロー（`.github/workflows/build-android.yml`）で実機確認が必要。Expo Webではスケール・SafeArea・Fold開閉の挙動が正しく再現できない

3. **ファイル重複の注意**: シンボリックリンクをコピーで置き換えたため、ルート直下とサブディレクトリ（例: `local-llm.ts` と `lib/local-llm.ts`）に同じファイルが存在する場合がある。`app/(tabs)/`内のimportは`@/lib/`を参照するため、`lib/`配下が正。ルート直下のファイルは参照されない可能性あり

4. **⚠️ ブリッジサーバーのセットアップバグ**: SetupWizardのインストールコマンドが `mkdir -p ~/shelly-bridge` しか実行せず、`server.js` をコピー/生成していない。ユーザーが `node ~/shelly-bridge/server.js` を実行すると `MODULE_NOT_FOUND` エラーになる。修正方法: セットアップコマンドで `server.js` を `~/shelly-bridge/` に配置するか、`lib/bridge-bundle.ts` にサーバーコードを埋め込んでセットアップ時に書き出す仕組みにする。暫定対応: `cp ~/Shelly/server.js ~/shelly-bridge/server.js`

5. **⚠️ セットアップUX全体の改善が必要**:
   - ブリッジ + llama-server の2つを起動する必要があるが、ユーザーにとって手順が分かりづらい
   - ポート競合時のエラー（EADDRINUSE）がユーザーフレンドリーでない
   - 理想: SetupWizardでワンタップで全部起動できるようにする（tmuxセッション自動作成、ブリッジ+LLMサーバー同時起動）
   - もしくは: ブリッジサーバーにllama-serverのプロセス管理機能を統合して、1コマンドで全部起動
   - 最低限: セットアップ手順にtmuxの使い方、ポート競合時の対処法（`pkill -f "node.*server.js"`）を明記

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
