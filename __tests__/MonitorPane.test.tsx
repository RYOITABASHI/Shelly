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
import { computeMonitorGrid } from '@/components/monitor/monitor-grid';

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
  tFor: (_locale: string, key: string) => key,
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
// Provider picker: the exec / updateAgent side lives in lib/monitor-provider-pick.
const mockApplyPick = jest.fn(async (..._args: unknown[]) => ({ result: 'override', appliesNow: true, paidNextRun: false }));
jest.mock('@/lib/monitor-provider-pick', () => ({
  applyProviderPick: (...args: unknown[]) => mockApplyPick(...args),
}));

// Register / run hand-off: the AI pane focus, the agent runner and the shell
// are the I/O boundaries; the registration store itself is real.
const mockEnsurePane = jest.fn((_tab: string) => true);
jest.mock('@/lib/pane-focus', () => ({ ensurePaneByTab: (tab: string) => mockEnsurePane(tab) }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/hooks/use-multi-pane', () => {
  const state = { slots: [{ id: 'leaf-ai', tab: 'ai' }], focusedSlot: 0 };
  // Callable as a selector hook (MonitorPane's BACK slot) and via getState.
  const useMultiPaneStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useMultiPaneStore };
});
const mockRunAgentNow = jest.fn(async (_id: string, _run: unknown) => {});
const mockUpdateAgent = jest.fn(async () => null);
jest.mock('@/lib/agent-manager', () => ({
  runAgentNow: (id: string, run: unknown) => mockRunAgentNow(id, run),
  updateAgent: () => mockUpdateAgent(),
}));
jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
const mockSetClipboard = jest.fn(async (_s: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockSetClipboard(s) }));

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

  it('single camera view has its own way back to the grid', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getAllByLabelText(/^CH-01 /)[0]);
    expect(utils.queryByTestId('monitor-grid')).toBeNull();
    expect(utils.queryByTestId('monitor-grid-fit')).toBeNull();
    fireEvent.press(utils.getByText('monitor.back_to_grid'));
    expect(utils.queryByText('monitor.back_to_grid')).toBeNull();
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

