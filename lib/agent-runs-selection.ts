/**
 * lib/agent-runs-selection.ts — the agent-scoping channel between the Sidebar's
 * "View Run History" action and the Agent Runs pane.
 *
 * hooks/use-multi-pane.ts's `Slot` carries no general per-pane metadata (only
 * `sessionId`, and only for terminal panes), so an agent id cannot ride along
 * with `addPane('agent-runs')`. This module is that parameter channel.
 *
 * Deliberately a plain subscribable module rather than a new Zustand store:
 * store/ is already at 20 stores (see CLAUDE.md's "consider adding to an
 * existing store first" rule) and this is a single transient value that must
 * NOT persist. It is also RN-free so Sidebar.tsx can import it without
 * eagerly pulling in the pane component and defeating pane-registry.ts's
 * lazy `require`.
 *
 * The last value is retained (not just broadcast) because `addPane` mounts the
 * pane asynchronously — a selection made before the pane subscribes would
 * otherwise be lost, and the pane would open unscoped.
 */

type SelectionListener = (agentId: string | null) => void;

let selectedAgentId: string | null = null;
const listeners = new Set<SelectionListener>();

/** The agent the Agent Runs pane should focus, or null for "all agents". */
export function getSelectedRunAgentId(): string | null {
  return selectedAgentId;
}

/**
 * Scopes the Agent Runs pane to one agent (or null to clear the filter).
 *
 * Always notifies, even when the value is unchanged: re-tapping "View Run
 * History" for the already-shown agent is a legitimate "bring this back into
 * view" gesture, and a de-duped no-op would make the second tap feel broken.
 */
export function selectRunAgent(agentId: string | null): void {
  selectedAgentId = agentId;
  for (const listener of [...listeners]) {
    try {
      listener(agentId);
    } catch {
      // A listener belonging to a pane that is unmounting mid-notify must
      // never prevent the remaining panes from seeing the selection.
    }
  }
}

/** Subscribes to selection changes. Returns an unsubscribe function. */
export function subscribeRunAgentSelection(listener: SelectionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
