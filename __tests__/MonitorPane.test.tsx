/**
 * __tests__/MonitorPane.test.tsx — render tests for the MONITOR pane: it
 * mounts on the demo source, switches to MAP, labels the DEMO feed as
 * playback (not a recording), pins the approval reply under the mission bar,
 * and the plain-chat approval round-trip (type "ok") reaches mission complete.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import MonitorPane from '@/components/panes/MonitorPane';
import { useAgentStore, type LiveRunEntry } from '@/store/agent-store';
import type { MonitorRun } from '@/lib/agent-progress';

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

const layout = { isWide: true, isCompact: false };
jest.mock('@/hooks/use-device-layout', () => ({
  useDeviceLayout: () => layout,
}));

// The poller execs a shell; LIVE data is injected through the store instead.
jest.mock('@/hooks/use-monitor-live-poller', () => ({ useMonitorLivePoller: jest.fn() }));
const mockOpenFile = jest.fn(async (_path: string) => {});
jest.mock('@/lib/open-file', () => ({ openFile: (p: string) => mockOpenFile(p) }));
const mockOpenChat = jest.fn((_id: string) => true);
jest.mock('@/lib/agent-thread-open', () => ({ openAgentChatThread: (id: string) => mockOpenChat(id) }));

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
    useAgentStore.getState().setMonitor({ sourceMode: 'auto', liveAgentId: null, selectedId: 'ch1' });
    useAgentStore.setState({ liveRuns: {}, agents: [], runningAgentIds: [] });
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

describe('MonitorPane LIVE source', () => {
  const NOW = Date.now();
  const iso = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();

  function liveRun(over: Partial<MonitorRun> = {}): MonitorRun {
    return {
      runId: 'run-1',
      agentId: 'digest',
      mode: 'SERIAL',
      startedAt: iso(20),
      stepCount: 2,
      lastSeq: 9,
      branches: [
        {
          branchId: 'run-1#0',
          stepIndex: 0,
          state: 'DONE',
          provider: { kind: 'API', name: 'perplexity', model: 'sonar' },
          tail: '41 results',
          usage: { inputTokens: 100, outputTokens: 20, usd: 0.003 },
          startedAt: iso(19),
          endedAt: iso(10),
          updatedAt: iso(10),
        },
        {
          branchId: 'run-1#1',
          stepIndex: 1,
          state: 'RUNNING',
          tail: 'drafting',
          startedAt: iso(9),
          updatedAt: iso(2),
        },
      ],
      ...over,
    };
  }

  function seed(run: MonitorRun, entry: Partial<LiveRunEntry> = {}) {
    act(() => {
      useAgentStore.setState({
        agents: [
          {
            id: 'digest',
            name: 'Paper digest',
            orchestration: { steps: ['collect papers', 'save to Obsidian'] },
          } as never,
        ],
        runningAgentIds: run.endedAt ? [] : ['digest'],
        liveRuns: { digest: [{ run, ...entry }] },
      });
    });
  }

  beforeEach(() => {
    layout.isWide = true;
    mockOpenFile.mockClear();
    mockOpenChat.mockClear();
    useAgentStore.getState().setMonitor({ view: 'grid', auto: false, sourceMode: 'auto', liveAgentId: null });
    useAgentStore.setState({ liveRuns: {}, agents: [], runningAgentIds: [] });
  });

  it('defaults to DEMO when no run is known', () => {
    const utils = render(<MonitorPane />);
    expect(utils.getByText('monitor.source.live_none')).toBeTruthy();
    expect(utils.getByText('monitor.demo_badge')).toBeTruthy();
    expect(utils.getByText('SPEED 1×')).toBeTruthy();
    utils.unmount();
  });

  it('defaults to LIVE for a running run and hides the demo-only controls', () => {
    seed(liveRun());
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.getByText('monitor.source.live')).toBeTruthy();
    expect(utils.queryByText('monitor.demo_badge')).toBeNull();
    expect(utils.queryByText('monitor.cost_sample')).toBeNull();
    expect(utils.queryByText(/^SPEED/)).toBeNull();
    expect(utils.queryByText(/monitor.restart/)).toBeNull();
    expect(utils.queryByLabelText('monitor.chat_a11y')).toBeNull();
    // Cameras come from the run's steps, named by the agent's step instructions.
    expect(utils.getByText('collect papers')).toBeTruthy();
    expect(utils.getByText('save to Obsidian')).toBeTruthy();
    // Real recording, not the DEMO OSD.
    expect(utils.queryByText('monitor.osd_demo')).toBeNull();
    expect(utils.getAllByText('monitor.rec').length).toBeGreaterThan(0);
    // AUTO until the second step reports its provider.
    expect(utils.getAllByText('AUTO').length).toBeGreaterThan(0);
    // Step-based mission %: (1 + 0.5) / 2
    expect(utils.getByText('75%')).toBeTruthy();
    utils.unmount();
  });

  it('switches to DEMO and back from the selector', () => {
    seed(liveRun());
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByLabelText('monitor.source.demo_a11y'));
    expect(useAgentStore.getState().monitor.sourceMode).toBe('demo');
    expect(utils.getByText('monitor.demo_badge')).toBeTruthy();
    expect(utils.getByText('SPEED 1×')).toBeTruthy();
    fireEvent.press(utils.getByLabelText('monitor.source.live_a11y'));
    expect(useAgentStore.getState().monitor).toMatchObject({ sourceMode: 'live', liveAgentId: 'digest' });
    expect(utils.queryByText('monitor.demo_badge')).toBeNull();
    utils.unmount();
  });

  it('LIVE MAP is read-only (no editor tools, no DEMO note)', () => {
    seed(liveRun());
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('MAP'));
    expect(utils.getByText('monitor.map.caption')).toBeTruthy();
    expect(utils.queryByText('monitor.map.demo_note')).toBeNull();
    expect(utils.queryByText('monitor.map.add')).toBeNull();
    expect(utils.queryByText('monitor.map.hint')).toBeNull();
    utils.unmount();
  });

  it('approval: points to Shelly chat and opens the agent chat, no reply box', () => {
    const r = liveRun();
    r.branches[1] = { ...r.branches[1], state: 'WAITING_APPROVAL' };
    seed(r);
    const utils = render(<MonitorPane />);
    expect(utils.getByTestId('monitor-pinned-approval')).toBeTruthy();
    expect(utils.getByText('monitor.live.approval_where')).toBeTruthy();
    expect(utils.queryByLabelText('monitor.pinned_a11y')).toBeNull();
    fireEvent.press(utils.getByLabelText('monitor.live.open_chat_a11y'));
    expect(mockOpenChat).toHaveBeenCalledWith('digest');
    utils.unmount();
  });

  it('completed run with a recorded output: "Saved to" opens the file', () => {
    const r = liveRun({ endedAt: iso(1), status: 'success' });
    r.branches[1] = { ...r.branches[1], state: 'DONE', endedAt: iso(1) };
    seed(r, { savedPath: '/sdcard/Obsidian/digest.md' });
    const utils = render(<MonitorPane />);
    expect(utils.getByText('monitor.mission_complete')).toBeTruthy();
    fireEvent.press(utils.getByTestId('monitor-saved-to'));
    expect(mockOpenFile).toHaveBeenCalledWith('/sdcard/Obsidian/digest.md');
    utils.unmount();
  });

  it('failed run shows the failure reason; stopped run says STOPPED BY YOU', () => {
    const failed = liveRun({ endedAt: iso(1), status: 'error' });
    failed.branches[1] = { ...failed.branches[1], state: 'FAILED', tail: '429 rate limited', endedAt: iso(1) };
    seed(failed);
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.getByTestId('monitor-failure')).toBeTruthy();
    expect(utils.getByTestId('monitor-status').props.children).toBe('monitor.live.outcome.failed');
    expect(utils.queryByTestId('monitor-saved-to')).toBeNull();

    const halted = liveRun({ endedAt: iso(1), status: 'halted' });
    halted.branches[1] = { ...halted.branches[1], state: 'SKIPPED', endedAt: iso(1) };
    seed(halted);
    expect(utils.getByTestId('monitor-status').props.children).toBe('monitor.live.outcome.stopped');
    expect(utils.queryByTestId('monitor-failure')).toBeNull();
    expect(utils.getAllByText('monitor.state.STOPPED').length).toBeGreaterThan(0);
    utils.unmount();
  });
});
