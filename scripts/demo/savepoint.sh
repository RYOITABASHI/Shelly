#!/data/data/com.termux/files/usr/bin/bash
# savepoint.sh — 素材4: 自動セーブポイント + 元に戻す（8秒）
#
# SavepointBubble → 変更を見る（diff）→ 元に戻す

source "$(dirname "$0")/common.sh"

banner "素材4: 自動セーブポイント + 元に戻す（8秒）"

echo "📋 事前準備:"
echo "   1. Chat タブを開いている"
echo "   2. AI操作後の SavepointBubble が見えている"
echo "      「📁 Modified N files」[Undo] [View changes]"
echo "   3. 言語: 英語"
echo ""

wait_for "SavepointBubble が見えている？準備OK？"
countdown 3

start_recording "savepoint"

# ステップ1: SavepointBubble を1秒見せる
sleep 1

# ステップ2: 変更を見る
wait_for "[View changes] をタップ"

# ステップ3: Diff モーダル表示
wait_for "DiffViewer モーダルが開いた。2秒待って。"
sleep 2

# ステップ4: モーダルを閉じる
wait_for "DiffViewer を閉じる（外側タップ or 戻るボタン）"

# ステップ5: 元に戻す
wait_for "[Undo] をタップ"

# ステップ6: 結果表示
sleep 1.5
stop_recording "savepoint"

echo ""
echo "✅ テイク完了！ファイル: $DEMO_DIR/savepoint.mp4"
