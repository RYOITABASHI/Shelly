/**
 * Ingress taint (DEFERRED.md P1 "MCP の入口", Inc 3): the RN wrapper with the
 * native module mocked, plus source pins on AgentIngressTaint.kt's fail-closed
 * rules (the Kotlin itself is type-checked/run with kotlinc stubs off-tree).
 */
import * as fs from 'fs';
import * as path from 'path';

const mockNative: Record<string, jest.Mock | undefined> = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: mockNative }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
const mockGetConnectorSecret = jest.fn();
jest.mock('@/lib/secure-store', () => ({ getConnectorSecret: (...a: unknown[]) => mockGetConnectorSecret(...a) }));

import {
  agentIngressStatus,
  clearAgentIngress,
  isAgentIngressTainted,
  markAgentIngress,
  parseAgentIngressStatus,
  removeAgentIngress,
  resetAgentIngress,
  statusTaints,
} from '@/lib/agent-ingress-taint';

const status = (s: string, entries: object[] = [], overflow = false) => JSON.stringify({ status: s, overflow, entries });
const entry = (agentId: string) => ({ agentId, source: 'mcp', principal: 'abc123', at: 1 });

beforeEach(() => {
  for (const k of Object.keys(mockNative)) delete mockNative[k];
  mockGetConnectorSecret.mockReset().mockResolvedValue('tok');
});

describe('parseAgentIngressStatus', () => {
  it('parses a verified list', () => {
    expect(parseAgentIngressStatus(status('ok', [entry('a1')]))).toEqual({
      status: 'ok',
      overflow: false,
      entries: [entry('a1')],
    });
  });

  it.each([
    ['not json', '{'],
    ['not a string', 42],
    ['unknown status', status('fine')],
    ['bad agent id', status('ok', [{ ...entry('a'), agentId: '../x' }])],
    ['bad source', status('ok', [{ ...entry('a'), source: 'web' }])],
    ['no entries', JSON.stringify({ status: 'ok' })],
    ['principal that is not a hash', status('ok', [{ ...entry('a'), principal: 'Bearer secret' }])],
  ])('%s -> unreadable (fail closed)', (_label, raw) => {
    expect(parseAgentIngressStatus(raw).status).toBe('unreadable');
  });
});

describe('statusTaints', () => {
  it('empty and unavailable taint nothing; ok taints the listed agents; unreadable/overflow taint all', () => {
    const ok = parseAgentIngressStatus(status('ok', [entry('a1')]));
    expect(statusTaints(ok, 'a1')).toBe(true);
    expect(statusTaints(ok, 'a2')).toBe(false);
    expect(statusTaints({ status: 'empty', overflow: false, entries: [] }, 'a1')).toBe(false);
    expect(statusTaints({ status: 'unavailable', overflow: false, entries: [] }, 'a1')).toBe(false);
    expect(statusTaints({ status: 'unreadable', overflow: false, entries: [] }, 'a1')).toBe(true);
    expect(statusTaints({ status: 'overflow', overflow: true, entries: [] }, 'a1')).toBe(true);
  });
});

