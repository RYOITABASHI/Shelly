# Shelly 実機検証チェックリスト (2026-04-12 セッション後)

最新ビルド `24307521971` の APK 検証時に、何をどの順で確認すべきかをまとめたもの。
**順番通りに上から実行すること**。早期に致命的問題が見つかれば下のステップは無意味になる。

## 0. 事前準備

- 既存の Shelly アプリがインストールされていれば**そのまま上書き**で OK (Bundle ID `dev.shelly.terminal`)
- 検証中の不具合は**スクショ**で残す。スクショは `~/storage/dcim/Screenshots/Screenshot_*_Shelly.jpg` に自動保存される

## 1. 起動 + 初回画面 (致命度: ★★★)

| # | 確認項目 | 期待 | NGなら |
|---|---|---|---|
| 1.1 | Shelly を起動 | 黒画面ではなく、Sidebar + AgentBar + ペインが見える | スクショ → Mock 復活疑い |
| 1.2 | TerminalPane に PTY プロンプトが見える | `~$ ` または cwd 付きプロンプトが表示 | スクショ |
| 1.3 | プロンプトの形式 | `~$` で始まる、`\[\e]133;A\a\]` のような literal なし | **NGなら BASHRC_VERSION 14 が効いていない** |

## 2. ターミナル基本入力 (致命度: ★★★)

| # | 操作 | 期待 | NGなら |
|---|---|---|---|
| 2.1 | キーボードで `echo hello` 打つ | `e` `c` `h` `o` `space` `h` `e` `l` `l` `o` がそのまま見える、文字 drop なし | **重要**: スクショ |
| 2.2 | Enter 押す | `hello` が次行に出る → さらに次行に新プロンプト `~$` がすぐ出る | **2回押さないと出ないなら Enter 問題未解決** |
| 2.3 | `git status` 打って Enter | git 出力が出る → 新プロンプトがすぐ出る | |
| 2.4 | BackSpace で `git status` の `s` を1文字削除 | カーソルが1つ戻り `s` が消える | **削除できないなら primeImeBuffer 修正が効いていない** |
| 2.5 | クリップボードから `claude --version` をペースト | **1文字目の `c` も含めて全文が表示される** | **`laude --version` のように1文字目が消えるなら IME 経路の問題** |
| 2.6 | Enter で実行 | `2.1.10X (Claude Code)` が出る | NGなら CLI バンドル問題 |

## 3. PS1 確認 (致命度: ★★)

| # | 操作 | 期待 |
|---|---|---|
| 3.1 | `echo "$PS1"` 実行 | `\[\e[1;32m\]~\[\e[0m\]$ ` のような ANSI 緑のみ。**`\[\e]133;A\a\]` が出てはいけない** |

NGなら `BASHRC_VERSION 14` が効いていない → ユーザー手動で `rm ~/.bashrc && exit` → Shelly 再起動

## 4. 設定モーダル (致命度: ★★)

| # | 操作 | 期待 |
|---|---|---|
| 4.1 | 画面右上の歯車 ⚙ をタップ | 画面右上から SETTINGS パネルがフェードイン |
| 4.2 | DISPLAY セクション | CRT Effect トグル / Intensity スライダー / Font Size S/M/L が表示 |
| 4.3 | Font Size を S にタップ | ターミナル文字が小さくなる |
| 4.4 | Font Size を L にタップ | ターミナル文字が大きくなる |
| 4.5 | LANGUAGE | EN / JA ラジオが表示、現在選択中がアクセント色 |
| 4.6 | AI AGENTS Default | **`Cerebras` 等のドロップダウンとして表示**、タップで5択ピッカー (Cerebras/Groq/Gemini/Claude/Codex) |
| 4.7 | Default を Cerebras に変更 | ピッカーが閉じて Cerebras 表示 |
| 4.8 | API KEYS | Gemini / Perplexity / Groq の設定状況 + MANAGE KEYS リンク |
| 4.9 | 歯車もう一度タップ | パネルが閉じる |

## 5. レイアウトプリセット (致命度: ★★)

| # | 操作 | 期待 |
|---|---|---|
| 5.1 | AgentBar 左端の dashboard アイコン (アクセント色枠) をタップ | LAYOUT ボトムシートが下からスライドアップ |
| 5.2 | 6プリセット表示 | Single / 1+2 Split / 2 Col / 2 Row / 2×2 Grid / 4 Terminal タイル |
| 5.3 | `2 Col` をタップ | シートが閉じて画面が左右2分割、左にターミナル、右に AI ペイン |

## 6. ペインタイプ切替 (致命度: ★★)

| # | 操作 | 期待 |
|---|---|---|
| 6.1 | 右ペインヘッダー左の `[AI ▾]` pill (アクセント色枠) をタップ | PaneSelector ボトムシート出現 |
| 6.2 | 5種類選択肢 | Terminal / AI / Browser / Markdown / Preview |
| 6.3 | `Browser` をタップ | 右ペインが BrowserPane に変わり、ブックマークバー (YouTube/X/GitHub/localhost) が出る |
| 6.4 | YouTube タップ | youtube.com がロードされる |
| 6.5 | 右ペインを `[BROWSER ▾]` から `Preview` に変更 | PreviewPane (Web/Code/Files タブバー) 表示 |
| 6.6 | 右ペインを `[PREVIEW ▾]` から `AI` に戻す | AI ペインに戻る |

