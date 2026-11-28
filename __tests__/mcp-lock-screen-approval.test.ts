/**
 * Lock-screen approval (owner decision 2026-11-29) for update_pipeline_config /
 * update_delivery_script / stage_install: an approval the owner gave on the
 * lock screen (McpLockScreenApprovalActivity, only after the keyguard was
 * dismissed) is written natively as `lock-approvals/<callId>` and RN honours
 * it WITHOUT a second tap: verified for this callId and tool, unexpired,
 * within the request's approval deadline, single use. Anything else falls
 * back to RN's dialog. Also: the 5 min approval deadline end to end.
 * Dummy values only.
 */
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  invalidateStageInstalls: jest.fn(() => true),
  resolveStageInstallPath: jest.fn(async (p: string) => ({ path: p, sha256: 'b'.repeat(64) })),
  stageInstallGeneration: jest.fn(() => 0),
  stageInstallApk: jest.fn(async () => ({ error: 'staging refused in this test', code: 'staging_failed' })),
  getStageInstallResult: jest.fn(),
} }));
jest.mock('@/store/agent-store', () => require('./helpers/mcp-typed-ops-harness').agentStoreMock);
jest.mock('@/store/settings-store', () => require('./helpers/mcp-typed-ops-harness').settingsStoreMock);
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/lib/agent-user-policy-store', () => require('./helpers/mcp-typed-ops-harness').policyStoreMock);
jest.mock('@/lib/debug-logger', () => require('./helpers/mcp-typed-ops-harness').loggerMock);
jest.mock('@/lib/secure-store', () => ({ getConnectorSecret: async () => 'dummy-token' }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })) }));
jest.mock('react-native', () => require('./helpers/mcp-typed-ops-harness').reactNativeMock);
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k, tFor: (_l: string, k: string) => k }));
jest.mock('@/lib/agent-manager', () => ({ updateAgent: jest.fn() }));

import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { __setMCPRequestSha256ForTests, setMCPBridgeKey, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import {
  MCP_LOCK_APPROVAL_DOMAIN, mcpLockApprovalMac, recordMcpLockApprovalConsumed, verifyMcpLockApproval,
} from '@/lib/mcp-request-auth';
import { execCommand } from '@/hooks/use-native-exec';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, LOCK_APPROVALS, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

jest.setTimeout(30_000);

const KT_DIR = path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'java', 'expo', 'modules', 'terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-server-bridge.ts'), 'utf8');
const current = () => useMcpApprovalStore.getState().current;
const PRE_APPROVAL_MS = 300_000;

const ARGS: Record<string, Record<string, unknown>> = {
  update_delivery_script: { stagedPath: '/sdcard/Download/d.js', expectedSha256: 'ab'.repeat(32), expectedBytes: 3 },
  stage_install: { path: '/storage/emulated/0/Download/a.apk' },
};
const kindOf = (tool: string) => (tool === 'stage_install' ? 'mcp_stage_install' : 'mcp_update_delivery_script');

/** The value McpLockScreenApproval.token writes. */
async function token(callId: string, tool: string, expiresAtMs: number, key = TEST_BRIDGE_KEY): Promise<string> {
  return `${expiresAtMs}.${await mcpLockApprovalMac(key, callId, tool, expiresAtMs, nodeSha256)}`;
}

