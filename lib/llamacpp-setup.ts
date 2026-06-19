/**
 * lib/llamacpp-setup.ts — v2.7
 *
 * llama.cpp setup for local LLM
 *
 * 設計方針:
 * - llama.cpp setup for local LLM（ビルド不要）
 * - モデルはHugging FaceからGGUF形式で直接ダウンロード
 * - ShellyのLocal LLM設定（http://127.0.0.1:8080）と自動連携
 * - llama-serverはOpenAI互換API（/v1/chat/completions）を提供
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LlamaCppModel {
  id: string;
  name: string;
  description: string;
  sizeGb: number;
  ramRequiredGb: number;
  language: 'ja' | 'en' | 'multilingual';
  useCase: 'chat' | 'code' | 'balanced';
  quantization: string;
  huggingFaceRepo: string;
  filename: string;
  downloadUrl: string;
  recommended?: boolean;
  badge?: string;
  hidden?: boolean;
}

export interface LlamaCppSetupStep {
  id: string;
  label: string;
  command: string;
  estimatedSeconds: number;
  critical: boolean; // falseなら失敗してもスキップ可能
}

export interface LlamaCppServerConfig {
  port: number;
  modelPath: string;
  contextSize: number;
  threads: number;
  gpuLayers: number; // Snapdragon GPU offload（0=CPU only）
}

export interface LlamaCppRuntimeProfile {
  contextSize: number;
  threads: number;
  idleTimeoutSeconds: number;
}

export type SetupPhase =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'downloading'
  | 'starting'
  | 'done'
  | 'error';

// ─── Model Catalog ────────────────────────────────────────────────────────────

/**
 * Z Fold6（RAM 12GB）向け推奨モデルカタログ。
 * RAMの目安: モデルサイズ × 1.2 + システム用2GB
 */
export const MODEL_CATALOG: LlamaCppModel[] = [
  {
    id: 'qwen3.5-2b-q4',
    name: 'Qwen3.5-2B Q4_K_M',
    description: '標準。短い下書き、軽い推論、ベリファイア向け。常時起動よりオンデマンド利用向け。',
    sizeGb: 1.3,
    ramRequiredGb: 3.2,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-2B-GGUF',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    badge: '標準',
  },
  {
    id: 'qwen3-1.7b-q4',
    name: 'Qwen3 1.7B Q4_K_M',
    description: 'Legacy optional fallback. Kept only so already-installed files can be detected and removed.',
    sizeGb: 1.1,
    ramRequiredGb: 2.9,
    language: 'ja',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3-1.7B-GGUF',
    filename: 'Qwen3-1.7B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    badge: '軽量',
    hidden: true,
  },
  {
    id: 'qwen3.5-0.8b-q4',
    name: 'Qwen3.5-0.8B Q4_K_M',
    description: '推奨。分類、ルーティング、スキーマ検証、短文補助向け。自律エージェントの常用起点。',
    sizeGb: 0.6,
    ramRequiredGb: 1.8,
    language: 'ja',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-0.8B-GGUF',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    recommended: true,
    badge: '推奨',
  },
  {
    id: 'qwen3.5-4b-q4',
    name: 'Qwen3.5-4B Q4_K_M',
    description: '品質確認用。Z Fold6でもバックグラウンドアプリを落とすほど重くなるため、常用既定にはしない。',
    sizeGb: 2.7,
    ramRequiredGb: 5.8,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-4B-GGUF',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    badge: '高負荷',
  },
  {
    id: 'qwen3.5-9b-q4',
    name: 'Qwen3.5-9B Q4_K_M',
    description: 'Legacy removal target. Too heavy for Shelly on-device autonomous use.',
    sizeGb: 5.3,
    ramRequiredGb: 9.0,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-9B-GGUF',
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    badge: '削除推奨',
    hidden: true,
  },
  {
    id: 'gemma3-4b-q4',
    name: 'Gemma 3 4B',
    description: '高品質だが重い比較用モデル。長時間常用より、短時間の品質確認向け。',
    sizeGb: 2.5,
    ramRequiredGb: 5.0,
    language: 'multilingual',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    filename: 'gemma-3-4b-it-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf',
    hidden: true,
  },
  {
    id: 'qwen2.5-1.5b-q4',
    name: 'Qwen 2.5 1.5B',
    description: '旧軽量候補。Qwen3 1.7Bが未導入の端末向けfallback。',
    sizeGb: 1.1,
    ramRequiredGb: 3.3,
    language: 'ja',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    badge: '軽量',
    hidden: true,
  },
  {
    id: 'qwen2.5-3b-q4',
    name: 'Qwen 2.5 3B',
    description: '軽量・高速・日本語対応。Z Fold6で快適動作。チャット応答が速い。',
    sizeGb: 2.0,
    ramRequiredGb: 4.4,
    language: 'ja',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    hidden: true,
  },
  {
    id: 'phi4-mini-q4',
    name: 'Phi-4 Mini',
    description: 'Microsoftの超軽量モデル。推論・数学に強い。',
    sizeGb: 2.2,
    ramRequiredGb: 4.6,
    language: 'multilingual',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'microsoft/Phi-4-mini-instruct-GGUF',
    filename: 'Phi-4-mini-instruct-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/microsoft/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf',
    badge: 'Microsoft',
    hidden: true,
  },
  {
    id: 'llama3.2-3b-q4',
    name: 'Llama 3.2 3B',
    description: 'Meta製。英語メインだが安定性が高い。',
    sizeGb: 2.0,
    ramRequiredGb: 4.4,
    language: 'en',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    badge: 'Meta',
    hidden: true,
  },
];

