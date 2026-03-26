#!/data/data/com.termux/files/usr/bin/bash
# screenshots.sh — README用スクリーンショット7枚を撮影

source "$(dirname "$0")/common.sh"

banner "スクリーンショット撮影（7枚）"

# ── SS1: ヒーロー画像 ──
echo "📸 SS1: ヒーロー画像"
echo "   マルチペイン: Chat + Terminal"
echo "   Chat 側に AI応答 + ActionBlock（[▶ Run]ボタン付き）"
echo "   Terminal 側にコマンド出力"
echo "   Nacre キーボードが画面下部に映っている"
wait_for "画面の準備OK？"
take_screenshot "hero"

# ── SS2: セットアップウィザード ──
echo "📸 SS2: セットアップウィザード"
echo "   ウィザードの完了画面（Bridge✓ Terminal✓ AI✓）"
echo "   「Get Started」ボタンが見える"
wait_for "画面の準備OK？"
take_screenshot "setup-wizard"

# ── SS3: @team 複数AI応答 ──
echo "📸 SS3: @team 複数AI応答"
echo "   ファシリテーターサマリーが上部に表示"
echo "   各AIの個別回答が折りたたみで下に"
echo "   カラーバッジが見える（Claude=アンバー、Gemini=ブルー等）"
wait_for "画面の準備OK？"
take_screenshot "team-response"

# ── SS4: DiffViewer ──
echo "📸 SS4: DiffViewer モーダル"
echo "   DiffViewerModal が開いている状態"
echo "   緑（追加）/ 赤（削除）のシンタックスハイライト"
wait_for "画面の準備OK？"
take_screenshot "diff-viewer"

# ── SS5: GitHub連携提案 ──
echo "📸 SS5: GitHub Sync 提案"
echo "   AI提案バブル「Sync to GitHub?」が表示"
echo "   [Sync] [Later] ボタンが見える"
wait_for "画面の準備OK？"
take_screenshot "github-suggest"

# ── SS6: テーマバリエーション ──
echo "📸 SS6: テーマバリエーション"
echo "   まずダークテーマで撮影"
wait_for "ダークテーマの画面準備OK？"
take_screenshot "themes-dark"
echo "   次に別のテーマに切り替えて"
wait_for "別テーマに切り替えた？"
take_screenshot "themes-alt"

# ── SS7: 自動チェックウィザード ──
echo "📸 SS7: 自動チェックウィザード"
echo "   Settings → 自動チェック設定のモーダルを開く"
echo "   Step 1 が見えている状態:"
echo "   [✅ ビルド確認] [✅ テスト実行] [デプロイ] [リリース作成]"
wait_for "画面の準備OK？"
take_screenshot "actions-wizard"

echo ""
echo "════════════════════════════════════════════════════"
echo "  全7枚のスクリーンショット撮影完了！"
echo "  保存先: $DEMO_DIR/"
echo "════════════════════════════════════════════════════"
echo ""
echo "📁 ファイル:"
ls -la "$DEMO_DIR"/*.png 2>/dev/null || echo "   （PNG ファイルなし）"
