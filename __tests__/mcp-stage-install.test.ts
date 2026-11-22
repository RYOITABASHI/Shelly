jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  stageInstallGeneration: jest.fn(() => 0), invalidateStageInstalls: jest.fn(),
  resolveStageInstallPath: jest.fn(), stageInstallApk: jest.fn(), getStageInstallResult: jest.fn(),
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
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k, tFor: (_l: string, k: string) => k }));

import {
  __setMCPRequestSha256ForTests, __setStageInstallWaitForTests,
  revokePendingMCPRequests, setMCPBridgeKey, startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY } from './helpers/mcp-signed-request';
import { callTool, h, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

const path = '/storage/emulated/0/Download/test.APK';
const approvedSha256 = 'b'.repeat(64);
const install = { sessionId: 42, packageName: 'dev.test', versionCode: 7 };
const resolvePath = jest.mocked(TerminalEmulator.resolveStageInstallPath);
const stage = jest.mocked(TerminalEmulator.stageInstallApk);
const result = jest.mocked(TerminalEmulator.getStageInstallResult);
const current = () => useMcpApprovalStore.getState().current;

beforeEach(() => {
  resetHarness();
  h.settings.mcpExecEnabled = true;
  resolvePath.mockReset().mockResolvedValue({ path, sha256: approvedSha256 });
  stage.mockReset().mockResolvedValue(install);
  result.mockReset();
  __setMCPRequestSha256ForTests(nodeSha256);
  __setStageInstallWaitForTests(30);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  startMCPPoller();
});

afterEach(() => {
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
  __setStageInstallWaitForTests(null);
  __setMCPRequestSha256ForTests(null);
});

async function approve(args: { path: string; expectedSha256?: string } = { path }, decision: 'once' | 'deny' = 'once') {
  const pending = callTool('stage_install', args);
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: 'stage_install', detail: path });
  expect(current()?.alwaysAllowable).toBeUndefined();
  useMcpApprovalStore.getState().respond(current()!.id, decision);
  return pending;
}

it('refuses while exec/write is disabled', async () => {
  h.settings.mcpExecEnabled = false;
  expect(await callTool('stage_install', { path })).toMatchObject({ ok: false, error: expect.stringContaining('disabled') });
  expect(resolvePath).not.toHaveBeenCalled();
  expect(current()).toBeNull();
});

it.each(['/storage/emulated/0/Download/../Download/test.apk', '/storage/emulated/0/Download/test.zip', 'test.apk'])(
  'refuses invalid path %s before approval', async (invalid) => {
    expect(await callTool('stage_install', { path: invalid })).toMatchObject({ ok: false });
    expect(resolvePath).not.toHaveBeenCalled();
    expect(current()).toBeNull();
    expect(stage).not.toHaveBeenCalled();
  },
);

it('refuses an APK outside the canonical roots before approval', async () => {
  resolvePath.mockResolvedValue({ error: 'APK path is outside the allowed directories' });
  expect(await callTool('stage_install', { path: '/data/user/0/other/files/test.apk' }))
    .toEqual({ ok: false, error: 'APK path is outside the allowed directories' });
  expect(current()).toBeNull();
  expect(stage).not.toHaveBeenCalled();
});

it.each(['native resolution', 'approval audit'] as const)(
  'returns structured timeout when the pre-approval deadline elapses during %s', async (step) => {
    let deadline: number;
    const clock = jest.spyOn(Date, 'now');
    const appendAudit = TerminalEmulator.appendMcpIngressAudit!;
    const audit = jest.spyOn(TerminalEmulator, 'appendMcpIngressAudit');
    resolvePath.mockImplementation(async (_path, approvalDeadline) => {
      deadline = approvalDeadline;
      if (step === 'native resolution') clock.mockReturnValue(deadline);
      return { path, sha256: approvedSha256 };
    });
    audit.mockImplementation(async (agentId, json) => {
      const written = await appendAudit(agentId, json);
      if (step === 'approval audit' && JSON.parse(json).code === 'approval_requested') {
        clock.mockReturnValue(deadline);
      }
      return written;
    });
    try {
      expect(await callTool('stage_install', { path })).toEqual({ ok: true, data: { status: 'timeout' } });
      expect(current()).toBeNull();
      expect(stage).not.toHaveBeenCalled();
      expect(h.audits.map(({ json }) => json.code))
        .toEqual(step === 'approval audit' ? ['approval_requested', 'timeout'] : ['timeout']);
    } finally {
      audit.mockRestore();
      clock.mockRestore();
    }
  },
);

