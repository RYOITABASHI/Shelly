# 2026-04-20 Claude Code credentials transplant — 勝利ログ + 再現手順

**成果**: bug #102 (claude OAuth 400) の**実用回避策を確立**。Shelly で Claude Code が完全動作。

**セッション**: 2026-04-20 09:30〜10:04 JST、Termux + ワイヤレス ADB + Shelly 実機でのハンズオン切り分け。

---

## 1. なぜこの文書があるか

夜間の desktop セッション (`62a0110b docs(handoff): claude OAuth #102 root cause findings + workaround menu`) で bug #102 の **原因絞り込みまで**は完了していたが、**実用的な解決までは至っていなかった**。このセッションで credentials transplant を実機で検証し、Shelly 上で "Welcome back" まで到達した。

**この成果が埋もれると、次に Shelly を触る人が再度同じ OAuth 地獄を踏む**。それを防ぐための記録。

---

## 2. 決定的な発見

### 2-1. claude-code の認証状態は 2 つのファイルに分かれている

| ファイル | サイズ | 役割 |
|---|---|---|
| `~/.claude.json` ($HOME 直下) | 32 KB | **onboarding 完了フラグ + アカウント情報の正本** |
| `~/.claude/.credentials.json` | 470 B | OAuth access/refresh token |

**両方揃わないと onboarding 画面が出る**。過去の Termux コミュニティの "just copy `.credentials.json`" アドバイスは**不完全**で、これだけだと Shelly で login method 選択画面に進んでしまう。

### 2-2. 失敗した仮説 (今日試して外れたもの)

| 仮説 | 結果 |
|---|---|
| `/tmp/claude` ハードコードを sed で `$HOME/.claude-tmp` に置換 | 置換成功 (`grep -c "/tmp/claude"` → 0) だが claude の挙動は変わらず 400 |
| `$HOME/bin/xdg-open` に `am start` ラッパーを配置 | 配置成功、`which xdg-open` 通るが claude は依然 manual paste mode に入る |
| `~/.claude/.credentials.json` だけを transplant | onboarding 画面が出て認証未完了扱い |
| `~/.claude/` ディレクトリ全体 (948MB tar) を transplant | 同上。onboarding 画面 |
| その後で `~/.claude.json` も transplant (← **これが最後の 1 ピース**) | ✅ "Welcome back" 画面、日本語 1 往復成功 |

---

## 3. 再現手順

### Termux 側 (claude 既に動く環境)

```bash
# credentials.json + $HOME/.claude.json を抽出
cp ~/.claude.json /sdcard/Download/shelly-claude-root.json
tar czf /sdcard/Download/termux-claude-dir.tar.gz -C ~/.claude .
gunzip -k /sdcard/Download/termux-claude-dir.tar.gz   # Shelly の tar は /bin/zcat 決め打ちなので uncompressed 版を用意
```

> サイズ目安: `.claude.json` 32KB / `termux-claude-dir.tar` 1.8GB (history.jsonl + file-history が大半)。最小構成なら `.claude.json` + `.credentials.json` の 2 ファイルだけでも行けるはず (未検証、要確認)。

### Shelly 側

```bash
# 認証本体の正本を配置
cp /sdcard/Download/shelly-claude-root.json ~/.claude.json
chmod 600 ~/.claude.json

# ~/.claude/ 全体を上書き (Termux 時代のセッション履歴も一緒に入るが問題ない)
cd ~/.claude
tar xf /sdcard/Download/termux-claude-dir.tar   # NOTE: tar xzf はダメ (/bin/zcat not found)

# 動作確認
claude
```

**期待する画面**:
```
Claude Code v2.1.112
Welcome back りょう!
Opus 4.7 (1M context) · Claude Max · info@rebuildfactoryz.com's Organization
/data/data/dev.shelly.terminal/files/home/.claude

> こんにちは
● こんにちは！何かお手伝いできることはありますか？
```

> 最初の起動で「Quick safety check: Is this a project you created or one you trust?」が出たら `1. Yes, I trust this folder` → Enter。以降は出ない。

---

## 4. 制約と運用上の注意

### 4-1. アクセストークン期限