describe('MonitorPane GRID fits the pane (no scrolling)', () => {
  const layoutOf = (utils: ReturnType<typeof render>, id: string, width: number, height: number) =>
    fireEvent(utils.getByTestId(id), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  /** Pane `w`x`h` with fixed-height chrome; returns the wall height the pane
   *  should give the grid (pane - 2 paddings - 2 gaps - chrome - 1). */
  const layoutPane = (utils: ReturnType<typeof render>, w: number, h: number, top = 110, bottom = 150) => {
    layoutOf(utils, 'monitor-root', w, h);
    layoutOf(utils, 'monitor-chrome-top', w - 20, top);
    layoutOf(utils, 'monitor-chrome-bottom', w - 20, bottom);
    layoutOf(utils, 'monitor-wall', w - 20, 0);
    return Math.floor(h - 20 - 20 - top - bottom) - 1;
  };

  beforeEach(() => {
    layout.isWide = true;
    layout.isCompact = false;
    useAgentStore.getState().restartMonitor();
    useAgentStore.getState().setMonitor({
      view: 'grid',
      auto: false,
      speed: 1,
      legendDismissed: false,
      sourceMode: 'demo',
    });
    useAgentStore.getState().setMonitorTeam(null);
  });

  it.each([
    ['full pane', 1720, 1700],
    ['half-height pane', 1720, 800],
    ['portrait', 800, 1700],
    ['wide dp pane', 760, 640],
  ])('%s: every camera sits inside a fixed-height wall', (_name, w, h) => {
    const utils = render(<MonitorPane />);
    const wallH = layoutPane(utils, w, h);
    expect(utils.getByTestId('monitor-grid-fit')).toBeTruthy();
    const wall = utils.getByTestId('monitor-wall');
    const wallStyle = Object.assign({}, ...[wall.props.style].flat(3).filter(Boolean));
    expect(wallStyle.height).toBe(wallH);
    const g = computeMonitorGrid(w - 20, wallH, 5);
    expect(g.fits).toBe(true);
    // The NO SIGNAL tile only when the chosen grid leaves a cell free.
    expect(utils.queryAllByText('monitor.no_signal').length).toBe(g.freeCells > 0 ? 1 : 0);
    // The one-time legend gives its row back to the cameras.
    expect(utils.queryByTestId('monitor-cost-legend')).toBeNull();
    utils.unmount();
  });

  it('falls back to a scrolling wall when even the smallest cells cannot fit', () => {
    const utils = render(<MonitorPane />);
    layoutPane(utils, 380, 340);
    expect(utils.queryByTestId('monitor-grid-fit')).toBeNull();
    expect(utils.getByTestId('monitor-grid')).toBeTruthy();
    // Every camera is still rendered (reachable by scrolling).
    expect(utils.getByText('ARXIV SCOUT')).toBeTruthy();
    utils.unmount();
  });

  it('keeps the legend on the single view', () => {
    const utils = render(<MonitorPane />);
    layoutPane(utils, 1720, 1700);
    expect(utils.queryByTestId('monitor-cost-legend')).toBeNull();
    act(() => useAgentStore.getState().setMonitor({ view: 'single', selectedId: 'ch1' }));
    expect(utils.getByTestId('monitor-cost-legend')).toBeTruthy();
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
    expect(utils.queryByTestId('monitor-chat-unavailable')).toBeNull();
    // 4 panes full: say so inline instead of doing nothing.
    mockOpenChat.mockReturnValueOnce(false);
    fireEvent.press(utils.getByLabelText('monitor.live.open_chat_a11y'));
    expect(utils.getByTestId('monitor-chat-unavailable')).toBeTruthy();
    utils.unmount();
  });

  it('single view: tapping the camera opens the inline provider picker; Redo writes a restart override', async () => {
    seed(liveRun());
    act(() => {
      useAgentStore.getState().setMonitor({ view: 'single', selectedId: 's1', auto: false });
    });
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.queryByTestId('monitor-provider-picker')).toBeNull();
    fireEvent.press(utils.getAllByLabelText(/save to Obsidian/)[0]);
    expect(utils.getByTestId('monitor-provider-picker')).toBeTruthy();
    // Nothing to apply until a different provider is chosen.
    expect(utils.queryByTestId('monitor-provider-keep')).toBeNull();
    fireEvent.press(utils.getByTestId('monitor-provider-groq'));
    expect(utils.getByTestId('monitor-provider-keep')).toBeTruthy();
    await act(async () => {
      fireEvent.press(utils.getByTestId('monitor-provider-restart'));
    });
    expect(mockApplyPick).toHaveBeenCalledTimes(1);
    expect(mockApplyPick.mock.calls[0][2]).toMatchObject({ stepIndex: 1, pick: 'groq', restart: true, runId: 'run-1', runActive: true });
    // One-line note in the agent's own chat thread (the real chat store).
    const { useAIPaneStore, agentThreadKey } = require('@/store/ai-pane-store');
    const thread = useAIPaneStore.getState().getOrCreate(agentThreadKey('digest')).messages;
    expect(thread.some((m: { role: string; content: string }) => m.role === 'system' && m.content === 'monitor.provider.note_restart')).toBe(true);
    expect(utils.queryByTestId('monitor-provider-picker')).toBeNull();
    // Still the single view (on LIVE the tap no longer jumps to GRID).
    expect(useAgentStore.getState().monitor.view).toBe('single');
    utils.unmount();
  });

  it('a finished step offers Keep going only (no redo)', () => {
    seed(liveRun());
    act(() => {
      useAgentStore.getState().setMonitor({ view: 'single', selectedId: 's0', auto: false });
    });
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    fireEvent.press(utils.getAllByLabelText(/collect papers/)[0]);
    fireEvent.press(utils.getByTestId('monitor-provider-local'));
    expect(utils.getByTestId('monitor-provider-keep')).toBeTruthy();
    expect(utils.queryByTestId('monitor-provider-restart')).toBeNull();
    utils.unmount();
  });

  it('a single-step agent never offers 「今のステップをやり直す」', () => {
    const r = liveRun({ mode: 'SINGLE', stepCount: 1, branches: [{ ...liveRun().branches[1], branchId: 'run-1#0', stepIndex: 0, state: 'RUNNING' }] });
    act(() => {
      useAgentStore.setState({
        agents: [{ id: 'digest', name: 'Paper digest', tool: { type: 'local' } } as never],
        runningAgentIds: ['digest'],
        liveRuns: { digest: [{ run: r }] },
      });
      useAgentStore.getState().setMonitor({ view: 'single', selectedId: 's0', auto: false });
    });
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    fireEvent.press(utils.getAllByLabelText(/Paper digest|STEP 1/)[0]);
    fireEvent.press(utils.getByTestId('monitor-provider-groq'));
    expect(utils.getByTestId('monitor-provider-keep')).toBeTruthy();
    expect(utils.queryByTestId('monitor-provider-restart')).toBeNull();
    utils.unmount();
  });

  it('ignores leftover runs of a deleted agent', () => {
    seed(liveRun());
    act(() => {
      useAgentStore.setState({ agents: [] });
    });
    const utils = render(<MonitorPane />);
    expect(utils.getByText('monitor.source.live_none')).toBeTruthy();
    expect(utils.getByText('monitor.demo_badge')).toBeTruthy();
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
    // RUN n/3 is live concurrency; a finished run shows DONE n/total there.
    expect(utils.getByTestId('monitor-run-slot').props.children).toBe('monitor.done_count');
    expect(utils.queryByTestId('monitor-saved-to')).toBeNull();

    const halted = liveRun({ endedAt: iso(1), status: 'halted' });
    halted.branches[1] = { ...halted.branches[1], state: 'SKIPPED', endedAt: iso(1) };
    seed(halted);
    expect(utils.getByTestId('monitor-status').props.children).toBe('monitor.live.outcome.stopped');
    expect(utils.queryByTestId('monitor-failure')).toBeNull();
    expect(utils.getAllByText('monitor.state.STOPPED').length).toBeGreaterThan(0);
    utils.unmount();
  });

  it('a run stopped before any step ran reads 0%, not 100%', () => {
    const halted = liveRun({ endedAt: iso(1), status: 'halted' });
    halted.branches = halted.branches.map((b) => {
      const { startedAt: _s, provider: _p, usage: _u, tail: _t, ...rest } = b;
      return { ...rest, state: 'SKIPPED' as const, endedAt: iso(1) };
    });
    seed(halted);
    const utils = render(<MonitorPane />);
    layoutWall(utils);
    expect(utils.getByTestId('monitor-status').props.children).toBe('monitor.live.outcome.stopped');
    expect(utils.getByLabelText('monitor.mission_progress').props.accessibilityValue.now).toBe(0);
    // Header + both cameras read 0%; nothing claims 100%.
    expect(utils.getAllByText('0%').length).toBe(3);
    expect(utils.queryByText('100%')).toBeNull();
    utils.unmount();
  });

  it('LIVE MAP of a finished run offers RUN NOW for that agent (no REGISTER)', () => {
    const r = liveRun({ endedAt: iso(1), status: 'success' });
    r.branches[1] = { ...r.branches[1], state: 'DONE', endedAt: iso(1) };
    seed(r);
    mockRunAgentNow.mockClear();
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('MAP'));
    expect(utils.queryByTestId('monitor-map-register')).toBeNull();
    fireEvent.press(utils.getByTestId('monitor-map-run-now'));
    expect(mockRunAgentNow).toHaveBeenCalledWith('digest', expect.any(Function));
    utils.unmount();
  });
});

