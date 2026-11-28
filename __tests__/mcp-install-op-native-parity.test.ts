/**
 * Background ingress, phase B-2: update_delivery_script and
 * update_pipeline_config are drained natively (McpTypedOpConsumer +
 * McpInstallOpDecision.kt); stage_install too since the foreground-for-
 * approval change (owner decision 2026-11-29), which also brings Shelly to the
 * front while RN is paused instead of answering `not_attended` at once
 * (native only: McpApprovalForeground.kt; the fixture models it as unavailable).
 *
 * Neither op can be approved without a tap (RN's approveRawTool: no
 * always-allow rule, no "Skip all approvals"), so native never writes; it
 * answers RN's refusals before the tap, the pre-approval timeout and
 * `not_attended`, and hands the tap case to RN while RN is live.
 *
 * The ladder fixture (fixtures/mcp-install-op-ladder-cases.json) is the
 * contract between the two implementations: this file drives the REAL RN
 * handlers (lib/mcp-server-bridge.ts updateDeliveryScriptTool /
 * updatePipelineConfigTool) with every case and checks the exact result and
 * the audit line; the JVM test McpInstallOpDecisionTest runs the Kotlin
 * decision on the same file. Native `handoff` and `not_attended` are both the
 * point where RN shows its dialog (with RN's content checks passing).
 *
 * Also: the script routes both ops to typed-requests/ (no bridge_not_live at
 * enqueue any more), and RN runs them from requests/ only with the native
 * consumer's single-use handoff token. Dummy values only.
 */
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  invalidateStageInstalls: jest.fn(() => true),
  // stage_install: RN's path resolution passes (it is RN's only, like the update ops' content checks).
  resolveStageInstallPath: jest.fn(async (p: string) => ({ path: p, sha256: 'b'.repeat(64) })),
  stageInstallGeneration: jest.fn(() => 0),
  stageInstallApk: jest.fn(),
  getStageInstallResult: jest.fn(),
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
jest.mock('@/lib/agent-manager', () => ({ updateAgent: jest.fn() }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __setMCPRequestSha256ForTests, setMCPBridgeKey, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { execCommand } from '@/hooks/use-native-exec';
import { ARTICLE_PIPELINE_FILE_MAX_BYTES } from '@/lib/agent-article-pipeline-file';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { EXAMPLE_CONFIGS } from './fixtures/article-pipeline-config';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

jest.setTimeout(30_000);

type Facts = { exec: boolean; rnLive: boolean; ageMs: number };
type Expect =
  | { outcome: 'answer'; audit: string; result: Record<string, unknown> }
  | { outcome: 'handoff' }
  | { outcome: 'not_attended' };
type Case = { name: string; tool: string; args: Record<string, unknown>; facts: Facts; expect: Expect };

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mcp-install-op-ladder-cases.json'), 'utf8')) as {
  principal: string; notAttended: { code: string; message: string }; ladder: Case[];
};
const KT_DIR = path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'java', 'expo', 'modules', 'terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-server-bridge.ts'), 'utf8');
const exec = jest.mocked(execCommand);
const current = () => useMcpApprovalStore.getState().current;
const CONFIG_TEXT = JSON.stringify({ version: 1, pipelines: [EXAMPLE_CONFIGS['example-a']] });
const auditKind = (tool: string) => (tool === 'update_pipeline_config' ? 'mcp_update_pipeline_config'
  : tool === 'stage_install' ? 'mcp_stage_install' : 'mcp_update_delivery_script');