- `~/.claude/.credentials.json` の `expiresAt` は access token の有効期限 (今回は約 9 時間)
- 期限切れ後、claude-code 内部で refresh token を使った自動更新が走る — この時 Cloudflare WAF で弾かれる報告あり ([#47754](https://github.com/anthropics/claude-code/issues/47754))
- 弾かれた場合は Termux で再度 /login を完走 → `.credentials.json` と `.claude.json` を再 transplant

### 4-2. Termux 側の維持

- Termux の claude-code が 2.1.113+ に勝手にアップデートされると cli.js 消失で /login 自体不可能 ([#50270](https://github.com/anthropics/claude-code/issues/50270))
- Termux で `npm i -g @anthropic-ai/claude-code@2.1.112` で pin 必須
- auto-update 防止のため `DISABLE_AUTOUPDATER=1` + `chmod a-w` も検討

### 4-3. /sdcard 中継の権限

- Shelly は bug #92 修正で MANAGE_EXTERNAL_STORAGE 持ちなので /sdcard/Download を読み書き可能
- Termux も同様に /sdcard アクセス可能

### 4-4. uid の違い

- Shelly uid = `u0_a888`、Termux uid = `u0_a488`
- /sdcard は FUSE で両方から見えるので uid 差は問題にならない
- Shelly 側にコピー後 `chmod 600` で所有者 (u0_a888) が読めるようにすれば OK

---

## 5. 恒久修正候補 (v0.1.1 以降)

| 候補 | コスト | リスク |
|---|---|---|
| **A. Shelly 内 credentials import UI** (Sidebar にボタン追加) | 低 (50-100 LoC) | 低 (既存 transplant 手順の UI 化) |
| **B. shelly-claude-auth.js 自作** (PKCE + am start、~250 LoC、codex-login の対称) | 中 | 中 (claude API 変更で壊れる) |
| **C. xdg-open 以外の detector 特定** → 潰す | 低 (調査次第) | 不明 (claude cli.js 2.1.112 の minified コード解析必要) |

**推奨**: **A → C → B の順で試す**。A は実機で動いてる transplant 手順をそのまま UI 化するだけで、ユーザーの敷居を「adb + tar コマンド」から「ファイルピッカー 2 クリック」に下げる。claude 側の仕様に依存しないので安全。

---

## 6. 今日のセッションで判明した周辺事実

- **codex の vendor symlink 回避策**は dev handoff §3 で pipeline 化された (`0e2ac6fa`) ので、新 APK install で恒久化のはず (要再起動後の検証)
- **Shelly の `.bashrc` には `CLAUDE_CODE_TMPDIR` が既に export されている** (`d613f78c` で修正入り) が、claude 2.1.112 cli.js は `os.tmpdir()` を使わないため無効 (dead code)
- **`xdg-open` / `termux-open` 置いても claude は manual paste mode** — Android 検出の signal が別にある。dev handoff §4-1 の「xdg-open が signal」仮説は**間違い** (要補足)
- **Shelly ターミナルから `pm install` 不可** (SELinux INTERACT_ACROSS_USERS_FULL 不足) → adb install 経由が唯一
- **Shelly の tar は gzip 解凍できない** (`/bin/zcat` ハードコード、DEFERRED.md bug #34 類似)

---

## 7. 未解決項目 (v0.1.0 RC 前に対応すべき)

以下は DEFERRED.md 本体で P0/P1 管理:

1. **bug #104 キーボード回避失敗** (P0 最優先、dev handoff §4-3 で診断ログ仕込み済、実機で値確認 TODO)
2. **bug #101 codex TLS rustls-native-certs** (P0、恒久は codex-termux rebuild 多日工程)
3. **bug #106 paste 複数症状** (P0、今日のセッションでも繰り返し遭遇、dev handoff §3 で閾値は 16/newline に revert 済)
4. **bug #103 サイドバー polling** (P0、dev handoff §3 で 15s 緩和済、要実機検証)
5. **bug #102 恒久修正** (P1、本 transplant を UI 化 or self-auth 実装)

---

**作成者**: Opus 4.7 1M context (Termux/Claude Code モバイル)、ユーザー (りょう) との対話セッション
**セッション開始**: 2026-04-20 00:00 JST、このファイル作成時点 10:12 JST
**関連文書**:
- `docs/superpowers/specs/2026-04-20-overnight-fix-handoff.md` (夜間 desktop セッション)
- `docs/superpowers/specs/2026-04-20-desktop-handoff.md` (Termux 側早朝セッション)
- `docs/superpowers/DEFERRED.md` bug #101-#106
