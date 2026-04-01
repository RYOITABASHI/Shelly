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
import { diagnosePackageError } from '@/lib/package-doctor';

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

// Patterns indicating package/apt errors (subset triggers PackageDoctor)
const PACKAGE_ERROR_PATTERNS = [
  /Unable to locate package/,
  /NOSPLIT|Clearsigned file/,
  /dpkg was interrupted/,
  /Unable to acquire the dpkg frontend lock/,
  /404\s+Not Found|Failed to fetch/,
  /Unmet dependencies|Depends:/,
  /Hash Sum mismatch/,
];

export function useTerminalOutput() {
  const addTerminalOutput = useExecutionLogStore((s) => s.addTerminalOutput);
  const savepointDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorAccum = useRef<string[]>([]);
  const pkgErrorDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pkgErrorAccum = useRef<string[]>([]);
  const { isWide } = useDeviceLayout();

  // Batch buffer for output analysis (省バッテリー: per-line → batched)
  const batchBuffer = useRef<string[]>([]);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const BATCH_INTERVAL = 50; // 50ms batching

  useEffect(() => {
    const sub = TerminalEmulator.addListener('onSessionOutput', (event: { sessionId: string; data: string }) => {
      if (!event.data) return;

      // Always add to execution log immediately (lightweight)
      const lines = event.data.split('\n');
      for (const line of lines) {
        addTerminalOutput(line, event.sessionId);
      }

      // Batch lines for expensive pattern analysis
      batchBuffer.current.push(...lines);
      if (batchTimer.current) return; // Already scheduled
      batchTimer.current = setTimeout(() => {
        batchTimer.current = null;
        const batch = batchBuffer.current;
        batchBuffer.current = [];

        for (const line of batch) {
          // Detect localhost URLs for preview offers
          const url = detectLocalhostUrl(line);
          if (url) {
            usePreviewStore.getState().offerPreview(url, 'localhost');
          }

          // Detect file-changing output → request savepoint + notify preview
          for (const pattern of FILE_CHANGE_OUTPUT) {
            const match = pattern.exec(line);
            if (match) {
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

          // Wide mode only: detect approval prompts
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
                  translation: '',
                  dangerLevel: 'MEDIUM',
                },
              });
            }, 300);
          }

          // Wide mode only: detect error output (single bubble per error burst)
          if (isWide) {
            let matched = false;
            for (const pattern of ERROR_OUTPUT_PATTERNS) {
              if (pattern.test(line)) { matched = true; break; }
            }
            if (matched) {
              const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
              if (cleanLine && !errorAccum.current.includes(cleanLine)) {
                errorAccum.current.push(cleanLine);
              }
              if (errorDebounce.current) clearTimeout(errorDebounce.current);
              errorDebounce.current = setTimeout(() => {
                const errorText = errorAccum.current.join('\n');
                errorAccum.current = [];
                if (!errorText) return;
                // Check chat history: skip if recent error bubble exists (within 10s)
                let store: ReturnType<typeof useChatStore.getState>;
                let session: ReturnType<ReturnType<typeof useChatStore.getState>['getActiveSession']>;
                try {
                  store = useChatStore.getState();
                  session = store.getActiveSession();
                } catch { return; }
                if (!session) return;
                const msgs = session.messages ?? [];
                for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 5); i--) {
                  const m = msgs[i];
                  if (m?.errorSummaryData && Date.now() - m.timestamp < 10_000) return;
                }
                try {
                  store.addMessage(session.id, {
                    id: generateId(),
                    role: 'system',
                    content: '',
                    timestamp: Date.now(),
                    errorSummaryData: { errorText, translation: '', provider: '' },
                  });
                } catch {}
              }, 2000);
            }
          }

          // PackageDoctor: detect package manager errors
          for (const pattern of PACKAGE_ERROR_PATTERNS) {
            if (pattern.test(line)) {
              pkgErrorAccum.current.push(line);
              if (pkgErrorDebounce.current) clearTimeout(pkgErrorDebounce.current);
              pkgErrorDebounce.current = setTimeout(() => {
                const stderr = pkgErrorAccum.current.join('\n');
                pkgErrorAccum.current = [];
                const fix = diagnosePackageError(stderr);
                if (!fix) return;
                const store = useChatStore.getState();
                const session = store.getActiveSession();
                if (!session) return;
                store.addMessage(session.id, {
                  id: generateId(),
                  role: 'system',
                  content: `🔧 **Package Doctor**: ${fix.message}\n\nSuggested fix: \`${fix.fix}\`${fix.autoRun ? '\n_(Auto-repair available)_' : ''}`,
                  timestamp: Date.now(),
                });
              }, 1500);
              break;
            }
          }
        }
      }, BATCH_INTERVAL);
    });
    return () => {
      sub.remove();
      if (batchTimer.current) clearTimeout(batchTimer.current);
      if (savepointDebounce.current) clearTimeout(savepointDebounce.current);
      if (approvalDebounce.current) clearTimeout(approvalDebounce.current);
      if (errorDebounce.current) clearTimeout(errorDebounce.current);
      if (pkgErrorDebounce.current) clearTimeout(pkgErrorDebounce.current);
    };
  }, [addTerminalOutput, isWide]);
}
