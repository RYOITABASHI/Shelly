# 2026-04-13 実機検証チェックリスト

最新ビルド(`94d5df52` 以降 / 24320807909 系列)をインストールした後に上から順に実行する。

**致命度**: ★★★ = ブロッカー、★★ = 重要、★ = 軽微

---

## 0. 事前準備

- [ ] **API キー** Cerebras は設定済み(前回確認)。Groq も時間があれば `https://console.groq.com/keys` で取得して入れる。
- [ ] **実機の向き**: 縦固定 or 自動回転 OFF(YouTube fullscreen で勝手に回転されると比較しにくい)
- [ ] **Termux は別アプリとして裏側で走らせておく**(logcat 取得用)

---

## 1. 起動 + Shelly プリセット (★★★)

| # | 確認項目 | 期待 | NG時 |
|---|---|---|---|
| 1.1 | Shelly を起動 | Sidebar + AgentBar + ペインが見える、起動ロゴはなし or 短い | ログ収集 |
| 1.2 | 初回表示のフォント | **Silkscreen ドット文字**(サイドバーの `SHELLY` `FILE TREE` `DEVICE` 等) | 1.3 で検証 |
| 1.3 | `Settings → Display → Font` を開く | 4 個のセグメント: **`Shelly / Silk / 8bit / Mono`**、`Shelly` が active ハイライト | preset が入ってない |
| 1.4 | ペインヘッダー `~$` プロンプト | **teal ネオン発光**(radius 10 くらい、目でハッキリ光る) | neon-glow 設定ミス |
| 1.5 | Sidebar `SHELLY` repo active 行 | **teal + neon 発光** | neon 未適用 |

## 2. モック色検証(★★★)

mock-1 を並べて比較。順番:

| # | 場所 | 期待色 |
|---|---|---|
| 2.1 | `YOU` ラベル(AI ペイン) | **青 #60A5FA + blue neon** |
| 2.2 | `CLAUDE` assistant ラベル | **紫 #A78BFA + purple neon** |
| 2.3 | `+` diff 行(ACCEPT/REJECT のある緑行) | **#4ADE80 green + 薄緑塗り** |
| 2.4 | `-` diff 行 | **#F87171 red + 薄赤塗り** |
| 2.5 | `⚠ BASH:` warning | **#F59E0B amber + 琥珀塗り** |
| 2.6 | `ALLOW` ボタン | **amber bg + amber text** |
| 2.7 | `DENY` ボタン | 灰 |
| 2.8 | `RUNNING` バッジ(TASKS) | **amber** |
| 2.9 | `LINKED` バッジ(CLOUD) | **green** |
| 2.10 | `CONNECT` バッジ | 灰 |
| 2.11 | FileTree の folder/file icon | **blue #60A5FA** |
| 2.12 | FileTree `README.MD` | **red #F87171** |
| 2.13 | Ports `:3000 NEXT.JS` | **green dot** |
| 2.14 | Ports `:8081 EXPO` | **sky dot #38BDF8** |
| 2.15 | Code preview の `import/from/const` キーワード | **紫** |
| 2.16 | Code preview の `'react'` 文字列 | **pink #EC4899** |

## 3. ランタイム切替(★★★) — PTY を殺さない確認

**これが最重要**。プリセット切替で vim が消えたら設計失敗。

- [ ] **Step 1**: ターミナルペインで `vim ~/test.txt` を実行
- [ ] **Step 2**: `i` で insert モードに入り、何か 3 文字打つ (`abc`)
- [ ] **Step 3**: **Settings → Display → Font → `Silk`** をタップ
  - 期待: UI 全体が旧パレット(緑一色系)に切替え、フォントは Silkscreen のまま、`vim` の画面は**残ったまま**、カーソル位置・`abc` 文字列・insert モード全部保持
  - NG: vim が消える、ターミナル再起動、ペインが閉じる