describe('the RN ladder gives the fixture outcome for every case', () => {
  beforeEach(() => {
    resetHarness();
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
  });

  afterEach(() => {
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  it('uses the shared test principal and has enough cases', () => {
    expect(fixture.principal).toBe(TEST_PRINCIPAL);
    expect(fixture.ladder.length).toBeGreaterThanOrEqual(130);
    expect(fixture.ladder.filter((c) => c.tool === 'stage_install').length).toBeGreaterThanOrEqual(45);
  });

  it.each(fixture.ladder.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    const f = c.facts;
    h.settings.mcpExecEnabled = f.exec;
    h.appState.currentState = f.rnLive ? 'active' : 'background';
    // RN's content checks pass (they are RN's only; see McpInstallOpDecision).
    exec.mockReset().mockImplementation(async (command: string) => ({
      stdout: command.includes('/sdcard/Download/')
        ? `${JSON.stringify({ sha256: c.args.expectedSha256, text: CONFIG_TEXT })}\n`
        : '{"sha256":null,"text":null}\n',
      stderr: '',
      exitCode: 0,
    }));
    const receivedAt = new Date(Date.now() - f.ageMs).toISOString();
    const pending = callTool(c.tool, c.args, { receivedAt });
    const lines = () => h.audits.map((a) => a.json);

    if (c.expect.outcome !== 'answer') {
      // Native: handoff (RN live, fresh) or not_attended. RN: the tap dialog, after every refusal.
      await waitFor(() => current() !== null);
      expect(current()).toMatchObject({ kind: c.tool });
      expect(current()?.alwaysAllowable).toBeUndefined();
      expect(lines()).toEqual([{ kind: auditKind(c.tool), event: auditKind(c.tool), principal: TEST_PRINCIPAL, code: 'approval_requested' }]);
      useMcpApprovalStore.getState().respond(current()!.id, 'deny');
      expect(await pending).toMatchObject(c.tool === 'stage_install'
        ? { ok: false, error: 'denied by user (or timed out waiting for a response)' }
        : { ok: false, code: 'denied' });
      return;
    }
    const r = await pending;
    expect(current()).toBeNull();
    expect(r).toEqual(c.expect.result);
    expect(lines()).toEqual([{ kind: auditKind(c.tool), event: auditKind(c.tool), principal: TEST_PRINCIPAL, code: c.expect.audit }]);
    // Nothing touched the disk for an answer before the tap except the pipeline's read-only checks.
    for (const call of exec.mock.calls) expect(String(call[0])).not.toMatch(/\bmv -f\b/);
  });
});

describe('the Kotlin decision names the same constants and messages as the TS sources', () => {
  const src = kt('McpInstallOpDecision.kt');

  it('messages appear verbatim in both', () => {
    for (const m of [
      'cancelled: pending MCP requests were revoked',
      'exec/write tools are disabled (Settings → Agents → MCP: Allow exec/write)',
      'stagedPath must name a .js file directly under /sdcard/Download',
      'stagedPath must name a .json file directly under /sdcard/Download',
      'expectedSha256 must be 64 lowercase hex digits',
      'expectedBytes must be an integer from 1 to 1048576',
      'rebuild must be an array of agentId and pipelineId pairs',
      'rebuild must contain at most 33 pairs',
      'timed out: the result window expired before the update could be applied',
      'path must be an absolute .apk file path without control characters',
    ]) {
      expect(bridgeSrc).toContain(m);
      expect(src).toContain(`"${m}"`);
    }
    // The pipeline size message is a template in TS.
    expect(bridgeSrc).toContain('`expectedBytes must be an integer from 1 to ${ARTICLE_PIPELINE_FILE_MAX_BYTES}`');
    expect(src).toContain(`"expectedBytes must be an integer from 1 to ${ARTICLE_PIPELINE_FILE_MAX_BYTES}"`);
    expect(src).toContain(`"${fixture.notAttended.message}"`);
    // stage_install's dot-dot message (escaped quotes in Kotlin).
    expect(bridgeSrc).toContain(`return refuse('invalid_path', 'path must not contain ".."');`);
    expect(src).toContain(String.raw`"path must not contain \"..\""`);
    // stage_install's refuse() keeps `code` only for these two.
    expect(bridgeSrc).toContain("return code === 'digest_changed' || code === 'revoked'");
    expect(src).toContain('setOf("digest_changed", "revoked", "not_attended", "handoff_failed")');
  });

  it('constants', () => {
    expect(bridgeSrc).toContain('const INSTALL_CLASS_PRE_APPROVAL_MS = 300_000;');
    expect(src).toContain('const val PRE_APPROVAL_MS = 300_000L');
    expect(ARTICLE_PIPELINE_FILE_MAX_BYTES).toBe(262_144);
    expect(src).toContain('const val PIPELINE_MAX_BYTES = 262_144L');
    expect(src).toContain('const val DELIVERY_MAX_BYTES = 1_048_576L');
    expect(bridgeSrc).toContain('if (rebuild.length > 33)');
    expect(src).toContain('const val MAX_REBUILD_PAIRS = 33');
    // The path patterns, as in the TS source (Regex.matches = whole input).
    expect(bridgeSrc).toContain(String.raw`/^\/sdcard\/Download\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`);
    expect(bridgeSrc).toContain(String.raw`/^\/sdcard\/Download\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/`);
    expect(src).toContain(String.raw`Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.js")`);
    expect(src).toContain(String.raw`Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.json")`);
  });

  it('the consumer routes all three ops to the decision, with the exec setting RN mirrors', () => {
    const consumer = kt('McpTypedOpConsumer.kt');
    expect(src).toContain('val OPS: Set<String> = setOf(OP_DELIVERY_SCRIPT, OP_PIPELINE_CONFIG, OP_STAGE_INSTALL)');
    expect(src).toContain('const val OP_STAGE_INSTALL = "stage_install"');
    expect(consumer).toContain('if (request.tool in McpInstallOpDecision.OPS) {');
    expect(consumer).toContain('override fun execOn(): Boolean = svcSteps.execOn()');
    expect(consumer).toContain('McpServerSupervisor.execWanted() && (McpAutostartStore.read(app)?.exec == true)');
  });

  it('native never writes the script or the config', () => {
    expect(src).not.toMatch(/\bFile\(|Os\.|rename|writeBytes|execCommand/);
    const consumer = kt('McpTypedOpConsumer.kt');
    const body = consumer.slice(consumer.indexOf('private fun processInstallOp'), consumer.indexOf('private val installSteps'));
    expect(body).not.toMatch(/article-pipelines|article-delivery|\/sdcard/);
  });
});

describe('RN runs these ops from requests/ only with the native handoff token', () => {
  beforeEach(() => {
    resetHarness();
    h.settings.mcpExecEnabled = true;
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
    exec.mockReset().mockImplementation(async (command: string) => ({
      stdout: command.includes('/sdcard/Download/')
        ? `${JSON.stringify({ sha256: 'ab'.repeat(32), text: CONFIG_TEXT })}\n`
        : '{"sha256":null,"text":null}\n',
      stderr: '',
      exitCode: 0,
    }));
  });

  afterEach(() => {
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  it.each([
    ['update_delivery_script', { stagedPath: '/sdcard/Download/d.js', expectedSha256: 'ab'.repeat(32), expectedBytes: 3 }],
    ['update_pipeline_config', { stagedPath: '/sdcard/Download/c.json', expectedSha256: 'ab'.repeat(32), expectedBytes: 3, rebuild: [] }],
    ['stage_install', { path: '/storage/emulated/0/Download/a.apk' }],
  ] as const)('%s: no token or a forged one is dropped unanswered; a valid one is asked', async (tool, args) => {
    for (const handoff of ['none', 'forged'] as const) {
      expect(await callTool(tool, args, { handoff })).toBeNull();
    }
    expect(h.audits).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(h.logs.filter((l) => l.includes('no valid handoff token'))).toHaveLength(2);
    const pending = callTool(tool, args, { handoff: 'valid' });
    await waitFor(() => current() !== null);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    // stage_install's refuse() carries no code for `denied`.
    expect(await pending).toMatchObject(tool === 'stage_install'
      ? { ok: false, error: 'denied by user (or timed out waiting for a response)' }
      : { ok: false, code: 'denied' });
  });

  it('stage_install needs the token too (it reaches requests/ only by the native handoff now)', () => {
    expect(bridgeSrc).not.toContain("request.tool !== 'stage_install' && !(await consumeHandoffToken");
  });
});

describe('script routing', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-install-route-'));
    for (const d of ['requests', 'typed-requests', 'raw-requests', 'results']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ingress = { principal: TEST_PRINCIPAL, clientNameSelfReported: 'c' };

  it.each([
    ['update_delivery_script', { stagedPath: '/sdcard/Download/d.js', expectedSha256: 'ab'.repeat(32), expectedBytes: 3 }],
    ['update_pipeline_config', { stagedPath: '/sdcard/Download/c.json', expectedSha256: 'ab'.repeat(32), expectedBytes: 3, rebuild: [] }],
    ['stage_install', { path: '/storage/emulated/0/Download/a.apk' }],
  ] as const)('%s goes to typed-requests/ (even with a paused heartbeat) and reads its answer from results/', async (tool, args) => {
    expect(server.requestDirName(tool)).toBe('typed-requests');
    expect(server.TYPED_REQUEST_TOOLS.has(tool)).toBe(true);
    fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), '0');
    const callTool2 = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool2(tool, args, ingress);
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'typed-requests', typed[0]), 'utf8'));
    expect(body).toMatchObject({ tool, args, ingress: { kind: 'mcp', principal: TEST_PRINCIPAL } });
    expect(body.mac).toBe(server.requestMac(TEST_BRIDGE_KEY, (({ mac: _m, ...rest }) => rest)(body)));
    const answer = { ok: false, error: fixture.notAttended.message, code: 'not_attended' };
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify(answer));
    await expect(pending).resolves.toEqual(answer);
  });

  it('stage_install keeps its long result wait on the typed path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'), 'utf8');
    expect(src).toContain("(toolName === 'stage_install' || toolName === 'update_delivery_script' || toolName === 'update_pipeline_config') ? STAGE_INSTALL_RESULT_TIMEOUT_MS");
  });

  it('the APK asset is byte-identical to the script', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
    const b = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-mcp-server.js'));
    expect(a.equals(b)).toBe(true);
  });
});