it('asks even when approval omission is enabled and honors denial', async () => {
  h.settings.approveAllWithoutAsking = true;
  h.settings.mcpSkipApproval = true;
  expect(await approve({ path }, 'deny')).toMatchObject({ ok: false, error: expect.stringContaining('denied') });
  expect(stage).not.toHaveBeenCalled();
});

it('refuses a late tap if JS did not run the approval timer in time', async () => {
  const pending = callTool('stage_install', { path });
  await waitFor(() => current() !== null);
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 91_000);
  try {
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('denied') });
    expect(stage).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it('returns a native digest mismatch without polling a session', async () => {
  const expectedSha256 = 'a'.repeat(64);
  stage.mockResolvedValue({ error: 'APK SHA-256 mismatch' });
  expect(await approve({ path, expectedSha256 })).toEqual({ ok: false, error: 'APK SHA-256 mismatch' });
  expect(stage).toHaveBeenCalledWith(path, approvedSha256, expectedSha256, expect.any(Number), 0);
  expect(result).not.toHaveBeenCalled();
});

it.each([
  [{ status: 'success', at: 1 }, { status: 'success' }],
  [{ status: 'user_action_required', at: 1 }, { status: 'user_action_required' }],
  [{ status: 'failure', statusCode: 7, message: 'Storage full', at: 1 }, { status: 'failure', statusCode: 7, message: 'Storage full' }],
  [{ status: 'pending' }, { status: 'timeout' }],
] as const)('maps native %j to %j', async (native, mapped) => {
  result.mockImplementation(async (_id, waitMs = 0) => {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return native;
  });
  expect(await approve()).toEqual({ ok: true, data: { ...install, ...mapped } });
  expect(result).toHaveBeenCalledWith(install.sessionId, 0);
  expect(h.audits).toEqual(expect.arrayContaining([
    expect.objectContaining({ json: expect.objectContaining({ event: 'mcp_stage_install', code: mapped.status }) }),
  ]));
});

it('keeps polling after the confirmation request and returns the final outcome', async () => {
  result.mockResolvedValueOnce({ status: 'user_action_required', at: 1 })
    .mockResolvedValueOnce({ status: 'success', at: 2 });
  expect(await approve()).toEqual({ ok: true, data: { ...install, status: 'success' } });
  expect(result).toHaveBeenCalledTimes(2);
});

it('returns success with only the session ID when native omits APK metadata', async () => {
  stage.mockResolvedValue({ sessionId: install.sessionId });
  result.mockResolvedValue({ status: 'success', at: 1 });
  expect(await approve()).toEqual({ ok: true, data: { sessionId: install.sessionId, status: 'success' } });
});

it('rejects bytes changed during approval without a caller-supplied digest', async () => {
  let onDisk = approvedSha256;
  resolvePath.mockImplementation(async () => ({ path, sha256: onDisk }));
  stage.mockImplementation(async (_path, digest) => digest === approvedSha256 && onDisk !== approvedSha256
    ? { error: 'APK changed while waiting for approval', code: 'digest_changed' }
    : install);
  const pending = callTool('stage_install', { path });
  await waitFor(() => current() !== null);
  onDisk = 'c'.repeat(64);
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: false, code: 'digest_changed' });
  expect(result).not.toHaveBeenCalled();
});

it('invalidates the native generation synchronously while staging is in progress', async () => {
  const invalidate = jest.mocked(TerminalEmulator.invalidateStageInstalls!);
  let generation = 0;
  invalidate.mockImplementation(() => { generation += 1; });
  let finishCopy!: () => void;
  const copy = new Promise<void>((resolve) => { finishCopy = resolve; });
  const commit = jest.fn();
  stage.mockImplementation(async (_path, _digest, _expected, _deadline, requestGeneration) => {
    await copy;
    if (requestGeneration !== generation) return { error: 'revoked', code: 'revoked' };
    commit();
    return install;
  });
  const pending = approve();
  await waitFor(() => stage.mock.calls.length === 1);
  const revoke = revokePendingMCPRequests();
  const generationAtRevoke = generation;
  finishCopy();
  await revoke;
  expect(await pending).toBeNull();
  expect(generationAtRevoke).toBe(1);
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  expect(commit).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});

it('returns structured timeout when native staging hits its deadline', async () => {
  stage.mockResolvedValue({ error: 'timed out staging APK', code: 'timeout' });
  expect(await approve()).toEqual({ ok: true, data: { status: 'timeout' } });
  expect(result).not.toHaveBeenCalled();
});

it('redacts secrets in a native pre-commit error', async () => {
  stage.mockResolvedValue({ error: 'could not stage APK: token=private-value' });
  expect(await approve()).toMatchObject({ ok: false, error: 'could not stage APK: token=<redacted>' });
});
