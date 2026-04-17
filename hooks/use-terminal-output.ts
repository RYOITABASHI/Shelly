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

          // TODO: approval prompts, error detection, and PackageDoctor
          // were routed to the deleted chat-store. Re-wire to AI pane in v0.2.
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