// ─── Setup Script Generator ───────────────────────────────────────────────────

const MODELS_DIR = '$HOME/models';
// Resolved inside generated shell scripts. Native exec does not always source
// interactive shell rc files, so do not rely on $HOME/.local/bin being on PATH.
const SERVER_BIN =
  `/system/bin/sh -c 'cd "$1" || exit 1; shift; unset LD_PRELOAD; export HOME="$HOME"; export ANDROID_ROOT="\${ANDROID_ROOT:-/system}"; export ANDROID_DATA="\${ANDROID_DATA:-/data}"; export LD_LIBRARY_PATH="\${LLAMA_LIB_PATH}\${SHELLY_LD_LIBRARY_PATH:+:$SHELLY_LD_LIBRARY_PATH}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; exec /system/bin/linker64 "$@"' sh "$REAL_LLAMA_SERVER_DIR" "$REAL_LLAMA_SERVER_BIN"`;

const LLAMA_SERVER_BIN_INIT =
  'LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/.local/bin/llama-server}"';

const REAL_LLAMA_SERVER_BIN_INIT = [
  `INSTALL_MARKER="$HOME/.local/llama.cpp/.shelly-install-ok"`,
  `if [ ! -f "$INSTALL_MARKER" ]; then`,
  `  echo "llama.cpp install is incomplete; run llama.cpp Setup and wait for Setup complete."`,
  `  exit 1`,
  `fi`,
  `if [ ! -e "$LLAMA_SERVER_BIN" ]; then`,
  `  echo "llama-server launcher metadata is missing: $LLAMA_SERVER_BIN"`,
  `fi`,
  `REALPATH_FILE="$HOME/.local/bin/llama-server.realpath"`,
  `if [ ! -s "$REALPATH_FILE" ]; then`,
  `  echo "llama-server real binary metadata is missing: $REALPATH_FILE"`,
  `  echo "Run llama.cpp setup first."`,
  `  exit 1`,
  `fi`,
  `REAL_LLAMA_SERVER_BIN="$(cat "$REALPATH_FILE" 2>/dev/null || true)"`,
  `if [ ! -x "$REAL_LLAMA_SERVER_BIN" ]; then`,
  `  echo "llama-server binary not found or not executable: $REAL_LLAMA_SERVER_BIN"`,
  `  echo "Run llama.cpp setup first."`,
  `  exit 1`,
  `fi`,
  `REAL_LLAMA_SERVER_DIR="\${REAL_LLAMA_SERVER_BIN%/*}"`,
  `LLAMA_LIB_PATH="$(find "$HOME/.local/llama.cpp" -type f \\( -name '*.so' -o -name '*.so.*' \\) -exec dirname {} \\; 2>/dev/null | sort -u | tr '\\n' ':')"`,
  `export LLAMA_LIB_PATH`,
].join('\n');

const HEALTH_CHECK_CMD = [
  `command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1`,
  `command -v wget >/dev/null 2>&1 && wget -q -T 2 -O - http://127.0.0.1:8080/v1/models >/dev/null 2>&1`,
  `command -v toybox >/dev/null 2>&1 && printf 'GET /v1/models HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' | toybox nc -w 2 127.0.0.1 8080 2>/dev/null | grep -q 'HTTP/1\\.[01] 200'`,
].join(' || ');

function normalizedModelText(model: LlamaCppModel): string {
  return `${model.id} ${model.name} ${model.filename}`.toLowerCase();
}

