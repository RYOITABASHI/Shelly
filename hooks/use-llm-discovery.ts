/**
 * hooks/use-llm-discovery.ts — LLM自動検出ポーリング
 *
 * アプリ起動時と定期間隔でローカルLLMの存在を確認する。
 * 検出されたらlocalLlmEnabledを自動でtrueにする。
 * 消えたらfalseに戻す。
 */

import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useTerminalStore } from '@/store/terminal-store';
import { checkOllamaConnection } from '@/lib/local-llm';

const POLL_INTERVAL = 30000; // 30秒
const COMMON_PORTS = ['8080', '11434']; // llama-server, ollama

export function useLlmDiscovery() {
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStatusRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;

    const check = async () => {
      if (!mountedRef.current) return;

      const { settings, updateSettings } = useTerminalStore.getState();
      const baseUrl = settings.localLlmUrl || 'http://127.0.0.1:8080';

      // まず設定済みURLを試す
      let result = await checkOllamaConnection(baseUrl);

      // 設定URLで見つからない場合、既知ポートをスキャン
      if (!result.available) {
        for (const port of COMMON_PORTS) {
          const url = `http://127.0.0.1:${port}`;
          if (url === baseUrl) continue;
          result = await checkOllamaConnection(url);
          if (result.available) {
            // 見つかったURLで設定を更新
            updateSettings({ localLlmUrl: url });
            break;
          }
        }
      }

      if (!mountedRef.current) return;

      const wasAvailable = lastStatusRef.current;
      lastStatusRef.current = result.available;

      if (result.available && !settings.localLlmEnabled) {
        // 新規検出 → 自動有効化
        updateSettings({ localLlmEnabled: true });
        // モデル名も更新（あれば）
        if (result.models.length > 0 && !settings.localLlmModel) {
          updateSettings({ localLlmModel: result.models[0] });
        }
      } else if (!result.available && settings.localLlmEnabled && wasAvailable) {
        // 消えた → 自動無効化
        updateSettings({ localLlmEnabled: false });
      }
    };

    // 初回チェック（少し遅延させてアプリ起動を邪魔しない）
    const initialTimer = setTimeout(check, 3000);

    // 定期ポーリング
    timerRef.current = setInterval(check, POLL_INTERVAL);

    // フォアグラウンド復帰時にもチェック
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        setTimeout(check, 1000);
      }
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
      subscription.remove();
    };
  }, []);
}
