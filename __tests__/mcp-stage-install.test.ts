jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  stageInstallGeneration: jest.fn(() => 0), invalidateStageInstalls: jest.fn(),
  resolveStageInstallPath: jest.fn(), stageInstallApk: jest.fn(), getStageInstallResult: jest.fn(),
  getLastStageInstallResult: jest.fn(),
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

import { createHash, createHmac } from 'node:crypto';
import {
  __setMCPRequestSha256ForTests, __setMCPSnapshotSha256ForTests, __setStageInstallWaitForTests,
  revokePendingMCPRequests, setMCPBridgeKey, startMCPPoller, startMCPSnapshotPublisher,
  stopMCPPoller, stopMCPSnapshotPublisher,
} from '@/lib/mcp-server-bridge';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, HANDOFFS, REQUESTS, resetHarness, RESULTS, waitFor } from './helpers/mcp-typed-ops-harness';

const path = '/storage/emulated/0/Download/test.APK';
const approvedSha256 = 'b'.repeat(64);
const install = { sessionId: 42, packageName: 'dev.test', versionCode: 7 };
const resolvePath = jest.mocked(TerminalEmulator.resolveStageInstallPath);
const stage = jest.mocked(TerminalEmulator.stageInstallApk);
const result = jest.mocked(TerminalEmulator.getStageInstallResult);
const lastResult = jest.mocked(TerminalEmulator.getLastStageInstallResult!);
const current = () => useMcpApprovalStore.getState().current;

