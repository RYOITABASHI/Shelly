/**
 * Shared TS/Kotlin fixtures for the headless typed-op consumer (PR 6,
 * McpTypedOpConsumer.kt). The JVM tests McpAgentBindingTest /
 * McpTypedOpPolicyTest / McpTypedOpConsumerTest read the SAME files:
 *  - mcp-agent-binding-cases.json: bind = sha256(canonicalJson(projection)),
 *    so a rule created in RN (agentBindingHash) matches what native computes
 *    from ~/.shelly/agents/<id>.json;
 *  - mcp-typed-op-capabilities.json: the action-type → capability table and
 *    the native step-7 subset (clearable / policy_denied / undecidable) —
 *    "clearable" must never be something the TS classifier refuses, and
 *    "policy_denied" must be something it refuses too;
 *  - mcp-signed-request-cases.json: the queue request MAC.
 * Dummy values only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { actionTypeCapabilities, hasSideEffect, type PolicyCapability } from '@/lib/agent-action-policy';
import { canonicalJson, mcpHandoffToken, mcpRequestMac, verifyMcpHandoffToken } from '@/lib/mcp-request-auth';
import { AGENT_BIND_FIELDS, agentBindingHash, agentBindingProjection, classifyRunAgentDeny, TYPED_OP_ERROR_CODES } from '@/lib/mcp-typed-ops';
import { nodeSha256 } from './helpers/mcp-signed-request';

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as T;
}

type BindCase = { name: string; agent: Record<string, unknown>; canonical: string; bind: string };
const binding = fixture<{ fields: string[]; cases: BindCase[] }>('mcp-agent-binding-cases.json');

describe('binding projection fixture (TS side)', () => {
  it('lists exactly the PR 5 bind fields', () => {
    expect(binding.fields).toEqual([...AGENT_BIND_FIELDS]);
  });

  it.each(binding.cases.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    expect(canonicalJson(agentBindingProjection(c.agent))).toBe(c.canonical);
    expect(await agentBindingHash(c.agent, nodeSha256)).toBe(c.bind);
  });

  it('an in-memory agent with nested undefined hashes like its JSON on disk', async () => {
    const inMemory = { prompt: 'p', action: { type: 'draft', webhookUrl: undefined }, memory: { n: Number.NaN } };
    const onDisk = JSON.parse(JSON.stringify(inMemory));
    expect(await agentBindingHash(inMemory as never, nodeSha256)).toBe(await agentBindingHash(onDisk, nodeSha256));
  });

  it('runtime fields do not change the hash; an edit does', async () => {
    const [minimal, runtime] = binding.cases;
    expect(runtime.bind).toBe(minimal.bind);
    expect(await agentBindingHash({ ...minimal.agent, prompt: 'changed' }, nodeSha256)).not.toBe(minimal.bind);
  });
});

type CapCase = { actionType: string; intentMode?: string; command?: string; capabilities?: string[]; sideEffecting: boolean };
type PolicyCase = { name: string; actions: Record<string, unknown>[]; policy: Record<string, any> | null; expected: 'clearable' | 'policy_denied' | 'undecidable' };
const caps = fixture<{ readOnlyCapabilities: string[]; cases: CapCase[]; policyCases: PolicyCase[] }>('mcp-typed-op-capabilities.json');

describe('step-7 capability table fixture (TS side)', () => {
  it.each(caps.cases.map((c) => [`${c.actionType || '(empty)'} ${c.intentMode ?? ''} ${c.command ?? ''}`, c] as const))('%s', (_n, c) => {
    const got = actionTypeCapabilities(c.actionType, { command: c.command ?? null, intentMode: c.intentMode ?? null });
    if (c.capabilities) expect(got).toEqual(c.capabilities);
    expect(hasSideEffect(got)).toBe(c.sideEffecting);
  });

  it('the read-only set is the policy module one', () => {
    for (const cap of caps.readOnlyCapabilities) expect(hasSideEffect([cap as PolicyCapability])).toBe(false);
  });
});

describe('native step-7 subset never disagrees with the TS classifier in the unsafe direction', () => {
  it.each(caps.policyCases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    if (c.expected === 'undecidable') return; // RN decides; nothing to compare
    const rules = c.policy?.userPolicy?.rules ?? [];
    const result = classifyRunAgentDeny({
      agentId: 'agent-1',
      agent: { action: undefined, actions: c.actions as never },
      halted: false,
      tainted: false,
      policy: { data: { rules, trust: { allows: [], counts: {} } }, unavailable: false } as never,
      homeDir: '/home/test',
    });
    if (c.expected === 'clearable') {
      expect(result.refusal).toBeNull();
      expect(result.ruleEligible).toBe(true);
    } else {
      expect(result.refusal?.code).toBe('policy_denied');
    }
  });
});

type ReqCase = { name: string; request: Record<string, unknown>; macValid: boolean };
const requests = fixture<{ bridgeKey: string; cases: ReqCase[]; handoffTokens: { callId: string; token: string }[] }>('mcp-signed-request-cases.json');

describe('handoff token fixture (TS side)', () => {
  it.each(requests.handoffTokens.map((t) => [t.callId, t] as const))('%s', async (_n, t) => {
    expect(await mcpHandoffToken(requests.bridgeKey, t.callId, nodeSha256)).toBe(t.token);
    expect(await verifyMcpHandoffToken(t.token, requests.bridgeKey, t.callId, nodeSha256)).toBe(true);
    expect(await verifyMcpHandoffToken(t.token, requests.bridgeKey, 'other-call', nodeSha256)).toBe(false);
    expect(await verifyMcpHandoffToken(t.token, 'b'.repeat(64), t.callId, nodeSha256)).toBe(false);
  });
});

describe('signed request fixture (TS side)', () => {
  it.each(requests.cases.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    const { mac, ...unsigned } = c.request;
    expect((await mcpRequestMac(requests.bridgeKey, unsigned, nodeSha256)) === mac).toBe(c.macValid);
  });
});

// Structural pins for the single-consumer invariant (Kotlin is compiled only
// by CI's assembleRelease; the JVM tests are not run there yet).
describe('headless consumer wiring (structural)', () => {
  const kt = (name: string) =>
    fs.readFileSync(path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator', name), 'utf8');
  const consumer = kt('McpTypedOpConsumer.kt');
  const move = kt('McpHandoffMove.kt');
  const launcher = kt('McpRunLauncher.kt');
  const supervisor = kt('McpServerSupervisor.kt');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'lib/mcp-server-bridge.ts'), 'utf8');

  it('RN never reads typed-requests/ or claimed/', () => {
    expect(bridge).not.toMatch(/typed-requests|claimed/);
  });

  it('the launcher sends no origin and no tainted extra, and writes the ticket first', () => {
    expect(launcher).not.toMatch(/putExtra\(TerminalSessionService\.EXTRA_RUN_ORIGIN/);
    expect(launcher).not.toMatch(/putExtra\(TerminalSessionService\.EXTRA_TAINTED/);
    expect(launcher.indexOf('acceptForMcp')).toBeLessThan(launcher.indexOf('startForegroundService'));
  });

  it('the consumer touches requests/ only through the one no-overwrite handoff move, after the token', () => {
    expect(consumer.match(/requestsDir/g)).toHaveLength(2); // declaration + handOff
    const handOff = consumer.slice(consumer.indexOf('private fun handOff'), consumer.indexOf('// ── Facts'));
    expect(handOff).toMatch(/audit\("mcp_typed_op_handed_off"[\s\S]*if \(writeHandoffToken\(token, request\.callId\)\) McpHandoffMove\.move\(claimed\.path, dest\.path, handoffFs\) else null/);
    // After a successful move nothing is written.
    expect(handOff).toMatch(/if \(result is McpHandoffMove\.Result\.Moved\) \{[\s\S]*?return\s*\}/);
    // Results are published create-if-absent too.
    const write = consumer.slice(consumer.indexOf('private fun writeResult'), consumer.indexOf('private fun writeHandoffToken'));
    expect(write).toMatch(/Os\.open\(\s*final\.path,\s*OsConstants\.O_WRONLY or OsConstants\.O_CREAT or OsConstants\.O_EXCL/);
    expect(write).not.toMatch(/Os\.rename/);
    // No hard links anywhere in the consumer (SELinux denies apps `link` on app_data_file: build 2964).
    expect(consumer).not.toMatch(/Os\.link\(/);
  });

  // Build 2964: the hard-link handoff failed on device and was reported as not_attended.
  it('a failed handoff move is refused handoff_failed with its errno audited, never not_attended', () => {
    const handOff = consumer.slice(consumer.indexOf('private fun handOff'), consumer.indexOf('// ── Facts'));
    expect(handOff).not.toMatch(/NOT_ATTENDED/);
    expect(handOff).toMatch(/audit\("mcp_typed_op_handoff_failed", agentId, request\.principal, why\)/);
    expect(handOff).toMatch(/McpHandoffMove\.refusalAfterFailure\(lexists\(claimed\), lexists\(dest\)\)[\s\S]*Os\.remove\(token\.path\)[\s\S]*refuse\(request, claimed, refusal/);
    expect(move).toMatch(/if \(claimedStillThere && !destExists\) McpTypedOpDecision\.HANDOFF_FAILED else null/);
    expect(kt('IngressAuditWriter.kt')).toMatch(/NATIVE_MCP_KINDS: Set<String> = setOf\([^)]*"mcp_typed_op_handoff_failed"/);
  });

  it('the handoff move is renameat2(RENAME_NOREPLACE); the checked rename only when that is unavailable', () => {
    const body = move.slice(move.indexOf('fun move('), move.indexOf('fun refusalAfterFailure'));
    // EEXIST = taken; only UNAVAILABLE / ENOSYS / EINVAL reach the fallback; any other errno fails.
    expect(body).toMatch(/0 -> return Result\.Moved\(ROUTE_NOREPLACE\)\s*EEXIST -> return Result\.Taken\s*UNAVAILABLE, ENOSYS, EINVAL -> Unit[^\n]*\s*else -> return Result\.Failed\(r, ROUTE_NOREPLACE\)/);
    // The fallback checks the destination before renaming.
    expect(body.indexOf('fs.exists(dst)')).toBeGreaterThan(-1);
    expect(body.indexOf('fs.exists(dst)')).toBeLessThan(body.indexOf('fs.rename(src, dst)'));
    expect(consumer).toMatch(/Build\.VERSION\.SDK_INT < 30\) return McpHandoffMove\.UNAVAILABLE/);
    const jni = fs.readFileSync(path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/jni/shelly-exec.c'), 'utf8');
    expect(jni).toMatch(/Java_expo_modules_terminalemulator_ShellyJNI_renameNoReplace[\s\S]*syscall\(__NR_renameat2, AT_FDCWD, src, AT_FDCWD, dst, RENAME_NOREPLACE\)/);
    expect(kt('ShellyJNI.kt')).toMatch(/external fun renameNoReplace\(src: String, dst: String\): Int/);
  });

  // Every code a native refusal can carry is in the TS vocabulary and is shown
  // by both copies of the MCP script as `Error: [<code>] …`.
  it('every Kotlin typed-op refusal code is a TYPED_OP_ERROR_CODES entry the script renders', () => {
    const decision = kt('McpTypedOpDecision.kt');
    const codes = [...decision.matchAll(/Refusal\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes).toEqual(expect.arrayContaining(['not_attended', 'handoff_failed']));
    for (const code of codes) expect(TYPED_OP_ERROR_CODES).toContain(code);
    const scripts = ['scripts/shelly-mcp-server.js', 'modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js'].map((p) =>
      fs.readFileSync(path.join(__dirname, '..', p), 'utf8'),
    );
    expect(scripts[0]).toBe(scripts[1]);
    const re = /const RESULT_CODE_RE = \/(.+)\/;/.exec(scripts[0]);
    expect(re).not.toBeNull();
    const resultCodeRe = new RegExp(re![1]);
    for (const code of TYPED_OP_ERROR_CODES) expect({ code, ok: resultCodeRe.test(code) }).toEqual({ code, ok: true });
  });

  it('stop() waits on the commit lock the launch runs under', () => {
    const stop = consumer.slice(consumer.indexOf('fun stop(clearPending'), consumer.indexOf('private fun startObserver'));
    expect(stop).toMatch(/stopped = true\s*\/\/[\s\S]*?synchronized\(commitLock\) \{ \}/);
    const exec = consumer.slice(consumer.indexOf('private fun execute'), consumer.indexOf('private fun recheck'));
    expect(exec).toMatch(/synchronized\(commitLock\) \{\s*McpRunLauncher\.launch/);
    expect(exec).toMatch(/!isCurrent\(\)\) refusal = McpTypedOpDecision\.REVOKED/);
    expect(exec).toMatch(/McpTypedOpDecision\.isExpired\(request\.receivedAtMs/);
  });

  it('the audit line is written inside beforeWrite, before the launch, and a failed write refuses', () => {
    const exec = consumer.slice(consumer.indexOf('private fun execute'), consumer.indexOf('private fun recheck'));
    expect(exec).toMatch(/McpRunLauncher\.launch\([\s\S]*appendNativeMcpLine\(app, "mcp_typed_op_executing"[\s\S]*AUDIT_FAILED/);
  });

  it('the orphan sweep deletes, never answers or re-runs', () => {
    const sweep = consumer.slice(consumer.indexOf('private fun sweepOrphans'), consumer.indexOf('// ── One request'));
    expect(sweep).not.toMatch(/writeResult|process\(|launch/);
    expect(sweep).toMatch(/isOrphan/);
  });

  // Gate finding 3: replay protection lasts the whole validity window.
  it('the consumer keeps consumed callIds by validity window (McpReplayGuard), never by count, and fails closed when full', () => {
    expect(consumer).toMatch(/private val seen = McpReplayGuard\(\)/);
    expect(consumer).not.toMatch(/seen\.remove\(|MAX_SEEN|LinkedHashSet/);
    const proc = consumer.slice(consumer.indexOf('private fun process'), consumer.indexOf('private fun refuse'));
    expect(proc).toMatch(/if \(!seen\.admit\(request\.callId, request\.receivedAtMs, now\)\) \{[\s\S]*?"replay_capacity"[\s\S]*?delete\(claimed\)\s*return\s*\}/);
    // Admitted before any decision or launch.
    expect(proc.indexOf('seen.admit(')).toBeLessThan(proc.indexOf('McpTypedOpDecision.decide('));
  });

  // Gate finding 4: the launch grant survives to the actual start.
  it('both launch paths carry a grant; the service re-checks it under the ticket lock before running', () => {
    const service = kt('TerminalSessionService.kt');
    const module = kt('TerminalEmulatorModule.kt');
    const tickets = kt('McpRunTickets.kt');
    expect(service).toMatch(/McpRunTickets\.markRunning\(applicationContext, mcpRunHandle, agentId, mcpPrincipal\) \{\s*McpRunLauncher\.authorizeStart\(applicationContext, mcpRunHandle, agentId, mcpPrincipal\) \{ mcpActionsPreapproved = it \}\s*\}/);
    expect(tickets).toMatch(/fun markRunning\(context: Context, handle: String, agentId: String, principal: String\?, authorize: \(\) -> String\?\): Boolean/);
    const mark = tickets.slice(tickets.indexOf('fun markRunning('), tickets.indexOf('fun markEndedWithoutRun('));
    expect(mark.indexOf('authorize()')).toBeGreaterThan(mark.indexOf('mayStart('));
    expect(mark.indexOf('authorize()')).toBeLessThan(mark.indexOf('withRunning('));
    // The launcher checks and registers the grant inside acceptForMcp (ticket lock), before the intent.
    const launch = launcher.slice(launcher.indexOf('fun launch('), launcher.indexOf('fun authorizeStart('));
    expect(launch).toMatch(/acceptForMcp\([^)]*\) \{[\s\S]*?authorizeNow\([\s\S]*?McpRunAuthorization\.register\(handle, grant[\s\S]*?beforeWrite\(\)/);
    // Every grant: typed ops ON; an agent with actions: the very policy file RN
    // evaluated (pin); a rule-based grant of such an agent: a sealed policy.
    const auth = kt('McpRunAuthorization.kt');
    expect(auth).toMatch(/if \(!f\.typedOpsOn\) return McpRunTickets\.REASON_DISABLED/);
    expect(auth).toMatch(/if \(f\.declaresActions\) \{\s*if \(grant\.policyPin == null \|\| f\.policyPin == null \|\| f\.policyPin != grant\.policyPin\) return[^\n]*\n\s*if \(grant\.ruleId != null && !f\.policyVerified\) return/);
    expect(launcher).toMatch(/AgentPolicySeal\.read\(context\)[\s\S]*?McpRunAuthorization\.isSealed\(/);
    expect(module).toMatch(/policyPin = policyPin,/);
    expect(launch.indexOf('McpRunAuthorization.register')).toBeLessThan(launch.indexOf('startForegroundService'));
    expect(consumer).toMatch(/McpRunLauncher\.launch\(app, x\.agentId, handle, request\.principal, x\.requestId, grant\)/);
    expect(module).toMatch(/McpRunLauncher\.launch\(requireReactContext\(\), agentId, runHandle, principal, requestId, grant\)/);
    expect(module).toMatch(/AsyncFunction\("runAgentForMcp"\) \{ agentId: String, runHandle: String, principal: String, requestId: String\?, deadlineMs: Double\?, approvedBind: String\?, ruleId: String\?, policyPin: String\? ->/);
  });

  it('the supervisor owns exactly one consumer and replaces it on a new key', () => {
    expect(supervisor).toMatch(/@Volatile private var typedOpConsumer: McpTypedOpConsumer\?/);
    expect(supervisor.match(/McpTypedOpConsumer\(app, /g)).toHaveLength(1);
    // stop(): the consumer goes with the server (pending typed requests cleared).
    const stop = supervisor.slice(supervisor.indexOf('fun stop(context'), supervisor.indexOf('fun requestAutostart'));
    expect(stop).toMatch(/syncTypedOpConsumerLocked\(app\)/);
  });
});