- [ ] **Step 4**: `Shelly` に戻す → モック色に戻る、vim はまだ insert モードで `abc`
- [ ] **Step 5**: `8bit` → PressStart2P になる(ピクセル強め)、vim 生存
- [ ] **Step 6**: `Mono` → システム monospace、vim 生存
- [ ] **Step 7**: `Shelly` に戻す → モックに戻る
- [ ] **Step 8**: vim を `:wq` で抜ける → 正常終了

## 4. AgentBar (★★)

- [ ] **4.1** 左上の `[⊞]` (layout preset) ボタンがアクセント緑枠付きで見える
- [ ] **4.2** その右に `[+]`(AddPane)ボタン、同じアクセント緑枠、32×28 くらい
- [ ] **4.3** 右上に `[🔍][⚙]`
- [ ] **4.4** `[+]` タップ → AddPaneSheet → Terminal / AI / Browser / Markdown / Preview / File Tree の 6 択
- [ ] **4.5** 歯車 → SettingsDropdown 右からフェードイン

## 5. ペインヘッダー統合(★★)

a36d51ab でヘッダー 3 段を 1 段に統合した効果確認:

- [ ] **5.1** ペインヘッダーは **1 段のみ**(以前の `shelly_` ロゴ + tab + CLI info bar の 3 段じゃなく、1 行に pane-type pill + CLI タブ + actions)
- [ ] **5.2** terminal ペインの pill は **`[>_ TERMINAL ▾]`**(`CLAUDE CODE` ではない)
- [ ] **5.3** AI ペインの pill は **`[✨ AI ▾]`**
- [ ] **5.4** AI ペインの agent badge(ヘッダー中央)に **`[● CEREBRAS ▾]`**(cerebras 選択済の場合)
- [ ] **5.5** 右端に `[⊞][⤢][✕]` split/maximize/close

## 6. CLI タブ(★★)

- [ ] **6.1** terminal ペインヘッダー中央に `[● SHELL][+]` — PaneCliTabs
- [ ] **6.2** `[+]` タップで 2 個目のタブ作成
- [ ] **6.3** タブをタップで active 切替
- [ ] **6.4** active タブ横の `[×]` で閉じれる(最後 1 個は閉じれない)

## 7. マルチペインで UI 収まる(★★)

- [ ] **7.1** `[⊞]` → `2 Col` 選択 → 左右 2 ペイン
- [ ] **7.2** ペイン 2 つとも ヘッダーが pane 幅内に収まってる(`⊞ ⤢ ✕` がはみ出ていない)
- [ ] **7.3** `4 Terminal` に切替 → 4 分割、各ペインのヘッダーがアイコンだけ or short label で収まる
- [ ] **7.4** 境界線に **accent teal の 2px 線 + 3-dot grip** が見える
- [ ] **7.5** grip を長押しドラッグ → ペイン幅が可変
- [ ] **7.6** grip をダブルタップ → 50/50 に戻る

## 8. AI Edit ゴールデンパス(★★)

**API キー(Cerebras)設定済み前提**。

- [ ] **8.1** マルチペイン 2 Col: 左=Terminal、右=AI ペイン
- [ ] **8.2** 右ペインの agent badge で **Cerebras 選択**
- [ ] **8.3** Sidebar `FILE TREE` から `components/panes/AIPane.tsx` を tap
- [ ] **8.4** 画面のどこかに PreviewPane の Code タブが開き内容表示(新規 pane 追加 or 既存 preview pane に送られる)
- [ ] **8.5** Code タブツールバーの `[✨ AI]` ボタンタップ
- [ ] **8.6** AI ペインに system message `Staged X for AI editing` 表示
- [ ] **8.7** AI ペイン入力欄に「一番最初の関数のコメントを日本語にして」と入力 → 送信
- [ ] **8.8** Cerebras がストリーム応答 → unified diff が返ってくる
- [ ] **8.9** InlineDiff で diff が neon 強調表示される (+ 緑 - 赤)
- [ ] **8.10** `Accept All` ボタンタップ
- [ ] **8.11** toast `Applied to file` or `Copied to clipboard` が出る
- [ ] **8.12** Code タブが自動リロードして変更が反映されてる
- [ ] **8.13** 左のターミナルで `cat components/panes/AIPane.tsx | head -30` → 変更確認

