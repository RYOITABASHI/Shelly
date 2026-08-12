/**
 * lib/pane-focus.ts
 *
 * Focus (or open) the single mounted pane for a given tab, promoting the
 * multi-pane preset if needed so the pane is actually visible rather than
 * merely present-but-hidden behind the current preset's capacity.
 *
 * Extracted from app/_layout.tsx's deep-link handler (2026-07-29 widget ASK
 * handoff: `shelly:///ai?widgetAgentCommand=1` focuses the AI Pane before
 * seeding `useAIPaneStore.getState().setPendingExternalPrompt(...)`, so the
 * AIPane component that claims the prompt is guaranteed to already be
 * mounted) so other call sites can reuse the identical "make the pane
 * visible before queuing a hand-off" sequence instead of re-deriving it.
 * components/panes/TerminalPane.tsx's terminal `@agent` mention intercept
 * (bug: terminal `@agent` registration used to skip the mandatory confirm
 * flow entirely — see that file's onBlockCompleted) is the second caller.
 */
import { logInfo } from '@/lib/debug-logger';
import { PRESET_CAPACITY, useMultiPaneStore, type PresetId } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';

function visiblePresetForSlot(currentPreset: PresetId, slotIndex: number): PresetId {
  const currentCapacity = PRESET_CAPACITY[currentPreset] ?? 1;
  if (slotIndex < currentCapacity) return currentPreset;
  if (slotIndex <= 1) return 'p2h';
  if (slotIndex === 2) return 'p3l';
  return 'p4';
}

/**
 * Focus the existing pane for `tab`, or add one if none exists yet.
 * Returns true once a pane for `tab` is focused (pre-existing or newly
 * added), false if adding a new pane failed (layout at capacity).
 */
export function focusPaneByTab(tab: 'agent-chat' | 'ai'): boolean {
  const multiPane = useMultiPaneStore.getState();
  const existingIndex = multiPane.slots.findIndex((slot) => slot?.tab === tab);
  if (existingIndex >= 0) {
    const slot = multiPane.slots[existingIndex];
    multiPane.maximizeSlot(null);
    const visiblePreset = visiblePresetForSlot(multiPane.preset, existingIndex);
    if (visiblePreset !== multiPane.preset) {
      multiPane.setPreset(visiblePreset);
    }
    multiPane.focusSlot(existingIndex as 0 | 1 | 2 | 3);
    if (slot) usePaneStore.getState().setFocusedPane(slot.id);
    return true;
  }

  const result = multiPane.addPane(tab);
  if (result) {
    logInfo('PaneFocus', `could not add ${tab} pane: ${result}`);
    return false;
  }
  return true;
}
