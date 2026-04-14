# Shelly — Deferred feature tracker

**これは後回しリストの唯一の真実の情報源です。**
**過去の不整合 (機能取りこぼし、README との乖離) を繰り返さないためのトラッキング装置。**

## 使い方

- スモークテスト / レビュー / 開発中に「後回し」判定したものは**全部ここに追加**する
- 判断理由 (Why not now) を必ず書く。後から読んだ自分が「なぜ?」で迷わないように
- 優先度は **P0 (次リリースのブロッカー) / P1 (次リリース推奨) / P2 (2 リリース先) / P3 (長期)**
- 完了したら行を削除するのではなく **✅ + 完了コミット SHA** を先頭に付ける (履歴を残す)
- MEMORY.md や README.md に反映すべきものは **`→ sync:`** で明記
- 新しい項目を追加するときは `## History` に日付 + 誰が気付いたか 1 行メモ

---

## 🟢 現状サマリ (2026-04-15)

**v0.1.0 スモークテスト後の一括修正完了**:
- Wave A (#28, #54, #55, #57, #67): ChatBubble / Font picker / Voice release ✅
- Wave B (#27, #36, #58): IME paste P0 / PORTS JNI ✅
- Wave C (#60, #63): Command Blocks 配線復活 / vim restartInput ✅
- Wave D (#65): Immortal Sessions (Case C transcript replay) ✅
- Wave E (#51, #52, #53, #56, #61, #62, #64, #66): Preview pane / CRT / i18n / reflow / rehydration / Savepoint ✅

**一段落判定条件** (ユーザー合意):
1. Shelly 本体の致命的バグが 0
2. CLI (claude / gemini / codex) が AI ペイン or ターミナルで起動・対話できる

→ ビルド完了後に Phase 6 実機検証で上記 2 点を確認次第、v0.1.0 RC タグ。

---

## 🟡 一段落後チェックリスト (手が空いた時に検証)

これらは **スモークテスト未実施または薄い検証のみ** の項目。リリース候補判定後、時間があるときに順番に潰す。

### 必須 (リリース判断に直結する可能性)
- [ ] **CLI 起動** — `claude` / `gemini` / `codex` を AI ペインまたはターミナルで起動、1 往復対話。bug #63 修正で vim が動けば CLI も動くはず
- [ ] **AI Edit golden path** — ファイル書き戻しフロー (前回 Cerebras レート制限でスキップ)
- [ ] **Onboarding / SetupWizard** — 新規インストール時の初回体験
- [ ] **LLM ローカル 1 往復** — llama.cpp でモデル起動・推論 (bug #32 絡み)

### 品質確認 (出荷後の追加テスト)
- [ ] **GitHub 連携** — リポジトリ追加 / clone / status / diff / commit / push
- [ ] **Browser pane** — URL 入力 / ページ内検索 / 履歴 / share
- [ ] **Markdown pane** — rendering / スクロール / リンクタップ
- [ ] **Search 機能** — 右上 🔍 ボタン、検索スコープ
- [ ] **Repository sidebar** — Shelly / Nacre / LLM-Bench-V2 切替、cwd 連動
- [ ] **File tree** — サイドバーの FILE TREE (今回 "Add a repository above to browse" 表示だった)
- [ ] **Ports セクション** — 開放ポートをタップした時のアクション
- [ ] **Keyboard shortcuts** — Ctrl+C / Ctrl+V / Tab / ↑↓ / Paste / Alt など action bar のキー
- [ ] **設定画面** — 各設定項目の反映 (通知、haptic、AI provider 切替 etc.)
- [ ] **Notification / Toast** — エラーダイアログ以外の一般通知

### 既知の制約 (確認して仕様として許容 or v0.1.1 対応)
- [ ] **bug #34** (Known Limitations): `watch` コマンドが `/bin/date` を決め打ち → 代替ワークアラウンド記載済
- [ ] **bug #35** (Known Limitations): `busybox` 未同梱 → curl/nc/python3 -m http.server 代替記載済
- [ ] **bug #65 Case B 完全版**: 真の Immortal (対話状態まで保持) は Case C 応急実装中。v0.1.1 で SessionService 昇格予定 (Binder IPC 300 LoC)

---

## ルール

1. **README や Status 表にある機能を後回しにする場合は、必ず 🟡 / 🚫 の状態に降格させる**
2. **ここに書いていないものは存在しない** — 口頭・チャット内の「あとでね」は禁止
3. **P0 は次リリース前に必ず fix**、P1 は「出せるが推奨しない」水準、P2+ は気軽に積む
4. リリースノート / CHANGELOG 作成時は **このファイルの P0 が空か必ず確認**

---

## P0 — 次リリース前の必須対応 (v0.1.0 ブロッカー)

*空 (ここに項目が残っている間はタグ打ちしない)*

解決済み:
- ✅ **#27** ペースト末尾残留 (Wave B: commitText の二重フラッシュガードを mLastFinishFlush 比較に修正、TerminalView.java)
- ✅ **#58** ペースト先頭 `:` 混入 (Wave B: mShadow/mLastCommitAt を外側クラスに昇格、middle-button paste で sync)
- ✅ **#63** vim 脱出不可 (Wave C: onWindowFocusChanged で InputMethodManager.restartInput、診断ログ追加)

---

## P1 — v0.1.1 で対応推奨

| # | タイトル | Issue / Status | 見積 |
|---|---|---|---|
| 1 | llama.cpp UI: pre-installed model 検出 + active server model 表示 | [#10](https://github.com/RYOITABASHI/Shelly/issues/10) | 60–90 分 |
| 2 | Modal: 可視 BACK アフォーダンス追加 (MCP / llama / SSH) | [#11](https://github.com/RYOITABASHI/Shelly/issues/11) | 30–45 分 |
| 3 | Enter key 2 連打問題の実機検証 (primeImeBuffer 削除後) | [#12](https://github.com/RYOITABASHI/Shelly/issues/12) | 15 分 (検証のみ) |
| 4 | Typeless 音声入力の検証 (IME 全面改修後) | [#13](https://github.com/RYOITABASHI/Shelly/issues/13) | 15 分 (検証のみ) |
| 5 | 端末 CJK フォント統合 — Misaki / Cica + GL atlas 更新 | [#14](https://github.com/RYOITABASHI/Shelly/issues/14) | 3–4 時間 |
| 7 | 音声 / immortal / AlarmManager の実機スモークテスト | [#16](https://github.com/RYOITABASHI/Shelly/issues/16) | 80 分 |
| ✅ 27 | ペースト + Enter でコマンドが実行されない | **Wave B 修正済** | 済 |
| ✅ 28 | UI 全面の Silkscreen 大文字問題 | **Wave A 修正済** | 済 |
| ✅ 29 | 2 回目以降の Add Pane が効かない | **前セッション修正済 (409b4642)** 実機検証待ち | 済 |
| ✅ 30 | Splitter (ペイン幅) のドラッグが効かない | **前セッション修正済 (409b4642)** 実機検証待ち | 済 |
| ✅ 36 | PORTS が listener を検知しない | **Wave B: JNI 直読に切替** | 済 |
| ✅ 54 | Font picker が Silkscreen 以外反映されない | **Wave A: SettingsDropdown で applyThemePreset 配線** | 済 |
| ✅ 55 | Theme 切替で色が残留する | **Wave A: ChatBubble markdownStyles トークン化** | 済 |
| ✅ 56 | ペインコンテンツがペインサイズに最適化されない | **Wave E: fontSize 段階縮小 (Case 1)** + Case 2 (cols/reflow) 実装中 | 実装中 |
| ✅ 57 | Groq 応答が ActionBlock 化されない | **Wave A: provider 非依存分岐 + markdownStyles 修正** | 済 |
| ✅ 58 | ペースト先頭 `:` 混入 | **Wave B 修正済** | 済 |
| ✅ 59 | @agent コマンドがインターセプトされない | **Wave C 波及 (#60 解決で自動修復)** | 済 |
| ✅ 63 | vim から脱出できない | **Wave C 修正済** | 済 |
| ✅ 65 | Immortal Sessions (tmux 復元) | **Wave D: Case C transcript replay** / Case B 完全版は実装中 | Case C 済 |
| ✅ 67 | マイク占有 / 権限 revoke 再起動 | **Wave A: releaseRecorder を 3 箇所で await** | 済 |

すべて GitHub Issues に登録済み (milestone: v0.1.1)。各項目の詳細 (実装ヒント、検証手順、影響範囲) は Issue 本文を参照。このセクションは要約インデックスのみ。

---

## P2 — 2 リリース先 (v0.2.0 milestone)

### GitHub Issues 登録済み

| # | タイトル | Issue | Status |
|---|---|---|---|
| 6 | **Cloud Config Sync** — 暗号化 GitHub バックアップ + ウィザード UX | [#15](https://github.com/RYOITABASHI/Shelly/issues/15) | 未着手 |
| 8 | 日本語 i18n の完成 — ハードコード英語を `t()` でラップ | [#17](https://github.com/RYOITABASHI/Shelly/issues/17) | Wave E で再 mount hack, 完全移行は実装中 |
| ✅ 51 | Theme presets (silkscreen/pixel/mono) が Settings に無い | — | **Wave E 修正済** |
| ✅ 52 | Preview pane パス全部大文字 | — | **Wave E: FilesTab の font を JetBrainsMono に** |
| ✅ 53 | Preview pane FILES タブが空 | — | **Wave E: find→ls -la parse に書き換え** |
| ✅ 60 | Command Blocks 視覚装飾なし | — | **Wave C: onOutputDelta 配線復活 (#59 も波及解決)** |
| ✅ 61 | CRT 全開で色ムラ | — | **Wave E: VIGNETTE_OPACITY_MAX 0.35→0.22** |
| ✅ 62 | i18n 切替が UI に反映されない | — | **Wave E: Stack key 再 mount (応急) + 完全移行実装中** |
| ✅ 64 | force-stop 後に Pane ヘッダー消失 | — | **Wave E: use-multi-pane に _hasHydrated フラグ** |
| ✅ 66 | Savepoint 自動発火しない (💾 出ない) | — | **Wave E: app/_layout.tsx に bridge 追加 + ShellLayout に SaveBadge mount** |

### まだ Issue 化していない P2 項目 (必要になったら登録)

#### llama.cpp UI: 初回起動時の自動 Recommended セットアップ
- Recommended モデルが未インストールなら起動時にサジェストポップアップ → 確認 → ダウンロード
- **Why not now**: ディスク容量 / バッテリー / 帯域を勝手に消費するリスク、明示同意の設計を固めてから
- **Issue 登録条件**: Issue #10 (llama detect) 完了後にセットで検討

#### Cloud storage 統合 (Google Drive / Dropbox / OneDrive)
- **現状**: v0.1.0 で **明示的に descope 済** (Sidebar から CLOUD セクション削除、Status 表で 🚫 out-of-scope、`rclone` に委譲)
- **Why deferred permanently**: ターミナルアプリの主軸から外れる、OAuth 管理コストが高い、`rclone` が 40+ backend をカバー済
- **再考の条件**: ユーザーから具体的なユースケース報告が 3 件以上あった場合のみ Issue 化

#### RTL (Arabic / Hebrew) サポート
- **現状**: ゼロ、`I18nManager.forceRTL()` 未使用
- **Why not now**: 実ユーザー需要が発生してから Issue 化

#### アクセシビリティ完成 (スクリーンリーダー対応の全面展開)
- **現状**: v0.1.0 で CommandPalette / SettingsDropdown / Sidebar の主要 Pressable に label 追加済み
- **不足**: FileTree / TerminalPane / AIPane / BrowserPane 等の他コンポーネント
- **Why not now**: 視覚 UI の変動が落ち着いてから一気にやる方が効率的
- **Issue 登録条件**: Issue #17 (i18n) 完了と同時期に Issue 化

#### ChatScreen.tsx (1410 LOC) / use-ai-dispatch.ts (1363 LOC) のリファクタ
- **現状**: アーキテクチャレビュー agent から "major refactor candidate" と指摘済み
- **Why not now**: 機能変更を伴わない refactor は shipping velocity を下げる
- **Issue 登録条件**: v0.2.0 の大型作業を開始するタイミング

#### Zustand store 統合 (git-status-store + ports-store → sidebar-data-store)
- **現状**: 20 個の store に分割されており過剰
- **Why not now**: 動いているものを触るコストが高い、v0.2.0 refactor とまとめる

#### テスト infra 追加 (jest / detox)
- **現状**: ゼロ、`package.json` に `"check": "tsc --noEmit"` のみ
- **Why not now**: 解を追加するより仕様を先に固める段階
- **最低限**: `terminal-store` の unit test 1 本 + `@shelly exec` の e2e test 1 本から始める

#### AlarmManager 再入ロック
- **現状**: `useAgentStore.agents: Agent[]` は mutable array、再入防止ロックなし
- **リスク**: 前回実行の終了前に次のアラームが発火すると 2 重実行の可能性
- **Why not now**: 実ユーザー報告がまだ無い

#### 起動時 JNI 診断チェック (linker64 silent failure 対策)
- **現状**: `TerminalEmulatorModule.kt` に `testExecve()` はあるが、ユーザー手動呼び出しのみ
- **実装案**: `MainApplication.kt` 起動時に `execCommand("echo ok", 3000)` を 1 回走らせ、失敗ならダイアログ
- **Why not now**: v0.1.0 で実機動作確認済なら事実上発動しない

#### shelly-exec.c の 4 MiB 出力キャップ改善
- **現状**: `MAX_OUTPUT = 4 MiB` で切り捨て、タイムアウト時の waitpid ブロッキングリスク
- **Why not now**: llama モデル DL は `curl -o FILE` を使うのでキャップには当たらない

#### execCommand タイムアウトの上限キャップ + `__SHELLY_TIMEOUT__` マーカー
- **Why not now**: 小さい UX 改善、重要度低

#### bug #34 — `watch` コマンドが `/bin/date` を決め打ちで呼ぶ
- **症状**: Plan B 環境で `watch -n1 date` が `error: unable to open file "/bin/date"` を出す。ヘッダーは更新されるがサブコマンド実行が壊れる
- **原因仮説**: 同梱 `watch` バイナリ (出自不明、`LibExtractor.LIBS` に明示エントリ無し → おそらく別バンドル or 別ツール由来) が `/bin/sh -c` / `/bin/date` を hard-code。Plan B の rootfs には `/bin/*` が存在しない
- **対応 (v0.1.0)**: Known issue として README.md (Known Limitations) に明記済。ワークアラウンド: `while true; do clear; <cmd>; sleep 1; done`
- **本修正候補**: (a) `/data/.../termux-libs/bin/` に shim スクリプトを置いて PATH 先頭に追加 (b) procps-ng watch を $PREFIX 対応で再ビルドして jniLibs 同梱 (c) toybox watch applet (同じく hard-code 問題あるので要 patch)
- **Why not now**: shim 方式は簡単だが Android 10+ の shebang 実行制限 (SELinux) にかかる可能性あり、LD_PRELOAD exec wrapper 経由の挙動検証が必要。v0.1.1 以降
- **Issue 登録条件**: 実ユーザーから複数報告が来たら GitHub Issue 化

#### bug #35 — `busybox` コマンド未同梱
- **症状**: `busybox httpd ...` / `busybox nc ...` 等が `libbash.so: busybox: command not found`
- **現状**: `LibExtractor.LIBS` に busybox エントリなし、`jniLibs/arm64-v8a/` にも `libbusybox.so` 無し → 完全未同梱が確定
- **対応 (v0.1.0)**: Known issue として README.md に明記済。代替: 同梱済の `curl`, `nc`, `python3 -m http.server` 等を使う / Termux 併用 / PR 歓迎
- **本修正候補**: busybox-static (arm64-v8a, ~1 MiB) を `jniLibs/arm64-v8a/libbusybox.so` として同梱し `LibExtractor.LIBS` に `"busybox"` エントリ追加。applet シンボリックリンクは初回起動時に `LibExtractor` で展開
- **Why not now**: ターミナルの主要ユースケース (AI CLI + git + node + python) には不要。バイナリ追加は APK サイズ増 (+1-2 MiB × ABI) とビルド時間の問題
- **Issue 登録条件**: busybox 依存ワークフローの具体的要望が 3 件以上

---

## P3 — 長期ロードマップ / 検討中

### bug #65 Case B — 真の Immortal Sessions (対話状態保持)
- **現状**: Wave D で Case C (transcript replay) を実装。見た目は「続きから再開」に見えるが vim / claude --continue / REPL の対話状態は失われる
- **Case B 方針**: fork 親を TerminalSessionService (FG service) に移動、sessionRegistry を Service の Binder 経由で Module から再取得可能にする
- **工数**: ~300 LoC Kotlin (Binder plumbing, Service lifecycle, event emitter 再配線)
- **Why not now**: v0.1.0 は Case C で十分、Case B は独立した大型タスク
- → sync: v0.1.1 milestone の目玉機能候補

### i18n: `t()` 呼び出しの `useTranslation()` 移行
- **現状**: Wave E で `<Stack key={locale}>` hack を入れ、EN/JA 切替は即反映。完全移行 (40+ ファイルの module-scope `t()` → `useTranslation()`) は実装中
- **Why not now**: 応急対応で動くので最優先ではない
- **スコープ感**: 半日〜1 日の機械的置換

### インライン IME compose preview
- **現状**: v0.1.0 では **採用せず** (`setComposingText` を PTY に書かない方針)
- **理由**: Android IME compose の state management が PTY stream と根本的に整合しない (Typeless / Samsung Keyboard / Gboard それぞれ別挙動、二重化や first-char 消失を誘発)
- **将来案**: Shelly 自前の compose preview レイヤーを PTY 上にオーバーレイ描画 (iTerm2 方式)、IME からは候補 string だけ受け取る
- **スコープ感**: 数日〜1 週間、別プロジェクトレベル
- → sync: `docs/RELEASE-v0.1.0.md` の "Known issues" に "No in-line compose preview on the terminal row — use your keyboard's candidate bar" と明記

### アプリアイコン + Play Store / F-Droid 配布
- **現状**: アイコンは `assets/images/icon.png` に配置済 (v0.1.0 で shipping)、Play Store / F-Droid 配布は未着手
- **Why not now**: 最初の OSS リリースは GitHub Releases のみで開始、配布先追加は反響を見てから
- → sync: README Status 表で `Distribution channels (Play Store / F-Droid) | 🟡 GitHub Releases only for now`

### PR 動画の自動生成
- ワイヤレス ADB + `screenrecord` + ffmpeg で Termux 内完結
- MEMORY.md の「やりたいことリスト」参照

### 開発特化キーボードアプリ
- Nacre の後継、分割型レイアウト、トラックボール
- MEMORY.md の「やりたいことリスト」参照

### UI セルフチェック機能
- ワイヤレス ADB 経由でスクショ → マルチモーダル AI に UI/UX バグ検出依頼
- MEMORY.md の「やりたいことリスト」参照

### CRT エフェクト強化
- Terminal + Chat の GPU シェーダー実装
- MEMORY.md の「やりたいことリスト」参照

---

## History

- **2026-04-14**: 初版作成。v0.1.0 スモークテスト中の発見を整理。コードレビュー / セキュリティ / アーキテクチャ / A11y / 競合 5 エージェントの指摘のうち、出荷ブロッカーではない項目をすべて P1-P3 に振り分け。
- **2026-04-14**: Task 5 スモークテスト時にユーザーから「戻るボタン」「モデル自動検出」「自動セットアップ」の 3 つの追加要望あり → BACK ボタン (P1)、モデル自動検出強化 (P1)、自動 Recommended セットアップ (P2) として登録。
- **2026-04-14**: Task 7 (Ports monitor) スモークテストで bug #27 発覚。`node -e "..."` をペースト + Enter してもコマンドが実行されず、末尾 `"` が残り `^[` が混入。通常タイプ経路は OK。ペースト経路の `\r` 送信欠落が疑わしい。P1 に登録し次リリースで対応。Task 7 自体はスキップして Task 8 に進行。
- **2026-04-14**: Task 8.2 (AI ペイン) スモークテストで bug #28 発覚。Cerebras 応答自体は正常だが、AI ペインの全テキスト (bubble, header, YOU/AI label) が大文字グリフで表示される。原因は Silkscreen フォントが小文字コードポイントを大文字形状で描画する仕様。ターミナルは JetBrains Mono 済だが UI 側は Silkscreen のまま。個別対応ではなく UI 全面一括置換として P1 に登録。bug #23 を統合・拡張。
- **2026-04-14**: Task 8.3 (Browser ペイン) スモークテストで bug #29 / #30 発覚。初回 Add Pane は成功するが 2 回目以降が無反応。原因調査で `AddPaneSheet` の `focusedPaneId` が split 後に stale になっていることを特定。#29 part 1 + part 2 で修正済 (0d7f0b40 / 409b4642)、実機検証は次セッション。
- **2026-04-14**: Phase 5 で bug #36 / #51-#67 を発見、並列 5 agent で原因調査。
- **2026-04-15**: Wave A/B/C/D/E で #27 / #28 / #36 / #51 / #52 / #53 / #54 / #55 / #56 / #57 / #58 / #59 / #60 / #61 / #62 / #63 / #64 / #65 / #66 / #67 を一括修正。
- **2026-04-15**: DEFERRED.md 再構成 — 先頭に「🟢 現状サマリ」「🟡 一段落後チェックリスト」を追加、各 bug にステータスマーク。

---

## 管理ルール (自分への覚書)

- このファイルを編集したらコミット必須 (`docs(deferred): ...`)
- README.md / CHANGELOG.md / MEMORY.md の更新が必要なものは `→ sync:` で明記
- リリース前に P0 を空にすること
- 新セッションで Shelly を触るときは **このファイルを必ず読む**
