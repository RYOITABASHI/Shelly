/**
 * hooks/use-launcher-approval.ts — launcher ingress Phase 2 (P2-A1 (a), P2-B1):
 * when Shelly comes to the foreground (the existing AppState subscription),
 * and every few seconds while it stays there, show the oldest pending launcher
 * submission in the approval modal (lib/launcher-approval.ts). Mounted once,
 * in ShellLayout next to McpApprovalModal. Android only (the ingress is native).
 */
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { maybePromptLauncherSubmission } from '@/lib/launcher-approval';

/** While in the foreground: a submission that arrives then is shown within this. */
const FOREGROUND_POLL_MS = 4_000;

export function useLauncherApproval(): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    if (AppState.currentState === 'active') void maybePromptLauncherSubmission('foreground');
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void maybePromptLauncherSubmission('foreground');
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void maybePromptLauncherSubmission('poll');
    }, FOREGROUND_POLL_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);
}
