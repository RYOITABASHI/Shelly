/**
 * Subscribes to TerminalEmulatorModule EventEmitter.
 * Feeds terminal output to execution-log-store for ALL sessions,
 * including background tabs. Independent of view lifecycle.
 *
 * Also detects file-changing output patterns to trigger savepoints,
 * approval prompts to show ApprovalBubble (Wide mode),
 * and error output to show ErrorSummaryBubble (Wide mode).
 */
import { useEffect, useRef } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { detectLocalhostUrl } from '@/lib/localhost-detector';
import { usePreviewStore } from '@/store/preview-store';
import { useSavepointStore } from '@/store/savepoint-store';
import { useChatStore } from '@/store/chat-store';
import { detectApprovalPrompt } from '@/lib/realtime-translate';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { generateId } from '@/lib/id';

// Patterns indicating file changes in PTY output (with capturing groups for file paths)
const FILE_CHANGE_OUTPUT = [
  /(?:wrote|created|saved|modified|updated|generated)\s+(\S+)/i,
  /(?:^|\$\s+|#\s+)(?:vim|nano|code)\s+(\S+)/,
  /(?:^|\$\s+|#\s+)(?:mv|cp)\s+\S+\s+(\S+)/,
  /(?:^|\$\s+|#\s+)rm\s+(\S+)/,
  /(?:^|\$\s+|#\s+)git\s+(?:checkout|reset|merge|rebase)/,
  /(?:^|\$\s+|#\s+)(?:npm|pnpm|yarn)\s+(?:install|add|remove)/,
];

// Patterns indicating errors in PTY output
const ERROR_OUTPUT_PATTERNS = [
  /^Error:/i,
  /^(?:Uncaught|Unhandled)\s/i,
  /ERR!|ENOENT|EACCES|EPERM|EISDIR/,
  /Traceback \(most recent call last\)/,
  /panic:/,
  /fatal:/i,
  /SyntaxError:|TypeError:|ReferenceError:|RangeError:/,
  /error\[E\d+\]:/,  // Rust compiler errors
  /FAILED|BUILD FAILED/,
  /Cannot find module/,
  /Module not found/,
];

export function useTerminalOutput() {
  const addTerminalOutput = useExecutionLogStore((s) => s.addTerminalOutput);
  const savepointDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorAccum = useRef<string[]>([]);
  const { isWide } = useDeviceLayout();

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

        // Detect file-changing output → request savepoint + notify preview
        for (const pattern of FILE_CHANGE_OUTPUT) {
          const match = pattern.exec(line);
          if (match) {
            // Extract file path if capture group matched
            if (match[1]) {
              usePreviewStore.getState().notifyFileChange(match[1]);
            }
            if (savepointDebounce.current) clearTimeout(savepointDebounce.current);
            savepointDebounce.current = setTimeout(() => {
              useSavepointStore.getState().requestSavepoint('file-change-detected');
            }, 5000);
            break;
          }
        }

        // Wide mode only: detect approval prompts → add ApprovalBubble to chat
        if (isWide && detectApprovalPrompt(line)) {
          if (approvalDebounce.current) clearTimeout(approvalDebounce.current);
          approvalDebounce.current = setTimeout(() => {
            const store = useChatStore.getState();
            const session = store.getActiveSession();
            if (!session) return;
            store.addMessage(session.id, {
              id: generateId(),
              role: 'system',
              content: '',
              timestamp: Date.now(),
              approvalData: {
                sessionId: event.sessionId,
                command: line.trim(),
                translation: '',  // filled by TranslateOverlay pipeline if available
                dangerLevel: 'MEDIUM',
              },
            });
          }, 300);
        }

        // Wide mode only: detect error output → accumulate and add ErrorSummaryBubble
        if (isWide) {
          for (const pattern of ERROR_OUTPUT_PATTERNS) {
            if (pattern.test(line)) {
              errorAccum.current.push(line);
              if (errorDebounce.current) clearTimeout(errorDebounce.current);
              errorDebounce.current = setTimeout(() => {
                const errorText = errorAccum.current.join('\n');
                errorAccum.current = [];
                const store = useChatStore.getState();
                const session = store.getActiveSession();
                if (!session) return;
                store.addMessage(session.id, {
                  id: generateId(),
                  role: 'system',
                  content: '',
                  timestamp: Date.now(),
                  errorSummaryData: {
                    errorText,
                    translation: '',  // will be filled async by translate pipeline
                    provider: '',
                  },
                });
              }, 2000);
              break;
            }
          }
        }
      }
    });
    return () => {
      sub.remove();
      if (savepointDebounce.current) clearTimeout(savepointDebounce.current);
      if (approvalDebounce.current) clearTimeout(approvalDebounce.current);
      if (errorDebounce.current) clearTimeout(errorDebounce.current);
    };
  }, [addTerminalOutput, isWide]);
}
