# Shelly — CLAUDE.md

このファイルはClaude Codeがプロジェクトを理解するためのコンテキストです。

## ⚠️ セッション開始時に必ず読むもの

**[docs/superpowers/DEFERRED.md](./docs/superpowers/DEFERRED.md)** — 後回しリストの唯一の真実の情報源。

このファイルには「将来実装する」「次リリースで対応」「意図的に descope した」と判断されたすべての項目が、理由と優先度 (P0/P1/P2/P3) 付きで登録されている。過去に README との不整合や機能取りこぼしが発生した反省から 2026-04-14 に導入。

**ルール**:
- 口頭の「あとでね」「後でやろう」禁止 — すべて DEFERRED.md に追加する
- リリース作業前に P0 が空か必ず確認
- 新機能を descope するときは README Status 表と DEFERRED.md の両方を同期

---

## プロジェクト概要

**Shelly** はAI搭載のAndroidターミナルIDE。Samsung Galaxy Z Fold6上で開発されている。

- **技術スタック**: Expo 54 / React Native 0.81 / TypeScript (strict)
- **UI**: NativeWind (TailwindCSS 3)
- **状態管理**: Zustand
- **パッケージマネージャ**: pnpm
- **ナビゲーション**: expo-router v6（ファイルベース）
- **アニメーション**: React Native Reanimated v4
- **i18n**: expo-localization + Zustand（日英対応）
- **Bundle ID**: `dev.shelly.terminal`
- **PTY**: JNI forkpty（`modules/terminal-emulator/` — Kotlin + C）。Termux不要
- **バンドルツール**: bash, Node.js, Python 3, git, curl, ssh, sqlite3, rg, jq, tmux, vim, make, less（APK同梱、`LibExtractor`で自動展開）
- **コマンド実行**: `execCommand()` from `hooks/use-native-exec.ts`（JNI fork+exec+pipe）
- **APIキー**: `lib/secure-store.ts`（expo-secure-store暗号化保存）
- **設定**: ConfigTUI（歯車ボタン or `shelly config`）— 設定タブは廃止済み
- **Storage**: `MANAGE_EXTERNAL_STORAGE` を取得して `/sdcard` 直接読み書き（bug #92）。初回起動時に `lib/first-launch-setup.ts` が Intent 経由で権限を要求
- **Paste 経路**: すべてのペースト（IME commitText / middle-click / CommandKeyBar Paste）は `TerminalView.pasteViaEmulator()` に集約、最終的に `TerminalEmulator.paste()` で bracketed-paste（`\e[200~..\e[201~`）wrap（bug #91 / #94）
- **Codex CLI**: 静的リンク ET_EXEC バイナリは Alpine minirootfs + proot wrapper 経由で起動。`codex.js` の `spawn()` は bashrc post-install の sed patch で `proot` 経由に書き換え（bug #76 / #95）
- **bash wrapper**: `$HOME/bin/bash` に linker64 経由の shim を配置して `bash script.sh` や `#!/usr/bin/env bash` shebang を動作させる（bug #93）

---

## レイアウト構成（Superset UI v6）

タブ構成は廃止。`app/index.tsx` が `ShellLayout` を直接レンダリングする。

```
ShellLayout
├── AgentBar       (上部) — エージェント状態・通知・グローバルアクション
├── Sidebar        (左)   — Tasks / Repos / Files / Device / Ports / Profiles
├── PaneContainer  (中央) — ターミナル/AI/ブラウザ/Markdownのペイン群
└── ContextBar     (下部) — cwd・gitブランチ・接続状態
```

**ペインタイプ**: Terminal / AI / Browser / Markdown（always-on、オーバーレイではない）

---

## ディレクトリ構成

