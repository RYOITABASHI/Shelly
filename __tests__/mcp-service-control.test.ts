jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseServiceControlResult, SERVICE_CONTROL_ACTIONS, SERVICE_CONTROL_TARGET_RE, SERVICE_IDS, SERVICE_STATES,
  serviceControlRuleTarget, validateServiceControlArgs,
} from '@/lib/mcp-service-control';
import { isTypedOp } from '@/lib/mcp-always-allow';

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

  it('is not an always-allow op yet', () => {
    expect(isTypedOp('service_control')).toBe(false);
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

  it('offers the same enums in the MCP tool schema', () => {
    expect(serverJs).toContain(`action: { type: 'string', enum: ['start', 'status', 'stop'] }`);
    expect(serverJs).toContain(`serviceId: { type: 'string', enum: ['article-delivery', 'council-facade'] }`);
  });
});
