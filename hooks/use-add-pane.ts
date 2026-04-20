// hooks/use-add-pane.ts
//
// Wraps `useMultiPaneStore.addPane` so every callsite gets the same
// user-facing feedback when capacity is exhausted. Without this, four
// paths into addPane (CommandPalette, MultiPaneContainer split menu,
// WorktreesSection "open in pane", LayoutAddSheet/AddPaneSheet) each had
// to remember to surface the failure reason; missing the wire-up is what
// produced bug #108 — the "+ button silently does nothing" complaint.
//
// Usage:
//   const addPane = useAddPane();
//   addPane('terminal');                                     // shows alert on cap
//   addPane('terminal', { silent: true });                    // skip alert
//   addPane('terminal', { onCap: () => { /* custom handler */ } });
//
// All callers should use this hook instead of calling
// `useMultiPaneStore.getState().addPane(...)` directly.

import { Alert } from 'react-native';
import { useCallback } from 'react';
import { useMultiPaneStore, type PaneTab } from '@/hooks/use-multi-pane';

type AddPaneOptions = {
  /** Suppress the default Alert on cap reached. */
  silent?: boolean;
  /** Called instead of (or in addition to) the default Alert when a cap is hit. */
  onCap?: (reason: 'terminal_cap' | 'layout_full') => void;
};

export type AddPaneResult = null | 'terminal_cap' | 'layout_full';

const DEFAULT_MESSAGES: Record<Exclude<AddPaneResult, null>, { title: string; body: string }> = {
  terminal_cap: {
    title: 'ターミナルの上限',
    body: 'ターミナルは 3 ペインまでです。これ以上増やすと Android の phantom process killer がバックグラウンドのセッションを殺す可能性があります。',
  },
  layout_full: {
    title: 'レイアウト満杯',
    body: '既に 4 ペイン使用中です。追加するにはいずれかのペインを閉じてください。',
  },
};

export function useAddPane() {
  return useCallback((tab: PaneTab, opts?: AddPaneOptions): AddPaneResult => {
    const result = useMultiPaneStore.getState().addPane(tab);
    if (result !== null) {
      opts?.onCap?.(result);
      if (!opts?.silent && !opts?.onCap) {
        const msg = DEFAULT_MESSAGES[result];
        Alert.alert(msg.title, msg.body);
      }
    }
    return result;
  }, []);
}