```
Shelly/
├── app/
│   ├── _layout.tsx             # ルートレイアウト
│   ├── index.tsx               # ShellLayout を直接レンダリング
│   └── (tabs)/
│       └── terminal.tsx        # Terminalペイン用コンテンツ（他タブは削除済み）
├── components/
│   ├── layout/
│   │   ├── ShellLayout.tsx         # 全体レイアウト（AgentBar+Sidebar+Pane+ContextBar）
│   │   ├── AgentBar.tsx            # 上部バー（エージェント切替+検索+設定）
│   │   ├── Sidebar.tsx             # 左サイドバー（Tasks/Repos/Files/Device/Ports/Profiles）
│   │   ├── SidebarSection.tsx      # アコーディオンセクション
│   │   ├── FileTree.tsx            # ファイルブラウザ
│   │   ├── ContextBar.tsx          # 下部ステータス（cwd・gitブランチ・接続状態）
│   │   └── ProfilesSection.tsx     # SSHプロファイル管理
│   ├── multi-pane/
│   │   ├── MultiPaneContainer.tsx  # ペイングリッド（inline、overlay廃止）
│   │   ├── PaneSlot.tsx            # 各ペインスロット（エージェント色ボーダー+フォーカス）
│   │   └── pane-registry.ts        # Terminal/AI/Browser/Markdownの登録
│   ├── panes/
│   │   ├── AIPane.tsx              # AIチャット+ストリーミング+インラインdiff
│   │   ├── BrowserPane.tsx         # WebView+ブックマーク+バックグラウンドメディア
│   │   ├── MarkdownPane.tsx        # Markdownプレビュー+editボタン
│   │   ├── PaneInputBar.tsx        # 共通入力バー（AI/Browser/Markdownペイン下部）
│   │   ├── InlineDiff.tsx          # diff Accept/Reject UI
│   │   └── VoiceWaveform.tsx       # インライン音声波形
│   ├── terminal/
│   │   ├── TerminalBlock.tsx       # コマンドブロック（インラインコンテンツ対応）
│   │   ├── AutocompletePopup.tsx   # Fig-style補完UI
│   │   ├── RichInputOverlay.tsx    # シンタックスハイライトオーバーレイ
│   │   ├── MarkdownBlock.tsx       # インラインMarkdownレンダラ
│   │   ├── JsonTreeBlock.tsx       # 折りたたみJSON表示
│   │   ├── ImagePreviewBlock.tsx   # インライン画像プレビュー
│   │   ├── TableBlock.tsx          # テーブル表示
│   │   └── LinkContextMenu.tsx     # パス/URL長押しメニュー
│   ├── config/
│   │   └── ConfigTUI.tsx           # 設定ボトムシート（全設定移植済み）
│   ├── CrtOverlay.tsx              # CRTエフェクト（scanlines+phosphor+flicker）
│   ├── ContextHint.tsx             # 行動トリガーヒント
│   ├── CommandPalette.tsx          # コマンドパレット（recent+suggested+search）
│   └── VoiceChat.tsx               # フルスクリーン音声モード
│   # 旧 AuthWizard / WelcomeWizard は廃止。API キーは Settings → API Keys の
│   # inline editor、CLI 認証は bashrc の post-install pipeline が担当。
├── modules/
│   ├── terminal-emulator/          # JNI forkpty ネイティブモジュール
│   │   ├── android/src/main/java/  # Kotlin — TerminalEmulatorModule, LibExtractor, ShellyJNI
│   │   └── android/src/main/jni/   # C — shelly-pty.c (forkpty), shelly-exec.c (exec)
│   └── terminal-view/              # ネイティブターミナルビュー（Kotlin Canvas描画）
├── lib/
│   ├── autocomplete-engine.ts      # Fig-style補完エンジン（fuzzyスコアリング）
│   ├── syntax-highlighter.ts       # シェルコマンドシンタックスハイライト
│   ├── error-pattern-detector.ts   # file:line:col エラーパターン検出
│   ├── content-block-detector.ts   # 出力タイプ判定（markdown/json/image/table）
│   ├── cli-notification.ts         # コマンド完了通知イベント
│   ├── workflow-manager.ts         # `shelly workflow` CRUD
│   ├── ai-pane-context.ts          # AIペインへのターミナルコンテキスト注入
│   ├── feature-catalog.ts          # 167機能カタログ（AI Discovery用）
│   ├── context-hint-manager.ts     # 行動トリガーヒント管理
│   ├── font-manager.ts             # フォント選択（CRT連動）
│   ├── sound-profiles.ts           # Modern/Retro/Silent
│   ├── haptics.ts                  # ハプティクスフィードバック
│   ├── workspace-manager.ts        # リポジトリごとのワークスペース切替
│   ├── local-llm.ts                # ローカルLLMオーケストレーション
│   ├── groq.ts                     # Groq API (SSEストリーミング)
│   ├── gemini.ts                   # Gemini API
│   ├── perplexity.ts               # Perplexity API
│   ├── cli-runner.ts               # CLIツール管理（claude/gemini/codex）
│   ├── cli-auth.ts                 # CLI認証（SecureStore）
│   ├── secure-store.ts             # APIキー暗号化（expo-secure-store）
│   ├── pseudo-shell.ts             # `shelly` コマンドハンドラ
│   ├── command-safety.ts           # コマンド安全チェック（5段階）
│   ├── input-router.ts             # 自然言語→コマンドルーティング
│   ├── theme-engine.ts             # テーマエンジン（30種）
│   ├── debug-logger.ts             # [Shelly][Module] 形式のデバッグログ
│   └── i18n/
│       └── locales/ (en.ts, ja.ts)
├── store/
│   ├── terminal-store.ts      # セッション・ブロック管理
│   ├── settings-store.ts      # アプリ設定
│   ├── pane-store.ts          # ペインフォーカス・エージェントバインド
│   ├── sidebar-store.ts       # サイドバーモード・リポジトリ
│   ├── ai-pane-store.ts       # ペインごとのAI会話
│   ├── browser-store.ts       # ブックマーク
│   ├── cosmetic-store.ts      # CRT・フォント・ハプティクス
│   ├── agent-store.ts         # バックグラウンドエージェント
│   ├── profile-store.ts       # SSHプロファイル
│   ├── workspace-store.ts     # リポジトリごとのワークスペース分離
│   └── workflow-store.ts      # 保存済みワークフロー
├── hooks/
│   ├── use-device-layout.ts      # レスポンシブ（compact/standard/wide）
│   ├── use-native-exec.ts        # execCommand() — JNI経由コマンド実行
│   ├── use-multi-pane.ts         # ペインツリー管理（split/resize/remove）
│   ├── use-autocomplete.ts       # 補完フック（sync+async path/git）
│   ├── use-ai-pane-dispatch.ts   # AIペインストリーミング（Groq/Gemini/Perplexity/Local）
│   ├── use-pane-voice.ts         # ペイン内音声入力
│   ├── use-command-palette.ts    # コマンドパレット状態
│   └── use-speech-input.ts       # 録音+文字起こし
│   # chelly/ (Chat UI) は v0.1.0 で削除、別リポ切り出し予定、git history に保存
├── .github/workflows/
│   └── build-android.yml
└── CLAUDE.md
```