## 7. AI ペインの agent 切替 (致命度: ★★★)

| # | 操作 | 期待 |
|---|---|---|
| 7.1 | AI ペインヘッダー中央の `[● XXXX ▾]` agent badge をタップ | AgentMenu ポップアップ表示 |
| 7.2 | リスト | Claude / Gemini / Codex / Cerebras / Groq / Perplexity / Local の 7択 |
| 7.3 | Cerebras 横にドット (色 `#FF6B35`) | アクセント色のドット表示 |
| 7.4 | Cerebras をタップ | バッジが `[● CEREBRAS ▾]` に変わる |
| 7.5 | AI ペイン入力欄に「hello」と入力 → 送信 | ストリーム応答が来る |
| 7.6 | エラーが出た場合 | スクショ → エラーメッセージ全文を読む。「READING TERMINAL バッジが出ているのに実は terminalContext が cerebras に渡っていない既知問題」あり |

## 8. クロスペインインテリジェンス検証 (致命度: ★★)

| # | 操作 | 期待 |
|---|---|---|
| 8.1 | 左ターミナルで `ls /nonexistent` 打って Enter | `ls: cannot access ...: No such file or directory` エラー |
| 8.2 | 右 AI ペイン (Cerebras) に「このエラーを直して」と入力 | ターミナルのエラー内容を読んで適切な対処を提案 |
| 8.3 | NG: 「ターミナルが見えません」のような応答 | **system prompt に terminal context が注入されていない既知問題** |

## 9. ペイン操作 (致命度: ★)

| # | 操作 | 期待 |
|---|---|---|
| 9.1 | ペインヘッダー右の ⊞ (split) | SplitMenu 出現、Direction → Tab を選んで分割 |
| 9.2 | ペインヘッダー右の ⤢ (maximize) | そのペインが全画面化 |
| 9.3 | もう一度 ⤢ | 元のレイアウトに戻る |
| 9.4 | ペインヘッダー右の ✕ (close) | ペインが消えて、残ったペインが拡張 |
| 9.5 | 2ペイン時、境界線をドラッグ | リアルタイムにリサイズ |
| 9.6 | 境界線をダブルタップ | 50/50 に均等分割 |

## 10. AddPaneSheet (致命度: ★)

| # | 操作 | 期待 |
|---|---|---|
| 10.1 | AgentBar の `+` ボタンをタップ | ADD PANE シート出現 |
| 10.2 | 6選択肢 | Terminal / AI Chat / Browser / Preview / Markdown / File Tree |
| 10.3 | Preview をタップ | 現在の focused pane が分割されて Preview ペインが追加 |

## 11. CRT エフェクト (致命度: ★)

| # | 操作 | 期待 |
|---|---|---|
| 11.1 | 設定で CRT Effect を ON にする | scanline が薄く乗る |
| 11.2 | Intensity を 50% に上げる | scanline は変わらず、フォスファーグリーンが濃くなる、ビネットも強まる |
| 11.3 | OFF にする | エフェクト消える |

## 12. 既知の積み残し (検証不要)

これらは今日のセッションで対応していないので、検証してもエラーが出るのは想定通り：

- **Groq / Gemini / Cerebras / Claude / Perplexity の system prompt 注入未実装** — ライブラリ側が hardcoded system content を使用していて、外部注入できない。次セッションで対応予定。今日のビルドでは **READING TERMINAL バッジは出るが、実際にはターミナル内容は AI に伝わっていない**
- **Local LLM (llama-server)** — バンドルされていないので Local 選択時はエラー
- **Cloud OAuth (Dropbox/OneDrive)** — client_id プレースホルダーのまま
- **Z Fold6 ヒンジ折り畳み** — 検知ロジックは入っているが実機ハードウェア未検証

## NGの場合の対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 1.3 PS1 が `\[\e]133` のまま | BASHRC_VERSION 14 が効いていない | ユーザー操作で `rm ~/.bashrc && exit` → Shelly 再起動 |
| 2.2 Enter 2回必要 | 1.3 と同じか、別の描画タイミング問題 | スクショ + ログ収集 |
| 2.5 ペースト1文字目消失 | IME composing 経路の追加バグ | スクショ + 使用キーボード名 |
| 4.1 設定パネルが出ない | Modal レンダリング失敗 | スクショ |
| 7.5 AI ペインが動かない | API キー未設定 or dispatcher 経路 | エラーメッセージ全文 |

## 検証完了後

すべて緑なら以下を memory に追記：

```markdown
## 2026-04-12 実機検証結果
- すべての項目 OK
- 残課題: system prompt 注入 (次セッション)
```
