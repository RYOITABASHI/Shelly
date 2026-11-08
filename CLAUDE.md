# Shelly — CLAUDE.md

このファイルはClaude Codeがプロジェクトを理解するためのコンテキストです。

## ⚠️ セッション開始時に必ず読むもの

**[docs/superpowers/DEFERRED.md](./docs/superpowers/DEFERRED.md)** — 後回しリストの唯一の真実の情報源。

**2026-07-14: 以下の旧セッション開始時必読ドキュメントは、独立調査（Codex）により全て資料的価値のみと判明したため「必読」から降格した。詳細は各ファイル自体を参照（内容は残置、再開ポインタとしては使わない）:**
- [2026-06-23-local-llm-autostart-handoff.md](./docs/superpowers/specs/2026-06-23-local-llm-autostart-handoff.md) — T1-T3（local-LLM autostart）は `b1dfb133c` 経由で、③エスカレーションラダーは `lib/agent-escalation-ladder.ts`（`d92018aef`）経由で、両方とも既にmain実装済み。旧ブランチ `claude/work-handoff-2qb1xd` は374箇所コンフリクトの陳腐化、rebase価値なしと判定（破棄推奨）。
- [2026-06-27-widget-agent-launch-handoff.md](./docs/superpowers/specs/2026-06-27-widget-agent-launch-handoff.md) — Task B（ウィジェットから登録済みエージェント1タップRUN）は `794cbeb7f`→PR #122 経由で main 実装済み。Task A（入力ショートカット）のみ未実装のままP2継続。
- [2026-06-20-secretary-completion-codex-sprint-handoff.md](./docs/superpowers/specs/2026-06-20-secretary-completion-codex-sprint-handoff.md) — 全チャンク（G1-G6）実装済み・main着地済み（`4ddf45029`/`5d6eb3bb6`/`b8f146b00`/`e5a2856ec`/`db04cc887`/`12873f632`ほか）。Telegram実機検証のみ未了、DEFERRED.mdへ個別追跡。
- [2026-06-17-B2-on-device-verified-HANDOFF.md](./docs/superpowers/specs/2026-06-17-B2-on-device-verified-HANDOFF.md) — 「次は Phase B RN ブリッジ」は `143a65ce0`/`f7230f6ee` 経由で実装・セキュリティ強化済み。`~`パス展開の1点のみ低優先度の残課題としてDEFERRED.mdへ。

