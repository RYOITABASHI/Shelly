#!/bin/bash
# shelly-local-llm-ensure.sh — bundled local-LLM (llama-server) autostart
# helper library. Ships as an APK asset
# (modules/terminal-emulator/android/src/main/assets/shelly-local-llm-ensure.sh,
# byte-identical to this scripts/ copy — see
# __tests__/local-llm-ensure-parity.test.ts) and is extracted by
# HomeInitializer.kt into $HOME/.shelly-local-llm-ensure.sh on every
# HomeInitializer.initialize() call (unconditional overwrite, same pattern as
# .shelly-plan-executor.js / .shelly-capability-broker.js — no separate
# version-gate constant needed since it is re-extracted before every single
# agent run, not just lazily on a JS-authored edit like run-agent-<id>.sh).
#
# This is a pure function library: sourcing it has no side effects other than
# defining the functions below. Callers must set $HOME, $AGENT_ID, $TMP_DIR,
# and $LOCKS_DIR before calling ensure_local_llm_server (see AgentRuntime.kt's
# runPlanAgent() preflight invocation for the native call site, and
# lib/agent-executor.ts's own generated run-agent-<id>.sh for the legacy
# single-shot caller this was extracted from).
#
# docs/superpowers/DEFERRED.md "PlanSpec executor 経由の無人スケジュール実行に
# local LLM autostart が無い" (2026-07-18): this file is an ADDITIVE
# extraction of ensure_local_llm_server() and its full transitive helper
# closure out of lib/agent-executor.ts's generateRunScript() bash template.
# lib/agent-executor.ts keeps its own inline copy of every function below
# completely unchanged (deliberately NOT refactored to source this file in
# this pass — see the DEFERRED.md entry for why); this file exists so
# AgentRuntime.kt's PlanSpec-executor path (scripts/shelly-plan-executor.js,
# which is intentionally spawn-incapable and cannot run this logic itself)
# can run the exact same autostart behavior via a small native preflight
# step before launching node. Do not edit the two copies out of sync with
# lib/agent-executor.ts's originals without re-verifying on-device — every
# function here carries on-device-bug-driven fixes (LD_PRELOAD handling,
# start-lock races, idle-watcher PID tracking, tier-mismatch reuse) called
# out in the inline comments below, copied verbatim from lib/agent-executor.ts.