describe('MonitorPane MAP register / run / team file', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const reg = require('@/lib/monitor-team-registration') as typeof import('@/lib/monitor-team-registration');

  beforeEach(() => {
    layout.isWide = true;
    mockEnsurePane.mockReset().mockReturnValue(true);
    mockRunAgentNow.mockClear();
    reg.resetTeamRegistration();
    useAgentStore.getState().setMonitorTeam(null);
    useAgentStore.getState().setMonitor({ view: 'map', auto: false, sourceMode: 'auto', liveAgentId: null });
    useAgentStore.setState({ liveRuns: {}, agents: [], runningAgentIds: [] });
  });

  const isDisabled = (el: { props: { accessibilityState?: { disabled?: boolean } } }) =>
    !!el.props.accessibilityState?.disabled;

  it('DEMO: REGISTER is enabled; pressing it queues the team draft for the AI chat', () => {
    const utils = render(<MonitorPane />);
    const button = utils.getByTestId('monitor-map-register');
    expect(isDisabled(button)).toBe(false);
    expect(utils.queryByTestId('monitor-map-run-now')).toBeNull();
    fireEvent.press(button);
    expect(mockEnsurePane).toHaveBeenCalledWith('ai');
    const pending = reg.useMonitorTeamRegistration.getState().pending;
    expect(pending?.draft.orchestrationSteps).toHaveLength(4);
    // Waiting for the chat OK: the key is disabled and the note says where.
    expect(isDisabled(utils.getByTestId('monitor-map-register'))).toBe(true);
    expect(utils.getByTestId('monitor-map-register-note').props.children).toBe('monitor.register.awaiting');
    utils.unmount();
  });

  it('no room for the chat pane: says so and nothing is queued', () => {
    mockEnsurePane.mockReturnValue(false);
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByTestId('monitor-map-register'));
    expect(reg.useMonitorTeamRegistration.getState().pending).toBeNull();
    expect(utils.getByTestId('monitor-map-register-note').props.children).toBe('monitor.register.no_pane');
    utils.unmount();
  });

  it('confirmed in chat → LIVE standby for the new agent, then RUN NOW runs it', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByTestId('monitor-map-register'));
    // What the AI pane does: claim, post, bind; the user types OK.
    act(() => {
      reg.takePendingTeamDraft('leaf-ai');
      reg.markTeamDraftPosted('draft-msg');
      useAgentStore.setState({
        agents: [{ id: 'team-1', name: 'Daily AI paper digest', orchestration: { steps: [] } } as never],
      });
      reg.onTeamDraftConfirmed(reg.useMonitorTeamRegistration.getState().token!, 'team-1');
    });
    expect(useAgentStore.getState().monitor).toMatchObject({ sourceMode: 'live', liveAgentId: 'team-1' });
    expect(utils.getByTestId('monitor-standby')).toBeTruthy();
    expect(utils.queryByText('monitor.demo_badge')).toBeNull();
    // Standby shows the registered team read-only, with RUN NOW.
    expect(utils.queryByTestId('monitor-map-register')).toBeNull();
    expect(utils.queryByText('monitor.map.add')).toBeNull();
    fireEvent.press(utils.getByTestId('monitor-map-run-now'));
    expect(mockRunAgentNow).toHaveBeenCalledWith('team-1', expect.any(Function));
    utils.unmount();
  });

  it('DRAFT mode: editable, no playback controls, REGISTER available', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByLabelText('monitor.source.draft_a11y'));
    expect(useAgentStore.getState().monitor.sourceMode).toBe('draft');
    expect(utils.queryByText('monitor.demo_badge')).toBeNull();
    expect(utils.queryByText(/^SPEED/)).toBeNull();
    expect(utils.queryByText('monitor.map.demo_note')).toBeNull();
    expect(utils.getByText('monitor.map.add')).toBeTruthy();
    expect(isDisabled(utils.getByTestId('monitor-map-register'))).toBe(false);
    utils.unmount();
  });

  it('TEAM FILE: copy, load a pasted file into DRAFT, and show parse errors inline', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('monitor.map.file'));
    fireEvent.press(utils.getByText('monitor.map.file_copy'));
    expect(mockSetClipboard).toHaveBeenCalledWith(expect.stringContaining('# Daily AI paper digest'));

    // Syntax error: inline, with the line number.
    fireEvent.changeText(utils.getByTestId('monitor-map-paste'), '# T\nnot a step');
    fireEvent.press(utils.getByText('monitor.map.file_load'));
    expect(utils.getByTestId('monitor-map-paste-error').props.children).toBe('monitor.map.file_err_syntax');

    // Shape error (last step in parallel): the validate() message.
    fireEvent.changeText(utils.getByTestId('monitor-map-paste'), '# T\n- a\n- in parallel:\n  - b\n  - c');
    fireEvent.press(utils.getByText('monitor.map.file_load'));
    expect(utils.getByTestId('monitor-map-paste-error').props.children).toBe('monitor.map.err.final_parallel');

    // Valid file: loaded into the editor as your own team (DRAFT).
    fireEvent.changeText(utils.getByTestId('monitor-map-paste'), '# Mine\n- in parallel:\n  - fetch A [Groq]\n  - fetch B\n- merge them');
    fireEvent.press(utils.getByText('monitor.map.file_load'));
    expect(utils.queryByTestId('monitor-map-paste-error')).toBeNull();
    const state = useAgentStore.getState().monitor;
    expect(state.sourceMode).toBe('draft');
    expect(state.team?.title).toBe('Mine');
    expect(state.team?.columns.map((c) => c.length)).toEqual([2, 1]);
    utils.unmount();
  });

  it('TEAM FILE: an over-long paste is refused inline; control characters are dropped', () => {
    const utils = render(<MonitorPane />);
    fireEvent.press(utils.getByText('monitor.map.file'));
    fireEvent.changeText(utils.getByTestId('monitor-map-paste'), `# T\n- a\n${'x'.repeat(9000)}`);
    fireEvent.press(utils.getByText('monitor.map.file_load'));
    expect(utils.getByTestId('monitor-map-paste-error').props.children).toBe('monitor.map.file_err_too_long');
    fireEvent.changeText(utils.getByTestId('monitor-map-paste'), '# Bell\u0007\n- fetch\u0000 it\n- save it');
    fireEvent.press(utils.getByText('monitor.map.file_load'));
    expect(utils.queryByTestId('monitor-map-paste-error')).toBeNull();
    expect(useAgentStore.getState().monitor.team?.title).toBe('Bell');
    expect(useAgentStore.getState().monitor.team?.columns[0][0].role).toBe('fetch it');
    utils.unmount();
  });
});