describe('RN honours a native lock-screen approval without a second tap', () => {
  beforeEach(() => {
    resetHarness();
    h.settings.mcpExecEnabled = true;
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
    jest.mocked(execCommand).mockClear();
    jest.mocked(TerminalEmulator.stageInstallApk).mockClear();
  });

  afterEach(() => {
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  it.each(Object.keys(ARGS))('%s: a valid approval runs it with no dialog, audited approved_on_lock_screen, and is consumed', async (tool) => {
    const callId = nodeCrypto.randomUUID();
    const receivedAtMs = Date.now() - 60_000;
    const file = `${LOCK_APPROVALS}/${callId}`;
    h.files.set(file, await token(callId, tool, receivedAtMs + PRE_APPROVAL_MS));
    const shown: unknown[] = [];
    const unsub = useMcpApprovalStore.subscribe((s) => { if (s.current) shown.push(s.current); });
    try {
      await callTool(tool, ARGS[tool], { callId, receivedAt: new Date(receivedAtMs).toISOString() });
    } finally {
      unsub();
    }
    expect(shown).toEqual([]);
    expect(h.files.has(file)).toBe(false);
    const codes = h.audits.map((a) => a.json).filter((j) => j.kind === kindOf(tool)).map((j) => j.code);
    expect(codes.slice(0, 2)).toEqual(['approval_requested', 'approved_on_lock_screen']);
    // It went past the approval into RN's own execution path.
    if (tool === 'stage_install') expect(TerminalEmulator.stageInstallApk).toHaveBeenCalled();
    else expect(execCommand).toHaveBeenCalled();
    // Single use: the same callId's approval is not accepted again.
    expect(recordMcpLockApprovalConsumed(callId, receivedAtMs)).toBe(false);
  });

  const cases: Array<[string, (callId: string, receivedAtMs: number) => Promise<string>]> = [
    ['forged', async () => `${Date.now() + 60_000}.${'c'.repeat(64)}`],
    ['for another callId', async (_c, r) => token(nodeCrypto.randomUUID(), 'update_delivery_script', r + PRE_APPROVAL_MS)],
    ['for another tool', async (c, r) => token(c, 'stage_install', r + PRE_APPROVAL_MS)],
    ['expired', async (c) => token(c, 'update_delivery_script', Date.now() - 1)],
    ['outliving the request deadline', async (c, r) => token(c, 'update_delivery_script', r + PRE_APPROVAL_MS + 1)],
    ['under another bridge key', async (c, r) => token(c, 'update_delivery_script', r + PRE_APPROVAL_MS, 'cd'.repeat(32))],
    ['malformed', async () => 'yes'],
  ];
  it.each(cases)('an approval %s is ignored (deleted) and RN asks as before', async (_n, make) => {
    const callId = nodeCrypto.randomUUID();
    const receivedAtMs = Date.now() - 1_000;
    const file = `${LOCK_APPROVALS}/${callId}`;
    h.files.set(file, await make(callId, receivedAtMs));
    const pending = callTool('update_delivery_script', ARGS.update_delivery_script, { callId, receivedAt: new Date(receivedAtMs).toISOString() });
    await waitFor(() => current() !== null);
    expect(h.files.has(file)).toBe(false);
    expect(h.audits.map((a) => a.json.code)).toEqual(['approval_requested']);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('a replayed approval file (callId already consumed) is not honoured', async () => {
    const callId = nodeCrypto.randomUUID();
    const receivedAtMs = Date.now() - 1_000;
    expect(recordMcpLockApprovalConsumed(callId, receivedAtMs)).toBe(true);
    h.files.set(`${LOCK_APPROVALS}/${callId}`, await token(callId, 'update_delivery_script', receivedAtMs + PRE_APPROVAL_MS));
    const pending = callTool('update_delivery_script', ARGS.update_delivery_script, { callId, receivedAt: new Date(receivedAtMs).toISOString() });
    await waitFor(() => current() !== null);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
  });

  it('without the handoff token nothing runs, even with a valid lock-screen approval', async () => {
    const callId = nodeCrypto.randomUUID();
    const receivedAtMs = Date.now() - 1_000;
    h.files.set(`${LOCK_APPROVALS}/${callId}`, await token(callId, 'update_delivery_script', receivedAtMs + PRE_APPROVAL_MS));
    expect(await callTool('update_delivery_script', ARGS.update_delivery_script, { callId, handoff: 'none', receivedAt: new Date(receivedAtMs).toISOString() })).toBeNull();
    expect(h.audits).toEqual([]);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('the RN dialog for these ops waits until the 5 min approval deadline, not 90 s', async () => {
    // Received 200 s ago: past the old 90 s dialog, inside the 300 s deadline.
    const receivedAtMs = Date.now() - 200_000;
    const pending = callTool('update_delivery_script', ARGS.update_delivery_script, { receivedAt: new Date(receivedAtMs).toISOString() });
    await waitFor(() => current() !== null);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
    expect(h.audits.map((a) => a.json.code)).toEqual(['approval_requested', 'denied']);
  });
});

describe('the token format is shared with the native writer', () => {
  it('TS MAC = HMAC-SHA256(bridgeKey, domain + callId:tool:exp) (McpLockScreenApprovalTest vector)', async () => {
    const callId = '0f8e2d3c-1111-4222-8333-944455556666';
    const key = 'ab'.repeat(32);
    const expected = nodeCrypto.createHmac('sha256', key).update(`shelly-mcp-lock-approval-v1:${callId}:stage_install:1800000300000`).digest('hex');
    expect(MCP_LOCK_APPROVAL_DOMAIN).toBe('shelly-mcp-lock-approval-v1:');
    expect(await mcpLockApprovalMac(key, callId, 'stage_install', 1_800_000_300_000, nodeSha256)).toBe(expected);
    const now = 1_800_000_000_000;
    expect(await verifyMcpLockApproval(`1800000300000.${expected}`, key, callId, 'stage_install', 1_800_000_300_000, now, nodeSha256)).toBe(true);
    expect(await verifyMcpLockApproval(`1800000300000.${expected}`, key, callId, 'stage_install', 1_800_000_299_999, now, nodeSha256)).toBe(false);
    expect(await verifyMcpLockApproval(`1800000300000.${expected}`, key, callId, 'stage_install', 1_800_000_300_000, 1_800_000_300_000, nodeSha256)).toBe(false);
    expect(await verifyMcpLockApproval(`1800000300000.${expected}`, null, callId, 'stage_install', 1_800_000_300_000, now, nodeSha256)).toBe(false);
    const src = kt('McpLockScreenApproval.kt');
    expect(src).toContain('const val DOMAIN = "shelly-mcp-lock-approval-v1:"');
    expect(src).toContain('McpTypedOpDecision.hmacHex(bridgeKey, "$DOMAIN$callId:$tool:$expiresAtMs")');
  });
});

describe('deadlines per tool (5 min approval for the three write ops; others unchanged)', () => {
  it('node: the three write ops wait 470 s (300 s approval + execution), others 100 s', () => {
    expect(server.STAGE_INSTALL_RESULT_TIMEOUT_MS).toBe(470_000);
    expect(server.RESULT_TIMEOUT_MS).toBe(100_000);
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'), 'utf8');
    expect(src).toContain("(toolName === 'stage_install' || toolName === 'update_delivery_script' || toolName === 'update_pipeline_config') ? STAGE_INSTALL_RESULT_TIMEOUT_MS");
  });

  it('RN and native: the approval deadline is 300 s from receipt; the config result window matches node', () => {
    expect(bridgeSrc).toContain('const INSTALL_CLASS_PRE_APPROVAL_MS = 300_000;');
    expect(bridgeSrc).toContain('const PIPELINE_CONFIG_RESULT_TIMEOUT_MS = 470_000;');
    expect(kt('McpInstallOpDecision.kt')).toContain('const val PRE_APPROVAL_MS = 300_000L');
    // Other typed ops keep their 100 s deadline and the 90 s dialog.
    expect(bridgeSrc).toContain('const DEFAULT_APPROVAL_TIMEOUT_MS = 90_000;');
    expect(fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-typed-ops.ts'), 'utf8')).toContain('export const TYPED_REQUEST_DEADLINE_MS = 100_000;');
  });

  it('the APK asset is byte-identical to the script', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
    const b = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-mcp-server.js'));
    expect(a.equals(b)).toBe(true);
  });
});

describe('lock-screen prompt (native only; source invariants)', () => {
  const act = kt('McpLockScreenApprovalActivity.kt');
  const prompt = kt('McpLockScreenPrompt.kt');
  const consumer = kt('McpTypedOpConsumer.kt');

  it('approval only after the keyguard was dismissed; deny without authentication', () => {
    expect(act).toContain('km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback()');
    expect(act).toMatch(/override fun onDismissSucceeded\(\) \{\s*if \(e\.machine\.dismissSucceeded\(/);
    expect(act).toContain('override fun onDismissCancelled() = authFailed(e)');
    expect(act).toContain('override fun onDismissError() = authFailed(e)');
    expect(act).toContain('if (e.machine.deny(System.currentTimeMillis()))');
    expect(act).toContain('setShowWhenLocked(true)');
    expect(act).toContain('setTurnScreenOn(true)');
  });

  it('full-screen notification, checked access, the token only after APPROVED', () => {
    expect(prompt).toContain('nm.canUseFullScreenIntent()');
    expect(prompt).toContain('.setFullScreenIntent(pi, true)');
    expect(prompt).toContain('PendingIntent.FLAG_IMMUTABLE');
    const poll = consumer.slice(consumer.indexOf('private fun pollLock'), consumer.indexOf('private fun writeLockApproval'));
    expect(poll).toContain('McpInstallOpDecision.Outcome.Handoff -> {');
    expect(poll.indexOf('installAudit(w.request, "lock_screen_approved")')).toBeLessThan(poll.indexOf('writeLockApproval('));
    expect(kt('McpInstallOpDecision.kt')).toContain('McpLockScreenApproval.State.APPROVED -> Outcome.Handoff');
  });

  it('the activity is declared in the module manifest; the permission in app.config.ts', () => {
    const manifest = fs.readFileSync(path.join(KT_DIR, '..', '..', '..', '..', 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/android:name="\.McpLockScreenApprovalActivity"\s+android:excludeFromRecents="true"\s+android:exported="false"/);
    const config = fs.readFileSync(path.join(__dirname, '..', 'app.config.ts'), 'utf8');
    expect(config).toContain('"USE_FULL_SCREEN_INTENT",');
  });

  it('strings exist in en and ja', () => {
    const res = (dir: string) => fs.readFileSync(path.join(KT_DIR, '..', '..', '..', '..', 'res', dir, 'mcp_approval_strings.xml'), 'utf8');
    for (const name of ['mcp_lock_summary_stage_install', 'mcp_lock_origin', 'mcp_lock_principal', 'mcp_lock_deny', 'mcp_lock_approve', 'mcp_lock_channel_name']) {
      expect(res('values')).toContain(`name="${name}"`);
      expect(res('values-ja')).toContain(`name="${name}"`);
    }
    expect(res('values-ja')).toContain('<string name="mcp_lock_deny">拒否</string>');
    expect(res('values-ja')).toContain('<string name="mcp_lock_approve">承認</string>');
    expect(res('values-ja')).toContain('<string name="mcp_lock_origin">出所: 外部（MCP）</string>');
  });
});
