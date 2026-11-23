jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  invalidateStageInstalls: jest.fn(() => true),
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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  __setMCPRequestSha256ForTests, revokePendingMCPRequests, setMCPBridgeKey,
  startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { execCommand } from '@/hooks/use-native-exec';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, REQUESTS, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

jest.mock('@/lib/agent-manager', () => ({ updateAgent: jest.fn() }));

import { updateAgent } from '@/lib/agent-manager';
import { buildArticlePipeline } from '@/lib/agent-pipeline-presets';
import type { Agent } from '@/store/types';
import { EXAMPLE_CONFIGS, EXAMPLE_DIGEST } from './fixtures/article-pipeline-config';

jest.setTimeout(30_000);

const tool = 'update_pipeline_config';
const realNow = Date.now;
const stagedPath = '/sdcard/Download/config.json';
const a = EXAMPLE_CONFIGS['example-a'];
const b = EXAMPLE_CONFIGS['example-queue'];
const updated = { ...a, instructions: { ...a.instructions, research: '新しい指示 📰' } };
const digest = { ...EXAMPLE_DIGEST, streams: EXAMPLE_DIGEST.streams.slice(0, 1) };
const config = (pipelines = [a], topDigest?: typeof digest) =>
  JSON.stringify({ version: 1, pipelines, digest: topDigest });
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const argsFor = (value: string, rebuild: { agentId: string; pipelineId: string }[] = []) =>
  ({ stagedPath, expectedSha256: sha256(value), expectedBytes: Buffer.byteLength(value), rebuild });
const current = () => useMcpApprovalStore.getState().current;
const exec = jest.mocked(execCommand);
const update = jest.mocked(updateAgent);
let root: string;
let target: string;
let staged: string;

beforeEach(() => {
  resetHarness();
  h.settings.mcpExecEnabled = true;
  h.settings.agentVaultPath = '/storage/example/Notes';
  root = mkdtempSync('/tmp/shelly-pipeline-op-');
  const agents = root + '/home/.shelly/agents';
  mkdirSync(agents, { recursive: true });
  target = agents + '/article-pipelines.json';
  staged = root + '/staged.json';
  writeFileSync(staged, config([updated]));
  writeFileSync(target, config());
  exec.mockReset().mockImplementation(async (command, timeout) => {
    const localCommand = command.replaceAll('/data/home-root/', root + '/').replaceAll(stagedPath, staged);
    return new Promise((resolve, reject) => {
      // Give nested Node a pipe for stdout instead of execFile's socket pair.
      const script = `set -o pipefail\n(\n${localCommand}\n) | cat`;
      execFile('bash', ['-c', script], { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 });
      });
    });
  });
  update.mockReset();
  __setMCPRequestSha256ForTests(nodeSha256);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  startMCPPoller();
});

afterEach(() => {
  jest.restoreAllMocks();
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
  __setMCPRequestSha256ForTests(null);
  rmSync(root, { recursive: true, force: true });
});

async function requestApproval(input = argsFor(config([updated])), receivedAt?: string) {
  const pending = callTool(tool, input, { receivedAt, waitClock: realNow });
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: tool });
  expect(current()?.alwaysAllowable).toBeUndefined();
  return { pending };
}

