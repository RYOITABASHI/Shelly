# 2026-04-20 デスクトップ Claude Code 引き継ぎ

**前提**: 2026-04-20 モバイル (Termux + Claude Code) で v0.1.0 最新ビルド `d613f78c` を実機インストール・動作検証。途中で**ターミナル入力困難** (bug #104 キーボード回避失敗 + bug #106 ペースト欠落) につき、デスクトップの Claude Code (1M context Opus 4.6+) に作業移譲。

**このファイルが唯一の正です**。DEFERRED.md と併せて読み、他の情報源 (MEMORY.md など) より**優先してください**。

---

## 1. 今日のセッションでやったこと

### 1-1. 最新ビルドのインストール
- Shelly 実機に GitHub Actions 最新 artifact `24630944526` (コミット `d613f78c`) の APK をインストール完了
- pm install は Termux uid から通らず、ワイヤレス ADB 経由で `adb install -r` 成功
- ペアリング: Samsung Wireless Debugging → pair → connect → install

### 1-2. Codex CLI を**動く状態まで**持っていった (一部 hack)
- codex (shelly 版 codex-termux 0.121.0) が `Missing optional dependency @openai/codex-linux-arm64` で起動しない
- 調査で判明: `@openai/codex@0.121.0` の `codex.js` 84-98 行に `existsSync(localBinaryPath)` チェックがあり、vendor ディレクトリが無いと shelly-patcher 済の spawn に到達する前に throw
- **実機で適用した hack**:
  ```bash
  V=~/.shelly-cli/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/codex
  mkdir -p $V
  ln -sf $LD_LIBRARY_PATH/codex_exec $V/codex
  ```
- これで `codex --version` が `codex-exec 0.121.0-termux` を返すようになった
- → **DEFERRED.md bug #105 として登録済、Shelly 本体への恒久修正必要**

### 1-3. Claude CLI の OAuth 400 対処 (失敗)
- MEMORY.md 既知の「`/tmp/claude` ハードコード」問題として cli.js に sed 置換を適用
  ```bash
  F=~/.shelly-cli/node_modules/@anthropic-ai/claude-code/cli.js
  sed -i "s|/tmp/claude|$HOME/.claude-tmp|g" $F
  ```
- 置換は**完全成功** (`grep -c "/tmp/claude" $F` → 0, `grep -c ".claude-tmp" $F` → 7)
- しかし `claude /login` → 認証コード貼付で**同じ "OAuth error: 400"**
- → **DEFERRED.md bug #102 として登録、真因未確定**

### 1-4. 新規 P0 バグを 6 件発見
DEFERRED.md の P0 セクション先頭に追記済:
- **#101** codex TLS: Rust rustls-native-certs が CA bundle env vars 無視
- **#102** claude OAuth 400: sed 後も継続
- **#103** サイドバー polling で UI 遅延
- **#104** ソフトキーボード回避失敗 (最優先)
- **#105** codex vendor ディレクトリ欠落
- **#106** ペースト複数症状 (先頭欠落、複数行の一部消失、長文途中欠損)

---

## 2. 実機に残っている手動 hack (デスクトップ再起動前に確認)

以下は**ライブツリー上 ($HOME 配下)** なので、アプリ再起動 or post-install 再実行で**消える可能性**があります。

| hack | 対象 | 消失条件 |
|---|---|---|
| codex vendor symlink | `~/.shelly-cli/.../codex/vendor/.../codex/codex → $LD_LIBRARY_PATH/codex_exec` | post-install が staging → live 置換で消える |
| cli.js sed (/tmp/claude → .claude-tmp) | `~/.shelly-cli/.../claude-code/cli.js` | post-install で npm install 再実行時に消える |
| .install-marker (未 touch) | `~/.shelly-cli/.install-marker` | 未作成。post-install リトライ許可状態 |

**恒久修正されるまで**、実機再起動後に以下を再適用する必要あり:
```bash
# codex hack 復活
V=~/.shelly-cli/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/codex
mkdir -p $V
ln -sf $LD_LIBRARY_PATH/codex_exec $V/codex

# claude hack 復活
F=~/.shelly-cli/node_modules/@anthropic-ai/claude-code/cli.js
sed -i "s|/tmp/claude|$HOME/.claude-tmp|g" $F

# post-install 止める
touch ~/.shelly-cli/.install-marker
```

---

## 3. デスクトップで優先すべき順序

### Phase 1: ブロッカー解消 (これが片付かないと誰も使えない)

1. **bug #104 ソフトキーボード回避** — **絶対最優先**
   - `KeyboardAvoidingView` を `useAnimatedKeyboard()` (react-native-reanimated 3) 置き換え or 手動 `Keyboard` listener + `WindowInsets.Type.ime()` 取得で自前実装
   - `android/gradle.properties` の `edgeToEdgeEnabled=true` との相性テスト必要
   - 関連: コミット `32cdad50 fix: keyboard avoidance for all panes` が効いていない → 原因調査
   - 触るファイル候補:
     - `components/layout/ShellLayout.tsx` 付近のルート KeyboardAvoidingView
     - `components/layout/Terminal*Pane.tsx` の action bar 配置
     - `app/_layout.tsx` の SafeAreaProvider / insets 設定

2. **bug #106 ペースト複数症状**
   - TerminalView.java の `ShellyPaste:` 診断ログを有効化して全ペースト経路 (commitText / middle-click / pasteViaEmulator) の raw/sanitized/送信 bytes を比較
   - bracketed-paste END トリガ `\e[201~` が commitText 境界で切られていないか確認
   - `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalView.java` の paste 周辺

### Phase 2: CLI 完全動作化

3. **bug #102 claude OAuth 400**
   - Claude Code 2.1.114 にアップグレードして再現確認
   - ブラウザを Chrome に変更してテスト (Samsung Internet 疑い)
   - `strace -f -e openat` で PKCE state の書き込み先特定

4. **bug #101 codex TLS**
   - `github.com/DioNanos/codex-termux` upstream issue 確認
   - 暫定: codex 関数に `SSL_CERT_FILE` 明示展開を追加して効くか検証
   - 根本: codex-termux rebuild で rustls-native-certs → rustls-pemfile + env var に置換

5. **bug #105 codex vendor symlink (恒久化)**
   - A案: `HomeInitializer.kt` の post-install で patchCodex 成功後に vendor symlink 作成
   - B案: `shelly-patcher.js` の patchCodex() に 2 つ目の needle 追加 (throw 分岐コメント化)

### Phase 3: UX / Performance

6. **bug #103 サイドバー polling**
   - polling interval 3s → 15s
   - LibExtractor 冪等チェックを起動時 1 回に削減
   - N+1 execCommand を 1 本に集約

---

## 4. 重要なコードポインタ

| バグ | 触るファイル |
|---|---|
| #104 keyboard | `components/layout/*` (KeyboardAvoidingView 配置), `app/_layout.tsx` |
| #106 paste | `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalView.java` |
| #102 claude | `~/.shelly-cli/.../claude-code/cli.js` (端末側), `modules/.../HomeInitializer.kt` (`.bashrc` 生成) |
| #101 codex TLS | `github.com/DioNanos/codex-termux` (upstream, 別リポ), `HomeInitializer.kt`:436 (codex 起動関数) |
| #105 codex vendor | `modules/.../HomeInitializer.kt` の shelly-patcher.js 生成部 + post-install |
| #103 polling | `components/layout/Sidebar*.tsx`, `store/ports-store.ts`, `store/git-status-store.ts` |

---

## 5. 重要な環境ポインタ (モバイルセッションで判明)

- **Shelly の native lib 展開先は `$LD_LIBRARY_PATH` = `$HOME/../termux-libs/`** (NOT `/data/app/.../lib/arm64/`)
- **LibExtractor は APK の `lib/arm64-v8a/libXXX.so` を `termux-libs/XXX` (lib prefix / .so suffix 剥がして) 展開**
- **`codex_exec` バイナリは `$LD_LIBRARY_PATH/codex_exec` に存在**、サイズ 105 MiB
- **ADB 経由で logcat から** Shelly プロセス (pid は `pidof dev.shelly.terminal`) のログを取得可能
- **Shelly ターミナルからの `pm install` は不可** (SELinux + INTERACT_ACROSS_USERS_FULL 不足) → ADB 経由のみ

---

## 6. 次セッション開始時のチェックリスト

```
[ ] ~/Shelly に cd して git pull
[ ] DEFERRED.md の P0 セクション先頭 6 件 (#101-#106) を確認
[ ] bug #104 (keyboard) から着手
[ ] 実機で hack が生きているか確認 (codex --version が codex-exec 0.121.0-termux を返すか)
[ ] もし消えていたら Section 2 のコマンドで再適用
```

---

## 7. セッション中のやり取り要旨

ユーザー指摘で重要だったもの:
- 「これ多分純正の Codex ではない」 → 完全に正しい。codex-termux (Shelly 独自 Android-native build) と気づけた
- 「改行コピペバグがあるから無理じゃない」 → 複数行コマンドは壊れる (bug #106)
- 「⌃cの反応がめちゃくちゃ遅い」 → logcat で polling ループ特定 (bug #103)
- 「ワイヤレスデバッグ繋いでんのになんでログみれねぇんだよ！」 → その通りでした。adb logcat で即解決 (今後同じミスしないこと)

---

**作成者**: Opus 4.7 1M context (Termux/Claude Code モバイル)
**次担当**: デスクトップ版 Claude Code
**セッションログ**: Claude Code の normal history に残存
