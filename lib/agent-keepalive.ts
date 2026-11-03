/**
 * lib/agent-keepalive.ts — keep attended-run work going while backgrounded.
 *
 * RN's JS timers run on Choreographer frame callbacks, and Samsung stops
 * those for background apps ("SYSPERF_ACTIVE_APP_BBA_ENABLE : stop animation
 * in background states") — a headless JS task does not help. The run itself
 * keeps going natively under the foreground service, but everything RN does
 * for it on a timer stopped with the app: the 500ms escalation drain in
 * app/_layout.tsx that answers "run without approval" asks and posts approval
 * notifications, and the run-log waiter. A Codex step that asked to run
 * `node --check` therefore sat unanswered until the driver's 5-minute turn
 * timeout (2026-11-03, builds 2812 / 2814).
 *
 * The JS thread itself keeps running, so while any user run is registered
 * (agent-run-origin-registry) a native thread emits "onAgentKeepAliveTick"
 * every second; subscribers run their timer work from it, and keepAliveDelay
 * resolves from it when its timer cannot fire.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { hasActiveUserRun } from './agent-run-origin-registry';
import { logInfo, logWarn } from './debug-logger';

/** Above the longest attended wait (native 30 min executor cap + slack). */
const KEEPALIVE_MAX_MS = 45 * 60_000;

type Tick = () => void;
const tickListeners = new Set<Tick>();
let tickerActive = false;
let subscription: { remove(): void } | null = null;

function onTick(): void {
  if (!hasActiveUserRun()) {
    stopTicker();
    return;
  }
  for (const listener of tickListeners) {
    try {
      listener();
    } catch (e) {
      logWarn('AgentKeepAlive', 'tick listener failed', e);
    }
  }
}

function stopTicker(): void {
  if (!tickerActive) return;
  tickerActive = false;
  subscription?.remove();
  subscription = null;
  TerminalEmulator.stopAgentKeepAlive?.().catch(() => undefined);
  logInfo('AgentKeepAlive', 'stopped');
}

/** Call right after markUserRunStarted. No-op while the ticker is running. */
export function ensureAgentKeepAlive(): void {
  if (tickerActive || !TerminalEmulator.startAgentKeepAlive || !TerminalEmulator.addListener) return;
  tickerActive = true;
  subscription = TerminalEmulator.addListener('onAgentKeepAliveTick', onTick);
  TerminalEmulator.startAgentKeepAlive(KEEPALIVE_MAX_MS)
    .then(() => logInfo('AgentKeepAlive', 'started'))
    .catch((e) => {
      logWarn('AgentKeepAlive', 'could not start keep-alive ticker', e);
      tickerActive = true;
      stopTicker();
    });
}

/** Runs `listener` on every tick while an attended run is in flight. */
export function onAgentKeepAliveTick(listener: Tick): () => void {
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
  };
}

/** setTimeout that also resolves from a keep-alive tick once `ms` passed
 *  (a backgrounded app's timers do not fire). */
export function keepAliveDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const due = Date.now() + ms;
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    unsubscribe = onAgentKeepAliveTick(() => {
      if (Date.now() >= due) finish();
    });
  });
}
