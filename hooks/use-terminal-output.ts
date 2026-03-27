/**
 * Subscribes to TerminalEmulatorModule EventEmitter.
 * Feeds terminal output to execution-log-store for ALL sessions,
 * including background tabs. Independent of view lifecycle.
 */
import { useEffect } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { detectLocalhostUrl } from '@/lib/localhost-detector';
import { usePreviewStore } from '@/store/preview-store';

export function useTerminalOutput() {
  const addTerminalOutput = useExecutionLogStore((s) => s.addTerminalOutput);

  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionOutput', (event: { sessionId: string; data: string }) => {
      if (!event.data) return;
      const lines = event.data.split('\n');
      for (const line of lines) {
        addTerminalOutput(line, event.sessionId);

        // Detect localhost URLs for preview offers
        const url = detectLocalhostUrl(line);
        if (url) {
          usePreviewStore.getState().offerPreview(url, 'localhost');
        }
      }
    });
    return () => sub.remove();
  }, [addTerminalOutput]);
}
