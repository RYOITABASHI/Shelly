#!/data/data/com.termux/files/usr/bin/bash
# common.sh — Shelly デモ撮影の共通ヘルパー（フルオート方式）
#
# ADB経由で全操作を自動化。座標はZ Fold6展開状態で検証済み。
# 画面サイズ: 1856x2160

set -euo pipefail

DEMO_DIR="$HOME/shelly-demo"
mkdir -p "$DEMO_DIR"

RECORD_PID=""
DISPLAY_ID="4630946165277524611"

# ── 検証済み座標 (Z Fold6 展開, 1856x2160, マルチペイン Chat+Terminal) ──
# Chat は左半分 (x: 0〜928)
INPUT_X=350         # 入力欄中央 (キーボードなし時)
INPUT_Y=2038        # 入力欄Y (キーボードなし時)
INPUT_Y_KB=1210     # 入力欄Y (キーボードあり時)
SEND_X=840          # 送信ボタンX
SEND_Y=2038         # 送信ボタンY (キーボードなし時)
SEND_Y_KB=1245      # 送信ボタンY (キーボードあり時)

# ─── 録画 ──────────────────────────────────────────────────────────────────────

start_recording() {
  local name="${1:?使い方: start_recording <名前>}"
  echo "🎬 録画開始 → ${name}.mp4"
  adb shell screenrecord --display-id "$DISPLAY_ID" --time-limit 120 "/sdcard/shelly_${name}.mp4" &
  RECORD_PID=$!
  sleep 1
}

stop_recording() {
  local name="${1:?使い方: stop_recording <名前>}"
  if [ -n "$RECORD_PID" ]; then
    kill "$RECORD_PID" 2>/dev/null || true
    wait "$RECORD_PID" 2>/dev/null || true
    RECORD_PID=""
  fi
  adb shell pkill -INT screenrecord 2>/dev/null || true
  sleep 2
  adb pull "/sdcard/shelly_${name}.mp4" "$DEMO_DIR/${name}.mp4" 2>/dev/null || true
  echo "✅ 保存 → $DEMO_DIR/${name}.mp4"
}

# ─── スクリーンショット ────────────────────────────────────────────────────────

take_screenshot() {
  local name="${1:?使い方: take_screenshot <名前>}"
  local out="$DEMO_DIR/${name}.png"
  adb shell screencap -d "$DISPLAY_ID" -p "/sdcard/shelly_ss_${name}.png"
  adb pull "/sdcard/shelly_ss_${name}.png" "$out" 2>/dev/null || true
  echo "📸 スクショ → $out"
}

# ─── タップ ────────────────────────────────────────────────────────────────────

tap() {
  adb shell input tap "$1" "$2"
  sleep 0.3
}

# ─── テキスト入力 ──────────────────────────────────────────────────────────────

# 入力欄をタップ → テキストを1文字ずつ入力
type_in_chat() {
  local text="$1"
  local delay="${2:-0.04}"

  # 入力欄をタップしてフォーカス + キーボード表示
  tap "$INPUT_X" "$INPUT_Y"
  sleep 0.5

  for (( i=0; i<${#text}; i++ )); do
    local char="${text:$i:1}"
    case "$char" in
      " ")  adb shell input keyevent 62 ;;
      "'")  adb shell input text "\\'" ;;
      '"')  adb shell input text '\\"' ;;
      "&")  adb shell input text "\\&" ;;
      "<")  adb shell input text "\\<" ;;
      ">")  adb shell input text "\\>" ;;
      "|")  adb shell input text "\\|" ;;
      ";")  adb shell input text "\\;" ;;
      "(")  adb shell input text "\\(" ;;
      ")")  adb shell input text "\\)" ;;
      "@")  adb shell input text "\\@" ;;
      "?")  adb shell input text "\\?" ;;
      "!")  adb shell input text "\\!" ;;
      *)    adb shell input text "$char" ;;
    esac
    sleep "$delay"
  done
}

# 送信ボタンをタップ（キーボード表示状態）
send_message() {
  tap "$SEND_X" "$SEND_Y_KB"
}

# キーボードを閉じる
hide_keyboard() {
  adb shell input keyevent 111  # KEYCODE_ESCAPE
  sleep 0.3
}

# ─── Terminal側に入力 ──────────────────────────────────────────────────────────

# Terminal側（右半分）をタップしてフォーカス
tap_terminal() {
  tap 1400 600
  sleep 0.3
}

# Terminal側にコマンドを入力して実行
type_in_terminal() {
  local text="$1"
  tap_terminal
  sleep 0.3
  for (( i=0; i<${#text}; i++ )); do
    local char="${text:$i:1}"
    case "$char" in
      " ")  adb shell input keyevent 62 ;;
      "'")  adb shell input text "\\'" ;;
      '"')  adb shell input text '\\"' ;;
      "&")  adb shell input text "\\&" ;;
      "|")  adb shell input text "\\|" ;;
      ";")  adb shell input text "\\;" ;;
      "(")  adb shell input text "\\(" ;;
      ")")  adb shell input text "\\)" ;;
      *)    adb shell input text "$char" ;;
    esac
    sleep 0.02
  done
  adb shell input keyevent 66  # ENTER
}

# ─── 待機 ──────────────────────────────────────────────────────────────────────

wait_sec() {
  local secs="$1"
  local msg="${2:-待機中}"
  echo "⏳ ${msg}（${secs}秒）"
  sleep "$secs"
}

# セミオートフォールバック
wait_for() {
  local msg="${1:-準備ができたらEnter...}"
  echo ""
  echo "⏸️  $msg"
  read -r -p "   [Enter で次へ] "
  echo ""
}

countdown() {
  local secs="${1:-3}"
  for (( i=secs; i>0; i-- )); do
    echo -ne "\r   ${i}秒後に開始..."
    sleep 1
  done
  echo -e "\r   スタート！        "
}

# ─── 後片付け ──────────────────────────────────────────────────────────────────

cleanup_recording() {
  if [ -n "$RECORD_PID" ]; then
    kill "$RECORD_PID" 2>/dev/null || true
    wait "$RECORD_PID" 2>/dev/null || true
  fi
  adb shell pkill -INT screenrecord 2>/dev/null || true
}

trap cleanup_recording EXIT

banner() {
  local title="$1"
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  $title"
  echo "════════════════════════════════════════════════════"
  echo ""
}
