#!/data/data/com.termux/files/usr/bin/bash
# post-process.sh — MP4 → GIF変換 + 字幕追加
#
# 必要: ffmpeg (pkg install ffmpeg)

set -euo pipefail

DEMO_DIR="$HOME/shelly-demo"
DOCS_DIR="$(dirname "$0")/../../docs/images"
mkdir -p "$DOCS_DIR"

if ! command -v ffmpeg &>/dev/null; then
  echo "❌ ffmpeg が見つからない。インストール: pkg install ffmpeg"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════"
echo "  後処理: MP4 → GIF + 字幕追加"
echo "════════════════════════════════════════════════════"
echo ""

# ─── GIF変換 ───────────────────────────────────────────────────────────────────

to_gif() {
  local input="$1"
  local output="$2"
  local width="${3:-900}"

  if [ ! -f "$input" ]; then
    echo "⏭️  スキップ: $input（ファイルなし）"
    return
  fi

  echo "🔄 変換中: $(basename "$input") → $(basename "$output")"
  ffmpeg -y -i "$input" \
    -vf "fps=15,scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
    -loop 0 "$output" 2>/dev/null

  local size
  size=$(du -h "$output" | cut -f1)
  echo "   ✅ $(basename "$output") ($size)"
}

# ─── 字幕追加 ──────────────────────────────────────────────────────────────────

add_subtitles() {
  local input="$1"
  local output="$2"
  shift 2
  local filters=""
  local sep=""

  for entry in "$@"; do
    local start end text
    IFS=':' read -r start end text <<< "$entry"
    filters="${filters}${sep}drawtext=text='${text}':x=(w-tw)/2:y=80:fontsize=42:fontcolor=white:borderw=2:bordercolor=black:enable='between(t,${start},${end})'"
    sep=","
  done

  if [ -n "$filters" ]; then
    echo "🔤 字幕追加: $(basename "$input")"
    ffmpeg -y -i "$input" -vf "$filters" -codec:a copy "$output" 2>/dev/null
    echo "   ✅ $(basename "$output")"
  fi
}

# ─── ヒーローGIF処理 ──────────────────────────────────────────────────────────

if [ -f "$DEMO_DIR/hero.mp4" ]; then
  add_subtitles "$DEMO_DIR/hero.mp4" "$DEMO_DIR/hero_subtitled.mp4" \
    "0:3:The copy-paste problem ends here." \
    "4:8:Say it. AI reads the terminal. Suggests a fix." \
    "8:12:One tap. It runs. Auto-saved."

  to_gif "$DEMO_DIR/hero_subtitled.mp4" "$DEMO_DIR/cross-pane.gif" 900
fi

# ─── Feature GIF処理 ──────────────────────────────────────────────────────────

to_gif "$DEMO_DIR/cross-pane-single.mp4" "$DEMO_DIR/cross-pane-single.gif" 900
to_gif "$DEMO_DIR/team.mp4"              "$DEMO_DIR/team.gif"              900
to_gif "$DEMO_DIR/savepoint.mp4"         "$DEMO_DIR/savepoint.gif"         900
to_gif "$DEMO_DIR/cli-copilot.mp4"       "$DEMO_DIR/cli-copilot.gif"      900
to_gif "$DEMO_DIR/github-sync.mp4"       "$DEMO_DIR/github-sync.gif"      900

# ─── docs/images/ にコピー ────────────────────────────────────────────────────

echo ""
echo "📁 docs/images/ にコピー中..."

for f in cross-pane.gif cross-pane-single.gif team.gif savepoint.gif cli-copilot.gif github-sync.gif; do
  if [ -f "$DEMO_DIR/$f" ]; then
    cp "$DEMO_DIR/$f" "$DOCS_DIR/$f"
    echo "   ✅ $f"
  fi
done

for f in hero setup-wizard team-response diff-viewer github-suggest themes-dark themes-alt actions-wizard; do
  if [ -f "$DEMO_DIR/${f}.png" ]; then
    cp "$DEMO_DIR/${f}.png" "$DOCS_DIR/${f}.png"
    echo "   ✅ ${f}.png"
  fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo "  後処理完了！"
echo "════════════════════════════════════════════════════"
echo ""
echo "📁 出力先: $DOCS_DIR/"
ls -la "$DOCS_DIR"/ 2>/dev/null