describe('foreground for approval (native only; source invariants)', () => {
  const fg = kt('McpApprovalForeground.kt');
  const decision = kt('McpInstallOpDecision.kt');
  const consumer = kt('McpTypedOpConsumer.kt');
  const res = (dir: string) => fs.readFileSync(path.join(KT_DIR, '..', '..', '..', '..', 'res', dir, 'mcp_approval_strings.xml'), 'utf8');

  it('never on the lock screen, and only with the overlay grant', () => {
    expect(fg).toContain('!pm.isInteractive || km.isKeyguardLocked) return McpInstallOpDecision.FG_LOCKED');
    expect(fg).toContain('Settings.canDrawOverlays(context)');
  });

  it('a small non-focusable overlay on the default display, the activity started after it was drawn', () => {
    expect(fg).toContain('WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY');
    expect(fg).toContain('WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL');
    expect(fg).toContain('WindowManager.LayoutParams.WRAP_CONTENT');
    expect(fg).toContain('dm?.getDisplay(Display.DEFAULT_DISPLAY)');
    expect(fg).toContain('options.launchDisplayId = Display.DEFAULT_DISPLAY');
    expect(fg).toContain('Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT');
    expect(fg).toContain('addOnDrawListener');
    expect(fg).toContain('R.string.mcp_approval_foreground_overlay');
  });

  it('the overlay text exists in en and ja', () => {
    expect(res('values')).toContain('<string name="mcp_approval_foreground_overlay">Shelly: approval needed</string>');
    expect(res('values-ja')).toContain('<string name="mcp_approval_foreground_overlay">Shelly: 承認が必要です</string>');
  });

  it('nothing on this path approves or executes: the result is still a handoff to RN or not_attended', () => {
    expect(fg).not.toMatch(/approveRawTool|writeResult|execCommand|McpAlwaysAllowStore/);
    const poll = consumer.slice(consumer.indexOf('private fun pollForeground'), consumer.indexOf('private fun revokeForegroundWaits'));
    expect(poll).toContain('McpInstallOpDecision.Outcome.Handoff -> handOff(w.request, w.name, w.claimed, null, install = true)');
    expect(poll).toContain('is McpInstallOpDecision.Outcome.Answer -> installAnswer(w.request, w.claimed, outcome)');
    expect(poll).toContain('McpApprovalForeground.hide(w.overlay)');
  });

  it('timeouts: 15 s wait, 3 s before the approval deadline, 200 ms polls', () => {
    expect(decision).toContain('const val FOREGROUND_WAIT_MS = 15_000L');
    expect(decision).toContain('const val FOREGROUND_DEADLINE_MARGIN_MS = 3_000L');
    expect(decision).toContain('const val FOREGROUND_POLL_MS = 200L');
    expect(decision).toContain('minOf(nowMs + FOREGROUND_WAIT_MS, receivedAtMs + PRE_APPROVAL_MS - FOREGROUND_DEADLINE_MARGIN_MS)');
  });

  it('the overlay permission is declared', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('android.permission.SYSTEM_ALERT_WINDOW');
  });
});
