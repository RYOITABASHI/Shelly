#!/data/data/com.termux/files/usr/bin/bash
# cross-pane-single.sh — 素材2: シングルペインのクロスペイン参照（10秒）
#
# Terminal タブでエラー → Chat タブに切り替え
# → 「さっきのエラー直して」→ AI応答 → ActionBlock → Run

source "$(dirname "$0")/common.sh"

banner "素材2: シングルペイン クロスペイン（10秒）"

echo "📋 事前準備:"
echo "   1. シングルペインモード（折りたたみ or 縦表示）"
echo "   2. Terminal タブにエラーが表示されている:"
echo "      \$ python test.py"
echo "      AssertionError: expected 200, got 404"
echo "   3. 言語: 日本語"
echo ""

wait_for "Terminal タブにエラーが出ている？準備OK？"
countdown 3

start_recording "cross-pane-single"

# ステップ1: Terminal のエラーを2秒見せる
sleep 2

# ステップ2: Chat タブに切り替え
wait_for "Chat タブをタップして切り替え"

# ステップ3: 日本語入力
sleep 0.5
wait_for "Chat の入力欄をタップ"
echo "⌨️  入力中: さっきのエラー直して"
paste_text "さっきのエラー直して"
sleep 0.5

# ステップ4: 送信
wait_for "送信ボタンをタップ"

# ステップ5: AI応答を待つ
wait_for "AI の応答 + ActionBlock が表示されるまで待つ"

# ステップ6: 実行
wait_for "ActionBlock の [▶ Run] をタップ"

# ステップ7: 完了
sleep 1
stop_recording "cross-pane-single"

echo ""
echo "✅ テイク完了！ファイル: $DEMO_DIR/cross-pane-single.mp4"
