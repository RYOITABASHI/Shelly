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

### ✅ bug #91 — ペースト時にコマンドが改行で分割される (修正済: 527a5d3a, 1e976712, bee63869)

**発見**: 2026-04-16 Codex 手動パッチ検証中
**症状**: 長い単一行シェルコマンドをペースト経由で送ると、bash が途中で Enter を押されたように受け取って中途実行する。先頭に `<` 混入、先頭バイト欠落も観測。
**根本原因**: IME の commitText が paste 由来の複数行テキストを `sendTextToTerminal` の per-char ループに流していた。ループ内で `\n → \r` 変換されて各 CR が PTY に即送信されて bash が逐次実行。CRLF 入力の場合は `\r\r` 列になっていて空コマンドと解釈される問題も。
**修正内容**:
- 527a5d3a: IME commitText の multi-line 分岐を追加して `mEmulator.paste()` 経由に変更。TerminalEmulator.paste() を DECSET 無視で常時 bracketed-paste wrap、CRLF → LF 正規化に変更。
- 1e976712: Session C の audit 推奨設計 (`pasteViaEmulator` ヘルパー) を TerminalView 側に追加。middle-click paste も共通化。
- bee63869: HomeInitializer の .bashrc 生成に `bind 'set enable-bracketed-paste on'` を追加、BASHRC_VERSION を 20 に bump。
**優先度**: 元 P0。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #92 — `/sdcard` 上のシェルスクリプトが読み込み不可 (修正済: d7a91a7e)

**発見**: 2026-04-16 Wave L 実機検証 (手動 codex patch 作業中)
**症状**: Shelly ターミナルから `/sdcard/Download/*.sh` を `source` / `.` / `cat` のいずれで読もうとしても `Permission denied`。
```
~$ source /sdcard/Download/patch-codex.sh
libbash.so: /sdcard/Download/patch-codex.sh: Permission denied
~$ cat /sdcard/Download/patch-codex.sh > ~/patch.sh
coreutils: /sdcard/Download/patch-codex.sh: Permission denied
```
**原因**: Android Scoped Storage (API 30+) と FUSE マウント。通常の Android アプリは `READ_EXTERNAL_STORAGE` だけでは `/sdcard` を直接 `open(2)` 出来ない。MediaStore / SAF 経由か、`MANAGE_EXTERNAL_STORAGE` (all-files-access) が必要。現在 `AndroidManifest.xml` は `READ_EXTERNAL_STORAGE` + `WRITE_EXTERNAL_STORAGE` のみで、Expo SDK 54 の既定 targetSdk は 34 なのでレガシー権限は無効。
**影響**: ADB 経由で `adb push <file> /sdcard/Download` → Shelly 側で source して実行、という**標準のデバッグ / patch 投入ワークフローが完全に詰まる**。本日の手動 codex patch 検証で実際に足止めされた。
**推奨修正案** (コスト順):
1. **(a) MANAGE_EXTERNAL_STORAGE 追加** — `app.config.ts` の `permissions` 配列に追加 + 初回起動で `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` Intent を投げる Modal。Play Store 非配布 (GitHub Releases / F-Droid) なので審査制約は低い。実装 30 分。**最速。**
2. **(b) SAF ベースの「ファイルをインポート」UI** — `Intent.ACTION_OPEN_DOCUMENT` で `~/imported/` にコピー。ユーザーが都度選択。スクリプト用途には摩擦が大きいが最も行儀が良い。
3. **(c) `~/shared/` シンボリック or JNI bridge** — 別アプリから Shelly の private data dir に書く手段が無いため実質不可 (ADB push なら可だが `/sdcard` 経由の利便性が無くなる)。
**採用**: **(a) MANAGE_EXTERNAL_STORAGE 追加**。d7a91a7e で実装済み。
**実装内容**:
- `app.config.ts` の `permissions` 配列と `android/app/src/main/AndroidManifest.xml` の両方に `MANAGE_EXTERNAL_STORAGE` を追加
- `TerminalEmulatorModule.kt` に `hasAllFilesAccess()` と `requestAllFilesAccess()` を expose (`Environment.isExternalStorageManager()` + `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` Intent)
- `lib/first-launch-setup.ts` の `runFirstLaunchSetup` で毎起動時に `ensureAllFilesAccess()` を呼び、未付与なら Settings 画面を開く
**優先度**: 元 P0。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #93 — `bash` コマンドが PATH 外 (修正済: 8f44e01c)

