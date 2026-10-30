import * as fs from 'fs';
import * as path from 'path';
import { monitorLinkPatch, openMonitorFromWidgetLink, parseMonitorWidgetLink } from '@/lib/monitor-widget-link';

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
