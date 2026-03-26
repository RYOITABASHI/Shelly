#!/data/data/com.termux/files/usr/bin/bash
# hero.sh — 素材1: ヒーローGIF（12秒）フルオート版
#
# クロスペインインテリジェンス:
#   Terminal にエラー → Chat で「fix the error on the right」
#   → AI応答待ち → ActionBlock [▶ Run] → 自動セーブ
#
# 前提: マルチペイン(Chat+Terminal)、Terminal にエラー表示済み、英語UI

source "$(dirname "$0")/common.sh"

banner "素材1: ヒーローGIF — クロスペイン（12秒）"

echo "📋 前提確認:"
echo "   1. マルチペイン（左: Chat、右: Terminal）"
echo "   2. Terminal にエラーが表示済み"
echo "   3. 英語UI"
echo ""

# Terminal にエラーを表示（まだなければ）
wait_for "Terminal にエラーが出てる？なければ先に表示してね。準備OK？"

countdown 3

# ── 録画開始 ──
start_recording "hero"

# 1秒間エラーを見せる
wait_sec 1 "エラー画面表示中"

# Chat 入力欄をタップ → テキスト入力
echo "⌨️  入力中: fix the error on the right"
type_in_chat "fix the error on the right" 0.05

wait_sec 1 "入力確認"

# 送信
echo "📤 送信"
send_message

# AI応答を待つ（セミオート: 応答+ActionBlock表示を目視）
wait_for "AI応答 + ActionBlock [▶ Run] が表示されたら Enter"

# ActionBlock の [▶ Run] をタップ
# ActionBlock は Chat 左側の中央付近に表示される（メッセージ位置による）
# ここはセミオート: 位置が動的なので手動タップ
wait_for "[▶ Run] をタップしたら Enter"

# 実行完了 + セーブバッジ待ち
wait_sec 3 "Terminal 実行 + 💾 セーブバッジ待ち"

# ── 録画停止 ──
stop_recording "hero"

echo ""
echo "✅ テイク完了！ $DEMO_DIR/hero.mp4"