**[docs/superpowers/specs/2026-05-14-release-cli-surface-handoff.md](./docs/superpowers/specs/2026-05-14-release-cli-surface-handoff.md)** — 2026-05-14 時点の release surface 引き継ぎ。v5.3.1 は Claude Code CLI / Codex CLI を正式対応、Gemini CLI を Experimental、AI Pane / background を明示的 API provider 経路に整理済み。

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
- **Paste 経路**: すべてのペースト（IME commitText / middle-click / CommandKeyBar Paste）は `TerminalView.pasteViaEmulator()` に集約、`TerminalEmulator.paste()` が DECSET 2004 状態で分岐: (a) bracketed-paste mode 有効 (readline guest) → `\C-x\C-b` (0x18 0x02) + payload + `\e[201~`。`\C-x\C-b` は .bashrc で emacs / vi-insert / vi-command 全 keymap に `bracketed-paste-begin` を bind、END 側の ESC は関数内の直接 read で preserve される。(b) bracketed-paste mode 無効 (vim/less/nano 等 TUI) → `\r?\n → \r` fallback で各行を個別 Enter として送信（bug #91 / #94 / #97）
- **AI CLIs**: **2026-07-15 訂正** — 本行は v5.3.1 時点の記述として書かれたが、`3095aa479`（"chore: remove legacy AI CLI integrations"、2026-05-29）で Claude Code CLI / Gemini CLI・OAuth surface は current main から撤去済み（`HomeInitializer.kt` の `cleanupRemovedCliRuntime()` が起動時に残存 `claude` ランタイムを能動的に削除する）。**現行 main の正式 CLI surface は Codex のみ。** Claude Code CLI の再有効化は `feat/claude-on-device-reenable` ブランチで進行中・未マージ（`claude -p` が deep path で SIGSEGV する既知バグが残っている）。Shelly 管理 updater が staging に取得し、`--version` probe を通したものだけを live/current に昇格する仕組み自体は Codex runtime に対して現役（`~/.shelly-runtime/codex/current` + `$HOME/bin` wrapper）。Gemini CLI は bundle/patched investigation 用の Experimental 扱いで、Worktrees / Quick Launch には出さない。Gemini は AI Pane/background の API provider として使う。**2026-10-31 追記（Claude glibc S1–S4）**: 公式 Claude Code 2.1.314（linux-arm64 glibc、`~/.shelly-runtime/claude-glibc/`、手動ステージング）が `shelly-claude-glibc()` / `claude()`（.bashrc）で動き、S4 でエージェントのワーカー（`ToolChoice {type:'cli', cli:'claude'}`、表示名 Claude Code、MONITOR では CLI＝サブスク）になった。エージェントからは `shelly-agent-driver.js --engine claude` → `bash ~/.shelly-claude-run.sh`（.bashrc と同じ関数を HomeInitializer が毎起動生成）で起動し、ツール使用はすべて Codex と同じゲートで判定する。認証は `ANTHROPIC_API_KEY`（Settings の Anthropic API Key）があれば常にそれ、無ければ有人はログイン中のサブスク、無人は設定 `claudeSubscriptionUnattended`（既定 ON、OFF で拒否）に従う（driver の `claudeAuthPlan()`）。Antigravity（agy）はエージェントのワーカーにせず、Shelly から自動起動しない。実機での agent 実行は未検証（DEFERRED.md「S4」）。CLI ワーカーの一覧は `lib/agent-cli-workers.ts`。**2026-11-02 追記（S3d、BASHRC_VERSION 285、実機未検証）**: Claude は shell snapshot を CLAUDE_CODE_SHELL（mksh）で採るため `set -o noexec` 等が記録され Bash ツールが何も実行しなくなっていた。`shelly-claude-glibc()` が起動前に毒入り snapshot（`~/.claude/shell-snapshots/snapshot-*.sh`）を削除し、claude 生存中は `__shelly_claude_snapshot_scrub` が mksh 由来の snapshot をコメント 1 行に置き換える。HomeInitializer も毎起動で削除（DEFERRED.md「S3d」）。**2026-11-07 追記（`claude-install`、BASHRC_VERSION 289、実機未検証）**: 手動ステージングは不要になった。`claude-install` / `agy-install` / Builds 画面 / 起動時の更新はすべて `scripts/shelly-cli-update.js`（+asset、`$HOME/.shelly-cli-update.js`）。端末が公式配布物を直接取得し、Shelly は再配布しない。Claude は署名付き manifest（固定鍵）→ SHA-256、glibc は Termux の `termux-glibc`（固定鍵 → InRelease → Packages.gz → .deb、gpgv も xz も端末に頼らず node だけで検証・展開）。`~/.shelly-runtime/{claude-glibc,agy}/` は `versions/` `current` `previous` `state.json` `leases/`、`claude` / `antigravity` は `current/` への symlink。`.bashrc` の関数は起動前に `cd -P` で実ディレクトリへ解決するので、更新が実行中の TUI に届かない。Claude は `DISABLE_UPDATES=1`、agy は `AGY_CLI_DISABLE_AUTO_UPDATE=true`。更新は Builds 画面のタップが基本で、起動時の自動更新は Wi-Fi のみ・**このリリースは既定 OFF**（設定 `cliAutoUpdateWifi`、native `isNetworkUnmetered`、実機確認後に ON にする予定、DEFERRED.md）。チャンネル `latest`、導入済みの CLI だけ、6 時間に 1 回まで。**エージェントはレビュー済みの版（`REVIEWED_CLAUDE` = driver の `CLAUDE_AGENT_REVIEWED`、2.1.314、テストで一致を保持）だけ**: `agent-current` を作るのは `claude-install --agent` と、取り込んだ／取得したファイルの SHA-256 がレビュー済みと完全一致したときのみ。更新で動くことはない。driver と `~/.shelly-claude-run.sh` の両方が確認し、無ければ手順を示して拒否する。**agy はどの経路でも実行しない**（確認はハッシュと ELF ヘッダのみ、§5.4）。
- **Local LLM**: 端末単体の常用推奨は Qwen3.5-2B Q4_K_M。重い場合は Qwen3 1.7B Q4_K_M、分類/ルーティング用途は Qwen3.5 0.8B Q4_K_M。4B/9B は短時間の品質確認に限定する。**Bonsai 27B（PrismML、Qwen3.6 27Bベース、1-bit/ternary量子化）は 2026-07-15 に実機評価・却下済み — 詳細は DEFERRED.md 参照。**
- **bash wrapper**: `$HOME/bin/bash` に linker64 経由の shim を配置して `bash -c "…"` や `bash script.sh`（`#!/usr/bin/env bash` shebang付きスクリプト含む）を動作させる（bug #93）。**shebangスクリプトの直接実行（`./script.sh`）はKnoxの`binfmt_script`制限で依然失敗する**（2026-08-17 Fable5実機確認、`/usr/bin/env: bad interpreter: Permission denied` exit 126）— 必ず`bash script.sh`経由で呼ぶこと
- **Terminal pane background**: **2026-08-25 訂正 — 本行は長らく陳腐化していた（2026-08-10 に一度発見されながらドキュメント同期が先送りされ続けた点も含め経緯を残す）。** build 1560–1565 の wallpaper/panel tint グレー化回帰を受け、Terminal pane は当初 opaque black に fail-closed（2026-07-15 早朝 `fb85a0b0c` で a96cdd8a4 由来のバグを再修正）。同日 `61e9bea15`（17:38）で `settings.terminalWallpaperTransparency` という明示オプトイン・トグル（既定 **OFF**）として復元されたが、プロダクトオーナーの直接指示「ターミナルも他のペインと同様に透過させる」を受けた `70ccd1e63`（17:53、既定→true）→ 実機で「白っぽいスモークが残る」との指摘による `85da0d144`（18:20、既定→false）→ その指摘は透過自体の欠陥ではなくネイティブ側の色パレット未更新（`ShellyTerminalView.kt` の transparent-mode 分岐が `mCurrentColors[COLOR_INDEX_BACKGROUND]` を更新していなかった）と切り分けた上でのプロダクトオーナーの明示的な再訂正 `2211047a2`（18:23、既定→**true**、最終確定）と続いた。**現在の HEAD まで `terminalWallpaperTransparency` の既定値は `true` のまま3週間以上変更なし**——Settings の説明文「On by default, matching the other panes」はこの実体と一致しており、矛盾していたのは本 CLAUDE.md の記述の方だった（2026-08-10 Fable5実機②レビュー + CC調査、`docs/superpowers/DEFERRED.md` P1 エントリ「CLAUDE.md「Terminal pane background」節が陳腐化」参照）。ネイティブ色パレットのギャップ自体は解消済みと確認済みだが、`2211047a2` が要求した「first frame/theme apply/new tab/split layout/IME resize/settings modal 背面」6シナリオの実機スクショ証跡は今も未取得（DEFERRED.md P3「Terminal pane wallpaper transparency re-enable」参照、次回オンデバイスQA枠で消化予定）。**この行および `terminalWallpaperTransparency` の既定値を変更する PR は、変更前に DEFERRED.md の該当エントリを読み、上記6シナリオのスクショ証跡を添えること。**

---

## レイアウト構成（Superset UI v6）

タブ構成は廃止。`app/index.tsx` が `ShellLayout` を直接レンダリングする。