it.each([
  ['invalid_path', { stagedPath: '/sdcard/Download/sub/config.json' }],
  ['invalid_digest', { expectedSha256: 'A'.repeat(64) }],
  ['invalid_size', { expectedBytes: 262145 }],
  ['size_mismatch', { expectedBytes: 1 }],
  ['digest_mismatch', { expectedSha256: 'a'.repeat(64) }],
  ['invalid_rebuild', { rebuild: [{ agentId: '../x', pipelineId: a.id }] }],
  ['invalid_rebuild', { rebuild: [{ agentId: 'agent-1', pipelineId: 'unknown' }] }],
])('refuses %s before approval (%j)', async (code, overrides) => {
  expect(await callTool(tool, { ...argsFor(config([updated])), ...overrides })).toMatchObject({ ok: false, code });
  expect(current()).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

it('refuses 34 rebuild pairs before any file operation or approval', async () => {
  const enqueue = jest.spyOn(useMcpApprovalStore.getState(), 'enqueue');
  const next = config([updated]);
  const pairs = Array.from({ length: 34 }, (_, index) => ({ agentId: `agent-${index + 1}`, pipelineId: a.id }));
  expect(await callTool(tool, argsFor(next, pairs))).toMatchObject({ ok: false, code: 'invalid_rebuild' });
  expect(h.audits.map(({ json }) => json.code)).toEqual(['invalid_rebuild']);
  expect(enqueue).not.toHaveBeenCalled();
  expect(current()).toBeNull();
  expect(exec).not.toHaveBeenCalled();
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(readFileSync(staged, 'utf8')).toBe(next);
  expect(existsSync(target + '.bak')).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

it('refuses a symlinked staged file before approval', async () => {
  rmSync(staged);
  symlinkSync(target, staged);
  expect(await callTool(tool, argsFor(config()))).toMatchObject({ ok: false, code: 'staged_missing' });
  expect(current()).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
});

it.each(['staged', 'current'] as const)('refuses schema-invalid %s JSON', async (which) => {
  const invalid = config([{ ...a, instructions: { ...a.instructions, research: 'x'.repeat(501) } }]);
  writeFileSync(which === 'staged' ? staged : target, invalid);
  const before = readFileSync(target, 'utf8');
  expect(await callTool(tool, argsFor(readFileSync(staged, 'utf8'))))
    .toMatchObject({ ok: false, code: which === 'staged' ? 'invalid_config' : 'invalid_current' });
  expect(current()).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe(before);
  expect(existsSync(target + '.bak')).toBe(false);
});

it.each([
  ['instructions', config(), config([updated]), [a.id]],
  ['added pipeline', config(), config([a, b]), [b.id]],
  ['removed pipeline', config([a, b]), config(), [b.id]],
  ['digest only', config([a], digest), config([a], { ...digest, footer: 'New footer' }), ['digest']],
  ['creation', null, config([a], digest), [a.id, 'digest']],
  ['key order', config(), config([{ name: a.name, ...Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'name')) } as typeof a]), []],
])('swaps and reports %s', async (_label, before, next, changedPipelineIds) => {
  if (before === null) rmSync(target);
  else writeFileSync(target, before);
  writeFileSync(staged, next);
  const input = argsFor(next);
  const { pending } = await requestApproval(input);
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  const status = before === null ? 'created' : 'updated';
  expect(await pending).toEqual({ ok: true, data: {
    status, sha256: input.expectedSha256, bytes: input.expectedBytes,
    backupCreated: before !== null, previousSha256: before === null ? null : sha256(before),
    changedPipelineIds, rebuilt: [], rebuildFailed: [],
  } });
  expect(readFileSync(target, 'utf8')).toBe(next);
  if (before !== null) expect(readFileSync(target + '.bak', 'utf8')).toBe(before);
  expect(existsSync(target + '.new')).toBe(false);
  const audit = { kind: 'mcp_update_pipeline_config', event: 'mcp_update_pipeline_config', principal: TEST_PRINCIPAL };
  expect(h.audits.map(({ json }) => json)).toEqual([
    { ...audit, code: 'approval_requested' },
    {
      ...audit, code: status, changedPipelineIds, rebuiltCount: 0, rebuildFailedCount: 0,
      rebuiltAgentIds: [], failedAgentIds: [], swapStatus: status, failedReasonCodes: [],
      sha256: input.expectedSha256, bytes: input.expectedBytes, backupCreated: before !== null,
      ...(before === null ? {} : { previousSha256: sha256(before) }),
    },
  ]);
  if (before === null) expect(h.audits.at(-1)?.json).not.toHaveProperty('previousSha256');
});

it('preserves identity and schedule and continues after unknown and failed rebuilds', async () => {
  const original = { id: 'agent-1', schedule: '10 8 * * *', enabled: false, autonomous: true } as Agent;
  const saved = new Map<string, Agent>([[original.id, original]]);
  update.mockImplementation(async (id, partial) => {
    if (id === 'agent-2') throw new Error('write failed');
    const existing = saved.get(id);
    if (!existing) return null;
    const patched = { ...existing, ...partial };
    saved.set(id, patched);
    return patched;
  });
  const { pending } = await requestApproval(argsFor(config([updated]), [
    { agentId: 'unknown', pipelineId: a.id },
    { agentId: 'agent-2', pipelineId: a.id },
    { agentId: original.id, pipelineId: a.id },
  ]));
  expect(current()?.summary).toBe('mcp.approval_update_pipeline_config');
  expect(update).not.toHaveBeenCalled();
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: true, data: {
    rebuilt: [original.id],
    rebuildFailed: [
      { agentId: 'unknown', reason: expect.stringContaining('not found') },
      { agentId: 'agent-2', reason: expect.stringContaining('write failed') },
    ],
  } });
  expect(saved.get(original.id)).toMatchObject({ ...original, orchestration: buildArticlePipeline(updated).orchestration });
  expect(readFileSync(target, 'utf8')).toBe(config([updated]));
});

