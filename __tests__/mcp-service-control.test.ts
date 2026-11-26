jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseServiceControlResult, SERVICE_CONTROL_ACTIONS, SERVICE_CONTROL_BIND_DOMAIN, SERVICE_CONTROL_TARGET_RE, SERVICE_IDS,
  SERVICE_STATES, serviceControlRuleBind, serviceControlRuleLabel, serviceControlRuleTarget, validateServiceControlArgs,
} from '@/lib/mcp-service-control';
import { isTypedOp } from '@/lib/mcp-always-allow';
import { nodeSha256 } from './helpers/mcp-signed-request';

const KT_DIR = join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const registryKt = readFileSync(join(KT_DIR, 'ManagedServices.kt'), 'utf8');
const serverJs = readFileSync(join(__dirname, '..', 'scripts/shelly-mcp-server.js'), 'utf8');

describe('validateServiceControlArgs', () => {
  it('accepts exactly {action, serviceId} from the closed sets', () => {
    for (const action of SERVICE_CONTROL_ACTIONS) {
      for (const serviceId of SERVICE_IDS) {
        expect(validateServiceControlArgs({ action, serviceId })).toEqual({ ok: true, args: { action, serviceId } });
      }
    }
  });

  it.each([
    [null],
    [[]],
    ['start'],
    [{ action: 'start' }],
    [{ serviceId: 'article-delivery' }],
    [{ action: 'restart', serviceId: 'article-delivery' }],
    [{ action: 'start', serviceId: 'Article-Delivery' }],
    [{ action: 'start', serviceId: '../agents' }],
    [{ action: 'start', serviceId: 'article-delivery', command: 'rm -rf ~' }],
    [{ action: 'start', serviceId: 'article-delivery', path: '/sdcard/x.js' }],
    [{ action: 'start', serviceId: 'article-delivery', args: ['loop'] }],
  ])('refuses %j', (args) => {
    expect(validateServiceControlArgs(args)).toMatchObject({ ok: false, code: 'invalid_params' });
  });
});

describe('parseServiceControlResult', () => {
  const base = {
    code: 'status', serviceId: 'article-delivery', state: 'running', pid: 6293,
    startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true, exitCode: null, exitedAt: null,
  };

  it('parses the native map', () => {
    expect(parseServiceControlResult(base, 'article-delivery')).toEqual({
      code: 'status',
      status: { serviceId: 'article-delivery', state: 'running', pid: 6293, startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true },
    });
  });

  it('keeps the exit of a dead service', () => {
    const dead = { ...base, state: 'dead', pid: null, supervised: false, exitCode: 1, exitedAt: 1_764_000_200_000 };
    expect(parseServiceControlResult(dead, 'article-delivery')?.status).toMatchObject({ state: 'dead', pid: null, exitCode: 1, exitedAt: 1_764_000_200_000 });
  });

  it.each([
    ['unknown code', { code: 'restarted' }],
    ['other service', { serviceId: 'council-facade' }],
    ['unknown state', { state: 'zombie' }],
    ['pid 1', { pid: 1 }],
    ['float pid', { pid: 1.5 }],
    ['negative time', { startedAt: -1 }],
    ['string heartbeat', { lastHeartbeatAt: '123' }],
    ['missing supervised', { supervised: undefined }],
    ['float exit', { exitCode: 0.5 }],
  ])('refuses %s', (_name, override) => {
    expect(parseServiceControlResult({ ...base, ...override }, 'article-delivery')).toBeNull();
  });

  it('refuses a non-object', () => {
    expect(parseServiceControlResult('{"code":"status"}', 'article-delivery')).toBeNull();
    expect(parseServiceControlResult(null, 'article-delivery')).toBeNull();
  });
});