```
ShellLayout
├── AgentBar       (上部) — エージェント状態・通知・グローバルアクション
├── Sidebar        (左)   — Tasks / Repos / Files / Device / Profiles
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
│   │   ├── Sidebar.tsx             # 左サイドバー（Tasks/Repos/Files/Device/Profiles）
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
│   │   ├── RichInputOverlay.tsx    # シンタックスハイライトオーバーレイ
│   │   ├── MarkdownBlock.tsx       # インラインMarkdownレンダラ（Block History経由で到達可能）
│   │   ├── JsonTreeBlock.tsx       # 折りたたみJSON表示（Block History経由で到達可能）
│   │   ├── ImagePreviewBlock.tsx   # インライン画像プレビュー（Block History経由で到達可能）
│   │   ├── TableBlock.tsx          # テーブル表示（Block History経由で到達可能）
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
│   └── workflow-store.ts      # 保存済みワークフロー
├── hooks/
│   ├── use-device-layout.ts      # レスポンシブ（compact/standard/wide）
│   ├── use-native-exec.ts        # execCommand() — JNI経由コマンド実行
│   ├── use-multi-pane.ts         # ペインツリー管理（split/resize/remove）
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
| AI Paneルーティングは明示的 API provider のみ | Gemini API / Cerebras / Groq / Perplexity / OpenAI-compatible local を use-ai-pane-dispatch.ts で分岐。（2026-10-30 訂正: 以前ここにあった「Claude Code subscription/CLI は hidden background worker として使わない」はプロダクトオーナーの方針ではなかったため撤回。CLI をエージェントのワーカーとして裏で使うこと自体は禁止しない。Claude Code CLI の端末上での実行可否は DEFERRED.md bug #117 を参照） | use-ai-pane-dispatch.ts, agent-executor.ts |
| APIキーは Settings → API Keys の inline editor | Wizard 廃止、SettingsDropdown に 1 行ずつ masked editor を展開 | components/settings/* |
| CLI の更新は 2 系統: Codex は staging + probe 後に手動で昇格、Claude Code / Antigravity は `shelly-cli-update.js` | **2026-11-07 訂正**: 下の説明は Codex の経路のもの（Claude Code と Antigravity は上の AI CLIs 行を参照）。Codex はCodex のバックグラウンド更新は無効（Builds 画面の `installCodexRuntime()` か `shelly-update-clis` から手動で実行。Builds 画面のシェルと `shelly-runtime-update.js` に同じ処理が重複している）。`~/.shelly-runtime/codex/versions/<版>` に展開し、`--version` 等のプローブを通ったものだけ `current` symlink の rename で昇格する。failed-version cooldown は現行コードに無い。古い版は削除しない。起動側（`codex()`、`$HOME/bin/codex`。driver の `runtimeCodexTuiPath()` は `agent-current`）はリンクを実パスへ解決してから起動するので、実行中の Codex は切り替え後も自分の版の `codex-code-mode-host` を使う（BASHRC_VERSION 286、実機未検証）。Claude Code は `~/.shelly-runtime/claude-glibc/` への手動配置のみ。`Bump Codex Runtime` は公開済みの版が upstream の最初の新しい版から 3 日を超えて遅れると赤くなる（`scripts/check-codex-freeze.js`）。計画は `docs/superpowers/specs/2026-11-07-cli-always-latest-plan.md` | HomeInitializer.kt, shelly-runtime-update.js, BuildsModal.tsx, shelly-agent-driver.js |
| Chat UIはv0.1.0で削除 | 旧 chelly/ は git history に保存。別 repo 切り出し予定 | — |
| デバッグログ全箇所 | `[Shelly][Module]`形式、logcat対応 | debug-logger.ts |
| **`execCommand` は Expo のキューを塞がない（2026-11-07）** | `execSubprocess` はコマンド終了までブロックするので、AsyncFunction のままだと `writeToSession`・`createSession`・承認の返信まで止まる。Coroutine にし、実行は `Dispatchers.IO`。コマンドは従来どおり 1 本ずつ呼び出し順（`ExecLanes` の FIFO セマフォ、許可は Expo のキュー上で取る）。別レーン（2 本まで）に出るのは第 3 引数で `'long'` を指定した呼び出しだけで、CLI インストーラ（`lib/managed-cli-update.ts` の install と auto）に限る。タイムアウト値では判断しない（バックアップの復元も長いが、$HOME を書き換えるので直列のまま）。タイムアウトと kill は従来どおり shelly-exec.c | TerminalEmulatorModule.kt |
| Paste は単一チョークポイント | `TerminalEmulator.paste()` に全経路を funnel。bug #97 で bionic bash の readline dispatch が `\e[200~` の ESC を swallow する問題が発覚 → 入口を ESC-free な `\C-x\C-b` に変更し、.bashrc で emacs/vi-insert/vi-command に `bracketed-paste-begin` を bind。END の `\e[201~` は関数内で直接 read されるため ESC が保持される。DECSET 2004 未設定の TUI (vim/less/nano) には `\r?\n → \r` fallback を適用。line 2649 で ESC と C1 制御文字を strip 済みなので paste 内に literal `\e[201~` が含まれても早期終了の command injection は不可 | TerminalView.java, TerminalEmulator.java, HomeInitializer.kt |
| shelly-exec は EAGAIN を retry | select + non-blocking read の spurious wake を EOF と誤認識しない。bug #70 の根治 | shelly-exec.c |
| **エージェントのファンアウト・サブタスク (`parallelGroup`)**: ブランチのコンテキスト分離・宣言順集約セマンティクスは両 executor 共通、**wall-clock 並列ディスパッチは無人 PlanSpec executor のみ実装済み**（attended TS チェーンは意図的に直列のまま） | Hermes サブエージェント相当の「分解→各サブタスクを同一コンテキストから処理→集約」を、ブランチのコンテキスト分離（兄弟出力をプロンプト/重複検知から遮断）+宣言順集約+最終ステップ除外+`MAX_PARALLEL_BRANCHES=3` cap として両 executor に実装 (2026-08-13)。その後 Increment 1a-1c (2026-08-14) で `shelly-plan-executor.js`（無人 PlanSpec executor）側だけ async `spawn`+in-process semaphore+`Promise.allSettled`による実 wall-clock 並列dispatch・budget file lockを実装し、native `CURRENT_EXECUTOR_VERSION`を2へ同期済み（tsc/Jestレベルで検証済み、on-device検証は継続中）。**2026-10-30 追記: attended の Run now は `lib/agent-attended-route.ts` の判定（有効な並列グループあり・全ステップが executor で実行可能・ディスク上の PlanSpec が現行のこのチェーン）を満たすときだけ、`TerminalEmulator.runAgent` → native `runPlanAgent` 経由で PlanSpec executor に流す（chain lock は取らない・plan は書き換えない・`markUserRunStarted` は保持）。満たさなければ従来どおり直列チェーンで、その直列チェーンも executor と同じ `logs/<id>/progress.jsonl` を書く（`lib/agent-progress-writer.ts`）。**2026-11-01 追記（並列 CLI ステップ Inc3、executor v21、実機未検証）: Codex / Claude Code にピンしたステップも executor ルートに乗る**——ディスク上のステップのピンが同じ CLI、有人ルーターの第一候補もその CLI（明示ピンの CLI は単独実行）、plan に `cliWorker` があり、`plan.tool`（集約・最終ステップ用）は HTTP 系のまま、が条件（判定ログの末尾に `cli=<n>`）。executor は CLI 枝ごとに `shelly-agent-driver.js` を起動し（ゲートは直列と同じ）、CLI 枝どうしを実時間で並列に走らせる（CLI スロット 合計2・エンジンごと1、他エージェントの lock / phantom 余裕が無ければ直列化、Inc2）。RN 側の待ちは native の 30 分上限＋2 分、終了ログ `plan-executor attended run finished status=<s> cliBranches=<n> overlapMs=<n>`、タイムアウト停止は executor のプロセスツリーを事前に採取して残りを KILL。2 つの枝が同時に承認を求めると MONITOR は 2 件並べ、2 件目は `ok <hash8>` で答える（チャットの 2 件目の依頼文も同じ指示）。chain lock / per-agent 単一飛行は不変（`docs/superpowers/specs/2026-11-01-parallel-cli-steps-plan.md`）。** attended TS チェーン（`agent-manager.ts` `runAgentOrchestratedBody`）自体は今も意図的に直列のまま: chain lock の回転 nonce、生成 .sh のグローバル `MAX_CONCURRENT=2`（phantom-process 上限保護）が per-agent 単一飛行を前提にしており、並列化にはその再設計を要する — DEFERRED.md 2026-08-13/2026-08-14 エントリ参照 | agent-orchestration.ts (`planParallelGroups`), agent-manager.ts, shelly-plan-executor.js (+APK asset ミラー), store/types.ts |
| **CLI ワーカーは共通ゲート経由（Codex / Claude Code）** | エージェントの CLI ステップは必ず `shelly-agent-driver.js` を通す。Codex は app-server の承認要求、Claude Code は stream-json + `--permission-prompt-tool stdio` の `can_use_tool` を、どちらも `gateCommandActions()`（gate helper＝command-safety・境界・POLICY-001、署名付き事前承認、無人時は即 decline、有人時は署名付きエスカレーション）で判定する。Claude の Read は `cat -- <path>`、Write/Edit は `tee -- <path>` と同じ判定。ツールは許可リスト（`--tools Bash,Read,Write,Edit`＋既知の他ツールを `--disallowedTools` と settings deny に列挙＋許可外の tool_use を見たら即停止）、`--setting-sources ""`・`ask` ルール・`disableAllHooks`・`--strict-mcp-config` でユーザー設定の allow やフックを効かせない。Codex ワーカーも MCP サーバー・ChatGPT アプリ・プラグインを起動引数で無効化し（`codex mcp list --json` の preflight で全サーバーの無効を確認できなければ起動しない）、`mcpToolCall` や MCP の要求が来たらターンを止めて失敗にする（2026-11-04、ブランチ `fix/codex-worker-mcp-gate`、実機未検証、DEFERRED.md P1）。**2026-11-07 追記（実機未検証）**: Codex の thread item は許可リストで判定する（`codexItemDisposition()`、app-server の ThreadItem 19 種を 0.163 / 0.167 のソースで確認）。ゲート対象でも無害でもない型（未知の型、型なし、sub-agent、`dynamicToolCall`、`imageView`、`hookPrompt`、`functionCallOutput`）はターンを止めて失敗にし、監査行 `codex_item_type_blocked` を残す。`multi_agent` と `view_image` はワーカーで無効。`webSearch` はオーナー決定で承認なしで通す。`imageGeneration` は 2026-11-08 のレビューで外した（画像ツールが承認なしで端末の画像を読んで送れるため、ワーカーでは `image_generation` を無効化し、item が来たら止める。使えるのは下の `--image-only` だけ）。検索は `web_search = "indexed"` で動かし、完了ごとに監査行 `codex_web_search` を残し、既知の秘密や秘密の形式が載っていれば `codexWebSearchLeakCheck` がターンを止める（値はログに残さない）。ワーカーの env から KEY / TOKEN / SECRET を含む名前を落とす（DEFERRED.md P1）。Claude は `system/init` の `tools` を確認し（`claudeInitToolCheck()`）、許可リスト外が 1 つでもあればツールが動く前に停止する（deny リストの名前は「載っているが無効」なので止めない、`tools` が無ければ停止）。プロンプトは stdin。新しい CLI は `lib/agent-cli-workers.ts` に行を足し、driver に `--engine` を足す（Antigravity はワーカーにしない）。**2026-10-31 追記（承認なしで実行）**: エージェントごとの任意設定（既定 OFF、`lib/agent-run-without-approval.ts`）が ON のとき、有人実行のゲートのエスカレーションのうちシグナルが `leaves-root` / `write-or-exec` だけで command-safety が CRITICAL/HIGH でないものと、`draft` / `notify` のアクション承認を、RN（`app/_layout.tsx`）が通知タップと同じ Keystore 署名付き返信で自動許可し（native `resolveAgentEscalationAutoApproval` は accept 専用・preapproval grant を発行しない）、エージェントのチャットに「承認なしで実行: 自動許可 …」を残す。gate の deny（CRITICAL・POLICY-001・policy-write）は要求自体が出ないので不変、外部送信・REVIEW_REQUIRED は人に聞く。フラグは Keystore 裏付けの SecureStore のみに置き、エージェント JSON（実行が書き換え可能）には持たない。無人実行は driver が即 decline のまま（DEFERRED.md 参照）。**2026-11-01 追記（2 レベル、実機未検証）**: 設定は OFF / **標準**（上記、既存の ON＝SecureStore エントリに `level` なし）/ **すべて**（`level: 'all'`、NL「すべて承認なしで実行」/ "run fully without approval" かエージェント詳細のボタンでのみ）。「すべて」は有人実行かつ Web 調査・URL・通知トリガー等の信頼できない入力を読まないエージェントに限り（それ以外は標準に落ちる）、標準ルールが soft な理由で拒否したエスカレーションのうちファイル操作ツール（`ALL_LEVEL_TOOLS`）によるホーム内の作成・編集・移動・削除（HIGH の `rm -rf` 含む）と、ワークスペース内ファイルの読み取り専用構文チェック（`node --check`・`python3 -m py_compile`・`bash -n`）だけを自動許可する。スクリプト・プログラムの実行（エージェントが書いたもの、`node -e`、`python -c`、`npm run` 等）、`$(…)`・変数、CRITICAL、secret-read / network-send、`.shelly*`・ドットディレクトリ・`~/bin`・`~/models` 等のランタイム、鍵 / `.env` 系、ワークスペース以外のホーム外パス、システムコマンド、ネットワーク git、POLICY-001 ask・proactive は人に聞く。フラグはチャットで打った言葉からだけ（ターミナル要求・inbound・チーム登録は無視）。**2026-11-02 追記（build 2790）**: 「すべて」の判定はクォートを解釈する字句解析（`lexAllLevelScript`：'…'・"…"・`\`・`#` コメント・heredoc を shell と同じ規則で読み、クォート内の `|`・`;`・`&&`・`<<` で分割しない）で行い、`/tmp` と `$TMPDIR`（= `$HOME/tmp`）をファイル操作・構文チェックの置き場として許可（`..` で抜けない、ドット・`shelly-*`・`codex-rc-*`・ルート自体は不可）、展開は語頭の `$HOME`・`$TMPDIR` のみ。CLI ワーカーへのプロンプト末尾に「構文チェックは `node --check`、`node -e`・`python -c` は使わない」旨のヒントを driver が付ける。リンクを作れるコマンド（`ln`・`cp -s/-l/-a/-P/-d`・`git apply`・`patch`）は「すべて」でも聞き、許可と判定したコマンドは署名前に RN が `allLevelLinkProbe` で名前の出たパスの既存 symlink を実機上で調べる（あれば人に回す）。driver はワーカーと gate の env から `NODE_OPTIONS`・`BASH_ENV`・`ENV`・`CDPATH`・`PROMPT_COMMAND` を消す（`WORKER_ENV_DROP`、構文チェック許可の前提）。対応表は `ALL_LEVEL_SOFT_REASONS` のコメント、チャットの監査行は「承認なしで実行（すべて）: 自動許可 …」。アクション承認と無人実行は両レベルとも不変。NL で作ったエージェントの `workspaceRoot` は依頼文のパス（例 `~/demo/a.html` と `~/demo/b.html` → `~/demo`）から決まる（`lib/agent-workspace-from-request.ts`、確認文に「ワークスペース: …」。既存の構成要素に symlink があれば使わず、確定時は `mkdir -p` 後の物理パスを再検証して保存） | lib/agent-cli-workers.ts, scripts/shelly-agent-driver.js（+asset）, lib/agent-executor.ts, HomeInitializer.kt (`appendClaudeGlibcFunction`/`claudeRunnerScript`) |
| **エージェントロール（Inc A、2026-11-02、実機未検証）** | ロール（名前・指示・エンジン・担当する作業の種類・ワークスペース方針・任意の自動レビュー）は既存の `~/.shelly/agents/roles.json` 1 ファイル（新ディレクトリなし、ゲートが CLI からの書き込みを `policy-write` で拒否、ファイルハッシュを Keystore 裏付けの SecureStore `shelly_roles_v1` で封印、検証失敗はルーティング停止）。ロールの承認レベルは roles.json に置かず SecureStore にロール定義ハッシュと束縛して保存。**実行時は roles.json を読まない**: 作成時にステップへスナップショット（`AgentOrchestrationStep.role`、プロンプトに `# Your role`、.sh チェーンには乗せない）。ルーティングは決定的（`lib/agent-role-router.ts`）: `@agent` の作成依頼は常に、`@agent` なしはロール名かチーム語（「ロールで」「役割分担して」「チームで任せて」/ "with my roles" / "have the team"）のときだけ。明示ツール・ピン留めステップ・Antigravity・「ロールなしで」/ "without roles"・api-call・ClosePaw / social-post / browser-pane・実行可能スキル・自律・ロール不可読のときはルーティングしない。単位ごとに種類→ロール、並列グループは別ロール（なるべく別エンジン）、「競わせて」/ "compete" / "both … compare" で実装役を 2–3 枝に複製、自動レビュー役を最後の実装の後に追加、最後が CLI なら要約ステップを足してエージェントの tool は local（PlanSpec executor の CLI 並列ルートに乗る）。単一単位は単一ステップ（ロールのエンジン、プロンプト先頭にロール）。無人実行（スケジュール・継続・通知）と Web 調査の後には CLI ロールを付けない。確認はチャットの平文（`[ロール · エンジン] 指示`・ワークスペース・「承認なしで実行: 標準（ロール設定の低い方: A=すべて, B=標準）」・取り消し方）で常に人の OK 必須。OK 時、依頼文に承認レベルの指定が無ければ割り当てロールの検証済みレベルの最小をそのエージェントの「承認なしで実行」に書く（チャットで打った依頼のみ、terminal-request / 音声 / ウィジェット / MONITOR チームからは書かない）。**2026-11-02 追記（Inc B、executor v26、実機未検証）**: 直列の実装の直後が自動レビュー役なら `[実装, レビュー r1, 修正 r1, レビュー r2, 修正 r2] + 要約` に静的展開（`AgentOrchestrationStep.handoff {kind, of, round}`、最大 2 往復、修正は実装役のロール・エンジン＝同じゲート）。レビューの 1 行目 `VERDICT: PASS` で残りを `skipped`（TS 直列・executor 共通の `shouldSkipHandoffStep`）、ハンドオフ・ステップは `of` の結果だけをデータとして受け取る。競わせた後は審査役が `Candidate A/B`（ロール・エンジン名なし）で比べ、`WINNER:` はログに記録するだけ。ハンドオフは権限を与えない（ツール・ピン・ゲート不変、Web 調査の後の CLI 修正ステップは既存ルールで拒否） | lib/agent-role-types.ts, lib/agent-role-store.ts, lib/agent-role-router.ts, lib/agent-plan-summary.ts, lib/agent-draft-patch.ts, hooks/use-ai-pane-dispatch.ts, docs/superpowers/specs/2026-11-02-agent-roles-design.md |
| **記事パイプラインは汎用エンジン＋ユーザーの設定ファイル（2026-11-07、ファイル経路は実機未検証）** | `orchestration.longform` のチェーン `[research, write, review1, revise1, review2, revise2, assemble]`（任意で先頭に `queue-refill`・`queue-pop`）と、`list-drafts` によるダイジェストは汎用の仕組みで、PlanSpec executor だけが実行する（Run now は拒否、`normalizeStepLocal` が再検証）。**Shelly は記事エージェント・テーマ・スケジュール・エンジン・保存先を同梱しない。** `buildArticlePipeline(config)` / `buildArticleDigestPipeline(config)` は設定を厳密に検証し（未知のキーは拒否、各指示は 500 字まで、切り詰めず拒否、cron は分と時が固定値、保存先はドットなしの絶対パス）、設定は端末の `~/.shelly/agents/article-pipelines.json`（ゲートが CLI の書き込みを `policy-write` で拒否）から `@agent 記事パイプライン <id>` / `@agent article pipeline <id>` のときだけ読む（チャットのみ、確認の OK は必須）。ファイルが無ければ短い案内を返してエージェントは作らない。保存先は設定の vault か custom フォルダの内側（キューとダイジェストは vault のみ）。エンジンは設定の必須項目で既定値は持たず、`gemini-api`・`cerebras`・`groq`・`perplexity` のいずれか。ローカル LLM はトークン上限のため拒否する。**2026-11-07 追記（executor v37、実機未検証）**: `write` と `review` は `{"type":"cli","cli":"claude"|"codex","textOnly":true}` を指定できる。プロンプトに Web 由来の文が入るので、このステップの CLI にはツールを一切渡さない（driver `--text-only`）。Claude は `--tools ""` と `system/init` の 0 件確認、Codex は `features.shell_tool=false` ほか、`web_search="disabled"`、1 モデルのカタログ（`apply_patch_tool_type: null`、`shell_type: "disabled"`）で要求の tools を [] にし、`features list` の preflight と read-only の確認を通す。テキスト以外（tool_use、承認要求、許可リスト外の item）はターンを止めてステップを失敗にする。cwd と HOME は空の一時ディレクトリで、`project_root_markers = []`（`$skill` の本文注入を止める。認証は `CODEX_HOME`）。Claude の `@path` を止めているのは `--tools ""` ではなく `Read` の deny（版を動かすときは DEFERRED.md の契約確認）。無人実行でき、失敗しても HTTP エンジンへは落ちない。例外は `isTextOnlyCliStep` だけが判定し、`textOnlyPlanRefusal` が実行前に plan ファイル上の不正な印を拒否する（plan に封印はないので、ここが基準）。それ以外の CLI ステップは従来どおり `longformPlanRefusal` で拒否する。設定は権限を増やさない: アクションは `draft` 固定、`autonomous:false`、api-call ステップなし。形式は `docs/article-pipeline-config.md`。**2026-11-07 追記（executor v36、実機未検証）**: 任意の拡張点 `~/.shelly/agents/after-draft-hook.js`。ダイジェスト以外の longform チェーンが成功して下書きを保存したあと（`review: unresolved` の下書きも対象。queue tick・run log・`progressFinish` の後、lock と SIGTERM ハンドラは保持）に `spawn` の argv で `node <hook> <保存先>` を 1 回実行する。ファイルが無ければ何も起きない。環境は許可リストのみ（API キーと `WORKER_ENV_DROP` は渡らない）、stdio は ignore、120 秒・`.halted`・SIGTERM・フック自身の終了時にプロセスグループごと kill、run 開始から 28 分を過ぎたら実行しない（native の 30 分の壁）。通常ファイル・所有者一致・リンク 1 本・group/other 書き込み不可でなければ `refused`。結果は監査ログの `after_draft_hook` 1 行（status のみ）で、run・バックオフ・通知には影響しない。ゲートはこの名前を含むコマンドを単純な読み取り以外すべて `policy-write` で拒否する（文字列照合で、内容の封印はなし。DEFERRED.md 参照） | lib/agent-pipeline-presets.ts, lib/agent-article-pipeline-file.ts, lib/agent-orchestration.ts (`normalizeStepLocal`), scripts/shelly-plan-executor.js（+asset）, lib/agent-boundary-policy.ts（+gate asset） |
| **ヘッダー画像は `shelly image`（driver `--image-only`、2026-11-08、executor v39、実機未検証。**画像生成は canary 合格の版が登録されるまで動かない**）** | **コードで強制していること**: text-only の封じ込め（shell・apply_patch・Web 検索・MCP・hooks なし、空の HOME と cwd）のまま `image_generation` だけ ON。スレッドは `sandbox: read-only`（`:root` が読める）ではなく per-run の権限プロファイル `shelly_image_only`（config.toml の `default_permissions` と thread/start の `permissions`、`:root` deny・空の private cwd だけ read・network off）で起動し、`activePermissionProfile` が違えばプロンプトを送らない。turn/start に `sandboxPolicy` は付けない。`codex --version` が `CODEX_IMAGE_CANARY_VERIFIED`（`.ci-versions/codex-image-canary.json` と一致、**現在は空**）に無ければ app-server を起動しない。`shelly image --canary`（driver `--image-canary`）は読める範囲の外に置いたカナリア画像を `referenced_image_paths` で読ませ、拒否されて（エラー文の報告あり）通常生成は動くときだけ PASS。許すアイテムは `imageGeneration`・メッセージ・reasoning だけ。`inputImages` 付き（path と sha256 を監査に残す）・status が failed・2 枚目はターンを止めて失敗。プロンプトは中立な固定スタイル（`IMAGE_STYLES`: abstract-geometric / abstract-light / abstract-organic / abstract-texture / minimal-gradient）と 80 字までの無害化した題材から driver が組み立て、固定ルール（著作物・ロゴ・実在の人物や製品・顔・文字・UI・図表なし、3:2）で包む。自由文は足せない。画像は `savedPath`（per-run `CODEX_HOME/generated_images` 内のみ）か base64 から home 削除前に取り出し、`shelly-image.js` がマジックバイト確認・上限付きデコード（1 辺 8000 px・16 MP・8-bit のみ）・3:2 切り抜き・幅 1600 の JPEG（品質 80）に再エンコード（PNG は自前の zlib デコーダ、JPEG は vendored jpeg-js 0.4.4）。出力は `$TMPDIR` 配下の .jpg のみ（symlink 不可）。無人実行可（オーナー決定）。使う Codex はワーカーと同じレビュー済みの版（`SHELLY_CODEX_TUI_PATH` は消す）。`locks/text-only-codex.slot` を executor と共有し、`locks/image-<pid>.pid` は同時実行数・executor の Codex CLI スロット（v39、2 秒ごとに再確認）・STOP-ALL（starttime か、コマンドラインの `shelly-image.js`。`shelly` ヘルパーは子プロセスとして起動）に数えられる。古い per-run home・text-only cwd・カナリア・作業ディレクトリ・一時ファイルは起動時に掃除。hooks は第 2 層にしない（PreToolUse の失敗は fail-open で、hooks を ON にするとゲート外でコマンドが動く）。**実機で確認が要ること**: Termux 版の Android 上でプロファイルが拡張ツールの読み取りに効くか（canary）、画像ツールが出るか、savedPath/base64 のどちらで届くか、速度、ロックと STOP-ALL | scripts/shelly-agent-driver.js, scripts/shelly-image.js, scripts/shelly-image-jpeg.js, scripts/shelly-plan-executor.js（+asset）, .ci-versions/codex-image-canary.json, HomeInitializer.kt, lib/agent-manager.ts |
| **ClosePaw の下書き保存は人の承認付きキュー（2026-11-07、実機未検証）** | `shelly save-draft`（`scripts/shelly-save-draft.js` +asset、`$HOME/.shelly-save-draft.js`）が Markdown を許可リスト内の HTML に変換し（本文は常にエスケープ、HTML は素通ししない）、`$HOME/.shelly-draft-req-<reqId>`（メタ 1 行＋リクエスト JSON）に積むだけ。送信は `ClosePawDrafts.kt`: TerminalSessionService の実行時 `ACTION_USER_PRESENT` レシーバーが最初のロック解除で最大 5 件を `ClosePawShellApprovals` の承認 1 回にまとめ（宛先・タイトル・内容ハッシュを表示、ターミナルからは承認不可）、承認後に SHA-256 と宛先を再確認して 1 件ずつ `SHELLY_SAVE_DRAFT` の順序付きブロードキャストで送る（FileProvider `cacheDir/share/draft-<ランダム 128bit>/`、新規作成で symlink 不可、承認済み SHA-256 を `shelly_request_sha256` で渡す、送信前に grant、順序付き結果の後に revoke と削除、無応答のときは最終結果まで保持）。結果コード 17/18 を含む未開始はキューに戻して次のロック解除で再試行（activity へのフォールバックなし）。`request-too-slow` は未開始なので新しい reqId（内容と承認ハッシュは同じ）で次のロック解除に再試行。5 秒無応答とコード 0 は状態不明として nonce を残し、再送せず遅れた結果を待つ（レシーバーの有無は送信前に確認）。読み取りと送信で起きた Throwable は項目を消して止める（サービスの onCreate から呼ばれるのでクラッシュループにしない）。`.sending` にリネームしてから送るので再送は起きない（クラッシュ時は失う側に倒す）。Substack のサブドメインは `~/.shelly/agents/draft-destinations.json`（ゲートが `policy-write` で拒否）から決まり、キュー項目は選択しかできない。Markdown の画像は Substack のみ（同ファイルの `image_hosts` の完全一致ホスト）で note は alt テキストに落とす。`shelly-save-draft.js` は ClosePaw の `ArticleHtmlPolicy.kt` のポートで、`__tests__/fixtures/closepaw-html-policy-cases.json` が実物の判定を保持する。タップなしの送信は下の行の宛先ごとの「承認なし」だけ | scripts/shelly-save-draft.js, ClosePawDrafts.kt, ClosePawHandoff.kt, ClosePawShellApprovals.kt, TerminalSessionService.kt |
| **下書き保存の「承認なし」は宛先ごと、チャットで打った言葉からだけ ON（2026-11-08、実機未検証）** | オーナーが AI ペインで「note と Substack の下書き保存は承認なしで」/ "save drafts to note and Substack without approval" と打つと（文全体が固定の文型に一致したときだけ、`typedByUser` かつ `source` なし。音声・`shelly agent add`・ウィジェット・MONITOR チーム・エージェント出力・ファイルは不可）、`lib/closepaw-draft-preapproval.ts` → native `setDraftPreapproval` → `ClosePawDraftPreapproval.kt` が宛先（`note` / `substack:<subdomain>`、Substack は `draft-destinations.json` で許可されたものだけ、1 つだけなら「Substack」で決まる）と 1 日の上限（既定 5、最大 20、「1日3件まで」/ "up to 3 a day"）を保存する。保存先は SharedPreferences ＋ Android Keystore の HMAC で、書き込みのたび（送信 1 件ごとのカウントも）に鍵を作り直すので、古い prefs に戻すと検証に失敗して OFF になる（ネイティブが RN なしで読むため expo-secure-store ではなく CodexRemoteAutostart と同じ型）。`ClosePawDrafts.unlockStep` はキューを分け、ON の宛先で上限内・画像ホストなしの下書きはタップなしで承認済みバッチと同じ `send()` に流し（送信前にカウントを保存、各送信前に ON を再確認）、残りはそのバッチの後に従来どおり承認を求める。終わったら通知で件数・タイトル・下書き一覧へのリンク（固定 URL）を出す。オフは「承認なしをやめて」/ "stop saving drafts without approval" か設定の「下書き（ClosePaw）」トグル（オフ専用）。公開する経路はない。ON の間はスクリプトが積んだ内容も見ないまま下書きになる（DEFERRED.md P1「ClosePaw save-draft」） | ClosePawDraftPreapproval.kt, ClosePawDrafts.kt, TerminalEmulatorModule.kt, lib/closepaw-draft-preapproval.ts, hooks/use-ai-pane-dispatch.ts, components/layout/SettingsDropdown.tsx |
| bash は linker64 経由で libbash.so を起動 | Plan B は `bash` という exec が PATH 外なので `$HOME/bin/bash` の wrapper が必要 | HomeInitializer.kt |
| Codex CLI は Termux 公式パッケージの bionic バイナリを実行する（2026-11-07 切替、実機未検証） | 旧 fork `DioNanos/codex-termux` は `0.163.0-termux.3` で終了した。公式の `codex` .deb の `codex` を `codex_tui` として、`codex-code-mode-host` と一緒に APK（`libcodex_tui.so`）と runtime tarball に入れる。バイナリ名と `versions/<id>/` + `manifest.json` + `.healthy` の配置は変えていないので既存端末はそのまま更新できる。OpenAI 公式の aarch64 は静的 musl で exec ラッパーが効かないので使わない（DEFERRED の「mmap_min_addr 制限」は誤りで、実際は `ET_EXEC` の拒否）。**信頼の連鎖は `scripts/codex-termux-apt.js`**: 固定鍵 `scripts/termux-autobuilds.gpg`（指紋も照合）→ gpgv が検証した InRelease の本文のみ → Packages.gz の SHA-256 → .deb の size と SHA-256。URL は信用しない。**pin は 2 つ**: `.ci-versions/codex-termux-channel.json` は人が使う TUI 向けの配信で Bump が動かす。`.ci-versions/codex-termux-deb.json` と `codex.txt` は APK の同梱版（＝エージェントが動かす版）で、**レビューを経た変更でしか動かさない**（`node scripts/codex-termux-apt.js promote --channel … --pin … --codex-txt …` の差分を PR にする）。どちらも連鎖で確かめた hash を持つ（apt の index は最新版のみなので後はこの hash が根拠。pool から消えた .deb は `codex-runtime-latest` の控えから取る）。APK ビルドの `fetch` で致命的なのは署名の失敗だけで、index の古さや版の後退は警告。`codex.txt` は同梱 pin と一致しなければ CI が落ちる（Termux の改訂番号 `-N` は除いて比較）。**配信は Bump ジョブ（6 時間ごと）が APK ビルドなしで行う**: 候補を一時領域で検証（ELF、ライブラリのシンボル版を同梱の `libssl3.so` / `libcrypto3.so` の verdef と照合、シークレットスキャン）→ 通れば channel pin をコミット → `codex-runtime-latest` に tarball と `codex-runtime-termux.json` を公開（チャンネルと候補を比べるので失敗しても次回直る）→ 凍結検知は公開済みの版を上流と比べる。`codex-runtime.json` は fork の最終版のまま残す: これを読むのは切替前の APK で、その driver にゲートの修正が無いから Termux 版を届けない。1 回 APK を更新すれば以後は APK なしで届く。**エージェントのワーカーは `current` ではなく `agent-current` を見る**（§6.2）。作るものがまだ無いので、Inc 4/5 までは APK の同梱版で動く。契約テストはまだ無く、同梱 pin のレビューが唯一の確認。Termux の改訂番号だけの更新は Builds 画面が `codexTermuxVersion` で判定する（`lib/codex-runtime-update.ts`）。RUNPATH の com.termux は `LD_LIBRARY_PATH` が先に効き、CA は `SSL_CERT_FILE` で上書きする | scripts/codex-termux-apt.js, .ci-versions/codex-termux-channel.json, .ci-versions/codex-termux-deb.json, bump-codex-runtime.yml, build-android.yml, BuildsModal.tsx, shelly-runtime-update.js, shelly-agent-driver.js, LibExtractor.kt |
| /sdcard は MANAGE_EXTERNAL_STORAGE | Scoped Storage 回避、初回起動で Intent 経由ユーザー許可 | app.config.ts, TerminalEmulatorModule.kt, first-launch-setup.ts |
| **shell→RN bridge は file-queue (am start 不可)** | Android Knox sepolicy で `untrusted_app` uid からの `am start` が AMS で拒否 (`Failed transaction (2147483646)`)。代替として `$HOME/.shelly-deep-link-queue` に append、RN 側 250ms poll で drain → `useBrowserStore.openUrl()` 直接呼び出し (RN main thread は activity context、AMS 経由しない) | shelly-xdg-open.c, shelly-codex-auth.js, app/_layout.tsx |
| **PATH-visible shim は native binary 必須 (#! script 不可)** | kernel binfmt_script が `app_data_file` の `file{read}` を caller domain に要求するが Knox sepolicy で deny。`#!/system/bin/sh`、`#!$HOME/bin/bash`、`#!/system/bin/linker64 ...libbash.so` 全て同じエラー (`bad interpreter: Success`)。jniLibs に native binary を同梱、LibExtractor で $libDir に展開、$HOME/bin から symlink するパターンが唯一動く (libDir SELinux label が exec 許可) | shelly-xdg-open.c, shelly-shell-launcher.c, LibExtractor.kt |
| **ターミナル出力中の URL を自動で開かない（OAuth URL は OSC 8 から）** | `onUrlDetected` はタップではなく出力差分ごと（transcript 縮小時は全量再送）に発火するため、開くとループ・切れた URL・無関係 URL が開く（Claude glibc S2, build 2687）。Claude Code のサインイン URL は OSC 8 ハイパーリンクとして完全な形で来るので、`TerminalEmulator.sHyperlinkObserver` → `OAuthHyperlinkBridge.kt` が受ける。**出力は攻撃者が混ぜられる（同意画面＋攻撃者の PKCE でコード窃取）ので自動では開かない**: Claude Code の client_id/redirect_uri と一致し、`shelly-claude-glibc` 対話セッションが armed のときだけ「サインイン要求」を積み、RN がダイアログを出して**タップ時のみ** Custom Tabs を開く（arm は 1 回で消費）。ドレインは external の行だけ `lib/deep-link-open-guard.ts` で provider+URL 30 秒 dedupe + バースト破棄 | TerminalPane.tsx, TerminalEmulator.java, OAuthHyperlinkBridge.kt, deep-link-queue-policy.ts, app/_layout.tsx |
| WebView UA は `wv` token 抜き必須 (OAuth 突破) | Android デフォルト UA の `wv` token を OAuth provider が embedded WebView 検出に使う。Anthropic / GitHub は UA 修正で通るが、Google は `X-Requested-With: <package>` header (Chromium 自動付与) でも検出するので Custom Tabs trampoline が別途必要 (Phase 1.2 deferred) | components/panes/BrowserPane.tsx |

---

## デバッグログタグ（logcat フィルタ用）

`adb logcat -s` で使える Shelly 固有の tag 一覧。スモークテストでのトラブルシューティングに使う:

| タグ | 出力元 | 内容 |
|------|--------|------|
| `ShellyPaste` | `TerminalEmulator.paste` / `TerminalView.pasteViaEmulator` | paste 入出力の長さ、改行数、bracketed / TUI の状態。**内容は出さない**（`__tests__/no-input-in-logs.test.ts`） |
| `ShellyIME` | `TerminalView` IME 経路 | commitText / setComposingText / deleteSurroundingText / finishComposing のイベント名と長さ。**内容は出さない** |
| `ShellyExec` | `shelly-exec.c execSubprocess` | 子 PID、exit code、stdout/stderr byte 数、EAGAIN 回数 |
| `ShellyPTY` | `shelly-pty.c createSubprocess` | fork / ptsname / termios 設定結果 |
| `HomeInitializer` | `HomeInitializer.kt` | .bashrc バージョンチェック、CLI staging promote、stale rootfs/proot のクリーンアップ |
| `TerminalEmulator` | `TerminalEmulatorModule.kt` | hasAllFilesAccess / requestAllFilesAccess の権限状態遷移 |
| `Shelly` | `lib/debug-logger.ts` | `logInfo(module, ...)` 経由の汎用 JS ログ。**`Sidebar`はここに含まれるmoduleラベルの一つであり、独立したlogcat tagではない**(`logInfo`は`console.log`実装のみでネイティブLog呼び出しが無いため、`adb logcat -s Sidebar:D`は何も出力しない — 2026-08-17実機調査で確認)。`tryAddRepo`のprobe結果/ghost entry診断を追うには`adb logcat -s ReactNativeJS:V \| grep -F '[Shelly][Sidebar]'`を使うこと |

**入力の内容はログに出さない**: logcat は同じ uid の全プロセスが読める。パスワードは `read -s` でも IME とペーストの経路を通るので、打った・貼った・音声入力した文字列とコマンドは長さとイベント名だけを記録する。ゲートはワーカーの logcat 読み取りを人に回す（`secret-read`）。

**典型的な使い方**:

```bash
# ペースト問題を追跡
adb logcat -s ShellyPaste:D ShellyIME:D

# ターミナル起動 / CLI インストール問題
adb logcat -s HomeInitializer:* ShellyPTY:* ShellyExec:*

# /sdcard 権限問題
adb logcat -s TerminalEmulator:*

# Sidebar(REPOSITORIES追加/ghost entry診断など、JSログのmodule="Sidebar")
adb logcat -s ReactNativeJS:V | grep -F '[Shelly][Sidebar]'

# 全部(ネイティブtagのみ。Shelly配下の汎用JSログは上記のgrep併用)
adb logcat -s ShellyPaste:D ShellyIME:D ShellyExec:D ShellyPTY:D HomeInitializer:D TerminalEmulator:D
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
| `snippet-store` | 保存済みスニペット（Command Palette 経由で実行） | ✅ |
| `theme-version-store` | テーマプリセット切替時のkey-remount用カウンタ | — |
| `savepoint-store` | auto-savepoint のコミット履歴 | ✅ |
| `preview-store` | Preview ペインの表示ファイルパス | — |
| `execution-log-store` | コマンド実行ログ | — |
| `mcp-store` | MCP サーバー接続状態 | ✅ |
| `usage-store` | API使用量トラッキング | ✅ |

**2026-08-10 削除**: `workspace-store`（リポジトリごとのワークスペース分離、UIから未参照の実質デッドストア）・`arena-store`（Arena モード比較、フック呼び出し箇所ゼロ）・`plan-store`（AIプランカード、フック呼び出し箇所ゼロ）・`chat-store`（旧チャット画面用、chelly/ 削除後は完全デッド）をコード監査で削除。`chat-store.ts`が定義していた`ChatMessage`/`ChatAgent`等の型のみ、他ファイル（`AIPane.tsx`、`use-ai-pane-dispatch.ts`、`ai-pane-store.ts`ほか）から実際に参照されていたため`store/types.ts`へ移設済み。ストア本体（`create()`フックと永続化ロジック）とそれ以外の型は削除。

**触る前の確認**: ストアを新設する前に、既存ストアに追加できないか検討すること。上記表以外にも `agent-chat-store` / `dm-pairing-store` / `focus-store` / `inbound-store` / `worktree-store` が実在するが本表は未更新（別件）。

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
