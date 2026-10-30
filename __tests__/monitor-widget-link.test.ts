import * as fs from 'fs';
import * as path from 'path';
import {
  canReturnFromMonitor,
  monitorLinkPatch,
  openMonitorFromWidgetLink,
  parseMonitorWidgetLink,
  pickSwapSlot,
  restoreFromMonitor,
  swapSlotToMonitor,
  type MonitorReturn,
  type SlotLike,
  type SlotOps,
} from '@/lib/monitor-widget-link';
import { createLiveSource, liveProviderLabel, withPlannedSteps } from '@/lib/monitor-live';
import type { MonitorRun } from '@/lib/agent-progress';

describe('parseMonitorWidgetLink', () => {
  it('reads agent and step', () => {
    expect(parseMonitorWidgetLink({ agentId: 'daily-papers_2', step: '3' })).toEqual({ agentId: 'daily-papers_2', step: 3 });
  });

  it('takes the first value of repeated params', () => {
    expect(parseMonitorWidgetLink({ agentId: ['a1', 'b2'], step: ['0', '9'] })).toEqual({ agentId: 'a1', step: 0 });
  });

  it('opens the plain pane with no params', () => {
    expect(parseMonitorWidgetLink(undefined)).toEqual({ agentId: null, step: null });
    expect(parseMonitorWidgetLink(null)).toEqual({ agentId: null, step: null });
    expect(parseMonitorWidgetLink({})).toEqual({ agentId: null, step: null });
  });

  it('drops unsafe agent ids (and the step with them)', () => {
    for (const bad of ['../etc', 'a b', 'x;rm', '', 'é', 'a'.repeat(129)]) {
      expect(parseMonitorWidgetLink({ agentId: bad, step: '1' })).toEqual({ agentId: null, step: null });
    }
  });

  it('drops malformed steps but keeps the agent', () => {
    for (const bad of ['-1', '1.5', 'x', '', '1000', ' 2', '0x1']) {
      expect(parseMonitorWidgetLink({ agentId: 'a1', step: bad })).toEqual({ agentId: 'a1', step: null });
    }
  });
});

describe('monitorLinkPatch', () => {
  it('camera tap → LIVE single view on the live camera id', () => {
    expect(monitorLinkPatch({ agentId: 'a1', step: 2 })).toEqual({
      sourceMode: 'live',
      liveAgentId: 'a1',
      view: 'single',
      selectedId: 's2',
      auto: false,
    });
  });

  it('widget tap → LIVE grid on the agent', () => {
    expect(monitorLinkPatch({ agentId: 'a1', step: null })).toEqual({
      sourceMode: 'live',
      liveAgentId: 'a1',
      view: 'grid',
      auto: false,
    });
  });

  it('no agent → grid, source left alone', () => {
    expect(monitorLinkPatch({ agentId: null, step: null })).toEqual({ view: 'grid', auto: false });
  });
});

describe('openMonitorFromWidgetLink', () => {
  it('selects the channel before showing the pane', () => {
    const calls: string[] = [];
    const setMonitor = jest.fn(() => calls.push('set'));
    const showMonitorPane = jest.fn(() => {
      calls.push('show');
      return true;
    });
    const opened = openMonitorFromWidgetLink({ agentId: 'a1', step: '1' }, { setMonitor, showMonitorPane });
    expect(opened).toBe(true);
    expect(calls).toEqual(['set', 'show']);
    expect(setMonitor).toHaveBeenCalledWith(expect.objectContaining({ liveAgentId: 'a1', selectedId: 's1', view: 'single' }));
  });

  it('reports when no pane could be shown', () => {
    expect(openMonitorFromWidgetLink({}, { setMonitor: () => {}, showMonitorPane: () => false })).toBe(false);
  });
});

// Drift gate: the Kotlin widget builds these links, RootLayout routes them.
describe('MONITOR widget deep link wiring', () => {
  const root = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the Kotlin renderer emits shelly://monitor with agentId / step', () => {
    const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/monitor/MonitorWidgetRenderer.kt');
    expect(kt).toContain('Uri.parse("shelly://monitor")');
    expect(kt).toContain('appendQueryParameter("agentId"');
    expect(kt).toContain('appendQueryParameter("step"');
  });

  it('a landing route exists (no Unmatched Route page on cold start)', () => {
    expect(read('app/monitor.tsx')).toMatch(/export \{ default \} from '\.\/index';/);
  });

  it('RootLayout handles the monitor target', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain("target === 'monitor'");
    expect(layout).toContain('openMonitorFromWidgetLink(parsed.queryParams');
  });

  it('live camera ids match lib/monitor-live.ts liveDefId', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { liveDefId } = require('@/lib/monitor-live');
    expect(monitorLinkPatch({ agentId: 'a', step: 4 }).selectedId).toBe(liveDefId(4));
  });
});

