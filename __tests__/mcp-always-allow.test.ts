/**
 * lib/mcp-always-allow.ts — the TS side of the MCP always-allow rule store
 * (McpAlwaysAllowStore.kt is native; its pure half has a JVM test).
 */
const mockNative: Record<string, any> = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: mockNative }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }));

import {
  MAX_RULES,
  TYPED_OPS,
  addMcpAlwaysAllowRule,
  clientIdLabel,
  findAlwaysAllowMatch,
  isTypedOp,
  listMcpAlwaysAllowRules,
  mcpAlwaysAllowMatches,
  mcpPrincipalForToken,
  normalizeTarget,
  parseAlwaysAllowStatus,
  purgeMcpAlwaysAllowRulesExcept,
  purgeMcpAlwaysAllowRulesForNewToken,
  removeMcpAlwaysAllowRules,
  ruleKey,
  type AlwaysAllowRule,
} from '@/lib/mcp-always-allow';
import { MCP_PRINCIPAL_RE } from '@/lib/mcp-request-auth';
import { nodeSha256 } from './helpers/mcp-signed-request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcpScript = require('../scripts/shelly-mcp-server.js');

const P1 = '0123456789abcdef0123456789abcdef';
const P2 = 'fedcba9876543210fedcba9876543210';
const BIND_A = 'a'.repeat(64);
const BIND_B = 'b'.repeat(64);

function rule(over: Partial<AlwaysAllowRule> = {}): AlwaysAllowRule {
  return { id: 'r_0000000000000001', principal: P1, op: 'run_agent', target: 'agent:daily', bind: BIND_A, label: 'Daily', createdAt: 1731650000000, ...over };
}
const status = (rules: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, status: rules.length ? 'ok' : 'empty', rules, ...extra });

function clearNative() {
  for (const k of Object.keys(mockNative)) delete mockNative[k];
}

/**
 * A fake of the native store with the same semantics as McpAlwaysAllowStore
 * (unique key = principal/op/target, same-key add keeps the id, bind-absent
 * rules match any bind, raw ops refused). Exercises the wrappers the way the
 * bridge and Settings will use them.
 */
function installFakeStore() {
  let rules: AlwaysAllowRule[] = [];
  let n = 0;
  const list = () => JSON.stringify({ version: 1, status: rules.length ? 'ok' : 'empty', rules });
  Object.assign(mockNative, {
    mcpAlwaysAllowList: jest.fn(async () => list()),
    mcpAlwaysAllowMatch: jest.fn(async (principal: string, op: string, target: string, bind: string | null) =>
      rules.some((r) => r.principal === principal && r.op === op && r.target === target && (r.bind === undefined || r.bind === bind))),
    mcpAlwaysAllowAdd: jest.fn(async (principal: string, op: string, target: string, bind: string | null, label: string) => {
      if (!isTypedOp(op)) return JSON.stringify({ ok: false, code: 'invalid' });
      const existing = rules.find((r) => ruleKey(r.principal, r.op, r.target) === ruleKey(principal, op, target));
      if (existing) {
        if (bind) existing.bind = bind;
        else delete existing.bind;
        existing.label = label;
        return JSON.stringify({ ok: true, code: 'replaced', id: existing.id });
      }
      if (rules.length >= MAX_RULES) return JSON.stringify({ ok: false, code: 'full' });
      n += 1;
      const r: AlwaysAllowRule = { id: `r_${n.toString(16).padStart(16, '0')}`, principal, op, target, label, createdAt: 1 };
      if (bind) r.bind = bind;
      rules.push(r);
      return JSON.stringify({ ok: true, code: 'added', id: r.id });
    }),
    mcpAlwaysAllowRemove: jest.fn(async (ids: string[]) => {
      rules = rules.filter((r) => !ids.includes(r.id));
      return JSON.stringify({ ...JSON.parse(list()), ok: true });
    }),
    mcpAlwaysAllowPurgeExcept: jest.fn(async (principal: string | null) => {
      rules = principal === null ? [] : rules.filter((r) => r.principal === principal);
      return true;
    }),
  });
  return { rules: () => rules };
}

afterEach(() => clearNative());

