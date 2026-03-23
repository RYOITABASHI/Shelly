/**
 * lib/auto-setup.ts — 2フェーズ自動セットアップオーケストレーター
 *
 * Phase 1: RUN_COMMAND Intentで&&チェインの一括コマンドを送信
 *          pkg install → ws install → server.js書き込み → bridge起動
 *          WebSocket接続成功をポーリングで検知
 *
 * Phase 2: bridge WebSocket経由で残作業を実行（結果確認付き）
 *          boot script設置 / ttyd起動 / CLI検出 / LLM検出
 */

import { BRIDGE_SERVER_JS } from './bridge-bundle';
import { useTerminalStore } from '@/store/terminal-store';
import { checkOllamaConnection } from './local-llm';

// ── Phase 1 Types ───────────────────────────────────────────────────────────

export type Phase1Step = 'sending_command' | 'waiting_bridge' | 'connected' | 'timeout' | 'permission_error';

export type Phase1Progress = {
  step: Phase1Step;
  elapsedSeconds: number;
};

// ── Phase 2 Types ───────────────────────────────────────────────────────────

export type Phase2Step = 'boot_script' | 'ttyd' | 'cli_detect' | 'llm_detect' | 'complete';

export type Phase2Results = {
  bootScript?: boolean;
  ttyd?: boolean;
  cli?: { claudeCode: boolean; geminiCli: boolean; codex: boolean };
  llm?: boolean;
};

export type Phase2Progress = {
  step: Phase2Step;
  results: Phase2Results;
};

export type BridgeExecutor = (
  cmd: string,
  opts?: { timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type BridgeFileWriter = (
  filePath: string,
  content: string
) => Promise<{ ok: boolean; error?: string }>;

// ── Connection tester ───────────────────────────────────────────────────────

function testBridgeConnection(wsUrl: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => done(false), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'pong' || msg.type === 'ready') done(true);
      } catch {}
    };
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

// ── Boot script ─────────────────────────────────────────────────────────────

function buildBootScript(): string {
  return `#!/data/data/com.termux/files/usr/bin/sh
# Shelly auto-start script
sleep 3
ttyd -p 7681 bash &
cd ~/shelly-bridge && node server.js &
# Auto-start llama-server if model exists
MODEL=$((find ~/models ~/llama.cpp/models -maxdepth 2 -name "qwen*.gguf" -o -name "Qwen*.gguf" -size +100M 2>/dev/null; find ~/models ~/llama.cpp/models -maxdepth 2 -name "*.gguf" -size +100M 2>/dev/null) | awk '!seen[$0]++' | head -1)
if [ -n "$MODEL" ] && which llama-server >/dev/null 2>&1; then
  llama-server -m "$MODEL" --host 127.0.0.1 --port 8080 -ngl 0 -c 2048 -t 6 &
fi
`;
}

// ── Setup command builder (exported for copy button in SetupWizard) ──────

export function buildSetupCommand(): string {
  return [
    'pkg install -y nodejs-lts ttyd',
    'mkdir -p ~/shelly-bridge',
    'cd ~/shelly-bridge',
    'npm init -y 2>/dev/null',
    'npm install ws 2>&1',
    `cat << 'SHELLY_BRIDGE_EOF' > server.js\n${BRIDGE_SERVER_JS}\nSHELLY_BRIDGE_EOF`,
    'ttyd -p 7681 -W bash &',  // Start ttyd in background before bridge
    'node server.js',
  ].join(' && ');
}

// ── Phase 1: RUN_COMMAND + WS polling ───────────────────────────────────────

const PHASE1_POLL_INTERVAL = 2000;
const PHASE1_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Phase 1: Poll for bridge connection.
 *
 * SetupWizard first attempts auto-execution via Native Module (RUN_COMMAND).
 * If that fails (allow-external-apps not set), falls back to manual copy-paste.
 * This function only handles the polling — execution is done by SetupWizard.
 *
 * Flow:
 * 1. SetupWizard tries runTermuxCommand() (Native Module) — no user interaction
 * 2. If failed: shows manual copy-paste button as fallback
 * 3. This function polls ws://127.0.0.1:8765 until bridge connects
 */
export async function runPhase1Setup(
  onProgress: (p: Phase1Progress) => void,
): Promise<{ success: boolean; error?: string }> {
  const { wsUrl } = useTerminalStore.getState().termuxSettings;

  // Poll for bridge connection (user is executing command in Termux)
  onProgress({ step: 'waiting_bridge', elapsedSeconds: 0 });
  const startTime = Date.now();

  while (Date.now() - startTime < PHASE1_TIMEOUT_MS) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    onProgress({ step: 'waiting_bridge', elapsedSeconds: elapsed });

    const ok = await testBridgeConnection(wsUrl, 3000);
    if (ok) {
      onProgress({ step: 'connected', elapsedSeconds: elapsed });
      useTerminalStore.getState().setConnectionMode('termux');
      return { success: true };
    }

    await new Promise((r) => setTimeout(r, PHASE1_POLL_INTERVAL));
  }

  // Timeout
  const elapsed = Math.floor(PHASE1_TIMEOUT_MS / 1000);
  onProgress({ step: 'timeout', elapsedSeconds: elapsed });
  return { success: false, error: 'TIMEOUT' };
}

