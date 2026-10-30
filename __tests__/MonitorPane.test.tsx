/**
 * __tests__/MonitorPane.test.tsx — render smoke test for the MONITOR pane:
 * it mounts on the demo source, switches to MAP, and the plain-chat approval
 * round-trip (type "ok") reaches mission complete.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import MonitorPane from '@/components/panes/MonitorPane';
import { useAgentStore } from '@/store/agent-store';

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

describe('MonitorPane', () => {
  beforeEach(() => {
    useAgentStore.getState().restartMonitor();
    useAgentStore.getState().setMonitor({ view: 'grid', auto: false, speed: 1 });
    useAgentStore.getState().setMonitorTeam(null);
  });

  it('renders the demo wall and the DEMO label', () => {
    const utils = render(<MonitorPane />);
    // The grid sizes its cameras from the measured wall width.
    fireEvent(utils.getByTestId('monitor-wall'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } },
    });
    expect(utils.getAllByText('monitor.demo_badge').length).toBeGreaterThan(0);
    expect(utils.getByText('ARXIV SCOUT')).toBeTruthy();
    expect(utils.getByText('monitor.no_signal')).toBeTruthy();
    utils.unmount();
  });

  it('opens the MAP editor', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('MAP'));
    expect(utils.getByText('monitor.map.caption')).toBeTruthy();
    expect(utils.getByText('monitor.map.lane_parallel')).toBeTruthy();
    utils.unmount();
  });

  it('asks for approval in chat and completes after "ok"', () => {
    const utils = render(<MonitorPane />);
    act(() => {
      useAgentStore.setState((s) => ({ monitor: { ...s.monitor, t: 26 } }));
    });
    expect(utils.getByText('monitor.waiting_for_you')).toBeTruthy();
    fireEvent.changeText(utils.getByLabelText('monitor.chat_a11y'), 'ok');
    fireEvent.press(utils.getByText('monitor.send'));
    act(() => {
      useAgentStore.setState((s) => ({ monitor: { ...s.monitor, t: 40 } }));
    });
    expect(utils.getByText('monitor.mission_complete')).toBeTruthy();
    utils.unmount();
  });
});
