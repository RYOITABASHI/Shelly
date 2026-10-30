/**
 * __tests__/MonitorPane.test.tsx — render tests for the MONITOR pane: it
 * mounts on the demo source, switches to MAP, labels the DEMO feed as
 * playback (not a recording), pins the approval reply under the mission bar,
 * and the plain-chat approval round-trip (type "ok") reaches mission complete.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import MonitorPane from '@/components/panes/MonitorPane';
import { useAgentStore } from '@/store/agent-store';

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

const layout = { isWide: true, isCompact: false };
jest.mock('@/hooks/use-device-layout', () => ({
  useDeviceLayout: () => layout,
}));

const setT = (t: number) =>
  act(() => {
    useAgentStore.setState((s) => ({ monitor: { ...s.monitor, t } }));
  });

const layoutWall = (utils: ReturnType<typeof render>) =>
  fireEvent(utils.getByTestId('monitor-wall'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } },
  });

describe('MonitorPane', () => {
  beforeEach(() => {
    layout.isWide = true;
    layout.isCompact = false;
    useAgentStore.getState().restartMonitor();
    useAgentStore.getState().setMonitor({ view: 'grid', auto: false, speed: 1, legendDismissed: false });
    useAgentStore.getState().setMonitorTeam(null);
  });

  it('renders the demo wall and the DEMO label once (mission bar only)', () => {
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.getAllByText('monitor.demo_badge')).toHaveLength(1);
    expect(utils.getByText('ARXIV SCOUT')).toBeTruthy();
    expect(utils.getByText('monitor.no_signal')).toBeTruthy();
    utils.unmount();
  });

  it('opens the MAP editor with the DEMO preview note and the destination', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('MAP'));
    expect(utils.getByText('monitor.map.caption')).toBeTruthy();
    expect(utils.getByText('monitor.map.lane_parallel')).toBeTruthy();
    expect(utils.getByText('monitor.map.demo_note')).toBeTruthy();
    expect(utils.getByText('OBSIDIAN')).toBeTruthy();
    // Wide keeps the wall under the map and the goal node's mission/API lines.
    expect(utils.queryByTestId('monitor-wall')).toBeTruthy();
    expect(utils.getByText('monitor.map.goal_progress')).toBeTruthy();
    utils.unmount();
  });

  it('shows ▶ DEMO and playback time on the camera OSD instead of REC + wall clock', () => {
    useAgentStore.getState().setMonitor({ view: 'single', selectedId: 'ch1' });
    const utils = render(<MonitorPane />);
    setT(5.4);
    expect(utils.getByText('monitor.osd_demo')).toBeTruthy();
    expect(utils.queryByText('monitor.rec')).toBeNull();
    // Mission bar + camera OSD both show playback time.
    expect(utils.getAllByText('T+00:05').length).toBeGreaterThanOrEqual(2);
    expect(utils.queryByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)).toBeNull();
    utils.unmount();
  });

  it('camera HUD shows % only (STEP is reserved for map columns)', () => {
    useAgentStore.getState().setMonitor({ view: 'single', selectedId: 'ch1' });
    const utils = render(<MonitorPane />);
    expect(utils.queryByText('monitor.step')).toBeNull();
    expect(utils.getAllByText('0%').length).toBeGreaterThan(0);
    utils.unmount();
  });

  it('shows spent / cap and a dismissible cost legend', () => {
    const utils = render(<MonitorPane />);
    expect(utils.getByText('$0.0000 / $0.1333')).toBeTruthy();
    expect(utils.getByTestId('monitor-cost-legend')).toBeTruthy();
    fireEvent.press(utils.getByLabelText('monitor.legend_dismiss'));
    expect(utils.queryByTestId('monitor-cost-legend')).toBeNull();
    expect(useAgentStore.getState().monitor.legendDismissed).toBe(true);
    // Dismissal survives RESTART (UI state, not run state).
    act(() => useAgentStore.getState().restartMonitor());
    expect(utils.queryByTestId('monitor-cost-legend')).toBeNull();
    utils.unmount();
  });

  it('asks for approval in chat and completes after "ok"', () => {
    const utils = render(<MonitorPane />);
    setT(26);
    expect(utils.getByText('monitor.waiting_for_you')).toBeTruthy();
    const chatInput = utils.getByLabelText('monitor.chat_a11y');
    fireEvent.changeText(chatInput, 'ok');
    fireEvent(chatInput, 'submitEditing');
    setT(40);
    expect(utils.getByText('monitor.mission_complete')).toBeTruthy();
    expect(utils.getByTestId('monitor-saved-to')).toBeTruthy();
    utils.unmount();
  });

  it('pins the approval question + reply under the mission bar, same handling as chat', () => {
    const utils = render(<MonitorPane />);
    expect(utils.queryByTestId('monitor-pinned-approval')).toBeNull();
    setT(26);
    expect(utils.getByTestId('monitor-pinned-approval')).toBeTruthy();
    expect(utils.getAllByText(/monitor.demo.chat.approval_ask/).length).toBeGreaterThanOrEqual(2);
    const pinned = utils.getByLabelText('monitor.pinned_a11y');
    // An unrecognised reply re-asks, exactly like the chat strip.
    fireEvent.changeText(pinned, 'maybe');
    expect(utils.getByLabelText('monitor.chat_a11y').props.value).toBe('maybe');
    fireEvent(pinned, 'submitEditing');
    expect(useAgentStore.getState().monitor.inputs.map((i) => i.text)).toEqual(['maybe']);
    expect(utils.getByTestId('monitor-pinned-approval')).toBeTruthy();
    fireEvent.changeText(utils.getByLabelText('monitor.pinned_a11y'), 'ok');
    fireEvent.press(utils.getByLabelText('monitor.pinned_send_a11y'));
    expect(utils.queryByTestId('monitor-pinned-approval')).toBeNull();
    setT(40);
    expect(utils.getByText('monitor.mission_complete')).toBeTruthy();
    utils.unmount();
  });

  it('folded layout: no NO SIGNAL tile, DONE folded into the progress label, no wall under MAP', () => {
    layout.isWide = false;
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.queryByText('monitor.no_signal')).toBeNull();
    expect(utils.getByText('monitor.done_count · 0%')).toBeTruthy();
    // Each camera keeps its latest-log line.
    setT(1);
    expect(utils.getByText(/query arXiv cs.AI, last 24h/)).toBeTruthy();
    fireEvent.press(utils.getByText('MAP'));
    expect(utils.queryByTestId('monitor-wall')).toBeNull();
    expect(utils.queryByText('monitor.map.goal_progress')).toBeNull();
    expect(utils.getByText('monitor.map.demo_note')).toBeTruthy();
    utils.unmount();
  });
});
