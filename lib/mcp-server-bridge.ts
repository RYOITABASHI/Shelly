/**
 * lib/mcp-server-bridge.ts — RN-side half of the MCP server's file-queue IPC.
 *
 * scripts/shelly-mcp-server.js runs as a separate Node process (spawned by
 * MCPBridge.kt) and can't reach RN's JS state directly, so it writes a
 * tool-call request file to $HOME/.shelly-mcp-queue/requests/<callId>.json
 * and polls for .../results/<callId>.json — the same file-queue IPC
 * pattern as lib/a2a-bridge.ts (see that file's header for the fuller
 * rationale; this is a near-duplicate poller, just dispatching to MCP
 * tools instead of A2A skills).
 *
 * Every tool here is deliberately READ-ONLY and scoped to data the user
 * already exposed through Shelly's own UI (registered agents, Sidebar
 * repo paths, terminal session transcripts) — see
 * scripts/shelly-mcp-server.js's header for why exec/write tools aren't
 * implemented yet.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { useAgentStore } from '@/store/agent-store';
import { useSidebarStore } from '@/store/sidebar-store';
import { useTerminalStore } from '@/store/terminal-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import { logError, logInfo } from '@/lib/debug-logger';

const QUEUE_DIR = `${FileSystem.documentDirectory}home/.shelly-mcp-queue`;
const REQUESTS_DIR = `${QUEUE_DIR}/requests`;
const RESULTS_DIR = `${QUEUE_DIR}/results`;
const POLL_INTERVAL_MS = 500;

type MCPToolRequest = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
};

function isMCPToolRequest(value: unknown): value is MCPToolRequest {
  const v = value as MCPToolRequest;
  return !!v && typeof v === 'object' && typeof v.callId === 'string' && typeof v.tool === 'string';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (tool) {
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
    case 'list_repos': {
      return { ok: true, data: useSidebarStore.getState().repoPaths };
    }
    case 'read_terminal_output': {
      const sessionId = typeof args.sessionId === 'string' && args.sessionId
        ? args.sessionId
        : useTerminalStore.getState().activeSessionId;
      const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 200;
      try {
        const text = await TerminalEmulator.getTranscriptText(sessionId, maxLines);
        return { ok: true, data: text };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'git_status': {
      const targetPath = typeof args.path === 'string' ? args.path : '';
      const configured = useSidebarStore.getState().repoPaths;
      // Scoped to repos the user already added in the Sidebar — a remote
      // MCP client can't probe arbitrary filesystem paths through this
      // tool, only ones the user chose to expose through Shelly's own UI.
      if (!configured.includes(targetPath)) {
        return { ok: false, error: 'path is not a Shelly-configured repo (see list_repos)' };
      }
      try {
        const result = await execCommand(`cd ${shellQuote(targetPath)} && git status`, 10_000);
        if (result.exitCode !== 0) {
          return { ok: false, error: result.stderr || `git exited ${result.exitCode}` };
        }
        return { ok: true, data: result.stdout };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      return { ok: false, error: `unknown tool: ${tool}` };
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
      if (!isMCPToolRequest(parsed)) {
        logError('MCPBridge', `rejected malformed request file ${name}`);
        await FileSystem.deleteAsync(requestUri, { idempotent: true });
        continue;
      }
      const result = await callTool(parsed.tool, parsed.args ?? {});
      const resultUri = `${RESULTS_DIR}/${parsed.callId}.json`;
      await FileSystem.writeAsStringAsync(resultUri, JSON.stringify(result));
      logInfo('MCPBridge', `answered call ${parsed.callId} (tool=${parsed.tool}, ok=${result.ok})`);
    } catch (e) {
      logError('MCPBridge', `failed to process request file ${name}`, e);
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
    logError('MCPBridge', 'poll iteration failed', e);
  }
  if (!stopped) {
    pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

export function startMCPPoller(): void {
  if (!stopped) return;
  stopped = false;
  void pollLoop();
}

export function stopMCPPoller(): void {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