shelly_app_binary_path() {
  name="$1"
  if [ -n "${SHELLY_LIB_DIR:-}" ] && [ -f "$SHELLY_LIB_DIR/$name" ]; then
    printf '%s\n' "$SHELLY_LIB_DIR/$name"
    return 0
  fi
  resolved=$(command -v "$name" 2>/dev/null || true)
  case "$resolved" in
    /*)
      printf '%s\n' "$resolved"
      return 0
      ;;
  esac
  return 1
}

shelly_run_app_binary() {
  name="$1"
  shift
  binary=$(shelly_app_binary_path "$name") || return 127
  binary_dir="${binary%/*}"
  if [ -x /system/bin/linker64 ]; then
    LD_LIBRARY_PATH="${SHELLY_LD_LIBRARY_PATH:-${SHELLY_LIB_DIR:-$binary_dir}}" /system/bin/linker64 "$binary" "$@"
    return $?
  fi
  "$binary" "$@"
}

shelly_node() {
  shelly_run_app_binary node "$@"
}

node_usable() {
  shelly_node -e 'process.exit(0)' >/dev/null 2>&1 || return 1
}

python3_usable() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import sys' >/dev/null 2>&1 || return 1
}

http_get_ok() {
  url="$1"
  err_file="$2"
  timeout_seconds="${3:-5}"
  if node_usable; then
    HTTP_TIMEOUT_SECONDS="$timeout_seconds" shelly_node - "$url" > /dev/null 2> "$err_file" <<'NODEEOF'
const http = require('http');
const https = require('https');

const url = new URL(process.argv[2]);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;
const timeoutSeconds = Number(process.env.HTTP_TIMEOUT_SECONDS || '5');

const req = client.request({
  method: 'GET',
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
}, (res) => {
  res.resume();
  res.on('end', () => {
    process.exitCode = res.statusCode && res.statusCode < 500 ? 0 : 22;
  });
});

req.on('error', (err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
req.setTimeout(timeoutSeconds * 1000, () => {
  req.destroy(new Error('request timed out'));
});
req.end();
NODEEOF
    return $?
  fi

  echo "No HTTP client available: node is missing or unavailable." > "$err_file"
  return 127
}

http_get_text() {
  url="$1"
  out_file="$2"
  err_file="$3"
  timeout_seconds="${4:-5}"
  if node_usable; then
    HTTP_TIMEOUT_SECONDS="$timeout_seconds" shelly_node - "$url" > "$out_file" 2> "$err_file" <<'NODEEOF'
const http = require('http');
const https = require('https');

const url = new URL(process.argv[2]);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;
const timeoutSeconds = Number(process.env.HTTP_TIMEOUT_SECONDS || '5');

const req = client.request({
  method: 'GET',
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
}, (res) => {
  res.setEncoding('utf8');
  res.on('data', (chunk) => process.stdout.write(chunk));
  res.on('end', () => {
    process.exitCode = res.statusCode && res.statusCode < 500 ? 0 : 22;
  });
});

req.on('error', (err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
req.setTimeout(timeoutSeconds * 1000, () => {
  req.destroy(new Error('request timed out'));
});
req.end();
NODEEOF
    return $?
  fi

  echo "No HTTP client available: node is missing or unavailable." > "$err_file"
  return 127
}

local_llm_is_loopback_url() {
  case "$1" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

local_llm_ready() {
  base_url="$1"
  timeout_seconds="${2:-5}"
  err_file="${3:-$TMP_DIR/local-llm-ready.err}"
  http_get_ok "${base_url%/}/health" "$err_file" "$timeout_seconds" && return 0
  http_get_ok "${base_url%/}/v1/models" "$err_file" "$timeout_seconds" && return 0
  return 1
}

local_llm_server_matches_model() {
  base_url="$1"
  expected_model="$2"
  timeout_seconds="${3:-5}"
  err_file="${4:-$TMP_DIR/local-llm-models.err}"
  out_file="$TMP_DIR/local-llm-models-$AGENT_ID.json"
  [ -n "$expected_model" ] || return 1
  if ! http_get_text "${base_url%/}/v1/models" "$out_file" "$err_file" "$timeout_seconds"; then
    return 1
  fi
  EXPECTED_MODEL="$expected_model" shelly_node - "$out_file" <<'NODEEOF'
const fs = require('fs');

function normalize(value) {
  const base = String(value || '').split(/[\/]/).pop() || '';
  return base.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const expected = normalize(process.env.EXPECTED_MODEL);
if (!expected) process.exit(1);

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (_) {
  process.exit(1);
}

const ids = [];
if (Array.isArray(parsed?.data)) {
  for (const item of parsed.data) {
    if (item?.id) ids.push(item.id);
    if (item?.root) ids.push(item.root);
    if (item?.name) ids.push(item.name);
  }
}
if (parsed?.model) ids.push(parsed.model);

const ok = ids
  .map(normalize)
  .filter(Boolean)
  .some((id) => id === expected);
process.exit(ok ? 0 : 1);
NODEEOF
}

local_llm_port() {
  base_url="$1"
  port=$(printf '%s\n' "$base_url" | sed -n 's#^http://127\.0\.0\.1:\([0-9][0-9]*\).*#\1#p; s#^http://localhost:\([0-9][0-9]*\).*#\1#p' | head -n 1)
  printf '%s' "${port:-8080}"
}

local_llm_touch_activity() {
  activity_file="${LLAMA_SERVER_ACTIVITY:-$HOME/models/llama-server.activity}"
  mkdir -p "$(dirname "$activity_file")" 2>/dev/null || true
  touch "$activity_file" 2>/dev/null || true
}

local_llm_cleanup_stale_active_users() {
  active_dir="${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  [ -d "$active_dir" ] || return 0
  find "$active_dir" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true
}

local_llm_wait_for_no_active_users() {
  active_dir="${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  wait_seconds="${LOCAL_LLM_RESTART_WAIT_SECONDS:-120}"
  case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=0 ;; esac
  [ "$wait_seconds" -gt 0 ] || return 0
  [ -d "$active_dir" ] || return 0
  _wait_i=0
  while [ "$_wait_i" -lt "$wait_seconds" ]; do
    local_llm_cleanup_stale_active_users
    active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
    [ "${active_count:-0}" = "0" ] && return 0
    sleep 1
    _wait_i=$((_wait_i + 1))
  done
  local_llm_cleanup_stale_active_users
  active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${active_count:-0}" != "0" ]; then
    return 1
  fi
  return 0
}

local_llm_runtime_profile() {
  model_name="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$model_name" in
    *0.8b*|*0-8b*) printf '8192 2 1800\n' ;;
    *1.7b*|*1-7b*) printf '8192 3 1800\n' ;;
    *2b*) printf '8192 4 1800\n' ;;
    *4b*) printf '4096 4 900\n' ;;
    *9b*|*8b*) printf '4096 3 600\n' ;;
    *) printf '4096 3 900\n' ;;
  esac
}

local_llm_stop_watcher() {
  watcher_pid_file="${LLAMA_SERVER_WATCHER_PID:-$HOME/models/llama-server-watcher.pid}"
  if [ -f "$watcher_pid_file" ]; then
    watcher_pid="$(cat "$watcher_pid_file" 2>/dev/null || true)"
    if [ -n "$watcher_pid" ] && kill -0 "$watcher_pid" 2>/dev/null; then
      kill "$watcher_pid" 2>/dev/null || true
    fi
    rm -f "$watcher_pid_file"
  fi
}

local_llm_stop_server() {
  pid_file="${1:-$HOME/models/llama-server.pid}"
  local_llm_wait_for_no_active_users || return 1
  local_llm_stop_watcher
  if [ -f "$pid_file" ]; then
    server_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
      kill "$server_pid" 2>/dev/null || true
      sleep 1
      kill -0 "$server_pid" 2>/dev/null && kill -9 "$server_pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  old_pid="$(ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | awk '{print $2}' | head -n1)"
  if [ -n "$old_pid" ]; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
    kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null || true
  fi
}

local_llm_start_idle_watcher() {
  server_pid="$1"
  idle_timeout="$2"
  pid_file="$3"
  log_file="$4"
  activity_file="${LLAMA_SERVER_ACTIVITY:-$HOME/models/llama-server.activity}"
  active_dir="${LLAMA_SERVER_ACTIVE_DIR:-$HOME/models/llama-server.active}"
  watcher_pid_file="${LLAMA_SERVER_WATCHER_PID:-$HOME/models/llama-server-watcher.pid}"
  case "$idle_timeout" in ''|*[!0-9]*) idle_timeout=0 ;; esac
  [ "$idle_timeout" -gt 0 ] || return 0
  local_llm_touch_activity
  (
    while kill -0 "$server_pid" 2>/dev/null; do
      find "$active_dir" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true
      active_count="$(find "$active_dir" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"
      if [ "${active_count:-0}" != "0" ]; then
        sleep 15
        continue
      fi
      now="$(date +%s)"
      last="$(stat -c %Y "$activity_file" 2>/dev/null || echo "$now")"
      case "$last" in ''|*[!0-9]*) last="$now" ;; esac
      if [ $((now - last)) -ge "$idle_timeout" ]; then
        echo "llama-server idle timeout after $idle_timeout seconds" >> "$log_file" 2>/dev/null || true
        kill "$server_pid" 2>/dev/null || true
        sleep 1
        kill -0 "$server_pid" 2>/dev/null && kill -9 "$server_pid" 2>/dev/null || true
        rm -f "$pid_file"
        break
      fi
      sleep 15
    done
  ) >/dev/null 2>&1 &
  echo $! > "$watcher_pid_file"
}

find_llama_server_bin() {
  if [ -n "${LLAMA_SERVER_BIN:-}" ] && [ -x "$LLAMA_SERVER_BIN" ]; then
    printf '%s\n' "$LLAMA_SERVER_BIN"
    return 0
  fi
  # T3: prefer the app-installed REAL ELF via its .realpath metadata. The
  # $HOME/.local/bin/llama-server entry is a wrapper SCRIPT (not an ELF), so the
  # linker64 launch below needs the real binary; direct-exec of the wrapper in
  # the agent's exec context fails to resolve shared libs (cold-start blocker C).
  if [ -s "$HOME/.local/bin/llama-server.realpath" ]; then
    _real_bin="$(cat "$HOME/.local/bin/llama-server.realpath" 2>/dev/null || true)"
    if [ -x "$_real_bin" ]; then
      printf '%s\n' "$_real_bin"
      return 0
    fi
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return 0
  fi
  for candidate in "$HOME/.local/bin/llama-server" "$HOME/bin/llama-server"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

local_llm_normalize_model_token() {
  value="${1:-}"
  value="${value##*/}"
  value="${value%.gguf}"
  printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g'
}