it('refuses a current file change after approval was requested', async () => {
  const { pending } = await requestApproval();
  const concurrent = config([b]);
  writeFileSync(target, concurrent);
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: false, code: 'current_changed' });
  expect(readFileSync(target, 'utf8')).toBe(concurrent);
  expect(existsSync(target + '.bak')).toBe(false);
});

it('drops the result if the epoch changes during approval', async () => {
  const { pending } = await requestApproval();
  await revokePendingMCPRequests();
  expect(await pending).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

it('drops the result but audits partial rebuild progress when revoked in flight', async () => {
  let finishRebuild: (() => void) | undefined;
  update.mockResolvedValueOnce({ id: 'agent-1' } as Agent)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => {
      finishRebuild = () => reject(new Error('persistence interrupted'));
    }));
  const { pending } = await requestApproval(argsFor(config([updated]), [
    { agentId: 'agent-1', pipelineId: a.id },
    { agentId: 'agent-2', pipelineId: a.id },
    { agentId: 'agent-3', pipelineId: a.id },
    { agentId: 'agent-4', pipelineId: a.id },
  ]));
  try {
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    await waitFor(() => update.mock.calls.length === 3);
    await revokePendingMCPRequests();
  } finally {
    finishRebuild?.();
  }
  expect(await pending).toBeNull();
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  expect(h.audits.at(-1)?.json).toMatchObject({
    code: 'revoked', changedPipelineIds: [a.id], rebuiltCount: 1, rebuildFailedCount: 3,
    rebuiltAgentIds: ['agent-1'], failedAgentIds: ['agent-2', 'agent-3', 'agent-4'],
    swapStatus: 'updated', failedReasonCodes: ['agent_not_found', 'other', 'revoked'],
    sha256: sha256(config([updated])), bytes: Buffer.byteLength(config([updated])),
    backupCreated: true, previousSha256: sha256(config()),
  });
  expect(readFileSync(target, 'utf8')).toBe(config([updated]));
  expect(update).toHaveBeenCalledTimes(3);
});

it.each([0, 1])('audits the in-flight persistence result after revocation (exit %s)', async (exitCode) => {
  const command = 'persist test agent';
  const runBash = exec.getMockImplementation()!;
  let finishWrite!: (result: Awaited<ReturnType<typeof execCommand>>) => void;
  const write = new Promise<Awaited<ReturnType<typeof execCommand>>>((resolve) => { finishWrite = resolve; });
  exec.mockImplementation((script, timeout) => script === command ? write : runBash(script, timeout));
  update.mockImplementation(async (id, _patch, runCommand) => {
    expect(await runCommand(command)).toBe('saved');
    return { id } as Agent;
  });
  const { pending } = await requestApproval(argsFor(config([updated]), [{ agentId: 'agent-1', pipelineId: a.id }]));
  try {
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    await waitFor(() => exec.mock.calls.some(([script]) => script === command));
    await revokePendingMCPRequests();
  } finally {
    finishWrite({ exitCode, stdout: 'saved', stderr: exitCode ? 'persistence interrupted' : '' });
  }
  const updateResult = update.mock.results[0].value;
  if (exitCode === 0) await expect(updateResult).resolves.toMatchObject({ id: 'agent-1' });
  else await expect(updateResult).rejects.toThrow('persistence interrupted');
  expect(await pending).toBeNull();
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  expect(h.audits.at(-1)?.json).toMatchObject({
    code: 'revoked', changedPipelineIds: [a.id], rebuiltCount: 1 - exitCode, rebuildFailedCount: exitCode,
    rebuiltAgentIds: exitCode === 0 ? ['agent-1'] : [], failedAgentIds: exitCode === 1 ? ['agent-1'] : [],
    swapStatus: 'updated', failedReasonCodes: exitCode === 1 ? ['other'] : [],
  });
});

