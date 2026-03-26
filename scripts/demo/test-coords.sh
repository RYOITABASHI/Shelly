#!/data/data/com.termux/files/usr/bin/bash
# test-coords.sh — 座標テスト
#
# Shellyの入力欄タップ → テスト文字入力 → 送信ボタンタップ
# を試して座標が合ってるか確認する。

source "$(dirname "$0")/common.sh"

banner "座標テスト"

echo "📋 事前準備:"
echo "   Shelly がマルチペインで開いている状態"
echo ""
echo "これから3秒後に以下を実行する:"
echo "   1. 入力欄をタップ (${INPUT_FIELD_X}, ${INPUT_FIELD_Y})"
echo "   2. 'hello' と入力"
echo "   3. 3秒待ち"
echo "   4. 送信ボタンをタップ (${SEND_BTN_X}, ${SEND_BTN_Y})"
echo ""
echo "Shelly の画面を見ていてね。"
echo ""

countdown 3

echo "👆 入力欄をタップ..."
tap "$INPUT_FIELD_X" "$INPUT_FIELD_Y"
sleep 0.5

echo "⌨️  'hello' を入力..."
adb shell input text "hello"
sleep 1

echo "📸 入力後のスクショ撮影..."
take_screenshot "test-after-input"

echo ""
echo "✅ テスト完了！"
echo "   $DEMO_DIR/test-after-input.png を確認して、"
echo "   Shelly の入力欄に 'hello' が入っていればOK。"
echo ""
echo "   入っていない場合は座標を調整する必要がある。"
echo "   送信テストは手動で送信ボタンをタップして確認して。"
