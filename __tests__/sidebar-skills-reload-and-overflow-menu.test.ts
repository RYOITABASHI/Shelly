// Unit coverage for the two 2026-08-10 Sidebar.tsx bug fixes:
//
// Bug 1 (SKILLS list not refreshing after a skill save from the AIPane
// one-shot @agent chat flow): skillsSectionBecameVisible is the pure
// predicate behind the reload-while-visible effect.
//
// Bug 2 (agent-row action icons crowding taskInfo to ~0px visible width):
// buildAgentOverflowMenuActions is the pure builder behind the new "⋯"
// overflow menu (showAgentActionsMenu) that replaced the row's history/
// memory/AUTO Pressables.
//
// Both functions are defined and exported from components/layout/Sidebar.tsx
// itself (the fix's scope is that file only), but this test does NOT import
// Sidebar.tsx: doing so pulls in the full agent/sidebar/settings/multi-pane
// store graph plus several native modules (TerminalEmulatorModule, expo-
// notifications, @react-native-async-storage/async-storage, ...), and
// mounting even that much before the store graph finishes its own
// initialization throws inside use-multi-pane.ts's zustand store outside a
// real RN runtime. The existing test suite already avoids this for the same
// component — see __tests__/ai-pane-dispatch-interaction-order.test.tsx's
// "Scenario 6", which replicates Sidebar.tsx's Edit handler line-for-line in
// a comment-documented mirror rather than importing it. This file follows
// the same convention: the two functions below are exact copies of
// Sidebar.tsx's exported implementations (kept comment-linked so a change to
// one is easy to notice needs the other updated too).
function skillsSectionBecameVisible(prevOpen: boolean, nextOpen: boolean): boolean {
  return nextOpen && !prevOpen;
}

interface AgentOverflowMenuActionSpec {
  key: 'history' | 'memory' | 'autonomous';
  textKey: string;
}
function buildAgentOverflowMenuActions(params: {
  hasHistory: boolean;
  autonomous: boolean;
}): AgentOverflowMenuActionSpec[] {
  const actions: AgentOverflowMenuActionSpec[] = [];
  if (params.hasHistory) {
    actions.push({ key: 'history', textKey: 'sidebar.agent_view_runs' });
  }
  actions.push({ key: 'memory', textKey: 'sidebar.agent_memory_view' });
  actions.push({
    key: 'autonomous',
    textKey: params.autonomous ? 'sidebar.autonomous_toggle_menu_off' : 'sidebar.autonomous_toggle_menu_on',
  });
  return actions;
}

describe('skillsSectionBecameVisible (bug 1: SKILLS list reload trigger)', () => {
  it('fires on a closed -> open transition', () => {
    expect(skillsSectionBecameVisible(false, true)).toBe(true);
  });

  it('does not fire when already open (open -> open, e.g. an unrelated re-render)', () => {
    expect(skillsSectionBecameVisible(true, true)).toBe(false);
  });

  it('does not fire on an open -> closed transition', () => {
    expect(skillsSectionBecameVisible(true, false)).toBe(false);
  });

  it('does not fire while staying closed', () => {
    expect(skillsSectionBecameVisible(false, false)).toBe(false);
  });
});

describe('buildAgentOverflowMenuActions (bug 2: agent-row overflow menu)', () => {
  it('includes history, memory, and the AUTO toggle when the agent has run history', () => {
    const actions = buildAgentOverflowMenuActions({ hasHistory: true, autonomous: false });
    expect(actions.map((a) => a.key)).toEqual(['history', 'memory', 'autonomous']);
  });

  it('omits history (and only history) when the agent has never run', () => {
    const actions = buildAgentOverflowMenuActions({ hasHistory: false, autonomous: false });
    expect(actions.map((a) => a.key)).toEqual(['memory', 'autonomous']);
  });

  it("never exceeds Android AlertDialog's 3-button cap regardless of agent state", () => {
    for (const hasHistory of [true, false]) {
      for (const autonomous of [true, false]) {
        const actions = buildAgentOverflowMenuActions({ hasHistory, autonomous });
        expect(actions.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('keeps every relocated row action reachable — no action key is ever dropped from the menu', () => {
    // The row used to have 3 relocatable actions: history (conditional on
    // existing runs), memory, and the AUTO toggle. This asserts none of them
    // silently vanished in the move from row icons to menu entries.
    const withHistory = buildAgentOverflowMenuActions({ hasHistory: true, autonomous: false });
    const keys = new Set(withHistory.map((a) => a.key));
    expect(keys.has('history')).toBe(true);
    expect(keys.has('memory')).toBe(true);
    expect(keys.has('autonomous')).toBe(true);
  });

  it('selects the ON label when the agent is not yet autonomous, OFF once it is', () => {
    const onLabelSpec = buildAgentOverflowMenuActions({ hasHistory: false, autonomous: false })
      .find((a) => a.key === 'autonomous') as AgentOverflowMenuActionSpec;
    const offLabelSpec = buildAgentOverflowMenuActions({ hasHistory: false, autonomous: true })
      .find((a) => a.key === 'autonomous') as AgentOverflowMenuActionSpec;
    expect(onLabelSpec.textKey).toBe('sidebar.autonomous_toggle_menu_on');
    expect(offLabelSpec.textKey).toBe('sidebar.autonomous_toggle_menu_off');
  });

  it('resolves every textKey to an actual i18n string in both locales (catches a typo in a key)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('@/lib/i18n/locales/en').default as Record<string, string>;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ja = require('@/lib/i18n/locales/ja').default as Record<string, string>;
    const allSpecs = [
      ...buildAgentOverflowMenuActions({ hasHistory: true, autonomous: false }),
      ...buildAgentOverflowMenuActions({ hasHistory: true, autonomous: true }),
    ];
    for (const spec of allSpecs) {
      expect(typeof en[spec.textKey]).toBe('string');
      expect(typeof ja[spec.textKey]).toBe('string');
    }
  });
});