it('records revocation before the operative write batch can execute', async () => {
  const command = "set -e\n: 'run-agent-agent-1.sh' 'plan-agent-agent-1.json'";
  update.mockImplementationOnce(async (_id, _patch, runCommand) => {
    await revokePendingMCPRequests();
    await runCommand(command);
    throw new Error('operative batch should have been rejected');
  });
  const { pending } = await requestApproval(argsFor(config([updated]), [{ agentId: 'agent-1', pipelineId: a.id }]));
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  const result = await pending;
  expect(result).toBeNull();
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  await expect(update.mock.results[0].value).rejects.toThrow('cancelled: pending MCP requests were revoked');
  expect(exec.mock.calls.some(([script]) => script === command)).toBe(false);
  expect(h.audits.at(-1)?.json).toMatchObject({
    code: 'revoked', swapStatus: 'updated', changedPipelineIds: [a.id], rebuiltCount: 0, rebuildFailedCount: 1,
    rebuiltAgentIds: [], failedAgentIds: ['agent-1'], failedReasonCodes: ['revoked'],
  });
  expect(JSON.stringify({ audits: h.audits, result })).not.toContain('write_landed');
});

it.each([false, true])('records a landed write followed by a schedule failure (revoked: %s)', async (revoked) => {
  const command = "set -e\n: 'run-agent-agent-1.sh' 'plan-agent-agent-1.json'";
  const runBash = exec.getMockImplementation()!;
  exec.mockImplementation((script, timeout) => (
    script === command ? Promise.resolve({ exitCode: 0, stdout: 'saved', stderr: '' }) : runBash(script, timeout)
  ));
  update.mockImplementationOnce(async (_id, _patch, runCommand) => {
    expect(await runCommand(command)).toBe('saved');
    if (revoked) await revokePendingMCPRequests();
    throw new Error('schedule installation failed');
  }).mockResolvedValueOnce({ id: 'agent-2' } as Agent);
  const next = config([updated]);
  const { pending } = await requestApproval(argsFor(next, [
    { agentId: 'agent-1', pipelineId: a.id }, { agentId: 'agent-2', pipelineId: a.id },
  ]));
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  const result = await pending;
  if (revoked) {
    expect(result).toBeNull();
    await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  } else {
    expect(result).toMatchObject({ ok: true, data: {
      status: 'updated', rebuilt: ['agent-1', 'agent-2'], rebuildFailed: [],
    } });
  }
  expect(readFileSync(target, 'utf8')).toBe(next);
  expect(update).toHaveBeenCalledTimes(revoked ? 1 : 2);
  expect(h.audits.at(-1)?.json).toMatchObject({
    code: revoked ? 'revoked' : 'updated', changedPipelineIds: [a.id],
    rebuiltCount: revoked ? 1 : 2, rebuildFailedCount: revoked ? 1 : 0,
    rebuiltAgentIds: revoked ? ['agent-1'] : ['agent-1', 'agent-2'], failedAgentIds: revoked ? ['agent-2'] : [],
    swapStatus: 'updated', failedReasonCodes: revoked ? ['revoked'] : [],
  });
  expect(JSON.stringify({ audits: h.audits, result })).not.toContain('write_landed');
});

const isSwap = (command: string) => command.includes('mv -f "$tmp" "$target"');