describe('isAgentIngressTainted', () => {
  it('uses the native answer', async () => {
    mockNative.isAgentIngressTainted = jest.fn().mockResolvedValue(false);
    expect(await isAgentIngressTainted('a1')).toBe(false);
    mockNative.isAgentIngressTainted = jest.fn().mockResolvedValue(true);
    expect(await isAgentIngressTainted('a1')).toBe(true);
    expect(mockNative.isAgentIngressTainted).toHaveBeenCalledWith('a1', true);
  });

  it('tells native whether MCP was ever enabled (an MCP token exists)', async () => {
    mockNative.isAgentIngressTainted = jest.fn().mockResolvedValue(false);
    mockGetConnectorSecret.mockResolvedValue(null);
    await isAgentIngressTainted('a1');
    expect(mockNative.isAgentIngressTainted).toHaveBeenLastCalledWith('a1', false);
    expect(mockGetConnectorSecret).toHaveBeenCalledWith('mcp-server', 'token');
    mockGetConnectorSecret.mockRejectedValue(new Error('x'));
    await isAgentIngressTainted('a1');
    expect(mockNative.isAgentIngressTainted).toHaveBeenLastCalledWith('a1', true);
  });

  it('fails closed when the native call throws', async () => {
    mockNative.isAgentIngressTainted = jest.fn().mockRejectedValue(new Error('keystore'));
    expect(await isAgentIngressTainted('a1')).toBe(true);
  });

  it('falls back to the status when only the status method exists', async () => {
    mockNative.getAgentIngressStatus = jest.fn().mockResolvedValue(status('unreadable'));
    expect(await isAgentIngressTainted('a1')).toBe(true);
    mockNative.getAgentIngressStatus = jest.fn().mockResolvedValue(status('ok', [entry('a2')]));
    expect(await isAgentIngressTainted('a1')).toBe(false);
    mockNative.getAgentIngressStatus = jest.fn().mockRejectedValue(new Error('x'));
    expect(await isAgentIngressTainted('a1')).toBe(true);
  });

  it('is false only when the build has no native store at all', async () => {
    expect(await isAgentIngressTainted('a1')).toBe(false);
    expect((await agentIngressStatus()).status).toBe('unavailable');
  });

  it('treats an invalid agent id as tainted without calling native', async () => {
    mockNative.isAgentIngressTainted = jest.fn().mockResolvedValue(false);
    expect(await isAgentIngressTainted('../etc')).toBe(true);
    expect(mockNative.isAgentIngressTainted).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('mark passes id, source and principal and returns the new status', async () => {
    mockNative.markAgentIngress = jest.fn().mockResolvedValue(status('ok', [entry('a1')]));
    const r = await markAgentIngress('a1', 'mcp', 'abc123');
    expect(mockNative.markAgentIngress).toHaveBeenCalledWith('a1', 'mcp', 'abc123');
    expect(r.ok).toBe(true);
    expect(r.status.entries.map((e) => e.agentId)).toEqual(['a1']);
  });

  it('mark refuses a principal that could be a token or a name', async () => {
    mockNative.markAgentIngress = jest.fn();
    expect((await markAgentIngress('a1', 'mcp', 'Bearer secret token')).ok).toBe(false);
    expect((await markAgentIngress('a1', 'mcp', 'x'.repeat(65))).ok).toBe(false);
    expect(mockNative.markAgentIngress).not.toHaveBeenCalled();
  });

  it('reports ok:false without the native method, and on a native failure', async () => {
    expect(await markAgentIngress('a1')).toEqual({ ok: false, status: { status: 'unavailable', overflow: false, entries: [] } });
    mockNative.clearAgentIngress = jest.fn().mockRejectedValue(new Error('x'));
    mockNative.getAgentIngressStatus = jest.fn().mockResolvedValue(status('unreadable'));
    const r = await clearAgentIngress('a1');
    expect(r.ok).toBe(false);
    expect(r.status.status).toBe('unreadable');
  });

  it('clear, remove and reset call their native methods', async () => {
    mockNative.clearAgentIngress = jest.fn().mockResolvedValue(status('empty'));
    mockNative.removeAgentIngress = jest.fn().mockResolvedValue(status('empty'));
    mockNative.resetAgentIngress = jest.fn().mockResolvedValue(status('ok'));
    expect((await clearAgentIngress('a1')).ok).toBe(true);
    expect((await removeAgentIngress('a1')).ok).toBe(true);
    expect((await resetAgentIngress()).status.status).toBe('ok');
    expect(mockNative.clearAgentIngress).toHaveBeenCalledWith('a1', true);
    expect(mockNative.removeAgentIngress).toHaveBeenCalledWith('a1', true);
    expect(mockNative.resetAgentIngress).toHaveBeenCalledWith();
  });
});

describe('AgentIngressTaint.kt (source pins)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentIngressTaint.kt'),
    'utf8',
  );

  it('fails closed: only a fresh install (no alias, no blob) where MCP was never enabled is empty', () => {
    expect(src).toContain('return Snapshot(if (mcpEverEnabled) Status.UNREADABLE else Status.EMPTY, emptyList())');
    expect(src).toContain('if (!hasAlias || state == null || storedMac == null || expectedMac == null) return Snapshot(Status.UNREADABLE, emptyList())');
    expect(src).toMatch(/Status\.UNREADABLE, Status\.OVERFLOW -> true/);
  });

  it('re-keys on every write and never evicts past the cap', () => {
    expect(src).toMatch(/private fun write\([\s\S]*?val key = newKey\(\)/);
    expect(src).toContain('if (list.size >= MAX_ENTRIES) return Pair(list, true)');
  });

  it('mark always treats MCP as enabled, and seal leaves EMPTY before the server runs', () => {
    expect(src).toContain('val current = snapshot(context, mcpEverEnabled = true)');
    expect(src).toMatch(/fun seal\(context: Context\): Status \{[\s\S]*?Status\.EMPTY[\s\S]*?write\(context, emptyList\(\), false\)/);
  });

  it('a failed prefs commit fails closed in-process until reset', () => {
    expect(src).toMatch(/if \(!ok\) \{[\s\S]*?poisoned = true/);
    expect(src).toMatch(/if \(poisoned\) \{\s*Snapshot\(Status\.UNREADABLE/);
  });

  it('remove is documented as owner-delete only, never a missing-JSON cleanup', () => {
    expect(src).toMatch(/ONLY from the owner's explicit agent-delete path\.\s*\* Never from a sync, cleanup or reconcile step/);
    expect(src).toContain('must NEVER be read to decide taint');
  });

  it('audits with the shared ingress_taint kind and opens the file O_NOFOLLOW', () => {
    expect(src).toContain('private const val AUDIT_KIND = "ingress_taint"');
    expect(src).toContain('OsConstants.O_NOFOLLOW');
  });
});
