/**
 * __tests__/agent-runs-selection.test.ts — the tiny agent-scoping channel the
 * Sidebar uses to tell a freshly-opened Agent Runs pane which agent to focus.
 *
 * hooks/use-multi-pane.ts's Slot carries no per-pane metadata beyond
 * `sessionId` (terminal only), so the scoping parameter travels through this
 * module instead — deliberately a plain subscribable module (no Zustand store,
 * no RN imports) so it is unit-testable and so Sidebar.tsx can import it
 * without eagerly pulling the pane component in and defeating
 * pane-registry.ts's lazy require.
 */
import {
  getSelectedRunAgentId,
  selectRunAgent,
  subscribeRunAgentSelection,
} from '@/lib/agent-runs-selection';

describe('agent-runs-selection', () => {
  afterEach(() => {
    selectRunAgent(null);
  });

  it('starts with no agent selected (the pane shows every agent)', () => {
    expect(getSelectedRunAgentId()).toBeNull();
  });

  it('remembers the selection made BEFORE any pane subscribed (add-pane then focus race)', () => {
    selectRunAgent('agent-1');
    expect(getSelectedRunAgentId()).toBe('agent-1');
  });

  it('notifies subscribers of subsequent selections', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeRunAgentSelection((id) => seen.push(id));
    selectRunAgent('agent-2');
    selectRunAgent(null);
    unsubscribe();
    selectRunAgent('agent-3');
    expect(seen).toEqual(['agent-2', null]);
  });

  it('re-notifies when the same agent is selected again (re-opening from the Sidebar)', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeRunAgentSelection((id) => seen.push(id));
    selectRunAgent('agent-4');
    selectRunAgent('agent-4');
    unsubscribe();
    expect(seen).toEqual(['agent-4', 'agent-4']);
  });

  it('keeps notifying the other subscribers when one of them throws', () => {
    const seen: (string | null)[] = [];
    const unsubA = subscribeRunAgentSelection(() => {
      throw new Error('pane unmounted mid-notify');
    });
    const unsubB = subscribeRunAgentSelection((id) => seen.push(id));
    expect(() => selectRunAgent('agent-5')).not.toThrow();
    unsubA();
    unsubB();
    expect(seen).toEqual(['agent-5']);
  });
});