local_llm_path_matches_model() {
  path_token="$(local_llm_normalize_model_token "${1:-}")"
  model_token="$(local_llm_normalize_model_token "${2:-}")"
  [ -n "$path_token" ] || return 1
  [ -n "$model_token" ] || return 0
  [ "$path_token" = "$model_token" ] && return 0
  case "$path_token" in *"$model_token"*) return 0 ;; esac
  case "$model_token" in *"$path_token"*) return 0 ;; esac
  return 1
}

download_file_node() {
  url="$1"
  out_file="$2"
  err_file="$3"
  if ! node_usable; then
    echo "node is required for download" > "$err_file"
    return 127
  fi
  shelly_node - "$url" "$out_file" > /dev/null 2> "$err_file" <<'NODEEOF'
const fs = require('fs');
const http = require('http');
const https = require('https');

const [urlText, outFile] = process.argv.slice(2);

function download(urlText, redirects) {
  const url = new URL(urlText);
  const client = url.protocol === 'https:' ? https : http;
  const req = client.get(url, {
    headers: { 'User-Agent': 'Shelly-local-llm-installer/1' },
  }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
      res.resume();
      if (redirects <= 0) {
        console.error('too many redirects');
        process.exit(1);
        return;
      }
      download(new URL(res.headers.location, url).toString(), redirects - 1);
      return;
    }
    if (!res.statusCode || res.statusCode >= 400) {
      console.error('download failed: HTTP ' + res.statusCode);
      res.resume();
      process.exit(1);
      return;
    }
    const tmp = outFile + '.part';
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        fs.renameSync(tmp, outFile);
      });
    });
    file.on('error', (err) => {
      console.error(err && err.message ? err.message : String(err));
      try { fs.unlinkSync(tmp); } catch (_) {}
      process.exit(1);
    });
  });
  req.on('error', (err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
  req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
}

download(urlText, 5);
NODEEOF
}

