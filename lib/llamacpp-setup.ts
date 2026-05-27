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
    id: 'qwen3.5-4b-q4-k-m',
    name: 'Qwen3.5-4B Q4_K_M',
    description: '推奨・高品質。スマホ上のAIペインで常用しやすい速度と賢さのバランスが良いモデル。',
    sizeGb: 2.5,
    ramRequiredGb: 5.0,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-4B-GGUF',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    recommended: true,
    badge: '推奨',
  },
  {
    id: 'qwen3.5-9b-q4-k-m',
    name: 'Qwen3.5-9B Q4_K_M',
    description: 'Qwen3.5小型系列の高品質枠。Z Fold6では品質優先時向け、長文では発熱と待ち時間に注意。',
    sizeGb: 5.2,
    ramRequiredGb: 6.8,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3.5-9B-GGUF',
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    badge: '高品質',
  },
  {
    id: 'qwen3-8b-q4-k-m',
    name: 'Qwen3-8B Q4_K_M',
    description: '旧推奨・互換用。Qwen3.5の8B公式小型モデルはないため、既存8Bモデルを残す。',
    sizeGb: 4.7,
    ramRequiredGb: 6.0,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'Qwen/Qwen3-8B-GGUF',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    badge: 'Legacy 8B',
  },
  {
    id: 'gemma3-4b-q4',
    name: 'Gemma 3 4B',
    description: '日本語インストラクション追従が3-4Bクラス最強。意図分類・出力解釈・チャット全てに最適。',
    sizeGb: 2.5,
    ramRequiredGb: 5.0,
    language: 'multilingual',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    filename: 'gemma-3-4b-it-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf',
  },
  {
    id: 'qwen2.5-1.5b-q4',
    name: 'Qwen 2.5 1.5B',
    description: '超軽量・超高速。Nacre音声後処理と共用。推論2倍速で1-3秒応答。',
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
  },
  {
    id: 'qwen3-4b-q4',
    name: 'Qwen 3 4B',
    description: 'Qwen2.5比で大幅に賢い。日中英バランス良好。Z Fold6に最適。',
    sizeGb: 2.6,
    ramRequiredGb: 5.0,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    filename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    badge: 'Qwen',
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
  },
];

// ─── Setup Script Generator ───────────────────────────────────────────────────

const MODELS_DIR = '$HOME/models';
// Resolved inside generated shell scripts. Native exec does not always source
// interactive shell rc files, so do not rely on $HOME/.local/bin being on PATH.
const SERVER_BIN =
  `/system/bin/sh -c 'cd "$1" || exit 1; shift; exec /system/bin/env -u LD_PRELOAD HOME="$HOME" ANDROID_ROOT="\${ANDROID_ROOT:-/system}" ANDROID_DATA="\${ANDROID_DATA:-/data}" LD_LIBRARY_PATH="\${LLAMA_LIB_PATH}\${SHELLY_LD_LIBRARY_PATH:+:$SHELLY_LD_LIBRARY_PATH}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" /system/bin/linker64 "$@"' sh "$REAL_LLAMA_SERVER_DIR" "$REAL_LLAMA_SERVER_BIN"`;

const LLAMA_SERVER_BIN_INIT =
  'LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$(command -v llama-server 2>/dev/null || printf \'%s\' "$HOME/.local/bin/llama-server")}"';

const REAL_LLAMA_SERVER_BIN_INIT = [
  `REAL_LLAMA_SERVER_BIN="$(find "$HOME/.local/llama.cpp" -type f -name llama-server 2>/dev/null | head -n 1)"`,
  `if [ -z "$REAL_LLAMA_SERVER_BIN" ]; then`,
  `  echo "llama-server binary not found under $HOME/.local/llama.cpp"`,
  `  echo "Run llama.cpp setup first."`,
  `  exit 1`,
  `fi`,
  `if [ ! -x "$REAL_LLAMA_SERVER_BIN" ]; then`,
  `  echo "llama-server binary is not executable: $REAL_LLAMA_SERVER_BIN"`,
  `  exit 1`,
  `fi`,
  `REAL_LLAMA_SERVER_DIR="\${REAL_LLAMA_SERVER_BIN%/*}"`,
  `LLAMA_LIB_PATH="$(find "$HOME/.local/llama.cpp" -type f \\( -name '*.so' -o -name '*.so.*' \\) -exec dirname {} \\; 2>/dev/null | sort -u | tr '\\n' ':')"`,
  `export LLAMA_LIB_PATH`,
].join('\n');