describe('pure helpers', () => {
  it('the typed-op set is closed and excludes raw ops', () => {
    expect(TYPED_OPS).toEqual(['run_agent']);
    expect(isTypedOp('run_agent')).toBe(true);
    for (const op of ['run_command', 'write_file', 'list_agents', 'RUN_AGENT', '', null, undefined, 1, {}]) {
      expect(isTypedOp(op)).toBe(false);
    }
  });

  it('normalizeTarget: run_agent → agent:<id>; raw ops, bad ids and other args → null', () => {
    expect(normalizeTarget('run_agent', { agentId: 'daily-digest_1' })).toBe('agent:daily-digest_1');
    expect(normalizeTarget('run_agent', { agentId: 'Daily' })).toBe('agent:Daily'); // case kept
    expect(normalizeTarget('run_agent', { agentId: 'a'.repeat(128) })).toBe(`agent:${'a'.repeat(128)}`);
    for (const args of [{ agentId: 'a'.repeat(129) }, { agentId: '../x' }, { agentId: 'a b' }, { agentId: '*' }, { agentId: '' }, { agentId: 5 }, {}, null, [], 'agent:x']) {
      expect(normalizeTarget('run_agent', args)).toBeNull();
    }
    expect(normalizeTarget('run_command', { command: 'id' })).toBeNull();
    expect(normalizeTarget('write_file', { path: '/x', content: 'y' })).toBeNull();
  });

  it('ruleKey separates the three fields unambiguously', () => {
    expect(ruleKey(P1, 'run_agent', 'agent:x')).toBe(`${P1}\u0000run_agent\u0000agent:x`);
    expect(ruleKey(P1, 'run_agent', 'agent:x')).not.toBe(ruleKey(P2, 'run_agent', 'agent:x'));
  });

  it('clientIdLabel is the first 8 characters of the principal', () => {
    expect(clientIdLabel(P1)).toBe('01234567');
  });

  it('findAlwaysAllowMatch mirrors the native match', () => {
    const bound = rule();
    const unbound = rule({ id: 'r_0000000000000002', target: 'agent:free', bind: undefined });
    const rules = [bound, unbound];
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:daily', BIND_A)).toBe(bound);
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:daily', BIND_B)).toBeNull();
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:daily', null)).toBeNull();
    expect(findAlwaysAllowMatch(rules, P2, 'run_agent', 'agent:daily', BIND_A)).toBeNull();
    expect(findAlwaysAllowMatch(rules, P1, 'run_command', 'agent:daily', BIND_A)).toBeNull();
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:free', BIND_B)).toBe(unbound);
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:free', null)).toBe(unbound);
    expect(findAlwaysAllowMatch(rules, P1, 'run_agent', 'agent:free', 'nothex')).toBeNull();
  });
});

describe('parseAlwaysAllowStatus (fails to empty)', () => {
  it('keeps legacy consent distinct and strictly validates the action consent snapshot', () => {
    expect(parseAlwaysAllowStatus(status([rule()])).rules[0].actionPolicyPin).toBeUndefined();
    expect(parseAlwaysAllowStatus(status([rule({ actionPolicyPin: 'absent' })])).rules[0].actionPolicyPin).toBe('absent');
    for (const over of [{ actionPolicyPin: 'bad' }, { bind: undefined, actionPolicyPin: 'absent' }]) {
      expect(parseAlwaysAllowStatus(status([rule(over)])).status).toBe('unreadable');
    }
  });
  it('parses a well-formed status', () => {
    const r = rule();
    const u = rule({ id: 'r_0000000000000002', target: 'agent:free', bind: undefined, label: '' });
    expect(parseAlwaysAllowStatus(status([r, u]))).toEqual({ status: 'ok', rules: [r, u] });
    expect(parseAlwaysAllowStatus(status([]))).toEqual({ status: 'empty', rules: [] });
    expect(parseAlwaysAllowStatus(JSON.parse(status([r])))).toEqual({ status: 'ok', rules: [r] });
  });

  it.each([
    ['garbage', 'not json'],
    ['null', null],
    ['a number', 42],
    ['an array', '[]'],
    ['no version', JSON.stringify({ status: 'ok', rules: [] })],
    ['another version', status([], { version: 2 })],
    ['unknown status', status([], { status: 'maybe' })],
    ['native unreadable', status([], { status: 'unreadable' })],
    ['rules not an array', JSON.stringify({ version: 1, status: 'ok', rules: {} })],
    ['a raw op', status([rule({ op: 'run_command' as any })])],
    ['write_file', status([rule({ op: 'write_file' as any })])],
    ['a bad principal', status([rule({ principal: 'abc' })])],
    ['a bad target', status([rule({ target: 'agent:*' })])],
    ['a bad bind', status([rule({ bind: 'zz' })])],
    ['a null bind', status([{ ...rule(), bind: null }])],
    ['a bad id', status([rule({ id: 'x' })])],
    ['a long label', status([rule({ label: 'x'.repeat(65) })])],
    ['a bidi label', status([rule({ label: 'a\u202Eb' })])],
    ['a fractional createdAt', status([rule({ createdAt: 1.5 })])],
    ['an unknown key', status([{ ...rule(), extra: 1 }])],
    ['a duplicate key', status([rule(), rule({ id: 'r_0000000000000002', bind: BIND_B })])],
    ['a duplicate id', status([rule(), rule({ target: 'agent:other' })])],
    ['too many rules', status(Array.from({ length: MAX_RULES + 1 }, (_, i) => rule({ id: `r_${(i + 1).toString(16).padStart(16, '0')}`, target: `agent:a${i}` })))],
  ])('%s → unreadable with no rules', (_name, raw) => {
    const out = parseAlwaysAllowStatus(raw);
    expect(out.rules).toEqual([]);
    expect(out.status).toBe('unreadable');
  });

  it('one bad rule voids the whole list', () => {
    const out = parseAlwaysAllowStatus(status([rule(), rule({ id: 'r_0000000000000002', target: 'agent:x', op: 'run_command' as any })]));
    expect(out).toEqual({ status: 'unreadable', rules: [] });
  });
});

