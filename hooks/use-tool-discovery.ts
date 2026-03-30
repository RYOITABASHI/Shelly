/**
 * hooks/use-tool-discovery.ts — CLI + LLM 自動検出ポーリング
 *
 * アプリ起動時と定期間隔で以下を自動検出する:
 * - CLIツール: claude, gemini, codex (ブリッジ経由 `which` コマンド)
 * - ローカルLLM: llama-server / ollama (HTTP health check, 複数ポート対応)
 *
 * 検出結果に基づいてstoreを自動更新:
 * - localLlmEnabled: LLM検出時にtrue
 * - defaultAgent: 設定済みCLIが消えた場合のみ再選択（ユーザー設定は尊重）
 *
 * CLIの優先順位 (フォールバック時のみ):
 *   claude-code > codex > gemini-cli
 *   （claude/codexは定額利用可、geminiはAPI課金の可能性）
 */

import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { checkOllamaConnection } from '@/lib/local-llm';
import type { ToolStatus } from '@/lib/shelly-system-prompt';

const POLL_INTERVAL = 120000; // 120秒（省バッテリー: 30s→120s）

// ── CLI定義 ────────────────────────────────────────────────────────────────────

const CLI_TOOLS = [
  { id: 'claude-code', command: 'which claude', agent: 'claude-code' as const },
  { id: 'gemini-cli', command: 'which gemini', agent: 'gemini-cli' as const },
  { id: 'codex', command: 'which codex', agent: 'codex' as const },
] as const;

// フォールバック優先順位（設定済みCLIがアンインストールされた場合のみ使用）
const FALLBACK_PRIORITY: Array<'claude-code' | 'codex' | 'gemini-cli'> = [
  'claude-code',  // 定額Max/Pro、最強
  'codex',        // 定額Pro、軽量高速
  'gemini-cli',   // Google認証、無料枠あり
];

// ── LLM定義 ────────────────────────────────────────────────────────────────────

interface DetectedLlm {
  url: string;
  port: string;
  models: string[];
  apiType: 'openai' | 'ollama';
}

const LLM_PORTS = [
  { port: '8080', label: 'llama-server' },
  { port: '11434', label: 'Ollama' },
];

// ── グローバル検出結果 ─────────────────────────────────────────────────────────

let _detectedTools: ToolStatus[] = [];
let _detectedLlms: DetectedLlm[] = [];

/** 最新のCLI + LLM検出結果を取得（hook外から呼べる） */
export function getDetectedTools(): ToolStatus[] {
  return _detectedTools;
}

/** 検出された全LLMを取得（設定画面の切り替えUIで使用） */
export function getDetectedLlms(): DetectedLlm[] {
  return _detectedLlms;
}

/** 現在アクティブなLLMのラベルを取得（例: "gemma-3-4b-it (:8080)"） */
export function getActiveLlmLabel(): string | undefined {
  const { settings } = useTerminalStore.getState();
  if (!settings.localLlmEnabled) return undefined;
  const url = settings.localLlmUrl || 'http://127.0.0.1:8080';
  const portMatch = url.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : '?';
  const model = settings.localLlmModel;
  return model ? `${model} (:${port})` : `LLM (:${port})`;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useToolDiscovery() {
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastLlmStatusRef = useRef<boolean>(false);
  const { runRawCommand } = useTermuxBridge();

  const checkAll = useCallback(async () => {
    if (!mountedRef.current) return;

    const { settings, updateSettings, bridgeStatus } = useTerminalStore.getState();
    const bridgeConnected = bridgeStatus === 'connected';
    const tools: ToolStatus[] = [];

    // ── CLI検出（ブリッジ接続時のみ） ──────────────────────────────
    if (bridgeConnected) {
      for (const tool of CLI_TOOLS) {
        try {
          const result = await runRawCommand(tool.command, { reason: 'tool-discovery' });
          const installed = result.exitCode === 0 &&
            result.stdout.trim().length > 0 &&
            !result.stdout.includes('not found');
          tools.push({ id: tool.id, installed });
        } catch {
          tools.push({ id: tool.id, installed: false });
        }
      }

      if (!mountedRef.current) return;

      // defaultAgentの自動選択（設定済みCLIが消えた場合のみ）
      const currentAgent = settings.defaultAgent;
      const currentAgentInstalled = tools.find((t) => t.id === currentAgent)?.installed;

      if (!currentAgentInstalled) {
        const installedAgents = tools.filter((t) => t.installed).map((t) => t.id);
        const best = FALLBACK_PRIORITY.find((a) => installedAgents.includes(a));
        if (best) {
          updateSettings({ defaultAgent: best });
        }
      }
    }

    // ── LLM検出（ブリッジ不要、直接HTTP、複数ポートスキャン） ──────
    const detectedLlms: DetectedLlm[] = [];

    for (const { port, label } of LLM_PORTS) {
      const url = `http://127.0.0.1:${port}`;
      const result = await checkOllamaConnection(url);
      if (result.available) {
        detectedLlms.push({
          url,
          port,
          models: result.models,
          apiType: port === '11434' ? 'ollama' : 'openai',
        });
      }
    }

    if (!mountedRef.current) return;

    _detectedLlms = detectedLlms;
    const anyLlmAvailable = detectedLlms.length > 0;

    // LLMのtool status
    tools.push({
      id: 'llama-server',
      installed: anyLlmAvailable,
      running: anyLlmAvailable,
    });

    // LLM自動有効化/無効化
    const wasLlmAvailable = lastLlmStatusRef.current;
    lastLlmStatusRef.current = anyLlmAvailable;

    if (anyLlmAvailable && !settings.localLlmEnabled) {
      // 最初に見つかったLLMをデフォルトにする
      const first = detectedLlms[0];
      updateSettings({
        localLlmEnabled: true,
        localLlmUrl: first.url,
      });
      if (first.models.length > 0 && !settings.localLlmModel) {
        updateSettings({ localLlmModel: first.models[0] });
      }
    } else if (!anyLlmAvailable && settings.localLlmEnabled && wasLlmAvailable) {
      updateSettings({ localLlmEnabled: false });
    }

    // グローバルに保存
    _detectedTools = tools;
  }, [runRawCommand]);

  useEffect(() => {
    mountedRef.current = true;

    const initialTimer = setTimeout(checkAll, 3000);
    timerRef.current = setInterval(checkAll, POLL_INTERVAL);

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        setTimeout(checkAll, 1000);
      }
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
      subscription.remove();
    };
  }, [checkAll]);
}