const HEALTH_CHECK_CMD = [
  `node -e 'const http=require("http");const req=http.get("http://127.0.0.1:8080/v1/models",res=>{process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on("error",()=>process.exit(1));req.setTimeout(2000,()=>{req.destroy();process.exit(1);});' >/dev/null 2>&1`,
  `curl -fsS --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1`,
  `wget -q -T 2 -O - http://127.0.0.1:8080/v1/models >/dev/null 2>&1`,
].join(' || ');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const INSTALL_LLAMA_SERVER_CMD = `mkdir -p "$HOME/.cache/shelly" && cat > "$HOME/.cache/shelly/shelly-install-llama-server.js" <<'NODE'
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const home = process.env.HOME;
const tmpDir = home + '/.cache/shelly/llama-server-install';
const outDir = home + '/.local/bin';
const installDir = home + '/.local/llama.cpp';
const tmpInstallDir = home + '/.local/llama.cpp.tmp';
const releaseApi = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

function writeWrapper(finalBinary) {
  const binaryDir = finalBinary.slice(0, finalBinary.lastIndexOf('/'));
  const libPath = [...collectSoDirs(installDir), binaryDir, installDir, installDir + '/lib'].join(':');
  const wrapper = '#!/bin/sh\\ncd "' + binaryDir + '" || exit 1\\nexport LD_LIBRARY_PATH="' + libPath + ':\${LD_LIBRARY_PATH:-}"\\nunset LD_PRELOAD\\nif [ -x /system/bin/linker64 ]; then\\n  exec /system/bin/linker64 "' + finalBinary + '" "$@"\\nfi\\nexec "' + finalBinary + '" "$@"\\n';
  fs.writeFileSync(outDir + '/llama-server', wrapper, { mode: 0o755 });
  fs.chmodSync(outDir + '/llama-server', 0o755);
}

function requestText(urlText, redirects = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Shelly-local-llm-installer/1' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume();
        if (redirects <= 0) reject(new Error('too many redirects'));
        else resolve(requestText(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode + ' from ' + urlText));
        else resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

function download(urlText, outFile, redirects = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Shelly-local-llm-installer/1' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume();
        if (redirects <= 0) reject(new Error('too many redirects'));
        else resolve(download(new URL(res.headers.location, url).toString(), outFile, redirects - 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error('download failed: HTTP ' + res.statusCode));
        return;
      }
      const tmp = outFile + '.part';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, outFile);
        resolve();
      }));
      file.on('error', (err) => {
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
  });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(cmd + ' failed with exit ' + r.status);
}

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const path = cur + '/' + entry.name;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name === name) return path;
    }
  }
  return null;
}

function collectSoDirs(dir) {
  const dirs = new Set();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const path = cur + '/' + entry.name;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.includes('.so')) dirs.add(cur);
    }
  }
  return Array.from(dirs);
}

(async () => {
  if (!home) throw new Error('HOME is not set');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const existingBinary = fs.existsSync(installDir) ? findFile(installDir, 'llama-server') : null;
  if (existingBinary) {
    fs.chmodSync(existingBinary, 0o755);
    writeWrapper(existingBinary);
    console.log('Repaired: ' + outDir + '/llama-server');
    return;
  }

  const release = JSON.parse(await requestText(releaseApi));
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => {
    const name = (a.name || '').toLowerCase();
    return name.includes('bin-android-arm64') &&
      (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.zip'));
  });
  if (!asset || !asset.browser_download_url) {
    throw new Error('android arm64 llama.cpp asset not found. assets: ' + assets.map((a) => a.name).join(', '));
  }

  const archive = tmpDir + '/' + asset.name;
  console.log('Downloading ' + asset.name);
  await download(asset.browser_download_url, archive);

  const extractDir = tmpDir + '/extract';
  fs.mkdirSync(extractDir, { recursive: true });
  if (asset.name.toLowerCase().endsWith('.zip')) run('unzip', ['-o', archive, '-d', extractDir]);
  else run('tar', ['-xzf', archive, '-C', extractDir]);

  const binary = findFile(extractDir, 'llama-server');
  if (!binary) throw new Error('llama-server binary not found inside archive');

  fs.rmSync(tmpInstallDir, { recursive: true, force: true });
  fs.mkdirSync(tmpInstallDir, { recursive: true });
  fs.cpSync(extractDir, tmpInstallDir, { recursive: true });
  const installedBinary = findFile(tmpInstallDir, 'llama-server');
  fs.chmodSync(installedBinary, 0o755);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.renameSync(tmpInstallDir, installDir);

  const finalBinary = findFile(installDir, 'llama-server');
  writeWrapper(finalBinary);
  console.log('Installed: ' + outDir + '/llama-server');
})().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
NODE
node "$HOME/.cache/shelly/shelly-install-llama-server.js"`;

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
    `  node -e 'const fs=require("fs"),http=require("http"),https=require("https");const url=process.env.MODEL_URL,dest=process.env.MODEL_DEST;function go(u,n){const x=new URL(u),c=x.protocol==="https:"?https:http,r=c.get(x,{headers:{"User-Agent":"Shelly-model-downloader/1"}},res=>{if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();if(n<=0)throw Error("too many redirects");return go(new URL(res.headers.location,x).toString(),n-1)}if(!res.statusCode||res.statusCode>=400){res.resume();throw Error("HTTP "+res.statusCode)}res.pipe(fs.createWriteStream(dest)).on("finish",()=>{})});r.on("error",e=>{console.error(e.message);process.exit(1)});r.setTimeout(30000,()=>r.destroy(Error("download timed out")))}go(url,5);'`,
    `fi`,
    `test -s "$MODEL_DEST"`,
    `echo "Download complete: ${dest}"`,
  ].join(' && ');
}