describe('always-allow readiness (not enabled in v1)', () => {
  it('names one service and one action', () => {
    expect(serviceControlRuleTarget({ action: 'stop', serviceId: 'article-delivery' })).toBe('service:article-delivery:stop');
    for (const action of SERVICE_CONTROL_ACTIONS) {
      for (const serviceId of SERVICE_IDS) {
        expect(SERVICE_CONTROL_TARGET_RE.test(serviceControlRuleTarget({ action, serviceId }))).toBe(true);
      }
    }
    expect(SERVICE_CONTROL_TARGET_RE.test('service:article-delivery:*')).toBe(false);
  });

  it('is an always-allow op (S2), with the same target pattern on both sides', () => {
    expect(isTypedOp('service_control')).toBe(true);
    const storeKt = readFileSync(join(KT_DIR, 'McpAlwaysAllowStore.kt'), 'utf8');
    expect(storeKt).toContain('val TYPED_OPS: Set<String> = setOf("run_agent", "service_control", "request_pipeline_refire", IngressDecision.OP_SUBMIT_INSTRUCTION, IngressDecision.OP_PUT_STREAM_FEED)');
    expect(storeKt).toContain(`"service_control" to Regex("${SERVICE_CONTROL_TARGET_RE.source}")`);
  });

  it('binds a rule to a versioned value derived from the target only', async () => {
    const a = { action: 'start', serviceId: 'article-delivery' } as const;
    const bind = await serviceControlRuleBind(a, nodeSha256);
    expect(bind).toMatch(/^[0-9a-f]{64}$/);
    expect(SERVICE_CONTROL_BIND_DOMAIN).toBe('shelly-service-control-bind-v2:');
    const expected = createHash('sha256').update(`${SERVICE_CONTROL_BIND_DOMAIN}service:article-delivery:start`).digest('hex');
    expect(bind).toBe(expected);
    expect(await serviceControlRuleBind({ action: 'stop', serviceId: 'article-delivery' }, nodeSha256)).not.toBe(bind);
    expect(serviceControlRuleLabel(a)).toBe('start article-delivery');
  });
});

describe('parity with the native registry and the server', () => {
  it('lists the same service ids as ManagedServices.REGISTRY', () => {
    const ids = [...registryKt.matchAll(/^ {8}"([a-z0-9-]+)" to Spec\(/gm)].map((m) => m[1]);
    expect(ids).toEqual([...SERVICE_IDS]);
  });

  it('lists the same actions and states', () => {
    expect(registryKt).toContain('val ACTIONS: Set<String> = setOf("start", "status", "stop")');
    const states = [...registryKt.matchAll(/^ {8}[A-Z_]+\("([a-z_]+)"\),?$/gm)].map((m) => m[1]);
    expect(states).toEqual([...SERVICE_STATES]);
  });

  // Kotlin unit tests run only in CI; this pins the launch form on the JS side too.
  // The bundled node lives in the app's data dir and exec'ing it directly is
  // refused (W^X: exit 126 "termux-libs/node: Permission denied" on the device,
  // 2026-11-25), so the service is started through the system linker exactly
  // like AgentRuntime's executor launch.
  it('starts node through /system/bin/linker64, never by exec node', () => {
    expect(registryKt).toContain('const val LINKER64 = "/system/bin/linker64"');
    expect(registryKt).toContain('val node = "$libPath/node"');
    expect(registryKt).toContain(
      `sb.append("exec ").append(LINKER64).append(' ').append(shQuote(node)).append(' ').append(shQuote(script))`,
    );
    expect(registryKt).toContain('sb.append("[ -f ").append(shQuote(node)).append(" ] || exit 127\\n")');
    expect(registryKt).not.toContain('exec node ');
    expect(registryKt).not.toContain('command -v node');
    const agentRuntimeKt = readFileSync(join(KT_DIR, 'AgentRuntime.kt'), 'utf8');
    expect(agentRuntimeKt).toContain('append(" && unset LD_PRELOAD && /system/bin/linker64 ")');
    expect(agentRuntimeKt).toContain('append(shellQuote("$libPath/node"))');
  });

  it('offers the same enums in the MCP tool schema', () => {
    expect(serverJs).toContain(`action: { type: 'string', enum: ['start', 'status', 'stop'] }`);
    expect(serverJs).toContain(`serviceId: { type: 'string', enum: ['article-delivery', 'council-facade'] }`);
  });
});
