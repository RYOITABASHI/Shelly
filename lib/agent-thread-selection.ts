/**
 * lib/agent-thread-selection.ts — the per-pane scoping channel between the
 * Sidebar's "Chat" action and an 'ai' pane acting as a background Agent's
 * own persistent chat thread (the "Grok Bot"-style named-teammate feature).
 *
 * Unlike lib/agent-runs-selection.ts (one global selection shared by every
 * Agent Runs pane), a chat thread is scoped PER PANE — two different 'ai'
 * panes can each be pinned to a different agent at once — so this keys by
 * the pane's leafId rather than holding a single value.
 *
 * Same rationale as agent-runs-selection.ts for being a plain subscribable
 * module rather than a new Zustand store: store/ is already at 20 stores
 * (CLAUDE.md's "consider an existing store first" rule), this is transient
 * routing state that must NOT persist across restarts (persistence for the
 * thread itself lives in ai-pane-store.ts, keyed by the resolved
 * `agent:<id>` conversation key — this module only says which pane maps to
 * which agent right now), and it stays RN-free.
 */

type ThreadListener = (leafId: string, agentId: string | null) => void;

const selections = new Map<string, string>();
const listeners = new Set<ThreadListener>();

/** The agent this pane's chat thread is pinned to, or null if it's an
 *  ordinary provider-switchable AI pane. */
export function getThreadAgentId(leafId: string): string | null {
  return selections.get(leafId) ?? null;
}

/** Pins a pane to a background agent's own chat thread. */
export function selectThreadAgent(leafId: string, agentId: string): void {
  selections.set(leafId, agentId);
  notify(leafId, agentId);
}

/** Unpins a pane, returning it to an ordinary provider-switchable AI pane. */
export function clearThreadAgent(leafId: string): void {
  if (!selections.delete(leafId)) return;
  notify(leafId, null);
}

/** Finds a leafId (if any) already pinned to the given agent — used by the
 *  Sidebar's "Chat" action to focus an existing thread instead of opening
 *  a duplicate pane for the same agent. */
export function findLeafIdForAgent(agentId: string): string | null {
  for (const [leafId, pinnedAgentId] of selections) {
    if (pinnedAgentId === agentId) return leafId;
  }
  return null;
}

function notify(leafId: string, agentId: string | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(leafId, agentId);
    } catch {
      // A listener belonging to a pane that is unmounting mid-notify must
      // never prevent other panes from seeing the change.
    }
  }
}

/** Subscribes to selection changes across all panes. Returns an unsubscribe function. */
export function subscribeThreadAgent(listener: ThreadListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Cleans up the map entry when a pane closes, so a later pane reusing the
 *  same leafId (unlikely but not impossible) never inherits a stale pin. */
export function releaseThreadSlot(leafId: string): void {
  clearThreadAgent(leafId);
}