/**
 * llama-serverの起動コマンドを生成する。
 * OpenAI互換エンドポイント（/v1/chat/completions）を提供。
 */
export function buildServerStartCommand(config: LlamaCppServerConfig): string {
  const args = [
    `--model "${config.modelPath}"`,
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
  const config: LlamaCppServerConfig = {
    port: 8080,
    modelPath,
    // Z Fold6 local use prioritizes system responsiveness. Keep threads low so
    // Shelly and the AI pane stay responsive while Qwen3.5 is running locally.
    contextSize: 1024,
    threads: 2,
    gpuLayers: 0, // Adreno GPU offloadは現状不安定なためCPU only
  };
  return buildServerStartCommand(config);
}

/**
 * バックグラウンド常駐起動スクリプト（nohup）を生成する。
 */
export function buildDaemonStartScript(model: LlamaCppModel, modelPath?: string): string {
  const logFile = `${MODELS_DIR}/llama-server.log`;
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const resolvedModelPath = modelPath ?? `${MODELS_DIR}/${model.filename}`;
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
    `echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"`,
    `echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"`,
    `echo "model: $MODEL_PATH"`,
    `pkill -x llama-server 2>/dev/null || true`,
    `sleep 1`,
    `nohup /system/bin/nice -n 10 ${startCmd} > "${logFile}" 2>&1 &`,
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
  return `pkill -x llama-server && echo "llama-server stopped" || echo "llama-server not running"`;
}

/**
 * llama-serverの状態確認コマンドを生成する。
 */
export function buildStatusCommand(): string {
  return [
    `if ${HEALTH_CHECK_CMD}; then`,
    `  echo "running"`,
    `  exit 0`,
    `fi`,
    `if pgrep -x llama-server >/dev/null 2>&1; then`,
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
export function buildDeleteModelCommand(model: LlamaCppModel): string {
  return `rm -f "${MODELS_DIR}/${model.filename}" && echo "Deleted: ${model.filename}"`;
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
  const resolvedModelPath = `${MODELS_DIR}/${model.filename}`;
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
    `echo "llama-server binary: $REAL_LLAMA_SERVER_BIN"`,
    `echo "llama-server dir: $REAL_LLAMA_SERVER_DIR"`,
    `echo "model: $MODEL_PATH"`,
    ``,
    `# 1. 既存プロセスを停止`,
    `pkill -x llama-server 2>/dev/null || true`,
    `sleep 1`,
    ``,
    `# 2. llama-serverをバックグラウンドで起動`,
    `echo "llama-serverを起動中..."`,
    `nohup /system/bin/nice -n 10 ${startCmd} > "${logFile}" 2>&1 &`,
    `echo $! > "${pidFile}"`,
    `echo "llama-server started (PID: $(cat ${pidFile}))"`,
    ``,
    `# 3. llama-serverの起動を待つ（最大180秒）`,
    `for i in $(seq 1 180); do`,
    `  if ${HEALTH_CHECK_CMD}; then`,
    `    echo "llama-server ready!"`,
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