extract_zip_file() {
  zip_file="$1"
  dest_dir="$2"
  err_file="$3"
  mkdir -p "$dest_dir"
  if command -v unzip >/dev/null 2>&1; then
    unzip -o "$zip_file" -d "$dest_dir" > /dev/null 2> "$err_file"
    return $?
  fi
  if python3_usable; then
    if python3 - "$zip_file" "$dest_dir" > /dev/null 2> "$err_file" <<'PYEOF'
import sys
import zipfile

zip_file, dest_dir = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_file) as z:
    z.extractall(dest_dir)
PYEOF
    then
      return 0
    else
      return $?
    fi
  fi
  echo "unzip or python3 is required to extract llama-server" > "$err_file"
  return 127
}

extract_archive_file() {
  archive_file="$1"
  dest_dir="$2"
  err_file="$3"
  mkdir -p "$dest_dir"
  case "$archive_file" in
    *.zip) extract_zip_file "$archive_file" "$dest_dir" "$err_file"; return $? ;;
  esac
  if command -v tar >/dev/null 2>&1; then
    tar -xzf "$archive_file" -C "$dest_dir" > /dev/null 2> "$err_file"
    return $?
  fi
  if python3_usable; then
    if python3 - "$archive_file" "$dest_dir" > /dev/null 2> "$err_file" <<'PYEOF'
import sys
import tarfile

archive_file, dest_dir = sys.argv[1], sys.argv[2]
with tarfile.open(archive_file, "r:*") as t:
    t.extractall(dest_dir)
PYEOF
    then
      return 0
    else
      return $?
    fi
  fi
  echo "tar or python3 is required to extract llama-server archive" > "$err_file"
  return 127
}