**NG パターン**:
- `Could not apply diff — context mismatch` → apply ロジックのバグ
- 何も起きない → Accept 経路未配線
- AI が diff 形式で返さない → system prompt 問題

## 9. YouTube フルスクリーン(★)

- [ ] **9.1** Browser ペインで `YOUTUBE` ブックマーク tap
- [ ] **9.2** 適当な動画を選ぶ
- [ ] **9.3** 再生 → 動画の**右下のフルスクリーンアイコン**タップ
- [ ] **9.4** **Shelly のブラウザペインが画面全体に拡大**される(他のペイン/Sidebar が消える)
- [ ] **9.5** ナビゲーションバーが隠れる(Android 下部の 3 ボタン)
- [ ] **9.6** 動画はペインサイズ = 画面サイズで再生
- [ ] **9.7** 動画上の UI で戻るボタン or 左上の × タップ
- [ ] **9.8** Shelly の元のレイアウトに戻る、ナビゲーションバーも戻る

**注意**: Android 15 で横向き強制は無効。**縦のまま拡大する**のが正解(横向きにはならない)。

## 10. Desktop UA(★)

- [ ] **10.1** Browser ペインで右端の `📱` アイコンタップ
- [ ] **10.2** `🖥` に変わり、accent 色ハイライト
- [ ] **10.3** YouTube を再読込 → **デスクトップ版 UI** (横に多数サムネ並ぶ)
- [ ] **10.4** `🖥` → `📱` に戻す → モバイル版

## 11. 空ペイン状態復帰(★)

- [ ] **11.1** 全ペインを一つずつ閉じる → 最後の 1 個で `[×]` を押すと**閉じれない**(無反応)
- [ ] **11.2** (空状態が発生する経路がなければこのテストはスキップ)
- [ ] **11.3** もし空状態になったら、中央に `[Terminal][AI Chat][Browser]` の 3 ボタン CTA が出る

## 12. 音声対話(★)

- [ ] **12.1** ターミナルペインの mic ボタンを**長押し 350ms**
- [ ] **12.2** VoiceChat モーダルが開く
- [ ] **12.3** `Tap to talk` 表示 → 録音 → 「lsを実行して」と発話
- [ ] **12.4** Groq API キー設定済みなら文字起こし → コマンド実行
- [ ] **12.5** 結果が自動で読み上げ(日本語 TTS)
- [ ] **12.6** `×` で終了

## 13. タブ× クラッシュ確認(★)

- [ ] **13.1** 3 タブ作る (`SHELL` x 3)
- [ ] **13.2** Active タブの `[×]` タップ → そのタブ消える、**クラッシュしない**
- [ ] **13.3** 残り 2 個の active タブを `[×]` タップ → 消える
- [ ] **13.4** 最後の 1 個は `[×]` 出ない(UI 上)

---

## NG 時の対処

| 症状 | 最初にやること |
|---|---|
| Shelly preset が出ない | `cat settings-store.ts`, `grep 'shelly'` uiFont default 確認 |
| フォントが Silkscreen じゃない | Settings → Display で Font が `Shelly` 選ばれてるか |
| 切替で vim 消える | logcat で `Shell layout` 再マウントログ、PTY destroy ログ |
| AI Edit で diff 出ない | AI 応答が unified diff format か確認、system prompt 注入 log |
| YouTube fullscreen 動かない | logcat に `shelly:fs:on` postMessage が出てるか確認 |

## 検証完了後

全項目 OK なら memory の `shelly-session-20260413.md` に以下を追記:

```markdown
## 実機検証結果 (2026-04-13)
- 全 13 セクション合格
- 懸念: [あれば記載]
```

不合格あれば **GitHub Issue** 化 or 直接修正コミット。
