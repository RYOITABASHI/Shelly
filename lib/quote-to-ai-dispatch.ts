/**
 * lib/quote-to-ai-dispatch.ts
 *
 * Binds lib/quote-to-ai.ts's routeQuoteToAI() to the real pane stores. Kept
 * separate so the pure formatting/insertion logic stays importable in tests
 * without pulling in the multi-pane store.
 */
import { PRESET_CAPACITY, useMultiPaneStore, type SlotIndex } from '@/hooks/use-multi-pane';
import { focusPaneByTab } from '@/lib/pane-focus';
import { routeQuoteToAI, visibleSlotsOf, type QuoteTargetTab } from '@/lib/quote-to-ai';
import { t } from '@/lib/i18n';
import { usePaneStore } from '@/store/pane-store';

export function quoteTerminalSelectionToAI(selectedText: string): QuoteTargetTab | null {
  return routeQuoteToAI(selectedText, {
    getVisibleSlots: () => {
      const mp = useMultiPaneStore.getState();
      return visibleSlotsOf(mp.slots, PRESET_CAPACITY[mp.preset] ?? 1, mp.maximizedSlot);
    },
    getFocusHistory: () => usePaneStore.getState().focusHistory,
    focusPane: (paneId) => {
      const mp = useMultiPaneStore.getState();
      const index = mp.slots.findIndex((s) => s?.id === paneId);
      if (index >= 0) mp.focusSlot(index as SlotIndex);
      usePaneStore.getState().setFocusedPane(paneId);
    },
    openAiPane: () => {
      if (!focusPaneByTab('ai')) return null;
      const slot = useMultiPaneStore.getState().slots.find((s) => s?.tab === 'ai');
      if (!slot) return null;
      usePaneStore.getState().setFocusedPane(slot.id);
      return slot.id;
    },
    queue: (insert) => usePaneStore.getState().queueComposerInsert(insert),
    truncationNote: (omitted) => t('quote_to_ai.truncated_note', { count: omitted }),
  });
}
