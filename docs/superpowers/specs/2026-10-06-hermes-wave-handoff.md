# 2026-10-06 integ/hermes-wave 引き継ぎ（実機テスト + README ヒーロー撮影）

別 PC の Claude Code セッションへの引き継ぎ。**ブランチ `integ/hermes-wave` はまだ main 未マージ。** 実機テスト PASS → main へマージ（fast-forward 可）→ README 素材差し込み、の順で進める。

## 1. このブランチに入っているもの（全てレビュー済み・CI green）

| 機能 | 要点 | 既定 |
|---|---|---|
| MCP 2026-07-28 対応 | `scripts/shelly-mcp-server.js` 旧/新プロトコル両対応、承認待ちは POST 保持（MRTR は `SHELLY_MCP_MRTR=1` のみ） | ON（MCP 有効時） |
| サイドバー細身化・右端枠 | rail 48→38dp、ペイン外周 3dp、CommandKeyBar の Enter 欠け修正、ContextBar `~` / `Native` | — |
| Ask AI（引用） | ターミナル長押し選択メニューに「Ask AI」→ AI ペイン入力欄へ引用 | — |
| llama.cpp ピン留め | `releases/latest` が v0.6.0（Android アセット無し）になり新規 install/Repair が全滅していた → b11433 + sha256 固定、フォールバック付き。**実機で sha256 verified を確認済み** | — |
| MiniCPM5-2B | カタログに Experimental として追加。実機評価で不採用（下記 §5） | opt-in |
| 引き継ぎスレッド | 多段エージェント実行のステップ間受け渡しを `agent:<id>` スレッドに system 行で投稿 | — |
| 端末内 STT | API 33+ の `createOnDeviceSpeechRecognizer`。Groq キー無しでも音声入力可 | Auto |
| ティーチモード | `shelly teach start/stop/cancel/status`、`shelly workflow list/show/run/delete`（BASHRC 244 / shim v6） | — |
| POLICY-001 | 自然言語ルール / trust-ramp（完全一致コマンドの sha256 鍵）/ 自動起動 run は読み取り専用 / Keystore seal | **フラグ OFF**（ConfigTUI「Agent Safety Rules (beta)」） |
| 修正 | 空の AI 返答バブル（abort 競合）、起動時テーマのちらつき、設定/モーダル/カタログ/Sidebar/AgentBar のテーマ追従、Case File ターミナル配色のネイティブ再同期 + レトロPC ANSI パレット、AI 返答の Markdown 表示、複数行コンポーザ、DL 進捗表示、Setup ログの curl 進捗除去、eval スクリプトの curl/node linker64 経由化 | — |

最新ビルド: GitHub Actions run **37424212010**（artifact `shelly-apk`、約 670MB）。アプリ内アップデーターは main しか拾わないので、`gh run download 37424212010` → `adb install -r` で入れる（入れたら PC 側 APK は削除）。

## 2. 実機テスト チェックリスト（ビルド 37424212010）

1. **Case File テーマでコールドスタート**: スプラッシュから直接ベージュ画面（青/黒のちらつき無し）。ターミナル文字が濃いインク色で読めること（`cat` 出力・Python traceback の赤/マゼンタ・プロンプト緑すべて可読）。logcat: `attachSession: refreshed stale emulator palette`。
2. 設定 → Developer → Local LLM がベージュ。MiniCPM5 バッジが「Experimental」。サイドバー/上部バーもテーマ通り。
3. AI ペイン（LOCAL = Qwen3.5-2B を Start しておく）: 回答の `**太字**`・箇条書きが整形表示。連続送信しても空バブルが残らない。
4. Ask AI: 複数行選択 → 引用が複数行コンポーザに整形されて入る（最大 6 行で伸びる）。API キー入力中（伏字）には入らない。
5. teach: `shelly teach start greet` → `echo hi` → `gti status`（失敗）→ `shelly teach stop` → `gti` が除外され保存 → `shelly workflow run greet`。`set -euo pipefail` 下でもシェルが落ちない。
6. 端末内 STT: 設定 → Voice Input → Device にして「Download」→ マイクで日本語発話。
7. POLICY-001（任意）: ConfigTUI で ON → AI ペインで `お金が絡む操作は必ず聞いて` → `OK`、`許可ルールを見せて`、`2番目のルールを取り消して` → 確認。
8. 引き継ぎスレッド（任意）: `@agent まずAIの最新ニュースを3件調べて、次に要約して、最後にXの投稿文を書いて` → 登録 → Sidebar から Run → Chat に `🔁 調査役 → 要約役` 行。

## 3. README ヒーロー撮影（ユーザー指示: ステータスバーはトリミング、一番パンチのあるシーン）

