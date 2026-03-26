#!/data/data/com.termux/files/usr/bin/bash
# team.sh — 素材3: @team マルチAI合議（8秒）
#
# 1つのプロンプト → 複数AIが並列応答 → ファシリテーターサマリー

source "$(dirname "$0")/common.sh"

banner "素材3: @team マルチAI合議（8秒）"

echo "📋 事前準備:"
echo "   1. Chat タブを開いている"
echo "   2. 複数のAIプロバイダーが設定済み（Cerebras + Gemini等）"
echo "   3. 言語: 英語"
echo ""

wait_for "Chat タブが開いている？入力欄が見えている？"
countdown 3

start_recording "team"

# ステップ1: テキスト入力
wait_for "Chat の入力欄をタップ"
echo "⌨️  入力中: @team What architecture should I use for a REST API?"
type_text "@team" 0.05
sleep 0.3
type_text " What architecture should I use for a REST API?" 0.04
sleep 0.5

# ステップ2: 送信
wait_for "送信ボタンをタップ"

# ステップ3: 複数AI応答を待つ
wait_for "複数AIの応答（Claude, Gemini等）+ ファシリテーターサマリーが表示されるまで待つ"

# ステップ4: 完了
sleep 1
stop_recording "team"

echo ""
echo "✅ テイク完了！ファイル: $DEMO_DIR/team.mp4"