**発見**: 2026-04-16 Codex 手動パッチ検証中
**症状**: Shelly は Plan B で bash を libbash.so として linker64 経由で起動しているため、`bash` という名前の exec が PATH 上に存在しない。`bash script.sh` / `#!/usr/bin/env bash` shebang が軒並み動かない。
**修正内容** (Session B, 8f44e01c):
- HomeInitializer.kt に `$HOME/bin/bash` wrapper を配置 (proot wrapper と同じパターンで linker64 経由で libbash.so を起動)
- `$HOME/bin` は既に PATH 先頭に通っている
**優先度**: 元 P1。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #94 — ペースト経路の根本設計見直し (調査完了 + 実装済み)

**発見**: 2026-04-16 Wave L レビュー (bug #27 / #58 / #81 / #91 が全部ペースト経路由来と判明)
**症状**: ペーストだけで独立バグが 4 件 (先頭バイト欠け / 末尾残留 / 先頭 `:` 混入 / 改行分割)。根本原因は**ペースト経路が 5 つ並列に存在し、それぞれで CR/LF 正規化と bracketed-paste ラッピングの扱いがバラバラ**。
**調査結果**: `docs/superpowers/specs/2026-04-16-paste-pipeline-audit.md` に 5 経路のマッピング + `TerminalEmulator.paste()` 1 点集約の推奨設計を記載 (Session C commit 9f70d3ac)。
**要点**:
- Funnel α (IME commitText 経由) と Funnel β (`TerminalEmulator.paste()` 経由) の 2 本が併存
- Funnel α は `\n→\r` のみで CRLF を collapse しないため、multi-line paste が `\r\r` 列になる → bug #91 の有力仮説
- bracketed-paste wrap は Funnel β にしか無い
**実装結果** (Session A, 1e976712):
- TerminalView に package-private な `pasteViaEmulator(String)` ヘルパーを追加
- `commitText` の multi-line 分岐 + middle-click paste を全部このヘルパー経由に集約
- emulator.paste() は bracketed-paste を DECSET 無視で常時強制 ON (527a5d3a)
- .bashrc に readline bracketed-paste bind を追加 (bee63869)
**優先度**: 元 P0 調査。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #95 — Wave L の post-install sed patch が走らない (修正済: 8f44e01c)

**発見**: 2026-04-16 Wave L 実機検証
**症状**: HomeInitializer.kt の post-install ジョブで codex.js に sed patch を当てる処理があるが、実機で `grep -c shelly-proot codex.js` が 0 を返す = patch が実行されていない。
**修正内容** (Session B, 8f44e01c):
- post-install 内のログを `~/.shelly-cli/install.log` に書き出し、各ステップ (npm install start/end, codex.js exists check, sed patch exit code, verify) をトレース可能に
- sed patch 適用後に `grep -q 'shelly-proot'` で検証してログ出力
- 背景ジョブを同期的な手順に戻し、npm install 完了を待ってから patch
**優先度**: 元 P1。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #73 — Sidebar repo のパス正規化漏れ (修正済: 0687fca3)

**発見**: 2026-04-15 Phase 6-A Test 5-2 logcat 解析
**症状**: ユーザーが `~/Shelly` を ADD REPOSITORY 追加 → 内部で Termux 時代のパスに展開される / 存在しないパスが ghost entry として残る。
**修正内容**:
- normalizePath は既に Wave H で Shelly HOME を参照するように修正済み (bug #43)
- 0687fca3: Sidebar の ADD REPOSITORY モーダルで readDirEntries 経由の親ディレクトリ probe を追加。basename が実在するかを確認してから addRepo を呼び、存在しない場合は Alert "Directory not found" を出す。
- bug #70 修正 (4fac02d0) により、git status 経由での存在確認も信頼できる動作に戻った。
**優先度**: 元 P1。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #74 — 空履歴で ↑ を押した時の無反応 UX (修正済: HomeInitializer BASHRC_VERSION 21)

**発見**: 2026-04-15 Phase 6-A Test 5-2
**症状**: bash 起動直後で履歴が空の状態で action bar の ↑ を押しても画面が無変化。ユーザー視点では「ボタン壊れてる?」と混乱する。実際は `\x1b[A` を送信しており bash 側が無反応なだけ (後で `echo hello` 等を実行してから ↑ を押せば正常復元される)。
**修正方針**: action bar 側で履歴状態を知る手段はないので、(a) 軽いベル音/ハプティック、(b) あるいは初回 bash 起動時に `HISTFILE` を明示作成して履歴機能をアクティブ化、のどちらか。
**優先度**: P3 (仕様通り動作しているため出荷可能。出荷後改善)

---

### ✅ bug #70 — Sidebar の ls/git 実行が shell 経由で exit=0 stdout=0chars を返す (修正済: 4fac02d0)

**発見**: 2026-04-15 Phase 6-A Test 4 実機検証
**症状**: shell 経由の execCommand が exit=0 stdout=0chars を返し、Sidebar / FileTree / GitStatusBadge / PORTS のすべての読み取り機能が壊れていた。
**真の原因判明 (2026-04-16)**: `shelly-exec.c` の `execSubprocess` read loop が **non-blocking read の EAGAIN を EOF として誤認識** していた。`if (n <= 0) stdout_eof = 1` で n<0 (EAGAIN) と n==0 (EOF) を同列扱い。子プロセスが少し遅れて書き込む (bash + 小さい command は fork から書き出しまで数 ms 遅延がある) と、select が false positive で wake → read が EAGAIN → 親が EOF 判定 → 空 buffer 返却。
**修正内容** (4fac02d0):
- `n == 0` → 真の EOF として eof フラグを立てる
- `n < 0` + errno が EAGAIN/EWOULDBLOCK/EINTR → spurious wake として retry
- `n < 0` + それ以外の errno → 致命的エラーとして eof 扱い
- stdout / stderr 両方に適用
**影響**: bug #36 / #70 で「JNI に切り替える」ワークアラウンドをしていた機能の多くは、実は shell 経由の execCommand でも動作するようになる。FileTree / Sidebar / GitStatus / auto-savepoint 等の shell 経由読み取りが復活。
**優先度**: 元 P0。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #69 — Sidebar REPOSITORIES に Mock のダミーが表示され切替不能 (修正済: Wave F fdd4f0db)

**発見**: 2026-04-15 Phase 6-A Test 2 (リポジトリ切替) 実機検証
**症状**: サイドバーに SHELLY V9.2 / NACRE / LLM-BENCH-V2 の 3 ダミーが表示されるがタップしても何も起きない。
**修正内容** (Wave F fdd4f0db): Mock dummy 分岐を削除して、repo 0 件時は空状態 UI ("No repositories yet. Tap + ADD REPOSITORY to browse your code.") に置き換え済み。
**優先度**: 元 P0。解決済み → v0.1.0 に含まれる。

---

### ✅ bug #68 — AI ペインの Local LLM が server running 状態を検知せず "not enabled" エラー (修正済: Wave F fdd4f0db)

**発見**: 2026-04-15 Phase 6-A Test 1 (LLM ローカル 1 往復) 実機検証
**症状**: AI ペインでプロバイダを Local に切替え → "Error: Local LLM is not enabled. Enable it in Settings → Local LLM."
**修正内容** (Wave F fdd4f0db): `hooks/use-ai-pane-dispatch.ts:272-284` で `settings.localLlmEnabled` トグル参照を廃止し、`settings.localLlmUrl` がセットされているかだけをゲートに変更。Plan B 以降は Setup 画面の Start/Stop が直接 `localLlmUrl` を更新するので、Setup で RUNNING なら AI ペインでも即使える。
**確認**: 2026-04-16 Session A で `use-ai-dispatch.ts` が旧チャット画面用の dead code であることを確認 (どこからも import されていない)。新しい AI ペイン経路 (use-ai-pane-dispatch.ts) は URL チェックのみ。
**優先度**: 元 P0。解決済み → v0.1.0 に含まれる。

---

解決済み:
- ✅ **#27** ペースト末尾残留 (Wave B: commitText の二重フラッシュガードを mLastFinishFlush 比較に修正、TerminalView.java)
- ✅ **#58** ペースト先頭 `:` 混入 (Wave B: mShadow/mLastCommitAt を外側クラスに昇格、middle-button paste で sync)
- ✅ **#63** vim 脱出不可 (Wave C: onWindowFocusChanged で InputMethodManager.restartInput、診断ログ追加)
- ✅ **#93** bash コマンドが PATH 外 ($HOME/bin/bash ラッパー追加、BASHRC_VERSION 19、HomeInitializer.kt)
- ✅ **#95** codex.js sed patch が post-install 内で走らない (install.log 追記+sed exit code 検証+patch 適用確認ログ、HomeInitializer.kt)

---

## P1 — v0.1.1 で対応推奨

### bug #76 — Codex CLI が起動しない (optional native dep 欠落 + sed patch 未適用)

**発見**: 2026-04-15 Phase 6-A CLI 動作確認
**症状**: `codex` 実行時に以下のエラー:
```
Error: Missing optional dependency @openai/codex-linux-arm64.
Reinstall Codex: npm install -g @openai/codex@latest
```
Wave L インストール後の新しい症状:
```
error: "/data/data/dev.shelly.terminal/files/home/.shelly-cli/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/codex/codex" has unexpected e_type: 2
```
**原因**: (1) `@openai/codex` はプラットフォーム固有のネイティブバイナリを optional deps として持ち、Android では `--include=optional --os=linux --cpu=arm64` を渡さないと install されない → Wave L で修正済。(2) 静的リンク ET_EXEC aarch64 バイナリは Android の mmap_min_addr 制限で直接 exec 不可 → Wave L で Alpine minirootfs + proot wrapper を追加し、codex.js に sed patch を当てて `spawn("proot", ...)` に書き換える方針。
**Wave L 実機検証 (2026-04-16)**:
- ✅ Alpine rootfs 展開成功 (`~/.shelly-rootfs/etc/alpine-release` 存在)
- ✅ proot wrapper 配置成功 (`~/bin/proot` 存在、PATH 通り)
- ✅ codex 関数定義は `termux-libs/node codex.js` を直接呼ぶ形 (正しい。sed patch された codex.js 内部で proot を spawn する設計)
- ✅ npm install で codex.js + optional dep インストール完了
- ❌ **sed patch が走っていない** (`grep -c shelly-proot codex.js` → 0)
- ❌ 結果として codex.js は proot を経由せず直接 ET_EXEC を spawn → `unexpected e_type: 2`
**追加の原因推定**: HomeInitializer の post-install ジョブ内にある sed patch ブロックが、(a) 背景ジョブ (`( __shelly_bg_cli_update & )`) の中で早すぎるタイミングで走っていて npm install 完了前に codex.js を見に行ってスキップしている、または (b) `grep -q 'shelly-proot'` ガードの初回条件が誤判定、または (c) 背景ジョブ自体が起動していない。
**手動パッチ検証 (進行中)**: `sed -i 's|spawn(binaryPath,|spawn("proot",[binaryPath.replace(process.env.HOME,"/root"),|' codex.js` でパッチを当て、proot 経由で起動するかを確認中。手動パッチが動けば post-install ロジックのタイミング修正だけで本修正可能。
**修正方針**:
1. post-install 内の sed patch ブロックを npm install 完了確認後に同期実行させる (背景ジョブのサブシェル化を外す、または `wait` を入れる)
2. `grep -q 'shelly-proot'` ガードを `grep -q '/\*shelly-proot\*/'` にして確実にマーカー文字列にマッチさせる
3. 手動パッチで動作確認後、HomeInitializer 側で .bashrc 再生成タイミングも要検証 (BASHRC_VERSION bump しないと更新されない)
**現状**: `claude` (PASS) と `gemini` で代替可能なので **出荷ブロッカーではない**。v0.1.1 で対応。ただしユーザーが強く希望しているため本日中に解決試行継続。
**優先度**: P1 (ユーザー希望により実質 P0 扱い)

---

(bug #91 は P0 セクションに移動済み)

---

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
- **2026-04-15**: Phase 6-A 継続実機検証で #68 / #69 / #70 を特定・コード修正済 (未ビルド)。Test 5-1 Tab ✅ / Test 5-2 ↑ ✅ (履歴空時の無反応で一時誤診、後に正常動作確認)。#73 (repo パス正規化) / #74 (空履歴 ↑ UX) を登録。
- **2026-04-16**: v0.1.0 Wave L 実機検証セッション。Codex CLI を動かすために Alpine rootfs + proot wrapper を導入したが実機で複数の根本問題が顕在化。**bug #91** (ペースト改行分割、P0)、**bug #92** (/sdcard noexec/read 拒否、P0)、**bug #93** (`bash` コマンドが PATH 外、P1)、**bug #94** (ペースト経路設計がバラバラで同種バグが繰り返し発生、P0 調査)、**bug #95** (Wave L の codex.js sed patch が post-install 内で走らない、P1) を登録。bug #76 を Wave L 検証結果で更新。本日 v0.1.0 を出すのは **bug #91 を根本修正してから** という方針に変更。codex は v0.1.1 送り (claude + gemini の 2 本で v0.1.0 を出荷予定)。

---

## 管理ルール (自分への覚書)

- このファイルを編集したらコミット必須 (`docs(deferred): ...`)
- README.md / CHANGELOG.md / MEMORY.md の更新が必要なものは `→ sync:` で明記
- リリース前に P0 を空にすること
- 新セッションで Shelly を触るときは **このファイルを必ず読む**
