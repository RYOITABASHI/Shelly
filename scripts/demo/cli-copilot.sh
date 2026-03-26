#!/data/data/com.termux/files/usr/bin/bash
# cli-copilot.sh — 素材5: CLI Co-Pilot リアルタイム翻訳（8秒）
#
# マルチペイン: Terminal で claude 実行 → Chat に翻訳オーバーレイ表示
# + 承認プロンプトのリスク表示

source "$(dirname "$0")/common.sh"

banner "素材5: CLI Co-Pilot リアルタイム翻訳（8秒）"

echo "📋 事前準備:"
echo "   1. マルチペイン: 左 Chat、右 Terminal"
echo "   2. Terminal で claude を起動する準備"
echo "   3. Cerebras/Groq の API キーが設定済み（高速翻訳用）"
echo "   4. 言語: 日本語"
echo ""

wait_for "マルチペイン準備OK？Terminal で claude を起動する？"
countdown 3

start_recording "cli-copilot"

# ステップ1: claude を起動
wait_for "Terminal で 'claude' と入力して Enter。何か応答が出るまで待つ。"

# ステップ2: 翻訳オーバーレイ
wait_for "Chat 側に翻訳オーバーレイが表示されるまで待つ"

# ステップ3: 承認プロンプト
wait_for "claude が 'Allow editing?' の承認プロンプトを出すまで待つ。
         Chat 側に ⚠️ リスク表示が出るはず。
         （出ない場合: 'edit src/app.ts to add a comment' と指示してみて）"

# ステップ4: 2秒ホールド
sleep 2
stop_recording "cli-copilot"

echo ""
echo "✅ テイク完了！ファイル: $DEMO_DIR/cli-copilot.mp4"