it('audits all rebuilds as revoked when revocation follows the swap', async () => {
  const runBash = exec.getMockImplementation()!;
  exec.mockImplementation(async (command, timeout) => {
    const result = await runBash(command, timeout);
    if (isSwap(command)) await revokePendingMCPRequests();
    return result;
  });
  const next = config([updated]);
  const { pending } = await requestApproval(argsFor(next, [
    { agentId: 'agent-1', pipelineId: a.id }, { agentId: 'agent-2', pipelineId: a.id },
  ]));
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toBeNull();
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  expect(readFileSync(target, 'utf8')).toBe(next);
  expect(update).not.toHaveBeenCalled();
  expect(h.audits.at(-1)?.json).toMatchObject({
    code: 'revoked', swapStatus: 'updated', rebuiltCount: 0, rebuildFailedCount: 2,
    rebuiltAgentIds: [], failedAgentIds: ['agent-1', 'agent-2'], failedReasonCodes: ['revoked', 'revoked'],
    sha256: sha256(next), bytes: Buffer.byteLength(next), backupCreated: true, previousSha256: sha256(config()),
  });
});

it.each(['rejected', 'empty', 'invalid', 'unrecognized error', 'third hash', 'third hash revoked', 'third hash non-UTF8', 'third hash oversized non-UTF8'] as const)(
  'reconciles the target after a swap with %s outcome', async (outcome) => {
    const runBash = exec.getMockImplementation()!;
    const corrupt = outcome === 'third hash oversized non-UTF8' ? Buffer.alloc(262146, 0xff)
      : outcome === 'third hash non-UTF8' ? Buffer.from([0xff, 0xfe, 0x00]) : config([b]);
    exec.mockImplementation(async (command, timeout) => {
      const result = await runBash(command, timeout);
      if (!isSwap(command)) return result;
      expect(result.exitCode).toBe(0);
      if (outcome === 'unrecognized error') {
        return { ...result, stdout: JSON.stringify({ error: 'unrecognized_thing' }), exitCode: 1 };
      }
      if (outcome === 'rejected') throw new Error('native timeout');
      if (outcome === 'invalid') return { ...result, stdout: result.stdout.replace('"updated"', '"created"') };
      if (outcome.startsWith('third hash')) writeFileSync(target, corrupt);
      if (outcome === 'third hash revoked') await revokePendingMCPRequests();
      return { stdout: '', stderr: '', exitCode: 1 };
    });
    const next = config([updated]);
    update.mockResolvedValue({ id: 'agent-1' } as Agent);
    const { pending } = await requestApproval(argsFor(next, [{ agentId: 'agent-1', pipelineId: a.id }]));
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    const result = await pending;
    if (outcome.startsWith('third hash')) {
      if (outcome === 'third hash revoked') expect(result).toBeNull();
      else expect(result).toMatchObject({ ok: false, code: 'native_error' });
      await waitFor(() => h.audits.some(({ json }) => json.code === 'native_error'));
      expect(h.audits.map(({ json }) => json)).toEqual([
        expect.objectContaining({ code: 'approval_requested' }),
        expect.objectContaining({ code: 'native_error', observedSha256: sha256(corrupt) }),
      ]);
      expect(update).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: true, data: {
        status: 'updated', sha256: sha256(next), bytes: Buffer.byteLength(next), backupCreated: true,
        previousSha256: sha256(config()), changedPipelineIds: [a.id], rebuilt: ['agent-1'], rebuildFailed: [],
      } });
      expect(h.audits.map(({ json }) => json)).toEqual([
        expect.objectContaining({ code: 'approval_requested' }),
        expect.objectContaining({ code: 'updated', rebuiltCount: 1, rebuildFailedCount: 0 }),
      ]);
    }
  },
);

it.each([false, true])('refuses an unrecognized swap error without a rename (target missing: %s)', async (missing) => {
  if (missing) rmSync(target);
  const runBash = exec.getMockImplementation()!;
  exec.mockImplementation((command, timeout) => isSwap(command)
    ? Promise.resolve({ stdout: '{"error":"unrecognized_thing"}', stderr: '', exitCode: 1 })
    : runBash(command, timeout));
  const { pending } = await requestApproval();
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: false, code: 'native_error' });
  const swapIndex = exec.mock.calls.findIndex(([command]) => isSwap(command));
  expect(swapIndex).toBeGreaterThanOrEqual(0);
  expect(exec.mock.calls.slice(swapIndex + 1)).toHaveLength(1);
  expect(h.audits.at(-1)?.json).toEqual({
    kind: 'mcp_update_pipeline_config', event: 'mcp_update_pipeline_config', principal: TEST_PRINCIPAL,
    code: 'native_error',
  });
  if (missing) expect(existsSync(target)).toBe(false);
  else expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
  expect(existsSync(target + '.new')).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

