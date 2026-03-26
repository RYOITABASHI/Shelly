#!/data/data/com.termux/files/usr/bin/bash
# run-all.sh — 全デモ素材を順番に撮影

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Shelly デモ — 撮影セッション開始            ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  開始前チェック:                                     ║"
echo "║  □ ワイヤレスADB 接続済み                           ║"
echo "║  □ Shelly 起動中 + Bridge 接続済み                  ║"
echo "║  □ おやすみモード ON                                ║"
echo "║  □ バッテリー 80% 以上                              ║"
echo "║  □ GitHub PAT 設定済み                              ║"
echo "║  □ shelly_autocheck_offered クリア済み               ║"
echo "║                                                      ║"
echo "║  撮影順（画面モードでまとめて効率化）:               ║"
echo "║  1. hero.sh          （マルチペイン）               ║"
echo "║  2. cli-copilot.sh   （マルチペイン）               ║"
echo "║  3. cross-pane-single.sh（シングル、日本語）        ║"
echo "║  4. team.sh          （シングルペイン）             ║"
echo "║  5. savepoint.sh     （シングルペイン）             ║"
echo "║  6. github-sync.sh   （シングルペイン）             ║"
echo "║  7. screenshots.sh   （混合）                       ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

read -r -p "撮影セッションを開始する？ [Enter で開始 / Ctrl+C でキャンセル] "

# ── マルチペイン撮影 ──
echo ""
echo "▶ フェーズ1: マルチペイン撮影"
echo "  Z Fold6 を展開して、マルチペインモードにして"
read -r -p "  [マルチペインになったら Enter] "

bash "$SCRIPT_DIR/hero.sh"
echo ""
read -r -p "CLI Co-Pilot に進む？ [Enter] "
bash "$SCRIPT_DIR/cli-copilot.sh"

# ── シングルペイン撮影 ──
echo ""
echo "▶ フェーズ2: シングルペイン撮影"
echo "  シングルペインモードにして（折りたたみ or リサイズ）"
read -r -p "  [シングルペインになったら Enter] "

echo "  言語を日本語に切り替えて（素材2用）"
read -r -p "  [日本語になったら Enter] "
bash "$SCRIPT_DIR/cross-pane-single.sh"

echo ""
echo "  言語を英語に戻して"
read -r -p "  [英語になったら Enter] "

bash "$SCRIPT_DIR/team.sh"
echo ""
read -r -p "セーブポイントに進む？ [Enter] "
bash "$SCRIPT_DIR/savepoint.sh"
echo ""
read -r -p "GitHub Sync に進む？ [Enter] "
bash "$SCRIPT_DIR/github-sync.sh"

# ── スクリーンショット ──
echo ""
echo "▶ フェーズ3: スクリーンショット"
bash "$SCRIPT_DIR/screenshots.sh"

# ── 後処理 ──
echo ""
echo "▶ フェーズ4: 後処理（MP4 → GIF + 字幕）"
read -r -p "後処理を実行する？ [Enter で実行 / Ctrl+C でスキップ] "
bash "$SCRIPT_DIR/post-process.sh"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           全部完了！素材を確認してね:               ║"
echo "║           ~/shelly-demo/                            ║"
echo "║           docs/images/                              ║"
echo "╚══════════════════════════════════════════════════════╝"