権限: `~/.claude/settings.json` に `adb shell screencap` / `adb shell screenrecord` / `adb pull` の allow が**この PC には**入っている。別 PC では同等の allow をユーザー自身に追加してもらう（CC が自分で権限を広げると auto-mode classifier にブロックされる）。**`adb exec-out screencap` は使わない**（生バイナリがパイプに流れてセッションが落ちた前歴）。必ず端末ファイル → `adb pull` → 端末側削除。

リハーサル済みの筋書き（Fold6 展開、左 Terminal / 右 AI ペイン、LOCAL = Qwen3.5-2B）:
1. `mkdir -p ~/myapp && cd ~/myapp`
2. `printf '{"port": 8080, "debug": true,}\n' > config.json`
3. `python3 -c 'import json;json.load(open("config.json"))'` → `JSONDecodeError: Illegal trailing comma ...`
4. 最終 2 行を長押し → 右ハンドルを下へドラッグして 2 行選択 → **Ask AI**
5. コンポーザに `Why does this fail? How do I fix config.json?` を追記 → 送信 → Qwen3.5-2B が約 25 秒で原因 + 修正手順 + 修正後 JSON を回答（リハ済み・内容良好）
6. 続けて `shelly teach start fix-config` → `sed -i 's/,}/}/' config.json` → `python3 -c ...`（成功）→ `shelly teach stop` → `shelly workflow run fix-config`

**注意**: Ask AI 後は入力フォーカスが AI ペインに残る。ターミナルに打つ前に必ずターミナルをタップしてフォーカスを戻す（一度コマンドを AI チャットに誤送信した）。

ヒーロー画像 = 手順 5 の回答表示直後（左に traceback、右に引用 + AI 回答）。動画 = 手順 3〜6 を `adb shell screenrecord --time-limit 170 --bit-rate 8000000 //sdcard/x.mp4`。

後処理（ffmpeg あり）: 1856x2160 の上端ステータスバー約 90px と下端ジェスチャーバー約 40px を落とす。例:
```bash
ffmpeg -i in.png -vf "crop=1856:2030:0:90" hero.png
ffmpeg -i in.mp4 -vf "crop=1856:2030:0:90,setpts=PTS/1.5" -an -c:v libx264 -crf 23 hero.mp4
ffmpeg -i hero.mp4 -vf "fps=12,scale=900:-1:flags=lanczos" -loop 0 hero.gif
```
撮影後は端末 `/sdcard` 上の png/mp4 を削除。

## 4. 端末上の後片付け

- `/sdcard/Download/shelly-eval/`（評価スクリプト + result.txt）
- `~/myapp`、`~/notes`、`~/teachdemo`（デモ用）
- `~/.local/llama.cpp.bak-b9371`（旧 llama.cpp。新 b11433 で問題無ければ削除）
- `~/models/MiniCPM5-2B-Q4_K_M.gguf`（1.6GB、不採用なので不要ならアプリから削除）
- AI ペイン companion 会話に評価・リハの履歴あり（撮影前に消す。ユーザー承認済み）

## 5. MiniCPM5-2B 評価結果（Fold6, llama.cpp b11433, greedy, thinking off）

| suite | Qwen3.5-2B | MiniCPM5-2B |
|---|---|---|
| router (12) | 100% | 83% |
| tools JSON (8) | 75% | 50% |
| tools native (8) | 88% | 50% |
| summary (5) | 80% | 80% |
| gen tok/s | 11.7–15.7 | 10.4–12.0 |

→ 不採用、Experimental として残す。DEFERRED.md に P3 記録済み。

## 6. 残タスク（このブランチの外）

- 実機テスト PASS 後 `integ/hermes-wave` → main マージ（fast-forward 推奨）→ in-app updater で配布確認。
- ワークツリー/ブランチ整理: `worktree-agent-*`（約 10 本）、`policy-001`、`polish/nits` は全て integ に取り込み済み → マージ後に削除。PC 側 `C:\Users\ryoxr\Shelly-integ` ワークツリー（node_modules は junction）も削除。
- 見送り（DEFERRED 済み or 要追記）: ML Kit Prompt API（Fold6 非対応見込み、minSdk 24→26 判断待ち）、Gemma 4 E2B 端末内 STT（3.8GB・llama.cpp server input_audio 500 issue）、POLICY-001 の既定 ON 化、Cerebras キーが HTTP 402（残高/無料枠切れの可能性、ユーザーに伝達済み）。
- 引き継ぎスレッド: 明示的な「Xの結果をYに渡して」、エージェント削除時の `agent:<id>` スレッド掃除。