// The signed receipt and file mtime deliberately differ. Restore the validation
// clock once the test observes the publication of the signed file.
async function dropWithMtime(input: ReturnType<typeof argsFor>, receipt: number, mtime: number, clock: jest.SpyInstance) {
  clock.mockReturnValue(mtime);
  const recordMtime = h.fileMtimes.set.bind(h.fileMtimes);
  const setMtime = jest.spyOn(h.fileMtimes, 'set').mockImplementation((uri, time) => {
    const result = recordMtime(uri, time);
    if (uri.startsWith(REQUESTS + '/')) {
      clock.mockReturnValue(receipt);
      setMtime.mockRestore();
    }
    return result;
  });
  const pending = callTool(tool, input, { receivedAt: new Date(receipt).toISOString(), waitClock: realNow });
  await waitFor(() => current()?.kind === tool, 5000, realNow);
  return { pending };
}

it.each([
  [260_000, 'times out when its result window expires'],
  [259_999, 'swaps while its result window is still open'],
] as const)('a queued call %s ms after file publication: %s', async (elapsed, _outcome) => {
  const receivedAt = Date.now();
  const signedReceipt = new Date(receivedAt).toISOString();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(receivedAt);
  let finishRebuild!: () => void;
  const blocked = new Promise<Agent>((resolve) => {
    finishRebuild = () => resolve({ id: 'agent-1' } as Agent);
  });
  update.mockImplementationOnce(() => blocked).mockResolvedValue({ id: 'agent-2' } as Agent);
  let predecessor: Awaited<ReturnType<typeof requestApproval>> | undefined;
  let queued: Awaited<ReturnType<typeof requestApproval>> | undefined;
  const next = config([updated]);
  const backup = 'existing backup after the predecessor';
  const expired = elapsed === 260_000;
  try {
    // Keep the target digest stable so the queued swap can pass its CAS check.
    writeFileSync(staged, config());
    predecessor = await requestApproval(argsFor(config(), [{ agentId: 'agent-1', pipelineId: a.id }]), signedReceipt);
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    await waitFor(() => update.mock.calls.length === 1);
    writeFileSync(target + '.bak', backup);
    writeFileSync(staged, next);
    const queuedMtime = receivedAt - 120_000;
    queued = await dropWithMtime(argsFor(next, [{ agentId: 'agent-2', pipelineId: a.id }]), receivedAt, queuedMtime, clock);
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    // Let the approved request reach the write queue before advancing time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const execCallsBeforeRelease = exec.mock.calls.length;
    clock.mockReturnValue(queuedMtime + elapsed);
    finishRebuild();
    expect(await predecessor.pending).toMatchObject({ ok: true, data: { status: 'updated' } });
    if (expired) {
      expect(await queued.pending).toMatchObject({ ok: false, code: 'timeout' });
      expect(h.audits.at(-1)?.json).toMatchObject({ code: 'timeout' });
      expect(exec).toHaveBeenCalledTimes(execCallsBeforeRelease);
      expect(update).toHaveBeenCalledTimes(1);
      expect(readFileSync(target, 'utf8')).toBe(config());
      expect(readFileSync(target + '.bak', 'utf8')).toBe(backup);
    } else {
      expect(await queued.pending).toMatchObject({ ok: true, data: { status: 'updated', rebuilt: ['agent-2'] } });
      expect(readFileSync(target, 'utf8')).toBe(next);
      expect(readFileSync(target + '.bak', 'utf8')).toBe(config());
    }
  } finally {
    finishRebuild();
    clock.mockRestore();
  }
});

it('refuses at shell startup when only the device clock has reached the deadline', async () => {
  const receipt = realNow() - 42_000;
  const mtime = receipt - 259_999;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(receipt);
  const { pending } = await dropWithMtime(argsFor(config([updated]), [{ agentId: 'agent-1', pipelineId: a.id }]), receipt, mtime, clock);
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: false, code: 'timeout' });
  expect(exec.mock.calls.some(([command]) => isSwap(command))).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
  expect(existsSync(target + '.new')).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

