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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  __setMCPRequestSha256ForTests, revokePendingMCPRequests, setMCPBridgeKey,
  startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { execCommand } from '@/hooks/use-native-exec';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

const tool = 'update_delivery_script';
const stagedPath = '/sdcard/Download/delivery.js';
const targetName = '.env.article-delivery.js';
const script = 'console.log("delivery");\n';
const previous = 'console.log("previous");\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const args = { stagedPath, expectedSha256: digest(script), expectedBytes: Buffer.byteLength(script) };
const current = () => useMcpApprovalStore.getState().current;
const exec = jest.mocked(execCommand);

beforeEach(() => {
  resetHarness();
  h.settings.mcpExecEnabled = true;
  exec.mockReset();
  __setMCPRequestSha256ForTests(nodeSha256);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  startMCPPoller();
});

afterEach(() => {
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
  __setMCPRequestSha256ForTests(null);
});

function expectAudits(...codes: string[]) {
  expect(h.audits.map(({ json }) => json)).toEqual(codes.map((code) => ({
    kind: 'mcp_update_delivery_script', event: 'mcp_update_delivery_script', principal: TEST_PRINCIPAL, code,
  })));
}

async function approve(input = args, decision: 'once' | 'deny' | 'always' = 'once') {
  const pending = callTool(tool, input);
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: tool, summary: 'mcp.approval_update_delivery_script' });
  expect(current()?.detail).toContain(stagedPath);
  expect(current()?.detail).toContain(targetName);
  expect(current()?.alwaysAllowable).toBeUndefined();
  expect(exec).not.toHaveBeenCalled();
  useMcpApprovalStore.getState().respond(current()!.id, decision);
  return pending;
}

it('refuses when exec/write is disabled', async () => {
  h.settings.mcpExecEnabled = false;
  expect(await callTool(tool, args)).toMatchObject({ ok: false, code: 'disabled' });
  expect(current()).toBeNull();
  expect(exec).not.toHaveBeenCalled();
  expectAudits('disabled');
});

it.each([
  ['invalid_path', { stagedPath: '/sdcard/Download/sub/delivery.js' }],
  ['invalid_path', { stagedPath: '/sdcard/Download/delivery..js' }],
  ['invalid_path', { stagedPath: '/sdcard/Download/delivery.js\n' }],
  ['invalid_digest', { expectedSha256: 'A'.repeat(64) }],
  ['invalid_digest', { expectedSha256: args.expectedSha256 + '\n' }],
  ['invalid_size', { expectedBytes: 0 }],
  ['invalid_size', { expectedBytes: 1.5 }],
  ['invalid_size', { expectedBytes: 1_048_577 }],
])('refuses %s before requesting approval (%j)', async (code, override) => {
  expect(await callTool(tool, { ...args, ...override })).toMatchObject({ ok: false, code });
  expect(current()).toBeNull();
  expect(exec).not.toHaveBeenCalled();
  expectAudits(code);
});

it('honors denial without executing', async () => {
  h.settings.mcpSkipApproval = true;
  expect(await approve(args, 'deny')).toMatchObject({ ok: false, code: 'denied' });
  expect(exec).not.toHaveBeenCalled();
  expectAudits('approval_requested', 'denied');
});

it('returns a timeout for an expired pre-approval deadline', async () => {
  expect(await callTool(tool, args, { receivedAt: new Date(Date.now() - 301_000).toISOString() }))
    .toEqual({ ok: true, data: { status: 'timeout' } });
  expect(current()).toBeNull();
  expect(exec).not.toHaveBeenCalled();
  expectAudits('timeout');
});

it('revokes during approval without executing', async () => {
  const pending = callTool(tool, args);
  await waitFor(() => current() !== null);
  await revokePendingMCPRequests();
  expect(await pending).toBeNull();
  await waitFor(() => h.audits.some(({ json }) => json.code === 'revoked'));
  expectAudits('approval_requested', 'revoked');
  expect(exec).not.toHaveBeenCalled();
});

describe('approved filesystem transaction', () => {
  let root: string;
  let target: string;
  let shellSetup: string;

  beforeEach(() => {
    shellSetup = '';
    root = mkdtempSync('/tmp/shelly-delivery-op-');
    const agents = root + '/home/.shelly/agents';
    mkdirSync(agents, { recursive: true });
    target = agents + '/' + targetName;
    exec.mockImplementation(async (command, timeout) => {
      expect(timeout).toBe(60_000);
      const localCommand = command.replaceAll('/data/home-root/', root + '/')
        .replaceAll(stagedPath, root + '/staged.js');
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        execFile('bash', ['-c', shellSetup + localCommand], { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 });
        });
      });
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      return { ...result, stdout: 'shell startup output\n{}\n' + result.stdout };
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects a tmp size mismatch before backing up or replacing the target', async () => {
    shellSetup = 'cp() { command cp "$@" && printf "\\n" >> "$2"; }\n';
    writeFileSync(root + '/staged.js', script);
    writeFileSync(target, previous);
    expect(await approve()).toMatchObject({ ok: false, code: 'size_mismatch' });
    expect(readFileSync(target, 'utf8')).toBe(previous);
    expect(existsSync(target + '.bak')).toBe(false);
    expect(existsSync(target + '.new')).toBe(false);
    expectAudits('approval_requested', 'size_mismatch');
  });

  it('rejects a staged digest mismatch and leaves the target untouched', async () => {
    writeFileSync(root + '/staged.js', script.replace('delivery', 'changed!'));
    writeFileSync(target, previous);
    expect(await approve()).toMatchObject({ ok: false, code: 'digest_mismatch' });
    expect(readFileSync(target, 'utf8')).toBe(previous);
    expect(existsSync(target + '.bak')).toBe(false);
    expect(existsSync(target + '.new')).toBe(false);
    expectAudits('approval_requested', 'digest_mismatch');
  });

  it('rejects invalid syntax before backing up or replacing the target', async () => {
    const invalid = 'const broken = ;\n';
    writeFileSync(root + '/staged.js', invalid);
    writeFileSync(target, previous);
    expect(await approve({ ...args, expectedSha256: digest(invalid), expectedBytes: Buffer.byteLength(invalid) }))
      .toMatchObject({ ok: false, code: 'syntax_error', error: expect.stringContaining('SyntaxError') });
    expect(readFileSync(target, 'utf8')).toBe(previous);
    expect(existsSync(target + '.bak')).toBe(false);
    expect(existsSync(target + '.new')).toBe(false);
    expectAudits('approval_requested', 'syntax_error');
  });

  it.each(['updated', 'created'] as const)('returns %s and reports the backup outcome', async (status) => {
    const updating = status === 'updated';
    writeFileSync(root + '/staged.js', script);
    if (updating) {
      writeFileSync(target, previous);
      writeFileSync(target + '.bak', 'older backup');
    }
    expect(await approve(args, 'always')).toEqual({ ok: true, data: {
      status, sha256: args.expectedSha256, bytes: args.expectedBytes,
      backupCreated: updating, previousSha256: updating ? digest(previous) : null,
    } });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(readFileSync(target, 'utf8')).toBe(script);
    if (updating) expect(readFileSync(target + '.bak', 'utf8')).toBe(previous);
    else expect(existsSync(target + '.bak')).toBe(false);
    expect(existsSync(target + '.new')).toBe(false);
    expectAudits('approval_requested', status);
  });
});
