const mockServiceControl = jest.fn();
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  serviceControl: (...a: unknown[]) => mockServiceControl(...a),
} }));
jest.mock('@/store/agent-store', () => require('./helpers/mcp-typed-ops-harness').agentStoreMock);
jest.mock('@/store/settings-store', () => require('./helpers/mcp-typed-ops-harness').settingsStoreMock);
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/lib/agent-user-policy-store', () => require('./helpers/mcp-typed-ops-harness').policyStoreMock);
jest.mock('@/lib/debug-logger', () => require('./helpers/mcp-typed-ops-harness').loggerMock);
jest.mock('@/lib/secure-store', () => ({ getConnectorSecret: async () => 'dummy-token' }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) }));
jest.mock('react-native', () => require('./helpers/mcp-typed-ops-harness').reactNativeMock);
jest.mock('@/lib/i18n', () => ({ t: (k: string, p?: Record<string, string>) => (p ? `${k}:${p.action}:${p.service}` : k), tFor: (_l: string, k: string) => k }));

import {
  __setMCPRequestSha256ForTests, revokePendingMCPRequests, setMCPBridgeKey,
  startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { execCommand } from '@/hooks/use-native-exec';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

const tool = 'service_control';
const current = () => useMcpApprovalStore.getState().current;
const exec = jest.mocked(execCommand);

const nativeStatus = (over: Record<string, unknown> = {}) => ({
  code: 'status', serviceId: 'article-delivery', state: 'running', pid: 6293,
  startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true, exitCode: null, exitedAt: null,
  ...over,
});

beforeEach(() => {
  resetHarness();
  h.settings.mcpExecEnabled = true;
  mockServiceControl.mockReset();
  exec.mockClear();
  __setMCPRequestSha256ForTests(nodeSha256);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  startMCPPoller();
});

afterEach(() => {
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
  __setMCPRequestSha256ForTests(null);
});

function audits() {
  return h.audits.map(({ agentId, json }) => {
    expect(agentId).toBeNull();
    expect(json).toMatchObject({ kind: 'mcp_service_control', event: 'mcp_service_control', principal: TEST_PRINCIPAL });
    return [json.code, json.action ?? null, json.serviceId ?? null];
  });
}

async function approve(args: Record<string, unknown>, decision: 'once' | 'deny' = 'once') {
  const pending = callTool(tool, args);
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: tool, summary: 'mcp.approval_service_control' });
  expect(current()?.detail).toBe(`mcp.approval_service_control_detail:${args.action}:${args.serviceId}`);
  expect(current()?.alwaysAllowable).toBeUndefined();
  expect(mockServiceControl).not.toHaveBeenCalled();
  useMcpApprovalStore.getState().respond(current()!.id, decision);
  return pending;
}

it('refuses when exec/write is disabled', async () => {
  h.settings.mcpExecEnabled = false;
  expect(await callTool(tool, { action: 'status', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'disabled' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['disabled', 'status', 'article-delivery']]);
});

it.each([
  [{ action: 'start' }],
  [{ action: 'restart', serviceId: 'article-delivery' }],
  [{ action: 'start', serviceId: 'article-delivery', command: 'node evil.js' }],
  [{ action: 'start', serviceId: '../../bin/sh' }],
])('refuses %j before asking, and audits no unchecked field', async (args) => {
  expect(await callTool(tool, args)).toMatchObject({ ok: false, code: 'invalid_params' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['invalid_params', null, null]]);
});

it('refuses a start under STOP-ALL without asking', async () => {
  h.halted = true;
  expect(await callTool(tool, { action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'halted' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['halted', 'start', 'article-delivery']]);
});

it('still lets status and stop through under STOP-ALL (after the tap)', async () => {
  h.halted = true;
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'not_running', state: 'stopped', pid: null, startedAt: null, supervised: false }));
  expect(await approve({ action: 'stop', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'not_running', state: 'stopped' } });
  expect(mockServiceControl).toHaveBeenCalledWith('stop', 'article-delivery', TEST_PRINCIPAL);
});

it('honors a denial without calling native', async () => {
  expect(await approve({ action: 'start', serviceId: 'article-delivery' }, 'deny')).toMatchObject({ ok: false, code: 'denied' });
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery'], ['denied', 'start', 'article-delivery']]);
});

it('drops an expired request without asking', async () => {
  expect(await callTool(tool, { action: 'start', serviceId: 'article-delivery' }, { receivedAt: new Date(Date.now() - 101_000).toISOString() }))
    .toMatchObject({ ok: false, code: 'timeout' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
});

it('revokes during approval without calling native', async () => {
  const pending = callTool(tool, { action: 'start', serviceId: 'article-delivery' });
  await waitFor(() => current() !== null);
  await revokePendingMCPRequests();
  expect(await pending).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
});

it('returns status after the tap and audits it', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus());
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toEqual({
    ok: true,
    data: {
      action: 'status', code: 'status', serviceId: 'article-delivery', state: 'running', pid: 6293,
      startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true,
    },
  });
  expect(mockServiceControl).toHaveBeenCalledWith('status', 'article-delivery', TEST_PRINCIPAL);
  expect(audits()).toEqual([['approval_requested', 'status', 'article-delivery'], ['status', 'status', 'article-delivery']]);
});

it('reports a dead service through status', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ state: 'dead', pid: null, supervised: false, exitCode: 137, exitedAt: 1_764_000_300_000 }));
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toMatchObject({
    ok: true, data: { state: 'dead', pid: null, exitCode: 137, exitedAt: 1_764_000_300_000 },
  });
});

it('leaves the start outcome line to native', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'started', state: 'starting', lastHeartbeatAt: null }));
  expect(await approve({ action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'started', state: 'starting' } });
  expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery']]);
  expect(exec).not.toHaveBeenCalled();
});

it('returns already_running as success (idempotent start)', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'already_running', supervised: false }));
  expect(await approve({ action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'already_running', pid: 6293 } });
});

it('returns a native failure as an error that carries the status', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'launch_failed', state: 'dead', pid: null, exitCode: 127 }));
  const r = await approve({ action: 'start', serviceId: 'article-delivery' });
  expect(r).toMatchObject({ ok: false, code: 'launch_failed' });
  expect((r as { error: string }).error).toContain('"state":"dead"');
});

it('answers not_configured for the shape-only facade entry', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'not_configured', serviceId: 'council-facade', state: 'not_configured', pid: null, startedAt: null, lastHeartbeatAt: null, supervised: false }));
  expect(await approve({ action: 'start', serviceId: 'council-facade' })).toMatchObject({ ok: false, code: 'not_configured' });
});

it('refuses a malformed native answer', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ serviceId: 'council-facade' }));
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'native_error' });
  expect(audits().at(-1)).toEqual(['native_error', 'status', 'article-delivery']);
});

it('maps a native exception to native_error', async () => {
  mockServiceControl.mockRejectedValueOnce(new Error('boom'));
  expect(await approve({ action: 'stop', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'native_error' });
});
