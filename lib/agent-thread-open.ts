/**
 * lib/agent-thread-open.ts — focus a background agent's own chat thread (an
 * 'ai' pane pinned to the agent), opening one if none is pinned yet.
 *
 * Same sequence as the Sidebar agent detail "Chat" action
 * (components/layout/Sidebar.tsx openAgentThread), for callers outside the
 * Sidebar — the MONITOR pane's approval strip uses it to send the user to
 * the chat where Shelly asks for approvals.
 */
import { useMultiPaneStore, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { findLeafIdForAgent, selectThreadAgent } from '@/lib/agent-thread-selection';
import { logInfo } from '@/lib/debug-logger';

/** Returns false when no pane could be shown (layout full). */
export function openAgentChatThread(agentId: string): boolean {
  const existingLeafId = findLeafIdForAgent(agentId);
  const multiPane = useMultiPaneStore.getState();
  if (existingLeafId) {
    const slotIndex = multiPane.slots.findIndex((slot) => slot?.id === existingLeafId);
    if (slotIndex >= 0) multiPane.focusSlot(slotIndex as SlotIndex);
    usePaneStore.getState().setFocusedPane(existingLeafId);
    return true;
  }
  const err = multiPane.addPane('ai');
  if (err !== null) {
    logInfo('AgentThread', `could not open chat for ${agentId}: ${err}`);
    return false;
  }
  const next = useMultiPaneStore.getState();
  const newSlot = next.slots[next.focusedSlot];
  if (!newSlot) return false;
  selectThreadAgent(newSlot.id, agentId);
  usePaneStore.getState().setFocusedPane(newSlot.id);
  return true;
}
