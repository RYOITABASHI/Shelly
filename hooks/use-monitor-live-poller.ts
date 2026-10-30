/**
 * hooks/use-monitor-live-poller.ts — keeps agent-store `liveRuns` fresh while
 * a MONITOR pane is mounted and the app is in the foreground.
 *
 * Cadence: POLL_ACTIVE_MS while any run is going, POLL_IDLE_MS otherwise.
 * Polls never overlap (the next one is scheduled after the previous exec
 * settles) and the exec is async, so the UI thread is never blocked. Several
 * mounted MONITOR panes share one poll loop (ref-counted).
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useAgentStore } from '@/store/agent-store';
import { logInfo } from '@/lib/debug-logger';
import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  createPollMemo,
  pollLiveRunsOnce,
  type PollExec,
  type PollState,
  type PollStore,
} from '@/lib/monitor-live-poll';

const exec: PollExec = (command, timeoutMs) => TerminalEmulator.execCommand(command, timeoutMs);

const getState = (): PollState => {
  const s = useAgentStore.getState();
  return { agents: s.agents, runningAgentIds: s.runningAgentIds, liveRuns: s.liveRuns };
};

const store: PollStore = {
  upsertLiveRuns: (id, runs) => useAgentStore.getState().upsertLiveRuns(id, runs),
  setLiveRunSavedPath: (id, runId, p) => useAgentStore.getState().setLiveRunSavedPath(id, runId, p),
  getLiveRuns: () => useAgentStore.getState().liveRuns,
  setLiveLoop: (id, view) => useAgentStore.getState().setLiveLoop(id, view),
};

let mounted = 0;
let stopLoop: (() => void) | null = null;

function startLoop(): () => void {
  const memo = createPollMemo();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let foreground = AppState.currentState === 'active' || AppState.currentState == null;

  const schedule = (ms: number) => {
    if (stopped || !foreground) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  async function tick() {
    timer = null;
    if (stopped || !foreground || running) return;
    running = true;
    let active = false;
    try {
      active = await pollLiveRunsOnce(exec, memo, getState, store);
    } finally {
      running = false;
    }
    schedule(active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
    const wasForeground = foreground;
    foreground = next === 'active';
    if (!foreground && timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (foreground && !wasForeground) schedule(0);
  });
  logInfo('Monitor', 'live poller started');
  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    sub.remove();
    logInfo('Monitor', 'live poller stopped');
  };
}

export function useMonitorLivePoller(): void {
  useEffect(() => {
    mounted += 1;
    if (mounted === 1) stopLoop = startLoop();
    return () => {
      mounted -= 1;
      if (mounted === 0 && stopLoop) {
        stopLoop();
        stopLoop = null;
      }
    };
  }, []);
}
