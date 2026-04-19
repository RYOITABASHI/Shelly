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

### bug #101 — codex TLS: Rust rustls が CA bundle env vars を見ない

**発見**: 2026-04-20 `codex "hello"` 実行時、logcat transcript 再描画で判明
**症状**: codex-termux バイナリ (0.121.0-termux) が OpenAI API に接続しようとして
```
ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket:
IO error: no native root CA certificates found (errors: []), url: wss://api.openai.com/v1/responses
ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header,
url: https://api.openai.com/v1/responses
```
**原因**: Shelly は `$SSL_CERT_FILE` / `$CURL_CA_BUNDLE` / `$NODE_EXTRA_CA_CERTS` / `$REQUESTS_CA_BUNDLE` を `.bashrc` で export しているが、**Rust の `rustls-native-certs` は OS のネイティブ証明書ストアを直接読む設計** で env var を見ない。Android にはそのネイティブストアが無いので no native root CA certificates。
**関連コミット**: `6f0b4e16 feat(v39): Mozilla CA bundle + codex-login device-auth` で Mozilla CA bundle を導入したが codex-termux binary 側で使用されていない可能性
**次アクション**:
1. codex-termux に env var `SSL_CERT_FILE` / `CA_BUNDLE` を見るオプションがあるか upstream (github.com/DioNanos/codex-termux) を確認
2. もしくは codex-termux を rebuild して rustls-native-certs を `rustls-pemfile` + env var 経由に置換
3. 暫定: `codex` 関数で `SSL_CERT_FILE` を明示的に変数展開してから exec
**優先度**: P0 (codex CLI 完全に動かない)

---

### bug #102 — claude OAuth 400 は sed 後も継続

**発見**: 2026-04-20 claude /login 実機検証
**経緯**:
1. MEMORY.md 既知の `/tmp/claude` ハードコード対処として `sed -i "s|/tmp/claude|\$HOME/.claude-tmp|g"` を `~/.shelly-cli/.../cli.js` に適用
2. `grep -c "/tmp/claude"` → 0, `grep -c ".claude-tmp"` → 7 で置換は完全完了
3. しかし `claude /login` → 認証コード貼付 → **同じ "OAuth error: Request failed with status code 400"**
4. `CLAUDE_CODE_TMPDIR=$HOME/.claude-tmp` は bashrc で export 済、mkdir 済 (bug d613f78c 最新ビルドで修正入り)
**真因未確定**. 可能性:
- cli.js とは別の場所 (子プロセス、mcp サーバー) が PKCE state を書いている
- Samsung Internet ブラウザが OAuth URL の state / code_challenge を rewrite している (loopback callback で verifier ミスマッチ)
- Claude Code 2.1.112 は古い、2.1.114 にしたら直る可能性
- `claude` 関数のプロセス分離でメモリ上の古いコードが生きている (sed 後に再起動しても転写が走った後なので新コードが使われているはず)
**次アクション**:
1. claude を 2.1.114 にアップグレードして再現確認
2. Chrome で /login 試す (Samsung Internet 疑い)
3. `strace -f -e openat` or Android の `statvfs` trace で PKCE state の実際の書き込み先を特定
**優先度**: P0 (claude CLI 認証不可)

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

---

## 管理ルール (自分への覚書)

- このファイルを編集したらコミット必須 (`docs(deferred): ...`)
- README.md / CHANGELOG.md / MEMORY.md の更新が必要なものは `→ sync:` で明記
- リリース前に P0 を空にすること
- 新セッションで Shelly を触るときは **このファイルを必ず読む**
