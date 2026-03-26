#!/data/data/com.termux/files/usr/bin/bash
# github-sync.sh — 素材6: GitHub連携 + 自動チェック（12秒）
#
# AI が sync 提案 → Sync タップ → push完了
# → 自動チェック提案 → Turn on → CI設定完了

source "$(dirname "$0")/common.sh"

banner "素材6: GitHub連携 + 自動チェック（12秒）"

echo "📋 事前準備:"
echo "   1. Chat タブを開いている"
echo "   2. GitHub PAT が設定済み"
echo "   3. プロジェクトに git remote origin がある"
echo "   4. 5件以上の未push セーブポイントがある"
echo "   5. AsyncStorage 'shelly_autocheck_offered' をクリア済み"
echo "   6. 言語: 英語"
echo ""
echo "⚠️  自動チェックフラグのリセット方法:"
echo "   Settings → ストレージクリア、または手動でキーを削除"
echo ""

wait_for "全部準備OK？"
countdown 3

start_recording "github-sync"

# ステップ1: sync 提案バブル
wait_for "Git sync 提案バブルが表示されている？
         「💡 N savepoints not synced. Sync to GitHub?」
         表示されてない場合はセーブポイントを増やして。"

# ステップ2: Sync タップ
wait_for "[Sync] をタップ"

# ステップ3: push 完了を待つ
wait_for "「Synced!」メッセージが出るまで待つ"

# ステップ4: 自動チェック提案
wait_for "AutoCheckProposal バブルが出るまで待つ（約800ms後）:
         「✓ Auto-check available」
         [Maybe later]  [⚡ Turn on]"

# ステップ5: Turn on タップ
wait_for "[⚡ Turn on] をタップ"

# ステップ6: 設定完了を待つ
wait_for "「Auto-check is on!」の確認メッセージが出るまで待つ"

# ステップ7: 1秒ホールド
sleep 1
stop_recording "github-sync"

echo ""
echo "✅ テイク完了！ファイル: $DEMO_DIR/github-sync.mp4"
echo ""
echo "⚠️  注意: 自動チェックフラグがセットされた。"
echo "   再撮影する場合は 'shelly_autocheck_offered' を AsyncStorage からクリアして。"
