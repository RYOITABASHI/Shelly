/**
 * lib/auto-setup.ts — 自動セットアップオーケストレーター
 *
 * RUN_COMMAND Intent経由でTermux上のセットアップを自動実行する。
 * ユーザーはアニメーションを見ているだけで完了する。
 *
 * フロー:
 * 1. pkg install nodejs-lts ttyd
 * 2. bridge設置 (server.js書き込み)
 * 3. boot script設置 (~/.termux/boot/start-shelly.sh)
 * 4. ttyd起動
 * 5. bridge起動
 * 6. 接続確認 (WS + HTTP)
 * 7. LLM検出 (オプション、失敗してもスルー)
 */

import { runTermuxCommand } from './termux-intent';
import { BRIDGE_SERVER_JS } from './bridge-bundle';
import { useTerminalStore } from '@/store/terminal-store';
import { checkOllamaConnection } from './local-llm';

// ── Types ──────────────────────────────────────────────────────────────────────

export type SetupStep =
  | 'installing_packages'
  | 'writing_bridge'
  | 'writing_boot_script'
  | 'starting_ttyd'
  | 'starting_bridge'
  | 'connecting_bridge'
  | 'connecting_tty'
  | 'detecting_llm'
  | 'complete'
  | 'error';

export interface SetupProgress {
  step: SetupStep;
  /** 0-100 */
  percent: number;
  error?: string;
}

type ProgressCallback = (progress: SetupProgress) => void;

// ── Step weights (for progress bar) ────────────────────────────────────────────

const STEP_WEIGHTS: Record<SetupStep, number> = {
  installing_packages: 40,
  writing_bridge: 5,
  writing_boot_script: 5,
  starting_ttyd: 5,
  starting_bridge: 5,
  connecting_bridge: 15,
  connecting_tty: 10,
  detecting_llm: 10,
  complete: 5,
  error: 0,
};

const STEPS_ORDER: SetupStep[] = [
  'installing_packages',
  'writing_bridge',
  'writing_boot_script',
  'starting_ttyd',
  'starting_bridge',
  'connecting_bridge',
  'connecting_tty',
  'detecting_llm',
  'complete',
];

function calcPercent(currentStep: SetupStep): number {
  let sum = 0;
  for (const s of STEPS_ORDER) {
    if (s === currentStep) return sum;
    sum += STEP_WEIGHTS[s];
  }
  return 100;
}

// ── Boot script content ────────────────────────────────────────────────────────

function buildBootScript(): string {
  return `#!/data/data/com.termux/files/usr/bin/sh
# Shelly auto-start script — managed by Shelly app
# Do not edit manually

# Wait for network
sleep 3

# Start ttyd (terminal web UI)
ttyd -p 7681 bash &

# Start Shelly bridge (WebSocket)
node ~/shelly-bridge/server.js &
`;
}

// ── Connection testers ─────────────────────────────────────────────────────────

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