// A fake multi-pane store for the "no free slot" fallback.
function fakeSlots(initial: (SlotLike | null)[], focused = 0) {
  const slots = initial.map((s) => (s ? { ...s } : null));
  let focusedSlot = focused;
  const focusCalls: number[] = [];
  const ops: SlotOps = {
    getSlots: () => slots,
    getFocusedSlot: () => focusedSlot,
    setSlotTab: (i, tab) => {
      slots[i] = { ...slots[i]!, tab };
    },
    focusSlot: (i) => {
      focusedSlot = i;
      focusCalls.push(i);
    },
  };
  let ret: MonitorReturn | null = null;
  const setReturnTo = (r: MonitorReturn | null) => {
    ret = r;
  };
  return { slots, ops, setReturnTo, getReturn: () => ret, focusCalls };
}

describe('no free slot fallback (single terminal on the cover screen)', () => {
  it('turns the focused terminal slot into MONITOR and can put it back', () => {
    const f = fakeSlots([{ id: 'term1', tab: 'terminal' }, null, null, null]);
    expect(swapSlotToMonitor(f.ops, f.setReturnTo)).toBe(true);
    expect(f.slots[0]).toEqual({ id: 'term1', tab: 'monitor' });
    expect(f.getReturn()).toEqual({ slotId: 'term1', tab: 'terminal' });
    expect(canReturnFromMonitor(f.getReturn(), f.slots)).toBe(true);

    expect(restoreFromMonitor(f.getReturn(), f.ops, f.setReturnTo)).toBe(true);
    expect(f.slots[0]).toEqual({ id: 'term1', tab: 'terminal' });
    expect(f.getReturn()).toBeNull();
    expect(f.focusCalls).toEqual([0, 0]);
  });

  it('keeps the other slot fields (terminal session) when swapping', () => {
    const f = fakeSlots([{ id: 't', tab: 'terminal', sessionId: 's1' } as SlotLike, null, null, null]);
    swapSlotToMonitor(f.ops, f.setReturnTo);
    expect(f.slots[0]).toEqual({ id: 't', tab: 'monitor', sessionId: 's1' });
  });

  it('uses the first occupied slot when the focused one is empty', () => {
    expect(pickSwapSlot([null, { id: 'b', tab: 'terminal' }], 0)).toBe(1);
    expect(pickSwapSlot([null, null], 0)).toBeNull();
    const f = fakeSlots([null, null, null, null]);
    expect(swapSlotToMonitor(f.ops, f.setReturnTo)).toBe(false);
  });

  it('does not record a return when the slot already shows MONITOR', () => {
    const f = fakeSlots([{ id: 'm', tab: 'monitor' }]);
    expect(swapSlotToMonitor(f.ops, f.setReturnTo)).toBe(true);
    expect(f.getReturn()).toBeNull();
  });

  it('BACK is offered only while that slot still shows MONITOR', () => {
    const ret = { slotId: 'term1', tab: 'terminal' };
    expect(canReturnFromMonitor(ret, [{ id: 'term1', tab: 'terminal' }])).toBe(false);
    expect(canReturnFromMonitor(null, [{ id: 'term1', tab: 'monitor' }])).toBe(false);
    // The user moved on: restoring clears the record and changes nothing.
    const f = fakeSlots([{ id: 'term1', tab: 'ai' }]);
    expect(restoreFromMonitor(ret, f.ops, f.setReturnTo)).toBe(false);
    expect(f.slots[0]!.tab).toBe('ai');
  });

  it('openMonitorFromWidgetLink falls back when the pane cannot be added', () => {
    const f = fakeSlots([{ id: 'term1', tab: 'terminal' }]);
    const opened = openMonitorFromWidgetLink(
      { agentId: 'a1', step: '0' },
      { setMonitor: () => {}, showMonitorPane: () => false || swapSlotToMonitor(f.ops, f.setReturnTo) },
    );
    expect(opened).toBe(true);
    expect(f.slots[0]!.tab).toBe('monitor');
  });
});

describe('pane and widget show the same cameras', () => {
  const run: MonitorRun = {
    runId: 'r1',
    agentId: 'a1',
    mode: 'SERIAL',
    startedAt: '2026-10-30T12:00:00.000Z',
    stepCount: 3,
    lastSeq: 2,
    branches: [{ branchId: 'r1#0', stepIndex: 0, state: 'RUNNING', updatedAt: '2026-10-30T12:00:01.000Z' }],
  };

  it('a planned step without an event gets a STANDBY camera the widget can deep-link to', () => {
    const padded = withPlannedSteps(run);
    expect(padded.branches.map((b) => [b.stepIndex, b.state])).toEqual([
      [0, 'RUNNING'],
      [1, 'STANDBY'],
      [2, 'STANDBY'],
    ]);
    const source = createLiveSource(run);
    const target = monitorLinkPatch(parseMonitorWidgetLink({ agentId: 'a1', step: '2' })).selectedId;
    expect(source.agents.map((d) => d.id)).toContain(target);
    expect(source.snapshot(Date.parse('2026-10-30T12:00:02.000Z'), []).agents[target!]?.state).toBe('STANDBY');
  });

  it('leaves a fully reported run alone', () => {
    const full = { ...run, stepCount: 1 };
    expect(withPlannedSteps(full)).toBe(full);
  });

  it('labels a CLI step like the widget does', () => {
    expect(liveProviderLabel('cli:codex')).toBe('Codex CLI');
    expect(liveProviderLabel('local')).toBe('Local LLM');
  });
});