resolve_llama_server_download_url() {
  err_file="$TMP_DIR/llama-server-release-$AGENT_ID.err"
  if [ -n "${LLAMA_SERVER_DOWNLOAD_URL:-}" ]; then
    printf '%s\n' "$LLAMA_SERVER_DOWNLOAD_URL"
    return 0
  fi
  if ! node_usable; then
    echo "node is required to resolve latest llama-server release" > "$err_file"
    return 127
  fi
  shelly_node - > "$TMP_DIR/llama-server-url-$AGENT_ID.txt" 2> "$err_file" <<'NODEEOF'
const https = require('https');

const req = https.get('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
  headers: { 'User-Agent': 'Shelly-local-llm-installer/1' },
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    if (!res.statusCode || res.statusCode >= 400) {
      console.error('release lookup failed: HTTP ' + res.statusCode);
      process.exit(1);
      return;
    }
    const release = JSON.parse(body);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => /bin-android-arm64\.(tar\.gz|tgz|zip)$/i.test(a.name || ''));
    if (!asset || !asset.browser_download_url) {
      console.error('release lookup failed: android arm64 llama.cpp asset not found');
      process.exit(1);
      return;
    }
    process.stdout.write(asset.browser_download_url);
  });
});
req.setTimeout(8000, () => {
  req.destroy(new Error('release lookup timed out'));
});
req.on('error', (err) => {
  console.error('release lookup failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
NODEEOF
  if [ ! -s "$TMP_DIR/llama-server-url-$AGENT_ID.txt" ]; then
    return 1
  fi
  cat "$TMP_DIR/llama-server-url-$AGENT_ID.txt"
}

install_llama_server_bin() {
  err_file="$TMP_DIR/llama-server-install-$AGENT_ID.err"
  mkdir -p "$HOME/.local/bin" "$TMP_DIR"
  extract_dir="$TMP_DIR/llama-server-android-arm64"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"

  url=$(resolve_llama_server_download_url || true)
  if [ -z "$url" ]; then
    echo "auto-install failed: could not resolve latest Android arm64 llama-server asset: $(head -c 300 "$TMP_DIR/llama-server-release-$AGENT_ID.err" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi
  case "$url" in
    *.zip) archive_file="$TMP_DIR/llama-server-android-arm64.zip" ;;
    *.tgz) archive_file="$TMP_DIR/llama-server-android-arm64.tgz" ;;
    *) archive_file="$TMP_DIR/llama-server-android-arm64.tar.gz" ;;
  esac
  if ! download_file_node "$url" "$archive_file" "$err_file"; then
    echo "auto-install failed: could not download llama-server from $url: $(head -c 300 "$err_file" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi
  if ! extract_archive_file "$archive_file" "$extract_dir" "$err_file"; then
    echo "auto-install failed: could not extract llama-server archive: $(head -c 300 "$err_file" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi

  extracted=$(find "$extract_dir" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  if [ -z "$extracted" ]; then
    echo "auto-install failed: llama-server binary was not found inside downloaded archive"
    return 1
  fi

  install_dir="$HOME/.local/llama.cpp"
  install_tmp="$HOME/.local/llama.cpp.tmp"
  rm -rf "$install_tmp"
  mkdir -p "$install_tmp"
  cp -R "$extract_dir"/. "$install_tmp"/
  installed_binary=$(find "$install_tmp" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  if [ -z "$installed_binary" ]; then
    echo "auto-install failed: llama-server binary disappeared during install copy"
    return 1
  fi
  chmod +x "$installed_binary"
  rm -rf "$install_dir"
  mv "$install_tmp" "$install_dir"
  installed_binary=$(find "$install_dir" -type f -name 'llama-server' 2>/dev/null | head -n 1 || true)
  binary_dir=$(dirname "$installed_binary")
  lib_dirs=$(find "$install_dir" -type f -name '*.so*' -exec dirname {} \; 2>/dev/null | sort -u | tr '\n' ':' || true)

cat > "$HOME/.local/bin/llama-server" <<WRAPPEREOF
#!/system/bin/sh
cd "$binary_dir" || exit 1
export LD_LIBRARY_PATH="${lib_dirs}${binary_dir}:${install_dir}:${install_dir}/lib:\${LD_LIBRARY_PATH:-}"
unset LD_PRELOAD
if [ -x /system/bin/linker64 ]; then
  exec /system/bin/linker64 "$installed_binary" "\$@"
fi
exec "$installed_binary" "\$@"
WRAPPEREOF
  chmod +x "$HOME/.local/bin/llama-server"
  printf '%s\n' "$HOME/.local/bin/llama-server"
}

find_local_llm_model() {
  model_name="${1:-Qwen3.5-0.8B-Q4_K_M}"
  if [ -n "${LOCAL_LLM_MODEL_PATH:-}" ] &&
    [ -f "$LOCAL_LLM_MODEL_PATH" ] &&
    local_llm_path_matches_model "$LOCAL_LLM_MODEL_PATH" "$model_name"; then
    printf '%s\n' "$LOCAL_LLM_MODEL_PATH"
    return 0
  fi

  case "$model_name" in
    *.gguf) model_file="$model_name" ;;
    *) model_file="$model_name.gguf" ;;
  esac

  for dir in "$HOME/models" "$HOME" "$HOME/.local/share/shelly/models" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/$model_file" ]; then
      printf '%s\n' "$dir/$model_file"
      return 0
    fi
  done

  search_pattern='Qwen3.*0[._-]*8B.*Q4_K_M\|Qwen3.*Q4_K_M.*0[._-]*8B'
  case "$(printf '%s' "$model_name" | tr '[:upper:]' '[:lower:]')" in
    *0.8b*) search_pattern='Qwen3.*0[._-]*8B.*Q4_K_M\|Qwen3.*Q4_K_M.*0[._-]*8B' ;;
    *1.7b*) search_pattern='Qwen3.*1[._-]*7B.*Q4_K_M\|Qwen3.*Q4_K_M.*1[._-]*7B' ;;
    *2b*) search_pattern='Qwen3.*2B.*Q4_K_M\|Qwen3.*Q4_K_M.*2B' ;;
    *8b*) search_pattern='Qwen3.*8B.*Q4_K_M\|Qwen3.*Q4_K_M.*8B' ;;
    *4b*) search_pattern='Qwen3.*4B.*Q4_K_M\|Qwen3.*Q4_K_M.*4B' ;;
  esac

  for dir in "$HOME/models" "$HOME" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    found=$(find "$dir" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null | grep -i "$search_pattern" | head -n 1 || true)
    if [ -n "$found" ]; then
      printf '%s\n' "$found"
      return 0
    fi
  done

  # T1: installed-aware fallback. The requested tier is not present; rather than
  # fail (which blocks ALL autostart — root cause B), use the first installed
  # Qwen Q4_K_M model. llama.cpp serves whatever it loads regardless of the
  # request's model field, and the caller re-derives the alias + readiness check
  # from the returned path, so a tier substitution is safe.
  for dir in "$HOME/models" "$HOME" "$HOME/.local/share/shelly/models" "/sdcard/Download" "/sdcard/models" "/sdcard/llama" "/sdcard/Documents/models" "/sdcard/Models"; do
    [ -d "$dir" ] || continue
    found=$(find "$dir" -maxdepth 2 -type f -name '*.gguf' 2>/dev/null | grep -iE 'qwen3?[._-].*q4_k_m' | head -n 1 || true)
    if [ -n "$found" ]; then
      printf '%s\n' "$found"
      return 0
    fi
  done

  return 1
}

