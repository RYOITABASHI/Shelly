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

type FocusableTab = 'agent-chat' | 'ai' | 'markdown' | 'preview';

function focusExistingSlot(index: number): void {
  const multiPane = useMultiPaneStore.getState();
  const slot = multiPane.slots[index];
  multiPane.maximizeSlot(null);
  const visiblePreset = visiblePresetForSlot(multiPane.preset, index);
  if (visiblePreset !== multiPane.preset) {
    multiPane.setPreset(visiblePreset);
  }
  // setPreset compacts slots, so re-resolve the index by id afterwards.
  const after = useMultiPaneStore.getState();
  const finalIndex = slot ? after.slots.findIndex((s) => s?.id === slot.id) : index;
  const target = finalIndex >= 0 ? finalIndex : index;
  after.focusSlot(target as 0 | 1 | 2 | 3);
  if (slot) usePaneStore.getState().setFocusedPane(slot.id);
}

/**
 * Focus the existing pane for `tab`, or add one if none exists yet.
 * Returns true once a pane for `tab` is focused (pre-existing or newly
 * added), false if adding a new pane failed (layout at capacity).
 */
export function focusPaneByTab(tab: FocusableTab): boolean {
  const multiPane = useMultiPaneStore.getState();
  const existingIndex = multiPane.slots.findIndex((slot) => slot?.tab === tab);
  if (existingIndex >= 0) {
    focusExistingSlot(existingIndex);
    return true;
  }

  const result = multiPane.addPane(tab);
  if (result) {
    logInfo('PaneFocus', `could not add ${tab} pane: ${result}`);
    return false;
  }
  return true;
}

/** Tabs we'd rather not evict when the 4-slot grid is full. */
const PRESERVE_ON_REPLACE = new Set<string>(['terminal', 'ai', 'agent-chat']);

/**
 * Like focusPaneByTab, but when the layout is full (4 panes) it repurposes
 * an existing non-terminal slot instead of failing. Preference order: a
 * non-focused slot whose tab isn't a terminal/chat, then any non-focused
 * non-terminal slot, then the focused non-terminal slot. Terminal slots are
 * never repurposed (they own a live PTY session). Returns false only when
 * no pane could be made visible at all.
 */
export function ensurePaneByTab(tab: FocusableTab): boolean {
  if (focusPaneByTab(tab)) return true;
  const { slots, focusedSlot, setSlotTab } = useMultiPaneStore.getState();
  const indices = [0, 1, 2, 3].filter((i) => slots[i] && slots[i]!.tab !== 'terminal');
  const pick =
    indices.find((i) => i !== focusedSlot && !PRESERVE_ON_REPLACE.has(slots[i]!.tab)) ??
    indices.find((i) => i !== focusedSlot) ??
    indices.find((i) => i === focusedSlot);
  if (pick === undefined) {
    logInfo('PaneFocus', `no replaceable slot for ${tab}`);
    return false;
  }
  logInfo('PaneFocus', `layout full — repurposing slot ${pick} (${slots[pick]!.tab}) as ${tab}`);
  setSlotTab(pick as 0 | 1 | 2 | 3, tab);
  focusExistingSlot(pick);
  return true;
}
