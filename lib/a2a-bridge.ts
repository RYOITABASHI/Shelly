/**
 * lib/a2a-bridge.ts — RN-side half of the A2A (Agent2Agent) protocol
 * server's file-queue IPC.
 *
 * scripts/shelly-a2a-server.js runs as a separate Node process (spawned by
 * A2ABridge.kt) and can't reach RN's JS state (store/agent-store.ts, where
 * the actual agent list lives) directly, so it writes a task request file
 * to $HOME/.shelly-a2a-queue/requests/<taskId>.json and polls for
 * $HOME/.shelly-a2a-queue/results/<taskId>.json — the same file-queue
 * pattern already used for the deep-link queue and the agent
 * action-approval bridges (see app/_layout.tsx's pollers for those), just
 * bidirectional here. This module is the poller that answers those
 * requests: read pending request files, run the requested skill, write the
 * result, delete the request.
 *
 * Only one skill exists right now — list_agents, read-only — see
 * scripts/shelly-a2a-server.js's own header for why triggering a run via
 * A2A isn't implemented yet.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { useAgentStore } from '@/store/agent-store';
import { logError, logInfo } from '@/lib/debug-logger';

const QUEUE_DIR = `${FileSystem.documentDirectory}home/.shelly-a2a-queue`;
const REQUESTS_DIR = `${QUEUE_DIR}/requests`;
const RESULTS_DIR = `${QUEUE_DIR}/results`;
const POLL_INTERVAL_MS = 500;

type A2ATaskRequest = {
  taskId: string;
  skillId: string;
  receivedAt?: string;
};

function isA2ATaskRequest(value: unknown): value is A2ATaskRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as A2ATaskRequest).taskId === 'string' &&
    typeof (value as A2ATaskRequest).skillId === 'string'
  );
}

async function runSkill(skillId: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  switch (skillId) {
    case 'list_agents': {
      const agents = useAgentStore.getState().agents.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        schedule: a.schedule ?? null,
        autonomous: a.autonomous,
      }));
      return { ok: true, data: agents };
    }
    default:
      return { ok: false, error: `unknown skill: ${skillId}` };
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

async function drainOnce(): Promise<void> {
  const names = await FileSystem.readDirectoryAsync(REQUESTS_DIR).catch(() => null);
  if (!names || names.length === 0) return;

  await FileSystem.makeDirectoryAsync(RESULTS_DIR, { intermediates: true }).catch(() => {});

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const requestUri = `${REQUESTS_DIR}/${name}`;
    try {
      const raw = await FileSystem.readAsStringAsync(requestUri);
      const parsed: unknown = JSON.parse(raw);
      if (!isA2ATaskRequest(parsed)) {
        logError('A2ABridge', `rejected malformed request file ${name}`);
        await FileSystem.deleteAsync(requestUri, { idempotent: true });
        continue;
      }
      const result = await runSkill(parsed.skillId);
      const resultUri = `${RESULTS_DIR}/${parsed.taskId}.json`;
      await FileSystem.writeAsStringAsync(resultUri, JSON.stringify(result));
      logInfo('A2ABridge', `answered task ${parsed.taskId} (skill=${parsed.skillId}, ok=${result.ok})`);
    } catch (e) {
      logError('A2ABridge', `failed to process request file ${name}`, e);
    } finally {
      await FileSystem.deleteAsync(requestUri, { idempotent: true });
    }
  }
}

async function pollLoop(): Promise<void> {
  if (stopped) return;
  try {
    await drainOnce();
  } catch (e) {
    logError('A2ABridge', 'poll iteration failed', e);
  }
  if (!stopped) {
    pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

/** Starts the request-queue poller. Idempotent — a second call while
 *  already running is a no-op. Does NOT start the native A2A server itself
 *  (TerminalEmulator.startA2AServer) — callers wire both together, see
 *  app/_layout.tsx's settings.a2aServerEnabled effect. */
export function startA2APoller(): void {
  if (!stopped) return;
  stopped = false;
  void pollLoop();
}

export function stopA2APoller(): void {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