async function testTtyConnection(ttyUrl: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(ttyUrl, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Retry helper ───────────────────────────────────────────────────────────────

async function retry<T>(
  fn: () => Promise<T>,
  check: (result: T) => boolean,
  maxAttempts: number,
  delayMs: number,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    if (check(result)) return result;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return fn();
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * 自動セットアップを実行する。
 * 各ステップの進捗をコールバックで通知する。
 */
export async function runAutoSetup(onProgress: ProgressCallback): Promise<{ success: boolean; llmDetected: boolean; error?: string }> {
  const { termuxSettings, settings } = useTerminalStore.getState();
  const wsUrl = termuxSettings.wsUrl;
  const ttyUrl = termuxSettings.ttyUrl || 'http://localhost:7681';
  let llmDetected = false;

  try {
    // ── Step 1: Install packages ──────────────────────────────────────────
    onProgress({ step: 'installing_packages', percent: calcPercent('installing_packages') });

    const installResult = await runTermuxCommand({
      command: 'pkg install -y nodejs-lts ttyd 2>&1',
    });
    if (!installResult.success) {
      // RUN_COMMAND失敗 → フォールバック情報を返す
      onProgress({ step: 'error', percent: 0, error: installResult.error });
      return { success: false, llmDetected: false, error: installResult.error };
    }

    // pkg installは時間がかかるのでポーリングで待つ
    // (RUN_COMMANDはfire-and-forgetなので、接続確認で完了を判断する)
    // 中間進捗を出す
    await new Promise((r) => setTimeout(r, 2000));
    onProgress({ step: 'installing_packages', percent: 10 });
    await new Promise((r) => setTimeout(r, 3000));
    onProgress({ step: 'installing_packages', percent: 20 });

    // ── Step 2: Write bridge server.js ────────────────────────────────────
    onProgress({ step: 'writing_bridge', percent: calcPercent('writing_bridge') });

    const escapedBridge = BRIDGE_SERVER_JS.replace(/'/g, "'\\''");
    await runTermuxCommand({
      command: `mkdir -p ~/shelly-bridge && cat << 'SHELLY_EOF' > ~/shelly-bridge/server.js\n${BRIDGE_SERVER_JS}\nSHELLY_EOF`,
    });
    await new Promise((r) => setTimeout(r, 1000));

    // ── Step 3: Write boot script ─────────────────────────────────────────
    onProgress({ step: 'writing_boot_script', percent: calcPercent('writing_boot_script') });

    const bootScript = buildBootScript();
    await runTermuxCommand({
      command: `mkdir -p ~/.termux/boot && cat << 'SHELLY_EOF' > ~/.termux/boot/start-shelly.sh\n${bootScript}\nSHELLY_EOF\nchmod +x ~/.termux/boot/start-shelly.sh`,
    });
    await new Promise((r) => setTimeout(r, 500));

    // ── Step 4: Start ttyd ────────────────────────────────────────────────
    onProgress({ step: 'starting_ttyd', percent: calcPercent('starting_ttyd') });

    await runTermuxCommand({
      command: 'pkill -f "ttyd" 2>/dev/null; sleep 0.5; ttyd -p 7681 bash &',
    });
    await new Promise((r) => setTimeout(r, 2000));

    // ── Step 5: Start bridge ──────────────────────────────────────────────
    onProgress({ step: 'starting_bridge', percent: calcPercent('starting_bridge') });

    await runTermuxCommand({
      command: 'pkill -f "shelly-bridge/server.js" 2>/dev/null; sleep 0.5; node ~/shelly-bridge/server.js &',
    });
    await new Promise((r) => setTimeout(r, 2000));

    // ── Step 6: Verify bridge connection ──────────────────────────────────
    onProgress({ step: 'connecting_bridge', percent: calcPercent('connecting_bridge') });

    const bridgeOk = await retry(
      () => testBridgeConnection(wsUrl),
      (ok) => ok,
      10,  // 最大10回リトライ
      3000, // 3秒間隔 (= 最大30秒待ち)
    );

    if (!bridgeOk) {
      onProgress({ step: 'error', percent: calcPercent('connecting_bridge'), error: 'BRIDGE_CONNECTION_FAILED' });
      return { success: false, llmDetected: false, error: 'BRIDGE_CONNECTION_FAILED' };
    }

    // ブリッジ接続成功 → storeに反映
    useTerminalStore.getState().setConnectionMode('termux');

    // ── Step 7: Verify TTY connection ─────────────────────────────────────
    onProgress({ step: 'connecting_tty', percent: calcPercent('connecting_tty') });

    const ttyOk = await retry(
      () => testTtyConnection(ttyUrl),
      (ok) => ok,
      5,
      2000,
    );
    // TTY失敗は致命的ではない（ブリッジがあれば基本機能は使える）

    // ── Step 8: Detect LLM (optional) ─────────────────────────────────────
    onProgress({ step: 'detecting_llm', percent: calcPercent('detecting_llm') });

    const llmUrl = settings.localLlmUrl || 'http://127.0.0.1:8080';
    const llmResult = await checkOllamaConnection(llmUrl);
    if (llmResult.available) {
      llmDetected = true;
      useTerminalStore.getState().updateSettings({ localLlmEnabled: true });
    }
    // LLM未検出でもエラーにしない

    // ── Complete ──────────────────────────────────────────────────────────
    onProgress({ step: 'complete', percent: 100 });
    return { success: true, llmDetected };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ step: 'error', percent: 0, error: message });
    return { success: false, llmDetected: false, error: message };
  }
}