---

## レスポンシブデザイン方針

### ブレークポイント（`hooks/use-device-layout.ts`）

| 区分 | 幅 | 対象デバイス | ペイン数上限 |
|------|-----|-------------|-------------|
| Compact | < 380dp | Z Fold6カバー、小型スマホ | 1 |
| Standard | 380-599dp | 一般スマホ | 1 |
| Wide | >= 600dp | タブレット、Z Fold6展開 | 最大4 |

- **Z Fold6展開（wide）**: 左サイドバー常時表示 + 最大4ペイン分割
- **折りたたみ（standard/compact）**: サイドバー非表示、スワイプでペイン切替
- サブ画面（Z Fold6カバー ≒ 一般スマホ）をベースUIとして設計。ワイド画面は追加機能のみ

---

## Architecture Decisions（変更時は必ず更新）

| 判断 | 理由 | 影響範囲 |
|------|------|----------|
| タブ廃止 → ShellLayout一本化 | ターミナルをプライマリUIとするため | app/index.tsx, ShellLayout.tsx |
| PTYをJNI forkptyに移行 | Termux不要、IPC境界ゼロ | modules/terminal-emulator/ |
| バイナリAPK同梱（LibExtractor） | bash/node/git/python等をAPK内に.soとして同梱、初回起動時に展開 | LibExtractor.kt |
| NativeTerminalView = PTY直結 | ユーザー入力はPTY fd直接。terminal-storeは補助（ブロック記録、cwd追跡） | terminal.tsx, terminal-store.ts |
| execCommand = 別fork+exec | runCommandとは別系統。非インタラクティブコマンド用 | use-native-exec.ts |
| shellyコマンド → pseudo-shell | `shelly config/workflow/voice`等はアプリ内処理 | pseudo-shell.ts |
| 設定タブ廃止 → ConfigTUI | 歯車ボタン or `shelly config`。全設定をボトムシートに集約 | ConfigTUI.tsx |
| APIキーはSecureStore | settings-store.updateSettingsが自動ルーティング | secure-store.ts, settings-store.ts |
| AI PaneルーティングはGroq > Gemini > Perplexity > Local | use-ai-pane-dispatch.tsで分岐 | use-ai-pane-dispatch.ts |
| APIキーは Settings → API Keys の inline editor | Wizard 廃止、SettingsDropdown に 1 行ずつ masked editor を展開 | components/settings/* |
| CLI は bashrc post-install で自動 npm install | HomeInitializer.kt の __shelly_bg_cli_update が 24 時間おきに更新 | HomeInitializer.kt |
| Chat UIはv0.1.0で削除 | 旧 chelly/ は git history に保存。別 repo 切り出し予定 | — |
| デバッグログ全箇所 | `[Shelly][Module]`形式、logcat対応 | debug-logger.ts |
| Paste は単一チョークポイント | `TerminalEmulator.paste()` に全経路を funnel。bracketed-paste は DECSET 無視で常時 wrap。readline の bracketed-paste bind を .bashrc で明示 ON | TerminalView.java, TerminalEmulator.java, HomeInitializer.kt |
| shelly-exec は EAGAIN を retry | select + non-blocking read の spurious wake を EOF と誤認識しない。bug #70 の根治 | shelly-exec.c |
| bash は linker64 経由で libbash.so を起動 | Plan B は `bash` という exec が PATH 外なので `$HOME/bin/bash` の wrapper が必要 | HomeInitializer.kt |
| Codex CLI は Alpine rootfs + proot 経由 | 静的リンク ET_EXEC を Android の mmap_min_addr 制限下で動かすために rootfs をバンドル、proot で chroot | HomeInitializer.kt, assets/alpine-rootfs.tar.gz |
| /sdcard は MANAGE_EXTERNAL_STORAGE | Scoped Storage 回避、初回起動で Intent 経由ユーザー許可 | app.config.ts, TerminalEmulatorModule.kt, first-launch-setup.ts |

---

## デバッグログタグ（logcat フィルタ用）

`adb logcat -s` で使える Shelly 固有の tag 一覧。スモークテストでのトラブルシューティングに使う:

| タグ | 出力元 | 内容 |
|------|--------|------|
| `ShellyPaste` | `TerminalEmulator.paste` / `TerminalView.pasteViaEmulator` | paste 入出力 byte 数、改行数、先頭 32 文字 preview（改行は `↵⏎` に可視化） |
| `ShellyIME` | `TerminalView` IME 経路 | commitText / setComposingText / deleteSurroundingText / finishComposing の全ログ |
| `ShellyExec` | `shelly-exec.c execSubprocess` | 子 PID、exit code、stdout/stderr byte 数、EAGAIN 回数 |
| `ShellyPTY` | `shelly-pty.c createSubprocess` | fork / ptsname / termios 設定結果 |
| `HomeInitializer` | `HomeInitializer.kt` | .bashrc バージョンチェック、rootfs 展開、proot wrapper 作成 |
| `TerminalEmulator` | `TerminalEmulatorModule.kt` | hasAllFilesAccess / requestAllFilesAccess の権限状態遷移 |
| `Sidebar` | `Sidebar.tsx` | tryAddRepo の probe 結果、ghost entry 診断 |
| `Shelly` | `lib/debug-logger.ts` | `logInfo(module, ...)` 経由の汎用 JS ログ |

**典型的な使い方**:

```bash
# ペースト問題を追跡
adb logcat -s ShellyPaste:D ShellyIME:D

# ターミナル起動 / CLI インストール問題
adb logcat -s HomeInitializer:* ShellyPTY:* ShellyExec:*

# /sdcard 権限問題
adb logcat -s TerminalEmulator:* Sidebar:*

# 全部
adb logcat -s ShellyPaste:D ShellyIME:D ShellyExec:D ShellyPTY:D HomeInitializer:D TerminalEmulator:D Sidebar:D Shelly:D
```

---

## Zustand ストア一覧

first-time contributor が最も迷うのは「状態がどこにあるか」。以下がすべてのストア（`store/` ディレクトリ）:

| ストア | 責務 | persist |
|--------|------|---------|
| `terminal-store` | セッションID、ブロック記録、cwd追跡 | ✅ |
| `settings-store` | フォント、テーマ、APIキー（SecureStore連携）、全アプリ設定 | ✅ |
| `pane-store` | フォーカスペインID、エージェントバインド | ✅ |
| `sidebar-store` | サイドバーモード、リポジトリパス一覧 | ✅ |
| `ai-pane-store` | ペインごとのAI会話（メッセージ、ストリーミング状態） | ✅ |
| `browser-store` | ブックマーク、ナビゲーションシグナル | ✅ |
| `cosmetic-store` | CRT、フォント、ハプティクス、サウンドプロファイル | ✅ |
| `agent-store` | バックグラウンドエージェント定義、実行履歴 | ✅ |
| `profile-store` | SSHプロファイル | ✅ |
| `workspace-store` | リポジトリごとのワークスペース分離 | ✅ |
| `snippet-store` | 保存済みスニペット（Command Palette 経由で実行） | ✅ |
| `git-status-store` | dirtyCount（Sidebar/AgentBar badge用、20秒ポーリング） | — |
| `ports-store` | ローカルリスナー一覧（/proc/net/tcp 15秒ポーリング） | — |
| `theme-version-store` | テーマプリセット切替時のkey-remount用カウンタ | — |
| `savepoint-store` | auto-savepoint のコミット履歴 | ✅ |
| `preview-store` | Preview ペインの表示ファイルパス | — |
| `execution-log-store` | コマンド実行ログ | — |
| `arena-store` | Arena モードの比較状態 | — |
| `mcp-store` | MCP サーバー接続状態 | ✅ |
| `plan-store` | AIプランカード | — |
| `usage-store` | API使用量トラッキング | ✅ |
| `chat-store` | 旧チャット画面用（chelly/ 削除後は dead、v0.1.1 で削除予定） | ✅ |

**触る前の確認**: ストアを新設する前に、既存ストアに追加できないか検討すること。20 個は多い。

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

Claude Codeアップデート時に再度実行が必要。v2.1.5以降は `export CLAUDE_CODE_TMPDIR="$HOME/.claude-tmp"` でも対応可。
