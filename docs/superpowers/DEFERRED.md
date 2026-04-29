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

## 🟢 現状サマリ (2026-04-20 evening、BASHRC_VERSION 43)

**CLI 3/3 実機動作確定** (Termux 午後セッション)。Shelly で claude / codex / gemini すべて対話モード起動 & 1 往復チャット成功:

| CLI | 状態 | 認証方式 |
|---|---|---|
| **claude** | ✅ 対話 REPL 動作 | 別環境で `/login` → `~/.claude.json` + `~/.claude/.credentials.json` を /sdcard 経由 transplant |
| **codex** | ✅ **TUI REPL 動作** | **Shelly 単独完結** (`shelly-codex-auth.js` device-auth、PKCE 自前実装、#114) |
| **gemini** | ✅ 対話 REPL 動作 | 別環境で `/auth` → `~/.gemini/` 全体 transplant |

**今日投入された主な fix** (commit 列: `b445073f` → `7000c578` → `e7328b2e` → BASHRC_VERSION 43 hardening pass):

Termux 午後セッション (Termux Claude Code):
- #114 codex TUI wiring (`codex.bin` 154MB bundle、BASHRC_VERSION 42)
- #102/#115 scope decision: claude/gemini transplant docs 整備
- #116 multi-pane keyboard input routing fix (e85694a3)
- #101 demote P0→P1 (実機で 401 消えた、観測継続)

Evening hardening pass (desktop、BASHRC_VERSION 43):
- #108 addPane silent failure → `useAddPane` hook で全 callsite 統一
- #112 Modal refocus → `<ShellyModal>` wrapper で構造的解決
- #106 表示破損 IME burst diag log (`commit BURST delta=Xms`)
- #100/#103 再検証 (git default identity の actually-writes、polling AppState gate の genuine pause)
- bashrc hardening: dead TMPDIR 削除、PS2='> ' 明示、DISABLE_AUTOUPDATER=1 (claude pin 防衛)
- CI codex.bin verify loud fail

**install 推奨**: 最新 build (BASHRC_VERSION 43)

**未解決 P0 (v0.1.0 RC ブロッカー)**:
- **#104** keyboard 回避失敗 — edge-to-edge + Android 15+ で ime insets が RN に届かない
- **#106** paste 表示破損 — バイトは正しいが画面が崩壊、burst diag で chunk-split 仮説確定待ち

**Scope decision (Shelly では fix しない、別パス):**
- **#101** codex rustls CA → P1 (実機 401 消、観測継続、恒久は codex-termux 再ビルド)
- **#102** claude OAuth → P2 (Chelly 責務、Shelly scope 外)
- **#115** gemini OAuth → P2 (同上)

**未解決 P0 (継続):**
- **#101** codex rustls CA — 暫定のみ、恒久は codex-termux 再ビルド (multi-day)
- **#104** keyboard 回避 — 診断ログのみ、実機値の logcat 未取得

**P1 (実装 / 検証残):**
- **#106 表示破損** (バイトは正しいが画面が崩壊) — IME chunk-split 仮説、diag log (`commit BURST delta=`) 入れた次回 install で確定。修正は coalescing 追加。
- BASHRC_VERSION 43 install 後に #100/#103/#108/#111/#112 全部実機検証必要

**未着手 / 別ブランチ:**
- shelly-cs Phase 1.5 SSH tunneling: `feat/ssh-tunneling` で Day 3 まで、Day 4/5 未完
- shelly-claude-auth.js / shelly-gemini-auth.js (codex-login pattern、in-app device flow) — ユーザー dismiss 済、当面 transplant で運用

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

### ✅ claude-code v2.1.113+ の cli.js 消失問題 (対応済: BASHRC_VERSION 33 で 2.1.112 に pin)

**発見**: 2026-04-18/19 v32 実機テスト中、install.log に繰り返し
`[install] HEALTH CHECK FAILED` が記録されていることを発見。追跡した
結果、**`@anthropic-ai/claude-code@2.1.113` で `cli.js` が tarball から
削除された**ことが判明。

**経緯** (npm registry 調査):
- `2.1.112` — `bin.claude = "cli.js"`, tarball に `cli.js` (2.8 MB 純粋 JS) + `vendor/` 含む
- `2.1.113` — `bin.claude = "bin/claude.exe"`, `cli.js` 消失、代わりに `bin/` + `cli-wrapper.cjs` + `install.cjs`
- `2.1.114` — 同上

**cli-wrapper.cjs の中身** (2.1.113 以降):
```javascript
// 126 行。platform-detect して native binary を spawnSync するだけ。
// JS fallback は皆無。PLATFORMS マップに android-arm64 は無い。
function main() {
  const binaryPath = getBinaryPath();  // → Bun SEA 絶対パス
  spawnSync(binaryPath, process.argv.slice(2), ...);
}
```

**影響**: Shelly v32 の 3-tier fallback は `$HOME/.shelly-cli/node_modules/.../cli.js`
を探すが、Tier 1 (auto-updated) が `cli.js` を持たない → 毎回 Tier 3
(bundled golden = 2.1.105) に fall through する仕様に。

**対応 (BASHRC_VERSION 33)**:
- `.github/workflows/build-android.yml` の `Bundle AI CLIs` step で
  `@anthropic-ai/claude-code@2.1.112` を明示 pin
- `HomeInitializer.kt` の `__shelly_bg_cli_update` で同 pin
- `--libc=musl` と `@anthropic-ai/claude-code-linux-arm64-musl` の強制 install を削除

**2026-04-29 Path D experiment**: `feature/claude-bun-extract-node`
で `@anthropic-ai/claude-code-linux-arm64-musl@latest` の Bun SEA
`.bun` section から `cli.js` を `objcopy` + Python で抽出し、
Shelly の bionic `node` で走らせる opt-in ルートを追加。実機では
`SHELLY_PREFER_EXTRACTED_CLAUDE=1 claude --version` から検証する。
最新版 bundle の `using` / `await using` 構文は Shelly の Node で
parse できないため、CI で `const` へ最小変換して `node cli.js
--version` まで検証する。
musl SEA 直実行の `__errno_location` / Bash tool 障壁を回避できる
可能性があるが、Anthropic の bundle layout drift に弱いため CI で
fail-loud する。詳細:
`docs/superpowers/specs/2026-04-29-claude-bun-extract-node-handoff.md`。
- 併せて `cp -al` の staging ディレクトリネスト bug を修正

**戦略的影響**:
- **ローカル claude-code は 2.1.112 で frozen**。2.1.113+ の新機能
  (`/rewind`, `/bashes`, Skills hot reload, Sonnet 4.5 デフォルト化) は
  ローカルでは使えない
- **"常に最新 claude-code" は Codespaces 経由が唯一の道** に → shelly-cs
  Phase 1 実装の戦略的裏付け (BASHRC_VERSION 34)

**優先度**: 元 P0、解決済み。コミット: `b7061d57`, `15ee5843`。

---

### ✅ Ask Pane Stage 1 — Shelly self-documenting assistant (実装済: commit 6de28e13)

**動機**: Shelly の機能が多すぎて覚えてられない。AI に聞いたときに「その機能はない」と言われたら、そのまま issue に投げられたら超便利。

**Stage 1 で shipped 範囲**:
- 新 pane type `'ask'` 追加 (hooks/use-multi-pane.ts, pane-registry.ts)
- `components/panes/AskPane.tsx` — 質問入力 + Groq streaming 回答 + ステータスバッジ (✅/⏳/❌)
- `lib/ask-context.ts` — PRIMER + FEATURE_CATALOG dump + curated shipping/roadmap snippets
- 既存 `groqChatStream` を `systemPromptOverride` 経由で流用 — 新規 LLM plumbing ゼロ
- AddPaneSheet / LayoutAddSheet / PaneSlot の選択肢に統合

**Stage 2 予定** (設計完了、実装未着手 — docs/ask-pane-stage2-design.md 参照):
- `[📝 Create GitHub issue]` ActionBlock (NOT_AVAILABLE 時に表示)
- Issue 作成 flow: 質問 + AI 回答 + 環境情報を template に pre-populate、editable modal で preview → POST /repos/RYOITABASHI/Shelly/issues
- Token は `~/.shelly-cs/token` (0600、`shelly-cs auth` で保存済) を expo-file-system で読み込み
- `labels: ['from-ask-pane']` 一律付与

**Stage 3+ (将来)**:
- dedup search (既存 open issue との類似性チェック)
- category label 自動付与 (feature-catalog.category ベース)
- "What's new" card (CHANGELOG [Unreleased] の自動引用)
- pane-local history (AsyncStorage)
- voice input (PaneInputBar 統合)
- README/CLAUDE.md/DEFERRED.md 全文 ingestion via CI-generated docs-content.ts

**優先度**: Stage 1 済み、Stage 2 は P1 (1-1.5 日工数)。

---

### ✅ Codespaces 統合 Phase 1 minimum (実装済: BASHRC_VERSION 34, commit 15ee5843)

**動機**: claude-code 2.1.113+ が Android bionic で動かなくなったため、
**"本物の最新 claude-code" をモバイルで使う唯一の道は Codespaces 経由
のリモート実行** になった。

**Phase 1 minimum で landed した物**:
1. `shelly-cs` CLI (Pure Node, ~450 LoC, `assets/shelly-cs.js`)
2. OAuth device flow (GitHub OAuth App `Ov23liLDXUTGYlzzhlLG`)
3. `list`, `create`, `open`, `stop`, `delete`, `doctor`, `logout`
4. env-var overridable constants (`SHELLY_OAUTH_CLIENT_ID`,
   `SHELLY_CS_DEFAULT_REPO`, `SHELLY_CS_SCOPE`)
5. Template repo `RYOITABASHI/shelly-codespace-template` (Node 20 +
   claude-code postCreateCommand)

**Phase 1.5 送り (次スプリント)**:
- **SSH tunneling**: GitHub Codespaces の native SSH は gh CLI の
  proprietary tunnel infrastructure (WebSocket + JSON-RPC) 経由。
  実装候補 3 通り (下記 "Phase 1.5 設計メモ" 参照)
- **SecureStore bridge**: 現在 token は file (`$HOME/.shelly-cs/token`,
  0600)。JSI 経由で expo-secure-store に橋渡し
- **Browser Pane auto-open**: 現在 `am start -a VIEW` で OS 標準ブラウザ
  起動。JSI hook で Shelly 内蔵 Browser Pane に切替
- **Clipboard monitor**: device code copy → URL 自動オープンまで自動化
- **Auth polling**: device flow 完了を auto-detect、Shelly 通知で完了表示

**Phase 2 以降 (Sidebar 統合)**:
- `Sidebar → CODESPACES` セクション (Worktrees pattern 踏襲)
- タップで SSH 接続 → Terminal Pane に claude-code
- 30 秒ポーリング or WebSocket で status 更新
- 長押しメニュー (start / stop / rebuild / delete)

**Phase 3 (透過化)**:
- `claude()` 関数に Tier 0 (Codespace tunnel) 追加
- `~/.shelly-cs/config.json` に default codespace 設定
- `claude "hello"` 打つだけで裏で SSH tunnel 経由で remote claude-code 実行
- ユーザー体験: "Android で `claude` 打てば動く" が完全復活 (ただし裏は
  Codespace)

**優先度**: Phase 1 min P0 (解決済み), Phase 1.5 P1 (次スプリント), 2/3 は P2。

---

### bug #104 — ソフトキーボード回避失敗 (edge-to-edge + Android 15+)

**発見**: 2026-04-20 最新ビルド `d613f78c` 実機検証 (Z Fold6 / Android 16)
**症状**: ソフトキーボードを起動するとターミナルペインの action bar (Ctrl+C/Tab/↑↓/Paste/Alt) と入力プロンプト行が完全にキーボードの下に隠れる。`KeyboardAvoidingView` が機能しておらず、ペインが 2160px 高さのまま描画されてキーボードが上に重なっている。
**logcat で確認した事実**:
- adb dumpsys window InputMethod で IME frame `[0,1303][1856,2160]` = キーボード高 857px を計測できている
- つまりシステム側は ime insets を通知しているが、RN 側がそれを使っていない
**原因仮説**:
- `android/gradle.properties` で `edgeToEdgeEnabled=true` (Android 15+ デフォルト)。edge-to-edge 有効時はシステムが自動で ime insets を適用しないため、アプリ側で `WindowInsets.Type.ime()` を明示的に padding に加える実装が必要
- 直近コミット `32cdad50 fix: keyboard avoidance for all panes` が入っているが効いていない → 特定ペイン / 特定 IME (Samsung Keyboard) で効かない可能性
**影響**: **ターミナル入力が物理的に不可能**。v0.1.0 最大のブロッカー。
**次アクション**: `react-native-safe-area-context` の `useSafeAreaInsets()` に加えて、`useAnimatedKeyboard()` (react-native-reanimated 3) or 手動 `Keyboard.addListener('keyboardDidShow', ...)` で `ime` inset を取得して padding に加える。`KeyboardAvoidingView` を自前実装に置き換える必要がありそう。
**優先度**: **P0 最優先**

---

### ✅ bug #114 — codex TUI wiring (解決済: commit acd13d5e + BASHRC_VERSION 42)

**発見**: 2026-04-20 TUI エージェント調査。`codex help` の Commands が `resume/review/help` の 3 つだけで、対話モードに入れなかった。
**判明した真因**: codex-termux tarball には実は 2 つのバイナリが同梱されている:
- `codex-exec.bin` (106 MB) — 1-shot 実行専用 (`exec/resume/review/help` サブコマンド処理)
- `codex.bin` (154 MB) — **完全な ratatui TUI REPL** (引数なし or bare prompt 起動)

Shelly の CI ワークフローは従来 `codex-exec.bin` だけを `libcodex_exec.so` として jniLibs に配置していて、**TUI バイナリを完全に捨てていた**。`codex.js` の shelly-patcher も `codex_exec` に固定 spawn していたため、`codex` コマンドは常に 1-shot モードしか動かなかった。
**実装内容** (commit `acd13d5e`):
- `.github/workflows/build-android.yml`: `codex.bin` を `libcodex_tui.so` として追加 copy (+154 MB APK)
- `LibExtractor.kt`: `libcodex_tui.so → termux-libs/codex_tui` 展開エントリ追加
- `HomeInitializer.kt`:
  - `codex()` bash 関数を全書き直し: `exec/resume/review/help` サブコマンド → `codex_exec`、それ以外 (bare invocation, options, 自由記述 prompt) → `codex_tui`
  - 不在時に silent fallback ではなく明示的エラー + exit 127
  - `_run` が既に `linker64` を呼ぶので二重呼び回避 (レビューで blocking 検出)
  - whitelist から `mcp/completion/login/logout` 除外 (fork 未サポート、codex-login は別ルート)
  - BASHRC_VERSION 41 → 42 (.bashrc 強制再生成)
**実機検証 (2026-04-20 14:31 JST)**: 新 APK (`24644652433`) install 後に `codex` (引数なし) 起動 → **ratatui REPL 表示**。model `gpt-5.4`、/statusline、/model、Tip hint、placeholder `Improve documentation in @filename` すべて出現。認証は既に shelly-codex-auth.js 経由で済んでいたため /login 不要。
**副次効果**: APK サイズ約 441 MB → 596 MB (+155 MB)。GitHub Releases 配布前提なので許容範囲。
**優先度**: ✅ 解決済 → v0.1.0 RC 含む

---

### 🟡 bug #101 — codex TLS: rustls-native-certs 問題 (実機で解消を観測、真因不明)

**発見**: 2026-04-20 朝、`codex "hello"` logcat transcript 再描画で確認
**症状 (朝 01:16 時点)**: codex-termux バイナリが OpenAI API 接続時に
```
ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket:
IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses
ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header
```
**当時の仮説**: Shelly は `$SSL_CERT_FILE` / `$CURL_CA_BUNDLE` / `$NODE_EXTRA_CA_CERTS` / `$REQUESTS_CA_BUNDLE` を `.bashrc` で export しているが、**Rust の `rustls-native-certs` は OS のネイティブ証明書ストアを直接読む設計** で env var を見ない。Android にはそのネイティブストアが無いので no native root CA certificates。

**更新 (2026-04-20 14:31 JST 実機検証)**: 新 APK (bug #114 fix 入り, BASHRC_VERSION 42) で `codex` TUI 起動後、`codex "hello"` も 401 を出さずに `Hello. How can I help?` を返した。BASHRC 再生成で CA bundle 参照が効いた可能性、もしくは朝の 401 は別要因 (auth.json が壊れていた、refresh token 一時失効など) の可能性。

**次アクション**:
- 継続観測: `codex "何か長めの質問"` を時間空けて叩き続け、再現するか
- 再現した場合のみ: codex-termux upstream に `rustls-tls-webpki-roots` feature 有効化 request
- 現状: ユーザー可視の不具合なしとして優先度を下げる

**優先度**: P0 → **P1** (実機では動作中、観測継続が必要)

---

### 🟡 bug #102 — claude OAuth 400 (回避策確立、恒久修正は未実装)

**現状 (2026-04-20 10:04 JST 実機検証)**: credentials transplant で完全動作確認。Shelly 内での /login フローは依然 400 のまま (恒久修正は v0.1.1 以降)。

**真の原因** (夜間 dev handoff §4-1 + 10:04 実証で確定):
- claude は Shelly に `xdg-open` / `termux-open` / `open` のいずれも無いため **manual paste mode** にフォールバック
- 対策として `$HOME/bin/xdg-open` に `am start -a VIEW -d $1` ラッパーを置いたが claude は依然 manual paste mode → xdg-open の有無以外の signal を見ている可能性 (要追加調査)
- manual paste mode での PKCE verifier 保存先が謎、コード貼り付け後に 400
- MEMORY.md に書いてあった `/tmp/claude` sed や CLAUDE_CODE_TMPDIR 系は **2.1.112 cli.js で既に dead code** → 対処しても無意味

**✅ 実証済の回避策 (credentials transplant)**:

事前条件: 別環境 (Termux 等) で claude 認証を完了させた `.credentials.json` + `.claude.json` を持っている。

```bash
# Termux 側 (Claude Code が動く環境)
cp ~/.claude.json /sdcard/Download/shelly-claude-root.json          # 32KB
tar czf /sdcard/Download/termux-claude-dir.tar.gz -C ~/.claude .     # 948MB (history.jsonl 込み、小さくしたければ excludes で絞る)
gunzip -k /sdcard/Download/termux-claude-dir.tar.gz                  # 1.8GB 展開形 (Shelly の tar が /bin/zcat ハードコードなので uncompressed 必要)

# Shelly 側
cp /sdcard/Download/shelly-claude-root.json ~/.claude.json
chmod 600 ~/.claude.json
cd ~/.claude && tar xf /sdcard/Download/termux-claude-dir.tar        # ~/.claude/ 全体を上書き
claude                                                                # → onboarding スキップ、"Welcome back XXX" が出れば勝ち
```

**決定的な発見**:
- **`~/.claude.json` ($HOME 直下、32KB)** が onboarding 完了 + 認証本体の正本
- **`~/.claude/.credentials.json` (OAuth トークン) だけでは不十分** ← 09:38 に credentials.json だけ置いて失敗した原因
- `~/.claude/` 全体の transplant は補助 (settings.json / projects/ でセッション継続に便利)

**制約**:
- `expires_at` 約 9 時間 (Termux 側の access_token の残り期限) → 期限切れ後は Termux で再 /login して transplant やり直し
- refresh token が Cloudflare WAF で弾かれる可能性 ([#47754](https://github.com/anthropics/claude-code/issues/47754)) → 確認 TODO
- **⚠️ Termux 側 claude-code は `@2.1.112` で pin 必須**。2.1.113+ は cli.js が Bun SEA バイナリに置き換わり、`node cli.js` 経路が死ぬ ([#50270](https://github.com/anthropics/claude-code/issues/50270))。**2026-04-21 に実際に Termux 側が 2.1.116 に auto-update されて claude 起動不可になる事故が発生**。毎回 `claude` 起動時に自動更新が走る仕様なので、以下いずれかの対処必須:
  - **A. 起動前に pin 戻し**: `npm i -g @anthropic-ai/claude-code@2.1.112`
  - **B. 書込み禁止でロック** (推奨): `npm i -g @anthropic-ai/claude-code@2.1.112 && chmod a-w /data/data/com.termux/files/usr/lib/node_modules/@anthropic-ai/claude-code`。以後 auto-update が permission denied で無害化
  - **C. `DISABLE_AUTOUPDATER=1` export** (未確認、v2.1.112 で効くかは Anthropic upstream コード次第)

**🎯 スコープ判断 (2026-04-20)**: Shelly は **ゼロ状態ユーザー向けではなく、既に開発環境を持つユーザー向け** のツールとして再定義。初心者向けの「ブラウザから直接 /login 完結」体験は **Chelly (Chat UI を別リポで OSS 化する姉妹プロジェクト)** の責務。Shelly 本体での /login 完結実装は **スコープ外**。

→ **優先度**: P2 (Shelly の設計思想と合わない。v0.1.0 では README に transplant 手順を明記して「上級者向けの手作業セットアップ」として出荷)

**恒久修正候補** (もし Chelly 連携が遅れた場合の Shelly 側 fallback、v0.2.0 以降):
1. **Shelly 内 credentials import UI** — Sidebar に「Import from external claude install」ボタン追加、/sdcard/Download/ からピック (最小工数)
2. **shelly-claude-auth.js 自作** (dev handoff §4-1 回避策 3, ~250 LoC) — codex-login と対称のデバイスフロー実装、PKCE + am start で完結させる
3. **xdg-open 以外の signal を特定して潰す** — claude 2.1.112 cli.js を再解析、`isTTY` / `terminal.type` 等の detector を探す

**→ sync**:
- README.md に credentials transplant 手順を明記 (done TODO → 本コミットで対応)
- MEMORY.md / `2026-04-20-claude-credentials-transplant.md` に transplant 手順を記録済
- Chelly プロジェクト側に「credentials 生成 → Shelly 転送経路」の設計タスクを渡す

---

### 🟡 bug #115 — gemini CLI `/auth` 400 (回避策確立、claude #102 と同族)

**現状 (2026-04-20 11:15 JST 実機検証)**: gemini も transplant で完全動作確認。Shelly 内での `/auth` loopback フローは 2 段階で詰む。

**失敗経路**:
1. **xdg-open EACCES**: gemini-cli は auth URL を `spawn('xdg-open', [url])` で開こうとする → `Failed to open browser with error: spawn xdg-open EACCES`。今朝 10:30 頃に置いた `~/bin/xdg-open` ラッパーは chmod +x 済みだったはずだが何かの post-install で権限剥がれた可能性 (要調査、claude transplant 後に /auth 試したので state が汚れてる)
2. **手動ブラウザで URL 開いても 400**: 出力された auth URL (`https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http://127.0.0.1:41319/oauth2callback&...`) を Chrome にコピペしても Google OAuth サーバーが "要求の形式が正しくありません (400)" を返す。redirect_uri のポート (`41319`) が OAuth client の登録済 URL リストに無いか、loopback redirect がドメインポリシー違反扱いか

claude #102 と同じく、**Shelly 内で OAuth loopback を完結させるのは事実上不可能**。

**✅ 実証済の回避策 (credentials transplant)**:

gemini の認証状態は `~/.gemini/` ディレクトリ**だけ**で完結 (claude の `~/.claude.json` のような $HOME 直下の特別ファイルは不要)。サイズも小さい (110KB tar)。

```bash
# Termux 側 (gemini が動く環境、事前に /auth 完了済)
tar cf /sdcard/Download/termux-gemini-dir.tar -C ~/.gemini .

# Shelly 側
mkdir -p ~/.gemini
cd ~/.gemini && tar xf /sdcard/Download/termux-gemini-dir.tar
gemini              # → "Signed in with Google" で対話プロンプト直行
```

**重要なファイル**:
- `~/.gemini/oauth_creds.json` (~1.8KB) — Google OAuth access + refresh token
- `~/.gemini/google_accounts.json` (~55B) — アカウント紐付け
- `~/.gemini/trustedFolders.json` (~56B) — trust 済フォルダ記録 (これが無いと初回 trust prompt が出る)
- `~/.gemini/settings.json` / `state.json` / `projects.json` — 設定と履歴

**制約**:
- claude #102 と同じく、Shelly をゼロ状態ユーザーに使わせる用途ではない。別環境で `gemini` 認証を完了した人向けの運用
- Google OAuth refresh token の失効条件は Anthropic より緩い想定だが、長期の実運用データはまだ無い
- Termux 側も `@google/gemini-cli` の upstream 変更で破綻する可能性 → 現在 `0.38.2` で動作確認

**🎯 スコープ判断**: bug #102 と同じく **P2**。Shelly での `/auth` 完結は Chelly 側の責務として外す。

**→ sync**:
- README.md の "Bring your own credentials" セクションに gemini 版を追加 (本コミットで対応)
- 2026-04-20-claude-credentials-transplant.md に gemini の手順も追記推奨

---

### bug #103 — サイドバー polling の CPU 連打でターミナル UI 遅延

**発見**: 2026-04-20 実機 logcat 解析 (Ctrl+C / Enter の反応が数秒遅延)
**症状**: Shelly アクティブ中、約 **3 秒ごと** に以下のシーケンスが連発される:
```
LibExtractor: Attempting CLI tools extraction...
LibExtractor: cli-tools.tar.gz: already extracted (...)
LibExtractor: CLI tools extraction done, checking launchers...
TerminalEmulator: execCommand: bash exists=true lib exists=true files=55
ShellyExec: execSubprocess: child pid=XXXXX ...
[Shelly][NativeExec] exec: cd '/data/.../home' && git branch --show-current 2>/dev/null
[Shelly][NativeExec] exec: cat '/data/.../home/.shelly_cwd' 2>/dev/null
```
**原因**: サイドバーの自動更新 polling が git branch / cwd / PORTS / その他を 3 秒毎に複数 execCommand で取得しており、さらに毎回 LibExtractor が冪等チェック (全 lib エントリの存在確認) を走らせる。UI スレッドが詰まってキー入力イベントの処理が遅延する。
**次アクション**:
1. polling interval を 3 秒 → 15 秒に緩和
2. LibExtractor の冪等チェックは app 起動時 1 回でよい、polling ごとに呼ぶ必要なし
3. git branch / cwd / ports を 1 つの複合 exec にまとめる (N+1 問題)
**優先度**: P0 (UX 破綻レベルのレイテンシ)

---

### bug #105 — codex vendor ディレクトリ欠落で Missing optional dependency

**発見**: 2026-04-20 `codex "hello"` 起動時
**症状**: shelly-patcher が codex.js の `spawn(binaryPath, ...)` を `spawn(linker64, [codex_exec])` に書き換えても、codex.js 実行フローが spawn に到達する前に
```
throw new Error(`Missing optional dependency @openai/codex-linux-arm64. Reinstall Codex: ...`)
```
で落ちる。
**原因**: `@openai/codex@0.121.0` の codex.js 84-98 行に、`require.resolve("@openai/codex-linux-arm64/package.json")` に失敗した時の fallback として `path.join(__dirname, "..", "vendor", "aarch64-unknown-linux-musl", "codex", "codex")` の `existsSync` チェックがあり、**両方 false なら throw**。Shelly は `@openai/codex-linux-arm64` を install しない (Android で musl ET_EXEC なので動かない) + vendor ディレクトリも作らない → throw 確定。
**実機で確認した回避**:
```bash
V=~/.shelly-cli/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/codex
mkdir -p $V
ln -sf $LD_LIBRARY_PATH/codex_exec $V/codex
```
この symlink で `existsSync` が true になり throw 回避 → shelly-patcher 済 spawn に到達 → codex が起動する。
**次アクション (Shelly 本体)**:
- **A案 (推奨)**: `HomeInitializer.kt` の post-install で `patchCodex` 成功後に vendor symlink を作成
- **B案**: `shelly-patcher.js` の `patchCodex()` に 2 つ目の needle 追加 (`throw new Error(\`Missing optional dependency` → コメントアウト)
**優先度**: P0 (codex 起動不可、hack なしでは動かない)

---

### bug #106 — ペースト複数症状 (bug #97 修正後の別クラスタ)

**発見**: 2026-04-20 ビルド `d613f78c` 実機検証 (セッション中に複数回再現)
**観測された症状 (全 4 パターン)**:
1. **先頭文字欠落** — `mkdir -p $V` → 1 行目丸ごと消滅、`codex --version` → `odex`、`ls -la $F` → `a -la $F`
2. **複数行ペーストの一部消失** — 3 行貼り付けのうち 1 行目が完全欠落、別パターンでは真ん中が飛ぶ
3. **長文コマンドの途中欠損** — `sed -i "s|/tmp/claude|$HOME/.claude-tmp|g" $F` のように 1 行で長いコマンドを貼ると、途中から欠ける or 表示が尻切れ (画面上 `<elly-cli/...` のような truncate 表示)
4. **行頭に `<` 記号が混入** — ペースト後のプロンプト折り返し表示で `<` が行頭に現れる (bash prompt の truncate 表示? 要検証)

bug #97 (改行ごと実行) は修正済だが、**別クラスタのペーストバグ** が残っている。

**仮説** (確度順):
- **A. bracketed-paste END トリガ欠落**: `\C-x\C-b` (begin) は `.bashrc` の bind で有効化されているが、`\e[201~` (end) が IME commitText 境界で切断され、bash が「ペースト中」状態のまま次の入力を wait → 一部バイトが fallthrough。bug #97 follow-up の副作用の可能性
- **B. Samsung Keyboard の `setComposingText` → `commitText` 境界問題**: DEFERRED.md bug #98 の Samsung Keyboard / CJK commitText ケース。長いペーストが 1 回の commitText ではなく複数回に分割されて届き、pasteViaEmulator の閾値判定 (16 chars) が誤動作
- **C. bug #91 修正 `pasteViaEmulator` 集約の不完全さ**: 全経路が emulator.paste() に集約されているはずだが、IME 固有の経路 (古い Android setComposingRegion?) が取り漏れている
- **D. 端末 ANSI エスケープの余剰**: `\<` の混入はプロンプトのescape処理漏れでアプリ側の描画の話。実際に bash に届いている内容とは別問題かも

**次アクション** (デスクトップ版で):
1. TerminalView.java の `ShellyPaste:` 診断ログ (bug #97 修正時導入) を全ペースト経路で grep 出力し、raw bytes / sanitized bytes / 送信 bytes の 3 点を比較
2. Samsung Keyboard 以外 (Gboard) で再現テストして IME 固有か切り分け
3. DECSET 2004 gate が TUI 外 (bash readline) に wrap を送る実装になっているか `paste()` の分岐を再検証
4. bug #98 のエッジケース 3 件と統合検討

**優先度**: **P0** (今日のデバッグ作業中に頻発、v0.1.0 ブロッカー。ターミナルでまともなコマンドを打てないレベル)

---

### ✅ bug #97 follow-up — ペースト時に改行ごとに実行されるリグレッション (修正中: TerminalEmulator.java + HomeInitializer.kt BASHRC_VERSION 27)

**発見**: 2026-04-17 v0.1.0 RC 実機テスト (更新インストール)
**症状**: 複数行ペーストが bracketed-paste で wrap されず、`\n` → `\r` 置換で 1 行ずつ bash に到達 → 1 行ずつ Enter として実行される。ユーザー側では「ペーストすると 2 行目以降がコマンドとして誤実行」に見える。ログは `ShellyPaste: paste(raw=18, sanitized=17, nl=1, bracketed=true, preview="echo one↵echo two")` と出るが、`bracketed=true` は **DECSET 状態の診断用ログ**で実際の wrap 挙動とは別もの → 誤解を誘発。
**原因**: bug #97 root fix (`TerminalEmulator.paste()` の `text.replaceAll("\r?\n", "\r")`) は「ESC 漏れを防ぐため wrap を諦める」という意図的なトレードオフだった。問題は readline dispatch が `\e[200~` キーシーケンスの ESC (0x1B) を meta-prefix として swallow してしまうことで、`[200~` がリテラル文字として bash に流れ command not found 祭りになる、という bionic bash 5.3 固有の挙動。
**修正**: 入口の keyseq を ESC-free に変更 + 周辺 3 件の P0/P1 を同時対応:
- `TerminalEmulator.paste()`: DECSET 2004 gate で分岐。(a) readline guest → `\C-x\C-b` (0x18 0x02) + payload + `\e[201~`。(b) TUI (vim/less/nano) → `\r?\n → \r` fallback。
- `HomeInitializer.kt`: .bashrc に `bind '"\C-x\C-b": bracketed-paste-begin' 2>/dev/null` を emacs / vi-insert / vi-command 各 keymap に追加。BASHRC_VERSION 26 → 27。
- `rl_bracketed_paste_begin` は呼び出し後 `rl_read_key` で直接バイトを読みながら `\e[201~` を探す実装 (readline/kill.c `_rl_bracketed_text`) なので、END 側の ESC は dispatch を通らず swallow されない。
**並列レビューで検出した周辺問題 (この修正で同時対応)**:
1. **P0 候補 — clipboard 内 `\e[201~` による command injection** → line 2649 の既存 sanitize (`text.replaceAll("(\u001B|[\u0080-\u009F])", "")`) が ESC を strip 済みなので mitigate されている。security invariant としてコメント追記。
2. **P1 — vi-mode で `\C-x\C-b` が unbound** → `bind -m vi-insert` / `bind -m vi-command` 追加済み。
3. **P1 — vim/less 等 TUI の foreground に wrap を送ると `\e[201~` が insert mode を exit して破壊的操作** → DECSET 2004 gate で TUI には fallback 経路を使う。
**残る既知の制約 (v0.1.0 では許容、v0.1.1 以降で再検討)**:
- **SSH / docker exec / sudo 経由のネスト bash**: remote bash は DECSET 2004 を advertise するので gate 通過、しかし `\C-x\C-b` bind は remote 側に無いので unbound → readline が discard → payload が dispatch に流れ line-by-line 実行 (旧 bug #97 挙動と同等、リグレッション無し)。将来的には `bind` を送信して remote に一時 install する手もあるが、SSH セッション確立検出が難しいので保留。
- **古い tmux / immortal session で BASHRC_VERSION < 27 の .bashrc を保持しているケース**: shell 再起動で解消。ドキュメントに known limitation として追記検討。
**副次効果**: 複数行 compound 構文 (`for…done`, here-doc, 関数定義) が atomic に貼り付け可能に復活。ユーザーが Enter を押すまで実行されない標準ブラケットペーストの挙動を取り戻す。
**レビュー**: 3 並列エージェント (source-code verification / edge-case hunt / implementation-bug hunt) で妥当性確認済み。
**優先度**: P0。再ビルド後実機検証で動作確認してから v0.1.0 確定。

---

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

### bug #135 — gpg cascade runtime deps (libgcrypt + chain) — v5.1.1

**発見**: 2026-04-27 build #746 実機検証
**症状**: bug #132 で libbz2 を bundle して unzip は動くようになったが、gpg は次の missing dep:
```
CANNOT LINK EXECUTABLE ".../gpg": library "libgcrypt.so" not found
```
unzip / nano / その他は動作確認済み。gpg だけ cascade。

**未解決の dep chain (推定)**:
```
gpg → libbz2          ✅ bundle 済 (#132)
gpg → libgcrypt       ❌ 次にこける (確認済)
libgcrypt → libgpg-error  ❌ 次の次の可能性
gpg → libassuan       ❌ gpg-agent との IPC 用、必須
gpg → libksba         ❌ X.509 / S/MIME (CMS)
gpg → libnpth         ❌ threading
gpg → libz            ✅ libz1.so で既に bundle 済
```

**修正方針 (v5.1.1)**:
1. Termux apt から `libgcrypt` / `libgpg-error` / `libassuan` / `libksba` / `libnpth` の各 .deb を順次 extract
2. CI workflow の bug #128/#130 と同じ table-driven loop に追加
3. LibExtractor.kt に対応 mapping
4. 各 lib も DT_NEEDED の cascade 持つので、build → fail → 不足 lib 追加 を 2-3 cycle 想定
5. APK サイズ +5-10 MB

**v5.1.0 影響**: gpg 動かないが core dev workflow には影響なし (signed commit が出来ないだけ)。release notes に "gpg available in v5.1.1" と記載済。

**優先度**: P1 (v5.1.1 の主要項目)
**見積**: 1-2 build cycle、~1-2 時間

---

### bug #134 — process.execPath = linker64 path (Node CLI launcher pattern 全般)

**発見**: 2026-04-27 gemini health check 調査中
**症状**: Shelly の node は `linker64 /node ...` 経由で起動するため、`/proc/self/exe` が `/system/bin/linker64` を返す。Node が `process.execPath` を `/proc/self/exe` から決定するので、**`process.execPath = "/system/bin/linker64"`** になる。

任意の Node CLI が launcher pattern (`spawn(process.execPath, [flags, bundle, ...args])`) で self-relaunch すると、`spawn("/system/bin/linker64", ["--max-old-space-size=...", bundle, ...])` になり、linker64 が `--max-old-space-size=` を unknown flag として `error: expected absolute path: "..."` で reject。

**現状の bypass**:
- gemini: bash function `gemini()` と health check 両方で `GEMINI_CLI_NO_RELAUNCH=true` set + 直接 node に `--max-old-space-size=5557` を渡す (commit 527efd5b で済)
- claude: 該当しない (cli.js 直 invoke、relaunch しない)
- codex: 該当しない (native binary)
- npm: 大半 OK、一部 hook で起動失敗の可能性 (確証なし)

**潜在的影響**: 未知の node CLI / npm package の postinstall script で再発の可能性。今回 user 報告の freeze cascade (Claude Code が isomorphic-git 経由で workaround) も間接的にこの bug が引き金。

**構造的修正方針 (v5.1.1+)**:
1. **Option A**: node binary を patch して `process.execPath` を env var (例: `SHELLY_NODE_REAL_PATH`) から override
2. **Option B**: thin wrapper binary (Kotlin or C) を `~/bin/node` に置き、execve で `/proc/self/exe` を正しい path に偽装してから linker64 経由で本体起動
3. **Option C**: shelly-musl-exec のように direct mmap でロード、linker64 を介さない (大幅 rework)

A が最小コスト、B が cleanest、C が radical。Codex review で意見聞きたい。

**v5.1.0 影響**: gemini bypass 済みなので default user に影響なし。Recovery button が safety net。

**優先度**: P1 (構造的 root cause、v5.1.1 で対処望ましい)
**見積**: A=4h, B=1-2 day, C=3-5 day

---

### bug #121 — paste marker file: app-home injection + forceTuiSource log (post-HN polish)

**発見**: 2026-04-25 Codex review of d9df5312
**症状**: build #709 の paste marker file 検出が `shellPid=unknown` で fail (instanceof TerminalSession が runtime で false)。build #710 で `mSession.getShellPid()` 直接呼び + hardcoded HOME fallback で対応 → 動作確認済み (#710 install 後)。ただし Codex 指摘の通り、構造的に脆弱:

1. **hardcoded `/data/user/0/dev.shelly.terminal/files/home`** は work profile / multi-user / fork 名変更で壊れる
2. **forceTuiSource ログ不足**: marker hit が dynamic HOME 経由か hardcoded fallback 経由か区別できない → diagnostics 弱い

**修正方針 (post-HN)**:
1. **Kotlin から TerminalEmulator construct 時に app home を inject**: `setShellyHome(File)` メソッド追加、`isShellyPasteForceTui()` がそれを優先使用
2. **forceTuiSource 診断**: ログに "dynamic" / "hardcoded" / "injected" の出所を含める
3. **shellPid=0 の根本原因調査**: なぜ instanceof が false になったか (Kotlin/Java vtable / R8 obfuscation / RN bridge wrap?) — 当面は dynamic dispatch で回避できてるが、根本解明は望ましい

**現状**: HN day 1 リリースは hardcoded fallback で動作する。post-HN で構造化。

**優先度**: P1 (機能は動いてる、技術的負債の解消)
**見積**: 30-60 分 (Kotlin から path inject + 診断ログ追加)

---

### ✅ bug #120 — Claude Code 自動追従: verified runtime + staged npm probe

**発見**: 2026-04-25 Codex product review
**症状**: 以前は `@anthropic-ai/claude-code` を最後の pure-JS 形に固定していたため、npm 最新追従が止まっていた。理由は claude-code の Bun SEA 化で legacy `cli.js` patch が効かなくなるため。

**既存インフラ (既に 80% ある)**:
- `__shelly_bg_cli_update` の staging → health-check → atomic promote pipeline
- `$HOME/.shelly-cli/` (current) / `$HOME/.shelly-cli.staging/` / `$HOME/.shelly-cli.prev/` / `$libDir/node_modules` (bundled golden)
- `claude()` bash function の 3-tier dispatch (auto → prev → bundled)

**対応**:
- `shelly-runtime-update.js` が Claude Code musl runtime を newest-first に取得し、ELF shape check + `--version` smoke 後に `~/.shelly-runtime/claude/current` を切り替える。
- `claude()` は verified runtime をデフォルトにし、APK-bundled musl runtime と legacy cli.js tiers を fallback として残す。
- `__shelly_bg_cli_update` は `@anthropic-ai/claude-code@latest` / Gemini latest / Codex latest を staging に install し、compat hook 適用後に 3 CLI の `--version` probe が通った場合だけ live tree に昇格する。
- `.failed-versions` cooldown により、probe で壊れていると判定した upstream version を毎 launch 再取得し続けない。network failure は poison しない。

**現状**: 解決済み。残タスクは実機 smoke (`claude --version` / Bash tool、Codex internal exec、Gemini Shell) の継続検証。

**優先度**: Done
**見積**: —

---

### bug #118 — exec-wrapper: PATH-resolved ELFs skip linker routing (HIGH, audit 2026-04-22)

**発見**: 2026-04-22 Codex security audit of `modules/terminal-emulator/android/src/main/jni/exec-wrapper.c`
**症状**: `execvp()` / `execvpe()` の rewrite 経路で、PATH 解決後の絶対パスが ELF だった場合に `should_linker_exec()` の判定をスキップして `orig(file, argv)` (linker64 を経由しない直 exec) に流れる経路がある。targetSdk >= 29 で SELinux W^X が有効な app-data ELF だと EACCES になり得る。

**現状**: 実機では `claude / codex / gemini` の 3 CLI とも shebang script + bash function dispatch なので、PATH 経由の絶対パス ELF を直接 exec する経路は trigger していない。bionic 側 LD_PRELOAD は `should_linker_exec()` 経由で正しく linker64 routing される。

**修正方針**:
1. `execvp()` / `execvpe()` の **PATH 探索結果に対しても** `should_linker_exec()` を再評価し、ELF なら linker64 経由で再 exec (rewrite が起きていないパスも対象)
2. PATH 探索を内製化するか、`execve()` の rewrite path 経由に統一する

**優先度**: P1 (現状 trigger していないが、今後 PATH 経由 ELF exec を増やすときに踏む)
**見積**: 1-2h (修正 + 既存 exec 経路全部で smoke test)

---

### bug #119 — exec-wrapper: is_elf() TOCTOU window (HIGH, audit 2026-04-22)

**発見**: 2026-04-22 Codex security audit
**症状**: `is_elf(path)` で `open(path, O_RDONLY)` → `read(magic)` → `close()` した後に `execve(LINKER64, [LINKER64, path, ...])` を呼ぶ間に、攻撃者が path を symlink で別ファイルに差し替えると、is_elf 判定済みのつもりが別 binary を linker64 経由で起動できる可能性。
**条件**: 攻撃者が Shelly の app-data ディレクトリ書き込み権限を持っている必要があるので、現状単独では trigger 不能。ただし他の脆弱性 (e.g. パスインジェクション) と組み合わせると weaponize される。

**修正方針**:
1. `open(path, O_RDONLY|O_CLOEXEC|O_NOFOLLOW)` で fd を保持し、その fd から ELF magic / `fstat` を検証したうえで、`linker64 /proc/self/fd/N <args...>` で起動する (TOCTOU 不能 + 既存 linker64 routing を維持)
2. `fexecve()` は linker64 経由を bypass して Android app-data exec 制限に再衝突する可能性があるため、別途検証できるまで修正候補から外す
3. Android 33+ で `/proc/self/fd/N` 経由 exec に追加権限制約がないか実機確認すること

**優先度**: P1 (defense in depth、現状単独 trigger 不能)
**見積**: 2-3h (open flag 変更 + linker64 invocation 経路書き換え + Android 33+ で `/proc/self/fd` permission 検証)

---

### bug #122 — Shelly Doctor UI dashboard (Codex AnyClaw review 2026-04-25)

**発見**: 2026-04-25 Codex AnyClaw 比較レビュー
**動機**: AnyClaw は health/auth/CLI version/proxy 状態を 1 画面 dashboard で出している。Shelly は `shelly doctor` を CLI で持っているが UI 化されていない。HN ローンチ後にユーザーが「動かない」と言ってきたとき、screenshot 1 枚で診断できると support コストが激減する。

**スコープ**:
- ContextBar に小さな ❤️ アイコン (緑/黄/赤) — クリックで Doctor pane を open
- Doctor pane の表示項目:
  - **CLIs**: claude / codex / gemini それぞれの `--version` + 最終 smoke 結果 + 最終 update 時刻
  - **Auth**: `~/.claude.json` / `~/.codex/auth.json` / `~/.gemini/oauth_creds.json` の存在 + 期限 (token expiry が分かる場合)
  - **Runtime**: BASHRC_VERSION, `$HOME/.shelly-cli/` channel (stable/latest), proot rootfs OK
  - **Storage**: `MANAGE_EXTERNAL_STORAGE` 取得状態, `/sdcard` write probe
  - **Network**: DNS / CA / proxy detection
  - **Last error**: `~/.shelly/last-error.json` (新規) — 直近の CLI 起動失敗ログ

**実装ノート**:
- `shelly doctor --json` を追加 (既存 CLI を JSON 出力に拡張)
- AIPane と並列の DoctorPane を pane-registry に追加
- 24h 毎に background tick で health 再計測 (バッテリー impact 注意)

**優先度**: P1 (v4.3.1)
**見積**: 1 日 (CLI extension 2h + pane UI 4h + ContextBar widget 2h)

---

### bug #123 — Bootstrap state machine refactor (HomeInitializer.kt 肥大化)

**発見**: 2026-04-25 Codex AnyClaw レビュー
**症状**: `HomeInitializer.kt` (1500+ 行) と `.bashrc` 生成ロジックが密結合で、phase boundary が曖昧。BASHRC_VERSION up のたびに想定外箇所が壊れる (build #693 〜 #712 のリグレッション系列)。

**修正方針 (Codex 提案)**:
1. **Phase 分離**: bootstrap → install → auth → health → server start を独立 Kotlin class に
2. **State file**: `$HOME/.shelly/bootstrap-state.json` に各 phase の last-success-version + timestamp を記録
3. **Phase logging**: `[ShellyBootstrap][install] start` / `done` を logcat に明示的に出す
4. **Idempotent re-entry**: 部分失敗からの再開を確実に

**注意**: 動いている部分には極力触らない。リファクタは v4.4 (HN 後 1-2 週) に隔離ブランチで。build #712 級のリグレッション再発を絶対避ける。

**優先度**: P2 (v4.4.0)
**見積**: 2-3 日 (設計 1 日 + 実装 + 全 BASHRC フロー回帰テスト)

---

### bug #124 — Node compat preload shim (NODE_OPTIONS=--require)

**発見**: 2026-04-25 Codex AnyClaw レビュー (AnyClaw の bionic-compat.js)
**動機**: Android bionic 上での Node 互換差分 (TLS / fs / signal 等) を 1 か所で吸収できれば、CLI ごとの個別 patch (`patchClaude` / `patchCodex` / `patchGemini` の sed 群) が減らせる。

**慎重論**:
- bug #117 Path A (musl libexec_wrapper) で Claude Bun SEA が解決すれば、shim の必要性は下がる
- `NODE_OPTIONS=--require` は **全 child node プロセスに伝播** する。ユーザーが書いた script にも効くので、副作用が読めない
- 段階導入: まず Gemini だけに opt-in `SHELLY_USE_NODE_COMPAT_SHIM=1` で試す → 1 週間 telemetry → 全展開判断

**修正方針**:
- `$HOME/.shelly/node-compat.js` に必要最小限の polyfill (現在の sed patch を JS 化)
- HomeInitializer.kt で生成
- 各 CLI runner で `NODE_OPTIONS=--require=$HOME/.shelly/node-compat.js` を `_run` env に注入 (opt-in)

**優先度**: P2 (#117 Path A の結果次第で取りやめも検討)
**見積**: 1 日 + telemetry 1 週

---

### bug #125 — Foreground service オンボーディング UX

**発見**: 2026-04-25 Codex AnyClaw レビュー
**症状**: AnyClaw は foreground service / Doze 除外を初回起動時に明示的に説明している。Shelly は既に foreground service は持っているが、ユーザーへの説明 UX がない → Samsung 系のバッテリー最適化で kill されることがある。

**修正方針**:
- 初回起動時の `first-launch-setup.ts` に Step を追加: 「バッテリー最適化から除外してね、理由は CLI が長時間動くから」+ 設定アプリへの直接 Intent
- Settings → System → "Battery exemption status" 表示 (Doctor pane 候補)

**優先度**: P3 (HN 後にユーザーフィードバックで kill 報告が来てから対応)
**見積**: 半日

---

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

### bug #100 — auto-savepoint が Author identity unknown で毎回失敗する

**発見**: 2026-04-17 実機 logcat 解析中 (bug #97 follow-up 調査の副産物)
**症状**: logcat に 3 秒ごとに以下のスタックが繰り返される:
```
E TerminalEmulator: execCommand FAILED: exit=128 stderr=Author identity unknown
E TerminalEmulator:
E TerminalEmulator: *** Please tell me who you are.
E TerminalEmulator:
E TerminalEmulator: Run
E TerminalEmulator:
E TerminalEmulator:   git config --global user.email "you@example.com"
E TerminalEmulator:   git config --global user.name "Your Name"
E TerminalEmulator:
E TerminalEmulator: to set your account's default identity.
E TerminalEmulator: Omit --global to set the identity only in this repository.
E TerminalEmulator:
E TerminalEmulator: fatal: unable to auto-detect email address (got 'u0_a888@localhost.(none)')
E TerminalEmulator:  cmd=git -C '/data/user/0/dev.shelly.terminal/files/home' commit -m "Auto: Created 70
```
**原因**: auto-savepoint 機能 (lib/savepoint-store.ts → git auto commit) が git user.email / user.name を要求する。Shelly は初回起動時に global config を設定していないので、commit が exit=128 で fail する。
**影響**: savepoint が一度も作られないため 💾 インジケータが常に未発火。機能としての価値ゼロ。logcat も常にノイズが出続けるのでデバッグ効率が下がる。
**修正方針** (コスト順):
1. **HomeInitializer の .bashrc 生成時に `git config --global user.email` / `user.name` をデフォルト値で 1 回だけ書き込む** (例: `shelly@localhost` / `Shelly User`)。ユーザーが上書きすれば個人設定が優先。実装 5 分。**採用推奨**。
2. auto-savepoint の git commit に `-c user.email=... -c user.name=...` を inline 注入。JS 側の変更のみで済むが、設定を 2 箇所に持つことになる。
3. auto-savepoint を一旦無効化してユーザーが config 設定後に手動で有効化。UX 劣化。
**優先度**: P1 (v0.1.0 出荷前に対応推奨、5 分作業で直る)
**関連コード**:
- `lib/savepoint-store.ts` (auto commit 呼び出し元)
- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt` (.bashrc 生成箇所)

---

### bug #99 — PORTS が Android 10+ で listener を検知しない (SELinux 再発)

**発見**: 2026-04-17 サイドバー機能検証中、ユーザー実機 (Galaxy Z Fold6 / Android 16)
**症状**: 自前のプロセスが listen しているポート (例: `node -e ... listen(3000)`) が PORTS セクションに全く出ない。
**原因**: Android 10+ の SELinux ポリシーが `/proc/net/tcp{,6}` と `/proc/self/net/tcp{,6}` の両方をアプリから読めないようブロックしている。bug #36 で導入した JNI 直読 (fopen in-process) も blocked:
```
coreutils: /proc/net/tcp6: Permission denied
coreutils: /proc/self/net/tcp6: Permission denied
```
**bug #36 との関係**: #36 は「bash 経由で cat すると exit=1 になる」問題の回避策として JNI 直読に切り替えたが、どちらも SELinux の最終段階で同じ `EACCES` を返すだけで、問題の根っこは解決していなかった。Android 10+ では app_data_file コンテキストからの procfs 読みはそもそも許可されない。
**修正方針候補**:
1. **NETLINK_SOCK_DIAG JNI 実装** (50-100 LoC の C): `socket(AF_NETLINK, SOCK_DGRAM, NETLINK_SOCK_DIAG)` → `inet_diag_req_v2` で listen socket を query。Android の SELinux が Netlink SOCK_DIAG を許可しているか要確認 (`untrusted_app` コンテキストでは塞がれている可能性あり)。
2. **Track own listen() calls**: アプリ自身が呼んだ `listen()` をフックして記録 (`LD_PRELOAD` 不可なので JNI ラッパー経由)。PTY 子プロセスの socket までは見えない。
3. **`ss` バイナリをバンドル + busybox ベースで実行**: 結局 Netlink 経由になるので (1) と同じ問題。
4. **機能廃止 → 別の "デバイスモニター" 機能に置換**: 例えば「アプリが動かしている background process 一覧」「最近 shelly が実行したコマンドの最新 exit code」等。
**現状の影響**: PORTS セクションは常に "No listeners" 表示。サイドバーのノイズになるだけで害は無いが機能していない。
**v0.1.0 では**: サイドバーから隠すか、"Not available on Android 10+" プレースホルダに置き換える小パッチを推奨。
**優先度**: P1 (ユーザー可視の壊れ機能。v0.1.1 で Netlink 実装 or 機能置換を決定)
**関連コード**:
- `store/ports-store.ts` (パース)
- `components/layout/Sidebar.tsx:133-151` (ポーリング)
- `modules/terminal-emulator/android/src/main/jni/shelly-exec.c:372` (`readProcNetFile` JNI)

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

#### bug #142 — Tier-2/3 APK 軽量化リトライ (Codex セッションで)
- 2026-04-27 v5.1.1 candidate (#755, sha `a9172e91`) で実機検証 → **キーボードが立ち上がらない regression** を Z Fold6 で観測。Nacre IME がデフォルト IME 設定下で IME framework は `mInputShown=true mImeWindowVis=3` を返すが描画されず。Tier-1 (#753 / v5.1.0) ではこの問題は出ていない。
- 容疑筆頭: Tier-2 strip sweep (`dec73b30`) の `--strip-unneeded --remove-section=.note.gnu.build-id --remove-section=.comment` が `libcxx_shared.so` / `libterminal-view` 系の何かを壊した可能性、もしくは `libproot.so` / `libtalloc.so` 削除の副作用 (LibExtractor が呼んでないことは確認済み)。Tier-3 (`a9172e91`) は workflow のみ変更で runtime コード未変更なので容疑からは外れるが、両者の組合せで初めて出る可能性も残る。
- **Why not now**: keyboard が出ないと UI が成立しない。Codex に渡してじっくり原因切り分け。サイズ削減の現実的な天井 (8.5G→7.3G で-1.2G、HOME の半分以上は user state) も判明したので、Tier-2/3 を完全には積まずに Tier-2 のみ無害化したリビルド方針も検討対象。
- **次セッションでの調査ポイント**:
  1. Tier-2 だけ #754 (`dec73b30`) を install してキーボード現象を再現するか? → Tier-2 単独の責任切り分け
  2. dlopen エラーは logcat に出てないが、`libcxx_shared.so` / `libreact*.so` が `--remove-section=.note.gnu.build-id` で破損していないか `readelf -S` で section list 比較
  3. TerminalView の `onCreateInputConnection` がランタイムで何を返してるか (RN bridge 側のデバッグログ)
  4. `libproot.so` / `libtalloc.so` 削除が `terminal-emulator` モジュールの何かを暗黙参照していないか (`grep -r "proot\|talloc"` で確認、最初の audit では LibExtractor.kt のコメント以外 hit 無し)
- **状態**: v5.1.0 (#753) にロールバック済み。ブランチ `claude/stoic-hugle-569bef` に Tier-2 (`dec73b30`) と Tier-3 (`a9172e91`) コミット保留中。リバート不要 (main にマージしてないので release には影響しない)。
- **関連 commit**: `dec73b30` (Tier-2), `a9172e91` (Tier-3), `e62df519` (docs)

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

### 📦 OSS integration roadmap — Shelly に載せる候補 10 本 (2026-04-20 調査)

**ソース**: 2026-04-20 並列エージェント 2 本で 20 候補を洗い出し、重複排除 + ROI 評価で 10 本に絞ったもの。詳細レポートは本セッションの history 参照。

**方針**: v0.1.0 RC は現状機能で出す。以下はリリース後の運用フィードバックを見てから順次投入。

---

#### 🥇 Tier S — 即採用レベル (v0.1.1 候補)

| # | OSS | License | Size | 配置 | 理由 |
|---|---|---|---|---|---|
| 1 | [**lazygit**](https://github.com/jesseduffield/lazygit) | MIT | 15MB Go | Terminal pane | 親指で git 操作完結、auto-savepoint 直結 |
| 2 | [**atuin**](https://github.com/atuinsh/atuin) | MIT | 15MB Rust | Command Palette backend + sidebar | シェル履歴を SQLite で全文検索、↑連打の苦行解消 |
| 3 | [**fzf**](https://github.com/junegunn/fzf) | MIT | 3MB Go | Command Palette 裏 + Ctrl-R/Ctrl-T | fuzzy 検索の定番、atuin のフロントにも |
| 4 | [**delta**](https://github.com/dandavison/delta) | MIT | 6MB Rust | git pager + DiffViewerModal | diff を syntax highlight + side-by-side |

**推奨採用順** (v0.1.1): fzf → atuin → lazygit → delta。fzf と atuin は相互強化、lazygit は auto-savepoint と自然に統合、delta は diff viewer の裏で効く。

#### 🥈 Tier A — 差別化 (v0.2.0 候補)

| # | OSS | License | Size | 配置 | 理由 |
|---|---|---|---|---|---|
| 5 | [**chafa + libsixel**](https://github.com/hpjansson/chafa) | LGPL-3.0 / MIT | medium | GLTerminalView 拡張 | **Terminal pane に画像インライン描画**。Termux にできない絵作り ★スクショ映え No.1 |
| 6 | [**whisper.cpp (grammar-constrained)**](https://github.com/ggml-org/whisper.cpp) | MIT | 31MB (tiny.en-q5_1) | キーボード行マイクボタン | 「ホールド → 音声コマンド → 正しい shell 入力」。grammar constraint で誤爆防止 ★**差別化 No.1** |
| 7 | [**glow**](https://github.com/charmbracelet/glow) | MIT | 12MB Go | Markdown pane のターミナル版 | Markdown を TUI 描画、README / docs を terminal から即プレビュー |

#### 🥉 Tier B — 後回しでも良いが効く (v0.3.0+)

| # | OSS | License | Size | 配置 | 理由 |
|---|---|---|---|---|---|
| 8 | [**age / rage**](https://github.com/FiloSottile/age) | BSD-3 / MIT-Apache | 5MB Go/Rust | Settings → Secrets vault | `.env` / transplant credentials を暗号化、Biometric Prompt 連携 |
| 9 | [**dedoc**](https://github.com/toiletbril/dedoc) | MIT | Rust | 新 Docs pane type | DevDocs を terminal で読む、Fold 展開時に右 pane で off-line リファレンス |
| 10 | [**Mosh**](https://github.com/mobile-shell/mosh) | GPL-3.0 | Termux レシピあり | Terminal pane + sidebar hosts | UDP ベースで IP 変更に強い、「閉じて電車で開いても SSH 生きてる」 |

---

#### 🎯 「これだけは載せろ」の 2 本 (Shelly のアイデンティティ形成)

1. **chafa (sixel)** — terminal に画像が出る Android アプリ、Twitter で話題になる
2. **whisper.cpp grammar 音声** — ホールド & 話して CLI 操作、誰もやってない

この 2 本を v0.2.0 で出せれば、Shelly は「Termux の延長」ではなく「**新しいプラットフォーム**」として立つ。

---

#### 外した候補 (理由付き)

- **gitui**: lazygit と重複、UX 上は lazygit が優位
- **zoxide**: atuin に食われる (atuin が cwd context 持つ)
- **gitleaks**: 必要になってから。先に auto-savepoint が成熟してから pre-commit hook 拡張
- **harlequin**: SQLite pane は魅力的だが Python 依存 + Textual + pyarrow が重く v0.2 以降
- **zellij**: tmux と衝突、選択肢過剰
- **blessed-contrib**: Node で可能なので「shelly top」用の小物として軽く、フル機能不要
- **taskwarrior**: 既存の AI 管理と被る、優先度低
- **bandit-wargame**: Chelly (別プロジェクト) 側の教育向け機能として分離が筋
- **Iroh CRDT**: 魅力的だが複雑、まず immortal sessions (bug #65) を片付けてから

---

#### 採用フェーズ全体像

- **v0.1.0**: 現状機能で出荷 (OSS 追加なし)
- **v0.1.1**: Tier S (fzf / atuin / lazygit / delta) — ROI 高、単独で効く
- **v0.2.0**: Tier A (chafa / whisper 音声 / glow) — 差別化、APK サイズ +50-100MB 覚悟
- **v0.3.0+**: Tier B (age / dedoc / Mosh) — 成熟ユーザー向け
- **除外**: 上記 9 件は候補復活時に再評価

**優先度**: P3 (ロードマップ)。実装タスクは各 Tier のリリース milestone に合わせて個別 issue 化。

---

### 🟢 bug #117 — claude-code 2.1.113+ (Bun SEA) を Android bionic で動かす (Path C-bis で end-to-end 成立 2026-04-21)

**背景**: Anthropic が 2.1.113 で `cli.js` 純 JS → Bun SEA (Single Executable Application) バイナリに切り替え。Top-level `bin/claude.exe` は 500-byte の shell stub、実本体は `optionalDependencies` 経由で `@anthropic-ai/claude-code-linux-arm64-musl` (220 MB, ET_EXEC aarch64 musl) or glibc 版が配布される。2.1.112 pin が現状の回避策だが、以下の問題:
- Shelly ユーザーが `npm i -g @anthropic-ai/claude-code@latest` を踏むたび死ぬ (2026-04-21 実際に発生)
- 新機能 (プロバイダ追加 / bug fix / セキュリティ) が取り込めない

**検証済ルート (✅ 起動成功)**:

#### Path C — musl ld-musl 経由で 2.1.116 起動 (2026-04-21 実機確認)

実施コマンド (Termux, uid=u0_a488, bionic 環境):
```bash
# 1. claude-code 2.1.116 (musl variant) 取得
npm pack @anthropic-ai/claude-code-linux-arm64-musl@2.1.116
tar xzf anthropic-ai-claude-code-linux-arm64-musl-2.1.116.tgz

# 2. Alpine musl libc 取得 (ld-musl-aarch64.so.1 が標準 loader として使える)
curl -sL https://dl-cdn.alpinelinux.org/alpine/v3.19/main/aarch64/musl-1.2.4_git20230717-r6.apk | tar xz

# 3. Termux 特有の LD_PRELOAD を避けて ld-musl loader 経由で起動
env -i HOME=$HOME PATH=$PATH ./lib/ld-musl-aarch64.so.1 ./package/claude --version
# → 2.1.116 (Claude Code)
```

`--help` も完全に動作。musl ld は ET_DYN として bionic linker で起動可能、かつ自身が第二段 loader として ET_EXEC の claude を mmap できる (fixed address を回避して relocatable mode でロードする)。bionic linker の `unexpected e_type: 2` 拒否を迂回。

**条件**:
- **Alpine musl libc bundle (415 KB apk, 展開後 ld-musl-aarch64.so.1 = 723 KB)** を APK に同梱
- `env -i` で `libtermux-exec-ld-preload.so` をクリア必要 (Termux 環境の relocation 不整合回避)。**Shelly 環境では `libexec_wrapper.so` を使うため同問題は起きない見込み** (要実機確認)
- **ET_EXEC + 起動時 relocation** なので、Shelly の既存 `_run linker64 $bin` 経路とは別の wrapper が必要 — `_run_musl $bin` 的な関数を `.bashrc` に追加する形

**Path C 実装計画 (v0.1.1 候補)**:
1. CI ワークフローで `@anthropic-ai/claude-code-linux-arm64-musl@latest` + `musl-*-aarch64.apk` を取得
2. `libclaude_musl.so` (claude binary) + `libld_musl.so` (ld-musl-aarch64.so.1) の 2 ファイルを `jniLibs/arm64-v8a/` に配置
3. LibExtractor で `termux-libs/claude_musl` + `termux-libs/ld_musl` に展開 (lib prefix / .so suffix 剥がす既存仕組み流用)
4. `.bashrc` の `claude()` 関数を 2 経路 fallback に変更:
   - Tier A (新 Bun SEA 版): `env -i HOME=$HOME PATH=$PATH $libDir/ld_musl $libDir/claude_musl "$@"`
   - Tier B (既存 2.1.112 node cli.js 版): `_run $libDir/node "$__cli_dir/@anthropic-ai/claude-code/cli.js" "$@"`
5. BASHRC_VERSION bump

**APK サイズ影響**: +220 MB (claude musl binary) + 1 MB (ld-musl) = **約 +221 MB**。現在 596 MB → 817 MB に膨張。codex_tui (154 MB) 込みで **1 GB に近づく**。OTA / initial download UX に悪影響の可能性、**optional download UI** 検討必要。

#### 他候補の判定 (調査完了 2026-04-21)

| Path | 結論 | 根拠 |
|---|---|---|
| **A. patchelf flip ET_EXEC → ET_DYN** | ❌ Blocked | mainline patchelf に `--set-type` なし。[#50270](https://github.com/anthropics/claude-code/issues/50270) で "patchelf でも PHDR エラー" と報告済。Bun SEA は JSC JIT が canonical layout 前提なので hex edit でも壊れる |
| **B. userland stub loader** | ⏸️ 不要 | 2-4 weeks 工数だが Path C で解決するので保留。[tribixbite/bun-on-termux](https://github.com/tribixbite/bun-on-termux) に先行実装あり |
| **✅ C. ld-musl loader** | **動作確認済** | 上記実機検証 |
| **D. proot-less chroot** | ❌ Blocked | `chroot(2)` は CAP_SYS_CHROOT 必須、unrooted Android では不可能 |
| **E. upstream issue** | ❌ 無応答 | [#50270](https://github.com/anthropics/claude-code/issues/50270) 開発者返答なし、6-18 ヶ月待ち想定 |
| **F. opencode-termux Bun port** | ⏸️ 不要 | [guysoft/opencode-termux](https://github.com/guysoft/opencode-termux) で Bun 自体を bionic port する案、Path C で解決するので不要 |

#### 2026-04-21 後続調査: 対話モード hang の原因は DNS (musl libc の `/etc/resolv.conf` ハードコード)

`claude --print "hi"` で timeout した件を strace で追跡:

```
openat(AT_FDCWD, "/etc/hosts", O_RDONLY|...) = ...      # OK
openat(AT_FDCWD, "/etc/resolv.conf", ...) = -1 ENOENT   # ★ここで停止源
sendto(16, "\7+\1\0\0\1\0\0\0\0\0\0\3api\tanthropic\3com\0\0"..., 35,
       MSG_NOSIGNAL, {sa_family=AF_INET, sin_port=htons(53),
                     sin_addr=inet_addr("127.0.0.1")}, 16) = 35
# 127.0.0.1:53 に DNS query → 応答なし → 永久 hang
```

**根本原因**: musl libc は `/etc/resolv.conf` を**ハードコードで参照**する ([musl src/network/resolvconf.c](https://git.musl-libc.org/cgit/musl/tree/src/network/resolvconf.c))。Android では `/etc` が `/system/etc` への readonly symlink で `resolv.conf` が存在しない (bionic は `net.dns1` property で DNS を解決する別経路)。musl はファイルが無いと fallback で `127.0.0.1:53` に問い合わせるが、Android では当然 port 53 で listen してない → query が永遠に待つ。

**`--version` と `--help` が動いた理由**: DNS 解決を必要としないから。対話モード / `--print` は API call で DNS が要るので死ぬ。

**解決方針**: **LD_PRELOAD shim で `openat("/etc/resolv.conf")` を app 配下の書き換え可能パスにリダイレクト**。

```c
// resolv_shim.c (musl-gcc でビルド、Shelly APK に同梱)
#define _GNU_SOURCE
#include <fcntl.h>
#include <string.h>
#include <dlfcn.h>

int openat(int dirfd, const char *pathname, int flags, ...) {
    static int (*real_openat)(int, const char *, int, ...) = 0;
    if (!real_openat) real_openat = dlsym(RTLD_NEXT, "openat");
    if (pathname && strcmp(pathname, "/etc/resolv.conf") == 0) {
        pathname = "/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf";
    }
    // forward to real_openat (fflags + vararg handling)
    ...
}
```

app 側が `$HOME/.shelly-ssl/resolv.conf` に `nameserver 8.8.8.8` 等を書き出す HomeInitializer init step を追加。bionic の DNS は Wi-Fi/セル情報から `getaddrinfo` 内部で自動解決するが、musl に渡す用には明示 nameserver 必須。

**実装 3 点セット (v0.1.1)**:
1. **`libclaude.so`** = musl variant claude バイナリ (~220 MB)
2. **`libld_musl.so`** = Alpine の `ld-musl-aarch64.so.1` (~723 KB)
3. **`libresolv_shim.so`** = 上記 shim (musl-gcc でビルド、~5 KB)

`.bashrc` で:
```bash
claude() {
    LD_PRELOAD=$libDir/resolv_shim $libDir/ld_musl $libDir/claude "$@"
}
```

**自動追従 (v0.1.1)**:
- CI で毎 push 時に `npm pack @anthropic-ai/claude-code-linux-arm64-musl@latest` → 最新バイナリが APK に入る
- 追加で `.github/workflows/build-android.yml` に cron (毎日 UTC 0:00) 追加すれば **Anthropic リリースの 24 時間以内に Shelly も追従**
- Shelly のリリース頻度が CLI の頻度を決める (週 1 〜数週間)

#### 2026-04-21 追加調査: LD_PRELOAD 方式は musl では効かない (custom musl build が必要)

**試したこと**:
1. musl-dev apk (Alpine aarch64) を展開して `/usr/include` を取得
2. Termux の clang で `--target=aarch64-linux-musl -nostdinc -isystem alpine/musl-dev/usr/include` で `resolv_shim_musl.so` を build (3.6 KB、NEEDED 空)
3. `LD_PRELOAD=resolv_shim_musl.so ld-musl ./claude --version` で実行
4. strace で shim が**ロードはされている**ことは確認

**失敗した**: shim ロード後も strace に依然 `openat(AT_FDCWD, "/etc/resolv.conf", ...) = -1 ENOENT` が出る。**LD_PRELOAD の `openat()` シンボルを musl が呼んでいない**。

**根本原因**: **musl libc は自身の syscall を `__syscall_openat` (インライン asm で SYS_openat 直接発行) で実装**している ([musl src/internal/syscall_arch.h](https://git.musl-libc.org/cgit/musl/tree/arch/aarch64/syscall_arch.h))。glibc のように libc 関数 → syscall wrapper で 1 段経由しないので、**LD_PRELOAD で openat を上書きしても resolver は通過しない**。これは musl の設計思想 (static linking first) の副作用。

**唯一残る現実的解決策 (恒久対応は v0.1.1 or PC 環境での検証)**:

**Path C-bis: musl libc を Shelly 専用にカスタムビルド**
- Alpine 公式 musl source を取得
- `src/network/resolvconf.c` の hardcoded path `"/etc/resolv.conf"` を **ビルド時定数で上書き可能に patch**:
  ```c
  #ifndef MUSL_RESOLV_CONF_PATH
  #define MUSL_RESOLV_CONF_PATH "/etc/resolv.conf"
  #endif
  ```
  → `-DMUSL_RESOLV_CONF_PATH=\"/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf\"` で置換
- `./configure --prefix=... && make && make install` で **Shelly 専用 `libc.musl-aarch64.so.1`** を生成
- Shelly の CI で自動ビルド → jniLibs に `libld_musl_shelly.so` として同梱
- APK size +1-2 MB (musl libc は軽量)

**所要工数**: musl build 環境整備 (1-2 時間) + CI 化 (1 時間) + 実機検証 (30 分) = **3-4 時間**

**代替案 (別ルート)**:
- **Path G: `ldconfig` フック** — musl の `ldconfig` 相当で名前解決ファイルパスを注入できないか? 未調査
- **Path H: `getaddrinfo` 自体を shim で完全置き換え** — musl の getaddrinfo は libc 内部呼び出しだが、dynamic 版なら dlsym で介入可能? 未検証

#### 2026-04-21 Path C-bis 実機検証 ✅ end-to-end 成立

**実施 (Windows PC + WSL2 Ubuntu 24.04 + musl.cc cross toolchain)**:
1. `aarch64-linux-musl-cross.tgz` (104 MB, gcc 11.2.1) を musl.cc から取得
2. musl v1.2.4 source を clone (Alpine 3.19 の ld-musl とバイナリ互換)
3. `src/network/resolvconf.c` の `"/etc/resolv.conf"` リテラルを `"/data/data/com.termux/files/home/.shelly-ssl/resolv.conf"` に直接置換 (PoC は Termux HOME に焼き込み。CI build では Shelly path に差し替える)
4. `CC=aarch64-linux-musl-gcc ./configure --target=aarch64-linux-musl && make` → `lib/libc.so` (915 KB, stripped 619 KB)
5. ELF 確認: `Type: DYN (Shared object file), Machine: AArch64` ✅
6. `adb push` で `/sdcard/Download/libc.musl-aarch64.so.1` に配置
7. Termux (u0_a488, bionic 環境) の `bun-sea-test/alpine/lib/ld-musl-aarch64.so.1` を置換
8. `~/.shelly-ssl/resolv.conf` に `nameserver 8.8.8.8; nameserver 1.1.1.1` を書き込み
9. `env -i HOME=$HOME PATH=$PATH TERM=xterm-256color ./alpine/lib/ld-musl-aarch64.so.1 ./musl/package/claude --print "reply with exactly the two letters OK and nothing else"`

**結果**: `OK` が api.anthropic.com から返る (exit code 0, timeout なし) ✅

**補足知見**:
- CFLAGS 経由の `-DMUSL_RESOLV_CONF_PATH=\"...\"` は shell→make→shell の quote 剥がしで死ぬ (gcc は裸の `/data/...` をマクロ値として受け取る)。**source を直接 sed で置換する方式が確実**。
- musl.cc の pre-built toolchain (musl 1.2.4 ベース) で生成した libc.so は Alpine 3.19 の ld-musl と完全互換。PoC 段階では Alpine apk 同梱も不要 (ただし Shelly 本番 APK では他の依存回避のため自前ビルドを CI で焼く)。
- `alpine/lib/ld-musl-aarch64.so.1` と `alpine/lib/libc.musl-aarch64.so.1` は同一ファイル (symlink)。置換は ld-musl 側だけで十分。

**成果物 (PC, uncommitted)**:
- `C:\Users\ryoxr\shelly-musl-poc\libc.musl-aarch64.so.1` (633320 bytes, md5 `38b3db149db03615733ac47be7688ce2`, sha256 `97ccb63e8d7a96ef197b9dbaf16c674f300695d6fb9525c903364772003a6e9c`)
- `C:\Users\ryoxr\shelly-musl-poc\resolvconf.patched.c`
- `C:\Users\ryoxr\shelly-musl-poc\test-path-c.log`

**次のステップ (Shelly 本体への取り込み, v0.1.1 目玉機能化)**:
1. `.github/workflows/build-android.yml` に musl cross-build step を追加
   - alpine:3.19 + qemu-user-static OR musl.cc toolchain on ubuntu-latest
   - path 文字列を **Shelly path (`/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf`)** に切替
2. `npm pack @anthropic-ai/claude-code-linux-arm64-musl@latest` を CI に追加 → `libclaude.so` 生成
3. LibExtractor に `libclaude.so`・`libld_musl_shelly.so` を追加
4. `HomeInitializer.kt` の `claude()` bash 関数を `_run_musl` 相当に書き換え (BASHRC_VERSION 43)
5. HomeInitializer で `$HOME/.shelly-ssl/resolv.conf` を初期生成 (nameserver 8.8.8.8 / 1.1.1.1)
6. APK install → Shelly 実機で `claude --print` 完走確認
7. 毎日 cron で claude-code 最新版を pull → 24 時間以内に Anthropic リリースに追従する自動ビルド

#### 残る未検証項目
1. ~~musl-gcc で shim ビルド~~ → 完了、**LD_PRELOAD 方式は不可** と判明
2. ~~custom musl libc build~~ → **完了、end-to-end 成立** ✅
3. **Shelly 実機 (非 Termux)** で musl binary の dlopen が `libexec_wrapper.so` と干渉しないか (Termux では `env -i` で回避したが、Shelly 経由では `libexec_wrapper` が必ず LD_PRELOAD される)
4. **JIT / signal handler** で crash しないか — 長時間対話試験
5. **Play Store 配布時の execmem policy** — app_data からの実行可能 mmap は neverallow policy に触れる可能性、F-Droid/GitHub Releases なら問題なし
6. **APK サイズ +221 MB (596 MB → 817 MB)** — OTA / 初回 DL UX への影響、optional download UI は v0.1.2 以降

**優先度**: P1 (v0.1.1 目玉機能「Android で最新 Claude Code を動かせる唯一のアプリ」)

**関連**:
- [#50270 claude-code 2.1.113+ broken on Termux](https://github.com/anthropics/claude-code/issues/50270)
- [tribixbite/bun-on-termux](https://github.com/tribixbite/bun-on-termux) — 同戦略の先行事例
- [guysoft/opencode-termux](https://github.com/guysoft/opencode-termux) — Bun 本体 port (Path F)
- [Bun SEA bundler docs](https://bun.com/docs/bundler/executables)

---

### bug #98 — paste エッジケース 3 件 (Claude レビュー指摘, v0.1.1 IME 改善タイミング)

**発見**: 2026-04-16 v0.1.0 外部レビュー (Claude Opus)
**記録すべきエッジケース**:
1. **Samsung Bookcover BT キーボード** — HW キーボードは IME を経由しないため `commitText` を通らない。`KeyEvent` 経由のペーストが pasteViaEmulator をバイパスする可能性。
2. **CJK 変換中の `commitText`** — Samsung/Gboard は変換確定時に `setComposingText→commitText` を連続発火。multi-line 判定 (`length >= 16`) が誤作動するリスク。
3. **TTS / アクセシビリティ入力** — `AccessibilityService` 経由のテキスト挿入は IME を迂回する。
**優先度**: P3 — v0.1.0 では問題にならない。v0.1.1 の IME 改善タイミングで DEFERRED.md から拾い上げる。

---

### Play Store 配布時の SAF 並行実装 (Claude + Perplexity レビュー指摘)

**背景**: v0.1.0 は MANAGE_EXTERNAL_STORAGE で /sdcard を直接読み書き。GitHub Releases / F-Droid 配布では問題ないが、Play Store は all-files-access に対して審査制限がある。
**修正方針**: SAF (Storage Access Framework) ベースの「ファイルをインポート」UI を並行実装して、MANAGE_EXTERNAL_STORAGE がなくても最低限の外部ファイル取り込みが機能するようにする。
**トリガー**: Play Store 配布を本格検討するタイミング。
**優先度**: P3 (配布チャネル拡大は v0.2.0+ の話)

---

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
- **2026-04-16**: v0.1.0 リリース前最終スイープ。Session A/B/C 並列実行で bug #68/#69/#70/#73/#74/#76/#91/#92/#93/#94/#95/#97 を修正。44 orphan files (~300 KB) + chelly/ + components/chat/ + use-ai-dispatch.ts を削除。README を 3 エージェント並列レビュー + 校正 + 校正で磨き上げ。外部 4 LLM (Claude/Perplexity/GPT/Gemini) のレビューを受けて権限説明独立節追加、"only" hedge 全箇所適用、paste エッジケース 3 件 + Play Store SAF を P3 登録、Zustand ストア一覧を CLAUDE.md に図示。
- **2026-04-16**: v0.1.0 Wave L 実機検証セッション。Codex CLI を動かすために Alpine rootfs + proot wrapper を導入したが実機で複数の根本問題が顕在化。**bug #91** (ペースト改行分割、P0)、**bug #92** (/sdcard noexec/read 拒否、P0)、**bug #93** (`bash` コマンドが PATH 外、P1)、**bug #94** (ペースト経路設計がバラバラで同種バグが繰り返し発生、P0 調査)、**bug #95** (Wave L の codex.js sed patch が post-install 内で走らない、P1) を登録。bug #76 を Wave L 検証結果で更新。本日 v0.1.0 を出すのは **bug #91 を根本修正してから** という方針に変更。codex は v0.1.1 送り (claude + gemini の 2 本で v0.1.0 を出荷予定)。
- **2026-04-21**: bug #117 Path C-bis **end-to-end 成立** ✅。Windows PC + WSL2 Ubuntu 24.04 + musl.cc `aarch64-linux-musl-gcc` で musl v1.2.4 を `src/network/resolvconf.c` patch 後に cross-build (633 KB stripped)。Termux 実機で `./ld-musl ./claude --print "reply with OK"` が `OK` を api.anthropic.com から取得。世界初「Android ネイティブで最新 Claude Code (2.1.116) 動作」実機確認。次は Shelly CI への取り込み (musl build step + LibExtractor + HomeInitializer BASHRC_VERSION 43) で v0.1.1 目玉機能化。

---

## 管理ルール (自分への覚書)

- このファイルを編集したらコミット必須 (`docs(deferred): ...`)
- README.md / CHANGELOG.md / MEMORY.md の更新が必要なものは `→ sync:` で明記
- リリース前に P0 を空にすること
- 新セッションで Shelly を触るときは **このファイルを必ず読む**
