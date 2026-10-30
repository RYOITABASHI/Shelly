/**
 * hooks/use-monitor-live-poller.ts — one shared poll loop while MONITOR panes
 * are mounted: ref-counted, never overlapping, paused in the background and
 * resumed at once on return, nothing scheduled after the last unmount.
 */
import { renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '' })) },
}));

type Resolver = (active: boolean) => void;
const pending: Resolver[] = [];
const mockPoll = jest.fn(
  () =>
    new Promise<boolean>((resolve) => {
      pending.push(resolve);
    }),
);
jest.mock('@/lib/monitor-live-poll', () => ({
  ...jest.requireActual('@/lib/monitor-live-poll'),
  pollLiveRunsOnce: (...args: unknown[]) => mockPoll(...(args as [])),
}));

import { useMonitorLivePoller } from '@/hooks/use-monitor-live-poller';
import { POLL_ACTIVE_MS, POLL_IDLE_MS } from '@/lib/monitor-live-poll';

let appStateHandler: ((s: AppStateStatus) => void) | null = null;
let addCount = 0;
const removeSub = jest.fn();

/** Let the awaited poll promise settle and the follow-up schedule run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const settle = async (active: boolean) => {
  const r = pending.shift();
  if (!r) throw new Error('no poll in flight');
  r(active);
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockPoll.mockClear();
  pending.length = 0;
  removeSub.mockClear();
  appStateHandler = null;
  addCount = 0;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, h: (s: AppStateStatus) => void) => {
    appStateHandler = h;
    addCount += 1;
    return { remove: removeSub };
  }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useMonitorLivePoller', () => {
  it('polls at once, then at the active / idle cadence, never overlapping', async () => {
    const hook = renderHook(() => useMonitorLivePoller());
    jest.advanceTimersByTime(0);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    // still in flight: time passing must not start a second poll
    jest.advanceTimersByTime(POLL_IDLE_MS * 3);
    expect(mockPoll).toHaveBeenCalledTimes(1);

    await settle(true);
    jest.advanceTimersByTime(POLL_ACTIVE_MS - 1);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockPoll).toHaveBeenCalledTimes(2);

    await settle(false);
    jest.advanceTimersByTime(POLL_ACTIVE_MS);
    expect(mockPoll).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(POLL_IDLE_MS - POLL_ACTIVE_MS);
    expect(mockPoll).toHaveBeenCalledTimes(3);
    hook.unmount();
    await settle(false);
  });

  it('shares one loop between mounted panes (ref-counted)', async () => {
    const a = renderHook(() => useMonitorLivePoller());
    const b = renderHook(() => useMonitorLivePoller());
    jest.advanceTimersByTime(0);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    // One live loop = one live AppState subscription (the renderer may
    // mount/unmount effects once more in strict mode; count what is alive).
    const live = () => addCount - removeSub.mock.calls.length;
    expect(live()).toBe(1);
    a.unmount();
    expect(live()).toBe(1);
    await settle(false);
    jest.advanceTimersByTime(POLL_IDLE_MS);
    expect(mockPoll).toHaveBeenCalledTimes(2); // b still mounted
    b.unmount();
    expect(live()).toBe(0);
    await settle(false);
  });

  it('stops in the background and polls immediately on return', async () => {
    const hook = renderHook(() => useMonitorLivePoller());
    jest.advanceTimersByTime(0);
    await settle(false);
    appStateHandler?.('background');
    jest.advanceTimersByTime(POLL_IDLE_MS * 4);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    appStateHandler?.('active');
    jest.advanceTimersByTime(0);
    expect(mockPoll).toHaveBeenCalledTimes(2);
    hook.unmount();
    await settle(false);
  });

  it('a poll finishing after backgrounding does not reschedule', async () => {
    const hook = renderHook(() => useMonitorLivePoller());
    jest.advanceTimersByTime(0);
    appStateHandler?.('background');
    await settle(true);
    jest.advanceTimersByTime(POLL_IDLE_MS * 4);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('schedules nothing after the last unmount, even if a poll was in flight', async () => {
    const hook = renderHook(() => useMonitorLivePoller());
    jest.advanceTimersByTime(0);
    hook.unmount();
    await settle(true);
    jest.advanceTimersByTime(POLL_IDLE_MS * 4);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(removeSub.mock.calls.length).toBe(addCount);
  });
});
