/**
 * lib/agent-keepalive.ts — keep RN timers alive during an attended run.
 *
 * RN pauses JS timers when the app is backgrounded (phone folded, another app
 * in front). The run itself keeps going natively under the foreground
 * service, but everything RN does for it on a timer stops with the app: the
 * 500ms escalation drain in app/_layout.tsx that answers "run without
 * approval" asks and posts approval notifications, and the run-log waiter.
 * A Codex step that asked to run `node --check` therefore sat unanswered
 * until the driver's 5-minute turn timeout (2026-11-03, build 2812).
 *
 * A headless JS task keeps RN's timers running (JavaTimerManager does not
 * pause while a task is active). One task covers every concurrent user run;
 * it ends as soon as no run is registered in agent-run-origin-registry.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { hasActiveUserRun } from './agent-run-origin-registry';
import { logInfo, logWarn } from './debug-logger';

export const AGENT_KEEPALIVE_TASK = 'ShellyAgentKeepAlive';
/** Above the longest attended wait (native 30 min executor cap + slack). */
const KEEPALIVE_MAX_MS = 45 * 60_000;
const CHECK_MS = 2_000;

let taskActive = false;
let registered = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function registerAgentKeepAliveTask(): void {
  if (registered) return;
  registered = true;
  // Required lazily so agent-manager's unit tests never load react-native.
  const { AppRegistry } = require('react-native') as typeof import('react-native');
  AppRegistry.registerHeadlessTask(AGENT_KEEPALIVE_TASK, () => async () => {
    const startedAt = Date.now();
    try {
      while (hasActiveUserRun() && Date.now() - startedAt < KEEPALIVE_MAX_MS) {
        await sleep(CHECK_MS);
      }
    } finally {
      taskActive = false;
      logInfo('AgentKeepAlive', `ended after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
  });
}

/** Call right after markUserRunStarted. No-op while a task is already running. */
export function ensureAgentKeepAlive(): void {
  if (taskActive || !registered || !TerminalEmulator.startAgentKeepAlive) return;
  taskActive = true;
  TerminalEmulator.startAgentKeepAlive(KEEPALIVE_MAX_MS + 60_000)
    .then((taskId) => logInfo('AgentKeepAlive', `started task=${taskId}`))
    .catch((e) => {
      taskActive = false;
      logWarn('AgentKeepAlive', 'could not start keep-alive task', e);
    });
}