export function getModelRuntimeProfile(model: LlamaCppModel): LlamaCppRuntimeProfile {
  const text = normalizedModelText(model);
  if (text.includes('0.8b') || text.includes('0-8b')) {
    return { contextSize: 1024, threads: 2, idleTimeoutSeconds: 600 };
  }
  if (text.includes('1.7b') || text.includes('1-7b')) {
    return { contextSize: 1024, threads: 3, idleTimeoutSeconds: 300 };
  }
  if (text.includes('2b')) {
    return { contextSize: 1024, threads: 4, idleTimeoutSeconds: 180 };
  }
  if (text.includes('4b')) {
    return { contextSize: 768, threads: 4, idleTimeoutSeconds: 60 };
  }
  if (text.includes('9b') || text.includes('8b')) {
    return { contextSize: 512, threads: 3, idleTimeoutSeconds: 30 };
  }
  return { contextSize: 1024, threads: 3, idleTimeoutSeconds: 180 };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuoteContent(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function basenameOfPath(value: string): string {
  const i = value.lastIndexOf('/');
  return i >= 0 ? value.slice(i + 1) : value;
}

const TLS_ENV_PRELUDE = [
  'SHELLY_CA="$HOME/.shelly-ssl/ca-certificates.crt"',
  'SHELLY_OPENSSL_CONF="$HOME/.shelly-ssl/openssl.cnf"',
  'if [ -s "$SHELLY_CA" ]; then',
  '  export SSL_CERT_FILE="$SHELLY_CA"',
  '  export CURL_CA_BUNDLE="$SHELLY_CA"',
  '  export REQUESTS_CA_BUNDLE="$SHELLY_CA"',
  '  export GIT_SSL_CAINFO="$SHELLY_CA"',
  '  export NODE_EXTRA_CA_CERTS="$SHELLY_CA"',
  '  export SSL_CERT_DIR="$HOME/.shelly-ssl"',
  'else',
  '  [ -n "${SSL_CERT_FILE:-}" ] && [ ! -r "$SSL_CERT_FILE" ] && unset SSL_CERT_FILE',
  '  [ -n "${CURL_CA_BUNDLE:-}" ] && [ ! -r "$CURL_CA_BUNDLE" ] && unset CURL_CA_BUNDLE',
  '  [ -n "${REQUESTS_CA_BUNDLE:-}" ] && [ ! -r "$REQUESTS_CA_BUNDLE" ] && unset REQUESTS_CA_BUNDLE',
  '  [ -n "${GIT_SSL_CAINFO:-}" ] && [ ! -r "$GIT_SSL_CAINFO" ] && unset GIT_SSL_CAINFO',
  '  [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ ! -r "$NODE_EXTRA_CA_CERTS" ] && unset NODE_EXTRA_CA_CERTS',
  '  [ -n "${SSL_CERT_DIR:-}" ] && [ ! -d "$SSL_CERT_DIR" ] && unset SSL_CERT_DIR',
  'fi',
  'if [ -e "$SHELLY_OPENSSL_CONF" ]; then',
  '  export OPENSSL_CONF="$SHELLY_OPENSSL_CONF"',
  'elif [ -n "${OPENSSL_CONF:-}" ] && [ ! -r "$OPENSSL_CONF" ]; then',
  '  unset OPENSSL_CONF',
  'fi',
].join('\n');

const INSTALL_LLAMA_SERVER_CMD = `set -e
INSTALL_DIR="$HOME/.local/llama.cpp"
TMP_ROOT="$HOME/.cache/shelly/llama-server-install"
TMP_INSTALL_DIR="$HOME/.local/llama.cpp.tmp"
OUT_DIR="$HOME/.local/bin"
RELEASE_API="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
INSTALL_MARKER="$INSTALL_DIR/.shelly-install-ok"

mkdir -p "$TMP_ROOT" "$OUT_DIR"
${TLS_ENV_PRELUDE}

fetch_text() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - "$1"
  else
    echo "curl or wget is required to install llama.cpp" >&2
    return 127
  fi
}

download_file() {
  url="$1"
  out_file="$2"
  tmp_file="$out_file.part"
  rm -f "$tmp_file"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 --retry-delay 2 -o "$tmp_file" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$tmp_file" "$url"
  else
    echo "curl or wget is required to install llama.cpp" >&2
    return 127
  fi
  mv "$tmp_file" "$out_file"
}

find_llama_server() {
  find "$1" -type f -name llama-server 2>/dev/null | head -n 1
}

find_common_lib() {
  find "$1" -type f -name libllama-common.so 2>/dev/null | head -n 1
}

collect_so_dirs() {
  find "$INSTALL_DIR" -type f \\( -name '*.so' -o -name '*.so.*' \\) -exec dirname {} \\; 2>/dev/null | sort -u | tr '\\n' ':'
}

write_wrapper() {
  FINAL_BINARY="$1"
  BINARY_DIR="$(dirname "$FINAL_BINARY")"
  LIB_PATH="$(collect_so_dirs)$BINARY_DIR:$INSTALL_DIR:$INSTALL_DIR/lib"
  cat > "$OUT_DIR/llama-server" <<WRAPPER_EOF
#!/system/bin/sh
cd "$BINARY_DIR" || exit 1
export LD_LIBRARY_PATH="$LIB_PATH:\\$LD_LIBRARY_PATH"
unset LD_PRELOAD
if [ -x /system/bin/linker64 ]; then
  exec /system/bin/linker64 "$FINAL_BINARY" "\\$@"
fi
exec "$FINAL_BINARY" "\\$@"
WRAPPER_EOF
  printf '%s\\n' "$FINAL_BINARY" > "$OUT_DIR/llama-server.realpath"
  chmod 755 "$OUT_DIR/llama-server" "$FINAL_BINARY"
}

smoke_test_binary() {
  FINAL_BINARY="$1"
  BINARY_DIR="$(dirname "$FINAL_BINARY")"
  LIB_PATH="$(collect_so_dirs)$BINARY_DIR:$INSTALL_DIR:$INSTALL_DIR/lib"
  (
    cd "$BINARY_DIR" || exit 1
    unset LD_PRELOAD
    export ANDROID_ROOT="\${ANDROID_ROOT:-/system}"
    export ANDROID_DATA="\${ANDROID_DATA:-/data}"
    export LD_LIBRARY_PATH="$LIB_PATH:$LD_LIBRARY_PATH"
    if [ -x /system/bin/linker64 ]; then
      /system/bin/linker64 "$FINAL_BINARY" --version >/dev/null 2>&1 ||
        /system/bin/linker64 "$FINAL_BINARY" --help >/dev/null 2>&1
    else
      "$FINAL_BINARY" --version >/dev/null 2>&1 || "$FINAL_BINARY" --help >/dev/null 2>&1
    fi
  )
}

EXISTING_BINARY=""
if [ -d "$INSTALL_DIR" ]; then
  EXISTING_BINARY="$(find_llama_server "$INSTALL_DIR")"
fi
if [ -n "$EXISTING_BINARY" ] && [ -n "$(find_common_lib "$INSTALL_DIR")" ] && [ -f "$INSTALL_MARKER" ]; then
  chmod 755 "$EXISTING_BINARY"
  write_wrapper "$EXISTING_BINARY"
  if smoke_test_binary "$EXISTING_BINARY"; then
    printf 'ok\\n' > "$INSTALL_MARKER"
    echo "Repaired: $OUT_DIR/llama-server"
    exit 0
  fi
  echo "Existing llama-server failed smoke test; reinstalling..."
elif [ -n "$EXISTING_BINARY" ]; then
  chmod 755 "$EXISTING_BINARY" 2>/dev/null || true
  write_wrapper "$EXISTING_BINARY"
  if smoke_test_binary "$EXISTING_BINARY"; then
    echo "Existing llama-server install is from an older Shelly setup; reinstalling to refresh launcher metadata..."
  else
    echo "Existing llama-server install is incomplete; reinstalling..."
  fi
fi

RELEASE_JSON="$TMP_ROOT/release.json"
fetch_text "$RELEASE_API" > "$RELEASE_JSON"
ASSET_URL="$(grep -o 'https://[^"]*bin-android-arm64[^"]*' "$RELEASE_JSON" | grep -E '\\.(tar\\.gz|tgz|zip)$' | head -n 1)"
if [ -z "$ASSET_URL" ]; then
  echo "android arm64 llama.cpp asset not found in latest release" >&2
  grep -o '"name":[^,]*' "$RELEASE_JSON" | head -n 20 >&2 || true
  exit 1
fi

ASSET_NAME="$(basename "$ASSET_URL")"
ARCHIVE="$TMP_ROOT/$ASSET_NAME"
EXTRACT_DIR="$TMP_ROOT/extract"
rm -rf "$EXTRACT_DIR" "$TMP_INSTALL_DIR" "$ARCHIVE" "$ARCHIVE.part"
mkdir -p "$EXTRACT_DIR" "$TMP_INSTALL_DIR"

echo "Downloading $ASSET_NAME"
download_file "$ASSET_URL" "$ARCHIVE"

case "$ARCHIVE" in
  *.zip)
    command -v unzip >/dev/null 2>&1 || { echo "unzip is required to extract $ASSET_NAME" >&2; exit 1; }
    unzip -oq "$ARCHIVE" -d "$EXTRACT_DIR"
    ;;
  *)
    command -v tar >/dev/null 2>&1 || { echo "tar is required to extract $ASSET_NAME" >&2; exit 1; }
    tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"
    ;;
esac

BINARY="$(find_llama_server "$EXTRACT_DIR")"
if [ -z "$BINARY" ]; then
  echo "llama-server binary not found inside $ASSET_NAME" >&2
  exit 1
fi
if [ -z "$(find_common_lib "$EXTRACT_DIR")" ]; then
  echo "libllama-common.so not found inside $ASSET_NAME" >&2
  exit 1
fi

cp -R "$EXTRACT_DIR"/. "$TMP_INSTALL_DIR"/
INSTALLED_BINARY="$(find_llama_server "$TMP_INSTALL_DIR")"
if [ -z "$INSTALLED_BINARY" ]; then
  echo "llama-server binary disappeared during install copy" >&2
  exit 1
fi
chmod 755 "$INSTALLED_BINARY"
rm -rf "$INSTALL_DIR"
mv "$TMP_INSTALL_DIR" "$INSTALL_DIR"

FINAL_BINARY="$(find_llama_server "$INSTALL_DIR")"
write_wrapper "$FINAL_BINARY"
if ! smoke_test_binary "$FINAL_BINARY"; then
  echo "Installed llama-server failed smoke test" >&2
  BINARY_DIR="$(dirname "$FINAL_BINARY")"
  LIB_PATH="$(collect_so_dirs)$BINARY_DIR:$INSTALL_DIR:$INSTALL_DIR/lib"
  (cd "$BINARY_DIR" && LD_LIBRARY_PATH="$LIB_PATH:$LD_LIBRARY_PATH" /system/bin/linker64 "$FINAL_BINARY" --version) 2>&1 | head -n 20 >&2 || true
  exit 1
fi
printf 'ok\\n' > "$INSTALL_MARKER"
echo "Installed: $OUT_DIR/llama-server"`;

/**
 * llama.cppのセットアップステップ一覧を生成する。
 * v2.7: npm or manual install（ビルド不要・数秒で完了）
 */
export function buildSetupSteps(): LlamaCppSetupStep[] {
  return [
    {
      id: 'install_llamacpp',
      label: 'llama-cppをインストール',
      command: INSTALL_LLAMA_SERVER_CMD,
      estimatedSeconds: 60,
      critical: true,
    },
    {
      id: 'create_models_dir',
      label: 'モデル保存ディレクトリ作成',
      command: `mkdir -p ${MODELS_DIR}`,
      estimatedSeconds: 1,
      critical: false,
    },
  ];
}

/**
 * モデルダウンロードコマンドを生成する。
 */
export function buildDownloadCommand(model: LlamaCppModel): string {
  const dest = `${MODELS_DIR}/${model.filename}`;
  const url = shellQuote(model.downloadUrl);
  const name = shellQuote(model.name);
  return [
    `set -e`,
    TLS_ENV_PRELUDE,
    `echo "Downloading ${model.name} (${model.sizeGb}GB)..."`,
    `mkdir -p ${MODELS_DIR}`,
    `df -h ${MODELS_DIR} 2>/dev/null || true`,
    `MODEL_URL=${url}`,
    `MODEL_NAME=${name}`,
    `MODEL_DEST="${dest}"`,
    `if command -v curl >/dev/null 2>&1; then`,
    `  curl -L --fail --retry 3 --retry-delay 2 -C - -o "$MODEL_DEST" "$MODEL_URL"`,
    `elif command -v wget >/dev/null 2>&1; then`,
    `  wget -c -O "$MODEL_DEST" "$MODEL_URL"`,
    `else`,
    `  echo "Download failed: curl or wget is required." >&2`,
    `  exit 1`,
    `fi`,
    `test -s "$MODEL_DEST"`,
    `echo "Download complete: ${dest}"`,
  ].join('\n');
}

/**
 * llama-serverの起動コマンドを生成する。
 * OpenAI互換エンドポイント（/v1/chat/completions）を提供。
 */
export function buildServerStartCommand(config: LlamaCppServerConfig): string {
  const alias = basenameOfPath(config.modelPath).replace(/\.gguf$/i, '');
  const args = [
    `--model "${config.modelPath}"`,
    `--alias "${shellDoubleQuoteContent(alias)}"`,
    `--port ${config.port}`,
    `--ctx-size ${config.contextSize}`,
    `--threads ${config.threads}`,
    config.gpuLayers > 0 ? `--n-gpu-layers ${config.gpuLayers}` : '',
    '--host 127.0.0.1',
  ]
    .filter(Boolean)
    .join(' \\\n  ');

  return `${SERVER_BIN} \\\n  ${args}`;
}

/**
 * 推奨設定でllama-serverを起動するコマンドを生成する（Z Fold6向け）。
 */
export function buildRecommendedStartCommand(
  model: LlamaCppModel,
  modelPath = `${MODELS_DIR}/${model.filename}`,
): string {
  const profile = getModelRuntimeProfile(model);
  const config: LlamaCppServerConfig = {
    port: 8080,
    modelPath,
    contextSize: profile.contextSize,
    threads: profile.threads,
    gpuLayers: 0, // Adreno GPU offloadは現状不安定なためCPU only
  };
  return buildServerStartCommand(config);
}

function buildIdleWatcherStartLines(
  pidFile: string,
  watcherPidFile: string,
  activityFile: string,
  logFile: string,
  defaultTimeoutSeconds: number,
): string[] {
  return [
    `ACTIVITY_FILE="${activityFile}"`,
    `ACTIVE_DIR="$(dirname "$ACTIVITY_FILE")/llama-server.active"`,
    `WATCHER_PID_FILE="${watcherPidFile}"`,
    `IDLE_TIMEOUT_SECONDS="\${LLAMA_SERVER_IDLE_TIMEOUT_SECONDS:-${defaultTimeoutSeconds}}"`,
    `case "$IDLE_TIMEOUT_SECONDS" in ''|*[!0-9]*) IDLE_TIMEOUT_SECONDS=0 ;; esac`,
    `touch "$ACTIVITY_FILE" 2>/dev/null || true`,
    `if [ "$IDLE_TIMEOUT_SECONDS" -gt 0 ]; then`,
    `  SERVER_PID="$(cat "${pidFile}" 2>/dev/null || true)"`,
    `  if [ -n "$SERVER_PID" ]; then`,
    `    (`,
    `      while kill -0 "$SERVER_PID" 2>/dev/null; do`,
    `        find "$ACTIVE_DIR" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true`,
    `        ACTIVE_COUNT="$(find "$ACTIVE_DIR" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"`,
    `        if [ "\${ACTIVE_COUNT:-0}" != "0" ]; then`,
    `          sleep 15`,
    `          continue`,
    `        fi`,
    `        NOW="$(date +%s)"`,
    `        LAST="$(stat -c %Y "$ACTIVITY_FILE" 2>/dev/null || echo "$NOW")"`,
    `        case "$LAST" in ''|*[!0-9]*) LAST="$NOW" ;; esac`,
    `        if [ $((NOW - LAST)) -ge "$IDLE_TIMEOUT_SECONDS" ]; then`,
    `          echo "llama-server idle timeout after ${defaultTimeoutSeconds}s profile / $IDLE_TIMEOUT_SECONDS effective seconds" >> "${logFile}" 2>/dev/null || true`,
    `          kill "$SERVER_PID" 2>/dev/null || true`,
    `          sleep 1`,
    `          kill -0 "$SERVER_PID" 2>/dev/null && kill -9 "$SERVER_PID" 2>/dev/null || true`,
    `          rm -f "${pidFile}"`,
    `          break`,
    `        fi`,
    `        sleep 15`,
    `      done`,
    `    ) >/dev/null 2>&1 &`,
    `    echo $! > "$WATCHER_PID_FILE"`,
    `    echo "Idle auto-stop: ${defaultTimeoutSeconds}s profile / $IDLE_TIMEOUT_SECONDS effective seconds"`,
    `  fi`,
    `fi`,
  ];
}

function buildStopWatcherLines(watcherPidFile: string): string[] {
  return [
    `if [ -f "${watcherPidFile}" ]; then`,
    `  WATCHER_PID="$(cat "${watcherPidFile}" 2>/dev/null || true)"`,
    `  if [ -n "$WATCHER_PID" ] && kill -0 "$WATCHER_PID" 2>/dev/null; then`,
    `    kill "$WATCHER_PID" 2>/dev/null || true`,
    `  fi`,
    `  rm -f "${watcherPidFile}"`,
    `fi`,
  ];
}

function buildWaitForNoActiveUsersLines(activeDir: string): string[] {
  return [
    `ACTIVE_DIR="${activeDir}"`,
    `RESTART_WAIT_SECONDS="\${LLAMA_SERVER_RESTART_WAIT_SECONDS:-120}"`,
    `case "$RESTART_WAIT_SECONDS" in ''|*[!0-9]*) RESTART_WAIT_SECONDS=0 ;; esac`,
    `if [ -d "$ACTIVE_DIR" ] && [ "$RESTART_WAIT_SECONDS" -gt 0 ]; then`,
    `  WAIT_I=0`,
    `  while [ "$WAIT_I" -lt "$RESTART_WAIT_SECONDS" ]; do`,
    `    find "$ACTIVE_DIR" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true`,
    `    ACTIVE_COUNT="$(find "$ACTIVE_DIR" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"`,
    `    [ "\${ACTIVE_COUNT:-0}" = "0" ] && break`,
    `    echo "Waiting for active local LLM request to finish... ($WAIT_I/$RESTART_WAIT_SECONDS)"`,
    `    sleep 1`,
    `    WAIT_I=$((WAIT_I + 1))`,
    `  done`,
    `  find "$ACTIVE_DIR" -type f -name '*.active' -mmin +5 -delete 2>/dev/null || true`,
    `  ACTIVE_COUNT="$(find "$ACTIVE_DIR" -type f -name '*.active' 2>/dev/null | wc -l | tr -d ' ')"`,
    `  if [ "\${ACTIVE_COUNT:-0}" != "0" ]; then`,
    `    echo "Active local LLM request is still running; refusing to restart llama-server."`,
    `    exit 1`,
    `  fi`,
    `fi`,
  ];
}

/**
 * バックグラウンド常駐起動スクリプト（nohup）を生成する。
 */
export function buildDaemonStartScript(model: LlamaCppModel, modelPath?: string): string {
  const logFile = `${MODELS_DIR}/llama-server.log`;
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const watcherPidFile = `${MODELS_DIR}/llama-server-watcher.pid`;
  const activityFile = `${MODELS_DIR}/llama-server.activity`;
  const activeDir = `${MODELS_DIR}/llama-server.active`;
  const resolvedModelPath = modelPath ?? `${MODELS_DIR}/${model.filename}`;
  const profile = getModelRuntimeProfile(model);
  const startCmd = buildRecommendedStartCommand(model, resolvedModelPath);

  return [
    `# llama-server バックグラウンド起動スクリプト`,
    LLAMA_SERVER_BIN_INIT,
    REAL_LLAMA_SERVER_BIN_INIT,
    `mkdir -p ${MODELS_DIR}`,
    `MODEL_PATH="${resolvedModelPath}"`,
    `if [ ! -s "$MODEL_PATH" ]; then`,
    `  echo "model not found or empty: $MODEL_PATH"`,
    `  exit 1`,
    `fi`,
    `echo "llama-server launcher: $LLAMA_SERVER_BIN"`,
    `echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"`,
    `echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"`,
    `echo "model: $MODEL_PATH"`,
    ...buildWaitForNoActiveUsersLines(activeDir),
    ...buildStopWatcherLines(watcherPidFile),
    `if [ -f "${pidFile}" ]; then`,
    `  OLD_PID="$(cat "${pidFile}" 2>/dev/null || true)"`,
    `  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then`,
    `    kill "$OLD_PID" 2>/dev/null || true`,
    `    sleep 1`,
    `    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true`,
    `  fi`,
    `  rm -f "${pidFile}"`,
    `fi`,
    `OLD_PID="$(ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | awk '{print $2}' | head -n1)"`,
    `if [ -n "$OLD_PID" ]; then`,
    `  kill "$OLD_PID" 2>/dev/null || true`,
    `  sleep 1`,
    `  kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true`,
    `fi`,
    `sleep 1`,
    `echo "launching llama-server..."`,
    `{
  echo "llama-server launcher: $LLAMA_SERVER_BIN"
  echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"
  echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"
  echo "llama-server libs: $LLAMA_LIB_PATH"
  ls -l "$LLAMA_SERVER_BIN" "$REAL_LLAMA_SERVER_BIN" 2>&1 || true
  echo "--- starting llama-server ---"
} > "${logFile}"`,
    `nohup /system/bin/nice -n 5 ${startCmd} >> "${logFile}" 2>&1 &`,
    `echo $! > "${pidFile}"`,
    `echo "llama-server started (PID: $(cat ${pidFile}))"`,
    `echo "API: http://127.0.0.1:8080/v1/chat/completions"`,
    `echo "Log: ${logFile}"`,
    ``,
    `# Verify that the server did not just fork and crash. The settings UI`,
    `# treats exit code 0 as a real Running state, so do not return success`,
    `# until the OpenAI-compatible endpoint is reachable.`,
    `for i in $(seq 1 180); do`,
    `  if ${HEALTH_CHECK_CMD}; then`,
    `    echo "llama-server ready"`,
    ...buildIdleWatcherStartLines(pidFile, watcherPidFile, activityFile, logFile, profile.idleTimeoutSeconds).map(
      (line) => `    ${line}`,
    ),
    `    exit 0`,
    `  fi`,
    `  if ! kill -0 "$(cat "${pidFile}")" 2>/dev/null; then`,
    `    echo "llama-server exited before becoming ready"`,
    `    tail -80 "${logFile}" 2>/dev/null || true`,
    `    exit 1`,
    `  fi`,
    `  echo "Waiting for llama-server... ($i/180)"`,
    `  sleep 1`,
    `done`,
    `echo "llama-server is still running but did not become ready on http://127.0.0.1:8080"`,
    `tail -80 "${logFile}" 2>/dev/null || true`,
    `exit 1`,
  ].join('\n');
}

/**
 * llama-serverの停止コマンドを生成する。
 */
export function buildStopCommand(): string {
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const watcherPidFile = `${MODELS_DIR}/llama-server-watcher.pid`;
  return [
    `STOPPED=0`,
    ...buildStopWatcherLines(watcherPidFile),
    `if [ -f "${pidFile}" ]; then`,
    `  PID="$(cat "${pidFile}" 2>/dev/null || true)"`,
    `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `    kill "$PID" 2>/dev/null || true`,
    `    sleep 1`,
    `    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true`,
    `    STOPPED=1`,
    `  fi`,
    `  rm -f "${pidFile}"`,
    `fi`,
    `PID="$(ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | awk '{print $2}' | head -n1)"`,
    `if [ -n "$PID" ]; then`,
    `  kill "$PID" 2>/dev/null || true`,
    `  sleep 1`,
    `  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true`,
    `  STOPPED=1`,
    `fi`,
    `if [ "$STOPPED" = 1 ]; then echo "llama-server stopped"; else echo "llama-server not running"; fi`,
  ].join('\n');
}

/**
 * llama-serverの状態確認コマンドを生成する。
 */
export function buildStatusCommand(): string {
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  return [
    `if ${HEALTH_CHECK_CMD}; then`,
    `  echo "running"`,
    `  exit 0`,
    `fi`,
    `if [ -f "${pidFile}" ] && PID="$(cat "${pidFile}" 2>/dev/null)" && [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `  echo "starting_or_unreachable"`,
    `  exit 1`,
    `fi`,
    `if ps -Af 2>/dev/null | grep -F llama-server | grep -v grep >/dev/null; then`,
    `  echo "starting_or_unreachable"`,
    `  exit 1`,
    `fi`,
    `echo "stopped"`,
    `exit 1`,
  ].join('\n');
}

/**
 * モデルの削除コマンドを生成する。
 */
export function buildDeleteModelCommand(model: LlamaCppModel, installedPath?: string): string {
  const trimmedPath = installedPath?.trim();
  const hasExactInstalledPath =
    !!trimmedPath &&
    basenameOfPath(trimmedPath).toLowerCase() === model.filename.toLowerCase();
  const targetAssignment = hasExactInstalledPath
    ? `target=${shellQuote(trimmedPath)}`
    : `target="${MODELS_DIR}/${shellDoubleQuoteContent(model.filename)}"`;
  return [
    targetAssignment,
    `rm -f -- "$target"`,
    `if [ -e "$target" ]; then`,
    `  echo "Failed to delete: $target" >&2`,
    `  exit 1`,
    `fi`,
    `echo "Deleted: $target"`,
  ].join('\n');
}

/**
 * インストール済みモデルの一覧取得コマンドを生成する。
 */
export function buildListModelsCommand(): string {
  return `ls -lh "${MODELS_DIR}"/*.gguf 2>/dev/null || echo "no models"`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * モデルIDからカタログエントリを取得する。
 */
export function getModelById(id: string): LlamaCppModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * 推奨モデルを取得する（Z Fold6向けデフォルト）。
 */
export function getRecommendedModel(): LlamaCppModel {
  return MODEL_CATALOG.find((m) => m.recommended) ?? MODEL_CATALOG[0];
}

/**
 * llama.cppのShelly向けLocal LLM設定を返す。
 * llama-serverはOpenAI互換APIを提供する。
 */
export function getLlamaCppLocalLlmConfig(model: LlamaCppModel): {
  baseUrl: string;
  model: string;
  apiType: 'openai_compat';
} {
  return {
    baseUrl: 'http://127.0.0.1:8080',
    model: model.filename.replace('.gguf', ''),
    apiType: 'openai_compat',
  };
}

/**
 * セットアップ全体の推定所要時間（秒）を計算する。
 */
export function estimateTotalSetupTime(steps: LlamaCppSetupStep[]): number {
  return steps.reduce((sum, s) => sum + s.estimatedSeconds, 0);
}

/**
 * llama-server を起動するスクリプトを生成する。
 * llama-serverをバックグラウンドで起動する。
 */
export function buildStartAllScript(model: LlamaCppModel): string {
  const logFile = `${MODELS_DIR}/llama-server.log`;
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const watcherPidFile = `${MODELS_DIR}/llama-server-watcher.pid`;
  const activityFile = `${MODELS_DIR}/llama-server.activity`;
  const activeDir = `${MODELS_DIR}/llama-server.active`;
  const resolvedModelPath = `${MODELS_DIR}/${model.filename}`;
  const profile = getModelRuntimeProfile(model);
  const startCmd = buildRecommendedStartCommand(model, resolvedModelPath);

  return [
    `#!/bin/bash`,
    `# Shelly llama-server 起動スクリプト`,
    ``,
    LLAMA_SERVER_BIN_INIT,
    REAL_LLAMA_SERVER_BIN_INIT,
    `MODEL_PATH="${resolvedModelPath}"`,
    `if [ ! -s "$MODEL_PATH" ]; then`,
    `  echo "model not found or empty: $MODEL_PATH"`,
    `  exit 1`,
    `fi`,
    `echo "llama-server launcher: $LLAMA_SERVER_BIN"`,
    `echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"`,
    `echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"`,
    `echo "model: $MODEL_PATH"`,
    ``,
    `# 1. 既存プロセスを停止`,
    ...buildWaitForNoActiveUsersLines(activeDir),
    ...buildStopWatcherLines(watcherPidFile),
    `if [ -f "${pidFile}" ]; then`,
    `  OLD_PID="$(cat "${pidFile}" 2>/dev/null || true)"`,
    `  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then`,
    `    kill "$OLD_PID" 2>/dev/null || true`,
    `    sleep 1`,
    `    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true`,
    `  fi`,
    `  rm -f "${pidFile}"`,
    `fi`,
    `OLD_PID="$(ps -Af 2>/dev/null | grep -F llama-server | grep -v grep | awk '{print $2}' | head -n1)"`,
    `if [ -n "$OLD_PID" ]; then`,
    `  kill "$OLD_PID" 2>/dev/null || true`,
    `  sleep 1`,
    `  kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true`,
    `fi`,
    `sleep 1`,
    ``,
    `# 2. llama-serverをバックグラウンドで起動`,
    `echo "llama-serverを起動中..."`,
    `echo "llama-server launcher: $LLAMA_SERVER_BIN"`,
    `{
  echo "llama-server launcher: $LLAMA_SERVER_BIN"
  echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"
  echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"
  echo "llama-server libs: $LLAMA_LIB_PATH"
  ls -l "$LLAMA_SERVER_BIN" "$REAL_LLAMA_SERVER_BIN" 2>&1 || true
  echo "--- starting llama-server ---"
} > "${logFile}"`,
    `nohup /system/bin/nice -n 5 ${startCmd} >> "${logFile}" 2>&1 &`,
    `echo $! > "${pidFile}"`,
    `echo "llama-server started (PID: $(cat ${pidFile}))"`,
    ``,
    `# 3. llama-serverの起動を待つ（最大180秒）`,
    `for i in $(seq 1 180); do`,
    `  if ${HEALTH_CHECK_CMD}; then`,
    `    echo "llama-server ready!"`,
    ...buildIdleWatcherStartLines(pidFile, watcherPidFile, activityFile, logFile, profile.idleTimeoutSeconds).map(
      (line) => `    ${line}`,
    ),
    `    exit 0`,
    `  fi`,
    `  if ! kill -0 "$(cat "${pidFile}")" 2>/dev/null; then`,
    `    echo "llama-server exited before becoming ready"`,
    `    tail -80 "${logFile}" 2>/dev/null || true`,
    `    exit 1`,
    `  fi`,
    `  echo "Waiting for llama-server... ($i/180)"`,
    `  sleep 1`,
    `done`,
    ``,
    `echo "llama-server is still running but did not become ready on http://127.0.0.1:8080"`,
    `echo "Log: ${logFile}"`,
    `exit 1`,
  ].join('\n');
}

/**
 * RAM要件チェック。
 * @param availableRamGb 利用可能RAM（GB）
 */
export function checkRamRequirement(
  model: LlamaCppModel,
  availableRamGb: number,
): { ok: boolean; message: string } {
  if (availableRamGb >= model.ramRequiredGb) {
    return { ok: true, message: `RAM OK（必要: ${model.ramRequiredGb}GB, 利用可能: ${availableRamGb}GB）` };
  }
  return {
    ok: false,
    message: `RAM不足（必要: ${model.ramRequiredGb}GB, 利用可能: ${availableRamGb}GB）。より小さいモデルを選んでください。`,
  };
}