# Remove a stale local-LLM start lock so a lock leaked by a killed starter cannot
# permanently block autostart (root cause A). Stale = holder PID dead, or no live
# holder and older than a short just-created grace window. The lock dir holds
# owner.pid written by the acquirer.
local_llm_clear_stale_start_lock() {
  _ld="$1"
  [ -d "$_ld" ] || return 0
  _owner="$(cat "$_ld/owner.pid" 2>/dev/null || true)"
  if [ -n "$_owner" ] && kill -0 "$_owner" 2>/dev/null; then
    return 0
  fi
  _now="$(date +%s 2>/dev/null || echo 0)"
  _mtime="$(stat -c %Y "$_ld" 2>/dev/null || echo 0)"
  if [ -z "$_owner" ] && [ "$_now" -gt 0 ] && [ "$_mtime" -gt 0 ] && [ "$((_now - _mtime))" -lt 20 ]; then
    return 0
  fi
  rm -rf "$_ld" 2>/dev/null || true
}

ensure_local_llm_server() {
  base_url="$1"
  model_name="${2:-Qwen3.5-0.8B-Q4_K_M}"
  reason_file="$TMP_DIR/local-llm-start-$AGENT_ID.reason"
  : > "$reason_file"

  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
    # Reuse ANY already-running local server, regardless of which model tier it
    # serves. llama.cpp serves its loaded model irrespective of the request's
    # "model" field, so a mismatch is harmless. Restarting a healthy in-app-started
    # server was the root cause of on-device failures: the in-app "Start" launches
    # llama-server through a linker64 + LLAMA_LIB_PATH wrapper, but the agent's own
    # start exec's the binary directly and cannot relaunch it — so a tier mismatch
    # (scorer wants 0.8B, user has 2B running) made the agent kill the working
    # server and fail to bring it back. Reusing whatever is up is strictly better
    # than a dead server.
    local_llm_touch_activity
    return 0
  fi

  if ! local_llm_is_loopback_url "$base_url"; then
    echo "auto-start skipped: LOCAL_LLM_URL is not loopback ($base_url)" > "$reason_file"
    return 1
  fi
  if [ "${LOCAL_LLM_AUTOSTART:-1}" = "0" ]; then
    echo "auto-start disabled: LOCAL_LLM_AUTOSTART=0" > "$reason_file"
    return 1
  fi

  lock_dir="$LOCKS_DIR/local-llm-server-start.lock"
  local_llm_clear_stale_start_lock "$lock_dir"
  lock_acquired=0
  _i=0
	while [ "$_i" -lt 30 ]; do
	  if mkdir "$lock_dir" 2>/dev/null; then
	    lock_acquired=1
	    break
	  fi
	  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
	    # Another starter won the race and a server is up — reuse it (any tier; see
	    # the top reuse path). Consistent with not killing a healthy server.
	    local_llm_touch_activity
	    return 0
	  fi
	  sleep 1
	  _i=$((_i + 1))
	done
  if [ "$lock_acquired" != "1" ]; then
    echo "auto-start skipped: could not acquire start lock $lock_dir (held by a live starter)" > "$reason_file"
    return 1
  fi
  echo $$ > "$lock_dir/owner.pid" 2>/dev/null || true

  if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err"; then
    # Server came up while we held the lock — reuse it (any tier).
    local_llm_touch_activity
    rm -rf "$lock_dir" 2>/dev/null || true
    return 0
  fi

  server_bin=$(find_llama_server_bin || true)
  if [ -z "$server_bin" ]; then
    if [ "${LOCAL_LLM_INSTALL_LLAMA_SERVER:-0}" != "1" ]; then
      echo "auto-start failed: llama-server binary not found in PATH, $HOME/.local/bin, or $HOME/bin" > "$reason_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 1
    fi
    install_result=$(install_llama_server_bin || true)
    server_bin=$(find_llama_server_bin || true)
    if [ -z "$server_bin" ]; then
      echo "auto-start failed: llama-server binary not found and auto-install did not produce an executable. $install_result" > "$reason_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 1
    fi
  fi

  model_path=$(find_local_llm_model "$model_name" || true)
  if [ -z "$model_path" ]; then
    echo "auto-start failed: GGUF model not found for $model_name. Set LOCAL_LLM_MODEL_PATH or place it under $HOME/models or /sdcard/Download." > "$reason_file"
    rm -rf "$lock_dir" 2>/dev/null || true
    return 1
  fi

  port=$(local_llm_port "$base_url")
  log_file="${LLAMA_SERVER_LOG:-$HOME/models/llama-server.log}"
  pid_file="${LLAMA_SERVER_PID:-$HOME/models/llama-server.pid}"
  mkdir -p "$(dirname "$log_file")" "$(dirname "$pid_file")"
  if ! local_llm_stop_server "$pid_file"; then
    echo "auto-start skipped: another local LLM request is still active; refusing to restart llama-server" > "$reason_file"
    rm -rf "$lock_dir" 2>/dev/null || true
    return 1
  fi
  alias_name="${model_path##*/}"
  alias_name="${alias_name%.gguf}"
  # T1: if find_local_llm_model fell back to a different installed tier, the
  # readiness check below must match the model we actually load (alias_name),
  # NOT the requested model_name — else the just-started 2B server would be
  # rejected for not being the requested 8B and the start would "time out".
  _req_norm="$(printf '%s' "$model_name" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
  _got_norm="$(printf '%s' "$alias_name" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
  if [ "$_req_norm" != "$_got_norm" ]; then
    echo "note: requested model $model_name is not installed; using installed $alias_name" >> "$reason_file"
  fi
  profile="$(local_llm_runtime_profile "$alias_name")"
  set -- $profile
  default_ctx_size="$1"
  default_threads="$2"
  default_idle_timeout="$3"
  ctx_size="${LOCAL_LLM_CTX_SIZE:-$default_ctx_size}"
  threads="${LOCAL_LLM_THREADS:-$default_threads}"
  idle_timeout="${LOCAL_LLM_IDLE_TIMEOUT_SECONDS:-$default_idle_timeout}"
  local_llm_touch_activity

  # T3: app-installed llama.cpp needs its shared libs on LD_LIBRARY_PATH and a
  # linker64 launch (the same mechanism as the in-app Start). Without it the
  # agent's exec context can't resolve the .so files and cold-start fails
  # (blocker C). Self-contained binaries (PATH / agent-installed wrapper) have an
  # empty llama_lib_path and fall through to a plain exec.
  # The binary's OWN dir holds all its .so files (libggml*, libllama-server-impl,
  # …). Put that absolute dir FIRST on LD_LIBRARY_PATH so lib resolution never
  # depends on the find succeeding in the agent's exec context (where it returned
  # empty, dropping to a libless plain exec → "CANNOT LINK EXECUTABLE … library
  # not found"). The find still contributes any sibling lib dirs. Trigger the
  # linker64 path whenever the binary lives under .local/llama.cpp.
  server_dir="$(dirname "$server_bin")"
  llama_lib_path="$(find "$HOME/.local/llama.cpp" -type f \( -name '*.so' -o -name '*.so.*' \) -exec dirname {} \; 2>/dev/null | sort -u | tr '\n' ':')"
  use_linker64=0
  case "$server_bin" in "$HOME/.local/llama.cpp"/*) use_linker64=1 ;; esac
  if [ -n "$llama_lib_path" ]; then use_linker64=1; fi
  if [ "$use_linker64" = 1 ] && [ -x /system/bin/linker64 ]; then
    (
      cd "$server_dir" 2>/dev/null || true
      # The agent exec context sets LD_PRELOAD=libexec_wrapper.so (shelly-exec.c);
      # inherited into the linker64 launch it breaks llama-server's own .so
      # resolution ("library libllama-server-impl.so not found"). The in-app Start
      # unsets it for the same reason — mirror that.
      unset LD_PRELOAD
      export LD_LIBRARY_PATH="$server_dir:${llama_lib_path}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      nohup /system/bin/nice -n 5 /system/bin/linker64 "$server_bin" --model "$model_path" --alias "$alias_name" --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --threads "$threads" --log-disable ${LLAMA_SERVER_EXTRA_ARGS:-} > "$log_file" 2>&1 &
      echo $! > "$pid_file"
    )
  else
    nohup /system/bin/nice -n 5 "$server_bin" --model "$model_path" --alias "$alias_name" --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --threads "$threads" --log-disable ${LLAMA_SERVER_EXTRA_ARGS:-} > "$log_file" 2>&1 &
    echo $! > "$pid_file"
  fi

  ready_seconds="${LOCAL_LLM_START_TIMEOUT_SECONDS:-90}"
  _i=0
  while [ "$_i" -lt "$ready_seconds" ]; do
    if local_llm_ready "$base_url" 3 "$TMP_DIR/local-llm-ready-$AGENT_ID.err" &&
      local_llm_server_matches_model "$base_url" "$alias_name" 3 "$TMP_DIR/local-llm-models-$AGENT_ID.err"; then
      local_llm_touch_activity
      local_llm_start_idle_watcher "$(cat "$pid_file" 2>/dev/null || true)" "$idle_timeout" "$pid_file" "$log_file"
      rm -rf "$lock_dir" 2>/dev/null || true
      return 0
    fi
    sleep 1
    _i=$((_i + 1))
  done

  {
    echo "auto-start failed: llama-server did not become ready within $ready_seconds seconds"
    echo "server: $server_bin"
    echo "model: $model_path"
    echo "endpoint: $base_url"
    echo "log: $log_file"
    echo "log tail:"
    tail -n 40 "$log_file" 2>/dev/null || true
  } > "$reason_file"
  rm -rf "$lock_dir" 2>/dev/null || true
  return 1
}