describe('wrappers on a build without the native store', () => {
  it('list → empty, match → false, add → unavailable, remove → not ok', async () => {
    expect(await listMcpAlwaysAllowRules()).toEqual({ status: 'empty', rules: [] });
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', null)).toBe(false);
    expect(await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:daily', null, 'Daily')).toEqual({ ok: false, code: 'unavailable' });
    expect(await removeMcpAlwaysAllowRules(['r_0000000000000001'])).toEqual({ status: 'empty', rules: [], ok: false });
  });

  it('purge is confirmed: there is no store, so no rule can exist', async () => {
    expect(await purgeMcpAlwaysAllowRulesExcept(null)).toBe(true);
    expect(await purgeMcpAlwaysAllowRulesExcept(P1)).toBe(true);
  });
});

describe('wrappers fail closed on native errors', () => {
  it('a throwing or odd native answer never matches, never confirms a purge', async () => {
    Object.assign(mockNative, {
      mcpAlwaysAllowList: jest.fn(async () => { throw new Error('keystore'); }),
      mcpAlwaysAllowMatch: jest.fn(async () => { throw new Error('keystore'); }),
      mcpAlwaysAllowAdd: jest.fn(async () => 'not json'),
      mcpAlwaysAllowPurgeExcept: jest.fn(async () => { throw new Error('keystore'); }),
    });
    expect(await listMcpAlwaysAllowRules()).toEqual({ status: 'unreadable', rules: [] });
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', null)).toBe(false);
    expect(await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:daily', null, 'x')).toEqual({ ok: false, code: 'failed' });
    expect(await purgeMcpAlwaysAllowRulesExcept(null)).toBe(false);
    mockNative.mcpAlwaysAllowPurgeExcept = jest.fn(async () => 'true');
    expect(await purgeMcpAlwaysAllowRulesExcept(null)).toBe(false);
    mockNative.mcpAlwaysAllowMatch = jest.fn(async () => 1);
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', null)).toBe(false);
  });

  it('invalid inputs never reach native', async () => {
    installFakeStore();
    expect(await addMcpAlwaysAllowRule(P1, 'run_command', 'agent:x', null, 'x')).toEqual({ ok: false, code: 'invalid' });
    expect(await addMcpAlwaysAllowRule(P1, 'write_file', 'agent:x', null, 'x')).toEqual({ ok: false, code: 'invalid' });
    expect(await addMcpAlwaysAllowRule('nope', 'run_agent', 'agent:x', null, 'x')).toEqual({ ok: false, code: 'invalid' });
    expect(await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:x', 'short', 'x')).toEqual({ ok: false, code: 'invalid' });
    expect(await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:x', '', 'x')).toEqual({ ok: false, code: 'invalid' });
    expect(mockNative.mcpAlwaysAllowAdd).not.toHaveBeenCalled();
    expect(await mcpAlwaysAllowMatches(P1, 'run_command', 'agent:x', null)).toBe(false);
    expect(mockNative.mcpAlwaysAllowMatch).not.toHaveBeenCalled();
    expect(await purgeMcpAlwaysAllowRulesExcept('not-a-principal')).toBe(false);
    expect(mockNative.mcpAlwaysAllowPurgeExcept).not.toHaveBeenCalled();
  });
});

describe('store semantics at the TS boundary (fake native)', () => {
  it('add → match → list → revoke round-trip', async () => {
    installFakeStore();
    const added = await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:daily', BIND_A, 'Daily');
    expect(added).toEqual({ ok: true, code: 'added', id: 'r_0000000000000001' });
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', BIND_A)).toBe(true);
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', BIND_B)).toBe(false);
    expect(await mcpAlwaysAllowMatches(P2, 'run_agent', 'agent:daily', BIND_A)).toBe(false);

    // Same key: replaced, same id.
    expect(await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:daily', BIND_B, 'Daily 2')).toEqual({ ok: true, code: 'replaced', id: 'r_0000000000000001' });
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', BIND_B)).toBe(true);
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', BIND_A)).toBe(false);

    await addMcpAlwaysAllowRule(P2, 'run_agent', 'agent:daily', null, 'Daily');
    const listed = await listMcpAlwaysAllowRules();
    expect(listed.status).toBe('ok');
    expect(listed.rules.map((r) => [r.principal, r.target, r.label])).toEqual([
      [P1, 'agent:daily', 'Daily 2'],
      [P2, 'agent:daily', 'Daily'],
    ]);

    const left = await removeMcpAlwaysAllowRules(['r_0000000000000001']);
    expect(left.ok).toBe(true);
    expect(left.rules.map((r) => r.principal)).toEqual([P2]);
    expect(await mcpAlwaysAllowMatches(P1, 'run_agent', 'agent:daily', BIND_B)).toBe(false);
  });

  it('purgeExcept keeps only the given principal; null removes everything', async () => {
    const fake = installFakeStore();
    await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:a', null, 'A');
    await addMcpAlwaysAllowRule(P2, 'run_agent', 'agent:b', null, 'B');
    expect(await purgeMcpAlwaysAllowRulesExcept(P2)).toBe(true);
    expect(fake.rules().map((r) => r.principal)).toEqual([P2]);
    expect(await purgeMcpAlwaysAllowRulesExcept(null)).toBe(true);
    expect(fake.rules()).toEqual([]);
  });

  it('purge for a new token keeps only that token\'s principal; throws when unconfirmed', async () => {
    const fake = installFakeStore();
    const newPrincipal = await mcpPrincipalForToken('new-token', nodeSha256);
    await addMcpAlwaysAllowRule(P1, 'run_agent', 'agent:a', null, 'old');
    await addMcpAlwaysAllowRule(newPrincipal, 'run_agent', 'agent:b', null, 'new');
    await purgeMcpAlwaysAllowRulesForNewToken('new-token', nodeSha256);
    expect(mockNative.mcpAlwaysAllowPurgeExcept).toHaveBeenCalledWith(newPrincipal);
    expect(fake.rules().map((r) => r.label)).toEqual(['new']);

    mockNative.mcpAlwaysAllowPurgeExcept = jest.fn(async () => false);
    await expect(purgeMcpAlwaysAllowRulesForNewToken('new-token', nodeSha256)).rejects.toThrow(/could not confirm/);
  });
});

describe('principal parity with scripts/shelly-mcp-server.js', () => {
  it('mcpPrincipalForToken equals the principal createMcpHandler stamps on requests', async () => {
    for (const token of ['test-token', 'A'.repeat(43), 'xY_-09'.repeat(7)]) {
      const seen: unknown[] = [];
      const handler = mcpScript.createMcpHandler({
        token,
        callTool: async (_tool: string, _args: unknown, ingress: unknown) => {
          seen.push(ingress);
          return { ok: true, data: [] };
        },
      });
      const headers = { authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_repos' };
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'list_repos',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'parity', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      };
      const out = await handler.handle({ method: 'POST', url: '/mcp', headers, body: JSON.stringify(body) });
      expect(out.status).toBe(200);
      expect(seen).toHaveLength(1);
      const principal = (seen[0] as { principal: string }).principal;
      expect(principal).toMatch(MCP_PRINCIPAL_RE);
      expect(await mcpPrincipalForToken(token, nodeSha256)).toBe(principal);
    }
  });
});
