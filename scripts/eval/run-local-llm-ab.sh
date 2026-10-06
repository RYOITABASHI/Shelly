# scripts/eval/run-local-llm-ab.sh — A/B the local LLM tier on device.
#
# Run from Shelly's IN-APP terminal (needs the app's $HOME, its installed
# llama.cpp under ~/.local/llama.cpp, and the bundled node/curl):
#
#   bash scripts/eval/run-local-llm-ab.sh                 # Qwen3.5-2B vs MiniCPM5-2B
#   bash scripts/eval/run-local-llm-ab.sh A.gguf B.gguf   # any GGUFs (paths or names)
#
# Always invoke via `bash script.sh` — Knox blocks direct shebang exec.
#
# For each model it starts a DEDICATED llama-server on 127.0.0.1:$EVAL_PORT
# (default 8091, so Shelly's own :8080 server is left alone), runs
# local-llm-ab-eval.js against it, stops it, and finally prints one combined
# markdown table. Results go to a throwaway dir under $TMPDIR (no new
# persistent folder). Env knobs: EVAL_PORT, EVAL_THREADS (4), EVAL_CTX (8192),
# EVAL_ARGS (extra eval flags, e.g. "--native-tools" or "--grammar"),
# EVAL_START_TIMEOUT (180 s).

set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
eval_js="$script_dir/local-llm-ab-eval.js"
port="${EVAL_PORT:-8091}"
threads="${EVAL_THREADS:-4}"
ctx="${EVAL_CTX:-8192}"
start_timeout="${EVAL_START_TIMEOUT:-180}"
out_dir="${TMPDIR:-$HOME/tmp}/shelly-llm-ab-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out_dir" || exit 1

resolve_model() {
  name="$1"
  case "$name" in
    /*) [ -f "$name" ] && { printf '%s\n' "$name"; return 0; }; return 1 ;;
  esac
  case "$name" in *.gguf) file="$name" ;; *) file="$name.gguf" ;; esac
  for dir in "$HOME/models" "$HOME/.local/share/shelly/models" "/sdcard/Download" "/sdcard/Download/ShellyModels" "/sdcard/models" "/sdcard/Models"; do
    if [ -f "$dir/$file" ]; then printf '%s\n' "$dir/$file"; return 0; fi
  done
  return 1
}

server_pid=""
stop_server() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null
    _w=0
    while kill -0 "$server_pid" 2>/dev/null && [ "$_w" -lt 10 ]; do sleep 1; _w=$((_w + 1)); done
    kill -9 "$server_pid" 2>/dev/null
    server_pid=""
  fi
}
trap stop_server EXIT
# A bare INT/TERM trap would run stop_server and then resume the loop (POSIX
# sh does not exit after a handled signal), so stop and exit 130 explicitly.
trap 'stop_server; exit 130' INT TERM

start_server() {
  model_path="$1"
  log_file="$2"
  realpath_file="$HOME/.local/bin/llama-server.realpath"
  if [ ! -s "$realpath_file" ]; then
    echo "llama.cpp is not installed (missing $realpath_file). Run Settings -> llama.cpp Setup first." >&2
    return 1
  fi
  server_bin="$(cat "$realpath_file")"
  [ -x "$server_bin" ] || { echo "llama-server not executable: $server_bin" >&2; return 1; }
  server_dir="$(dirname "$server_bin")"
  lib_path="$(find "$HOME/.local/llama.cpp" -type f \( -name '*.so' -o -name '*.so.*' \) -exec dirname {} \; 2>/dev/null | sort -u | tr '\n' ':')"
  alias_name="$(basename "$model_path" .gguf)"
  (
    cd "$server_dir" || exit 1
    unset LD_PRELOAD
    export LD_LIBRARY_PATH="$server_dir:${lib_path}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    trap '' HUP
    exec /system/bin/linker64 "$server_bin" --model "$model_path" --alias "$alias_name" \
      --host 127.0.0.1 --port "$port" --ctx-size "$ctx" --threads "$threads" --jinja \
      < /dev/null > "$log_file" 2>&1
  ) &
  server_pid=$!
  _i=0
  while [ "$_i" -lt "$start_timeout" ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "llama-server exited during startup; last log lines:" >&2
      tail -n 15 "$log_file" >&2
      server_pid=""
      return 1
    fi
    sleep 1
    _i=$((_i + 1))
  done
  echo "llama-server did not become healthy within ${start_timeout}s" >&2
  tail -n 15 "$log_file" >&2
  return 1
}

if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
  echo "port $port is already in use; set EVAL_PORT to a free port" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- Qwen3.5-2B-Q4_K_M MiniCPM5-2B-Q4_K_M
fi

version_line=""
results=""
for name in "$@"; do
  model_path="$(resolve_model "$name")" || { echo "model not found: $name (looked in ~/models, /sdcard/Download, ...)" >&2; exit 1; }
  label="$(basename "$model_path" .gguf)"
  echo "=== $label ($model_path)" >&2
  log_file="$out_dir/$label.server.log"
  start_server "$model_path" "$log_file" || exit 1
  if [ -z "$version_line" ]; then
    version_line="$(grep -m1 -E 'build[: ]|version' "$log_file" 2>/dev/null || true)"
  fi
  # shellcheck disable=SC2086
  node "$eval_js" --base-url "http://127.0.0.1:$port" --model "$label" --label "$label" \
    --out "$out_dir/$label.json" ${EVAL_ARGS:-} > "$out_dir/$label.md" || echo "eval failed for $label" >&2
  stop_server
  results="$results $out_dir/$label.json"
done

echo
echo "llama.cpp: ${version_line:-unknown (see $out_dir/*.server.log)}"
echo "device: $(getprop ro.product.model 2>/dev/null) / threads=$threads ctx=$ctx"
echo
# shellcheck disable=SC2086
node "$eval_js" --compare $results
echo
echo "raw results: $out_dir"
