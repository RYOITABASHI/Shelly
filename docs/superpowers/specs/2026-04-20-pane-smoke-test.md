# 2026-04-20 ペイン機能スモークテスト

**対象 APK**: `e85694a3` 以降 (bug #116 multi-pane input routing fix 入り)
**前提**: Shelly は起動済み、claude/codex/gemini transplant 済み (CLI 3/3 動作状態)
**目的**: ペイン追加/削除/フォーカス/レイアウト/分割/全画面 の 10 項目を通し検証。bug #108/#111/#112/#116 を一度に確認する。

---

## チェックリスト

各項目、**✅ 期待通り** / **❌ 症状 (スクショ等)** を記録。症状ある項目は DEFERRED.md に起票。

### 1. ペイン追加 (1→2→3→4)

- [ ] 初期状態: 1 ペイン (TERMINAL)
- [ ] 右上 `+` ボタン → LayoutAddSheet が出る
- [ ] "Add pane" で 2 つ目追加 → 水平/垂直分割
- [ ] 同手順で 3 つ目、4 つ目追加
- [ ] それぞれ独立した `SHELL` セッションを持つ

**失敗パターン**: LayoutAddSheet が開かない / 追加しても反映しない (bug #29/#108 系)

### 2. ペイン cap (4 つで止まる)

- [ ] 4 ペイン開いた状態で `+` ボタン
- [ ] **Alert 表示**: "Cannot add pane (terminal_cap or layout_full)" 相当のメッセージ (bug #108)
- [ ] silent fail ではないことを確認

### 3. ペインフォーカス (bug #116)

**※最重要。今日の修正の主ターゲット。**

- [ ] 2 ペイン split 状態で、**右ペインにフォーカス**がある状態から**左ペインをタップ**
- [ ] 左ペインの SHELL タブが **緑 ● で点灯** に切り替わる (bug #116 の「green dot が動かない」問題)
- [ ] ソフトキーボードで入力 → **左ペインに文字が出る** (右ペインには出ない)
- [ ] 逆方向 (左 → 右タップ) も同様に動作

**失敗パターン**: タップしても入力先が変わらない (bug #116 未解消)

### 4. ペインタイプ切替

各ペインの dropdown で:

- [ ] TERMINAL
- [ ] AI (Claude / Gemini / Codex / Cerebras / Groq / Perplexity のプロバイダ選択)
- [ ] BROWSER (URL 入力して表示)
- [ ] MARKDOWN (ファイル開く)
- [ ] PREVIEW (コード/ファイル選択)

**期待**: 切替後にレンダリングが崩れない、前のタイプの残骸が残らない

### 5. 分割方向 (H / V)

- [ ] ペインヘッダーの split ボタンで **水平分割**
- [ ] **垂直分割**
- [ ] フォールド端末 (Z Fold6) の開閉で自動再配置 (bug `9eb162d9 feat(multi-pane): auto-reorient horizontal splits when Fold closes`)

### 6. ディバイダー (境界ドラッグ)

- [ ] ペイン境界線をドラッグしてサイズ変更
- [ ] neon glow 効果 (bug `2cb26992 feat(ui): refined multi-pane splitter with neon glow + drag feedback`)
- [ ] 極端に小さくしても他ペインが死なない

### 7. レイアウトプリセット (p1/p2/p3/p4)

- [ ] LayoutPicker で p1 ↔ p2 ↔ p3 ↔ p4 切替
- [ ] p4 → p1 ダウングレード時、**破棄件数が表示される** (bug #111)
- [ ] downgrade で session も cascade clean-up される (破棄されたペインの native session も閉じる)

### 8. Maximize (全画面化)

- [ ] 各ペインヘッダーの maximize アイコン → 1 ペインのみ全画面表示
- [ ] 元に戻す → 元のレイアウトに復帰
- [ ] 全画面中にキー入力 → そのペインにだけ届く

### 9. Modal close 後の focus 復帰 (bug #112)

- [ ] Command Palette (Ctrl+Space 的) / Add Repo modal / Settings dropdown などを開く
- [ ] Modal を閉じる → 元のペインにフォーカスが戻る (キー入力待ちになる)
- [ ] タップしなくても次の入力が効く

### 10. 複数ペインでの paste 挙動 (bug #106)

- [ ] 2 ペイン split で左ペインフォーカス → 長文コマンドを paste
- [ ] 左ペインに正しく貼り付く (先頭欠落 / 右ペイン誤配送 無し)
- [ ] 改行入り複数行コマンドで分割 / 部分欠落が起きない

**失敗パターン**: 先頭文字欠落、真ん中行消失、長文途中欠損 (bug #106) / 右ペイン誤配送 (bug #116 関連)

---

## 実施者記入欄

- **実施日時**:
- **APK ビルド**:
- **デバイス**: Galaxy Z Fold6 / Android 16
- **結果サマリ**: ✅ N / ⚠️ N / ❌ N
- **新規発見バグ**:
- **次アクション**:
