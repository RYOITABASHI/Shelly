# 帰宅後の検証チェックリスト

> 最後の場所からスムーズに続きができるよう、状況と手順をまとめておく。
> AI セッションが変わっても context なしで再開可能。

## 💡 すぐ確認したい状態 (30 秒)

```bash
# ターミナルで (PC 側):
/tmp/gh-cli/bin/gh.exe run list --repo RYOITABASHI/Shelly --limit 3

# 期待: 一番上が success
# 直近の最新 APK は UI/theme 反映後の build を使う
```

自動 install script が走ってたはず:
```bash
# 結果確認:
cat "C:\Users\info\AppData\Local\Temp\claude\C--Users-info-Desktop\d40507f4-6c36-4d6e-8d20-fb41d38e4179\tasks\b4d8gz945.output"
# 末尾に "=== AUTO-INSTALL COMPLETE ===" があれば install 済み
```

## 🎯 検証 1: 最新 APK の CLI ハーネス

**前提条件 - 事前確認**:
- Shelly の最新 APK をインストール済み
- `shelly-update-clis --force` が実行できる
- `claude --version` と `codex --version` を更新後に再確認する

**手順**:
1. `cat ~/.bashrc_version` を確認
2. `claude --version` を実行
3. `codex --version` を実行
4. `shelly-update-clis --force`
5. `tail -f ~/.shelly-runtime/update.log`
6. `claude --version`
7. `codex --version`
8. AgentBar の履歴アイコンを開き、Recent Logs モーダルで直近出力を確認
9. Copy / Share をそれぞれ 1 回ずつ試す

**期待**:
- Claude は Path C-bis か runtime latest に乗る
- Codex は最新 `codex-termux` を返す
- 失敗時は `~/.shelly-runtime/update.log` の内容を起点に追う
- Recent Logs モーダルに最新の端末出力が表示され、スクロールと共有ができる

## 🎯 検証 2: Stage 2 Issue 作成フロー (本日の優先課題)

**前提条件 - 事前確認**:
- Shelly 起動済み
- `shelly-cs auth` 認証済み
- AI Pane に Groq API キー設定済み

**手順**:
1. `+` → Ask Shelly ペインを開く
2. 質問: `VR 対応してる？` (NOT_AVAILABLE 確実に引き出す質問)
3. 応答完了後、❌ **未実装** バッジの下に `📝 GitHub Issue を作成` ボタンが出る
4. ボタンタップ → slide-up modal 開く
5. Title + Body が pre-populate されている (前回までは表示OK)
6. **[Create] タップ** ← これが前回 "Not authenticated" で失敗
7. 期待:
   - Spinner 出る
   - Modal 閉じる
   - **`✓ Issue #NN を作成しました [View]`** 緑 chip 表示
   - [View] タップ → Shelly の Browser Pane で issue が開く

**もし失敗 (Not authenticated のまま)**:
```bash
# logcat で原因確認
"/c/Users/info/Downloads/platform-tools-latest-windows/platform-tools/adb.exe" logcat -d -s ReactNativeJS:* 2>&1 | grep "github-issues\|token read" | tail -20
```

期待ログ:
- `[github-issues] token read via execCommand` (fix が効いた)
- または `[github-issues] token read via FileSystem` (どちらでもOK)

成功すれば → **Phase ② 完全完了 → `v0.1.0-rc2` tag 切り**。

## 🎯 検証 3 (optional): SSH Day 1 (feat/ssh-tunneling ブランチ)

まだ main にマージしていない branch。確認したければ手動 build 必要。

```bash
# 手動 trigger:
/tmp/gh-cli/bin/gh.exe workflow run "Build Android APK" --repo RYOITABASHI/Shelly --ref feat/ssh-tunneling
```

build 終了後、APK install して:
```
shelly-cs doctor
# → 末尾に "SSH tunneling: (not installed yet)" 出るか確認

shelly-cs ssh sturdy-cod-557j97jgggjc7p4w
# → "First-time SSH tunneling setup: installing ~1.5 MB of deps..."
# → npm install 走って 30-60 秒
# → "Tunneling deps ready"
# → "Day 1 checkpoint — tunnel protocol implementation lands next"
```

npm install が **bionic node 上で成功するか**が Day 1 の要。
失敗した場合:
- `websocket → ws` override が効いてない → `ws@^8` を直接 require 強制
- `ssh2` の `cpu-features` ネイティブ addon が install 失敗 → `--omit=optional` 追加

## 📌 現在地まとめ

### main ブランチ
```
84bc4198  fix(ask-pane): token read falls back to execCommand  ← build 中 (自動 install 予定)
842dafde  feat(ask-pane): Stage 2
a43c0adf  docs: Ask Pane Stage 2 + SSH tunneling
 tag: v0.1.0-rc1 (Released, APK 添付済み)
6de28e13  feat(ask-pane): Stage 1
```

### feat/ssh-tunneling ブランチ
```
677458e8  feat(ssh-tunneling): Day 1 — lazy-install scaffold
2936caa6  docs(ssh-tunneling): Day 1 commit plan
(main a43c0adf から分岐)
```

### 次のマイルストーン
- 🔵 Stage 2 修正 verify → `v0.1.0-rc2` tag
- 🟡 SSH Day 1 verify → Day 2 着手 (tunnel 接続)
- 🔴 SSH Day 2-5 実装 (3-5 日工程)

## 🆘 トラブル時の連絡先情報

**ビルド失敗**:
```bash
/tmp/gh-cli/bin/gh.exe run view <RUN_ID> --repo RYOITABASHI/Shelly --log-failed
```

**adb 切断**:
ワイヤレスデバッグ設定でペアリングし直し → コード + IP 貼り付け。

**scrcpy 起動**:
```bash
cd "/c/Users/info/Downloads/scrcpy/scrcpy-win64-v3.3.4" && ./scrcpy.exe
```

**Rate limit (GitHub API)**:
gh CLI 経由で叩く (認証済みなので 5000 req/h):
```bash
/tmp/gh-cli/bin/gh.exe api /repos/RYOITABASHI/Shelly/...
```
