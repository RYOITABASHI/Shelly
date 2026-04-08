# 次セッションプロンプト

以下をそのままClaude Codeに貼って。

---

## やること

Shellyの対話型ターミナルセットアップ（`shelly setup`）を設計・実装する。

### 背景

Shellyは Expo/React Native のAndroidターミナルIDE（~/Shelly）。
現在モーダル式のWelcomeWizard（components/WelcomeWizard.tsx）があるが、これを廃止して、ターミナル上で完結する対話型セットアップに置き換える。

### コンセプト

初回起動時にターミナルが表示され、そこに自然言語でCLIセットアップのガイダンスが表示される。ユーザーはタップ可能なボタンで選択肢を選び、ガイダンスに従うだけでCLI導入が完了する。

### 読むべきファイル

1. `memory/shelly-interactive-setup.md` — 設計メモ（フロー、ステップ、条件など全部書いてある）
2. `docs/current-tasks.md` — 現在のタスク状況
3. `CLAUDE.md` — アーキテクチャ全体像
4. `components/WelcomeWizard.tsx` — 現行ウィザード（廃止対象）
5. `lib/pseudo-shell.ts` — shellyコマンドハンドラ（ここに `shelly setup` を追加）
6. `store/terminal-store.ts` — CommandBlock/TerminalEntryの型
7. `components/terminal/TerminalBlock.tsx` — ブロック描画（ActionBlockの仕組みがある）
8. `lib/i18n/locales/en.ts` + `ja.ts` — i18nキー（全テキストをen/ja両方で）
9. `hooks/use-native-exec.ts` — execCommand（npm installに使う）
10. `components/AuthWizard.tsx` — 認証フロー（参考、PTY書き込み+URL検出の実装あり）

### 実装する機能

1. **`shelly setup` コマンド** — pseudo-shellに追加
   - `shelly setup` — フルウィザード
   - `shelly setup cli` — CLIツールのみ
   - `shelly setup git` — Git設定のみ
   - `shelly setup projects` — フォルダ登録のみ

2. **SetupBlock コンポーネント** — CommandBlockの拡張
   - テキスト + タップ可能ボタン（Pressable）を描画
   - ステップごとに新しいブロックが追加される
   - 各ステップの状態管理（Zustand store or ブロック内state）

3. **初回起動フック**
   - `AsyncStorage.getItem('@shelly/setup_complete')` で判定
   - 未完了 → ターミナルに `shelly setup` を自動実行
   - 完了 → 何もしない

4. **セットアップフロー（3ステップ）**
   - Step 1: CLI選択 → npm install → 認証（Claude/Gemini/Codex）
   - Step 2: Git設定（user.name/email、SSH鍵提案）
   - Step 3: プロジェクトフォルダ登録（~/以下スキャン→選択→サイドバー登録）
   - 各ステップにスキップボタン

5. **i18n** — 全テキストを en.ts/ja.ts の両方に追加

6. **ConfigTUIに再実行ボタン** — 歯車 → 「セットアップウィザードを再実行」

### 前提

- PATHにバンドルツールが通っている（Kotlin層でexport PATH=...をコマンドにラップ済み）
  - ただしこの修正がまだ実機で確認できてない。先にexecCommand('echo $PATH')の結果を確認すること
- `execCommand()` from `hooks/use-native-exec.ts` でnpm install等を実行
- `TerminalEmulator.writeToSession()` でPTYにインタラクティブコマンド送信
- `Linking.openURL()` でブラウザ起動
- 設定保存は `store/settings-store.ts` の `updateSettings()`
- APIキーは `lib/secure-store.ts`

### 注意

- まず先にPATH修正が動作するか確認（`execCommand('which node')`のテスト）
- 動かない場合はPATH問題を先に解決すること
- WelcomeWizard.tsxはまだ消さない — 対話型セットアップが完成して動作確認できてから廃止