// ── Phase 2: Bridge-based setup (with result verification) ──────────────────

export async function runPhase2Setup(
  exec: BridgeExecutor,
  writeFile: BridgeFileWriter,
  onProgress: (p: Phase2Progress) => void,
): Promise<Phase2Results> {
  const results: Phase2Results = {};

  // 1. Boot script
  onProgress({ step: 'boot_script', results });
  const bootScript = buildBootScript();
  await exec('mkdir -p ~/.termux/boot', { timeoutMs: 5000 });
  const writeResult = await writeFile(
    '/data/data/com.termux/files/home/.termux/boot/start-shelly.sh',
    bootScript,
  );
  if (writeResult.ok) {
    await exec('chmod +x ~/.termux/boot/start-shelly.sh', { timeoutMs: 5000 });
    results.bootScript = true;
  } else {
    // Fallback: write via exec
    const fallback = await exec(
      `cat << 'SHELLY_EOF' > ~/.termux/boot/start-shelly.sh\n${bootScript}\nSHELLY_EOF\nchmod +x ~/.termux/boot/start-shelly.sh`,
      { timeoutMs: 10000 },
    );
    results.bootScript = fallback.exitCode === 0;
  }

  // 2. ttyd (install if missing, then start)
  onProgress({ step: 'ttyd', results });
  const ttydInstalled = await exec('which ttyd >/dev/null 2>&1 && echo YES || echo NO', { timeoutMs: 5000 });
  if (ttydInstalled.stdout.includes('NO')) {
    // ttyd not installed — try to install
    await exec('pkg install -y ttyd 2>&1', { timeoutMs: 120000 });
  }
  const ttydCheck = await exec(
    'pgrep -f "ttyd.*7681" >/dev/null 2>&1 && echo ALREADY || (nohup ttyd -p 7681 -W bash > /dev/null 2>&1 & sleep 2 && curl -s -o /dev/null -w "%{http_code}" http://localhost:7681)',
    { timeoutMs: 15000 },
  );
  results.ttyd = ttydCheck.stdout.includes('200') || ttydCheck.stdout.includes('ALREADY');

  // 3. CLI detection
  onProgress({ step: 'cli_detect', results });
  const cliResult = await exec(
    'echo "CC:$(which claude 2>/dev/null && echo 1 || echo 0):GC:$(which gemini 2>/dev/null && echo 1 || echo 0):CX:$(which codex 2>/dev/null && echo 1 || echo 0)"',
    { timeoutMs: 10000 },
  );
  const cliOut = cliResult.stdout;
  results.cli = {
    claudeCode: cliOut.includes('CC:1'),
    geminiCli: cliOut.includes('GC:1'),
    codex: cliOut.includes('CX:1'),
  };

  // 4. LLM detection (check running → if not, try to start llama-server with available model)
  onProgress({ step: 'llm_detect', results });
  let llmDetected = false;

  // First check if already running
  for (const port of ['8080', '11434']) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const llmResult = await checkOllamaConnection(url);
      if (llmResult.available) {
        llmDetected = true;
        useTerminalStore.getState().updateSettings({
          localLlmEnabled: true,
          localLlmUrl: url,
        });
        break;
      }
    } catch {}
  }

  // If not running, try to start llama-server with available GGUF model
  if (!llmDetected) {
    const hasLlama = await exec('which llama-server >/dev/null 2>&1 && echo YES || echo NO', { timeoutMs: 5000 });
    if (hasLlama.stdout.includes('YES')) {
      // Find a GGUF model
      const modelFind = await exec(
        '(find ~/models ~/llama.cpp/models -maxdepth 2 -name "*.gguf" -size +100M 2>/dev/null) | head -1',
        { timeoutMs: 10000 },
      );
      const modelPath = modelFind.stdout.trim();
      if (modelPath) {
        // Start llama-server in background
        await exec(
          `nohup llama-server -m "${modelPath}" --host 127.0.0.1 --port 8080 -ngl 0 -c 2048 -t 4 > /dev/null 2>&1 &`,
          { timeoutMs: 5000 },
        );
        // Wait for startup (model loading takes time)
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const check = await checkOllamaConnection('http://127.0.0.1:8080');
            if (check.available) {
              llmDetected = true;
              useTerminalStore.getState().updateSettings({
                localLlmEnabled: true,
                localLlmUrl: 'http://127.0.0.1:8080',
                localLlmModel: check.models[0] || modelPath.split('/').pop()?.replace('.gguf', '') || 'default',
              });
              break;
            }
          } catch {}
        }
      }
    }
  }

  results.llm = llmDetected;

  onProgress({ step: 'complete', results });
  return results;
}