it('refuses at shell startup 500 ms after a fractional-second deadline', async () => {
  const deadline = Math.floor(realNow() / 1000) * 1000 + 250;
  const receipt = deadline - 1;
  const deviceSeconds = Math.floor((deadline + 500) / 1000);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(receipt);
  const runBash = exec.getMockImplementation()!;
  exec.mockImplementation((command, timeout) => runBash(
    isSwap(command) ? `date() { printf '%s\\n' '${deviceSeconds}'; }\n${command}` : command, timeout,
  ));
  const { pending } = await dropWithMtime(argsFor(config([updated])), receipt, deadline - 260_000, clock);
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  expect(await pending).toMatchObject({ ok: false, code: 'timeout' });
  expect(exec.mock.calls.some(([command]) => isSwap(command))).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(config());
  expect(existsSync(target + '.bak')).toBe(false);
  expect(existsSync(target + '.new')).toBe(false);
});

it('audits committed work when the deadline expires between rebuilds', async () => {
  const receipt = realNow();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(receipt);
  update.mockImplementationOnce(async (id) => {
    clock.mockReturnValue(receipt + 260_000);
    return { id } as Agent;
  });
  const { pending } = await requestApproval(argsFor(config([updated]), [
    { agentId: 'agent-1', pipelineId: a.id }, { agentId: 'agent-2', pipelineId: a.id },
  ]), new Date(receipt).toISOString());
  useMcpApprovalStore.getState().respond(current()!.id, 'once');
  const result = await pending;
  expect(result).toMatchObject({ ok: false, code: 'timeout', error: expect.stringMatching(/swap committed.*audit record/i) });
  expect(result?.error).not.toContain('before the update could be applied');
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0]).toBe('agent-1');
  expect(readFileSync(target, 'utf8')).toBe(config([updated]));
  expect(h.audits.map(({ json }) => json)).toEqual([
    expect.objectContaining({ code: 'approval_requested' }),
    expect.objectContaining({
      code: 'timeout', changedPipelineIds: [a.id], rebuiltCount: 1, rebuildFailedCount: 1,
      rebuiltAgentIds: ['agent-1'], failedAgentIds: ['agent-2'], swapStatus: 'updated', failedReasonCodes: ['timeout'],
      sha256: sha256(config([updated])), bytes: Buffer.byteLength(config([updated])),
      backupCreated: true, previousSha256: sha256(config()),
    }),
  ]);
});

it.each(['timeout', 'cancelled: pending MCP requests were revoked'])(
  'distinguishes native stderr %j from a deadline skip', async (stderr) => {
    const receipt = realNow();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(receipt);
    const command = 'persist test agent';
    const runBash = exec.getMockImplementation()!;
    exec.mockImplementation(async (script, timeout) => {
      if (script !== command) return runBash(script, timeout);
      clock.mockReturnValue(receipt + 260_000);
      return { exitCode: 1, stdout: '', stderr };
    });
    update.mockImplementationOnce(async (id, _patch, runCommand) => {
      await runCommand(command);
      return { id } as Agent;
    });
    const { pending } = await requestApproval(argsFor(config([updated]), [
      { agentId: 'agent-1', pipelineId: a.id }, { agentId: 'agent-2', pipelineId: a.id },
    ]), new Date(receipt).toISOString());
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe('agent-1');
    expect(h.audits.at(-1)?.json).toMatchObject({
      code: 'timeout', rebuiltAgentIds: [], failedAgentIds: ['agent-1', 'agent-2'],
      failedReasonCodes: ['other', 'timeout'],
    });
  },
);

it('offers the tool only with exec/write enabled', () => {
  const { availableTools } = require('../scripts/shelly-mcp-server.js');
  expect(availableTools({ typedOps: true }).map(({ name }: { name: string }) => name)).not.toContain(tool);
  expect(availableTools({ exec: true }).map(({ name }: { name: string }) => name)).toContain(tool);
});
