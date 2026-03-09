/**
 * lib/llamacpp-setup.ts — v2.7
 *
 * llama.cpp on Termux セットアップ支援ライブラリ。
 *
 * 設計方針:
 * - Termux公式パッケージ（pkg install llama-cpp）を使用（ビルド不要）
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
    id: 'gemma3-4b-q4',
    name: 'Gemma 3 4B',
    description: '日本語インストラクション追従が3-4Bクラス最強。意図分類・出力解釈・チャット全てに最適。',
    sizeGb: 2.5,
    ramRequiredGb: 5.0,
    language: 'multilingual',
    useCase: 'balanced',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'google/gemma-3-4b-it-GGUF',
    filename: 'gemma-3-4b-it-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/google/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
    recommended: true,
  },
  {
    id: 'qwen3-8b-q3',
    name: 'Qwen 3 8B',
    description: '高品質。日本語・コード・推論すべて優秀。RAM余裕があるなら。',
    sizeGb: 4.0,
    ramRequiredGb: 7.0,
    language: 'ja',
    useCase: 'balanced',
    quantization: 'Q3_K_M',
    huggingFaceRepo: 'unsloth/Qwen3-8B-GGUF',
    filename: 'Qwen3-8B-Q3_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q3_K_M.gguf',
    badge: '高品質',
  },
  {
    id: 'qwen2.5-3b-q4',
    name: 'Qwen 2.5 3B',
    description: '超軽量・高速。日本語対応。発熱を抑えたい場合に。',
    sizeGb: 2.0,
    ramRequiredGb: 4.4,
    language: 'ja',
    useCase: 'chat',
    quantization: 'Q4_K_M',
    huggingFaceRepo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    badge: '軽量',
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
// pkg install llama-cpp でインストールされるバイナリパス
const SERVER_BIN = 'llama-server';

/**
 * llama.cppのセットアップステップ一覧を生成する。
 * v2.7: pkg install を使用（ビルド不要・数秒で完了）
 */
export function buildSetupSteps(): LlamaCppSetupStep[] {
  return [
    {
      id: 'install_llamacpp',
      label: 'llama-cppをインストール（pkg）',
      command: 'pkg install -y llama-cpp',
      estimatedSeconds: 15,
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
  return [
    `echo "Downloading ${model.name} (${model.sizeGb}GB)..."`,
    `mkdir -p ${MODELS_DIR}`,
    `wget -c --show-progress -O "${dest}" "${model.downloadUrl}"`,
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
    '--log-disable',
  ]
    .filter(Boolean)
    .join(' \\\n  ');

  return `${SERVER_BIN} \\\n  ${args}`;
}

/**
 * 推奨設定でllama-serverを起動するコマンドを生成する（Z Fold6向け）。
 */
export function buildRecommendedStartCommand(model: LlamaCppModel): string {
  const config: LlamaCppServerConfig = {
    port: 8080,
    modelPath: `${MODELS_DIR}/${model.filename}`,
    // ctx-sizeを小さくすると起動時間・メモリ・推論速度が大幅改善する
    contextSize: model.useCase === 'chat' ? 2048 : 4096,
    // Snapdragon 8 Gen3: 性能コアは6スレッドまで有効
    threads: 6,
    gpuLayers: 0, // Adreno GPU offloadは現状不安定なためCPU only
  };
  return buildServerStartCommand(config);
}

/**
 * バックグラウンド常駐起動スクリプト（nohup）を生成する。
 */
export function buildDaemonStartScript(model: LlamaCppModel): string {
  const logFile = `${MODELS_DIR}/llama-server.log`;
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const startCmd = buildRecommendedStartCommand(model);

  return [
    `# llama-server バックグラウンド起動スクリプト`,
    `pkill -f llama-server 2>/dev/null || true`,
    `sleep 1`,
    `nohup ${startCmd} > "${logFile}" 2>&1 &`,
    `echo $! > "${pidFile}"`,
    `echo "llama-server started (PID: $(cat ${pidFile}))"`,
    `echo "API: http://127.0.0.1:8080/v1/chat/completions"`,
    `echo "Log: ${logFile}"`,
  ].join('\n');
}

/**
 * llama-serverの停止コマンドを生成する。
 */
export function buildStopCommand(): string {
  return `pkill -f llama-server && echo "llama-server stopped" || echo "llama-server not running"`;
}

/**
 * llama-serverの状態確認コマンドを生成する。
 */
export function buildStatusCommand(): string {
  return `pgrep -f llama-server > /dev/null && echo "running" || echo "stopped"`;
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
 * llama.cppのGhosty向けLocal LLM設定を返す。
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
 * ghosty-bridge + llama-server を1コマンドで起動するスクリプトを生成する。
 * Termuxのマルチウィンドウ不要。llama-serverをnohupでバックグラウンド起動後、
 * ghosty-bridgeをフォアグラウンドで起動する（Ctrl+Cで両方停止）。
 */
export function buildStartAllScript(model: LlamaCppModel): string {
  const logFile = `${MODELS_DIR}/llama-server.log`;
  const pidFile = `${MODELS_DIR}/llama-server.pid`;
  const startCmd = buildRecommendedStartCommand(model);

  return [
    `#!/data/data/com.termux/files/usr/bin/bash`,
    `# Ghosty 一括起動スクリプト`,
    `# llama-server + ghosty-bridge を1コマンドで起動`,
    ``,
    `# 1. 既存プロセスを停止`,
    `pkill -f llama-server 2>/dev/null || true`,
    `pkill -f "node.*server.js" 2>/dev/null || true`,
    `sleep 1`,
    ``,
    `# 2. llama-serverをバックグラウンドで起動`,
    `echo "[1/2] llama-serverを起動中..."`,
    `nohup ${startCmd} > "${logFile}" 2>&1 &`,
    `echo $! > "${pidFile}"`,
    `echo "llama-server started (PID: $(cat ${pidFile}))"`,
    ``,
    `# 3. llama-serverの起動を待つ（最大15秒）`,
    `for i in $(seq 1 15); do`,
    `  if curl -s http://127.0.0.1:8080/health > /dev/null 2>&1; then`,
    `    echo "llama-server ready!"`,
    `    break`,
    `  fi`,
    `  echo "Waiting for llama-server... ($i/15)"`,
    `  sleep 1`,
    `done`,
    ``,
    `# 4. ghosty-bridgeをフォアグラウンドで起動`,
    `echo "[2/2] ghosty-bridgeを起動中..."`,
    `echo "Ctrl+C で両方停止できます"`,
    `node ~/ghosty-bridge/server.js`,
    ``,
    `# 5. bridge停止時にllama-serverも停止`,
    `echo "ghosty-bridge stopped. Stopping llama-server..."`,
    `pkill -f llama-server 2>/dev/null || true`,
    `echo "All stopped."`,
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