beforeEach(() => {
  resetHarness();
  TerminalEmulator.getLastStageInstallResult = lastResult;
  h.settings.mcpExecEnabled = true;
  resolvePath.mockReset().mockResolvedValue({ path, sha256: approvedSha256 });
  stage.mockReset().mockResolvedValue(install);
  result.mockReset();
  lastResult.mockReset();
  jest.mocked(TerminalEmulator.invalidateStageInstalls!).mockReset().mockReturnValue(true);
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
  invalidate.mockImplementation(() => { generation += 1; return true; });
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

describe('stage_install_result', () => {
  const token = 'test-token';

  beforeEach(() => {
    __setMCPSnapshotSha256ForTests(nodeSha256);
    startMCPSnapshotPublisher(token);
  });

  afterEach(() => {
    stopMCPSnapshotPublisher();
    __setMCPSnapshotSha256ForTests(null);
  });

  async function readResult() {
    const envelope = await callTool('stage_install_result', {}) as unknown as { body: string; mac: string } | null;
    if (!envelope) throw new Error('missing stage_install_result envelope');
    const key = createHash('sha256').update(`shelly-mcp-snapshot:${token}`).digest();
    expect(envelope.mac).toBe(createHmac('sha256', key).update(envelope.body).digest('hex'));
    return JSON.parse(envelope.body);
  }

  it('reads the latest result after normal queue cleanup and audits its status', async () => {
    h.settings.mcpExecEnabled = false;
    await revokePendingMCPRequests();
    expect(TerminalEmulator.invalidateStageInstalls).toHaveBeenCalledWith(false);
    lastResult.mockResolvedValue({ status: 'failure', sessionId: 42, statusCode: 7, message: 'token=private-value', at: 1 });
    expect(await readResult()).toEqual({
      ok: true, data: { status: 'failure', sessionId: 42, statusCode: 7, message: 'token=<redacted>', at: 1 },
    });
    expect(lastResult).toHaveBeenCalledWith();
    expect(current()).toBeNull();
    expect(h.audits).toContainEqual(expect.objectContaining({
      json: {
        kind: 'mcp_stage_install_result', event: 'mcp_stage_install_result', principal: TEST_PRINCIPAL, code: 'failure',
      },
    }));
  });

  it('returns the session ID for a successful terminal outcome', async () => {
    lastResult.mockResolvedValue({ status: 'success', sessionId: 43, at: 2 });
    expect(await readResult()).toEqual({
      ok: true, data: { status: 'success', sessionId: 43, at: 2 },
    });
  });

  it('returns none when no result is recorded', async () => {
    lastResult.mockResolvedValue({ status: 'none' });
    expect(await readResult()).toEqual({ ok: true, data: { status: 'none' } });
  });

  it('returns a clean read error when the native getter is missing', async () => {
    TerminalEmulator.getLastStageInstallResult = undefined;
    expect(await readResult()).toEqual({
      ok: false, error: 'could not read the latest stage install result', code: 'read_failed',
    });
    expect(h.audits).toContainEqual(expect.objectContaining({
      json: expect.objectContaining({ event: 'mcp_stage_install_result', code: 'read_failed' }),
    }));
  });

  it.each(['current', 'failed commit', 'legacy', 'failing'] as const)(
    'drops the result on token revocation during a native read with the %s invalidator',
    async (binding) => {
      const invalidate = jest.mocked(TerminalEmulator.invalidateStageInstalls!);
      if (binding === 'current' || binding === 'failed commit') {
        invalidate.mockReturnValue(binding === 'current');
      } else {
        invalidate.mockImplementation((...args) => {
          if (args.length || binding === 'failing') throw new Error('native invalidation failed');
          return true;
        });
      }
      let finishRead!: (value: { status: 'success'; at: number }) => void;
      lastResult.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
      const pending = callTool('stage_install_result', {});
      await waitFor(() => lastResult.mock.calls.length === 1);
      const queueFiles = [REQUESTS, RESULTS, HANDOFFS].map((dir) => `${dir}/stale`);
      for (const file of queueFiles) h.files.set(file, 'stale');
      const revoke = revokePendingMCPRequests({ tokenRevoked: true });
      finishRead({ status: 'success', at: 1 });
      if (binding === 'current') {
        await expect(revoke).resolves.toBeUndefined();
      } else {
        await expect(revoke).rejects.toThrow(/stage install/);
      }
      expect(invalidate.mock.calls).toEqual(binding === 'legacy' || binding === 'failing' ? [[true], []] : [[true]]);
      for (const file of queueFiles) expect(h.files.has(file)).toBe(false);
      expect(await pending).toBeNull();
      await waitFor(() => h.audits.some(({ json }) => json.event === 'mcp_stage_install_result' && json.code === 'revoked'));
    },
  );
});

describe('native installer read-back fence', () => {
  const source = require('node:fs').readFileSync(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/StageInstall.kt',
    'utf8',
  ) as string;

  it('fences terminal updates before building the prefs editor and refuses fenced RN reads', () => {
    const record = source.slice(source.indexOf('fun record('), source.indexOf('class StageInstallReceiver'));
    expect(record).toMatch(/if \(updateLast && !writeFenceChecked\(prefs, dir, PoisonKind\.TERMINAL, sessionId, epoch, resultDigest\(value\)\)\)[\s\S]*?return@synchronized false[\s\S]*?prefs\.edit\(\)/);
    expect(source).toMatch(/fun lastResult[\s\S]*?synchronized\(commitLock\)[\s\S]*?check\([^\n]*!lastResultFenceMayExist/);
  });

  it('preserves the fence when poisoning and confirms a published mirror after directory sync', () => {
    const latch = source.slice(source.indexOf('private fun latchMirrorDivergence'), source.indexOf('private fun resolveMirrorDivergence'));
    expect(latch).toContain('poisonLastResultMirror(dir)');
    expect(latch).not.toContain('deletePoisonMarker');
    const write = source.slice(source.indexOf('private fun writeLastResultMirror'), source.indexOf('fun refreshLastResultMirror'));
    expect(write).toMatch(/dir\.publish\(MIRROR_TEMP_PREFIX, LAST_RESULT_MIRROR[\s\S]*?readRegularFile\(dir\.leaf\(LAST_RESULT_MIRROR\)[\s\S]*?opt\("body"\) == body[\s\S]*?opt\("mac"\) == mac[\s\S]*?McpAutostartStore\.readToken\(context\)[\s\S]*?TokenRead\.Present && current\.token == token/);
  });

  it('validates v2 marker content and atomically merges fences by operation kind', () => {
    const marker = source.slice(source.indexOf('private enum class PoisonKind'), source.indexOf('private fun latchMirrorDivergence'));
    expect(marker).toMatch(/kind == PoisonKind\.TERMINAL -> \{\s*val recordedTarget = \(existing as\? PoisonFence\.Terminal\)\?\.invalidateTarget\s*val target = when \{\s*recordedTarget == null -> invalidateTarget\s*invalidateTarget == null -> recordedTarget\s*else -> maxOf\(recordedTarget, invalidateTarget\)\s*\}\s*"v2:terminal:\$sessionId:\$epoch:\$digest:\$\{target \?: "-"\}"/);
    expect(marker).toContain('"v2:invalidate:$sessionId:$epoch:$digest"');
    expect(marker).toContain('"$body:${poisonChecksum(body)}"');
    expect(marker).toMatch(/fields\.size !in 6\.\.7 \|\| fields\[0\] != "v2"\) return PoisonFence\.Malformed/);
    expect(marker).toMatch(/sessionId < 0 \|\| fields\[2\] != sessionId\.toString\(\)\) return PoisonFence\.Malformed/);
    expect(marker).toMatch(/epoch < 0 \|\| fields\[3\] != epoch\.toString\(\)\) return PoisonFence\.Malformed/);
    expect(marker).toContain("digest.length == 16 && digest.all { it in '0'..'9' || it in 'a'..'f' }");
    expect(marker).toMatch(/"invalidate" -> if \(fields\.size == 6 && sessionId == 0 && digest == "-"\) \{\s*PoisonFence\.Invalidate\(epoch\)/);
    expect(marker).toMatch(/resultDigest\(value: String\): String = McpTokenFingerprintStore\.hash\(value\)\.take\(16\)/);
    expect(marker).toMatch(/getInstance\("SHA-256"\)[\s\S]*?take\(8\)/);
    expect(marker).toMatch(/val checksum = poisonChecksum\(content\.substringBeforeLast\(':'\)\)\s*if \(fields\.last\(\) != checksum\) return PoisonFence\.Malformed/);
    expect(marker).toMatch(/val targetField = if \(fields\.size == 7\) fields\[5\] else "-"/);
    expect(marker).toMatch(/if \(parsed < 0 \|\| targetField != parsed\.toString\(\)\) return PoisonFence\.Malformed/);
    expect(marker).toMatch(/existing == PoisonFence\.Malformed -> return@runCatching\s*kind == PoisonKind\.TERMINAL ->[\s\S]*?existing is PoisonFence\.Invalidate -> return@runCatching\s*existing is PoisonFence\.Terminal -> \{\s*val target = maxOf\(existing\.invalidateTarget \?: 0L, epoch\)\s*"v2:terminal:\$\{existing\.sessionId\}:\$\{existing\.epoch\}:\$\{existing\.digest\}:\$target"/);
    expect(marker).toMatch(/dir\.publish\(POISON_TEMP_PREFIX, POISON_MARKER/);
  });

  it('fences live mirrors before touching them and reconciles only compatible prefs', () => {
    const refresh = source.slice(source.indexOf('fun refreshLastResultMirror'), source.indexOf('private fun truncateMessage'));
    expect(refresh).not.toContain('!mirrorPoisonPending');
    expect(source).toContain('val written = dir != null && writePoisonMarker(dir, kind, sessionId, epoch, digest)');
    expect(source).toContain('failedFenceWrite = if (written) null else FailedFenceWrite(kind, sessionId, epoch, digest, prefsIdentity(prefs))');
    expect(refresh).toMatch(/val fencedForRefresh = fence == PoisonFence\.Absent && mirrorExists\(dir\)/);
    const fenceFirst = refresh.indexOf('if (fencedForRefresh && !writeFenceChecked(prefs, dir, PoisonKind.INVALIDATE, 0, epoch + 1L))');
    expect(fenceFirst).toBeGreaterThan(-1);
    for (const operation of ['writeLastResultMirror(', 'deleteLastResultMirror(']) {
      expect(refresh.indexOf(operation)).toBeGreaterThan(fenceFirst);
    }
    expect(refresh).toMatch(/failedFenceWrite\?\.let \{ failed ->\s*if \(failed\.snapshot != identity\) \{\s*failedFenceWrite = null\s*\} else if \(!writeFenceChecked\(prefs, dir, failed\.kind, failed\.sessionId, failed\.epoch, failed\.digest\)\) \{\s*return@synchronized false/);
    expect(refresh.indexOf('val fence =')).toBeGreaterThan(refresh.indexOf('failedFenceWrite?.let'));
    expect(refresh).toMatch(/val canPublish = fence != PoisonFence\.Absent \|\| failedFenceWrite == null\s*if \(canPublish && value != null && storedEpoch == epoch && token != null\) \{\s*if \(writeLastResultMirror/);
    expect(refresh).toMatch(/val target = fence\.invalidateTarget\s*if \(target != null\) \{\s*if \(epoch < target\) return@synchronized false\s*if \(value == null\) \{\s*return@synchronized deleteLastResultMirror\(dir\) && resolveMirrorDivergence\(dir\)/);
    expect(refresh).toMatch(/if \(fence == PoisonFence\.Malformed\) return@synchronized false/);
    expect(refresh).toMatch(/is PoisonFence\.Terminal ->[\s\S]*?value != sessionRecord[\s\S]*?return@synchronized false/);
    expect(refresh).toMatch(/is PoisonFence\.Invalidate -> \{\s*if \(epoch < fence\.targetEpoch \|\| value != null\) return@synchronized false/);
    expect(refresh).not.toMatch(/fence\.epoch < epoch && value == null/);
    expect(refresh).toMatch(/if \(value == null \|\| prefs\.getLong\(LAST_RESULT_EPOCH, -1L\) != fence\.epoch \|\|\s*resultDigest\(value\) != fence\.digest\s*\) return@synchronized false/);
    expect(refresh).toMatch(/if \(\(status != "success" && status != "failure"\) \|\|\s*record\.optInt\("sessionId", -1\) != fence\.sessionId\s*\) return@synchronized false/);
    expect(refresh).toMatch(/else if \(fence !is PoisonFence\.Terminal && deleteLastResultMirror\(dir\)\)/);
  });

  it('binds invalidate fences to the epoch advanced by a successful prefs commit', () => {
    const invalidate = source.slice(source.indexOf('fun invalidate('), source.indexOf('private fun checkPrefsCommit'));
    expect(invalidate).toMatch(/targetEpoch = prefs\.getLong\(REVOCATION_EPOCH, 0L\) \+ 1L\s*if \(!writeFenceChecked\(prefs, dir, PoisonKind\.INVALIDATE, 0, targetEpoch\)\) \{[\s\S]*?return@synchronized false\s*\}\s*checkNotNull\(dir\)\s*val cleared = prefs\.edit\(\)\s*\.putLong\(REVOCATION_EPOCH, targetEpoch\)\s*\.remove\(LAST_RESULT\)\.remove\(LAST_RESULT_EPOCH\)\.commit\(\)/);
    expect(invalidate).toMatch(/if \(!cleared\) \{[\s\S]*?return@synchronized false\s*\}\s*if \(deleteLastResultMirror\(dir\)\) return@synchronized resolveMirrorDivergence\(dir\)/);
    const latch = source.slice(source.indexOf('private fun latchMirrorDivergence'), source.indexOf('private fun resolveMirrorDivergence'));
    expect(latch).toMatch(/targetEpoch = prefs\.getLong\(REVOCATION_EPOCH, 0L\) \+ 1L\s*if \(!writeFenceChecked\(prefs, dir, PoisonKind\.INVALIDATE, 0, targetEpoch\)\)/);
    expect(latch).not.toContain('prefs.edit()');
  });

  it('verifies the signing credential and fingerprint under the same monitor as fence removal', () => {
    const resolve = source.slice(source.indexOf('private fun resolvePublishedMirror'), source.indexOf('private fun poisonLastResultMirror'));
    expect(resolve).toMatch(/synchronized\(McpTokenFingerprintStore\.monitor\) \{\s*val current = McpAutostartStore\.readToken\(context\)\s*if \(current !is McpAutostartStore\.TokenRead\.Present \|\| current\.token != signingToken\) \{\s*return@synchronized false\s*\}\s*val fingerprint = McpTokenFingerprintStore\.get\(context\)\s*if \(McpTokenFingerprintStore\.isTombstone\(fingerprint\) \|\|\s*\(fingerprint != null && fingerprint != McpTokenFingerprintStore\.hash\(signingToken\)\)\s*\) \{\s*return@synchronized false\s*\}\s*resolveMirrorDivergence\(dir\)\s*\}/);
    const nativeDir = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
    const autostart = require('node:fs').readFileSync(`${nativeDir}/McpAutostartStore.kt`, 'utf8');
    const fingerprint = require('node:fs').readFileSync(`${nativeDir}/McpTokenFingerprintStore.kt`, 'utf8');
    expect(autostart).not.toContain('@Synchronized');
    for (const method of ['writeOn', 'clear', 'read', 'readToken']) {
      expect(autostart).toMatch(new RegExp(`fun ${method}\\([^\\n]* = synchronized\\(McpTokenFingerprintStore\\.monitor\\)`));
    }
    for (const store of [autostart, fingerprint]) {
      expect(store).toContain('Global lock order: StageInstall.commitLock -> McpTokenFingerprintStore.monitor.');
      expect(store).toContain('The credential monitor is shared by both stores. McpAutostartStore has no lock of its own.');
      expect(store).toContain('While holding the credential monitor, never acquire commitLock or the supervisor lock.');
    }
    expect(resolve).not.toMatch(/McpServerSupervisor|MCPBridge/);
    expect(source).toMatch(/if \(token != null && writeLastResultMirror\(context, dir, token, value\)\) \{\s*resolvePublishedMirror\(context, dir, token\)/);
    expect(source).toMatch(/if \(writeLastResultMirror\(context, dir, token, value\)\) \{\s*return@synchronized !diverged \|\| resolvePublishedMirror\(context, dir, token\)/);
  });

  it('pins one queue directory across marker and mirror operations and syncs rename and unlink', () => {
    expect(source).toContain('import java.io.FileDescriptor');
    expect(source).toMatch(/private class PinnedDir\([^)]*private val dirFd: FileDescriptor/);
    expect(source).not.toContain('dirFd: Int');
    expect(source).not.toMatch(/DirectoryPin|withDirectoryFd/);
    expect(source).toMatch(/val flags = OsConstants\.O_RDONLY or OsConstants\.O_NOFOLLOW or OsConstants\.O_CLOEXEC\s*val dirFd = Os\.open\(path, flags, 0\)[\s\S]*?check\(OsConstants\.S_ISDIR\(Os\.fstat\(dirFd\)\.st_mode\)\)\s*val pfd = ParcelFileDescriptor\.dup\(dirFd\)/);
    expect(source).toContain('private val link = "/proc/self/fd/${pfd.fd}"');
    expect(source).toContain('check(Os.readlink(link) == path && OsConstants.S_ISDIR(Os.fstat(dirFd).st_mode))');
    expect(source).toContain('fun leaf(name: String): File = File("$link/$name")');
    expect(source).toMatch(/fun sync\(\) \{\s*Os\.fsync\(dirFd\)/);
    expect(source).toMatch(/fun unlink\(file: File\)[\s\S]*?Os\.remove\(file\.path\)[\s\S]*?sync\(\)/);
    expect(source).toMatch(/val temp = leaf\(prefix[\s\S]*?Os\.fsync\(fd\)[\s\S]*?Os\.rename\(temp\.path, leaf\(name\)\.path\)\s*renamed = true\s*sync\(\)/);
    expect(source).toMatch(/dir\.unlink\(dir\.leaf\(POISON_MARKER\)\)\s*!poisonMarkerExists\(dir\)/);
    expect(source).toMatch(/dir\.unlink\(dir\.leaf\(LAST_RESULT_MIRROR\)\)\s*!mirrorExists\(dir\)/);
    expect(source).toMatch(/val mirror = dir\.leaf\(LAST_RESULT_MIRROR\)\s*val poisoned = runCatching \{\s*val fd = Os\.open\(\s*mirror\.path,[\s\S]*?deleteLastResultMirror\(dir\) \|\| \(poisoned && readRegularFile\(mirror, 0\)/);
    expect(source).toMatch(/fun entries\(\): Array<String> = File\(link\)\.list\(\)/);
    expect(source).toMatch(/dir\.entries\(\)\.forEach[\s\S]*?dir\.unlink\(dir\.leaf\(name\)\)/);
    expect(source).toMatch(/val marker = dir\.leaf\(POISON_MARKER\)\s*try \{\s*Os\.lstat\(marker\.path\)/);
    for (const [start, end] of [
      ['fun invalidate(', 'private fun checkPrefsCommit'],
      ['fun refreshLastResultMirror(', 'private fun truncateMessage'],
      ['fun record(', 'class StageInstallReceiver'],
    ]) {
      const transaction = source.slice(source.indexOf(start), source.indexOf(end));
      expect(transaction.match(/openPinnedDir\(context\)\.use \{ dir ->/g)).toHaveLength(1);
      expect(transaction).not.toContain('McpTypedOpConsumer.queueDir');
    }
    expect(source).toMatch(/fun lastResultFenceMayExist[\s\S]*?pinDirectory\(queueDir\)[\s\S]*?return dir\.use \{\s*val exists = poisonMarkerExists\(it\)\s*it\.verify\(\)\s*exists\s*\}/);
  });

});
